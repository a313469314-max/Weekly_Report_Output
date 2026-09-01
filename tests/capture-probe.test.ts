import { describe, expect, it } from 'vitest';
import { parseCaptureProbe } from '../src/main/capture-probe';

const encoded = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

describe('capture probe request parsing', () => {
  it('accepts a complete explicit probe request without adding any defaults', () => {
    expect(parseCaptureProbe(encoded({
      gameId: '1234', pids: ['12341', '12342', '12341'], startDate: '2026-08-10', endDate: '2026-08-16',
      paymentStatsEndDate: '2026-08-31', incomeType: 'amount', includeReattribution: false,
    }))).toEqual({
      gameId: '1234', pids: ['12341', '12342'], startDate: '2026-08-10', endDate: '2026-08-16',
      paymentStatsEndDate: '2026-08-31', incomeType: 'amount', includeReattribution: false,
    });
  });

  it('rejects malformed or incomplete probe requests', () => {
    expect(parseCaptureProbe(undefined)).toBeNull();
    expect(parseCaptureProbe(encoded({ gameId: '1234', pids: [], startDate: '2026-08-10' }))).toBeNull();
    expect(parseCaptureProbe('invalid')).toBeNull();
  });
});
