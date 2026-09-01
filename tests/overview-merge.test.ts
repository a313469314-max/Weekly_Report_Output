import { describe, expect, it } from 'vitest';
import { amountBaselinesFromSummaryRows, DASHCARD_IDLE_WINDOW_MS, isOpsDashcardUrl, mergeOverviewRows, selectOverviewCards } from '../src/main/q1-connector';
import type { RawAdRow } from '../src/shared/contracts';

const row = (overrides: Partial<RawAdRow> = {}): RawAdRow => ({
  media: '头条', accountId: 'account', accountName: 'account', radid: 'tt_user_jh_agent', operatingSystem: '安卓',
  pid: '2170304', pidName: '王国大作战-APK-头条-安卓', packageName: 'APK', bidCode: 'jh', bidName: '激活', tapSegment: 'main',
  spend: 50, impressions: 100, clicks: 10, installs: 1, activatedDevices: 5, sameDayPayingDevices: 0,
  sameDayPayment: 0, loginDevices: 1, registrationDevices: 2, payingDevices: 0, payment: 0,
  registrationCost: 0, loginCost: 0, roi: 0, firstDayRoi: 0, firstDayArppu: 0, arppu: 0,
  date: '2026-08-29', isReattribution: false, source: 'structured', frontEndMetricsAvailable: true, ...overrides,
});

const baseCard = () => ({
  rows: [], columns: [], score: 20, matched: 1, targetPidCount: 1, unexpectedPidCount: 0,
  hasPid: true, hasDetail: true, hasRadid: true, hasSpend: true, hasActivatedDevices: true, hasRevenue: true,
  isCurrentQuery: true,
});

const card = (overrides: Partial<ReturnType<typeof baseCard>> = {}) => ({ ...baseCard(), ...overrides });

describe('overview detail and PID summary merge', () => {
  it('accepts only Q1 dashcard URLs for a query batch', () => {
    expect(isOpsDashcardUrl('https://ops.q1.com/api/dashcard/123')).toBe(true);
    expect(isOpsDashcardUrl('https://ops.q1.com/dataCenter/ads/overview')).toBe(false);
    expect(isOpsDashcardUrl('https://other.example.com/api/dashcard/123')).toBe(false);
  });

  it('keeps observing dashcard requests beyond the former 500ms cutoff', () => {
    expect(DASHCARD_IDLE_WINDOW_MS).toBeGreaterThan(500);
  });

  it('never selects a complete card that does not contain a target PID', () => {
    const withoutTarget = card({ score: 99, targetPidCount: 0, matched: 0 });
    const targetDetail = card({ score: 1, targetPidCount: 1 });
    expect(selectOverviewCards([withoutTarget, targetDetail]).primary).toBe(targetDetail);
  });

  it('prefers a card from the current query batch over a higher scored historic card', () => {
    const historic = card({ score: 99, isCurrentQuery: false });
    const current = card({ score: 1, isCurrentQuery: true });
    expect(selectOverviewCards([historic, current]).primary).toBe(current);
  });

  it('accepts a matching card without a query-time baseline', () => {
    const matching = card({ isCurrentQuery: undefined });
    expect(selectOverviewCards([matching]).primary).toBe(matching);
  });

  it('prefers an exact PID card over a higher scored card with extra PIDs', () => {
    const mixed = card({ score: 99, unexpectedPidCount: 3 });
    const exact = card({ score: 1, unexpectedPidCount: 0 });
    expect(selectOverviewCards([mixed, exact]).primary).toBe(exact);
  });

  it('does not treat a PID summary card as the required RADID detail card', () => {
    const pidSummary = card({ hasRadid: false, hasSpend: false });
    const selected = selectOverviewCards([pidSummary], { requireRadid: true });
    expect(selected.primary).toBeUndefined();
    expect(selected.summary).toBe(pidSummary);
  });

  it('keeps RADID rows separate when one PID summary spans multiple media, systems and bids', () => {
    const details = [
      row({ media: '头条', operatingSystem: '安卓', bidCode: 'jh', bidName: '激活' }),
      row({ media: '广点通', operatingSystem: 'IOS', bidCode: 'mroi7', bidName: '7R', radid: 'qq_user_mroi7_agent' }),
    ];
    const result = mergeOverviewRows(details, [row({ radid: '', spend: 100, payment: 20, activatedDevices: 10 })]);
    expect(result.rows).toEqual(details);
    expect(result.rows.map((item) => [item.media, item.operatingSystem, item.bidCode])).toEqual([
      ['头条', '安卓', 'jh'],
      ['广点通', 'IOS', 'mroi7'],
    ]);
    expect(result.issues.map((issue) => issue.code)).toEqual(['backend_granularity_unavailable']);
  });

  it('does not remove RADID detail rows merely because a PID summary exists', () => {
    const details = [row(), row({ radid: 'tt_user_mroi7_agent', bidCode: 'mroi7', bidName: '7R' })];
    const result = mergeOverviewRows(details, [row({ radid: '', spend: 100 })]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((item) => item.radid.length > 0)).toBe(true);
  });

  it('builds independent range amount baselines and preserves real zero values', () => {
    const baselines = amountBaselinesFromSummaryRows([
      row({ radid: '', spend: 0, sameDayPayment: 0, payment: 0, availableFields: { spend: true, sameDayPayment: true, payment: true } }),
      row({ radid: '', spend: 10, sameDayPayment: 2, payment: 3, availableFields: { spend: true, sameDayPayment: true, payment: true } }),
    ]);
    expect(baselines).toEqual([
      { metric: 'spend', label: '消耗', expected: 10, available: true },
      { metric: 'sameDayPayment', label: '当日付费金额', expected: 2, available: true },
      { metric: 'payment', label: '付费金额', expected: 3, available: true },
    ]);
  });

  it('never treats another RADID detail card as the PID summary card', () => {
    const primary = card({ score: 30 });
    const anotherRadidCard = card({ score: 29 });
    expect(selectOverviewCards([primary, anotherRadidCard]).summary).toBeUndefined();
  });
});
