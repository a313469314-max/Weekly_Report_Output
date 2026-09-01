import { describe, expect, it } from 'vitest';
import { normalizeStructuredRows } from '../src/engine/normalize';
import { createDefaultProjectConfig } from '../src/shared/defaults';

const columns = [
  '媒体', 'radid', '操作系统', '渠道id', '渠道名', '消耗', '激活设备数', '当日付费设备数', '当日付费金额',
  '登录设备数', '付费设备数', '付费金额', 'ROI', '首日ROI', '重归因',
].map((display_name) => ({ display_name }));

describe('structured row normalization', () => {
  it('normalizes object rows returned by the structured backend', () => {
    const config = createDefaultProjectConfig();
    config.pidWhitelist = ['2170304'];
    const result = normalizeStructuredRows([
      { 媒体: '头条', RADID: 'tt_ll_mroi7_agent_custom', 操作系统: 'android', 渠道ID: '2170304', 渠道名称: '王国大作战-APK-头条-安卓', 消耗: '100', 激活设备数: '10', 登录设备数: '8', 付费金额: '80' },
    ], columns, config, '2026-08-28');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].pid).toBe('2170304');
    expect(result.rows[0].media).toBe('头条');
    expect(result.rows[0].spend).toBe(100);
  });

  it('excludes unexpected backend PID rows without excluding requested PID rows', () => {
    const config = createDefaultProjectConfig();
    config.pidWhitelist = ['2170304'];
    const result = normalizeStructuredRows([
      { 媒体: '头条', RADID: 'tt_ll_jh_agent', 操作系统: 'android', 渠道ID: '2170304', 渠道名称: '王国大作战-APK-头条-安卓', 消耗: 100, 激活设备数: 10, 付费金额: 20 },
      { 媒体: '头条', RADID: 'tt_ll_jh_agent', 操作系统: 'android', 渠道ID: '2170999', 渠道名称: '其他项目-APK-头条-安卓', 消耗: 999, 激活设备数: 99, 付费金额: 999 },
    ], columns, config, '2026-08-28');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].pid).toBe('2170304');
  });

  it('matches media values after backend-added whitespace normalization', () => {
    const config = createDefaultProjectConfig();
    config.pidWhitelist = ['2170304'];
    config.pidPackageMap = { '2170304': 'APK' };
    const result = normalizeStructuredRows([
      ['Tap Tap', 'tap_ll_jh_x', 'android', '2170304', '王国大作战-APK-TAP-安卓', '10', '1', '0', '0', '1', '0', '0', '0', '0', '否'],
    ], columns, config, '2026-08-28');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].media).toBe('TapTap');
  });

  it('uses backend spend, keeps PID-level rows, maps bid code and parses percentages', () => {
    const config = createDefaultProjectConfig();
    config.pidWhitelist = ['2170304'];
    config.pidPackageMap = { '2170304': 'IOS' };
    const result = normalizeStructuredRows([
      ['头条', 'tt_ll_mroi7_agent_custom_part', 'android', '2170304', '王国大作战-APK-头条-安卓', '100', '10', '2', '40', '8', '4', '80', '80.00%', '40.00%', '否'],
    ], columns, config, '2026-08-28');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].spend).toBe(100);
    expect(result.rows[0].packageName).toBe('APK');
    expect(result.rows[0].operatingSystem).toBe('安卓');
    expect(result.rows[0].bidCode).toBe('mroi7');
    expect(result.rows[0].bidName).toBe('7R');
    expect(result.rows[0].roi).toBe(0.8);
    expect(result.rows[0].firstDayRoi).toBe(0.4);
  });

  it('uses cached PID names when the daily account export has no channel name column', () => {
    const config = createDefaultProjectConfig();
    config.pidWhitelist = ['2170405'];
    config.pidNames = { '2170405': '王国大作战-微小-广点通-安卓' };
    const accountDailyColumns = [
      '日期', '媒体', 'radid', '广告账号id', '广告账号', '操作系统', '渠道id', '消耗', '激活设备数', '登录设备数', '付费设备数', '付费金额',
    ].map((display_name) => ({ display_name }));
    const result = normalizeStructuredRows([
      { 日期: '2026-8-18', 媒体: '广点通', radid: 'qq_jq_ztzcroi_agent', 广告账号id: '123', 广告账号: '测试账号', 操作系统: 'android', 渠道id: '2170405', 消耗: 10, 激活设备数: 1, 登录设备数: 1, 付费设备数: 1, 付费金额: 2 },
    ], accountDailyColumns, config, '2026-08-18');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].pidName).toBe('王国大作战-微小-广点通-安卓');
    expect(result.rows[0].packageName).toBe('微小');
    expect(result.rows[0].date).toBe('2026-8-18');
  });

  it('uses the backend operating system for an unmarked micro PID without inferring mixed delivery', () => {
    const config = createDefaultProjectConfig();
    config.pidWhitelist = ['2170405'];
    config.pidNames = { '2170405': '王国大作战-微小-广点通' };
    const result = normalizeStructuredRows([
      { 媒体: '广点通', RADID: 'qq_ll_mroi7_agent', 操作系统: 'ios', 渠道ID: '2170405', 消耗: 100, 激活设备数: 8, 登录设备数: 7, 付费设备数: 2, 付费金额: 20 },
    ], columns, config, '2026-08-28');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].packageName).toBe('微小');
    expect(result.rows[0].operatingSystem).toBe('IOS');
    expect(result.rows[0].isMixedPid).toBe(false);
  });

  it('skips unknown package rows, keeps unknown bid codes and separates TAP ADN', () => {
    const config = createDefaultProjectConfig();
    config.pidWhitelist = ['2170304', '2170319', '2170320'];
    config.pidPackageMap = { '2170304': 'APK', '2170319': 'APK' };
    const result = normalizeStructuredRows([
      ['bilibili', 'bli_ll_newcode_x', 'android', '2170304', '普通渠道', '10', '0', '0', '0', '1', '0', '0', '0', '0', '否'],
      ['tap', 'tap_ll_mcff_x', 'android', '2170319', '王国大作战-APK-TAP-ADN联盟-安卓', '10', '0', '0', '0', '1', '0', '0', '0', '0', '否'],
      ['tap', 'tap_ll_mcff_x', 'android', '2170320', '未配置包体', '10', '0', '0', '0', '1', '0', '0', '0', '0', '否'],
    ], columns, config, '2026-08-28');
    expect(result.rows.map((row) => row.tapSegment)).toEqual(['main', 'adn']);
    expect(result.issues.some((issue) => issue.code === 'unknown_bid_code')).toBe(true);
    expect(result.issues.some((issue) => issue.code === 'unknown_package')).toBe(true);
  });

  it('keeps valid PID rows for realtime text even without report classifications', () => {
    const config = createDefaultProjectConfig();
    config.pidWhitelist = ['2170304'];
    const result = normalizeStructuredRows([
      ['未配置媒体', 'unknown_user_code_agent', '', '2170304', '不含渠道标记的PID名称', '10', '1', '0', '0', '1', '0', '0', '0', '0', '否'],
    ], columns, config, '2026-08-28', 'structured', false, { allowUnclassified: true });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].media).toBe('未识别');
    expect(result.rows[0].packageName).toBe('未识别');
  });

  it('filters reattribution rows unless explicitly enabled', () => {
    const config = createDefaultProjectConfig();
    config.pidWhitelist = ['2170304'];
    config.pidPackageMap = { '2170304': 'APK' };
    const row = ['头条', 'tt_ll_mroi7_agent_custom', 'android', '2170304', '渠道', '10', '1', '0', '0', '1', '0', '0', '0', '0', '是'];
    expect(normalizeStructuredRows([row], columns, config, '2026-08-28').rows).toHaveLength(0);
    expect(normalizeStructuredRows([row], columns, config, '2026-08-28', 'structured', true).rows).toHaveLength(1);
  });

  it('keeps real zero available while marking missing fields unavailable', () => {
    const config = createDefaultProjectConfig();
    config.pidWhitelist = ['2170304'];
    const result = normalizeStructuredRows([
      { 媒体: '头条', RADID: 'tt_ll_jh_agent', 操作系统: 'android', 渠道ID: '2170304', 渠道名称: '王国大作战-APK-头条-安卓', 消耗: 0, 激活设备数: 0, ROI: 0, 付费金额: 0 },
    ], columns, config, '2026-08-28');
    expect(result.rows[0].availableFields?.spend).toBe(true);
    expect(result.rows[0].availableFields?.roi).toBe(true);
    expect(result.rows[0].availableFields?.payment).toBe(true);
    expect(result.rows[0].availableFields?.sameDayPayment).toBe(false);
  });

  it('maps period payment amounts for aggregate ROI calculations', () => {
    const config = createDefaultProjectConfig();
    config.pidWhitelist = ['2170304'];
    const periodColumns = [...columns, { display_name: '次日付费金额' }, { display_name: '7日付费金额' }];
    const result = normalizeStructuredRows([
      { 媒体: '头条', RADID: 'tt_ll_jh_agent', 操作系统: 'android', 渠道ID: '2170304', 渠道名称: '王国大作战-APK-头条-安卓', 消耗: 100, 激活设备数: 10, '次日付费金额': 20, '7日付费金额': 50 },
    ], periodColumns, config, '2026-08-28');
    expect(result.rows[0].day2Payment).toBe(20);
    expect(result.rows[0].day7Payment).toBe(50);
    expect(result.rows[0].availableFields?.day2Roi).toBe(true);
    expect(result.rows[0].availableFields?.day7Roi).toBe(true);
  });

  it('ignores backend total rows before media classification', () => {
    const config = createDefaultProjectConfig();
    config.pidWhitelist = ['2170304'];
    const result = normalizeStructuredRows([
      { 媒体: '合计', 渠道ID: '2170304', 消耗: 100 },
      { 媒体: '未知媒体', RADID: 'bad_x_jh', 操作系统: 'android', 渠道ID: '2170304', 渠道名称: '王国大作战-APK-未知-安卓', 消耗: 10 },
    ], columns, config, '2026-08-28');
    expect(result.issues.filter((issue) => issue.code === 'unknown_media')).toHaveLength(1);
  });

  it('keeps live rows and labels live versus information-flow delivery', () => {
    const config = createDefaultProjectConfig();
    config.pidWhitelist = ['2170304'];
    const rows = [
      { 媒体: '头条', RADID: 'tt_ll_jh_agent', 操作系统: 'android', 渠道ID: '2170304', 渠道名称: '王国大作战-APK-头条-直播', 消耗: 10 },
      { 媒体: '头条', RADID: 'tt_ll_jh_agent_zb_custom', 操作系统: 'android', 渠道ID: '2170304', 渠道名称: '王国大作战-APK-头条-安卓', 消耗: 10 },
      { 媒体: '头条', RADID: 'tt_ll_jh_agent_zebra_custom', 操作系统: 'android', 渠道ID: '2170304', 渠道名称: '王国大作战-APK-头条-安卓', 消耗: 10 },
    ];
    const result = normalizeStructuredRows(rows, columns, config, '2026-08-28');
    expect(result.rows).toHaveLength(3);
    expect(result.rows.map((row) => row.deliveryType)).toEqual(['直播', '直播', '信息流']);
    expect(result.issues.filter((issue) => issue.code === 'live_data_excluded')).toHaveLength(0);
  });

  it('labels natural-volume rows from PID names', () => {
    const config = createDefaultProjectConfig();
    config.pidWhitelist = ['2170304'];
    const result = normalizeStructuredRows([
      { 媒体: '头条', RADID: 'tt_ll_jh_agent', 操作系统: 'android', 渠道ID: '2170304', 渠道名称: '王国大作战-APK-头条-自然流', 消耗: 10 },
    ], columns, config, '2026-08-28');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].deliveryType).toBe('自然量');
  });
});
