import ExcelJS from 'exceljs';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { AggregateTotals, ProjectConfig, RawAdRow, SheetConfig, ValidationBaseline, ValidationIssue } from '../shared/contracts';
import { metricByKey } from '../shared/metrics';
import { calculateMetric, groupRows, type GroupedRow } from '../engine/aggregation';
import { materializeMixedPidRows } from '../engine/mixed-pid';
import { validateAmountBaselines, validateBackendRatios } from '../engine/validation';

const moneyFormat = '#,##0.00';
const percentFormat = '0.00%';
const numberFormat = '#,##0';
const headerColor = 'FF1F4E78';
const titleColor = 'FFD9EAF7';
const alternateColor = 'FFF7FAFC';
const totalRowColor = 'FFEAF2F8';
const channelOrder = ['APK', 'IOS', '抖小', '微小', '鸿蒙'];
const operatingSystemOrder = ['安卓', 'IOS', '鸿蒙', '多端合计', '混投总计', '双端合计', '安卓（混投拆分）', 'IOS（混投拆分）', '鸿蒙（混投拆分）'];
const overallMediaOrder = ['头条', '广点通', 'TapTap', 'B站', '小红书'];
const mediaPackageSystemOrder = [
  ['APK', '安卓'],
  ['IOS', 'IOS'],
  ['微小', '安卓'],
  ['微小', 'IOS'],
  ['微小', '鸿蒙'],
  ['微小', '多端合计'],
  ['抖小', '安卓'],
  ['抖小', 'IOS'],
  ['抖小', '鸿蒙'],
  ['抖小', '多端合计'],
  ['APP', '鸿蒙'],
] as const;
const mediaPackageSystemRank = new Map(mediaPackageSystemOrder.map(([channel, operatingSystem], index) => [`${channel}\u001f${operatingSystem}`, index]));
const dataBarMetrics = new Set(['activationCost', 'sameDayPayingCost', 'payingCost', 'firstDayRoi', 'roi']);

type Dimension = { key: string; label: string; get: (row: RawAdRow) => string };
type ReportSection = { title: string; rows: RawAdRow[]; dimensions: Dimension[]; compare?: (left: GroupedRow, right: GroupedRow) => number };
type WorkbookOptions = {
  includePitcherDetails?: boolean;
  detailRows?: RawAdRow[];
  pidSummaryRows?: RawAdRow[];
};

function uniqueMetrics(config: SheetConfig): SheetConfig['metricOrder'] {
  const allowed = new Set(metricByKey.keys());
  return [...new Set(config.metricOrder)].filter((key) => allowed.has(key));
}

function metricValue(metric: SheetConfig['metricOrder'][number], totals: AggregateTotals): number | null {
  return calculateMetric(metric, totals);
}

function aggregatedDimensions(): Dimension[] {
  return [];
}

function pitcherCode(row: RawAdRow): string {
  if (!row.radid.trim()) return '后台PID汇总（未提供RADID）';
  return row.radid.split('_')[1]?.trim() || '异常RADID（缺少投手段）';
}

function pitcherName(row: RawAdRow, config: ProjectConfig): string {
  const code = pitcherCode(row);
  return code.startsWith('后台PID汇总') || code.startsWith('异常RADID') ? code : config.pitcherNameMap[code] ?? code;
}

function pitcherSectionTitle(name: string, code: string): string {
  if (name === code && (code.startsWith('后台PID汇总') || code.startsWith('异常RADID'))) return `投手：${name}`;
  return `投手：${name}（${code}）`;
}

function formatMetricCell(cell: ExcelJS.Cell, metricKey: string): void {
  const definition = metricByKey.get(metricKey as never);
  cell.numFmt = definition?.format === 'percent' ? percentFormat : definition?.format === 'number' ? numberFormat : moneyFormat;
  if (cell.value === null || cell.value === undefined) cell.value = '-';
}

function styleHeader(row: ExcelJS.Row): void {
  row.height = 28;
  row.eachCell((cell) => {
    cell.font = { name: '微软雅黑', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: headerColor } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFD0D5DD' } } };
  });
}

function addIncomeTypeBanner(sheet: ExcelJS.Worksheet, config: ProjectConfig): void {
  const row = sheet.addRow([`收入类型：${config.defaultIncomeType === 'amount' ? '收入' : '实收'}`]);
  row.font = { name: '微软雅黑', size: 9, color: { argb: 'FF4B5563' } };
  row.alignment = { vertical: 'middle', horizontal: 'left' };
  row.height = 20;
}

function writeGroupedRows(sheet: ExcelJS.Worksheet, rows: RawAdRow[], sheetConfig: SheetConfig, dateLabel: string, dimensions: Dimension[], isRangeTotal: boolean, compare?: (left: GroupedRow, right: GroupedRow) => number): number {
  const metrics = uniqueMetrics(sheetConfig);
  const groups = groupRows(rows, dimensions.map((dimension) => (row) => [dimension.key, dimension.get(row)] as [string, string]));
  groups.sort(compare ?? ((left, right) => left.key.localeCompare(right.key, 'zh-CN')));
  for (const [index, group] of groups.entries()) {
    const values = dimensions.map((dimension) => group.dimensions[dimension.key] ?? '');
    const output = sheet.addRow([dateLabel, ...values, ...metrics.map((key) => metricValue(key, group.totals))]);
    output.eachCell({ includeEmpty: true }, (cell, column) => {
      if (column > dimensions.length + 1) formatMetricCell(cell, metrics[column - dimensions.length - 2]);
      cell.font = { name: '微软雅黑', size: 10, bold: isRangeTotal };
      cell.alignment = { vertical: 'middle', horizontal: column > dimensions.length + 1 ? 'right' : 'left' };
    });
    if (isRangeTotal) output.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: totalRowColor } }; });
    else if (index % 2 === 1) output.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: alternateColor } }; });
  }
  return groups.length;
}

function addDataBars(sheet: ExcelJS.Worksheet, firstMetricColumn: number, firstDataRow: number, lastRow: number, metrics: SheetConfig['metricOrder'], priorityStart: number): number {
  if (lastRow < firstDataRow || metrics.length === 0) return priorityStart;
  let priority = priorityStart;
  for (let index = 0; index < metrics.length; index += 1) {
    if (!dataBarMetrics.has(metrics[index])) continue;
    const column = firstMetricColumn + index;
    const letter = sheet.getColumn(column).letter;
    const rule: ExcelJS.DataBarRuleType & { color: { argb: string } } = {
      type: 'dataBar',
      priority,
      gradient: true,
      color: { argb: 'FF5B9BD5' },
      cfvo: [{ type: 'min' }, { type: 'max' }],
    };
    sheet.addConditionalFormatting({
      ref: `${letter}${firstDataRow}:${letter}${lastRow}`,
      rules: [rule],
    });
    priority += 1;
  }
  return priority;
}

function sortedGroups(rows: RawAdRow[], getKey: (row: RawAdRow) => string, compare: (left: string, right: string) => number): Array<[string, RawAdRow[]]> {
  const groups = new Map<string, RawAdRow[]>();
  for (const row of rows) groups.set(getKey(row), [...(groups.get(getKey(row)) ?? []), row]);
  return [...groups.entries()].sort(([left], [right]) => compare(left, right));
}

function compareByOrder(order: string[]): (left: string, right: string) => number {
  return (left, right) => {
    const leftIndex = order.indexOf(left);
    const rightIndex = order.indexOf(right);
    if (leftIndex !== rightIndex) return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
    return left.localeCompare(right, 'zh-CN');
  };
}

const pitcherMediaOrder = [...overallMediaOrder, '快手', '百度'];
const pitcherBidOrder = ['激活', '首次付费', '每次付费', '7R', '智投7R'];
const pidFrontendFields = ['spend', 'impressions', 'clicks', 'installs'] as const;

function pidFieldAvailable(row: RawAdRow, field: typeof pidFrontendFields[number]): boolean {
  return row.availableFields?.[field] !== false && !row.notApplicableFields?.[field];
}

function pidDateKey(row: Pick<RawAdRow, 'date' | 'pid'>): string {
  return `${row.date}\u001f${row.pid}`;
}

function enrichPidSummaryRows(summaryRows: RawAdRow[], detailRows: RawAdRow[]): RawAdRow[] {
  const detailByPidDate = new Map<string, RawAdRow[]>();
  for (const row of detailRows) {
    if (!row.radid.trim()) continue;
    const key = pidDateKey(row);
    detailByPidDate.set(key, [...(detailByPidDate.get(key) ?? []), row]);
  }
  return summaryRows.map((summary) => {
    const details = detailByPidDate.get(pidDateKey(summary)) ?? [];
    if (details.length === 0) return summary;
    const availableFields = { ...(summary.availableFields ?? {}) };
    const next = { ...summary, availableFields };
    for (const field of pidFrontendFields) {
      if (pidFieldAvailable(summary, field)) continue;
      const sources = details.filter((row) => pidFieldAvailable(row, field));
      if (sources.length === 0) continue;
      next[field] = sources.reduce((total, row) => total + Number(row[field] ?? 0), 0);
      availableFields[field] = true;
    }
    if (pidFrontendFields.some((field) => pidFieldAvailable(next, field))) next.frontEndMetricsAvailable = true;
    return next;
  });
}

function comparePitcherMediaNames(leftMedia: string, rightMedia: string): number {
  const leftRank = pitcherMediaOrder.indexOf(leftMedia);
  const rightRank = pitcherMediaOrder.indexOf(rightMedia);
  const normalizedLeftRank = leftRank === -1 ? pitcherMediaOrder.length : leftRank;
  const normalizedRightRank = rightRank === -1 ? pitcherMediaOrder.length : rightRank;
  if (normalizedLeftRank !== normalizedRightRank) return normalizedLeftRank - normalizedRightRank;
  return leftMedia.localeCompare(rightMedia, 'zh-CN');
}

function comparePitcherMedia(left: GroupedRow, right: GroupedRow): number {
  return comparePitcherMediaNames(left.dimensions.media ?? '', right.dimensions.media ?? '');
}

function comparePitcherDetail(left: GroupedRow, right: GroupedRow): number {
  const mediaComparison = comparePitcherMedia(left, right);
  if (mediaComparison !== 0) return mediaComparison;
  const packageComparison = compareByOrder(channelOrder)(left.dimensions.packageName ?? '', right.dimensions.packageName ?? '');
  if (packageComparison !== 0) return packageComparison;
  const operatingSystemComparison = compareByOrder(operatingSystemOrder)(left.dimensions.operatingSystem ?? '', right.dimensions.operatingSystem ?? '');
  if (operatingSystemComparison !== 0) return operatingSystemComparison;
  const bidComparison = compareByOrder(pitcherBidOrder)(left.dimensions.bidName ?? '', right.dimensions.bidName ?? '');
  if (bidComparison !== 0) return bidComparison;
  return left.key.localeCompare(right.key, 'zh-CN');
}

function mediaPackageSystemCombinationRank(channel: string, operatingSystem: string): number {
  // Keep the current data labels while treating their equivalent summary labels as one slot.
  const normalizedChannel = channel === '鸿蒙' ? 'APP' : channel;
  const normalizedOperatingSystem = operatingSystem
    .replace(/（混投拆分）$/u, '')
    .replace(/^(?:双端|混投)总计$/u, '多端合计');
  return mediaPackageSystemRank.get(`${normalizedChannel}\u001f${normalizedOperatingSystem}`) ?? mediaPackageSystemOrder.length;
}

function buildSections(rows: RawAdRow[], sheetConfig: SheetConfig, segmentLabel?: string): ReportSection[] {
  const dimensions = aggregatedDimensions();
  const categoryKey = (row: RawAdRow) => [row.packageName, row.operatingSystem, ...(sheetConfig.kind === 'bid' ? [row.bidName] : [])].join('\u001f');
  const compareCategories = (left: string, right: string) => {
    const leftParts = left.split('\u001f');
    const rightParts = right.split('\u001f');
    const channelComparison = compareByOrder(channelOrder)(leftParts[0], rightParts[0]);
    if (channelComparison !== 0) return channelComparison;
    const operatingSystemComparison = compareByOrder(operatingSystemOrder)(leftParts[1], rightParts[1]);
    if (operatingSystemComparison !== 0) return operatingSystemComparison;
    return (leftParts[2] ?? '').localeCompare(rightParts[2] ?? '', 'zh-CN');
  };
  return sortedGroups(rows, categoryKey, compareCategories).map(([key, groupedRows]) => {
    const [channel, operatingSystem, bidName] = key.split('\u001f');
    const titleParts = [segmentLabel ?? sheetConfig.media ?? sheetConfig.name, channel, operatingSystem];
    if (sheetConfig.kind === 'bid') titleParts.push(bidName);
    return {
      title: titleParts.filter(Boolean).join(' · '),
      rows: groupedRows,
      dimensions,
    };
  });
}

function applyColumnWidths(sheet: ExcelJS.Worksheet, dimensions: Dimension[], metrics: SheetConfig['metricOrder']): void {
  sheet.getColumn(1).width = 16;
  dimensions.forEach((dimension, index) => {
    sheet.getColumn(index + 2).width = dimension.key === 'pidName' ? 30 : dimension.key === 'pid' ? 14 : dimension.key === 'pitcherName' ? 18 : 12;
  });
  metrics.forEach((metric, index) => {
    const label = metricByKey.get(metric)?.label ?? metric;
    sheet.getColumn(dimensions.length + 2 + index).width = Math.min(20, Math.max(12, label.length * 2 + 2));
  });
}

function writePeriodSummaryRows(sheet: ExcelJS.Worksheet, rows: RawAdRow[], sheetConfig: SheetConfig, dimensions: Dimension[], compare?: (left: GroupedRow, right: GroupedRow) => number, separateWhen?: (previous: GroupedRow, current: GroupedRow) => boolean): number {
  const metrics = uniqueMetrics(sheetConfig);
  const groups = groupRows(rows, dimensions.map((dimension) => (row) => [dimension.key, dimension.get(row)] as [string, string]));
  groups.sort(compare ?? ((left, right) => left.key.localeCompare(right.key, 'zh-CN')));
  for (const [index, group] of groups.entries()) {
    if (index > 0 && separateWhen?.(groups[index - 1], group)) sheet.addRow([]);
    const values = dimensions.map((dimension) => group.dimensions[dimension.key] ?? '');
    const output = sheet.addRow([...values, ...metrics.map((key) => metricValue(key, group.totals))]);
    output.eachCell({ includeEmpty: true }, (cell, column) => {
      if (column > dimensions.length) formatMetricCell(cell, metrics[column - dimensions.length - 1]);
      cell.font = { name: '微软雅黑', size: 10 };
      cell.alignment = { vertical: 'middle', horizontal: column > dimensions.length ? 'right' : 'left' };
    });
    if (index % 2 === 1) output.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: alternateColor } }; });
  }
  return groups.length;
}

function addPeriodSummaryTable(sheet: ExcelJS.Worksheet, title: string, rows: RawAdRow[], sheetConfig: SheetConfig, dimensions: Dimension[], priorityStart: number, compare?: (left: GroupedRow, right: GroupedRow) => number, separateWhen?: (previous: GroupedRow, current: GroupedRow) => boolean): number {
  const metrics = uniqueMetrics(sheetConfig);
  const headers = [...dimensions.map((dimension) => dimension.label), ...metrics.map((key) => metricByKey.get(key)?.label ?? key)];
  const titleRow = sheet.addRow([title]);
  sheet.mergeCells(titleRow.number, 1, titleRow.number, headers.length);
  titleRow.font = { name: '微软雅黑', bold: true, size: 12, color: { argb: 'FF1F2937' } };
  titleRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: titleColor } };
  titleRow.alignment = { vertical: 'middle', horizontal: 'left' };
  titleRow.height = 26;
  const headerRow = sheet.addRow(headers);
  styleHeader(headerRow);
  const firstDataRow = headerRow.number + 1;
  writePeriodSummaryRows(sheet, rows, sheetConfig, dimensions, compare, separateWhen);
  const lastRow = sheet.lastRow?.number ?? headerRow.number;
  return addDataBars(sheet, dimensions.length + 1, firstDataRow, lastRow, metrics, priorityStart);
}

function addOverallSummaryReport(sheet: ExcelJS.Worksheet, rows: RawAdRow[], pidSummaryRows: RawAdRow[], sheetConfig: SheetConfig): void {
  const summaryRows = rows.filter((row) => !row.isMixedSystemBreakdown && !row.isCrossSystemSummary);
  const overallRows = summaryRows.length > 0 ? summaryRows : pidSummaryRows;
  const overallDimensions: Dimension[] = [{ key: 'overall', label: '汇总范围', get: () => '全部PID' }];
  const pidDimensions: Dimension[] = [
    { key: 'pid', label: '渠道ID', get: (row) => row.pid },
    { key: 'pidName', label: '渠道名称', get: (row) => row.pidName },
  ];
  const mediaDimensions: Dimension[] = [{ key: 'media', label: '媒体', get: (row) => row.media }];
  const mediaPackageSystemDimensions: Dimension[] = [{
    key: 'mediaPackageSystem',
    label: '媒体-渠道-系统',
    get: (row) => `${row.media} · ${row.packageName} · ${row.operatingSystem}`,
  }];
  const mediaPackageSystemCompare = (left: GroupedRow, right: GroupedRow): number => {
    const leftLabel = left.dimensions.mediaPackageSystem ?? '';
    const rightLabel = right.dimensions.mediaPackageSystem ?? '';
    const [leftMedia = '', leftChannel = '', leftOperatingSystem = ''] = leftLabel.split(' · ');
    const [rightMedia = '', rightChannel = '', rightOperatingSystem = ''] = rightLabel.split(' · ');
    const leftRank = overallMediaOrder.indexOf(leftMedia);
    const rightRank = overallMediaOrder.indexOf(rightMedia);
    const normalizedLeftRank = leftRank === -1 ? overallMediaOrder.length : leftRank;
    const normalizedRightRank = rightRank === -1 ? overallMediaOrder.length : rightRank;
    if (normalizedLeftRank !== normalizedRightRank) return normalizedLeftRank - normalizedRightRank;
    const leftCombinationRank = mediaPackageSystemCombinationRank(leftChannel, leftOperatingSystem);
    const rightCombinationRank = mediaPackageSystemCombinationRank(rightChannel, rightOperatingSystem);
    if (leftCombinationRank !== rightCombinationRank) return leftCombinationRank - rightCombinationRank;
    return leftLabel.localeCompare(rightLabel, 'zh-CN');
  };
  let priority = addPeriodSummaryTable(sheet, summaryRows.length > 0 ? '总体汇总（RADID明细层）' : '总体汇总（PID汇总层）', overallRows, sheetConfig, overallDimensions, 1);
  sheet.addRow([]);
  priority = addPeriodSummaryTable(sheet, summaryRows.length > 0 ? '分PID数据汇总（RADID明细层）' : '分PID数据汇总（PID汇总层）', overallRows, sheetConfig, pidDimensions, priority);
  sheet.addRow([]);
  if (pidSummaryRows.length > 0) {
    priority = addPeriodSummaryTable(sheet, 'PID汇总未分配（不参与媒体、系统、出价或投手分类）', pidSummaryRows, sheetConfig, pidDimensions, priority);
    sheet.addRow([]);
  }
  priority = addPeriodSummaryTable(sheet, '媒体数据汇总（RADID明细层）', summaryRows, sheetConfig, mediaDimensions, priority);
  sheet.addRow([]);
  addPeriodSummaryTable(sheet, '媒体-渠道-系统汇总（RADID明细层）', rows, sheetConfig, mediaPackageSystemDimensions, priority, mediaPackageSystemCompare, (previous, current) => {
    const previousMedia = previous.dimensions.mediaPackageSystem?.split(' · ')[0] ?? '';
    const currentMedia = current.dimensions.mediaPackageSystem?.split(' · ')[0] ?? '';
    return previousMedia !== currentMedia;
  });
  applyColumnWidths(sheet, [{ key: 'mediaPackageSystem', label: '媒体-渠道-系统', get: () => '' }], uniqueMetrics(sheetConfig));
  sheet.getColumn(1).width = 30;
}

function addReportSection(sheet: ExcelJS.Worksheet, section: ReportSection, sheetConfig: SheetConfig, priorityStart: number): number {
  const metrics = uniqueMetrics(sheetConfig);
  const { dimensions } = section;
  const headers = ['日期', ...dimensions.map((dimension) => dimension.label), ...metrics.map((key) => metricByKey.get(key)?.label ?? key)];
  const titleRow = sheet.addRow([section.title]);
  sheet.mergeCells(titleRow.number, 1, titleRow.number, headers.length);
  titleRow.font = { name: '微软雅黑', bold: true, size: 12, color: { argb: 'FF1F2937' } };
  titleRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: titleColor } };
  titleRow.alignment = { vertical: 'middle', horizontal: 'left' };
  titleRow.height = 26;
  const headerRow = sheet.addRow(headers);
  styleHeader(headerRow);
  const firstDataRow = headerRow.number + 1;
  writeGroupedRows(sheet, section.rows, sheetConfig, '日期范围合计', dimensions, true, section.compare);
  if (sheetConfig.showDaily) {
    const dates = [...new Set(section.rows.map((row) => row.date))].sort();
    for (const date of dates) writeGroupedRows(sheet, section.rows.filter((row) => row.date === date), sheetConfig, date, dimensions, false, section.compare);
  }
  const lastRow = sheet.lastRow?.number ?? 2;
  return addDataBars(sheet, dimensions.length + 2, firstDataRow, lastRow, metrics, priorityStart);
}

function summaryTitle(sheetConfig: SheetConfig, segmentLabel?: string): string {
  if (segmentLabel) return `${segmentLabel}数据汇总`;
  if (sheetConfig.kind === 'bid') return `${sheetConfig.media ?? sheetConfig.name}出价方式汇总`;
  return `${sheetConfig.media ?? sheetConfig.name}数据汇总`;
}

function addCategorizedReport(sheet: ExcelJS.Worksheet, rows: RawAdRow[], sheetConfig: SheetConfig, segmentLabel?: string): void {
  const sections = buildSections(rows, sheetConfig, segmentLabel);
  if (sections.length === 0 && segmentLabel) sections.push({ title: segmentLabel, rows: [], dimensions: aggregatedDimensions() });
  let priority = 1;
  sections.forEach((section, index) => {
    if (index > 0) sheet.addRow([]);
    priority = addReportSection(sheet, section, sheetConfig, priority);
  });
  const summaryRows = rows.filter((row) => !row.isMixedSystemBreakdown);
  if (summaryRows.length > 0) {
    if (sections.length > 0) sheet.addRow([]);
    priority = addReportSection(sheet, {
      title: summaryTitle(sheetConfig, segmentLabel),
      rows: summaryRows,
      dimensions: aggregatedDimensions(),
    }, sheetConfig, priority);
  }
  const dimensions = sections[0]?.dimensions ?? aggregatedDimensions();
  applyColumnWidths(sheet, dimensions, uniqueMetrics(sheetConfig));
}

function addPitcherReport(sheet: ExcelJS.Worksheet, detailRows: RawAdRow[], sheetConfig: SheetConfig, config: ProjectConfig): void {
  const pitcherRows = detailRows.filter((row) => row.media !== 'apple_cn' && Boolean(row.radid.trim()));
  const pitcherGroups = sortedGroups(
    pitcherRows,
    (row) => `${pitcherName(row, config)}\u001f${pitcherCode(row)}`,
    (left, right) => left.localeCompare(right, 'zh-CN'),
  );
  const mediaSummaryDimensions: Dimension[] = [{ key: 'media', label: '媒体', get: (row) => row.media }];
  const detailDimensions: Dimension[] = [
    { key: 'media', label: '媒体', get: (row) => row.media },
    { key: 'packageName', label: '渠道', get: (row) => row.packageName },
    { key: 'operatingSystem', label: '操作系统', get: (row) => row.operatingSystem },
    { key: 'bidName', label: '出价方式', get: (row) => row.bidName },
  ];
  let priority = 1;
  const reportTitle = sheet.addRow(['分投手明细（投手 → 媒体 → 渠道 → 系统 → 出价方式）']);
  sheet.mergeCells(reportTitle.number, 1, reportTitle.number, detailDimensions.length + uniqueMetrics(sheetConfig).length + 1);
  reportTitle.font = { name: '微软雅黑', bold: true, size: 12, color: { argb: 'FF1F2937' } };
  reportTitle.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: titleColor } };
  reportTitle.alignment = { vertical: 'middle', horizontal: 'left' };
  reportTitle.height = 26;
  for (const [pitcherIndex, [pitcherKey, rows]] of pitcherGroups.entries()) {
    if (pitcherIndex > 0) sheet.addRow([]);
    const [pitcherDisplayName, pitcherDisplayCode] = pitcherKey.split('\u001f');
    const pitcherTitle = sheet.addRow([pitcherSectionTitle(pitcherDisplayName, pitcherDisplayCode)]);
    sheet.mergeCells(pitcherTitle.number, 1, pitcherTitle.number, detailDimensions.length + uniqueMetrics(sheetConfig).length + 1);
    pitcherTitle.font = { name: '微软雅黑', bold: true, size: 11, color: { argb: 'FF1F2937' } };
    pitcherTitle.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF2F8' } };
    pitcherTitle.alignment = { vertical: 'middle', horizontal: 'left' };
    pitcherTitle.height = 24;
    const mediaGroups = sortedGroups(rows, (row) => row.media, comparePitcherMediaNames);
    for (const [mediaIndex, [media, mediaRows]] of mediaGroups.entries()) {
      if (mediaIndex > 0) sheet.addRow([]);
      const mediaSummaryRows = mediaRows.filter((row) => !row.isMixedSystemBreakdown);
      priority = addReportSection(sheet, {
        title: `${pitcherDisplayName} · ${media}汇总`,
        rows: mediaSummaryRows,
        dimensions: mediaSummaryDimensions,
        compare: comparePitcherMedia,
      }, sheetConfig, priority);
      sheet.addRow([]);
      priority = addReportSection(sheet, {
        title: `${pitcherDisplayName} · ${media}明细`,
        rows: mediaRows,
        dimensions: detailDimensions,
        compare: comparePitcherDetail,
      }, sheetConfig, priority);
    }
  }
  applyColumnWidths(sheet, detailDimensions, uniqueMetrics(sheetConfig));
}

type SourceColumn = {
  header: string;
  width: number;
  value: (row: RawAdRow, config: ProjectConfig) => string | number;
  format?: 'number' | 'currency' | 'percent';
};

function sourceMetric(row: RawAdRow, metric: keyof RawAdRow, availability?: keyof NonNullable<RawAdRow['availableFields']>): string | number {
  if (availability && row.notApplicableFields?.[availability]) return '-';
  if (availability && row.availableFields?.[availability] === false) return '';
  const value = row[metric];
  return typeof value === 'number' ? value : '';
}

const sourceColumns: SourceColumn[] = [
  { header: '数据层级', width: 16, value: () => '' },
  { header: '投手归属说明', width: 36, value: () => '' },
  { header: '日期', width: 14, value: (row) => row.date },
  { header: '媒体', width: 14, value: (row) => row.media },
  { header: '投手', width: 18, value: pitcherName },
  { header: '投手代码', width: 14, value: (row) => pitcherCode(row) },
  { header: '渠道ID', width: 14, value: (row) => row.pid },
  { header: '渠道名称', width: 30, value: (row) => row.pidName },
  { header: '渠道', width: 12, value: (row) => row.packageName },
  { header: '操作系统', width: 16, value: (row) => row.operatingSystem },
  { header: '广告账号ID', width: 18, value: (row) => row.accountId },
  { header: '广告账号', width: 24, value: (row) => row.accountName },
  { header: 'RADID', width: 36, value: (row) => row.radid },
  { header: '出价代码', width: 14, value: (row) => row.bidCode },
  { header: '出价方式', width: 16, value: (row) => row.bidName },
  { header: 'TAP分组', width: 16, value: (row) => row.tapSegment === 'adn' ? 'TAP ADN/联盟' : 'TAP主站' },
  { header: '重归因', width: 10, value: (row) => row.isReattribution ? '是' : '否' },
  { header: '消耗', width: 14, value: (row) => sourceMetric(row, 'spend', 'spend'), format: 'currency' },
  { header: '展示', width: 12, value: (row) => sourceMetric(row, 'impressions', 'impressions'), format: 'number' },
  { header: '点击', width: 12, value: (row) => sourceMetric(row, 'clicks', 'clicks'), format: 'number' },
  { header: '安装数', width: 12, value: (row) => sourceMetric(row, 'installs', 'installs'), format: 'number' },
  { header: '激活设备数', width: 14, value: (row) => sourceMetric(row, 'activatedDevices', 'activatedDevices'), format: 'number' },
  { header: '登录设备数', width: 14, value: (row) => sourceMetric(row, 'loginDevices', 'loginDevices'), format: 'number' },
  { header: '注册设备数', width: 14, value: (row) => sourceMetric(row, 'registrationDevices', 'registrationDevices'), format: 'number' },
  { header: '当日付费设备数', width: 16, value: (row) => sourceMetric(row, 'sameDayPayingDevices', 'sameDayPayingDevices'), format: 'number' },
  { header: '当日付费金额', width: 16, value: (row) => sourceMetric(row, 'sameDayPayment', 'sameDayPayment'), format: 'currency' },
  { header: '付费设备数', width: 14, value: (row) => sourceMetric(row, 'payingDevices', 'payingDevices'), format: 'number' },
  { header: '付费金额', width: 14, value: (row) => sourceMetric(row, 'payment', 'payment'), format: 'currency' },
  { header: '次日付费金额', width: 16, value: (row) => sourceMetric(row, 'day2Payment', 'day2Roi'), format: 'currency' },
  { header: '3日付费金额', width: 16, value: (row) => sourceMetric(row, 'day3Payment', 'day3Roi'), format: 'currency' },
  { header: '7日付费金额', width: 16, value: (row) => sourceMetric(row, 'day7Payment', 'day7Roi'), format: 'currency' },
  { header: '30日付费金额', width: 16, value: (row) => sourceMetric(row, 'day30Payment', 'day30Roi'), format: 'currency' },
  { header: '后台首日ROI', width: 14, value: (row) => sourceMetric(row, 'firstDayRoi', 'firstDayRoi'), format: 'percent' },
  { header: '后台ROI', width: 14, value: (row) => sourceMetric(row, 'roi', 'roi'), format: 'percent' },
  { header: '后台首日ARPPU', width: 16, value: (row) => sourceMetric(row, 'firstDayArppu', 'firstDayArppu'), format: 'currency' },
  { header: '后台ARPPU', width: 14, value: (row) => sourceMetric(row, 'arppu', 'arppu'), format: 'currency' },
];

function addSourceDataSheet(sheet: ExcelJS.Worksheet, detailRows: RawAdRow[], pidSummaryRows: RawAdRow[], config: ProjectConfig): void {
  addIncomeTypeBanner(sheet, config);
  const title = sheet.addRow(['源数据（本次纳入报表计算的后台明细）']);
  sheet.mergeCells(title.number, 1, title.number, sourceColumns.length);
  title.font = { name: '微软雅黑', bold: true, size: 12, color: { argb: 'FF1F2937' } };
  title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: titleColor } };
  title.alignment = { vertical: 'middle', horizontal: 'left' };
  title.height = 26;
  const header = sheet.addRow(sourceColumns.map((column) => column.header));
  styleHeader(header);
  const sourceRows = [
    ...detailRows.map((row) => ({ row, layer: 'RADID明细', attribution: row.radid.trim() ? '可按 RADID 第二段归属到投手' : 'RADID 缺失，无法归属投手' })),
    ...pidSummaryRows.map((row) => ({ row, layer: 'PID汇总', attribution: '后台仅返回到 PID 层级，未提供 RADID；未计入任何投手' })),
  ];
  for (const [index, sourceRow] of sourceRows.entries()) {
    const output = sheet.addRow(sourceColumns.map((column, columnIndex) => columnIndex === 0 ? sourceRow.layer : columnIndex === 1 ? sourceRow.attribution : column.value(sourceRow.row, config)));
    output.eachCell({ includeEmpty: true }, (cell, columnIndex) => {
      const column = sourceColumns[columnIndex - 1];
      if (column?.format === 'number') cell.numFmt = numberFormat;
      if (column?.format === 'currency') cell.numFmt = moneyFormat;
      if (column?.format === 'percent') cell.numFmt = percentFormat;
      cell.font = { name: '微软雅黑', size: 10 };
      cell.alignment = { vertical: 'middle', horizontal: column?.format ? 'right' : 'left' };
    });
    if (index % 2 === 1) output.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: alternateColor } }; });
  }
  sheet.columns = sourceColumns.map((column) => ({ width: column.width }));
}

function addValidationSheet(sheet: ExcelJS.Worksheet, detailRows: RawAdRow[], pidSummaryRows: RawAdRow[], baselineRows: RawAdRow[], sourceRowCount: number, config: ProjectConfig, issues: ValidationIssue[], baselines: ValidationBaseline[]): void {
  sheet.addRow(['数据校验']);
  sheet.mergeCells(1, 1, 1, 4);
  sheet.getRow(1).font = { bold: true, size: 12 };
  const header = sheet.addRow(['级别', '检查项', '数量', '说明']);
  styleHeader(header);
  const summarized = new Map<string, ValidationIssue>();
  for (const issue of issues) {
    const key = `${issue.level}|${issue.code}|${issue.message}`;
    const previous = summarized.get(key);
    summarized.set(key, previous ? { ...previous, count: (previous.count ?? 1) + (issue.count ?? 1) } : { ...issue });
  }
  for (const issue of [
    ...validateBackendRatios(detailRows, config),
    ...validateAmountBaselines(baselineRows, baselines, config),
  ]) {
    const key = `${issue.level}|${issue.code}|${issue.message}`;
    const previous = summarized.get(key);
    summarized.set(key, previous ? { ...previous, count: (previous.count ?? 1) + (issue.count ?? 1) } : { ...issue });
  }
  const rowsToWrite = [
    ['提示', '读取行数', sourceRowCount, '后台读取并通过基础筛选的明细行'],
    ...[...summarized.values()].map((issue) => [issue.level === 'error' ? '错误' : '警告', issue.code, issue.count ?? 1, issue.message]),
  ];
  for (const values of rowsToWrite) sheet.addRow(values);
  sheet.columns = [{ width: 12 }, { width: 26 }, { width: 12 }, { width: 72 }];
}

function hasSpend(rows: RawAdRow[]): boolean {
  return rows.some((row) => row.spend !== 0);
}

export async function writeWorkbook(rows: RawAdRow[], config: ProjectConfig, outputPath: string, onProgress?: (value: number) => void, issues: ValidationIssue[] = [], baselines: ValidationBaseline[] = [], options: WorkbookOptions = {}): Promise<void> {
  const detailRows = options.detailRows ?? rows.filter((row) => Boolean(row.radid.trim()));
  const pidSummaryRows = options.pidSummaryRows ?? rows.filter((row) => !row.radid.trim());
  const enrichedPidSummaryRows = enrichPidSummaryRows(pidSummaryRows, detailRows);
  const detailPidDates = new Set(detailRows.filter((row) => Boolean(row.radid.trim())).map(pidDateKey));
  const reportPidSummaryRows = enrichedPidSummaryRows.filter((row) => !detailPidDates.has(pidDateKey(row)));
  const mixed = materializeMixedPidRows(detailRows, enrichedPidSummaryRows);
  const reportRows = mixed.rows;
  const detailOverallRows = reportRows.filter((row) => !row.isMixedSystemBreakdown && !row.isCrossSystemSummary);
  const overallRows = detailOverallRows.length > 0 ? detailOverallRows : reportPidSummaryRows;
  const categoryRows = reportRows.filter((row) => !row.isCrossSystemSummary);
  const reportIssues = [...issues, ...mixed.issues];
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '后台数据报表生成器';
  workbook.created = new Date();
  const reportSheets = config.sheetConfigs.filter((sheetConfig) => {
    if (sheetConfig.kind === 'overall' || sheetConfig.kind === 'validation') return true;
    if (sheetConfig.kind === 'pitcher') return options.includePitcherDetails === true;
    const scoped = sheetConfig.media ? categoryRows.filter((row) => row.media === sheetConfig.media) : categoryRows;
    return hasSpend(scoped);
  });
  const sheets = reportSheets.length > 0 ? reportSheets : config.sheetConfigs.filter((item) => item.kind === 'validation');
  sheets.forEach((sheetConfig, index) => {
    const sheet = workbook.addWorksheet(sheetConfig.name);
    addIncomeTypeBanner(sheet, config);
    if (sheetConfig.kind === 'validation') {
      addValidationSheet(sheet, detailRows, reportPidSummaryRows, overallRows, detailRows.length + pidSummaryRows.length, config, reportIssues, baselines);
    } else if (sheetConfig.kind === 'overall') {
      addOverallSummaryReport(sheet, reportRows, reportPidSummaryRows, sheetConfig);
    } else if (sheetConfig.kind === 'pitcher') {
      addPitcherReport(sheet, categoryRows, sheetConfig, config);
    } else if (sheetConfig.media === 'TapTap') {
      const scoped = categoryRows.filter((row) => row.media === 'TapTap');
      addCategorizedReport(sheet, scoped.filter((row) => row.tapSegment === 'main'), sheetConfig, 'TAP主站');
      sheet.addRow([]);
      addCategorizedReport(sheet, scoped.filter((row) => row.tapSegment === 'adn'), sheetConfig, 'TAP ADN/联盟');
    } else {
      const scoped = categoryRows.filter((row) => !sheetConfig.media || row.media === sheetConfig.media);
      addCategorizedReport(sheet, scoped, sheetConfig);
    }
    onProgress?.((index + 1) / (sheets.length + 1));
  });
  const sourceSheet = workbook.addWorksheet('源数据');
  addSourceDataSheet(sourceSheet, detailRows, pidSummaryRows, config);
  onProgress?.(1);
  await fs.mkdir(dirname(outputPath), { recursive: true });
  await workbook.xlsx.writeFile(outputPath);
}
