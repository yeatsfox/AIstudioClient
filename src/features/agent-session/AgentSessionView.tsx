import React from 'react';
import { getTranslator } from '@/i18n/coreTranslations';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUIStore } from '@/stores/uiStore';
import { ChatWidthControls } from '@/components/chat/width/ChatWidthControls';
import {
  useAgentSessionStore,
  type AgentBlock,
  type AgentPermissionNotice,
  type AgentTurn,
} from './agentSessionStore';
import { useAgentSessionRunner } from './useAgentSessionRunner';

/**
 * Renders one tool invocation as a compact, expandable card.
 *
 * Tool calls are the reason this view exists: a native agent's value is
 * mostly in what it ran and what came back. Hiding them in a log makes the
 * session look like a slow chat, so the command line and a few lines of output
 * are always visible, with the full output available on expand.
 */
const OUTPUT_PREVIEW_LINES = 6;

const toolTitle = (block: Extract<AgentBlock, { kind: 'tool' }>): string => {
  const params = block.parameters || {};
  // Antigravity's run_command passes the command as CommandLine; other tools
  // carry a path. Prefer whichever is present so the card header is useful.
  const command = params.CommandLine ?? params.command ?? params.path ?? params.TargetFile;
  return typeof command === 'string' ? command : block.toolName;
};

const ToolCard: React.FC<{
  block: Extract<AgentBlock, { kind: 'tool' }>;
  t: (key: string, params?: Record<string, string | number>) => string;
}> = ({ block, t }) => {
  const [expanded, setExpanded] = React.useState(false);
  const lines = (block.output || '').split('\n');
  const isTruncatable = lines.length > OUTPUT_PREVIEW_LINES;
  const shown = expanded || !isTruncatable ? block.output : lines.slice(0, OUTPUT_PREVIEW_LINES).join('\n');

  return (
    <div className="my-2 rounded-lg border border-[var(--theme-border-secondary)] bg-[var(--theme-bg-secondary)]">
      <div className="flex items-center gap-2 px-3 py-2">
        <span
          aria-hidden="true"
          className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${
            block.state === 'failed'
              ? 'bg-red-500'
              : block.state === 'running'
                ? 'animate-pulse bg-amber-500'
                : 'bg-emerald-500'
          }`}
        />
        <code className="flex-1 truncate text-xs text-[var(--theme-text-primary)]" title={toolTitle(block)}>
          {toolTitle(block)}
        </code>
        <span className="flex-shrink-0 text-[10px] uppercase tracking-wide text-[var(--theme-text-tertiary)]">
          {block.toolName}
        </span>
      </div>

      {block.error ? (
        <div className="border-t border-[var(--theme-border-secondary)] px-3 py-2 text-xs text-red-600 dark:text-red-300">
          {block.error}
        </div>
      ) : null}

      {shown ? (
        <div className="border-t border-[var(--theme-border-secondary)] px-3 py-2">
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs text-[var(--theme-text-secondary)]">
            {shown}
          </pre>
          {isTruncatable ? (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              className="mt-1 text-xs text-[var(--theme-accent)] hover:underline"
            >
              {expanded ? t('agentCollapseOutput') : t('agentExpandOutput', { count: lines.length })}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

/**
 * One soft-denied tool, with an approve action when a rule could be built.
 *
 * Approving writes the rule to the CLI's global settings, which affects every
 * future session, so the exact rule is shown before the click and the state of
 * the approval is shown after it. A notice with no buildable rule keeps its text
 * and gets no button rather than writing a guessed target.
 */
const PermissionNoticeRow: React.FC<{
  entry: AgentPermissionNotice;
  t: (key: string, params?: Record<string, string | number>) => string;
  onApprove: (notice: string, rule: string) => void;
}> = ({ entry, t, onApprove }) => {
  const [pending, setPending] = React.useState(false);
  const resolution = entry.resolution;

  const handleClick = async () => {
    if (!entry.request || pending) return;
    setPending(true);
    await onApprove(entry.notice, entry.request.rule);
    setPending(false);
  };

  return (
    <li className="space-y-1">
      <div className="break-words">{entry.notice}</div>
      {entry.request && !resolution ? (
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded bg-[var(--theme-bg-tertiary)] px-1.5 py-0.5 text-[11px]">{entry.request.rule}</code>
          <button
            type="button"
            onClick={handleClick}
            disabled={pending}
            className="rounded border border-amber-600/50 px-2 py-0.5 text-[11px] font-medium hover:bg-amber-500/20 disabled:opacity-50"
          >
            {pending ? t('agentPermissionApproving') : t('agentPermissionAllow')}
          </button>
        </div>
      ) : null}
      {resolution?.status === 'allowed' ? (
        <div className="text-[11px] text-[var(--theme-text-tertiary)]">
          {t('agentPermissionAllowed', { rule: resolution.rule })}
        </div>
      ) : null}
      {resolution?.status === 'failed' ? (
        <div className="text-[11px] text-red-600 dark:text-red-300">
          {t('agentPermissionAllowFailed', { message: resolution.message })}
        </div>
      ) : null}
    </li>
  );
};

const TurnView: React.FC<{
  turn: AgentTurn;
  t: (key: string, params?: Record<string, string | number>) => string;
  onApprove: (notice: string, rule: string) => void;
}> = ({
  turn,
  t,
  onApprove,
}) => (
  <div className="mb-6">
    <div className="mb-2 flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-[var(--theme-bg-tertiary)] px-4 py-2 text-sm text-[var(--theme-text-primary)]">
        {turn.prompt}
      </div>
    </div>

    <div className="px-1">
      {turn.blocks.map((block) =>
        block.kind === 'text' ? (
          <div
            key={block.id}
            className="my-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--theme-text-primary)]"
          >
            {block.text}
          </div>
        ) : (
          <ToolCard key={block.id} block={block} t={t} />
        ),
      )}

      {turn.status === 'running' && turn.blocks.length === 0 ? (
        <div className="my-2 text-sm text-[var(--theme-text-tertiary)]">{t('agentRunning')}</div>
      ) : null}

      {turn.permissionNotices.length > 0 ? (
        // A soft-denied tool is the one failure a user can fix, so it gets an
        // explicit callout naming the tool rather than a generic error.
        <div className="my-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <div className="font-medium">{t('agentPermissionDeniedTitle')}</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {turn.permissionNotices.map((entry) => (
              <PermissionNoticeRow key={entry.notice} entry={entry} t={t} onApprove={onApprove} />
            ))}
          </ul>
        </div>
      ) : null}

      {turn.status === 'failed' && turn.errorMessage ? (
        <div className="my-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-300">
          {turn.errorMessage}
        </div>
      ) : null}

      {turn.status === 'stopped' ? (
        <div className="my-2 text-xs text-[var(--theme-text-tertiary)]">{t('agentStopped')}</div>
      ) : null}

      {turn.usage?.totalTokens ? (
        <div className="mt-1 text-[11px] text-[var(--theme-text-tertiary)]">
          {turn.usage.totalTokens.toLocaleString()} tokens
          {turn.durationSeconds ? ` · ${turn.durationSeconds.toFixed(1)}s` : ''}
        </div>
      ) : null}
    </div>
  </div>
);

export const AgentSessionView: React.FC = () => {
  const language = useSettingsStore((state) => state.language);
  const t = React.useMemo(() => getTranslator(language), [language]);

  const {
    turns,
    cwd,
    model,
    connection,
    busy,
    transportError,
    availableHarnesses,
    permissionMode,
  } = useAgentSessionStore();

  const setCwd = useAgentSessionStore((state) => state.setCwd);
  const setModel = useAgentSessionStore((state) => state.setModel);
  const harness = useAgentSessionStore((state) => state.harness);

  const [draft, setDraft] = React.useState('');
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const areaRef = React.useRef<HTMLDivElement | null>(null);
  const { send, stop, detect, approve } = useAgentSessionRunner();
  const setActiveView = useUIStore((state) => state.setActiveView);

  // Ask the main process which harnesses exist as soon as this view mounts, so
  // the "not installed" notice is accurate instead of a guess.
  React.useEffect(() => {
    void detect();
  }, [detect]);

  // Follow the tail while the agent is producing output, which is the only
  // moment where new content can appear below the fold unbidden.
  React.useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [turns]);

  const harnessInfo = availableHarnesses.find((candidate) => candidate.id === harness);
  // Three distinct states, and they need different advice: no desktop shell at
  // all, the CLI missing from PATH, or a detected CLI that is simply idle.
  const unsupported = connection === 'unsupported';
  const cliMissing = !unsupported && harnessInfo !== undefined && !harnessInfo.installed;
  const notInstalled = unsupported || cliMissing;

  const pickFolder = async () => {
    const picked = await window.__AMC_DESKTOP__?.pickDirectory?.();
    if (picked?.path) setCwd(picked.path);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const prompt = draft;
    setDraft('');
    await send(prompt);
  };

  return (
    // Same shell as ChatArea: grow to fill the column, never shrink below the
    // content, and keep the scroll inside. Without `flex-grow min-w-0` this
    // panel sized itself to its content and left a dead strip on the right that
    // the width handles had nothing to attach to.
    <div
      ref={areaRef}
      className="flex flex-col flex-grow min-w-0 h-full overflow-hidden relative bg-[var(--theme-bg-primary)]"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--theme-border-secondary)] px-4 py-2">
        <span className="text-sm font-medium text-[var(--theme-text-primary)]">{t('agentTabTitle', 'Agent 会话')}</span>
        <span className="rounded bg-[var(--theme-bg-tertiary)] px-1.5 py-0.5 text-[11px] text-[var(--theme-text-secondary)]">
          {harnessInfo?.label ?? 'Antigravity'}
        </span>

        {/*
          The session is a mode of the same conversation window, not a separate
          page, so the switch sits where a tab would. Chat returns to the normal
          composer; this panel is the CLI mode of the same slot.
        */}
        <div
          role="tablist"
          aria-label={t('agentModeSwitchLabel')}
          className="ml-2 flex items-center gap-0.5 rounded-full bg-[var(--theme-bg-tertiary)] p-0.5"
        >
          <button
            type="button"
            role="tab"
            aria-selected={false}
            onClick={() => setActiveView('chat')}
            className="rounded-full px-3 py-1 text-[11px] text-[var(--theme-text-secondary)] hover:text-[var(--theme-text-primary)]"
          >
            {t('agentModeChat')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected
            className="rounded-full bg-[var(--theme-accent)] px-3 py-1 text-[11px] font-medium text-white"
          >
            {t('agentModeCli')}
          </button>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder={t('agentModelPlaceholder')}
            className="w-40 rounded border border-[var(--theme-border-secondary)] bg-[var(--theme-bg-secondary)] px-2 py-1 text-xs text-[var(--theme-text-primary)] outline-none focus:border-[var(--theme-border-focus)]"
            aria-label="agent model"
          />
          <button
            type="button"
            onClick={pickFolder}
            className="max-w-[16rem] truncate rounded border border-[var(--theme-border-secondary)] px-2 py-1 text-xs text-[var(--theme-text-secondary)] hover:text-[var(--theme-text-primary)]"
            title={cwd || t('agentFolderPlaceholder')}
          >
            {cwd || t('agentFolderPlaceholder')}
          </button>
          {permissionMode ? (
            <span className="text-[11px] text-[var(--theme-text-tertiary)]">{permissionMode}</span>
          ) : null}
        </div>
      </div>

      {notInstalled ? (
        <div className="border-b border-[var(--theme-border-secondary)] bg-[var(--theme-bg-secondary)] px-4 py-2 text-xs text-[var(--theme-text-secondary)]">
          {unsupported
            ? t('agentUnavailableDesktop')
            : t('agentCliMissing')}
        </div>
      ) : null}

      {transportError ? (
        <div className="border-b border-[var(--theme-border-secondary)] px-4 py-2 text-xs text-red-600 dark:text-red-300">
          {transportError}
        </div>
      ) : null}

      {/*
        Shares the chat width preference, so dragging the column here and in the
        chat view agree: one window, one reading width.
      */}
      <ChatWidthControls containerRef={areaRef} />

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        <div className="chat-message-list-scroller mx-auto w-full" style={{ maxWidth: 'var(--chat-content-width, 44.35rem)' }}>
          {turns.length === 0 ? (
            <div className="mt-16 text-center text-sm text-[var(--theme-text-tertiary)]">{t('agentEmptyHint')}</div>
          ) : (
            turns.map((turn) => <TurnView key={turn.id} turn={turn} t={t} onApprove={approve} />)
          )}
        </div>
      </div>

      <form onSubmit={submit} className="border-t border-[var(--theme-border-secondary)] p-3">
        <div
          className="mx-auto flex w-full items-end gap-2"
          style={{ maxWidth: 'var(--chat-content-width, 44.35rem)' }}
        >
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void submit(event);
              }
            }}
            rows={2}
            placeholder={notInstalled ? t('agentUnavailableDesktop') : t('agentPromptPlaceholder')}
            disabled={Boolean(notInstalled) || busy}
            className="flex-1 resize-none rounded-lg border border-[var(--theme-border-secondary)] bg-[var(--theme-bg-secondary)] px-3 py-2 text-sm text-[var(--theme-text-primary)] outline-none focus:border-[var(--theme-border-focus)] disabled:opacity-50"
          />
          {busy ? (
            <button
              type="button"
              onClick={() => void stop()}
              className="rounded-lg border border-[var(--theme-border-secondary)] px-4 py-2 text-sm text-[var(--theme-text-primary)]"
            >
              {t('agentStop')}
            </button>
          ) : (
            <button
              type="submit"
              disabled={Boolean(notInstalled) || !draft.trim()}
              className="rounded-lg bg-[var(--theme-accent)] px-4 py-2 text-sm text-white disabled:opacity-40"
            >
              {t('agentSend')}
            </button>
          )}
        </div>
      </form>
    </div>
  );
};
