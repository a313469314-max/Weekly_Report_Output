import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

type SafeValue = string | number | boolean;

const SAFE_DETAIL_KEYS = new Set([
  'stage', 'reason', 'code', 'format', 'mode', 'status', 'result', 'rows', 'columns', 'arrays', 'objects', 'issues',
  'hasIframe', 'visibleDialogs', 'dialogInputs', 'pidSearchInputs', 'channelNameButtons', 'channelFilterButtons',
  'visibleMenus', 'enabledPidFilterButtons', 'addFilterButtons', 'confirmButtons', 'visibleButtons', 'dialogPidMatches', 'buttonPidMatches',
  'visiblePidOptions', 'matchingPidOptions', 'checkedMatchingPidOptions', 'searchValueMatches', 'checkedPidOptions',
  'hasRadid', 'hasSpend', 'hasActivatedDevices', 'hasRevenue',
  'date', 'candidateCount', 'selected', 'targetPidCount', 'unexpectedPidCount', 'fieldFingerprint',
  'paginationMetadata', 'paginationNext',
  'candidateIndex', 'spendAvailableRows', 'activatedDevicesAvailableRows', 'sameDayPaymentAvailableRows', 'paymentAvailableRows',
  'startDateMatches', 'endDateMatches', 'paymentStatsEndDateMatches', 'incomeTypeMatches', 'pidFilterMatches',
  'datePickerCountBefore', 'datePickerCountAfter', 'datePickerFailure', 'datePickerFailureReason',
  'attempt', 'maxAttempts',
]);

function safeText(value: unknown): string {
  const text = String(value ?? '');
  return /^[A-Za-z0-9_. -]{1,80}$/u.test(text) || /^HTTP_\d{3}$/u.test(text) ? text : 'unspecified';
}

function safeErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(code)) return code;
  }
  return error instanceof Error ? safeText(error.name) : 'UnknownError';
}

export class DiagnosticLogger {
  get directoryPath(): string {
    return join(app.getPath('userData'), 'diagnostics');
  }

  get filePath(): string {
    return join(this.directoryPath, 'latest.log');
  }

  async begin(): Promise<void> {
    try {
      await fs.mkdir(this.directoryPath, { recursive: true });
      await fs.writeFile(this.filePath, `${new Date().toISOString()} RUN_STARTED\n`, 'utf8');
    } catch {
      // Diagnostics must never interrupt report generation.
    }
  }

  async event(event: string, details: Record<string, SafeValue> = {}): Promise<void> {
    try {
      const safeDetails = Object.fromEntries(
        Object.entries(details)
          .filter(([key]) => SAFE_DETAIL_KEYS.has(key))
          .map(([key, value]) => [key, typeof value === 'string' ? safeText(value) : value]),
      );
      await fs.mkdir(this.directoryPath, { recursive: true });
      await fs.appendFile(this.filePath, `${JSON.stringify({ time: new Date().toISOString(), event, ...safeDetails })}\n`, 'utf8');
    } catch {
      // Diagnostics must never interrupt report generation.
    }
  }

  async error(stage: string, error: unknown, details: Record<string, SafeValue> = {}): Promise<void> {
    await this.event('ERROR', { stage, code: safeErrorCode(error), reason: error instanceof Error ? safeText(error.message) : 'unspecified', ...details });
  }
}
