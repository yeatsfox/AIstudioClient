import React, { useEffect, useState } from 'react';
import { useI18n } from '@/contexts/I18nContext';
import { isWorkspaceEnabled } from '@/features/workspaces/workspaceModel';
import {
  canPickWorkspaceDirectory,
  pickWorkspaceDirectory,
  useWorkspaceStore,
} from '@/stores/workspaceStore';

/**
 * Workspace management for the desktop build.
 *
 * A workspace is a local directory the assistant may read and write. The list
 * is the permission boundary: what is here is reachable, what is not, isn't.
 * Directories are added through the OS folder picker — the browser cannot open
 * one, so on the web this section explains why the feature is unavailable
 * instead of showing a button that cannot work.
 */
export const WorkspacesSection: React.FC = () => {
  const { t } = useI18n();
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const isLoaded = useWorkspaceStore((state) => state.isLoaded);
  const add = useWorkspaceStore((state) => state.add);
  const remove = useWorkspaceStore((state) => state.remove);
  const rename = useWorkspaceStore((state) => state.rename);
  const setEnabled = useWorkspaceStore((state) => state.setEnabled);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [pickerAvailable, setPickerAvailable] = useState(false);
  const [duplicatePath, setDuplicatePath] = useState<string | null>(null);

  // The preload bridge is installed before the page script runs, but reading it
  // after mount keeps the server-rendered markup from differing.
  useEffect(() => {
    setPickerAvailable(canPickWorkspaceDirectory());
  }, []);

  const handleAdd = async () => {
    const picked = await pickWorkspaceDirectory();
    if (!picked) return;

    const created = add(picked.path, picked.title);
    if (!created) {
      // The only way add() returns null for a valid pick is a duplicate path.
      setDuplicatePath(picked.path);
    } else {
      setDuplicatePath(null);
    }
  };

  const startRename = (id: string, current: string) => {
    setEditingId(id);
    setDraftTitle(current);
  };

  const commitRename = () => {
    if (editingId) rename(editingId, draftTitle);
    setEditingId(null);
    setDraftTitle('');
  };

  return (
    <div className="space-y-4" data-testid="workspaces-section">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-[var(--theme-text-primary)]">
          {t('settingsWorkspacesTitle')}
        </h3>
        <p className="text-xs leading-relaxed text-[var(--theme-text-secondary)]">
          {t('settingsWorkspacesDescription')}
        </p>
      </div>

      {!pickerAvailable && (
        <div className="rounded-lg border border-[var(--theme-border-secondary)] bg-[var(--theme-bg-secondary)] px-3 py-2 text-xs leading-relaxed text-[var(--theme-text-secondary)]">
          {t('settingsWorkspacesDesktopOnly')}
        </div>
      )}

      {duplicatePath && (
        <div className="rounded-lg border border-[var(--theme-border-secondary)] px-3 py-2 text-xs text-[var(--theme-text-secondary)]">
          {t('settingsWorkspacesDuplicate')}
        </div>
      )}

      {isLoaded && workspaces.length === 0 && (
        <div className="rounded-lg border border-dashed border-[var(--theme-border-secondary)] px-4 py-6 text-center text-xs text-[var(--theme-text-tertiary)]">
          {t('settingsWorkspacesEmpty')}
        </div>
      )}

      <div className="space-y-2">
        {workspaces.map((workspace) => {
          const enabled = isWorkspaceEnabled(workspace);
          const isEditing = editingId === workspace.id;
          return (
            <div
              key={workspace.id}
              className="rounded-lg border border-[var(--theme-border-secondary)] bg-[var(--theme-bg-secondary)] px-3 py-2.5"
              data-testid={`workspace-row-${workspace.id}`}
            >
              <div className="flex items-center gap-2">
                {isEditing ? (
                  <input
                    autoFocus
                    value={draftTitle}
                    onChange={(event) => setDraftTitle(event.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitRename();
                      if (event.key === 'Escape') setEditingId(null);
                    }}
                    className="min-w-0 flex-1 rounded border border-[var(--theme-border-secondary)] bg-[var(--theme-bg-primary)] px-2 py-1 text-xs text-[var(--theme-text-primary)] outline-none focus:border-[var(--theme-border-focus)]"
                    aria-label={t('settingsWorkspacesRename')}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => startRename(workspace.id, workspace.title)}
                    className="min-w-0 flex-1 truncate text-left text-xs font-medium text-[var(--theme-text-primary)] hover:underline"
                    title={t('settingsWorkspacesRename')}
                  >
                    {workspace.title}
                  </button>
                )}

                <label className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--theme-text-secondary)]">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(event) => setEnabled(workspace.id, event.target.checked)}
                    className="h-3.5 w-3.5"
                    aria-label={t('settingsWorkspacesEnabled')}
                  />
                  {t('settingsWorkspacesEnabled')}
                </label>

                <button
                  type="button"
                  onClick={() => remove(workspace.id)}
                  className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-[var(--theme-text-tertiary)] hover:text-[var(--theme-text-primary)]"
                  aria-label={t('settingsWorkspacesRemove')}
                >
                  {t('settingsWorkspacesRemove')}
                </button>
              </div>

              <div
                className="mt-1 truncate font-mono text-[11px] text-[var(--theme-text-tertiary)]"
                title={workspace.path}
              >
                {workspace.path}
              </div>
            </div>
          );
        })}
      </div>

      {pickerAvailable && (
        <button
          type="button"
          onClick={handleAdd}
          className="rounded-lg border border-[var(--theme-border-secondary)] bg-[var(--theme-bg-secondary)] px-3 py-2 text-xs font-medium text-[var(--theme-text-primary)] hover:bg-[var(--theme-bg-tertiary)]"
          data-testid="workspace-add-button"
        >
          {t('settingsWorkspacesAdd')}
        </button>
      )}
    </div>
  );
};
