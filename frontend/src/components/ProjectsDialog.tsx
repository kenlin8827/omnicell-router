import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  FolderPlus,
  Trash2,
  CheckCircle2,
  FolderGit2,
  AlertCircle,
  Plus,
} from 'lucide-react';
import { Dialog } from './Dialog';
import { api, type ProjectItem } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from './ToastProvider';
import { useConfirm } from './ConfirmProvider';

export interface ProjectsDialogProps {
  open: boolean;
  onClose: () => void;
  onProjectsChange?: (projects: ProjectItem[], activeId: string | null) => void;
}

export const ProjectsDialog: React.FC<ProjectsDialogProps> = ({
  open,
  onClose,
  onProjectsChange,
}) => {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();

  const [loading, setLoading] = useState(false);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Form state
  const [isAdding, setIsAdding] = useState(false);
  const [name, setName] = useState('');
  const [pathStr, setPathStr] = useState('');
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // The parent passes an inline callback, so it changes identity every render. Holding it in a ref
  // keeps `loadProjects` stable; otherwise the effect below refetches on every parent render and the
  // parent's setState (from `onProjectsChange`) restarts the cycle — an infinite request loop.
  const onProjectsChangeRef = useRef(onProjectsChange);
  onProjectsChangeRef.current = onProjectsChange;

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listProjects();
      setProjects(data.projects);
      setActiveId(data.activeId);
      onProjectsChangeRef.current?.(data.projects, data.activeId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (open) {
      void loadProjects();
    }
  }, [open, loadProjects]);

  if (!open) return null;

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
      onProjectsChange?.(projects, id);
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

  return (
    <Dialog
      title={t('projects.title')}
      subtitle={t('projects.subtitle')}
      onClose={onClose}
      closeLabel={t('combobox.close')}
      width={640}
      footerRight={
        <button className="btn btn-sm" onClick={onClose}>
          {t('combobox.close')}
        </button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', paddingBottom: '6px' }}>
        {/* Header Action: Add Project toggle */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--font-semibold)', color: 'var(--text-main)' }}>
            {t('projects.title')} ({projects.length})
          </span>
          {!isAdding && (
            <button
              className="btn btn-sm btn-primary"
              onClick={() => {
                setIsAdding(true);
                setFormError(null);
              }}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <Plus size={13} aria-hidden />
              <span>{t('projects.add')}</span>
            </button>
          )}
        </div>

        {/* Add Project Form */}
        {isAdding && (
          <form
            onSubmit={(e) => void handleAddSubmit(e)}
            style={{
              padding: '14px',
              borderRadius: '8px',
              border: '1px solid var(--accent-border, var(--card-border))',
              background: 'var(--surface-hover)',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-md)', fontWeight: 'var(--font-semibold)' }}>
              <FolderPlus size={14} color="var(--accent)" />
              <span>{t('projects.add')}</span>
            </div>

            {formError && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 10px',
                  borderRadius: '6px',
                  background: 'var(--rose-soft, rgba(239, 68, 68, 0.1))',
                  color: 'var(--accent-rose, #ef4444)',
                  fontSize: 'var(--text-sm)',
                }}
              >
                <AlertCircle size={13} style={{ flexShrink: 0 }} />
                <span>{formError}</span>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
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
                style={{ fontSize: 'var(--text-sm)', padding: '6px 10px' }}
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
                {t('projects.path')} *
              </label>
              <input
                type="text"
                className="input"
                value={pathStr}
                onChange={(e) => setPathStr(e.target.value)}
                placeholder={t('projects.pathPlaceholder')}
                disabled={formBusy}
                style={{ fontSize: 'var(--text-sm)', padding: '6px 10px', fontFamily: 'var(--font-mono)' }}
              />
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
                {t('projects.pathHelp')}
              </span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
              <button
                type="button"
                className="btn btn-sm"
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
                className="btn btn-sm btn-primary"
                disabled={formBusy || !name.trim() || !pathStr.trim()}
              >
                {formBusy ? t('projects.validating') : t('projects.save')}
              </button>
            </div>
          </form>
        )}

        {/* Project List */}
        {loading && projects.length === 0 ? (
          <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--text-sm)' }}>
            {t('common.loading')}
          </div>
        ) : projects.length === 0 ? (
          <div
            style={{
              padding: '24px',
              textAlign: 'center',
              color: 'var(--text-dim)',
              fontSize: 'var(--text-sm)',
              border: '1px dashed var(--card-border)',
              borderRadius: '8px',
            }}
          >
            {t('projects.empty')}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '2px 2px 6px 2px' }}>
            {projects.map((p) => {
              const isActive = p.id === activeId;
              return (
                <div
                  key={p.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '11px 14px',
                    borderRadius: '8px',
                    border: `1px solid ${isActive ? 'var(--accent)' : 'var(--card-border)'}`,
                    background: isActive ? 'var(--surface-hover)' : 'var(--card-bg)',
                    gap: 12,
                    boxSizing: 'border-box',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                    <FolderGit2
                      size={18}
                      color={isActive ? 'var(--accent)' : 'var(--text-dim)'}
                      style={{ flexShrink: 0 }}
                    />
                    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, gap: 2 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--font-semibold)', color: 'var(--text-main)' }}>
                          {p.name}
                        </span>
                        {isActive && (
                          <span
                            className="chip"
                            style={{
                              fontSize: 'var(--text-2xs)',
                              padding: '1px 6px',
                              color: 'var(--accent)',
                              borderColor: 'var(--accent)',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 3,
                            }}
                          >
                            <CheckCircle2 size={10} />
                            {t('projects.active')}
                          </span>
                        )}
                      </div>
                      <span
                        style={{
                          fontSize: 'var(--text-xs)',
                          color: 'var(--text-dim)',
                          fontFamily: 'var(--font-mono)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={p.path}
                      >
                        {p.path}
                      </span>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                    {!isActive && (
                      <button
                        className="btn btn-sm"
                        onClick={() => void handleSetActive(p.id)}
                        style={{ fontSize: 'var(--text-xs)', padding: '3px 8px' }}
                        title={t('projects.setActive')}
                      >
                        {t('projects.setActive')}
                      </button>
                    )}
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => void handleDelete(p)}
                      title={t('projects.delete')}
                      style={{ padding: '4px', color: 'var(--text-dim)' }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Dialog>
  );
};
