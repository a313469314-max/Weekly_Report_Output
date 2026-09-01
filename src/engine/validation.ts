import type { ProjectConfig, RawAdRow, ValidationBaseline, ValidationIssue } from '../shared/contracts';

export interface NumericComparison {
  code: string;
  message: string;
  actual: number;
  expected: number;
  kind: 'amount' | 'ratio';
  actualAvailable?: boolean;
  expectedAvailable?: boolean;
}

export function exceedsThreshold(comparison: NumericComparison, config: ProjectConfig): boolean {
  if (comparison.actualAvailable === false || comparison.expectedAvailable === false) return false;
  const threshold = comparison.kind === 'amount' ? config.thresholds.amount : config.thresholds.percentagePoint / 100;
  return Math.abs(comparison.actual - comparison.expected) > threshold;
}

export function issuesFromComparisons(comparisons: NumericComparison[], config: ProjectConfig): ValidationIssue[] {
  return comparisons
    .filter((comparison) => exceedsThreshold(comparison, config))
    .map((comparison) => ({ level: 'warning', code: comparison.code, message: comparison.message }));
}

function available(row: RawAdRow, key: string): boolean {
  return row.availableFields?.[key as keyof NonNullable<RawAdRow['availableFields']>] !== false;
}

export function validateBackendRatios(rows: RawAdRow[], config: ProjectConfig): ValidationIssue[] {
  const comparisons: NumericComparison[] = [];
  for (const row of rows) {
    if (available(row, 'roi') && available(row, 'payment') && available(row, 'spend')) {
      comparisons.push({
        code: 'roi_mismatch',
        message: '后台 ROI 与付费金额/消耗重算结果超过阈值。',
        actual: row.roi,
        expected: row.spend === 0 ? 0 : row.payment / row.spend,
        kind: 'ratio',
      });
    }
    if (available(row, 'firstDayRoi') && available(row, 'sameDayPayment') && available(row, 'spend')) {
      comparisons.push({
        code: 'first_day_roi_mismatch',
        message: '后台首日 ROI 与当日付费金额/消耗重算结果超过阈值。',
        actual: row.firstDayRoi,
        expected: row.spend === 0 ? 0 : row.sameDayPayment / row.spend,
        kind: 'ratio',
      });
    }
  }
  return issuesFromComparisons(comparisons, config);
}

function actualAmount(rows: RawAdRow[], metric: ValidationBaseline['metric']): number {
  return rows.reduce((total, row) => total + row[metric], 0);
}

function actualAmountAvailable(rows: RawAdRow[], metric: ValidationBaseline['metric']): boolean {
  return rows.length > 0 && rows.every((row) => available(row, metric));
}

export function validateAmountBaselines(rows: RawAdRow[], baselines: ValidationBaseline[], config: ProjectConfig): ValidationIssue[] {
  return issuesFromComparisons(
    baselines.map((baseline) => ({
      code: `amount_${baseline.metric}_mismatch`,
      message: `${baseline.label ?? baseline.metric}后台基准与生成结果超过金额阈值。`,
      actual: actualAmount(rows, baseline.metric),
      expected: baseline.expected,
      kind: 'amount' as const,
      actualAvailable: actualAmountAvailable(rows, baseline.metric),
      expectedAvailable: baseline.available !== false,
    })),
    config,
  );
}
