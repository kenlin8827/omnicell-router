import React, { useState, useEffect, useMemo, useRef } from 'react';
import CodeMirror, { EditorView, oneDark } from '@uiw/react-codemirror';
import { yaml } from '@codemirror/lang-yaml';
import { FileCode2, Save, RefreshCw, Check, AlertCircle } from 'lucide-react';
import { api } from '../lib/api';
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

const editorFont = "'JetBrains Mono', Consolas, Monaco, 'Noto Sans SC', 'Microsoft YaHei', monospace";

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
  '&.cm-focused': { outline: 'none' },
});

export const YamlPage: React.FC = () => {
  const { t } = useI18n();
  const [yamlContent, setYamlContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const viewRef = useRef<EditorView | null>(null);
  const appTheme = useAppTheme();

  const sections = useMemo(() => {
    const out: YamlSection[] = [];
    const lines = yamlContent.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = TOP_LEVEL_RE.exec(lines[i]);
      if (m) out.push({ key: m[1], line: i + 1 });
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

  const loadYaml = async () => {
    setLoading(true);
    try {
      const res = await api.getRawYaml();
      setYamlContent(res.yaml || '');
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

  const handleSave = async () => {
    try {
      await api.saveRawYaml(yamlContent);
      setNotice({ type: 'success', text: t('yaml.savedNotice') });
      setTimeout(() => setNotice(null), 4000);
    } catch (err: any) {
      setNotice({ type: 'error', text: 'Failed: ' + err.message });
    }
  };

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
                extensions={[
                  yaml(),
                  EditorView.updateListener.of((update) => {
                    if (update.selectionSet || update.docChanged) {
                      setActiveKey(sectionAtCursor(update.view));
                    }
                  }),
                ]}
                onChange={setYamlContent}
                basicSetup={{ foldGutter: true, highlightActiveLine: true, autocompletion: false }}
              />
            </div>
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
