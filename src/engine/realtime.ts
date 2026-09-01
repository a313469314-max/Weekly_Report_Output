import type { AggregateTotals, RawAdRow, RealtimeMetricKey } from '../shared/contracts';
import { realtimeMetricByKey } from '../shared/realtime-metrics';
import { calculateMetric, groupRows } from './aggregation';
import { materializeMixedPidRows } from './mixed-pid';

export interface RealtimeTextOptions {
  pids: string[];
  pidNames: Record<string, string>;
  titleTemplate: string;
  metricOrder: RealtimeMetricKey[];
}

function calculateRealtimeMetric(metric: RealtimeMetricKey, totals: AggregateTotals): number | null {
  if (metric === 'activationLoginRate') return calculateMetric('activationLoginRate', totals);
  if (metric === 'loginPayRate') return totals.loginDevices === 0 ? 0 : totals.payingDevices / totals.loginDevices;
  return calculateMetric(metric, totals);
}

function formatMetric(metric: RealtimeMetricKey, value: number | null): string {
  if (value === null) return '-';
  const definition = realtimeMetricByKey.get(metric);
  if (definition?.format === 'percent') return `${(value * 100).toFixed(2)}%`;
  if (definition?.format === 'number') return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value);
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
}

function formatTitle(template: string, pid: string, pidName: string): string {
  const result = (template.trim() || '【{pidName}】')
    .replaceAll('{pidName}', pidName || pid)
    .replaceAll('{pid}', pid);
  return result.trim() || `【${pidName || pid}】`;
}

export function buildRealtimeText(rows: RawAdRow[], options: RealtimeTextOptions): string {
  const materialized = materializeMixedPidRows(rows).rows.filter((row) => !row.isMixedSystemBreakdown && !row.isCrossSystemSummary);
  const grouped = new Map(groupRows(materialized, [(row) => ['pid', row.pid]]).map((group) => [group.dimensions.pid, group]));
  const names = new Map<string, string>(Object.entries(options.pidNames));
  for (const row of materialized) if (row.pidName && !names.get(row.pid)) names.set(row.pid, row.pidName);
  const metrics = [...new Set(options.metricOrder)].filter((metric) => realtimeMetricByKey.has(metric));
  return options.pids.map((pid) => {
    const group = grouped.get(pid);
    const title = formatTitle(options.titleTemplate, pid, names.get(pid) ?? '');
    if (!group) return `${title}\n暂无符合条件的数据`;
    const lines = metrics.map((metric) => `${realtimeMetricByKey.get(metric)?.label ?? metric}：${formatMetric(metric, calculateRealtimeMetric(metric, group.totals))}`);
    return [title, ...lines].join('\n');
  }).join('\n\n');
}
