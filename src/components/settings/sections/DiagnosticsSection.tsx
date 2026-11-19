import { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/contexts/I18nContext';
import { interpolate } from '@/i18n/interpolate';
import {
  runDiagnostics,
  type DiagnosticCheck,
  type DiagnosticReport,
  type DiagnosticStatus,
} from '@/features/diagnostics/diagnostics';
import type { SettingsTab } from '@/stores/settingsUiStore';
import type { AppSettings } from '@/types';

interface DiagnosticsSectionProps {
  settings: AppSettings;
  /** 点「去修复」时切到对应设置页。 */
  onNavigateToTab?: (tab: SettingsTab) => void;
}

// Colours come from the theme variables, not fixed white/alpha: the settings
// panel ships a light theme too, and white-on-white made every label — the
// check names, the headline, the re-run button — invisible while the coloured
// status pills stayed readable. Only the pills have their own palette, since
// "warning" should look the same in both themes.
const STATUS_STYLES: Record<DiagnosticStatus, { dot: string; badge: string }> = {
  ok: { dot: 'bg-emerald-500', badge: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/40 dark:text-emerald-300' },
  warn: { dot: 'bg-amber-500', badge: 'bg-amber-500/10 text-amber-600 border-amber-500/40 dark:text-amber-300' },
  fail: { dot: 'bg-rose-500', badge: 'bg-rose-500/10 text-rose-600 border-rose-500/40 dark:text-rose-300' },
  skip: {
    dot: 'bg-[var(--theme-text-tertiary)]',
    badge: 'bg-[var(--theme-bg-tertiary)] text-[var(--theme-text-tertiary)] border-[var(--theme-border-secondary)]',
  },
};

const STATUS_LABEL_KEYS: Record<DiagnosticStatus, string> = {
  ok: 'diagnosticsStatusOk',
  warn: 'diagnosticsStatusWarn',
  fail: 'diagnosticsStatusFail',
  skip: 'diagnosticsStatusSkip',
};

export const DiagnosticsSection = ({ settings, onNavigateToTab }: DiagnosticsSectionProps) => {
  const { t } = useI18n();
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [ranAt, setRanAt] = useState<number | null>(null);

  const run = useCallback(async () => {
    setIsRunning(true);
    try {
      const next = await runDiagnostics(settings);
      setReport(next);
      setRanAt(Date.now());
    } finally {
      setIsRunning(false);
    }
  }, [settings]);

  // 打开页面先自动跑一次，用户不用先点按钮才知道结论。
  useEffect(() => {
    void run();
  }, [run]);

  const headline = useMemo(() => {
    if (!report) return t('diagnosticsRunning');
    if (report.failCount > 0) {
      return interpolate(t('diagnosticsHeadlineFail'), { count: report.failCount });
    }
    if (report.warnCount > 0) {
      return interpolate(t('diagnosticsHeadlineWarn'), { count: report.warnCount });
    }
    return t('diagnosticsHeadlineOk');
  }, [report, t]);

  const renderCheck = (check: DiagnosticCheck) => {
    const styles = STATUS_STYLES[check.status];
    const detail = check.detailParams ? interpolate(t(check.detailKey), check.detailParams) : t(check.detailKey);

    return (
      <li
        key={check.id}
        data-diagnostic-check={check.id}
        className="rounded-xl border border-[var(--theme-border-secondary)] bg-[var(--theme-bg-secondary)] p-3"
      >
        <div className="flex items-start gap-3">
          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${styles.dot}`} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-[var(--theme-text-primary)]">{t(check.labelKey)}</span>
              <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${styles.badge}`}>
                {t(STATUS_LABEL_KEYS[check.status])}
              </span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-[var(--theme-text-secondary)]">{detail}</p>
            {check.hintKey && (
              <p className="mt-1 text-xs leading-relaxed text-[var(--theme-text-tertiary)]">{t(check.hintKey)}</p>
            )}
          </div>
          {check.fixTab && onNavigateToTab && (check.status === 'fail' || check.status === 'warn') && (
            <button
              type="button"
              onClick={() => onNavigateToTab(check.fixTab!)}
              className="shrink-0 rounded-lg border border-[var(--theme-border-secondary)] px-2 py-1 text-xs text-[var(--theme-text-secondary)] transition hover:bg-[var(--theme-bg-tertiary)] hover:text-[var(--theme-text-primary)]"
            >
              {t('diagnosticsGoFix')}
            </button>
          )}
        </div>
      </li>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-[var(--theme-text-primary)]">{t('diagnosticsTitle')}</h3>
          <p className="mt-1 text-xs leading-relaxed text-[var(--theme-text-secondary)]">{headline}</p>
        </div>
        <button
          type="button"
          onClick={() => void run()}
          disabled={isRunning}
          className="shrink-0 rounded-lg border border-[var(--theme-border-secondary)] px-3 py-1.5 text-xs font-medium text-[var(--theme-text-primary)] transition enabled:hover:bg-[var(--theme-bg-tertiary)] disabled:opacity-50"
        >
          {isRunning ? t('diagnosticsRunning') : t('diagnosticsRerun')}
        </button>
      </div>

      <ul className="space-y-2">{report?.checks.map(renderCheck)}</ul>

      {ranAt && (
        <p className="text-[11px] text-[var(--theme-text-tertiary)]">
          {t('diagnosticsLastRun')} {new Date(ranAt).toLocaleTimeString()}
        </p>
      )}

      <p className="rounded-lg border border-[var(--theme-border-secondary)] bg-[var(--theme-bg-secondary)] p-2.5 text-[11px] leading-relaxed text-[var(--theme-text-tertiary)]">
        {t('diagnosticsReadOnlyNote')}
      </p>
    </div>
  );
};
