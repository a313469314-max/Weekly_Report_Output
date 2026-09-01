import type { MetricKey, RawAdRow, ValidationIssue } from '../shared/contracts';

const frontendFields = ['spend', 'impressions', 'clicks', 'installs'] as const;
const backendFields = ['activatedDevices', 'sameDayPayingDevices', 'sameDayPayment', 'loginDevices', 'registrationDevices', 'payingDevices', 'payment', 'day2Payment', 'day3Payment', 'day7Payment', 'day30Payment'] as const;
const systemNames = new Set(['安卓', 'IOS', '鸿蒙']);

function sourceKey(row: RawAdRow): string {
  return [row.date, row.media, row.pid, row.accountId, row.accountName, row.radid, row.pidName, row.packageName, row.bidCode, row.bidName, row.tapSegment, row.isReattribution, row.source].join('\u001f');
}

function hasAny(row: RawAdRow, fields: readonly (keyof RawAdRow)[]): boolean {
  return fields.some((field) => Number(row[field] ?? 0) !== 0);
}

function hasAvailableField(row: RawAdRow, fields: readonly (keyof RawAdRow)[]): boolean {
  return fields.some((field) => row.availableFields?.[field as MetricKey] !== false && !row.notApplicableFields?.[field as MetricKey]);
}

function sumFields(rows: RawAdRow[], fields: readonly (keyof RawAdRow)[]): Partial<Pick<RawAdRow, typeof frontendFields[number] | typeof backendFields[number]>> {
  const totals: Partial<Pick<RawAdRow, typeof frontendFields[number] | typeof backendFields[number]>> = {};
  for (const field of fields) totals[field as keyof typeof totals] = 0;
  for (const row of rows) {
    for (const field of fields) {
      const key = field as keyof typeof totals;
      totals[key] = (totals[key] ?? 0) + Number(row[field] ?? 0);
    }
  }
  return totals;
}

function mergeAvailability(rows: RawAdRow[]): Pick<RawAdRow, 'availableFields' | 'partialFields'> {
  const availableFields: Partial<Record<MetricKey, boolean>> = {};
  const partialFields: Partial<Record<MetricKey, boolean>> = {};
  const keys = new Set<MetricKey>();
  for (const row of rows) {
    for (const key of Object.keys(row.availableFields ?? {})) keys.add(key as MetricKey);
    for (const key of Object.keys(row.partialFields ?? {})) keys.add(key as MetricKey);
  }
  for (const key of keys) {
    let hasComplete = false;
    let hasPartial = false;
    let hasMissing = false;
    for (const row of rows) {
      if (row.notApplicableFields?.[key]) continue;
      if (row.partialFields?.[key]) hasPartial = true;
      else if (row.availableFields?.[key] === false) hasMissing = true;
      else hasComplete = true;
    }
    if (hasPartial || (hasComplete && hasMissing)) {
      availableFields[key] = true;
      partialFields[key] = true;
    } else if (hasComplete) {
      availableFields[key] = true;
    } else if (hasMissing) {
      availableFields[key] = false;
    }
  }
  return { availableFields, partialFields };
}

function fieldIsAvailable(row: RawAdRow, field: keyof RawAdRow): boolean {
  return row.availableFields?.[field as MetricKey] !== false && !row.notApplicableFields?.[field as MetricKey];
}

function frontendCandidates(rows: RawAdRow[]): RawAdRow[] {
  const systemRows = rows.filter((row) => systemNames.has(row.operatingSystem));
  const androidRows = systemRows.filter((row) => row.operatingSystem === '安卓');
  const totalRows = rows.filter((row) => !systemNames.has(row.operatingSystem));
  const otherSystemRows = systemRows.filter((row) => row.operatingSystem !== '安卓');
  return [...androidRows, ...totalRows, ...otherSystemRows].filter((row) => hasAvailableField(row, frontendFields));
}

function selectFrontendValues(rows: RawAdRow[], hasPidSummaryFrontend: boolean, issues: ValidationIssue[], pidDateKey: string, reportedPidSummaryFrontend: Set<string>): {
  values: Partial<Pick<RawAdRow, typeof frontendFields[number]>>;
  availableFields: Partial<Record<MetricKey, boolean>>;
  available: boolean;
} {
  const candidates = frontendCandidates(rows);
  const values: Partial<Pick<RawAdRow, typeof frontendFields[number]>> = {};
  const availableFields: Partial<Record<MetricKey, boolean>> = {};
  for (const field of frontendFields) {
    const source = candidates.find((row) => fieldIsAvailable(row, field));
    if (source) {
      values[field] = Number(source[field] ?? 0);
      availableFields[field] = true;
    } else {
      values[field] = 0;
      availableFields[field] = false;
    }
  }
  const available = frontendFields.some((field) => availableFields[field]);
  if (!available) {
    if (hasPidSummaryFrontend) {
      if (!reportedPidSummaryFrontend.has(pidDateKey)) {
        issues.push({ level: 'warning', code: 'mixed_pid_frontend_pid_summary_only', message: '混投 PID 的前端指标仅使用 PID 汇总层一次，未伪造分 RADID 或分系统消耗。' });
        reportedPidSummaryFrontend.add(pidDateKey);
      }
    } else {
      issues.push({ level: 'warning', code: 'mixed_pid_frontend_missing', message: '混投 PID 未找到可用的前端总计指标，多端合计中的消耗、展示、点击和安装将显示为“-”。' });
    }
  }
  return { values, availableFields, available };
}

function sumFrontendValues(rows: RawAdRow[]): {
  values: Partial<Pick<RawAdRow, typeof frontendFields[number]>>;
  availableFields: Partial<Record<MetricKey, boolean>>;
  available: boolean;
} {
  const values: Partial<Pick<RawAdRow, typeof frontendFields[number]>> = {};
  const availableFields: Partial<Record<MetricKey, boolean>> = {};
  for (const field of frontendFields) {
    const sources = rows.filter((row) => fieldIsAvailable(row, field));
    if (sources.length === 0) {
      values[field] = 0;
      availableFields[field] = false;
    } else {
      values[field] = sources.reduce((total, row) => total + Number(row[field] ?? 0), 0);
      availableFields[field] = true;
    }
  }
  return { values, availableFields, available: frontendFields.some((field) => availableFields[field]) };
}

function buildCrossSystemSummaryRow(rows: RawAdRow[]): RawAdRow {
  const systemRows = rows.filter((row) => systemNames.has(row.operatingSystem));
  const template = rows[0];
  const frontend = sumFrontendValues(systemRows);
  const backendTotals = sumFields(systemRows, backendFields);
  const mergedAvailability = mergeAvailability(systemRows);
  for (const field of frontendFields) {
    mergedAvailability.availableFields![field] = frontend.availableFields[field];
    delete mergedAvailability.partialFields?.[field];
  }
  return {
    ...template,
    ...frontend.values,
    ...backendTotals,
    operatingSystem: '多端合计',
    isMixedPid: false,
    isMixedSystemBreakdown: false,
    isCrossSystemSummary: true,
    frontEndMetricsAvailable: frontend.available,
    ...mergedAvailability,
  };
}

function buildMixedRows(rows: RawAdRow[], issues: ValidationIssue[], hasPidSummaryFrontend: boolean, reportedPidSummaryFrontend: Set<string>): RawAdRow[] {
  const systemRows = rows.filter((row) => systemNames.has(row.operatingSystem));
  const totalRows = rows.filter((row) => !systemNames.has(row.operatingSystem));
  const backendSystemRows = systemRows.filter((row) => hasAny(row, backendFields));
  const backendCandidates = backendSystemRows.length > 0 ? backendSystemRows : totalRows;
  const template = totalRows[0] ?? systemRows[0] ?? rows[0];
  const pidDateKey = `${template.date}\u001f${template.pid}`;
  const frontend = selectFrontendValues(rows, hasPidSummaryFrontend, issues, pidDateKey, reportedPidSummaryFrontend);
  const backendTotals = sumFields(backendCandidates, backendFields);
  const mergedAvailability = mergeAvailability(backendCandidates);
  for (const field of frontendFields) {
    mergedAvailability.availableFields![field] = frontend.availableFields[field];
    delete mergedAvailability.partialFields?.[field];
  }
  const output: RawAdRow[] = [{
    ...template,
    ...frontend.values,
    ...backendTotals,
    operatingSystem: '多端合计',
    isMixedPid: true,
    isMixedSystemBreakdown: false,
    frontEndMetricsAvailable: frontend.available,
    ...mergedAvailability,
  }];

  if (backendSystemRows.length === 0) {
    issues.push({ level: 'warning', code: 'mixed_pid_system_missing', message: '混投 PID 未返回可识别的安卓、IOS或鸿蒙后端明细，无法生成系统拆分行。' });
    return output;
  }

  const bySystem = new Map<string, RawAdRow[]>();
  for (const row of backendSystemRows) bySystem.set(row.operatingSystem, [...(bySystem.get(row.operatingSystem) ?? []), row]);
  for (const [system, rowsForSystem] of bySystem) {
    const backend = sumFields(rowsForSystem, backendFields);
    output.push({
      ...rowsForSystem[0],
      ...backend,
      spend: 0,
      impressions: 0,
      clicks: 0,
      installs: 0,
      operatingSystem: `${system}（混投拆分）`,
      isMixedPid: true,
      isMixedSystemBreakdown: true,
      frontEndMetricsAvailable: false,
      ...mergeAvailability(rowsForSystem),
      notApplicableFields: Object.fromEntries(frontendFields.map((field) => [field, true])),
    });
  }
  return output;
}

export function materializeMixedPidRows(rows: RawAdRow[], pidSummaryRows: RawAdRow[] = []): { rows: RawAdRow[]; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const output: RawAdRow[] = [];
  const grouped = new Map<string, RawAdRow[]>();
  const pidSummaryFrontend = new Set(
    pidSummaryRows
      .filter((row) => hasAvailableField(row, frontendFields))
      .map((row) => `${row.date}\u001f${row.pid}`),
  );
  const reportedPidSummaryFrontend = new Set<string>();
  for (const row of rows) {
    grouped.set(sourceKey(row), [...(grouped.get(sourceKey(row)) ?? []), row]);
  }
  for (const group of grouped.values()) {
    const template = group[0];
    const systems = new Set(group.filter((row) => systemNames.has(row.operatingSystem)).map((row) => row.operatingSystem));
    const hasMultipleSystems = systems.size >= 2;
    const isMicroOrDou = template.packageName === '微小' || template.packageName === '抖小';
    if (template.isMixedPid) {
      output.push(...buildMixedRows(group, issues, pidSummaryFrontend.has(`${template.date}\u001f${template.pid}`), reportedPidSummaryFrontend));
    } else if (isMicroOrDou && hasMultipleSystems) {
      output.push(...group, buildCrossSystemSummaryRow(group));
    } else {
      output.push(...group.map((row) => ({ ...row, frontEndMetricsAvailable: row.frontEndMetricsAvailable !== false })));
    }
  }
  return { rows: output, issues };
}
