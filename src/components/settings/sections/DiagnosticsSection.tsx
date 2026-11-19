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

const STATUS_STYLES: Record<DiagnosticStatus, { dot: string; badge: string; text: string }> = {
  ok: { dot: 'bg-emerald-400', badge: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30', text: '' },
  warn: { dot: 'bg-amber-400', badge: 'bg-amber-500/10 text-amber-300 border-amber-500/30', text: '' },
  fail: { dot: 'bg-rose-400', badge: 'bg-rose-500/10 text-rose-300 border-rose-500/30', text: '' },
  skip: { dot: 'bg-white/25', badge: 'bg-white/5 text-white/45 border-white/10', text: '' },
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
      <li key={check.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
        <div className="flex items-start gap-3">
          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${styles.dot}`} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-white/90">{t(check.labelKey)}</span>
              <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${styles.badge}`}>
                {t(STATUS_LABEL_KEYS[check.status])}
              </span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-white/60">{detail}</p>
            {check.hintKey && <p className="mt-1 text-xs leading-relaxed text-white/40">{t(check.hintKey)}</p>}
          </div>
          {check.fixTab && onNavigateToTab && (check.status === 'fail' || check.status === 'warn') && (
            <button
              type="button"
              onClick={() => onNavigateToTab(check.fixTab!)}
              className="shrink-0 rounded-lg border border-white/15 px-2 py-1 text-xs text-white/70 transition hover:bg-white/10 hover:text-white"
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
          <h3 className="text-base font-semibold text-white/90">{t('diagnosticsTitle')}</h3>
          <p className="mt-1 text-xs leading-relaxed text-white/50">{headline}</p>
        </div>
        <button
          type="button"
          onClick={() => void run()}
          disabled={isRunning}
          className="shrink-0 rounded-lg border border-white/15 px-3 py-1.5 text-xs font-medium text-white/80 transition enabled:hover:bg-white/10 disabled:opacity-50"
        >
          {isRunning ? t('diagnosticsRunning') : t('diagnosticsRerun')}
        </button>
      </div>

      <ul className="space-y-2">{report?.checks.map(renderCheck)}</ul>

      {ranAt && (
        <p className="text-[11px] text-white/30">
          {t('diagnosticsLastRun')} {new Date(ranAt).toLocaleTimeString()}
        </p>
      )}

      <p className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5 text-[11px] leading-relaxed text-white/35">
        {t('diagnosticsReadOnlyNote')}
      </p>
    </div>
  );
};
