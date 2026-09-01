import { describe, expect, it } from 'vitest';
import { calculateMetric, emptyTotals, fieldAvailability, groupRows } from '../src/engine/aggregation';
import type { RawAdRow } from '../src/shared/contracts';

const row = (overrides: Partial<RawAdRow> = {}): RawAdRow => ({
  media: '头条', accountId: 'account', accountName: 'account', radid: 'tt_a_mroi7_x', operatingSystem: 'android', pid: '2170304', pidName: 'APK', spend: 100, impressions: 0, clicks: 0, installs: 0, activatedDevices: 10, sameDayPayingDevices: 2, sameDayPayment: 40, loginDevices: 8, registrationDevices: 10, payingDevices: 4, payment: 80, registrationCost: 0, loginCost: 0, roi: 0, firstDayRoi: 0, firstDayArppu: 0, arppu: 0, date: '2026-08-28', isReattribution: false, source: 'structured', ...overrides,
  packageName: 'APK', bidCode: 'mroi7', bidName: '7R', tapSegment: 'main',
});

describe('aggregation and metric engine', () => {
  it('sums numerators and denominators before calculating ratios', () => {
    const totals = emptyTotals();
    const grouped = groupRows([row(), row({ spend: 300, sameDayPayment: 60, payment: 120, loginDevices: 12 })], [(item) => ['pid', item.pid]]);
    Object.assign(totals, grouped[0].totals);
    expect(totals.spend).toBe(400);
    expect(calculateMetric('firstDayRoi', totals)).toBe(0.25);
    expect(calculateMetric('roi', totals)).toBe(0.5);
    expect(calculateMetric('firstDayLtv', totals)).toBe(5);
    expect(calculateMetric('ltv', totals)).toBe(10);
  });

  it('returns zero when an ordinary ratio denominator is zero', () => {
    const totals = emptyTotals();
    expect(calculateMetric('roi', totals)).toBeNull();
    expect(calculateMetric('ltv', totals)).toBe(0);
  });

  it('calculates newly exposed rates and ROI periods from summed fields', () => {
    const totals = emptyTotals();
    Object.assign(totals, groupRows([row({
      impressions: 1000, clicks: 100, activatedDevices: 10, registrationDevices: 5, loginDevices: 8, sameDayPayingDevices: 3,
      day2Payment: 20, day3Payment: 30, day7Payment: 40, day30Payment: 50,
      availableFields: { day2Roi: true, day3Roi: true, day7Roi: true, day30Roi: true },
    })], []).at(0)?.totals);
    expect(calculateMetric('clickRate', totals)).toBe(0.1);
    expect(calculateMetric('cpm', totals)).toBe(100);
    expect(calculateMetric('clickActivationRate', totals)).toBe(0.1);
    expect(calculateMetric('activationRegistrationRate', totals)).toBe(0.5);
    expect(calculateMetric('activationLoginRate', totals)).toBe(0.8);
    expect(calculateMetric('activationPayRate', totals)).toBe(0.3);
    expect(calculateMetric('day2Roi', totals)).toBe(0.2);
    expect(calculateMetric('day3Roi', totals)).toBe(0.3);
    expect(calculateMetric('day7Roi', totals)).toBe(0.4);
    expect(calculateMetric('day30Roi', totals)).toBe(0.5);
  });

  it('distinguishes complete, partial, missing, real zero and not-applicable fields', () => {
    const complete = groupRows([row({ spend: 0, availableFields: { spend: true } })], [() => ['group', 'complete']])[0].totals;
    const partial = groupRows([
      row({ spend: 100, availableFields: { spend: true } }),
      row({ spend: 0, availableFields: { spend: false } }),
    ], [() => ['group', 'partial']])[0].totals;
    const missing = groupRows([row({ spend: 0, availableFields: { spend: false } })], [() => ['group', 'missing']])[0].totals;
    const notApplicable = groupRows([row({ spend: 0, notApplicableFields: { spend: true } })], [() => ['group', 'not-applicable']])[0].totals;

    expect(fieldAvailability(complete, 'spend')).toBe('complete');
    expect(calculateMetric('spend', complete)).toBe(0);
    expect(fieldAvailability(partial, 'spend')).toBe('partial');
    expect(fieldAvailability(missing, 'spend')).toBe('missing');
    expect(fieldAvailability(notApplicable, 'spend')).toBe('not_applicable');
    expect(calculateMetric('spend', notApplicable)).toBeNull();
  });

  it('calculates derived metrics from the known partial totals', () => {
    const totals = groupRows([
      row({ spend: 100, activatedDevices: 10, payment: 50, availableFields: { spend: true, activatedDevices: true, payment: true } }),
      row({ spend: 0, activatedDevices: 0, payment: 0, availableFields: { spend: false, activatedDevices: true, payment: true } }),
    ], [() => ['group', 'partial-spend']])[0].totals;
    expect(calculateMetric('spend', totals)).toBe(100);
    expect(calculateMetric('activationCost', totals)).toBe(10);
    expect(calculateMetric('roi', totals)).toBe(0.5);
  });

  it('returns zero for ratios with an available zero denominator', () => {
    const totals = groupRows([
      row({ spend: 0, payment: 0, activatedDevices: 0, sameDayPayment: 0, availableFields: { spend: true, payment: true, activatedDevices: true, sameDayPayment: true } }),
    ], [() => ['group', 'real-zero']])[0].totals;
    expect(calculateMetric('roi', totals)).toBe(0);
    expect(calculateMetric('firstDayLtv', totals)).toBe(0);
  });
});
