import { describe, expect, it } from 'vitest';
import { buildRealtimeText } from '../src/engine/realtime';
import type { RawAdRow } from '../src/shared/contracts';

const row = (overrides: Partial<RawAdRow> = {}): RawAdRow => ({
  media: '头条', accountId: 'account', accountName: 'account', radid: 'tt_user_mroi7_agent',
  operatingSystem: '安卓', pid: '2170304', pidName: '代号弹球王国-A包', packageName: 'APK',
  bidCode: 'mroi7', bidName: '7R', tapSegment: 'main', spend: 100, impressions: 0, clicks: 0,
  installs: 0, activatedDevices: 10, sameDayPayingDevices: 1, sameDayPayment: 10, loginDevices: 8,
  registrationDevices: 0, payingDevices: 2, payment: 20, registrationCost: 0, loginCost: 0,
  roi: 0, firstDayRoi: 0, firstDayArppu: 0, arppu: 0, date: '2026-08-29',
  isReattribution: false, source: 'structured', frontEndMetricsAvailable: true, ...overrides,
});

describe('realtime broadcast text', () => {
  it('sums PID rows before calculating costs and rates', () => {
    const text = buildRealtimeText([
      row(),
      row({ spend: 300, activatedDevices: 30, sameDayPayingDevices: 2, sameDayPayment: 30, loginDevices: 24, payingDevices: 4, payment: 60 }),
    ], {
      pids: ['2170304'],
      pidNames: { '2170304': '代号弹球王国-A包' },
      titleTemplate: '【{pidName}】',
      metricOrder: ['spend', 'activatedDevices', 'activationCost', 'loginDevices', 'loginCost', 'activationLoginRate', 'payingDevices', 'loginPayRate', 'sameDayPayingCost', 'firstDayRoi'],
    });
    expect(text).toBe([
      '【代号弹球王国-A包】',
      '消耗：400',
      '激活数：40',
      '激活成本：10',
      '登录数：32',
      '登录成本：12.5',
      '激活登录率：80.00%',
      '付费设备数：6',
      '登录付费率：18.75%',
      '当日付费成本：133.33',
      '首日ROI：10.00%',
    ].join('\n'));
  });

  it('shows zero for ordinary cost denominators and uses PID fallback in the title', () => {
    const text = buildRealtimeText([row({ pid: '2170305', pidName: '', spend: 0, activatedDevices: 0, loginDevices: 0, payingDevices: 0 })], {
      pids: ['2170305'], pidNames: {}, titleTemplate: '【{pidName}-{pid}】', metricOrder: ['activationCost', 'activationLoginRate', 'loginPayRate'],
    });
    expect(text).toBe('【2170305-2170305】\n激活成本：0\n激活登录率：0.00%\n登录付费率：0.00%');
  });

  it('does not count mixed PID frontend metrics twice', () => {
    const text = buildRealtimeText([
      row({ isMixedPid: true, operatingSystem: '安卓', spend: 100, activatedDevices: 10 }),
      row({ isMixedPid: true, operatingSystem: 'IOS', spend: 100, activatedDevices: 5 }),
    ], {
      pids: ['2170304'], pidNames: { '2170304': '代号弹球王国-A包' }, titleTemplate: '【{pidName}】', metricOrder: ['spend', 'activatedDevices', 'activationCost'],
    });
    expect(text).toBe('【代号弹球王国-A包】\n消耗：100\n激活数：15\n激活成本：6.67');
  });

  it('does not count a cross-system display summary on top of its source systems', () => {
    const text = buildRealtimeText([
      row({ packageName: '微小', operatingSystem: '安卓', spend: 100, activatedDevices: 10 }),
      row({ packageName: '微小', operatingSystem: 'IOS', spend: 20, activatedDevices: 5 }),
      row({ packageName: '微小', operatingSystem: '鸿蒙', spend: 30, activatedDevices: 2 }),
    ], {
      pids: ['2170304'], pidNames: { '2170304': '代号弹球王国-微小' }, titleTemplate: '【{pidName}】', metricOrder: ['spend', 'activatedDevices', 'activationCost'],
    });
    expect(text).toBe('【代号弹球王国-微小】\n消耗：150\n激活数：17\n激活成本：8.82');
  });
});
