import { describe, expect, it } from 'vitest';
import { isReportFrameReady, type ReportFrameReadyState } from '../src/main/q1-connector';

const readyState: ReportFrameReadyState = {
  iframeCount: 1,
  reportFrameCount: 1,
  hasActiveFrame: true,
  documentReady: true,
  startDateInteractive: true,
  endDateInteractive: true,
  paymentDateInteractive: true,
};

describe('report-frame readiness', () => {
  it('requires an active, fully loaded frame with every date control clickable', () => {
    expect(isReportFrameReady(readyState)).toBe(true);
    expect(isReportFrameReady({ ...readyState, documentReady: false })).toBe(false);
    expect(isReportFrameReady({ ...readyState, hasActiveFrame: false })).toBe(false);
    expect(isReportFrameReady({ ...readyState, startDateInteractive: false })).toBe(false);
    expect(isReportFrameReady({ ...readyState, endDateInteractive: false })).toBe(false);
    expect(isReportFrameReady({ ...readyState, paymentDateInteractive: false })).toBe(false);
  });
});
