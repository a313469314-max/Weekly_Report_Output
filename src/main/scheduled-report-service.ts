import type { ScheduledExecutionRecord, ScheduledExecutionResult, ScheduledReport } from '../shared/contracts';
import { beijingClock, isScheduledReportDue, scheduledSlotKey } from '../shared/schedule';

export interface ScheduledReportExecutionOutcome {
  result: Exclude<ScheduledExecutionResult, 'running'>;
  code: string;
}

export interface ScheduledReportServiceOptions {
  loadEnabledSchedules: () => Promise<ScheduledReport[]>;
  loadWaitingLoginExecutions?: () => Promise<ScheduledExecutionRecord[]>;
  scheduledExecution: (slotKey: string) => Promise<ScheduledExecutionRecord | null>;
  saveScheduledExecution: (record: ScheduledExecutionRecord) => Promise<void>;
  execute: (schedule: ScheduledReport) => Promise<ScheduledReportExecutionOutcome>;
  canRetryWaitingLogin?: (record?: ScheduledExecutionRecord) => Promise<boolean>;
  onStatus?: (record: ScheduledExecutionRecord) => void;
  now?: () => Date;
}

export class ScheduledReportService {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly inFlightSlots = new Set<string>();

  constructor(private readonly options: ScheduledReportServiceOptions) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, 15_000);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const schedules = await this.options.loadEnabledSchedules();
      const now = (this.options.now ?? (() => new Date()))();
      const runs: Promise<void>[] = [];
      for (const schedule of schedules) {
        const due = isScheduledReportDue(schedule, now);
        if (!due) continue;
        runs.push(this.runScheduled(schedule, due.date, due.time));
      }
      if (this.options.loadWaitingLoginExecutions && this.options.canRetryWaitingLogin) {
        const currentDate = beijingClock(now).date;
        const waitingRecords = await this.options.loadWaitingLoginExecutions();
        for (const record of waitingRecords) {
          if (record.date !== currentDate) continue;
          const schedule = schedules.find((candidate) => candidate.id === record.scheduleId);
          if (!schedule) continue;
          if (!await this.options.canRetryWaitingLogin(record)) continue;
          runs.push(this.runScheduled(schedule, record.date, record.time));
        }
      }
      await Promise.all(runs);
    } finally {
      this.ticking = false;
    }
  }

  async runNow(schedule: ScheduledReport): Promise<ScheduledExecutionRecord> {
    const now = (this.options.now ?? (() => new Date()))();
    const { date, time } = beijingClock(now);
    return this.execute(schedule, `manual:${schedule.id}:${now.toISOString()}`, date, time);
  }

  private async runScheduled(schedule: ScheduledReport, date: string, time: string): Promise<void> {
    const slotKey = scheduledSlotKey(schedule.id, date, time);
    if (this.inFlightSlots.has(slotKey)) return;
    this.inFlightSlots.add(slotKey);
    try {
    const existing = await this.options.scheduledExecution(slotKey);
    if (existing?.result === 'waiting_login') {
      const now = (this.options.now ?? (() => new Date()))();
      if (beijingClock(now).date !== existing.date) return;
      if (!this.options.canRetryWaitingLogin || !await this.options.canRetryWaitingLogin(existing)) return;
    } else if (existing) {
      return;
    }
    await this.execute(schedule, slotKey, date, time);
    } finally {
      this.inFlightSlots.delete(slotKey);
    }
  }

  private async execute(schedule: ScheduledReport, slotKey: string, date: string, time: string): Promise<ScheduledExecutionRecord> {
    const running: ScheduledExecutionRecord = {
      slotKey,
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      date,
      time,
      result: 'running',
      code: 'STARTED',
      occurredAt: new Date().toISOString(),
    };
    await this.options.saveScheduledExecution(running);
    this.options.onStatus?.(running);
    let outcome: ScheduledReportExecutionOutcome;
    try {
      outcome = await this.options.execute(schedule);
    } catch {
      outcome = { result: 'unknown', code: 'UNEXPECTED_ERROR' };
    }
    const completed: ScheduledExecutionRecord = {
      ...running,
      result: outcome.result,
      code: outcome.code.slice(0, 80) || 'UNKNOWN',
      occurredAt: new Date().toISOString(),
    };
    await this.options.saveScheduledExecution(completed);
    this.options.onStatus?.(completed);
    return completed;
  }
}
