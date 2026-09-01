import type { AggregateTotals, FieldAvailability, MetricKey, RawAdRow } from '../shared/contracts';

export interface GroupedRow {
  key: string;
  dimensions: Record<string, string>;
  totals: AggregateTotals;
  sourceRows: number;
}

const rawMetricKeys: MetricKey[] = [
  'spend', 'impressions', 'clicks', 'installs', 'activatedDevices', 'sameDayPayingDevices', 'sameDayPayment',
  'loginDevices', 'registrationDevices', 'payingDevices', 'payment', 'roi', 'firstDayRoi', 'firstDayArppu', 'arppu',
  'day2Roi', 'day3Roi', 'day7Roi', 'day30Roi',
];

const frontendMetricKeys = new Set<MetricKey>(['spend', 'impressions', 'clicks', 'installs']);

function rawFieldAvailability(row: RawAdRow, key: MetricKey): FieldAvailability {
  if (row.notApplicableFields?.[key]) return 'not_applicable';
  if (row.isMixedSystemBreakdown && frontendMetricKeys.has(key)) return 'not_applicable';
  if (row.partialFields?.[key]) return 'partial';
  return row.availableFields?.[key] === false ? 'missing' : 'complete';
}

function refreshFieldAvailability(totals: AggregateTotals): void {
  const states = totals.fieldAvailability ?? {};
  const availability = totals.availableFields ?? {};
  for (const [key, counts] of Object.entries(totals.fieldAvailabilityCounts ?? {})) {
    const typedKey = key as MetricKey;
    let state: FieldAvailability;
    if (counts.available === 0 && counts.missing === 0 && counts.notApplicable > 0) state = 'not_applicable';
    else if (counts.partial > 0 || (counts.missing > 0 && counts.available > 0)) state = 'partial';
    else if (counts.missing === 0) state = 'complete';
    else state = 'missing';
    states[typedKey] = state;
    availability[typedKey] = state === 'complete' || state === 'partial';
  }
  totals.fieldAvailability = states;
  totals.availableFields = availability;
}

export function fieldAvailability(totals: AggregateTotals, key: MetricKey): FieldAvailability {
  return totals.fieldAvailability?.[key] ?? (totals.availableFields?.[key] === false ? 'missing' : 'complete');
}

export function emptyTotals(): AggregateTotals {
  return {
    spend: 0,
    impressions: 0,
    clicks: 0,
    installs: 0,
    activatedDevices: 0,
    sameDayPayingDevices: 0,
    sameDayPayment: 0,
    loginDevices: 0,
    registrationDevices: 0,
    payingDevices: 0,
    payment: 0,
    day2Payment: 0,
    day3Payment: 0,
    day7Payment: 0,
    day30Payment: 0,
    availableFields: {},
    fieldAvailability: {},
    fieldAvailabilityCounts: {},
    frontEndMetricsAvailable: false,
  };
}

export function addRow(totals: AggregateTotals, row: RawAdRow): void {
  totals.spend += row.spend;
  totals.impressions += row.impressions;
  totals.clicks += row.clicks;
  totals.installs += row.installs;
  totals.activatedDevices += row.activatedDevices;
  totals.sameDayPayingDevices += row.sameDayPayingDevices;
  totals.sameDayPayment += row.sameDayPayment;
  totals.loginDevices += row.loginDevices;
  totals.registrationDevices += row.registrationDevices;
  totals.payingDevices += row.payingDevices;
  totals.payment += row.payment;
  totals.day2Payment = (totals.day2Payment ?? 0) + (row.day2Payment ?? 0);
  totals.day3Payment = (totals.day3Payment ?? 0) + (row.day3Payment ?? 0);
  totals.day7Payment = (totals.day7Payment ?? 0) + (row.day7Payment ?? 0);
  totals.day30Payment = (totals.day30Payment ?? 0) + (row.day30Payment ?? 0);
  for (const key of rawMetricKeys) {
    const availability = rawFieldAvailability(row, key);
    const counts = totals.fieldAvailabilityCounts![key] ?? { available: 0, partial: 0, missing: 0, notApplicable: 0 };
    if (availability === 'complete') counts.available += 1;
    else if (availability === 'partial') counts.partial += 1;
    else if (availability === 'missing') counts.missing += 1;
    else counts.notApplicable += 1;
    totals.fieldAvailabilityCounts![key] = counts;
  }
  refreshFieldAvailability(totals);
  totals.frontEndMetricsAvailable ||= row.frontEndMetricsAvailable !== false;
}

export function groupRows(rows: RawAdRow[], dimensions: Array<(row: RawAdRow) => [string, string]>): GroupedRow[] {
  const groups = new Map<string, GroupedRow>();
  for (const row of rows) {
    const values = dimensions.map((get) => get(row));
    const key = values.map(([, value]) => value).join('\u001f');
    let group = groups.get(key);
    if (!group) {
      group = { key, dimensions: Object.fromEntries(values), totals: emptyTotals(), sourceRows: 0 };
      groups.set(key, group);
    }
    addRow(group.totals, row);
    group.sourceRows += 1;
  }
  return [...groups.values()];
}

export function calculateMetric(metric: MetricKey, totals: AggregateTotals): number | null {
  const available = (key: MetricKey) => {
    const state = fieldAvailability(totals, key);
    return state === 'complete' || state === 'partial';
  };
  const safeRatio = (numerator: number, denominator: number, isAvailable = true) => {
    if (!isAvailable) return null;
    return denominator === 0 ? 0 : numerator / denominator;
  };
  const frontEndValue = (key: MetricKey) => totals.frontEndMetricsAvailable && available(key);
  const frontEndRatio = (numerator: number, denominator: number, numeratorKey: MetricKey, denominatorKey: MetricKey) => (
    safeRatio(numerator, denominator, totals.frontEndMetricsAvailable && available(numeratorKey) && available(denominatorKey))
  );
  switch (metric) {
    case 'spend': return frontEndValue('spend') ? totals.spend : null;
    case 'activatedDevices': return available('activatedDevices') ? totals.activatedDevices : null;
    case 'activationCost': return frontEndRatio(totals.spend, totals.activatedDevices, 'spend', 'activatedDevices');
    case 'sameDayPayingDevices': return available('sameDayPayingDevices') ? totals.sameDayPayingDevices : null;
    case 'sameDayPayingCost': return frontEndRatio(totals.spend, totals.sameDayPayingDevices, 'spend', 'sameDayPayingDevices');
    case 'sameDayPayment': return available('sameDayPayment') ? totals.sameDayPayment : null;
    case 'payingDevices': return available('payingDevices') ? totals.payingDevices : null;
    case 'payingCost': return frontEndRatio(totals.spend, totals.payingDevices, 'spend', 'payingDevices');
    case 'payment': return available('payment') ? totals.payment : null;
    case 'firstDayRoi': return frontEndRatio(totals.sameDayPayment, totals.spend, 'sameDayPayment', 'spend');
    case 'roi': return frontEndRatio(totals.payment, totals.spend, 'payment', 'spend');
    case 'loginDevices': return available('loginDevices') ? totals.loginDevices : null;
    case 'firstDayLtv': return safeRatio(totals.sameDayPayment, totals.activatedDevices, available('sameDayPayment') && available('activatedDevices'));
    case 'ltv': return safeRatio(totals.payment, totals.activatedDevices, available('payment') && available('activatedDevices'));
    case 'impressions': return frontEndValue('impressions') ? totals.impressions : null;
    case 'clicks': return frontEndValue('clicks') ? totals.clicks : null;
    case 'installs': return frontEndValue('installs') ? totals.installs : null;
    case 'registrationDevices': return available('registrationDevices') ? totals.registrationDevices : null;
    case 'loginCost': return frontEndRatio(totals.spend, totals.loginDevices, 'spend', 'loginDevices');
    case 'registrationCost': return frontEndRatio(totals.spend, totals.registrationDevices, 'spend', 'registrationDevices');
    case 'firstDayArppu': return safeRatio(totals.sameDayPayment, totals.sameDayPayingDevices, available('sameDayPayment') && available('sameDayPayingDevices'));
    case 'arppu': return safeRatio(totals.payment, totals.payingDevices, available('payment') && available('payingDevices'));
    case 'clickRate': return frontEndRatio(totals.clicks, totals.impressions, 'clicks', 'impressions');
    case 'cpm': return frontEndRatio(totals.spend * 1000, totals.impressions, 'spend', 'impressions');
    case 'clickActivationRate': return frontEndRatio(totals.activatedDevices, totals.clicks, 'activatedDevices', 'clicks');
    case 'activationRegistrationRate': return safeRatio(totals.registrationDevices, totals.activatedDevices, available('registrationDevices') && available('activatedDevices'));
    case 'activationLoginRate': return safeRatio(totals.loginDevices, totals.activatedDevices, available('loginDevices') && available('activatedDevices'));
    case 'activationPayRate': return safeRatio(totals.sameDayPayingDevices, totals.activatedDevices, available('sameDayPayingDevices') && available('activatedDevices'));
    case 'day2Roi': return frontEndRatio(totals.day2Payment ?? 0, totals.spend, 'day2Roi', 'spend');
    case 'day3Roi': return frontEndRatio(totals.day3Payment ?? 0, totals.spend, 'day3Roi', 'spend');
    case 'day7Roi': return frontEndRatio(totals.day7Payment ?? 0, totals.spend, 'day7Roi', 'spend');
    case 'day30Roi': return frontEndRatio(totals.day30Payment ?? 0, totals.spend, 'day30Roi', 'spend');
  }
  return null;
}
