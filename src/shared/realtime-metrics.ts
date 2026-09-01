import type { MetricKey, RealtimeMetricDefinition, RealtimeMetricKey } from './contracts';
import { METRICS } from './metrics';

const labelOverrides: Partial<Record<MetricKey, string>> = {
  activatedDevices: '激活数',
  loginDevices: '登录数',
};

export const REALTIME_METRICS: RealtimeMetricDefinition[] = [
  ...METRICS.map((metric) => ({ ...metric, label: labelOverrides[metric.key] ?? metric.label })),
  { key: 'activationLoginRate', label: '激活登录率', group: '比例', format: 'percent' },
  { key: 'loginPayRate', label: '登录付费率', group: '比例', format: 'percent' },
];

export const DEFAULT_REALTIME_METRICS: RealtimeMetricKey[] = [
  'spend',
  'activatedDevices',
  'activationCost',
  'loginDevices',
  'loginCost',
  'activationLoginRate',
  'payingDevices',
  'loginPayRate',
  'sameDayPayingCost',
  'firstDayRoi',
];

export const realtimeMetricByKey = new Map(REALTIME_METRICS.map((metric) => [metric.key, metric]));
