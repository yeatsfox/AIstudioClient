import { logService } from '@/services/logService';
import { useEffect, useMemo, useState } from 'react';
import { dbService, type ApiUsageRecord } from '@/services/db/dbService';
import {
  calculateApiUsageRecordPriceUsd,
  summarizeCacheEconomics,
  type CacheEconomics,
} from '@/utils/pricing/usagePricing';

export type UsageTimeRange = 'today' | '7d' | '30d' | 'all';

interface UsageSummary {
  totalRequests: number;
  totalPromptTokens: number;
  totalCachedPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  estimatedCostPricedRequests: number;
  estimatedCostUnavailableRequests: number;
}

export interface UsageModelBreakdown extends UsageSummary {
  modelId: string;
  cacheEconomics: CacheEconomics;
}

const EMPTY_SUMMARY: UsageSummary = {
  totalRequests: 0,
  totalPromptTokens: 0,
  totalCachedPromptTokens: 0,
  totalCompletionTokens: 0,
  totalTokens: 0,
  estimatedCostUsd: 0,
  estimatedCostPricedRequests: 0,
  estimatedCostUnavailableRequests: 0,
};

const getRangeBounds = (range: UsageTimeRange) => {
  const end = Date.now();

  if (range === 'all') {
    return { start: 0, end };
  }

  if (range === 'today') {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return { start: start.getTime(), end };
  }

  const days = range === '7d' ? 7 : 30;
  return { start: end - days * 24 * 60 * 60 * 1000, end };
};

const buildSummary = (records: ApiUsageRecord[]): UsageSummary =>
  records.reduce<UsageSummary>((summary, record) => {
    const cachedTokens = record.cachedPromptTokens ?? 0;
    const inputTokens = Math.max(record.promptTokens - cachedTokens, 0) + (record.toolUsePromptTokens ?? 0);
    const outputTokens = record.completionTokens + (record.thoughtTokens ?? 0);
    const totalTokens = inputTokens + cachedTokens + outputTokens;
    const estimatedCost = calculateApiUsageRecordPriceUsd(record);

    return {
      totalRequests: summary.totalRequests + 1,
      totalPromptTokens: summary.totalPromptTokens + inputTokens,
      totalCachedPromptTokens: summary.totalCachedPromptTokens + cachedTokens,
      totalCompletionTokens: summary.totalCompletionTokens + outputTokens,
      totalTokens: summary.totalTokens + totalTokens,
      estimatedCostUsd: summary.estimatedCostUsd + (estimatedCost ?? 0),
      estimatedCostPricedRequests: summary.estimatedCostPricedRequests + (estimatedCost === null ? 0 : 1),
      estimatedCostUnavailableRequests: summary.estimatedCostUnavailableRequests + (estimatedCost === null ? 1 : 0),
    };
  }, EMPTY_SUMMARY);

const buildBreakdown = (records: ApiUsageRecord[]): UsageModelBreakdown[] => {
  const grouped = new Map<string, UsageModelBreakdown>();

  records.forEach((record) => {
    const cachedTokens = record.cachedPromptTokens ?? 0;
    const inputTokens = Math.max(record.promptTokens - cachedTokens, 0) + (record.toolUsePromptTokens ?? 0);
    const outputTokens = record.completionTokens + (record.thoughtTokens ?? 0);
    const totalTokens = inputTokens + cachedTokens + outputTokens;
    const current = grouped.get(record.modelId) ?? {
      modelId: record.modelId,
      ...EMPTY_SUMMARY,
      cacheEconomics: summarizeCacheEconomics([]),
    };

    const estimatedCost = calculateApiUsageRecordPriceUsd(record);

    current.totalRequests += 1;
    current.totalPromptTokens += inputTokens;
    current.totalCachedPromptTokens += cachedTokens;
    current.totalCompletionTokens += outputTokens;
    current.totalTokens += totalTokens;
    current.estimatedCostUsd += estimatedCost ?? 0;
    current.estimatedCostPricedRequests += estimatedCost === null ? 0 : 1;
    current.estimatedCostUnavailableRequests += estimatedCost === null ? 1 : 0;
    // 逐个累加单条记录的缓存经济性，避免把整组再走一遍定价。
    const recordEconomics = summarizeCacheEconomics([record]);
    current.cacheEconomics = {
      cachedTokens: current.cacheEconomics.cachedTokens + recordEconomics.cachedTokens,
      cacheEligibleInputTokens:
        current.cacheEconomics.cacheEligibleInputTokens + recordEconomics.cacheEligibleInputTokens,
      cacheHitRate: 0,
      savedUsd:
        recordEconomics.savedUsd === null
          ? current.cacheEconomics.savedUsd
          : (current.cacheEconomics.savedUsd ?? 0) + recordEconomics.savedUsd,
      uncachedPriceUsd:
        recordEconomics.uncachedPriceUsd === null
          ? current.cacheEconomics.uncachedPriceUsd
          : (current.cacheEconomics.uncachedPriceUsd ?? 0) + recordEconomics.uncachedPriceUsd,
    };
    grouped.set(record.modelId, current);
  });

  return Array.from(grouped.values()).sort(
    (breakdownA, breakdownB) =>
      breakdownB.totalTokens - breakdownA.totalTokens || breakdownB.totalRequests - breakdownA.totalRequests,
  );
};

export const useUsageStats = () => {
  const [timeRange, setTimeRange] = useState<UsageTimeRange>('all');
  const [records, setRecords] = useState<ApiUsageRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setIsLoading(true);

      try {
        const { start, end } = getRangeBounds(timeRange);
        const result = await dbService.getApiUsageByTimeRange(start, end);

        if (!cancelled) {
          setRecords(result);
        }
      } catch (loadUsageError) {
        logService.error('Failed to load API usage data:', loadUsageError);
        if (!cancelled) {
          setRecords([]);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [timeRange]);

  const summary = useMemo(() => buildSummary(records), [records]);
  const byModel = useMemo(() => {
    // 命中率要等整组累加完才能算（分母是组内总和，不是单条）。
    return buildBreakdown(records).map((breakdown) => ({
      ...breakdown,
      cacheEconomics: {
        ...breakdown.cacheEconomics,
        cacheHitRate:
          breakdown.cacheEconomics.cacheEligibleInputTokens > 0
            ? breakdown.cacheEconomics.cachedTokens / breakdown.cacheEconomics.cacheEligibleInputTokens
            : 0,
      },
    }));
  }, [records]);
  const cacheEconomics = useMemo(() => summarizeCacheEconomics(records), [records]);

  return {
    timeRange,
    setTimeRange,
    isLoading,
    summary,
    byModel,
    cacheEconomics,
  };
};
