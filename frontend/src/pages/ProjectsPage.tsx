import React, { useState, useEffect, useCallback } from 'react';
import {
  FolderGit2,
  FolderPlus,
  Trash2,
  CheckCircle2,
  Copy,
  Check,
  AlertCircle,
  ExternalLink,
  Plus,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api, type ProjectItem } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { useConfirm } from '../components/ConfirmProvider';
import { copyToClipboard } from '../lib/format';
import { FONT_MONO } from '../lib/fonts';

export const ProjectsPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Form state
  const [isAdding, setIsAdding] = useState(false);
  const [name, setName] = useState('');
  const [pathStr, setPathStr] = useState('');
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listProjects();
      setProjects(data.projects);
      setActiveId(data.activeId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !pathStr.trim()) {
      setFormError(t('common.requiredFields'));
      return;
    }
    setFormBusy(true);
    setFormError(null);
    try {
      const res = await api.createProject({
        name: name.trim(),
        path: pathStr.trim(),
      });
      toast.success(`${t('projects.created')}: ${res.project.name}`);
      setName('');
      setPathStr('');
      setIsAdding(false);
      await loadProjects();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setFormBusy(false);
    }
  };

  const handleSetActive = async (id: string) => {
    try {
      await api.setActiveProject(id);
      setActiveId(id);
      const target = projects.find((p) => p.id === id);
      toast.success(t('projects.switchSuccess', { name: target?.name ?? id }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDelete = async (project: ProjectItem) => {
    const ok = await confirm({
      title: t('projects.delete'),
      description: t('projects.deleteConfirm', { name: project.name }),
      confirmLabel: t('projects.delete'),
      danger: true,
    });
    if (!ok) return;

    try {
      await api.deleteProject(project.id);
      toast.success(t('projects.deleted'));
      await loadProjects();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const handleCopyPath = async (p: ProjectItem) => {
    const ok = await copyToClipboard(p.path);
    if (ok) {
      setCopiedId(p.id);
      setTimeout(() => setCopiedId(null), 1500);
    }
  };

  return (
    <div style={{ padding: '24px clamp(16px, 3vw, 36px)', display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '1000px', margin: '0 auto' }}>
      {/* Page Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 'var(--text-3xl)', fontWeight: 'var(--font-bold)', margin: 0, color: 'var(--text-main)' }}>
            {t('projects.title')}
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 'var(--text-md)', color: 'var(--text-dim)' }}>
            {t('projects.subtitle')}
          </p>
        </div>
        {!isAdding && (
          <button
            className="btn btn-primary"
            onClick={() => {
              setIsAdding(true);
              setFormError(null);
            }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <Plus size={14} aria-hidden />
            <span>{t('projects.add')}</span>
          </button>
        )}
      </div>

      {/* Add Project Form Card */}
      {isAdding && (
        <div className="card" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-base)', fontWeight: 'var(--font-semibold)' }}>
            <FolderPlus size={16} color="var(--accent)" />
            <span>{t('projects.add')}</span>
          </div>

          {formError && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 12px',
                borderRadius: '6px',
                background: 'var(--rose-soft, rgba(239, 68, 68, 0.1))',
                color: 'var(--accent-rose, #ef4444)',
                fontSize: 'var(--text-sm)',
              }}
            >
              <AlertCircle size={14} style={{ flexShrink: 0 }} />
              <span>{formError}</span>
            </div>
          )}

          <form onSubmit={(e) => void handleAddSubmit(e)} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--font-medium)', color: 'var(--text-dim)' }}>
                {t('projects.name')} *
              </label>
              <input
                type="text"
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('projects.namePlaceholder')}
                disabled={formBusy}
                autoFocus
                style={{ fontSize: 'var(--text-md)' }}
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--font-medium)', color: 'var(--text-dim)' }}>
                {t('projects.path')} *
              </label>
              <input
                type="text"
                className="input"
                value={pathStr}
                onChange={(e) => setPathStr(e.target.value)}
                placeholder={t('projects.pathPlaceholder')}
                disabled={formBusy}
                style={{ fontSize: 'var(--text-md)', fontFamily: FONT_MONO }}
              />
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
                {t('projects.pathHelp')}
              </span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 6 }}>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setIsAdding(false);
                  setFormError(null);
                }}
                disabled={formBusy}
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={formBusy || !name.trim() || !pathStr.trim()}
              >
                {formBusy ? t('projects.validating') : t('projects.save')}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Projects List Card */}
      <div className="card" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--font-semibold)', color: 'var(--text-main)' }}>
            {t('projects.title')} ({projects.length})
          </span>
        </div>

        {loading && projects.length === 0 ? (
          <div style={{ padding: '36px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--text-md)' }}>
            {t('common.loading')}
          </div>
        ) : projects.length === 0 ? (
          <div
            style={{
              padding: '36px',
              textAlign: 'center',
              color: 'var(--text-dim)',
              fontSize: 'var(--text-md)',
              border: '1px dashed var(--card-border)',
              borderRadius: '8px',
            }}
          >
            {t('projects.empty')}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {projects.map((p) => {
              const isActive = p.id === activeId;
              const isCopied = copiedId === p.id;
              return (
                <div
                  key={p.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '14px 16px',
                    borderRadius: '8px',
                    border: `1px solid ${isActive ? 'var(--accent)' : 'var(--card-border)'}`,
                    background: isActive ? 'var(--surface-hover)' : 'transparent',
                    gap: 16,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: 1 }}>
                    <FolderGit2
                      size={20}
                      color={isActive ? 'var(--accent)' : 'var(--text-dim)'}
                      style={{ flexShrink: 0 }}
                    />
                    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, gap: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 'var(--text-base)', fontWeight: 'var(--font-semibold)', color: 'var(--text-main)' }}>
                          {p.name}
                        </span>
                        {isActive && (
                          <span
                            className="chip"
                            style={{
                              fontSize: 'var(--text-xs)',
                              padding: '2px 8px',
                              color: 'var(--accent)',
                              borderColor: 'var(--accent)',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                            }}
                          >
                            <CheckCircle2 size={11} />
                            {t('projects.active')}
                          </span>
                        )}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        <span
                          style={{
                            fontSize: 'var(--text-sm)',
                            color: 'var(--text-dim)',
                            fontFamily: FONT_MONO,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={p.path}
                        >
                          {p.path}
                        </span>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => void handleCopyPath(p)}
                          style={{ padding: '2px', color: 'var(--text-dim)' }}
                          title={t('common.copy')}
                        >
                          {isCopied ? <Check size={12} color="var(--accent)" /> : <Copy size={12} />}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                    {/* View project skills button */}
                    <button
                      className="btn btn-sm"
                      onClick={() => navigate(`/harness/skills?tab=project&project=${encodeURIComponent(p.id)}`)}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--text-sm)' }}
                      title={t('harness.viewProject', { kind: t('harness.scopeKindSkill') })}
                    >
                      <ExternalLink size={12} />
                      <span>{t('harness.viewProject', { kind: t('harness.scopeKindSkill') })}</span>
                    </button>

                    {!isActive && (
                      <button
                        className="btn btn-sm"
                        onClick={() => void handleSetActive(p.id)}
                        style={{ fontSize: 'var(--text-sm)' }}
                      >
                        {t('projects.setActive')}
                      </button>
                    )}

                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => void handleDelete(p)}
                      title={t('projects.delete')}
                      style={{ padding: '6px', color: 'var(--text-dim)' }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
