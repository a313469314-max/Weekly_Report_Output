import { z } from 'zod';
import type { ProjectConfig, SheetConfig } from './contracts';
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
  titleTemplate: z.string(),
  metricOrder: z.array(z.string()),
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
});

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
    ? parsed.data.sheetConfigs.map((sheet) => ({ ...sheet, metricOrder: cleanMetrics(sheet.metricOrder) }))
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
      metricOrder: cleanRealtimeMetrics(parsed.data.realtimeConfig?.metricOrder ?? defaults.realtimeConfig.metricOrder),
    },
  };
}
