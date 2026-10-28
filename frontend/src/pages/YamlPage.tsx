import React, { useState, useEffect, useMemo, useRef } from 'react';
import CodeMirror, { EditorView, oneDark } from '@uiw/react-codemirror';
import { yaml } from '@codemirror/lang-yaml';
import { Decoration, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import type { Range } from '@codemirror/state';
import { EditorState, StateField } from '@codemirror/state';
import { FileCode2, Save, RefreshCw, Check, AlertCircle } from 'lucide-react';
import { api } from '../lib/api';
import { FONT_MONO } from '../lib/fonts';
import { DEFAULT_THEME, isLightTheme } from '../lib/theme';
import { useI18n } from '../i18n/I18nContext';

/** Track the app-level `data-theme` attribute (set by Layout) so the editor follows theme switches. */
const useAppTheme = (): string => {
  const [theme, setTheme] = useState(() => document.documentElement.getAttribute('data-theme') || DEFAULT_THEME);
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(document.documentElement.getAttribute('data-theme') || DEFAULT_THEME);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return theme;
};

const editorFont = FONT_MONO;

/** A top-level `config.yaml` section: key name and its 1-based line number in the document. */
interface YamlSection {
  key: string;
  line: number;
}

/** Matches a top-level YAML key at column 0 (unindented, not a comment/list line). */
const TOP_LEVEL_RE = /^([A-Za-z_][A-Za-z0-9_.-]*):(?=[\s#]|$)/;

/** Finds the last top-level key at or above the cursor line — drives the active chip. */
const sectionAtCursor = (view: EditorView): string | null => {
  const state = view.state;
  const upto = state.doc.lineAt(state.selection.main.head).number;
  let current: string | null = null;
  for (let i = 1; i <= upto; i++) {
    const m = TOP_LEVEL_RE.exec(state.doc.line(i).text);
    if (m) current = m[1];
  }
  return current;
};

/**
 * Disk (grouped) YAML path → runtime comment-dictionary key. Mirrors the
 * server's disk↔runtime mapping (schema.ts SECTION_MOVES + retry split):
 * strip the group prefix, apply the three renames, collapse dynamic levels.
 */
const RUNTIME_GROUPS = ['client', 'protocol', 'routing', 'upstream', 'resilience', 'ops'];
const translateDiskPath = (diskPath: string): string => {
  const segs = diskPath.split('.');
  if (segs[0] === 'schemaVersion') return '';
  if (diskPath.startsWith('resilience.retry.escalation')) return 'fallback' + diskPath.slice('resilience.retry.escalation'.length);
  if (diskPath.startsWith('routing.strategy')) return 'routing.mode' + diskPath.slice('routing.strategy'.length);
  if (diskPath.startsWith('routing.profileMemory')) return 'clientProfileMemory' + diskPath.slice('routing.profileMemory'.length);
  if (RUNTIME_GROUPS.includes(segs[0]) && segs.length > 1) segs.shift();
  if (segs[0] === 'retry' && segs[1] === 'escalation') return 'fallback.' + segs.slice(2).join('.');
  let key = segs.join('.');
  if (segs[0] === 'tiers' && segs.length >= 2) key = 'tiers.*' + (segs.length > 2 ? '.' + segs.slice(2).join('.') : '');
  if (segs[0] === 'combos' && segs.length >= 2) key = 'combos.*' + (segs.length > 2 ? '.' + segs.slice(2).join('.') : '');
  if (segs[0] === 'modelProfiles' && segs.length >= 2) key = 'modelProfiles.*' + (segs.length > 2 ? '.' + segs.slice(2).join('.') : '');
  if (segs[0] === 'credentials' && segs.length >= 2) key = 'credentials.*';
  if (segs[0] === 'catalog' && segs[1] === 'autoPullPatterns' && segs.length >= 3) key = 'catalog.autoPullPatterns.*';
  return key;
};

/** Dotted YAML path of the key at (or above) the cursor line, by indentation stack. */
const pathAtCursor = (view: EditorView): string | null => {
  const state = view.state;
  const line = state.doc.lineAt(state.selection.main.head);
  const stack: Array<{ indent: number; key: string }> = [];
  const scan = (text: string) => {
    if (/^\s*(#|-)/.test(text) || text.trim() === '') return;
    const m = /^(\s*)([A-Za-z_][A-Za-z0-9_.-]*):/.exec(text);
    if (!m) return;
    const indent = m[1].length;
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    stack.push({ indent, key: m[2] });
  };
  for (let i = 1; i <= line.number; i++) scan(state.doc.line(i).text);
  if (stack.length === 0) return null;
  return translateDiskPath(stack.map((s) => s.key).join('.'));
};

/** Read-only inlay: renders the dictionary comment as ghost text after the key, IDE-inlay style. */
/**
 * Read-only block widget: renders the dictionary comment as a ghost line
 * ABOVE the key line, indent-aligned (IDE "hint above" style).
 */
class CommentInlay extends WidgetType {
  constructor(
    readonly text: string,
    readonly indent: number
  ) {
    super();
  }
  eq(other: CommentInlay): boolean {
    return other.text === this.text && other.indent === this.indent;
  }
  toDOM(): HTMLElement {
    const div = document.createElement('div');
    div.className = 'cm-ghost-comment';
    div.setAttribute('aria-hidden', 'true');
    div.style.paddingLeft = `${this.indent + 2}ch`;
    div.textContent = `# ${this.text}`;
    return div;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Split a dictionary comment into display items: '；' / '。' boundaries become
 * bullet rows (one concern per row, readable). Braced fragments like
 * "{ window: 1m, requests: 3 }" never contain the separators, so they stay
 * intact; a trailing empty piece from a final '。' is dropped.
 */
const splitCommentItems = (text: string): string[] =>
  text
    .split(/；|。/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Build one inlay per key line whose translated path has a dictionary entry. */
const buildGhostDecorations = (state: EditorState, dict: Record<string, string>, truncatedSuffix: string): DecorationSet => {
  const out: Array<Range<Decoration>> = [];
  const stack: Array<{ indent: number; key: string }> = [];
  for (let i = 1; i <= state.doc.lines; i++) {
    const line = state.doc.line(i);
    const text = line.text;
    if (/^\s*(#|-|schemaVersion:)/.test(text)) continue;
    const m = /^(\s*)([A-Za-z_][A-Za-z0-9_.-]*):/.exec(text);
    if (!m) continue;
    const indent = m[1].length;
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    stack.push({ indent, key: m[2] });
    const key = translateDiskPath(stack.map((s) => s.key).join('.'));
    const comment = key ? dict[key] : undefined;
    if (!comment) continue;
    const oneLine = comment.length > 120 ? `${comment.slice(0, 120)}… ${truncatedSuffix}` : comment;
    out.push(
      Decoration.widget({ widget: new CommentInlay(oneLine, indent), block: true, side: -1 }).range(line.from)
    );
  }
  return Decoration.set(out, true);
};

/**
 * Block decorations MUST come from a StateField — CodeMirror rejects block
 * ranges provided via a ViewPlugin ("Block decorations may not be specified
 * via plugins"). The field rebuilds on doc changes; a dict change swaps the
 * extension (memoized by commentDict), re-creating the field.
 */
const ghostComments = (dict: Record<string, string>, truncatedSuffix: string) =>
  StateField.define<DecorationSet>({
    create: (state) => buildGhostDecorations(state, dict, truncatedSuffix),
    update: (deco, tr) => (tr.docChanged ? buildGhostDecorations(tr.state, dict, truncatedSuffix) : deco),
    provide: (field) => EditorView.decorations.from(field),
  });

/** Editor chrome (bg / gutters / selection / caret) driven by the app's CSS variables. */
const appChrome = EditorView.theme({
  '&': { backgroundColor: 'var(--input-bg)', color: 'var(--text-main)', fontSize: '13px' },
  '.cm-content': { fontFamily: editorFont, lineHeight: '1.6' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--text-dim)', border: 'none', fontFamily: editorFont },
  '.cm-activeLine': { backgroundColor: 'rgba(127, 127, 127, 0.12)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(127, 127, 127, 0.18)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'rgba(99, 161, 255, 0.25) !important',
  },
  '.cm-ghost-comment': {
    color: 'var(--text-dim)',
    opacity: 0.55,
    fontStyle: 'italic',
    fontSize: '11px',
    pointerEvents: 'none',
    lineHeight: 1.5,
    userSelect: 'none',
    whiteSpace: 'pre-wrap',
  },
  '&.cm-focused': { outline: 'none' },
});

export const YamlPage: React.FC = () => {
  const { t, lang } = useI18n();
  const [yamlContent, setYamlContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [configPath, setConfigPath] = useState('');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [commentDict, setCommentDict] = useState<Record<string, string>>({});
  const [commentHeader, setCommentHeader] = useState('');
  const [cursorPath, setCursorPath] = useState<string | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const appTheme = useAppTheme();

  const sections = useMemo(() => {
    const out: YamlSection[] = [];
    const lines = yamlContent.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = TOP_LEVEL_RE.exec(lines[i]);
      // schemaVersion is machine-managed (ADR-0016): read at load, rewritten
      // on save — it is not a section the operator navigates or edits.
      if (m && m[1] !== 'schemaVersion') out.push({ key: m[1], line: i + 1 });
    }
    return out;
  }, [yamlContent]);

  const visibleSections = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? sections.filter((s) => s.key.toLowerCase().includes(q)) : sections;
  }, [sections, filter]);

  const jumpTo = (lineNo: number) => {
    const view = viewRef.current;
    if (!view) return;
    const target = view.state.doc.line(Math.min(lineNo, view.state.doc.lines));
    view.dispatch({
      selection: { anchor: target.from },
      effects: EditorView.scrollIntoView(target.from, { y: 'start', yMargin: 12 }),
    });
    view.focus();
  };

  // schemaVersion is machine-managed (ADR-0016): the editor NEVER shows it.
  // Strip it out of the loaded text; the save path splices it back in, so
  // disk keeps the version key while the operator edits pure content.
  const SCHEMA_VERSION_RE = /^schemaVersion:\s*(\d+)\s*$/m;
  const stripSchemaVersion = (text: string): { body: string; version: number } => {
    const m = SCHEMA_VERSION_RE.exec(text);
    if (!m) return { body: text, version: 1 };
    return {
      body: text.replace(`${m[0]}\n`, '').replace(m[0], ''),
      version: Number(m[1]),
    };
  };

  const schemaVersionRef = useRef(1);

  const loadYaml = async () => {
    setLoading(true);
    try {
      const res = await api.getRawYaml();
      const stripped = stripSchemaVersion(res.yaml || '');
      schemaVersionRef.current = stripped.version;
      setYamlContent(stripped.body);
      setConfigPath(res.path || '');
      setNotice(null);
    } catch (err: any) {
      setNotice({ type: 'error', text: 'Error: ' + err.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadYaml();
  }, []);
  // Dynamic comment panel: dictionaries come from the backend (zh-CN/en);
  // config.yaml itself is comment-free on disk (ADR-0016). Reload on UI
  // language switch — the panel follows instantly, the file never changes.
  useEffect(() => {
    let cancelled = false;
    api
      .getConfigComments(api.commentLang())
      .then((res) => {
        if (cancelled) return;
        setCommentDict(res.fields || {});
        setCommentHeader(res.header || '');
      })
      .catch(() => {
        if (!cancelled) setCommentDict({});
      });
    return () => {
      cancelled = true;
    };
  }, [lang]);

  const handleSave = async () => {
    try {
      const raw = `schemaVersion: ${schemaVersionRef.current}\n${yamlContent}`;
      await api.saveRawYaml(raw);
      setNotice({ type: 'success', text: t('yaml.savedNotice') });
      setTimeout(() => setNotice(null), 4000);
    } catch (err: any) {
      setNotice({ type: 'error', text: 'Failed: ' + err.message });
    }
  };

  // Hooks must be unconditional: the memo lives at component top level, not
  // inside the `{!loading && …}` conditional render (hook-order crash).
  const extensions = useMemo(
    () => [
      yaml(),
      ghostComments(commentDict, t('yaml.commentsTruncated')),
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) {
          setActiveKey(sectionAtCursor(update.view));
          setCursorPath(pathAtCursor(update.view));
        }
      }),
    ],
    [commentDict, lang]
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', height: '100%' }}>
      <div className="card" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="card-header">
          <div className="card-title">
            <FileCode2 size={18} color="var(--accent)" />
            <span>{t('yaml.title')}</span>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="btn btn-sm" onClick={loadYaml} disabled={loading}>
              <RefreshCw size={12} />
              <span>{t('yaml.reload')}</span>
            </button>
            <button className="btn btn-primary btn-sm" onClick={handleSave}>
              <Save size={12} />
              <span>{t('yaml.save')}</span>
            </button>
          </div>
        </div>

        {configPath && (
          <div
            style={{
              fontFamily: editorFont,
              fontSize: '11px',
              color: 'var(--text-dim)',
              wordBreak: 'break-all',
              userSelect: 'text',
              margin: '-4px 16px 10px',
            }}
          >
            {configPath}
          </div>
        )}
        {notice && (
          <div
            style={{
              padding: '10px 14px',
              borderRadius: '8px',
              background: notice.type === 'success' ? 'color-mix(in srgb, var(--accent-emerald) 15%, transparent)' : 'color-mix(in srgb, var(--accent-rose) 15%, transparent)',
              border: `1px solid ${notice.type === 'success' ? 'color-mix(in srgb, var(--accent-emerald) 30%, transparent)' : 'color-mix(in srgb, var(--accent-rose) 30%, transparent)'}`,
              color: notice.type === 'success' ? 'var(--accent-emerald)' : 'var(--accent-rose)',
              fontSize: '13px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              marginBottom: '16px',
            }}
          >
            {notice.type === 'success' ? <Check size={16} /> : <AlertCircle size={16} />}
            <span>{notice.text}</span>
          </div>
        )}

        <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '14px' }}>
          {t('yaml.desc')}
        </p>

        {!loading && (
          <div style={{ display: 'flex', gap: '16px', flex: 1, minHeight: 0 }}>
            {sections.length > 0 && (
              <aside style={{ width: '180px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <input
                className="input"
                style={{ fontSize: '11px', padding: '5px 10px' }}
                placeholder={t('yaml.filterPlaceholder')}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <nav style={{ overflowY: 'auto', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: '2px', scrollbarWidth: 'thin' }}>
                {visibleSections.map((s) => {
                  const active = activeKey === s.key;
                  return (
                    <button
                      key={`${s.key}:${s.line}`}
                      onClick={() => jumpTo(s.line)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '8px',
                        width: '100%',
                        textAlign: 'left',
                        fontSize: '12px',
                        fontFamily: editorFont,
                        padding: '4px 10px',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        border: 'none',
                        background: active ? 'color-mix(in srgb, var(--accent) 18%, transparent)' : 'transparent',
                        color: active ? 'var(--accent)' : 'var(--text-muted)',
                      }}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.key}</span>
                      <span style={{ fontSize: '10px', opacity: 0.6, flexShrink: 0 }}>{s.line}</span>
                    </button>
                  );
                })}
              </nav>
              </aside>
            )}

            <div
              style={{
                border: '1px solid var(--card-border)',
                borderRadius: '10px',
                overflow: 'hidden',
                flex: 1,
                minWidth: 0,
                minHeight: 0,
              }}
            >
              {/* `height="100%"` lands on .cm-editor; the wrapper div this component
                  renders defaults to height:auto, so it must be pinned to 100% too,
                  otherwise the editor collapses to content height and never scrolls. */}
              <CodeMirror
                value={yamlContent}
                style={{ height: '100%' }}
                height="100%"
                theme={isLightTheme(appTheme) ? [appChrome] : [oneDark, appChrome]}
                onCreateEditor={(view) => {
                  viewRef.current = view;
                  setActiveKey(sectionAtCursor(view));
                }}
                extensions={extensions}
                onChange={setYamlContent}
                basicSetup={{ foldGutter: true, highlightActiveLine: true, autocompletion: false }}
              />
            </div>

            <aside
              style={{
                width: '380px',
                flexShrink: 0,
                border: '1px solid var(--card-border)',
                borderRadius: '10px',
                padding: '12px 14px',
                overflowY: 'auto',
                minHeight: 0,
                fontSize: '12px',
                color: 'var(--text-muted)',
                lineHeight: 1.6,
                scrollbarWidth: 'thin',
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: '8px', color: 'var(--text-main)' }}>
                {t('yaml.commentsTitle')}
              </div>
              {cursorPath && commentDict[cursorPath] ? (
                <>
                  <div
                    style={{
                      fontFamily: editorFont,
                      fontSize: '11px',
                      color: 'var(--accent)',
                      marginBottom: '8px',
                      wordBreak: 'break-all',
                      paddingBottom: '6px',
                      borderBottom: '1px solid var(--card-border)',
                    }}
                  >
                    {cursorPath}
                  </div>
                  <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                    {splitCommentItems(commentDict[cursorPath]).map((item, i) => (
                      <li
                        key={i}
                        style={{
                          display: 'flex',
                          gap: '6px',
                          marginBottom: '6px',
                          lineHeight: 1.55,
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        <span
                          style={{
                            flexShrink: 0,
                            color: 'var(--text-dim)',
                            fontSize: '16px',
                            lineHeight: '12px',
                            fontWeight: 700,
                          }}
                        >
                          ·
                        </span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : commentHeader ? (
                <div style={{ lineHeight: 1.65, fontSize: '12px' }}>
                  {commentHeader.split('\n').map((ln, i) => {
                    // Group rows ("  client      Client entry surface: …") render as
                    // chip + description rows; everything else is prose.
                    const m = /^\s{2}(client|protocol|routing|upstream|resilience|ops)\s+(.+)$/.exec(ln);
                    if (m) {
                      return (
                        <div key={i} style={{ display: 'flex', gap: '8px', alignItems: 'baseline', marginBottom: '5px' }}>
                          <span
                            style={{
                              fontFamily: editorFont,
                              fontSize: '11px',
                              color: 'var(--accent)',
                              background: 'var(--surface)',
                              border: '1px solid var(--card-border)',
                              padding: '1px 8px',
                              borderRadius: '4px',
                              flexShrink: 0,
                              minWidth: '82px',
                              textAlign: 'center',
                            }}
                          >
                            {m[1]}
                          </span>
                          <span>{m[2]}</span>
                        </div>
                      );
                    }
                    const trimmed = ln.trim();
                    if (!trimmed) return null;
                    const isHeading = /(配置层次|Configuration layers|每段唯一归属|exactly one home)/.test(trimmed);
                    return (
                      <div
                        key={i}
                        style={{
                          marginBottom: '6px',
                          whiteSpace: 'pre-wrap',
                          fontWeight: isHeading ? 600 : 400,
                          color: isHeading ? 'var(--text-main)' : 'var(--text-secondary)',
                        }}
                      >
                        {trimmed}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{t('yaml.commentsHint')}</div>
              )}
            </aside>
          </div>
        )}

        {loading && (
          <div
            style={{
              border: '1px solid var(--card-border)',
              borderRadius: '10px',
              overflow: 'hidden',
              flex: 1,
              minHeight: 0,
            }}
          />
        )}
      </div>
    </div>
  );
};
