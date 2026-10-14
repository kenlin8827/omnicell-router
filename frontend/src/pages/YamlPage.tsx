import React, { useState, useEffect } from 'react';
import CodeMirror, { EditorView, oneDark } from '@uiw/react-codemirror';
import { yaml } from '@codemirror/lang-yaml';
import { FileCode2, Save, RefreshCw, Check, AlertCircle } from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';

/** Track the app-level `data-theme` attribute (set by Layout) so the editor follows theme switches. */
const useAppTheme = (): string => {
  const [theme, setTheme] = useState(() => document.documentElement.getAttribute('data-theme') || 'obsidian');
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(document.documentElement.getAttribute('data-theme') || 'obsidian');
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return theme;
};

const editorFont = "'JetBrains Mono', Consolas, Monaco, 'Noto Sans SC', 'Microsoft YaHei', monospace";

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
  const appTheme = useAppTheme();

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

        <div
          style={{
            border: '1px solid var(--card-border)',
            borderRadius: '10px',
            overflow: 'hidden',
            flex: 1,
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
            theme={appTheme === 'light' ? [appChrome] : [oneDark, appChrome]}
            extensions={[yaml()]}
            onChange={setYamlContent}
            basicSetup={{ foldGutter: true, highlightActiveLine: true, autocompletion: false }}
          />
        </div>
      </div>
    </div>
  );
};
