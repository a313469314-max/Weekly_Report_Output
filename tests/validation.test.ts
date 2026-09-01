import { describe, expect, it } from 'vitest';
import { exceedsThreshold, validateAmountBaselines, validateBackendRatios } from '../src/engine/validation';
import { createDefaultProjectConfig } from '../src/shared/defaults';
import type { RawAdRow } from '../src/shared/contracts';

const row = (overrides: Partial<RawAdRow> = {}): RawAdRow => ({
  media: '头条', accountId: 'account', accountName: 'account', radid: 'tt_a_jh_x', operatingSystem: '安卓',
  pid: '2170304', pidName: '测试渠道', packageName: 'APK', bidCode: 'jh', bidName: '激活', tapSegment: 'main',
  spend: 100, impressions: 0, clicks: 0, installs: 0, activatedDevices: 10, sameDayPayingDevices: 1,
  sameDayPayment: 0, loginDevices: 1, registrationDevices: 1, payingDevices: 1, payment: 0,
  registrationCost: 0, loginCost: 0, roi: 0, firstDayRoi: 0, firstDayArppu: 0, arppu: 0,
  date: '2026-08-29', isReattribution: false, source: 'structured', ...overrides,
});

describe('report validation thresholds', () => {
  it('uses amount thresholds with strict greater-than semantics', () => {
    const config = createDefaultProjectConfig();
    expect(exceedsThreshold({ code: 'x', message: 'x', actual: 100.1, expected: 100, kind: 'amount' }, config)).toBe(false);
    expect(exceedsThreshold({ code: 'x', message: 'x', actual: 100.1001, expected: 100, kind: 'amount' }, config)).toBe(true);
    expect(exceedsThreshold({ code: 'x', message: 'x', actual: -10.1, expected: -10, kind: 'amount' }, config)).toBe(false);
    expect(exceedsThreshold({ code: 'x', message: 'x', actual: -10.2, expected: -10, kind: 'amount' }, config)).toBe(true);
  });

  it('compares ratios in percentage points and skips missing values', () => {
    const config = createDefaultProjectConfig();
    expect(exceedsThreshold({ code: 'x', message: 'x', actual: 0.011, expected: 0.01, kind: 'ratio' }, config)).toBe(false);
    expect(exceedsThreshold({ code: 'x', message: 'x', actual: 0.01101, expected: 0.01, kind: 'ratio' }, config)).toBe(true);
    expect(exceedsThreshold({ code: 'x', message: 'x', actual: 0, expected: 1, kind: 'ratio', actualAvailable: false }, config)).toBe(false);
  });

  it('checks a real zero ROI instead of treating it as missing', () => {
    const config = createDefaultProjectConfig();
    const issues = validateBackendRatios([row({ payment: 10, roi: 0, availableFields: { spend: true, payment: true, roi: true, sameDayPayment: true, firstDayRoi: true } })], config);
    expect(issues.some((issue) => issue.code === 'roi_mismatch')).toBe(true);
  });

  it('compares independent amount baselines and skips unavailable baselines', () => {
    const config = createDefaultProjectConfig();
    expect(validateAmountBaselines([row({ spend: 100 })], [{ metric: 'spend', expected: 100.1 }], config)).toEqual([]);
    expect(validateAmountBaselines([row({ spend: 100.1001 })], [{ metric: 'spend', expected: 100 }], config).map((issue) => issue.code)).toEqual(['amount_spend_mismatch']);
    expect(validateAmountBaselines([row({ spend: 999 })], [{ metric: 'spend', expected: 100, available: false }], config)).toEqual([]);
  });

  it('does not treat a missing generated amount as a real zero', () => {
    const config = createDefaultProjectConfig();
    const issues = validateAmountBaselines([
      row({ spend: 0, availableFields: { spend: false } }),
    ], [{ metric: 'spend', expected: 100 }], config);
    expect(issues).toEqual([]);
  });

});
