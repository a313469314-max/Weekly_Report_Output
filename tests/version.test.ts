import { describe, expect, it } from 'vitest';
import { buildDailyQuery, ConnectorError, datePickerDayAriaLabel, datePickerYearFromHeader, dateRange, incomeLabelForType, isSelectedVersionCurrent, missingPidsFromFilterLabel, pitcherFilterSearchTarget, queryConditionMismatches, selectValidVersionCandidates, shouldRetryDailyPageSetup } from '../src/main/q1-connector';

describe('game version selection', () => {
  it('maps a pitcher code to the backend option label while keeping the search input short', () => {
    expect(pitcherFilterSearchTarget('fz')).toEqual({ searchValue: 'fz', optionValue: 'fz:fz' });
    expect(pitcherFilterSearchTarget('fz:fz')).toEqual({ searchValue: 'fz', optionValue: 'fz:fz' });
    expect(pitcherFilterSearchTarget('fz：fz')).toEqual({ searchValue: 'fz', optionValue: 'fz:fz' });
  });

  it('returns all valid versions for manual selection', () => {
    const result = selectValidVersionCandidates([
      { key: '2170-CN-A', name: '中文版', gameId: '2170', flag: 1 },
      { key: '2170-CN-B', name: '中文版新包', gameId: '2170', flag: 1 },
      { key: '2170-OFF', name: '已下线', gameId: '2170', flag: 0 },
      { key: '2171-CN-A', name: '其他项目', gameId: '2171', flag: 1 },
    ], '2170');
    expect(result.map((candidate) => candidate.key)).toEqual(['2170-CN-A', '2170-CN-B']);
  });

  it('creates an inclusive Beijing report date list for daily queries', () => {
    expect(dateRange('2026-08-10', '2026-08-17')).toEqual([
      '2026-08-10',
      '2026-08-11',
      '2026-08-12',
      '2026-08-13',
      '2026-08-14',
      '2026-08-15',
      '2026-08-16',
      '2026-08-17',
    ]);
    expect(dateRange('2026-08-17', '2026-08-10')).toEqual([]);
  });

  it('keeps the configured payment statistics end date for every daily query', () => {
    const query = buildDailyQuery({
      gameId: '2170', gameVersionId: '2170-CN', pids: ['2170405'], startDate: '2026-08-10', endDate: '2026-08-17',
      paymentStatsEndDate: '2026-08-29', incomeType: 'amount', includeReattribution: false, includePitcherDetails: false,
    }, '2026-08-12');
    expect(query.startDate).toBe('2026-08-12');
    expect(query.endDate).toBe('2026-08-12');
    expect(query.paymentStatsEndDate).toBe('2026-08-29');
  });

  it('retries daily page initialization only once for transient date-control failures', () => {
    expect(shouldRetryDailyPageSetup(new ConnectorError('QUERY_CONDITIONS_NOT_APPLIED', '日期控件未打开'), 0)).toBe(true);
    expect(shouldRetryDailyPageSetup(new ConnectorError('REPORT_LOAD_TIMEOUT', '页面未就绪'), 0)).toBe(true);
    expect(shouldRetryDailyPageSetup(new ConnectorError('QUERY_CONDITIONS_NOT_APPLIED', '日期控件未打开'), 1)).toBe(false);
    expect(shouldRetryDailyPageSetup(new ConnectorError('PID_FILTER_NOT_APPLIED', 'PID 未筛选'), 0)).toBe(false);
  });

  it('confirms only complete PID values shown in the top filter label', () => {
    expect(missingPidsFromFilterLabel(['2170304', '217030'], '渠道ID名称：2170304，2170405')).toEqual(['217030']);
    expect(missingPidsFromFilterLabel(['2170304'], '')).toEqual(['2170304']);
  });

  it('accepts a saved selected version only while it remains an active candidate for this gameid', () => {
    const candidates = [
      { key: '2170-CN-A', name: '版本A', gameId: '2170', flag: 1 },
      { key: '2170-CN-B', name: '版本B', gameId: '2170', flag: 1 },
    ];
    expect(isSelectedVersionCurrent(candidates, '2170', '2170-CN-B')).toBe(true);
    expect(isSelectedVersionCurrent(candidates, '2170', '2170-CN-OLD')).toBe(false);
    expect(isSelectedVersionCurrent(candidates, '2171', '2170-CN-A')).toBe(false);
  });

  it('blocks generation when any required query condition cannot be read back', () => {
    const query = {
      gameId: '2170', gameVersionId: '2170-CN-A', pids: ['2170304'], startDate: '2026-08-28', endDate: '2026-08-28',
      paymentStatsEndDate: '2026-08-30', incomeType: 'realamount' as const, includeReattribution: false, includePitcherDetails: false,
    };
    expect(queryConditionMismatches(query, {
      missingControls: [], startDate: '2026-08-28', endDate: '2026-08-28', paymentStatsEndDate: '2026-08-30', incomeLabel: 'amount:收入', pidFilterLabel: '渠道ID名称：2170304',
    })).toEqual(['收入类型']);
    expect(queryConditionMismatches(query, {
      missingControls: ['开始日期'], startDate: '2026-08-28', endDate: '2026-08-28', paymentStatsEndDate: '2026-08-30', incomeLabel: 'realamount:实收', pidFilterLabel: '渠道ID名称：2170304',
    })).toEqual(['开始日期']);
  });

  it('normalizes localized date control readback before comparing query conditions', () => {
    const query = {
      gameId: '2170', gameVersionId: '2170-CN-A', pids: [], startDate: '2026-08-28', endDate: '2026-08-29',
      paymentStatsEndDate: '2026-08-30', incomeType: 'amount' as const, includeReattribution: false, includePitcherDetails: false,
    };
    expect(queryConditionMismatches(query, {
      missingControls: [], startDate: '2026年8月28日', endDate: '2026/8/29', paymentStatsEndDate: '2026.8.30', incomeLabel: 'amount:收入', pidFilterLabel: '',
    })).toEqual([]);
  });

  it('uses the verified backend income labels for amount and realamount', () => {
    expect(incomeLabelForType('amount')).toBe('收入');
    expect(incomeLabelForType('realamount')).toBe('实收');
  });

  it('uses the backend date-picker labels for the exact target day', () => {
    expect(datePickerDayAriaLabel('2026-08-10')).toBe('10 八月 2026');
    expect(datePickerDayAriaLabel('2027-01-02')).toBe('2 一月 2027');
    expect(() => datePickerDayAriaLabel('2026-13-01')).toThrow('Invalid ISO date');
  });

  it('recognizes the date-picker year header for cross-year navigation', () => {
    expect(datePickerYearFromHeader('2026')).toBe(2026);
    expect(datePickerYearFromHeader('八月 2026')).toBeNull();
  });
});
