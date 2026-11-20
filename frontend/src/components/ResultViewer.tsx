import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, Maximize2, Minimize2 } from 'lucide-react';
import { SegGroup } from './SegGroup';
import { ScrollTable, type ScrollTableColumn } from './ScrollTable';
import { useToast } from './ToastProvider';
import { useI18n } from '../i18n/I18nContext';

export type ResultViewMode = 'pretty' | 'table' | 'raw';

export interface ResultViewerProps {
  /** Primary payload (JSON object/array, string, or MCP content blocks). */
  data: unknown;
  /** Raw payload shown in Raw view (defaults to `data`). */
  raw?: unknown;
  /** Optional status/meta node rendered on the left side of the toolbar. */
  headerLeft?: React.ReactNode;
  /** Optional trailing controls (e.g. close button) rendered on the far right. */
  headerRight?: React.ReactNode;
  /** Fill flex parent height (default false). */
  fill?: boolean;
  /** Max height when not filling a flex parent. */
  maxHeight?: number | string;
  /** Show fullscreen toggle button in the toolbar (default true). */
  allowFullscreen?: boolean;
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false };
  }
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function isMcpContentBlockList(v: unknown): v is Array<Record<string, unknown>> {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((item) => isPlainRecord(item) && typeof item.type === 'string')
  );
}

/** Syntax-highlighted JSON renderer using the console's theme tokens. */
const JsonCodeBlock: React.FC<{ value: unknown }> = ({ value }) => {
  const text = useMemo(
    () => (typeof value === 'string' ? value : JSON.stringify(value, null, 2)),
    [value]
  );

  const lines = useMemo(() => text.split('\n'), [text]);

  const highlightLine = (line: string): React.ReactNode => {
    // Match optional leading indent + `"key":` + rest of line.
    const keyMatch = /^(\s*)"([^"\\]*(?:\\.[^"\\]*)*)"(\s*:\s*)(.*)$/.exec(line);
    if (keyMatch) {
      const [, indent, key, colon, rest] = keyMatch;
      return (
        <>
          {indent}
          <span style={{ color: 'var(--accent)' }}>"{key}"</span>
          {colon}
          {highlightScalar(rest!)}
        </>
      );
    }
    return highlightScalar(line);
  };

  const highlightScalar = (segment: string): React.ReactNode => {
    const m = /^(\s*)(.+?)(,?)$/.exec(segment);
    if (!m) return segment;
    const [, lead, core, comma] = m;
    if (!core) return segment;
    if (core.startsWith('"') && core.endsWith('"') && core.length >= 2) {
      return (
        <>
          {lead}
          <span style={{ color: 'var(--accent-emerald, #4ade80)' }}>{core}</span>
          {comma}
        </>
      );
    }
    if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(core)) {
      return (
        <>
          {lead}
          <span style={{ color: 'var(--accent-amber, #fbbf24)' }}>{core}</span>
          {comma}
        </>
      );
    }
    if (core === 'true' || core === 'false') {
      return (
        <>
          {lead}
          <span style={{ color: 'var(--accent-violet, #a78bfa)' }}>{core}</span>
          {comma}
        </>
      );
    }
    if (core === 'null') {
      return (
        <>
          {lead}
          <span style={{ color: 'var(--text-dim)' }}>{core}</span>
          {comma}
        </>
      );
    }
    return segment;
  };

  return (
    <pre
      style={{
        margin: 0,
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-md)',
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: 'var(--text-main)',
      }}
    >
      {lines.map((line, i) => (
        <React.Fragment key={i}>
          {highlightLine(line)}
          {i < lines.length - 1 ? '\n' : ''}
        </React.Fragment>
      ))}
    </pre>
  );
};

interface ExtractedTable {
  label?: string;
  columns: ScrollTableColumn[];
  rows: Array<Record<string, unknown>>;
}

function extractTable(input: unknown): ExtractedTable | null {
  let target = input;

  // Unwrap MCP content block list if it carries a single JSON text block or structured objects.
  if (isMcpContentBlockList(target)) {
    const parsedTexts: unknown[] = [];
    for (const block of target) {
      if (block.type === 'text' && typeof block.text === 'string') {
        const parsed = tryParseJson(block.text);
        if (parsed.ok) parsedTexts.push(parsed.value);
      }
    }
    if (parsedTexts.length === 1) {
      target = parsedTexts[0];
    }
  } else if (typeof target === 'string') {
    const parsed = tryParseJson(target);
    if (!parsed.ok) return null;
    target = parsed.value;
  }

  const fromObjectArray = (arr: Record<string, unknown>[], label?: string): ExtractedTable => {
    const colKeys = new Set<string>();
    for (const row of arr) {
      for (const k of Object.keys(row)) colKeys.add(k);
    }
    const keys = [...colKeys];
    return {
      ...(label ? { label } : {}),
      columns: keys.map((k) => ({ key: k, label: k })),
      rows: arr,
    };
  };

  if (Array.isArray(target)) {
    if (target.length === 0) return null;
    if (target.every((item) => isPlainRecord(item))) {
      return fromObjectArray(target);
    }
    return {
      columns: [
        { key: '#', label: '#', width: 60 },
        { key: 'value', label: 'Value' },
      ],
      rows: target.map((v, i) => ({ '#': i, value: v })),
    };
  }

  if (isPlainRecord(target)) {
    // If an object contains a prominent array of records (e.g. { files: [...] }), tabulate it.
    for (const [k, v] of Object.entries(target)) {
      if (Array.isArray(v) && v.length > 0 && v.every((item) => isPlainRecord(item))) {
        return fromObjectArray(v, `${k} (${v.length})`);
      }
    }
    // Otherwise render Key | Value table.
    const entries = Object.entries(target);
    if (entries.length === 0) return null;
    return {
      columns: [
        { key: 'key', label: 'Key', width: '32%' },
        { key: 'value', label: 'Value' },
      ],
      rows: entries.map(([key, value]) => ({ key, value })),
    };
  }

  return null;
}

function formatCell(val: unknown): string {
  if (val === null) return 'null';
  if (val === undefined) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  return JSON.stringify(val);
}

/**
 * Shared Postman-style response/result viewer supporting Pretty (syntax-highlighted JSON,
 * rich text, and base64 images), Table (auto-tabulated arrays and key-value objects via ScrollTable),
 * and Raw views, plus one-click copy.
 */
export const ResultViewer: React.FC<ResultViewerProps> = ({
  data,
  raw,
  headerLeft,
  headerRight,
  fill = false,
  maxHeight = 420,
  allowFullscreen = true,
}) => {
  const { t } = useI18n();
  const toast = useToast();
  const [view, setView] = useState<ResultViewMode>('pretty');
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setFullscreen(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [fullscreen]);

  const table = useMemo(() => extractTable(data), [data]);

  const rawText = useMemo(() => {
    const src = raw !== undefined ? raw : data;
    return typeof src === 'string' ? src : JSON.stringify(src, null, 2);
  }, [raw, data]);

  const copyPayload = useMemo(() => {
    if (view === 'raw') return rawText;
    if (isMcpContentBlockList(data)) {
      return data
        .map((block) => {
          if (block.type === 'text' && typeof block.text === 'string') {
            const parsed = tryParseJson(block.text);
            return parsed.ok ? JSON.stringify(parsed.value, null, 2) : block.text;
          }
          return JSON.stringify(block, null, 2);
        })
        .join('\n\n');
    }
    if (typeof data === 'string') {
      const parsed = tryParseJson(data);
      return parsed.ok ? JSON.stringify(parsed.value, null, 2) : data;
    }
    return JSON.stringify(data, null, 2);
  }, [view, rawText, data]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(copyPayload);
      toast.success(t('common.copied'));
    } catch {
      toast.error(t('common.copyFailed'));
    }
  }, [copyPayload, t, toast]);

  const renderPretty = () => {
    if (isMcpContentBlockList(data)) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {data.map((block, idx) => {
            if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
              return (
                <div
                  key={idx}
                  style={{
                    padding: 10,
                    borderRadius: 6,
                    background: 'var(--card-bg)',
                    border: '1px solid var(--card-border)',
                  }}
                >
                  <img
                    src={`data:${block.mimeType};base64,${block.data}`}
                    alt="MCP image output"
                    style={{ maxWidth: '100%', maxHeight: 360, borderRadius: 4, display: 'block' }}
                  />
                </div>
              );
            }
            if (block.type === 'text' && typeof block.text === 'string') {
              const parsed = tryParseJson(block.text);
              return (
                <div
                  key={idx}
                  style={{
                    padding: 10,
                    borderRadius: 6,
                    background: 'var(--card-bg)',
                    border: '1px solid var(--card-border)',
                  }}
                >
                  {parsed.ok ? (
                    <JsonCodeBlock value={parsed.value} />
                  ) : (
                    <pre
                      style={{
                        margin: 0,
                        fontFamily: 'var(--font-mono)',
                        fontSize: 'var(--text-md)',
                        lineHeight: 1.5,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        color: 'var(--text-main)',
                      }}
                    >
                      {block.text}
                    </pre>
                  )}
                </div>
              );
            }
            return (
              <div
                key={idx}
                style={{
                  padding: 10,
                  borderRadius: 6,
                  background: 'var(--card-bg)',
                  border: '1px solid var(--card-border)',
                }}
              >
                <JsonCodeBlock value={block} />
              </div>
            );
          })}
        </div>
      );
    }

    if (typeof data === 'string') {
      const parsed = tryParseJson(data);
      if (parsed.ok) {
        return <JsonCodeBlock value={parsed.value} />;
      }
      return (
        <pre
          style={{
            margin: 0,
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-md)',
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: 'var(--text-main)',
          }}
        >
          {data}
        </pre>
      );
    }

    return <JsonCodeBlock value={data} />;
  };

  return (
    <div
      style={
        fullscreen
          ? {
              position: 'fixed',
              inset: 0,
              zIndex: 960,
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--bg-elev)',
              overflow: 'hidden',
            }
          : {
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--bg-elev)',
              border: fill ? 'none' : '1px solid var(--card-border)',
              borderRadius: fill ? 0 : 8,
              ...(fill ? { flex: 1, minHeight: 0, height: '100%' } : { maxHeight }),
              overflow: 'hidden',
            }
      }
    >
      {/* Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '8px 12px',
          borderBottom: '1px solid var(--card-border)',
          flexWrap: 'wrap',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {headerLeft}
          <SegGroup
            value={view === 'table' && !table ? 'pretty' : view}
            onChange={(v) => setView(v as ResultViewMode)}
            size="sm"
            options={[
              { value: 'pretty', label: 'Pretty' },
              ...(table ? [{ value: 'table', label: 'Table' }] : []),
              { value: 'raw', label: 'Raw' },
            ]}
          />
        </div>

        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <button type="button" className="btn btn-sm" onClick={() => void handleCopy()}>
            <Copy size={11} /> {t('common.copy')}
          </button>
          {allowFullscreen && (
            <button
              type="button"
              className="btn btn-sm"
              style={{ padding: '3px 6px' }}
              onClick={() => setFullscreen((f) => !f)}
              title={fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
            >
              {fullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
            </button>
          )}
          {headerRight}
        </div>
      </div>

      {/* Body */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: view === 'table' ? 'hidden' : 'auto',
          padding: view === 'table' ? 0 : 12,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {view === 'raw' ? (
          <pre
            style={{
              margin: 0,
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-md)',
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: 'var(--text-main)',
            }}
          >
            {rawText}
          </pre>
        ) : view === 'table' && table ? (
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
            {table.label && (
              <div
                style={{
                  padding: '6px 12px',
                  fontSize: 'var(--text-sm)',
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-muted)',
                  borderBottom: '1px solid var(--card-border)',
                }}
              >
                {table.label}
              </div>
            )}
            <ScrollTable
              columns={table.columns}
              {...(fill || fullscreen
                ? { fill: true }
                : { maxHeight: typeof maxHeight === 'number' ? Math.max(200, maxHeight - 52) : 340 })}
              minWidth={Math.max(420, table.columns.length * 160)}
            >
              <tbody>
                {table.rows.map((row, idx) => (
                  <tr key={idx}>
                    {table.columns.map((col) => (
                      <td
                        key={col.key}
                        style={{
                          padding: '6px 10px',
                          fontSize: 'var(--text-sm)',
                          fontFamily: 'var(--font-mono)',
                          borderBottom: '1px solid var(--divider)',
                          verticalAlign: 'top',
                          minWidth: 120,
                          maxWidth: 420,
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                        }}
                      >
                        {formatCell(row[col.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </ScrollTable>
          </div>
        ) : (
          renderPretty()
        )}
      </div>
    </div>
  );
};
