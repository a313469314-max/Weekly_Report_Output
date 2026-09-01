import type { IncomeType } from '../shared/contracts';

export interface CaptureProbeRequest {
  gameId: string;
  pids: string[];
  startDate: string;
  endDate: string;
  paymentStatsEndDate: string;
  incomeType: IncomeType;
  includeReattribution: boolean;
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value);
}

export function parseCaptureProbe(value: string | undefined): CaptureProbeRequest | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      typeof parsed.gameId !== 'string' || !/^\d{4,}$/u.test(parsed.gameId)
      || !Array.isArray(parsed.pids) || parsed.pids.length === 0 || !parsed.pids.every((pid) => typeof pid === 'string' && /^\d+$/u.test(pid))
      || !validDate(parsed.startDate) || !validDate(parsed.endDate) || !validDate(parsed.paymentStatsEndDate)
      || (parsed.incomeType !== 'amount' && parsed.incomeType !== 'realamount')
    ) return null;
    return {
      gameId: parsed.gameId,
      pids: [...new Set(parsed.pids)],
      startDate: parsed.startDate,
      endDate: parsed.endDate,
      paymentStatsEndDate: parsed.paymentStatsEndDate,
      incomeType: parsed.incomeType,
      includeReattribution: parsed.includeReattribution === true,
    };
  } catch {
    return null;
  }
}
