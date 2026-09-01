import type { DeliveryType, PidDirectoryEntry, ProjectConfig, ValidationIssue } from '../shared/contracts';
import { PACKAGE_OPTIONS } from '../shared/defaults';

export type PackageName = typeof PACKAGE_OPTIONS[number];
export type OperatingSystemName = '安卓' | 'IOS' | '鸿蒙';

export interface PidClassification {
  channel: PackageName;
  operatingSystem: OperatingSystemName;
}

export function inferPackageName(pidName: string): PackageName | null {
  const normalized = pidName.trim().toUpperCase();
  if (normalized.includes('抖小')) return '抖小';
  if (normalized.includes('微小')) return '微小';
  if (normalized.includes('鸿蒙')) return '鸿蒙';
  if (normalized.includes('IOS')) return 'IOS';
  if (normalized.includes('APK') || normalized.includes('安卓')) return 'APK';
  return null;
}

export function inferPidClassification(pidName: string): PidClassification | null {
  const normalized = pidName.trim().toUpperCase();
  const channel = inferPackageName(pidName);
  if (!channel) return null;
  if (channel === '抖小' || channel === '微小') {
    if (normalized.includes('IOS')) return { channel, operatingSystem: 'IOS' };
    if (normalized.includes('安卓') || normalized.includes('APK')) return { channel, operatingSystem: '安卓' };
    return null;
  }
  if (channel === '鸿蒙') return { channel, operatingSystem: '鸿蒙' };
  if (channel === 'IOS') return { channel, operatingSystem: 'IOS' };
  return { channel, operatingSystem: '安卓' };
}

export function isMixedPidName(pidName: string, knownChannel?: string | null): boolean {
  const channel = knownChannel ?? inferPackageName(pidName);
  if (channel !== '微小' && channel !== '抖小') return false;
  const normalized = pidName.trim().toUpperCase();
  return /混端(?:投放)?|混投/u.test(normalized);
}

export function classifyDeliveryType(pidName: string, radid = ''): DeliveryType {
  const normalizedName = pidName.replace(/\s+/gu, '');
  if (/自然量|自然流|自然/u.test(normalizedName)) return '自然量';
  const values = [pidName, radid].map((value) => value.trim()).filter(Boolean);
  const live = values.some((value) => value.includes('直播') || /(?:^|_)zb(?:_|$)/u.test(value));
  if (live) return '直播';
  return values.length > 0 ? '信息流' : '未识别';
}

export interface PidValidationResult {
  accepted: string[];
  entries: Array<PidDirectoryEntry & { status: 'ok' | 'duplicate' | 'invalid' | 'unknown'; deliveryType: DeliveryType; packageName: string | null; operatingSystem: string | null }>;
  issues: ValidationIssue[];
}

export function parsePidInput(input: string): string[] {
  return input
    .split(/[\s,，]+/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function removePidFromInput(input: string, pid: string): string {
  return parsePidInput(input).filter((value) => value !== pid).join(', ');
}

export interface RealtimePidValidationResult {
  accepted: string[];
  pidNames: Record<string, string>;
  issues: ValidationIssue[];
}

export function validateRealtimePids(gameId: string, input: string, directory: PidDirectoryEntry[]): RealtimePidValidationResult {
  const values = parsePidInput(input);
  const known = new Map(directory.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const accepted: string[] = [];
  const pidNames: Record<string, string> = {};
  const issues: ValidationIssue[] = [];
  for (const value of values) {
    const duplicate = seen.has(value);
    seen.add(value);
    const entry = known.get(value);
    const belongs = /^\d+$/u.test(value) && value.slice(0, 4) === gameId;
    if (duplicate) issues.push({ level: 'error', code: 'duplicate_pid', message: '存在重复 PID，请删除重复项。' });
    else if (!belongs) issues.push({ level: 'error', code: 'invalid_pid', message: 'PID必须为数字，且前四位必须等于当前 gameid。' });
    else if (!entry) issues.push({ level: 'error', code: 'unknown_pid', message: '后台未找到该 PID，请确认输入是否正确。' });
    else {
      accepted.push(value);
      pidNames[value] = entry.name;
    }
  }
  if (values.length === 0) issues.push({ level: 'error', code: 'missing_pid', message: '至少填写一个 PID。' });
  return { accepted, pidNames, issues };
}

export function validatePids(gameId: string, input: string, directory: PidDirectoryEntry[], config: ProjectConfig): PidValidationResult {
  const values = parsePidInput(input);
  const known = new Map(directory.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const entries: PidValidationResult['entries'] = [];
  const issues: ValidationIssue[] = [];
  const accepted: string[] = [];

  for (const value of values) {
    const duplicate = seen.has(value);
    seen.add(value);
    const entry = known.get(value);
    const belongs = /^\d+$/.test(value) && value.slice(0, 4) === gameId;
    const status = duplicate ? 'duplicate' : !belongs ? 'invalid' : !entry ? 'unknown' : 'ok';
    const deliveryType = entry?.deliveryType ?? classifyDeliveryType(entry?.name ?? '');
    const classification = entry ? inferPidClassification(entry.name) : null;
    const packageName = entry?.channel ?? inferPackageName(entry?.name ?? '') ?? config.pidPackageMap[value] ?? null;
    const mixed = Boolean(entry?.isMixed) || isMixedPidName(entry?.name ?? '', packageName);
    const operatingSystem = mixed
      ? '混投（按后台明细拆分）'
      : (entry?.operatingSystem ?? classification?.operatingSystem ?? (packageName === 'APK' ? '安卓' : packageName === 'IOS' ? 'IOS' : packageName === '鸿蒙' ? '鸿蒙' : null)) ?? null;
    entries.push({ id: value, name: entry?.name ?? '', status, deliveryType, packageName, operatingSystem });
    if (status === 'ok') accepted.push(value);
    if (status === 'duplicate') issues.push({ level: 'error', code: 'duplicate_pid', message: '存在重复 PID，请删除重复项。' });
    if (status === 'invalid') issues.push({ level: 'error', code: 'invalid_pid', message: 'PID必须为数字，且前四位必须等于当前 gameid。' });
    if (status === 'unknown') issues.push({ level: 'error', code: 'unknown_pid', message: '后台未找到该 PID，请确认输入是否正确。' });
    if (status === 'ok' && entry && !packageName) issues.push({ level: 'warning', code: 'unrecognized_channel_name', message: '后台 PID 名称未包含已知渠道关键词，生成时会忽略该 PID数据。' });
    if (status === 'ok' && entry && packageName && !operatingSystem) issues.push({ level: 'warning', code: 'unrecognized_operating_system', message: 'PID 名称和后台目录均未标明操作系统，后台明细也缺失系统时会忽略对应数据行。' });
  }

  if (values.length === 0) issues.push({ level: 'error', code: 'missing_pid', message: '至少填写一个 PID。' });
  return { accepted, entries, issues };
}
