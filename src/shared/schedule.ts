import type { ScheduledReport } from './contracts';

export interface BeijingClock {
  date: string;
  time: string;
}

export interface ScheduleTimeInput {
  hour: string;
  minute: string;
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((item) => item.type === type)?.value ?? '';
}

export function beijingClock(now = new Date()): BeijingClock {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  return {
    date: `${part(parts, 'year')}-${part(parts, 'month')}-${part(parts, 'day')}`,
    time: `${part(parts, 'hour')}:${part(parts, 'minute')}`,
  };
}

function dateOffset(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

export function scheduledSlotKey(scheduleId: string, date: string, time: string): string {
  return `${scheduleId}:${date}:${time}`;
}

function validDate(value: string | undefined): boolean {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/u.test(value));
}

function inDateRange(report: ScheduledReport, date: string): boolean {
  const startDate = report.startDate ?? '';
  const endDate = report.endDate ?? null;
  return (!startDate || date >= startDate) && (!endDate || date <= endDate);
}

function beijingMinuteDate(date: string, time: string): Date {
  return new Date(`${date}T${time}:00+08:00`);
}

function validTime(value: string | undefined): boolean {
  return Boolean(value && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value));
}

export function scheduleTimeInputsFromTimes(times: string[]): ScheduleTimeInput[] {
  const inputs = times.map((time) => {
    const [hour = '', minute = ''] = time.split(':');
    return { hour, minute };
  });
  return inputs.length > 0 ? inputs : [{ hour: '15', minute: '30' }];
}

export function normalizeScheduleTimeInputs(inputs: ScheduleTimeInput[]): string[] | null {
  const times = inputs.map(({ hour, minute }) => {
    if (!/^\d{1,2}$/u.test(hour) || !/^\d{1,2}$/u.test(minute)) return null;
    const hourValue = Number(hour);
    const minuteValue = Number(minute);
    if (hourValue > 23 || minuteValue > 59) return null;
    return `${String(hourValue).padStart(2, '0')}:${String(minuteValue).padStart(2, '0')}`;
  });
  if (times.some((time) => time === null)) return null;
  return [...new Set(times as string[])].sort();
}

export function isScheduledReportDue(report: ScheduledReport, now = new Date()): BeijingClock | null {
  if (!report.enabled) return null;
  const clock = beijingClock(now);
  if (!inDateRange(report, clock.date)) return null;
  if (report.scheduleMode !== 'interval') return report.times.includes(clock.time) ? clock : null;
  const startDate = report.startDate;
  const startTime = report.times[0];
  const intervalMinutes = report.intervalMinutes;
  if (!validDate(startDate) || !startTime || !Number.isInteger(intervalMinutes) || (intervalMinutes ?? 0) < 1) return null;
  const safeStartDate = startDate as string;
  const safeStartTime = startTime as string;
  const safeIntervalMinutes = intervalMinutes as number;
  const intervalEndTime = report.intervalEndTime ?? '23:59';
  if (!validTime(intervalEndTime) || safeStartTime >= intervalEndTime || clock.time < safeStartTime || clock.time > intervalEndTime) return null;
  const dailyStart = beijingMinuteDate(clock.date, safeStartTime);
  const current = beijingMinuteDate(clock.date, clock.time);
  const elapsedMinutes = Math.floor((current.getTime() - dailyStart.getTime()) / 60_000);
  return elapsedMinutes >= 0 && elapsedMinutes % safeIntervalMinutes === 0 ? clock : null;
}

export function nextScheduledRun(report: ScheduledReport, now = new Date()): string | null {
  if (!report.enabled || report.times.length === 0) return null;
  const clock = beijingClock(now);
  if (report.scheduleMode === 'interval') {
    const startDate = report.startDate;
    const startTime = report.times[0];
    const intervalMinutes = report.intervalMinutes;
    if (!validDate(startDate) || !startTime || !Number.isInteger(intervalMinutes) || (intervalMinutes ?? 0) < 1) return null;
    const safeStartDate = startDate as string;
    const safeStartTime = startTime as string;
    const safeIntervalMinutes = intervalMinutes as number;
    const intervalEndTime = report.intervalEndTime ?? '23:59';
    if (!validTime(intervalEndTime) || safeStartTime >= intervalEndTime) return null;
    let candidateDate = clock.date < safeStartDate ? safeStartDate : clock.date;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!inDateRange(report, candidateDate)) return null;
      const dayStart = beijingMinuteDate(candidateDate, safeStartTime);
      const dayEnd = beijingMinuteDate(candidateDate, intervalEndTime);
      const current = candidateDate === clock.date ? beijingMinuteDate(clock.date, clock.time) : dayStart;
      const intervalMs = safeIntervalMinutes * 60_000;
      const nextMs = current <= dayStart ? dayStart.getTime() : dayStart.getTime() + Math.ceil((current.getTime() - dayStart.getTime()) / intervalMs) * intervalMs;
      if (nextMs <= dayEnd.getTime()) {
        const nextClock = beijingClock(new Date(nextMs));
        return `${nextClock.date} ${nextClock.time}`;
      }
      candidateDate = dateOffset(candidateDate, 1);
    }
    return null;
  }
  const sortedTimes = [...report.times].sort();
  let candidateDate = clock.date;
  let candidateTime = sortedTimes.find((time) => time >= clock.time);
  if (!candidateTime) {
    candidateDate = dateOffset(clock.date, 1);
    candidateTime = sortedTimes[0];
  }
  if (report.startDate && candidateDate < report.startDate) {
    candidateDate = report.startDate;
    candidateTime = sortedTimes[0];
  }
  if (!inDateRange(report, candidateDate)) return null;
  return `${candidateDate} ${candidateTime}`;
}
