import { describe, expect, it, vi } from 'vitest';
import type { ScheduledExecutionRecord, ScheduledReport } from '../src/shared/contracts';
import { isScheduledReportDue, nextScheduledRun, normalizeScheduleTimeInputs, scheduleTimeInputsFromTimes } from '../src/shared/schedule';
import { ScheduledReportService } from '../src/main/scheduled-report-service';

const report: ScheduledReport = {
  id: 'schedule-a',
  name: '下午汇报',
  enabled: true,
  gameId: '1000',
  gameVersionId: 'version-a',
  pidInput: '1000001',
  incomeType: 'amount',
  includeReattribution: false,
  includePitcherDetails: false,
  titleTemplate: '【{pidName}】',
  metricOrder: ['spend'],
  times: ['15:30', '20:00'],
  targetIds: ['target-a'],
};

describe('scheduled report service', () => {
  it('normalizes fixed hour and minute inputs and rejects out-of-range values', () => {
    expect(scheduleTimeInputsFromTimes(['08:05', '20:00'])).toEqual([
      { hour: '08', minute: '05' },
      { hour: '20', minute: '00' },
    ]);
    expect(normalizeScheduleTimeInputs([
      { hour: '8', minute: '5' },
      { hour: '20', minute: '00' },
      { hour: '8', minute: '5' },
    ])).toEqual(['08:05', '20:00']);
    expect(normalizeScheduleTimeInputs([{ hour: '24', minute: '00' }])).toBeNull();
    expect(normalizeScheduleTimeInputs([{ hour: '23', minute: '60' }])).toBeNull();
    expect(normalizeScheduleTimeInputs([{ hour: '', minute: '30' }])).toBeNull();
  });

  it('runs an enabled plan once for a Beijing-time slot and persists its dedup record', async () => {
    const ledger = new Map<string, ScheduledExecutionRecord>();
    const execute = vi.fn(async () => ({ result: 'success' as const, code: 'SENT' }));
    const service = new ScheduledReportService({
      loadEnabledSchedules: async () => [report],
      scheduledExecution: async (slotKey) => ledger.get(slotKey) ?? null,
      saveScheduledExecution: async (record) => { ledger.set(record.slotKey, record); },
      execute,
      now: () => new Date('2026-09-01T07:30:10.000Z'),
    });

    await service.tick();
    await service.tick();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(ledger.get('schedule-a:2026-09-01:15:30')).toMatchObject({ result: 'success', code: 'SENT' });
  });

  it('uses Beijing time when describing the next execution', () => {
    expect(nextScheduledRun(report, new Date('2026-09-01T07:31:00.000Z'))).toBe('2026-09-01 20:00');
    expect(nextScheduledRun(report, new Date('2026-09-01T12:01:00.000Z'))).toBe('2026-09-02 15:30');
  });

  it('runs interval schedules only inside their configured daily time window', () => {
    const intervalReport: ScheduledReport = {
      ...report,
      scheduleMode: 'interval',
      startDate: '2026-09-01',
      endDate: '2026-09-01',
      intervalMinutes: 30,
      intervalEndTime: '16:00',
      times: ['15:30'],
    };
    expect(isScheduledReportDue(intervalReport, new Date('2026-09-01T07:30:10.000Z'))).toMatchObject({ date: '2026-09-01', time: '15:30' });
    expect(isScheduledReportDue(intervalReport, new Date('2026-09-01T08:00:10.000Z'))).toMatchObject({ date: '2026-09-01', time: '16:00' });
    expect(isScheduledReportDue(intervalReport, new Date('2026-09-01T08:15:10.000Z'))).toBeNull();
    expect(isScheduledReportDue(intervalReport, new Date('2026-09-01T08:30:10.000Z'))).toBeNull();
    expect(isScheduledReportDue(intervalReport, new Date('2026-09-02T07:30:10.000Z'))).toBeNull();
    expect(nextScheduledRun(intervalReport, new Date('2026-09-01T07:45:00.000Z'))).toBe('2026-09-01 16:00');
  });

  it('restarts the interval from the daily start time on the next eligible day', () => {
    const intervalReport: ScheduledReport = {
      ...report,
      scheduleMode: 'interval',
      startDate: '2026-09-01',
      intervalMinutes: 30,
      intervalEndTime: '10:00',
      times: ['09:00'],
    };
    expect(nextScheduledRun(intervalReport, new Date('2026-09-01T02:05:00.000Z'))).toBe('2026-09-02 09:00');
    expect(isScheduledReportDue(intervalReport, new Date('2026-09-02T01:00:10.000Z'))).toMatchObject({ date: '2026-09-02', time: '09:00' });
  });

  it('uses 23:59 as the daily end time for legacy interval plans', () => {
    const legacyIntervalReport: ScheduledReport = {
      ...report,
      scheduleMode: 'interval',
      startDate: '2026-09-01',
      intervalMinutes: 30,
      times: ['23:30'],
    };
    expect(isScheduledReportDue(legacyIntervalReport, new Date('2026-09-01T15:30:10.000Z'))).toMatchObject({ date: '2026-09-01', time: '23:30' });
    expect(isScheduledReportDue(legacyIntervalReport, new Date('2026-09-01T16:00:10.000Z'))).toBeNull();
  });

  it('applies the date range to a fixed-time schedule while keeping legacy schedules unrestricted', () => {
    const boundedReport: ScheduledReport = {
      ...report,
      startDate: '2026-09-02',
      endDate: '2026-09-03',
    };
    expect(isScheduledReportDue(boundedReport, new Date('2026-09-01T12:00:00.000Z'))).toBeNull();
    expect(isScheduledReportDue(boundedReport, new Date('2026-09-02T12:00:00.000Z'))).toMatchObject({ date: '2026-09-02', time: '20:00' });
    expect(isScheduledReportDue(boundedReport, new Date('2026-09-04T12:00:00.000Z'))).toBeNull();
    expect(isScheduledReportDue(report, new Date('2026-09-10T12:00:00.000Z'))).toMatchObject({ date: '2026-09-10', time: '20:00' });
  });

  it('re-runs a same-day waiting-login slot after login is restored', async () => {
    const ledger = new Map<string, ScheduledExecutionRecord>();
    const waiting: ScheduledExecutionRecord = {
      slotKey: 'schedule-a:2026-09-01:15:30',
      scheduleId: report.id,
      scheduleName: report.name,
      date: '2026-09-01',
      time: '15:30',
      result: 'waiting_login',
      code: 'LOGIN_WAITING_USER',
      occurredAt: '2026-09-01T08:00:00.000Z',
    };
    ledger.set(waiting.slotKey, waiting);
    const execute = vi.fn(async () => ({ result: 'success' as const, code: 'SENT' }));
    const service = new ScheduledReportService({
      loadEnabledSchedules: async () => [report],
      loadWaitingLoginExecutions: async () => [...ledger.values()].filter((item) => item.result === 'waiting_login'),
      scheduledExecution: async (slotKey) => ledger.get(slotKey) ?? null,
      saveScheduledExecution: async (record) => { ledger.set(record.slotKey, record); },
      execute,
      canRetryWaitingLogin: async () => true,
      now: () => new Date('2026-09-01T09:00:00.000Z'),
    });

    await service.tick();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(ledger.get(waiting.slotKey)).toMatchObject({ result: 'success', code: 'SENT' });
  });

  it('does not re-run a waiting-login slot after the scheduled date has passed', async () => {
    const waiting: ScheduledExecutionRecord = {
      slotKey: 'schedule-a:2026-09-01:15:30',
      scheduleId: report.id,
      scheduleName: report.name,
      date: '2026-09-01',
      time: '15:30',
      result: 'waiting_login',
      code: 'LOGIN_WAITING_USER',
      occurredAt: '2026-09-01T08:00:00.000Z',
    };
    const execute = vi.fn(async () => ({ result: 'success' as const, code: 'SENT' }));
    const service = new ScheduledReportService({
      loadEnabledSchedules: async () => [report],
      loadWaitingLoginExecutions: async () => [waiting],
      scheduledExecution: async () => waiting,
      saveScheduledExecution: async () => undefined,
      execute,
      canRetryWaitingLogin: async () => true,
      now: () => new Date('2026-09-02T09:00:00.000Z'),
    });

    await service.tick();

    expect(execute).not.toHaveBeenCalled();
  });
});
