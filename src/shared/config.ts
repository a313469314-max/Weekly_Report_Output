import { z } from 'zod';
import type { ProjectConfig, ScheduledReport, SheetConfig } from './contracts';
import { createDefaultProjectConfig, PACKAGE_OPTIONS } from './defaults';
import { METRICS } from './metrics';
import { REALTIME_METRICS } from './realtime-metrics';

const realtimeConfigSchema = z.object({
  gameId: z.string(),
  currentGameVersionId: z.string().nullable(),
  pidInput: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  paymentStatsEndDate: z.string(),
  incomeType: z.enum(['amount', 'realamount']),
  includeReattribution: z.boolean(),
  pitcherFilters: z.array(z.string()).optional(),
  includePitcherDetails: z.boolean().optional(),
  titleTemplate: z.string(),
  metricOrder: z.array(z.string()),
});

const scheduledReportSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  gameId: z.string(),
  gameVersionId: z.string(),
  pidInput: z.string(),
  incomeType: z.enum(['amount', 'realamount']),
  includeReattribution: z.boolean(),
  pitcherFilters: z.array(z.string()).optional(),
  includePitcherDetails: z.boolean().optional(),
  titleTemplate: z.string(),
  metricOrder: z.array(z.string()),
  scheduleMode: z.enum(['fixed', 'interval']).optional(),
  startDate: z.string().optional(),
  endDate: z.string().nullable().optional(),
  intervalMinutes: z.number().optional(),
  intervalEndTime: z.string().optional(),
  times: z.array(z.string()),
  targetIds: z.array(z.string()),
});

const configSchema = z.object({
  gameId: z.string(),
  currentGameVersionId: z.string().nullable(),
  pidWhitelist: z.array(z.string()),
  pidNames: z.record(z.string()),
  pidPackageMap: z.record(z.string()),
  pidOperatingSystemMap: z.record(z.string()).optional(),
  mediaRules: z.array(z.object({ name: z.string(), aliases: z.array(z.string()), radidPrefixes: z.array(z.string()) })),
  bidCodeMap: z.record(z.string()),
  pitcherNameMap: z.record(z.string()).optional(),
  tapAdnKeywords: z.array(z.string()).optional(),
  defaultIncomeType: z.enum(['amount', 'realamount']),
  defaultMetrics: z.array(z.string()),
  sheetConfigs: z.array(z.object({ id: z.string(), name: z.string(), kind: z.enum(['overall', 'media', 'bid', 'pitcher', 'validation']), media: z.string().optional(), showDaily: z.boolean(), metricOrder: z.array(z.string()) })),
  thresholds: z.object({ amount: z.number(), percentagePoint: z.number() }),
  outputDirectory: z.string(),
  fileNameRule: z.string(),
  realtimeConfig: realtimeConfigSchema.optional(),
  scheduledReports: z.array(scheduledReportSchema).optional(),
});

function normalizeScheduledReports(value: z.infer<typeof scheduledReportSchema>[], validMetrics: Set<string>): ScheduledReport[] {
  const ids = new Set<string>();
  return value.flatMap((report): ScheduledReport[] => {
    const id = report.id.trim();
    const name = report.name.trim();
    const gameId = report.gameId.trim();
    const gameVersionId = report.gameVersionId.trim();
    const pidInput = report.pidInput.trim();
    const times = [...new Set(report.times.map((time) => time.trim()).filter((time) => /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(time)))].sort();
    const targetIds = [...new Set(report.targetIds.map((targetId) => targetId.trim()).filter(Boolean))];
    const scheduleMode = report.scheduleMode === 'interval' ? 'interval' : 'fixed';
    const startDate = typeof report.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(report.startDate.trim()) ? report.startDate.trim() : '';
    const endDate = report.endDate === null
      ? null
      : typeof report.endDate === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(report.endDate.trim()) ? report.endDate.trim() : null;
    const intervalMinutes = Number.isInteger(report.intervalMinutes) && (report.intervalMinutes ?? 0) >= 1 && (report.intervalMinutes ?? 0) <= 1440
      ? report.intervalMinutes
      : undefined;
    const intervalEndTime = typeof report.intervalEndTime === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(report.intervalEndTime.trim())
      ? report.intervalEndTime.trim()
      : undefined;
    if (ids.has(id) || !id || !name || !/^\d{4,}$/u.test(gameId) || !gameVersionId || !pidInput || times.length === 0) return [];
    if (scheduleMode === 'interval' && (!startDate || intervalMinutes === undefined || (endDate !== null && endDate < startDate))) return [];
    if (scheduleMode === 'interval' && report.intervalEndTime !== undefined && (!intervalEndTime || times[0] >= intervalEndTime)) return [];
    ids.add(id);
    const normalized: ScheduledReport = {
      id,
      name,
      enabled: report.enabled && targetIds.length > 0,
      gameId,
      gameVersionId,
      pidInput,
      incomeType: report.incomeType,
      includeReattribution: report.includeReattribution,
      pitcherFilters: [...new Set((report.pitcherFilters ?? []).map((value) => value.trim()).filter(Boolean))],
      includePitcherDetails: report.includePitcherDetails === true,
      titleTemplate: report.titleTemplate,
      metricOrder: [...new Set(report.metricOrder)].filter((metric) => validMetrics.has(metric)) as ScheduledReport['metricOrder'],
      times: scheduleMode === 'interval' ? [times[0]] : times,
      targetIds,
    };
    if (report.scheduleMode !== undefined || report.startDate !== undefined || report.endDate !== undefined || report.intervalMinutes !== undefined || report.intervalEndTime !== undefined) {
      normalized.scheduleMode = scheduleMode;
      normalized.startDate = startDate;
      normalized.endDate = endDate;
      if (scheduleMode === 'interval') normalized.intervalMinutes = intervalMinutes;
      if (scheduleMode === 'interval' && intervalEndTime) normalized.intervalEndTime = intervalEndTime;
    }
    return [normalized];
  });
}

export function normalizeProjectConfig(value: unknown): ProjectConfig {
  const defaults = createDefaultProjectConfig();
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) return defaults;
  const validMetrics = new Set(METRICS.map((metric) => metric.key));
  const cleanMetrics = (metrics: string[]) => [...new Set(metrics)].filter((metric) => validMetrics.has(metric as never)) as ProjectConfig['defaultMetrics'];
  const validRealtimeMetrics = new Set(REALTIME_METRICS.map((metric) => metric.key));
  const cleanRealtimeMetrics = (metrics: string[]) => [...new Set(metrics)].filter((metric) => validRealtimeMetrics.has(metric as never)) as ProjectConfig['realtimeConfig']['metricOrder'];
  const validPackages = new Set<string>(PACKAGE_OPTIONS);
  const cleanPidPackageMap = Object.fromEntries(
    Object.entries(parsed.data.pidPackageMap)
      .filter(([pid, packageName]) => /^\d+$/u.test(pid) && validPackages.has(packageName)),
  );
  const sheetConfigs = parsed.data.sheetConfigs.length > 0
    ? parsed.data.sheetConfigs.map((sheet) => ({
      ...sheet,
      name: sheet.id === 'tap' && sheet.name === '媒体数据汇总-TAP' ? '媒体数据汇总-TapTap' : sheet.name,
      metricOrder: cleanMetrics(sheet.metricOrder),
    }))
    : defaults.sheetConfigs;
  const normalizedSheetConfigs = [...sheetConfigs] as SheetConfig[];
  if (!normalizedSheetConfigs.some((sheet) => sheet.id === 'pitcher')) {
    const pitcher = defaults.sheetConfigs.find((sheet) => sheet.id === 'pitcher');
    if (pitcher) {
      const validationIndex = normalizedSheetConfigs.findIndex((sheet) => sheet.kind === 'validation');
      normalizedSheetConfigs.splice(validationIndex >= 0 ? validationIndex : normalizedSheetConfigs.length, 0, pitcher);
    }
  }
  const pitcherNameMap = Object.fromEntries(
    Object.entries(parsed.data.pitcherNameMap ?? {})
      .map(([code, name]) => [code.trim(), name.trim()] as const)
      .filter(([code, name]) => Boolean(code && name)),
  );
  return {
    ...defaults,
    ...parsed.data,
    pidPackageMap: cleanPidPackageMap,
    pidOperatingSystemMap: parsed.data.pidOperatingSystemMap ?? defaults.pidOperatingSystemMap,
    mediaRules: parsed.data.mediaRules as ProjectConfig['mediaRules'],
    pitcherNameMap,
    tapAdnKeywords: parsed.data.tapAdnKeywords ?? defaults.tapAdnKeywords,
    sheetConfigs: normalizedSheetConfigs as ProjectConfig['sheetConfigs'],
    defaultMetrics: cleanMetrics(parsed.data.defaultMetrics),
    realtimeConfig: {
      ...defaults.realtimeConfig,
      ...parsed.data.realtimeConfig,
      pitcherFilters: [...new Set((parsed.data.realtimeConfig?.pitcherFilters ?? defaults.realtimeConfig.pitcherFilters ?? []).map((value) => value.trim()).filter(Boolean))],
      includePitcherDetails: parsed.data.realtimeConfig?.includePitcherDetails === true,
      metricOrder: cleanRealtimeMetrics(parsed.data.realtimeConfig?.metricOrder ?? defaults.realtimeConfig.metricOrder),
    },
    scheduledReports: normalizeScheduledReports(parsed.data.scheduledReports ?? [], validRealtimeMetrics),
  };
}
