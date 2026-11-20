import React, { useMemo, useState } from 'react';
import { FolderCog } from 'lucide-react';
import type { ProjectItem } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { Combobox, type ComboboxOption } from './Combobox';
import { ProjectsDialog } from './ProjectsDialog';

export interface ProjectPickerProps {
  projects: ProjectItem[];
  value: string;
  onChange: (projectId: string) => void;
  /** Called when projects are added, deleted, or active project changes via the built-in dialog. */
  onProjectsChange?: (projects: ProjectItem[], activeId: string | null) => void;
  /** Optional external manage handler; when provided, skips rendering an internal ProjectsDialog. */
  onManage?: () => void;
  placeholder?: string;
  /** Show text label next to the manage icon button (e.g. in page toolbars). */
  showManageLabel?: boolean;
  comboboxContainerStyle?: React.CSSProperties;
  buttonHeight?: number;
}

/** Keep current selection if it still exists; otherwise fall back to activeId or the first project. */
export function reconcileProjectSelection(
  currentId: string | null | undefined,
  projects: ProjectItem[],
  activeId: string | null
): string {
  if (currentId && projects.some((p) => p.id === currentId)) {
    return currentId;
  }
  return activeId ?? projects[0]?.id ?? '';
}

export const ProjectPicker: React.FC<ProjectPickerProps> = ({
  projects,
  value,
  onChange,
  onProjectsChange,
  onManage,
  placeholder,
  showManageLabel = false,
  comboboxContainerStyle,
  buttonHeight,
}) => {
  const { t } = useI18n();
  const [dialogOpen, setDialogOpen] = useState(false);

  const options: ComboboxOption[] = useMemo(
    () =>
      projects.map((p) => ({
        value: p.id,
        label: p.name || p.path,
        meta: p.path,
      })),
    [projects]
  );

  const openManage = () => {
    if (onManage) {
      onManage();
    } else {
      setDialogOpen(true);
    }
  };

  return (
    <>
      {projects.length === 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: buttonHeight ?? 30 }}>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--accent-rose)' }}>
            {t('harness.noProjectsAvailable')}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={openManage}
            style={buttonHeight ? { height: buttonHeight } : undefined}
          >
            {t('projects.add')}
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <div style={comboboxContainerStyle ?? { flex: 1, minWidth: 0 }}>
            <Combobox
              value={value}
              onChange={onChange}
              options={options}
              placeholder={placeholder ?? t('harness.selectProjectPlaceholder')}
              hideMetaInTrigger
              panelMinWidth={280}
            />
          </div>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={openManage}
            title={t('harness.manageProjects')}
            aria-label={t('harness.manageProjects')}
            style={
              buttonHeight || showManageLabel
                ? {
                    ...(buttonHeight ? { height: buttonHeight } : {}),
                    padding: '0 6px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                  }
                : undefined
            }
          >
            <FolderCog size={14} />
            {showManageLabel && <span style={{ fontSize: 'var(--text-sm)' }}>{t('projects.title')}</span>}
          </button>
        </div>
      )}

      {!onManage && (
        <ProjectsDialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          onProjectsChange={onProjectsChange}
        />
      )}
    </>
  );
};
