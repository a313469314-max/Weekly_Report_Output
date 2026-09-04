import type { MediaRule, MetricKey, ProjectConfig, RawAdRow, ValidationIssue } from '../shared/contracts';
import { classifyDeliveryType, inferPackageName, inferPidClassification, isMixedPidName } from '../domain/pid';

const unwrapCellValue = (value: unknown): unknown => {
  if (Array.isArray(value) && value.length === 1) return unwrapCellValue(value[0]);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  for (const key of ['value', 'raw', 'label', 'display_name', 'text']) {
    if (key in record) return unwrapCellValue(record[key]);
  }
  return value;
};

interface ParsedNumber {
  value: number;
  available: boolean;
}

const parseNumber = (value: unknown): ParsedNumber => {
  if (typeof value === 'number') return { value: Number.isFinite(value) ? value : 0, available: Number.isFinite(value) };
  const normalized = String(unwrapCellValue(value) ?? '').replace(/,/g, '').trim();
  if (!normalized || normalized === '-') return { value: 0, available: false };
  const parsed = Number(normalized.replace(/%$/u, ''));
  return { value: Number.isFinite(parsed) ? parsed : 0, available: Number.isFinite(parsed) };
};

const asRatio = (value: unknown): number => {
  const raw = text(value);
  const number = parseNumber(value).value;
  if (raw.includes('%')) return number / 100;
  return Math.abs(number) > 1 ? number / 100 : number;
};

const text = (value: unknown): string => String(unwrapCellValue(value) ?? '').trim();

const isTrue = (value: unknown): boolean => {
  if (value === true || value === 1) return true;
  const normalized = text(value).toLowerCase();
  return ['1', 'true', 'yes', '是', '重归因'].includes(normalized);
};

function resolveMedia(raw: string, radid: string, rules: MediaRule[], pidName = ''): string | null {
  const media = text(raw);
  if (media) {
    const normalizedMedia = normalizeFieldName(media);
    const direct = rules.find((rule) => rule.aliases.some((alias) => normalizedMedia === normalizeFieldName(alias)));
    if (direct) return direct.name;
    const contained = rules.find((rule) => rule.aliases.some((alias) => {
      const normalizedAlias = normalizeFieldName(alias);
      return normalizedMedia.includes(normalizedAlias) || normalizedAlias.includes(normalizedMedia);
    }));
    return contained?.name ?? null;
  }
  const normalizedPidName = normalizeFieldName(pidName);
  const fromPidName = rules.find((rule) => rule.aliases.some((alias) => {
    const normalizedAlias = normalizeFieldName(alias);
    return normalizedPidName.includes(normalizedAlias);
  }));
  if (fromPidName) return fromPidName.name;
  const first = radid.split('_')[0];
  return rules.find((rule) => rule.radidPrefixes.some((prefix) => prefix === first))?.name ?? null;
}

export interface BackendColumn {
  display_name?: string;
  name?: string;
}

export type BackendRow = unknown[] | Record<string, unknown>;

export interface StructuredNormalizationOptions {
  allowUnclassified?: boolean;
}

const normalizeFieldName = (value: unknown): string => text(value).replace(/\s+/gu, '').toLowerCase();

function normalizeOperatingSystem(value: unknown): string | null {
  const normalized = text(value).replace(/\s+/gu, '').toUpperCase();
  if (!normalized) return null;
  if (normalized.includes('鸿蒙') || normalized.includes('HARMONY')) return '鸿蒙';
  if (normalized.includes('IOS') || normalized.includes('苹果')) return 'IOS';
  if (normalized.includes('安卓') || normalized.includes('ANDROID') || normalized.includes('APK')) return '安卓';
  return null;
}

export function normalizeStructuredRows(
  rows: BackendRow[],
  columns: BackendColumn[],
  config: ProjectConfig,
  date: string,
  source: RawAdRow['source'] = 'structured',
  includeReattribution = false,
  options: StructuredNormalizationOptions = {},
): { rows: RawAdRow[]; issues: ValidationIssue[] } {
  const names = columns.map((column) => text(column.display_name ?? column.name));
  const index = (aliases: string[]) => names.findIndex((name) => aliases.some((alias) => normalizeFieldName(alias) === normalizeFieldName(name)));
  const at = (row: BackendRow, aliases: string[]) => {
    if (Array.isArray(row)) return row[index(aliases)];
    const wanted = new Set(aliases.map(normalizeFieldName));
    const matched = Object.entries(row).find(([key]) => wanted.has(normalizeFieldName(key)));
    return matched?.[1];
  };
  const issues: ValidationIssue[] = [];
  const output: RawAdRow[] = [];

  for (const row of rows) {
    const mediaRaw = text(at(row, ['媒体', '媒体名称', '媒体平台', 'media']));
    const radid = text(at(row, ['radid', 'RADID']));
    const pid = text(at(row, ['渠道id', '渠道ID', '渠道Pid', '渠道id名称', 'pid', 'channel_id']));
    const reattribution = isTrue(at(row, ['重归因', '是否重归因', '归因类型']));
    const accountName = text(at(row, ['广告账号', '广告账户', 'account_name']));
    const pidName = text(at(row, ['渠道名', '渠道名称', 'pid名称', 'pid_name', 'channel_name'])) || config.pidNames[pid] || '';
    const rowLabel = `${mediaRaw} ${pid} ${pidName} ${radid}`.replace(/\s+/gu, '').trim();
    const totalRow = /^(合计|总计|全部|汇总)$/u.test(mediaRaw) || /^(合计|总计|全部|汇总)$/u.test(pid);
    if (!rowLabel || totalRow || !/^\d+$/u.test(pid) || (/合计|总计|汇总/u.test(rowLabel) && !/^\d+$/u.test(pid))) continue;
    if (config.pidWhitelist.length > 0 && !config.pidWhitelist.includes(pid)) continue;
    if (reattribution && !includeReattribution) continue;
    const classification = inferPidClassification(pidName);
    const media = resolveMedia(mediaRaw, radid, config.mediaRules, pidName);
    const packageName = inferPackageName(pidName) ?? config.pidPackageMap[pid] ?? '';
    const mixedPid = isMixedPidName(pidName, packageName);
    const backendOperatingSystem = normalizeOperatingSystem(at(row, ['操作系统', '系统', 'os', 'operating_system']));
    const fallbackOperatingSystem = classification?.operatingSystem ?? (packageName === 'APK' ? '安卓' : packageName === 'IOS' ? 'IOS' : packageName === '鸿蒙' ? '鸿蒙' : null);
    const os = backendOperatingSystem ?? fallbackOperatingSystem ?? (mixedPid ? '多端合计' : '');
    const bidCode = radid.split('_')[2] ?? '';
    const bidName = config.bidCodeMap[bidCode] ?? (bidCode || '未识别');
    const tapAdnText = `${pidName} ${radid} ${accountName}`.toLowerCase();
    const tapSegment = media === 'TapTap' && config.tapAdnKeywords.some((keyword) => keyword.trim() && tapAdnText.includes(keyword.trim().toLowerCase())) ? 'adn' : 'main';
    if (!media && !options.allowUnclassified) {
      issues.push({ level: 'warning', code: 'unknown_media', message: '发现无法识别的媒体，已忽略对应数据行。' });
      continue;
    }
    if (!packageName && !options.allowUnclassified) {
      issues.push({ level: 'warning', code: 'unknown_package', message: '发现未配置包体映射的 PID，已忽略对应数据行。' });
      continue;
    }
    if (!os && !options.allowUnclassified) {
      issues.push({ level: 'warning', code: 'unknown_os', message: '发现无法识别的操作系统，已忽略对应数据行。' });
      continue;
    }
    if (!bidCode && radid) {
      issues.push({ level: 'warning', code: 'unknown_bid_code', message: '发现历史异常 RADID，无法识别出价方式，已保留原始数据。' });
    } else if (!config.bidCodeMap[bidCode]) {
      issues.push({ level: 'warning', code: 'unknown_bid_code', message: '发现未配置的出价代码，已保留原始代码。' });
    }
    const spend = parseNumber(at(row, ['消耗']));
    const impressions = parseNumber(at(row, ['展示', '展示量']));
    const clicks = parseNumber(at(row, ['点击']));
    const installs = parseNumber(at(row, ['安装数']));
    const activatedDevices = parseNumber(at(row, ['激活设备数']));
    const sameDayPayingDevices = parseNumber(at(row, ['当日付费设备数']));
    const sameDayPayment = parseNumber(at(row, ['当日付费金额']));
    const loginDevices = parseNumber(at(row, ['登录设备数']));
    const registrationDevices = parseNumber(at(row, ['注册设备数']));
    const payingDevices = parseNumber(at(row, ['付费设备数']));
    const payment = parseNumber(at(row, ['付费总金额', '付费金额']));
    const registrationCost = parseNumber(at(row, ['注册成本']));
    const loginCost = parseNumber(at(row, ['登录成本']));
    const roi = parseNumber(at(row, ['roi', 'ROI']));
    const firstDayRoi = parseNumber(at(row, ['首日roi', '首日ROI']));
    const firstDayArppu = parseNumber(at(row, ['首日ARPPU']));
    const arppu = parseNumber(at(row, ['ARPPU']));
    const day2Payment = parseNumber(at(row, ['次日付费金额', '次日付费总金额', '次日收入', 'day2_payment', 'D2付费金额', '2日付费金额']));
    const day3Payment = parseNumber(at(row, ['3日付费金额', '3日付费总金额', '3日收入', 'day3_payment', 'D3付费金额']));
    const day7Payment = parseNumber(at(row, ['7日付费金额', '7日付费总金额', '7日收入', 'day7_payment', 'D7付费金额']));
    const day30Payment = parseNumber(at(row, ['30日付费金额', '30日付费总金额', '30日收入', 'day30_payment', 'D30付费金额']));
    const availableFields: Partial<Record<MetricKey, boolean>> = {
      spend: spend.available,
      impressions: impressions.available,
      clicks: clicks.available,
      installs: installs.available,
      activatedDevices: activatedDevices.available,
      sameDayPayingDevices: sameDayPayingDevices.available,
      sameDayPayment: sameDayPayment.available,
      loginDevices: loginDevices.available,
      registrationDevices: registrationDevices.available,
      payingDevices: payingDevices.available,
      payment: payment.available,
      roi: roi.available,
      firstDayRoi: firstDayRoi.available,
      firstDayArppu: firstDayArppu.available,
      arppu: arppu.available,
      day2Roi: day2Payment.available,
      day3Roi: day3Payment.available,
      day7Roi: day7Payment.available,
      day30Roi: day30Payment.available,
    };
    const negative = spend.value < 0 || sameDayPayment.value < 0 || payment.value < 0;
    if (negative) issues.push({ level: 'warning', code: 'negative_value', message: '发现负数消耗、收入或退款数据，请在数据校验 Sheet查看。' });
    output.push({
      media: media ?? '未识别',
      accountId: text(at(row, ['广告账号id', '广告账号ID'])),
      accountName,
      radid,
      operatingSystem: os,
      pid,
      pidName,
      deliveryType: classifyDeliveryType(pidName, radid),
      packageName: packageName || '未识别',
      bidCode,
      bidName,
      tapSegment,
      spend: spend.value,
      impressions: impressions.value,
      clicks: clicks.value,
      installs: installs.value,
      activatedDevices: activatedDevices.value,
      sameDayPayingDevices: sameDayPayingDevices.value,
      sameDayPayment: sameDayPayment.value,
      loginDevices: loginDevices.value,
      registrationDevices: registrationDevices.value,
      payingDevices: payingDevices.value,
      payment: payment.value,
      registrationCost: registrationCost.value,
      loginCost: loginCost.value,
      roi: asRatio(at(row, ['roi', 'ROI'])),
      firstDayRoi: asRatio(at(row, ['首日roi', '首日ROI'])),
      firstDayArppu: firstDayArppu.value,
      arppu: arppu.value,
      day2Payment: day2Payment.value,
      day3Payment: day3Payment.value,
      day7Payment: day7Payment.value,
      day30Payment: day30Payment.value,
      date: text(at(row, ['日期', '数据日期'])) || date,
      isReattribution: reattribution,
      source,
      isMixedPid: mixedPid,
      frontEndMetricsAvailable: true,
      availableFields,
    });
  }
  const periodMetrics = [
    { label: '次日ROI', ratio: ['次日roi', '次日ROI'], amount: ['次日付费金额', '次日付费总金额', '次日收入', 'day2_payment', 'D2付费金额', '2日付费金额'] },
    { label: '3日ROI', ratio: ['3日roi', '3日ROI'], amount: ['3日付费金额', '3日付费总金额', '3日收入', 'day3_payment', 'D3付费金额'] },
    { label: '7日ROI', ratio: ['7日roi', '7日ROI'], amount: ['7日付费金额', '7日付费总金额', '7日收入', 'day7_payment', 'D7付费金额'] },
    { label: '30日ROI', ratio: ['30日roi', '30日ROI'], amount: ['30日付费金额', '30日付费总金额', '30日收入', 'day30_payment', 'D30付费金额'] },
  ];
  for (const period of periodMetrics) {
    if (index(period.ratio) >= 0 && index(period.amount) < 0) {
      issues.push({ level: 'warning', code: 'unaggregatable_period_roi', message: `后台提供${period.label}比例但未提供可汇总的${period.label.replace('ROI', '付费金额')}，程序不会直接平均该比例。` });
    }
  }
  return { rows: output, issues };
}
