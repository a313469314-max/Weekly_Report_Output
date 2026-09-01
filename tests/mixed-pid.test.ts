import { describe, expect, it } from 'vitest';
import { calculateMetric, emptyTotals, addRow } from '../src/engine/aggregation';
import { materializeMixedPidRows } from '../src/engine/mixed-pid';
import type { RawAdRow } from '../src/shared/contracts';

const sourceRow = (operatingSystem: string, overrides: Partial<RawAdRow> = {}): RawAdRow => ({
  media: '广点通', accountId: 'account', accountName: 'account', radid: 'qq_user_mroi7_agent',
  operatingSystem, pid: '2170405', pidName: '王国大作战-微小-广点通', packageName: '微小',
  bidCode: 'mroi7', bidName: '7R', tapSegment: 'main', spend: 100, impressions: 1000, clicks: 100,
  installs: 10, activatedDevices: 0, sameDayPayingDevices: 0, sameDayPayment: 0, loginDevices: 0,
  registrationDevices: 0, payingDevices: 0, payment: 0, registrationCost: 0, loginCost: 0,
  roi: 0, firstDayRoi: 0, firstDayArppu: 0, arppu: 0, date: '2026-08-28',
  isReattribution: false, source: 'structured', isMixedPid: true, frontEndMetricsAvailable: true, ...overrides,
});

describe('mixed PID report rows', () => {
  it('keeps frontend totals once and writes backend-only system breakdowns', () => {
    const result = materializeMixedPidRows([
      sourceRow('安卓', { activatedDevices: 10, loginDevices: 8, sameDayPayingDevices: 2, sameDayPayment: 30, payingDevices: 4, payment: 60 }),
      sourceRow('IOS', { activatedDevices: 5, loginDevices: 4, sameDayPayingDevices: 1, sameDayPayment: 20, payingDevices: 2, payment: 40 }),
    ]);
    expect(result.issues).toEqual([]);
    expect(result.rows.map((row) => row.operatingSystem)).toEqual(['多端合计', '安卓（混投拆分）', 'IOS（混投拆分）']);
    const total = result.rows[0];
    expect(total.spend).toBe(100);
    expect(total.activatedDevices).toBe(15);
    expect(total.payment).toBe(100);
    const android = result.rows[1];
    expect(android.spend).toBe(0);
    expect(android.payment).toBe(60);
    const totals = emptyTotals();
    addRow(totals, android);
    expect(calculateMetric('activationCost', totals)).toBeNull();
    expect(calculateMetric('roi', totals)).toBeNull();
    expect(calculateMetric('ltv', totals)).toBe(6);
  });

  it('does not infer mixed delivery from multiple backend systems for non-micro channels', () => {
    const result = materializeMixedPidRows([
      sourceRow('安卓', { isMixedPid: false, packageName: 'APK', spend: 100, activatedDevices: 8, payment: 20 }),
      sourceRow('IOS', { isMixedPid: false, packageName: 'APK', spend: 0, availableFields: { spend: false }, activatedDevices: 5, payment: 30 }),
    ]);
    expect(result.rows.map((row) => row.operatingSystem)).toEqual(['安卓', 'IOS']);
    expect(result.rows.map((row) => row.spend)).toEqual([100, 0]);
  });

  it('keeps name-based system rows and adds a multi-end total for all known systems', () => {
    const result = materializeMixedPidRows([
      sourceRow('安卓', { isMixedPid: false, packageName: '微小', spend: 100, activatedDevices: 8, payment: 20 }),
      sourceRow('IOS', { isMixedPid: false, packageName: '微小', spend: 20, activatedDevices: 5, payment: 30 }),
      sourceRow('鸿蒙', { isMixedPid: false, packageName: '微小', spend: 30, activatedDevices: 2, payment: 7 }),
    ]);
    expect(result.rows.map((row) => row.operatingSystem)).toEqual(['安卓', 'IOS', '鸿蒙', '多端合计']);
    expect(result.rows[0].spend).toBe(100);
    expect(result.rows[1].spend).toBe(20);
    expect(result.rows[3].spend).toBe(150);
    expect(result.rows[3].impressions).toBe(3000);
    expect(result.rows[3].clicks).toBe(300);
    expect(result.rows[3].installs).toBe(30);
    expect(result.rows[3].activatedDevices).toBe(15);
    expect(result.rows[3].payment).toBe(57);
    expect(result.rows[3].isCrossSystemSummary).toBe(true);
    expect(result.rows[3].isMixedPid).toBe(false);
  });

  it('uses the Android row for mixed frontend metrics even when a PID summary also exists', () => {
    const result = materializeMixedPidRows([
      sourceRow('安卓', { isMixedPid: true, spend: 120, impressions: 1200, clicks: 12 }),
      sourceRow('IOS', { isMixedPid: false, spend: 0, impressions: 0, clicks: 0, availableFields: { spend: false, impressions: false, clicks: false, installs: false } }),
    ], [sourceRow('多端合计', { radid: '', spend: 120, impressions: 1200, clicks: 12, installs: 10 })]);
    const total = result.rows.find((row) => row.operatingSystem === '多端合计');
    expect(total?.spend).toBe(120);
    expect(total?.impressions).toBe(1200);
    expect(result.issues.some((issue) => issue.code === 'mixed_pid_frontend_pid_summary_only')).toBe(false);
  });

  it('does not place one PID-level frontend total onto every RADID of a mixed PID', () => {
    const rows = [
      sourceRow('安卓', { radid: 'qq_user_mroi7_agent_a', activatedDevices: 10, availableFields: { spend: false, impressions: false, clicks: false, installs: false } }),
      sourceRow('IOS', { radid: 'qq_user_mroi7_agent_a', activatedDevices: 5, availableFields: { spend: false, impressions: false, clicks: false, installs: false } }),
      sourceRow('安卓', { radid: 'qq_user_jh_agent_b', activatedDevices: 8, availableFields: { spend: false, impressions: false, clicks: false, installs: false } }),
      sourceRow('IOS', { radid: 'qq_user_jh_agent_b', activatedDevices: 4, availableFields: { spend: false, impressions: false, clicks: false, installs: false } }),
    ];
    const pidSummaryRows = [sourceRow('多端合计', { radid: '', spend: 180, impressions: 1800, clicks: 180, installs: 18 })];
    const result = materializeMixedPidRows(rows, pidSummaryRows);
    const mixedTotals = result.rows.filter((item) => item.operatingSystem === '多端合计');
    expect(mixedTotals).toHaveLength(2);
    expect(mixedTotals.every((item) => item.availableFields?.spend === false)).toBe(true);
    expect(mixedTotals.reduce((total, item) => total + item.spend, 0)).toBe(0);
    expect(result.issues.filter((issue) => issue.code === 'mixed_pid_frontend_pid_summary_only')).toHaveLength(1);
  });

  it('sums independent RADID-level frontend values even when their values are identical', () => {
    const result = materializeMixedPidRows([
      sourceRow('安卓', { radid: 'qq_user_mroi7_agent_a', spend: 100 }),
      sourceRow('IOS', { radid: 'qq_user_mroi7_agent_a', spend: 100 }),
      sourceRow('安卓', { radid: 'qq_user_jh_agent_b', spend: 100 }),
      sourceRow('IOS', { radid: 'qq_user_jh_agent_b', spend: 100 }),
    ]);
    const mixedTotals = result.rows.filter((item) => item.operatingSystem === '多端合计');
    expect(mixedTotals).toHaveLength(2);
    expect(mixedTotals.reduce((total, item) => total + item.spend, 0)).toBe(200);
  });

  it('keeps distinct independent RADID frontend values without treating them as ambiguous', () => {
    const result = materializeMixedPidRows([
      sourceRow('安卓', { radid: 'qq_user_mroi7_agent_a', spend: 100 }),
      sourceRow('IOS', { radid: 'qq_user_mroi7_agent_a', spend: 100 }),
      sourceRow('安卓', { radid: 'qq_user_jh_agent_b', spend: 260 }),
      sourceRow('IOS', { radid: 'qq_user_jh_agent_b', spend: 260 }),
    ]);
    expect(result.rows.filter((item) => item.operatingSystem === '多端合计').reduce((total, item) => total + item.spend, 0)).toBe(360);
    expect(result.issues.some((issue) => issue.code === 'mixed_pid_frontend_ambiguous')).toBe(false);
  });

  it('warns instead of inventing a frontend total when no frontend source is available', () => {
    const unavailableFrontend = { spend: false, impressions: false, clicks: false, installs: false };
    const result = materializeMixedPidRows([
      sourceRow('安卓', { availableFields: unavailableFrontend, spend: 0 }),
      sourceRow('IOS', { availableFields: unavailableFrontend, spend: 0 }),
    ]);
    const total = result.rows.find((item) => item.operatingSystem === '多端合计');
    expect(total?.availableFields?.spend).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('mixed_pid_frontend_missing');
  });
});
