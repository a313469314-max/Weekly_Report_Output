import type { WebContents } from 'electron';
import type { MetricKey, PidDirectoryEntry, ProjectConfig, RawAdRow, ReportData, ReportQuery, ValidationBaseline, VersionCandidate } from '../shared/contracts';
import { normalizeStructuredRows, type BackendColumn, type BackendRow } from '../engine/normalize';
import { classifyDeliveryType, inferPackageName, inferPidClassification, isMixedPidName } from '../domain/pid';
import { DiagnosticLogger } from './diagnostic-log';

const OPS_ORIGIN = 'https://ops.q1.com';
export const DASHCARD_IDLE_WINDOW_MS = 2500;

type ReportFrameControl = 'pid-filter' | 'pid-search' | 'pid-option' | 'pid-apply' | 'query'
  | 'date-start' | 'date-end' | 'date-payment' | 'date-level' | 'date-previous' | 'date-next' | 'date-month-option' | 'date-option'
  | 'income-selector' | 'income-option';
export const REPORT_FRAME_CLICK_MODES = ['web-contents', 'debugger'] as const;
type ReportFrameClickMode = typeof REPORT_FRAME_CLICK_MODES[number];

interface PullOptions {
  allowUnclassified?: boolean;
}

export interface BrowserHost {
  readonly webContents: WebContents;
  isDestroyed(): boolean;
  focus(): void;
  loadURL(url: string): Promise<void>;
}

interface ReportFrameControlPoint {
  x: number;
  y: number;
}

export interface ReportFrameReadyState {
  iframeCount: number;
  reportFrameCount: number;
  hasActiveFrame: boolean;
  documentReady: boolean;
  startDateInteractive: boolean;
  endDateInteractive: boolean;
  paymentDateInteractive: boolean;
}

export function isReportFrameReady(state: ReportFrameReadyState): boolean {
  return state.hasActiveFrame
    && state.documentReady
    && state.startDateInteractive
    && state.endDateInteractive
    && state.paymentDateInteractive;
}

function findActiveReportFrame(): HTMLIFrameElement | null {
  const isVisible = (element: Element) => {
    const node = element as HTMLElement;
    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  return Array.from(document.querySelectorAll('iframe'))
    .filter(isVisible)
    .filter((iframe) => {
      const doc = (iframe as HTMLIFrameElement).contentDocument;
      return Boolean(
        doc?.querySelector('button[aria-label="开始日期"]')
        && doc.querySelector('button[aria-label="结束日期"]')
        && doc.querySelector('button[aria-label="付费统计结束日期"]'),
      );
    })
    .filter((iframe) => {
      const rect = (iframe as HTMLIFrameElement).getBoundingClientRect();
      const x = rect.left + (rect.width / 2);
      const y = rect.top + (rect.height / 2);
      return x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight && document.elementFromPoint(x, y) === iframe;
    })
    .at(-1) as HTMLIFrameElement | undefined ?? null;
}

interface PidDialogOptionState {
  visiblePidOptions: number;
  matchingPidOptions: number;
  checkedMatchingPidOptions: number;
  checkedPidOptions: number;
  searchValueMatches: boolean;
}

export interface PidSearchKeyEvent {
  type: 'keyDown' | 'keyUp';
  key: string;
  code: string;
  modifiers?: number;
  text?: string;
  unmodifiedText?: string;
  windowsVirtualKeyCode?: number;
  nativeVirtualKeyCode?: number;
}

export function buildPidSearchKeyEvents(value: string): PidSearchKeyEvent[] {
  if (!/^\d+$/u.test(value)) throw new Error('PID search value must contain digits only.');
  const events: PidSearchKeyEvent[] = [
    { type: 'keyDown', key: 'Control', code: 'ControlLeft', modifiers: 2, windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 },
    { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 },
    { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 },
    { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 },
  ];
  for (const digit of value) {
    const keyCode = Number(digit) + 48;
    events.push(
      { type: 'keyDown', key: digit, code: `Digit${digit}`, text: digit, unmodifiedText: digit, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode },
      { type: 'keyUp', key: digit, code: `Digit${digit}`, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode },
    );
  }
  return events;
}

interface OverviewStructuredPayload {
  rows: BackendRow[];
  columns: BackendColumn[];
  summaryRows?: BackendRow[];
  summaryColumns?: BackendColumn[];
  selectedCard?: OverviewCardDescriptor;
  summaryCard?: OverviewCardDescriptor;
  candidateCount: number;
  candidateProfiles?: Array<{
    hasPid: boolean;
    hasDetail: boolean;
    hasRadid: boolean;
    hasSpend: boolean;
    hasActivatedDevices: boolean;
    hasRevenue: boolean;
    rows: number;
    spendAvailableRows: number;
    activatedDevicesAvailableRows: number;
    sameDayPaymentAvailableRows: number;
    paymentAvailableRows: number;
  }>;
  emptyCurrentResult?: boolean;
}

interface QueryBatch {
  waitForInitialResults(): Promise<boolean>;
  waitForAdditionalResults(): Promise<boolean>;
  urls(): string[];
  requestCount(): number;
  stop(): void;
}

export interface QueryConditionReadback {
  missingControls: string[];
  startDate: string;
  endDate: string;
  paymentStatsEndDate: string;
  incomeLabel: string;
  pidFilterLabel: string;
}

export function incomeLabelForType(incomeType: ReportQuery['incomeType']): '收入' | '实收' {
  return incomeType === 'amount' ? '收入' : '实收';
}

export function datePickerDayAriaLabel(value: string): string {
  const matched = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!matched) throw new Error('Invalid ISO date.');
  const month = Number(matched[2]);
  if (month < 1 || month > 12) throw new Error('Invalid ISO date.');
  const monthNames = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
  return `${Number(matched[3])} ${monthNames[month - 1]} ${matched[1]}`;
}

export function datePickerYearFromHeader(value: string): number | null {
  const matched = value.trim().match(/^\d{4}$/u);
  return matched ? Number(matched[0]) : null;
}

export interface OverviewCardDescriptor {
  rows: BackendRow[];
  columns: BackendColumn[];
  score: number;
  matched: number;
  hasPid: boolean;
  hasDetail: boolean;
  hasRadid: boolean;
  hasSpend: boolean;
  hasActivatedDevices: boolean;
  hasRevenue: boolean;
  targetPidCount?: number;
  unexpectedPidCount?: number;
  fieldFingerprint?: string;
  isCurrentQuery?: boolean;
  pagination?: { hasMetadata: boolean; hasNext: boolean };
}

export function isOpsDashcardUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === OPS_ORIGIN && url.pathname.includes('/dashcard/');
  } catch {
    return false;
  }
}

export function selectOverviewCards<T extends OverviewCardDescriptor>(candidates: T[], options: { requireRadid?: boolean } = {}): { primary?: T; summary?: T } {
  const hasCoreMetric = (candidate: T) => candidate.hasSpend || candidate.hasActivatedDevices || candidate.hasRevenue;
  const primaryScore = (candidate: T) => candidate.score
    + (candidate.hasSpend ? 12 : 0)
    + (candidate.hasActivatedDevices ? 8 : 0)
    + (candidate.hasRevenue ? 8 : 0)
    + (candidate.hasRadid ? 2 : 0);
  const summaryScore = (candidate: T) => candidate.score
    + (candidate.hasSpend ? 12 : 0)
    + (candidate.hasActivatedDevices ? 8 : 0)
    + (candidate.hasRevenue ? 8 : 0)
    + (candidate.hasRadid ? 0 : 4);
  const ordered = (items: T[], score: (candidate: T) => number) => [...items]
    .sort((left, right) => score(right) - score(left) || right.matched - left.matched);
  const currentCandidates = candidates.filter((candidate) => candidate.isCurrentQuery !== false);
  const matchesTargetPid = (candidate: T) => (candidate.targetPidCount ?? candidate.matched) > 0;
  const matchingCandidates = currentCandidates.filter(matchesTargetPid);
  const exactCandidates = matchingCandidates.filter((candidate) => (candidate.unexpectedPidCount ?? 0) === 0);
  const primaryCandidates = exactCandidates.length > 0 ? exactCandidates : matchingCandidates;
  const primary = ordered(primaryCandidates.filter((candidate) => candidate.hasPid && candidate.hasDetail && hasCoreMetric(candidate) && (!options.requireRadid || candidate.hasRadid)), primaryScore)[0]
    ?? ordered(primaryCandidates.filter((candidate) => candidate.hasPid && hasCoreMetric(candidate) && (!options.requireRadid || candidate.hasRadid)), primaryScore)[0];
  const summaryCandidates = currentCandidates.filter((candidate) => candidate !== primary && candidate.hasPid && !candidate.hasRadid && hasCoreMetric(candidate) && matchesTargetPid(candidate));
  const exactSummaryCandidates = summaryCandidates.filter((candidate) => (candidate.unexpectedPidCount ?? 0) === 0);
  const summary = ordered(exactSummaryCandidates.length > 0 ? exactSummaryCandidates : summaryCandidates, summaryScore)[0];
  return { primary, summary };
}

function normalizeReadbackDate(value: string): string {
  const matched = value.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/u);
  if (!matched) return value.trim();
  return `${matched[1]}-${matched[2].padStart(2, '0')}-${matched[3].padStart(2, '0')}`;
}

export function queryConditionMismatches(query: ReportQuery, readback: QueryConditionReadback): string[] {
  const mismatches = [...readback.missingControls];
  if (normalizeReadbackDate(readback.startDate) !== query.startDate) mismatches.push('开始日期');
  if (normalizeReadbackDate(readback.endDate) !== query.endDate) mismatches.push('结束日期');
  if (normalizeReadbackDate(readback.paymentStatsEndDate) !== query.paymentStatsEndDate) mismatches.push('付费统计结束日期');
  const expectedIncomeLabel = incomeLabelForType(query.incomeType);
  if (!readback.incomeLabel.replace(/\s+/gu, '').includes(expectedIncomeLabel)) mismatches.push('收入类型');
  if (query.pids.length > 0) {
    const actualPids = new Set((readback.pidFilterLabel.match(/\d{4,}/gu) ?? []));
    if (!readback.pidFilterLabel || query.pids.some((pid) => !actualPids.has(pid)) || [...actualPids].some((pid) => !query.pids.includes(pid))) mismatches.push('PID筛选结果');
  }
  return [...new Set(mismatches)];
}

export function isSelectedVersionCurrent(candidates: VersionCandidate[], gameId: string, gameVersionId: string): boolean {
  return candidates.some((candidate) => candidate.gameId === gameId && candidate.key === gameVersionId);
}

export function mergeOverviewRows(detailRows: RawAdRow[], summaryRows: RawAdRow[]): { rows: RawAdRow[]; issues: ReportData['issues'] } {
  const groupedDetails = new Map<string, RawAdRow[]>();
  for (const detail of detailRows) groupedDetails.set(detail.pid, [...(groupedDetails.get(detail.pid) ?? []), detail]);
  const issues: ReportData['issues'] = [];
  const summaries = new Set(summaryRows.map((row) => row.pid));
  for (const [pid, details] of groupedDetails) {
    if (!summaries.has(pid)) continue;
    const dimensionKeys = new Set(details.map((row) => [row.media, row.packageName, row.operatingSystem, row.bidCode, row.bidName, row.tapSegment].join('\u001f')));
    if (dimensionKeys.size > 1) {
      issues.push({ level: 'warning', code: 'backend_granularity_unavailable', message: '后台同时返回 PID 汇总与多维 RADID 明细；程序保留 RADID 明细进行分类，匹配到明细的 PID 汇总仅保留在源数据中，不再重复展示。' });
    }
  }
  return { rows: detailRows, issues };
}

const amountBaselineDefinitions: Array<{ metric: ValidationBaseline['metric']; label: string }> = [
  { metric: 'spend', label: '消耗' },
  { metric: 'sameDayPayment', label: '当日付费金额' },
  { metric: 'payment', label: '付费金额' },
];

export function amountBaselinesFromSummaryRows(rows: RawAdRow[]): ValidationBaseline[] {
  return amountBaselineDefinitions.map(({ metric, label }) => ({
    metric,
    label,
    expected: rows.reduce((total, row) => total + row[metric], 0),
    available: rows.length > 0 && rows.every((row) => row.availableFields?.[metric] !== false),
  }));
}

export class ConnectorError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ConnectorError';
  }
}

export function shouldRetryDailyPageSetup(error: unknown, attempt: number): error is ConnectorError {
  return attempt === 0
    && error instanceof ConnectorError
    && ['QUERY_CONDITIONS_NOT_APPLIED', 'REPORT_LOAD_TIMEOUT'].includes(error.code);
}

export function dateRange(start: string, end: string): string[] {
  const first = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  if (!Number.isFinite(first.getTime()) || !Number.isFinite(last.getTime()) || first > last) return [];
  const dates: string[] = [];
  for (const cursor = first; cursor <= last; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    dates.push(cursor.toISOString().slice(0, 10));
  }
  return dates;
}

export function buildDailyQuery(query: ReportQuery, date: string): ReportQuery {
  return { ...query, startDate: date, endDate: date };
}

export function missingPidsFromFilterLabel(pids: string[], label: string): string[] {
  return pids.filter((pid) => !new RegExp(`(^|[^0-9])${pid}([^0-9]|$)`).test(label));
}

export function selectValidVersionCandidates(rows: Array<Record<string, unknown>>, gameId: string): VersionCandidate[] {
  return rows.filter((row) => {
    const key = String(row.key ?? row.versionId ?? row.gameVersionId ?? '');
    const rowGameId = String(row.gameId ?? row.gameid ?? row.appId ?? '');
    const validFlag = row.flag === 1 || row.flag === '1' || row.flag === true || row.isValid === true || row.active === true || row.status === 'active' || row.status === '有效';
    return (rowGameId === gameId || key.startsWith(`${gameId}-`)) && key && String(row.name ?? row.displayName ?? row.versionName ?? '') && validFlag;
  }).map((row) => ({
    key: String(row.key ?? row.versionId ?? row.gameVersionId),
    name: String(row.name ?? row.displayName ?? row.versionName),
    gameId,
    flag: Number(row.flag ?? (row.isValid || row.active ? 1 : 0)),
  }));
}

export class Q1Connector {
  constructor(private readonly browser: BrowserHost, private readonly diagnostics = new DiagnosticLogger()) {}

  private async diagnosePidFilter(stage: string, expectedPids: string[] = []): Promise<void> {
    const snapshot = await this.execute<{
      hasIframe: boolean;
      visibleDialogs: number;
      dialogInputs: number;
      pidSearchInputs: number;
      channelNameButtons: number;
      channelFilterButtons: number;
      visibleMenus: number;
      enabledPidFilterButtons: number;
      addFilterButtons: number;
      confirmButtons: number;
      visibleButtons: number;
      dialogPidMatches: number;
      buttonPidMatches: number;
    }>(`${findActiveReportFrame.toString()}
      (${function inspect(pids: string[]) {
      const iframe = findActiveReportFrame();
      const doc = iframe?.contentDocument;
      if (!doc) return {
        hasIframe: Boolean(iframe), visibleDialogs: 0, dialogInputs: 0, pidSearchInputs: 0,
        channelNameButtons: 0, channelFilterButtons: 0, visibleMenus: 0, enabledPidFilterButtons: 0, addFilterButtons: 0, confirmButtons: 0,
        visibleButtons: 0, dialogPidMatches: 0, buttonPidMatches: 0,
      };
      const isVisible = (element: Element) => {
        const node = element as HTMLElement;
        const style = doc.defaultView?.getComputedStyle(node);
        return (node.offsetParent !== null || node.getClientRects().length > 0) && style?.display !== 'none' && style?.visibility !== 'hidden';
      };
      const normalized = (value: string) => value.replace(/\\s+/gu, '').trim().toLowerCase();
      const textOf = (element: Element) => normalized((element as HTMLElement).innerText || element.textContent || '');
      const visibleDialogs = Array.from(doc.querySelectorAll('[role="dialog"]')).filter(isVisible) as HTMLElement[];
      const visibleMenus = Array.from(doc.querySelectorAll('[role="listbox"],[role="menu"]')).filter(isVisible);
      const visibleButtons = Array.from(doc.querySelectorAll('button')).filter(isVisible) as HTMLButtonElement[];
      const visibleInputs = Array.from(doc.querySelectorAll('input')).filter(isVisible) as HTMLInputElement[];
      const pidSearchInputs = visibleInputs.filter((input) => /多个关键词|关键词|以,隔开/gu.test(input.getAttribute('placeholder') || ''));
      const dialogText = visibleDialogs.map(textOf).join(' ');
      const buttonText = visibleButtons.map(textOf).join(' ');
      const hasPid = (haystack: string, pid: string) => new RegExp(`(^|[^0-9])${pid}([^0-9]|$)`).test(haystack);
      return {
        hasIframe: true,
        visibleDialogs: visibleDialogs.length,
        dialogInputs: visibleDialogs.reduce((sum, dialog) => sum + Array.from(dialog.querySelectorAll('input')).filter(isVisible).length, 0),
        pidSearchInputs: pidSearchInputs.length,
        channelNameButtons: visibleButtons.filter((button) => /渠道id名称/iu.test(textOf(button))).length,
        channelFilterButtons: visibleButtons.filter((button) => /渠道id筛选/iu.test(textOf(button))).length,
        visibleMenus: visibleMenus.length,
        enabledPidFilterButtons: visibleButtons.filter((button) => !button.disabled && button.getAttribute('aria-disabled') !== 'true' && /渠道id(?:名称|筛选)/iu.test(textOf(button))).length,
        addFilterButtons: visibleButtons.filter((button) => textOf(button) === '添加筛选器').length,
        confirmButtons: visibleButtons.filter((button) => /^(确定|确认|应用)$/u.test(textOf(button))).length,
        visibleButtons: visibleButtons.length,
        dialogPidMatches: pids.filter((pid) => hasPid(dialogText, pid)).length,
        buttonPidMatches: pids.filter((pid) => hasPid(buttonText, pid)).length,
      };
    }})(${JSON.stringify(expectedPids)})`, `filters.pid.ui.${stage}`).catch(() => null);
    if (!snapshot) return;
    await this.diagnostics.event('filters.pid.ui', { stage, ...snapshot });
  }

  private async execute<T>(script: string, stage: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (this.browser.isDestroyed() || this.browser.webContents.isDestroyed()) {
        lastError = new Error('Object has been destroyed');
        break;
      }
      try {
        return await this.browser.webContents.executeJavaScript(script, true) as T;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('Object has been destroyed') || attempt === 3) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    await this.diagnostics.error(stage, lastError);
    throw new ConnectorError('BROWSER_EXECUTION_FAILED', '后台页面暂时无法读取，请确认浏览器仍处于登录状态后重试。');
  }

  private assertOpsPage(): void {
    if (!this.browser || this.browser.isDestroyed() || !this.browser.webContents.getURL().startsWith(OPS_ORIGIN)) {
      throw new ConnectorError('NOT_LOGGED_IN', '请先在内置浏览器中登录运营后台。');
    }
  }

  async isLoggedIn(): Promise<boolean> {
    if (!this.browser || this.browser.isDestroyed()) return false;
    if (!this.browser.webContents.getURL().startsWith(OPS_ORIGIN)) return false;
    return this.execute<boolean>(`fetch('/api/current', { credentials: 'include' }).then((response) => response.ok)`, 'login.status')
      .catch(() => false);
  }

  async resolveVersionCandidates(gameId: string): Promise<VersionCandidate[]> {
    this.assertOpsPage();
    const url = `/api/gameenv/v1/version?gameId=${encodeURIComponent(gameId)}`;
    const rows = await this.execute<Array<Record<string, unknown>>>(`fetch(${JSON.stringify(url)}, { credentials: 'include' }).then((response) => { if (!response.ok) throw new Error('HTTP_' + response.status); return response.json(); }).then((value) => {
      if (Array.isArray(value)) return value;
      if (Array.isArray(value?.data)) return value.data;
      if (Array.isArray(value?.list)) return value.list;
      if (Array.isArray(value?.data?.list)) return value.data.list;
      if (Array.isArray(value?.result)) return value.result;
      return [];
    })`, 'version.fetch');
    return selectValidVersionCandidates(rows, gameId);
  }

  async resolveVersion(gameId: string): Promise<VersionCandidate> {
    const candidates = await this.resolveVersionCandidates(gameId);
    if (candidates.length !== 1) {
      if (candidates.length === 0) throw new ConnectorError('NO_VALID_GAME_VERSION', '后台没有返回当前 gameid 的有效版本，暂时无法生成。请刷新后台登录状态后重试。');
      throw new ConnectorError('AMBIGUOUS_GAME_VERSION', '后台返回了多个当前有效版本，程序无法安全判断应使用哪一个，已停止生成。请联系后台管理员确认版本配置。');
    }
    const selected = candidates[0];
    return selected;
  }

  async lookupPids(gameId: string, gameVersionId: string): Promise<PidDirectoryEntry[]> {
    this.assertOpsPage();
    const url = `/q1api/sdk/game_stat_type?itemname=channel&gameid=${encodeURIComponent(gameId)}&gameversion=${encodeURIComponent(gameVersionId)}&inputfield=mykey&multiple=true&multipleformat=1`;
    const response = await this.execute<{ code?: number; data?: Array<{ mykey?: string; myvalue?: string }> }>(`fetch(${JSON.stringify(url)}, { credentials: 'include' }).then((response) => { if (!response.ok) throw new Error('HTTP_' + response.status); return response.json(); })`, 'pid-directory.fetch');
    return (Array.isArray(response.data) ? response.data : [])
      .filter((row) => row.mykey && row.myvalue)
      .map((row) => {
        const name = String(row.myvalue);
        const classification = inferPidClassification(name);
        const channel = classification?.channel ?? inferPackageName(name) ?? undefined;
        return {
          id: String(row.mykey),
          name,
          deliveryType: classifyDeliveryType(name),
          channel,
          operatingSystem: classification?.operatingSystem,
          isMixed: isMixedPidName(name, channel),
        };
      });
  }

  private async openOverviewPage(gameId: string, gameVersionId: string, includeReattribution = false, forceReload = false): Promise<void> {
    const path = includeReattribution ? '/dataCenter/ads/ads_overview_return' : '/dataCenter/ads/overview';
    const url = `${OPS_ORIGIN}${path}?gameId=${encodeURIComponent(gameId)}&gameVersionId=${encodeURIComponent(gameVersionId)}&currency=RMB`;
    try {
      if (forceReload || this.browser.webContents.getURL() !== url) await this.browser.loadURL(url);
      await this.waitForReportPage('account.controls-ready');
      await this.diagnostics.event('overview.ready', { mode: includeReattribution ? 'reattribution' : 'standard', result: 'true' });
    } catch (error) {
      await this.diagnostics.error('overview.load', error, { mode: includeReattribution ? 'reattribution' : 'standard' });
      throw error;
    }
  }

  private async readReportFrameReadyState(stage: string): Promise<ReportFrameReadyState> {
    return this.execute<ReportFrameReadyState>(`${findActiveReportFrame.toString()}
      (${function inspect() {
        const iframeCount = document.querySelectorAll('iframe').length;
        const reportFrameCount = Array.from(document.querySelectorAll('iframe'))
          .filter((frame) => {
            const doc = (frame as HTMLIFrameElement).contentDocument;
            return Boolean(
              doc?.querySelector('button[aria-label="开始日期"]')
              && doc.querySelector('button[aria-label="结束日期"]')
              && doc.querySelector('button[aria-label="付费统计结束日期"]'),
            );
          }).length;
        const iframe = findActiveReportFrame();
        const doc = iframe?.contentDocument;
        const interactive = (label: string) => {
          const button = doc?.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
          if (!button || !doc) return false;
          const style = doc.defaultView?.getComputedStyle(button);
          const rect = button.getBoundingClientRect();
          if (button.disabled || button.getAttribute('aria-disabled') === 'true' || style?.display === 'none' || style?.visibility === 'hidden' || style?.pointerEvents === 'none' || rect.width <= 0 || rect.height <= 0) return false;
          const top = doc.elementFromPoint(rect.left + (rect.width / 2), rect.top + (rect.height / 2));
          return Boolean(top && (top === button || button.contains(top)));
        };
        return {
          iframeCount,
          reportFrameCount,
          hasActiveFrame: Boolean(iframe),
          documentReady: doc?.readyState === 'complete',
          startDateInteractive: interactive('开始日期'),
          endDateInteractive: interactive('结束日期'),
          paymentDateInteractive: interactive('付费统计结束日期'),
        };
      }})()`, stage).catch(() => ({
      iframeCount: 0,
      reportFrameCount: 0,
      hasActiveFrame: false,
      documentReady: false,
      startDateInteractive: false,
      endDateInteractive: false,
      paymentDateInteractive: false,
    }));
  }

  private async waitForReportPage(stage: string): Promise<void> {
    const deadline = Date.now() + 30000;
    let stableReadyReads = 0;
    let latest: ReportFrameReadyState | undefined;
    while (Date.now() < deadline) {
      latest = await this.readReportFrameReadyState(stage);
      stableReadyReads = isReportFrameReady(latest) ? stableReadyReads + 1 : 0;
      if (stableReadyReads >= 2) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await this.diagnostics.event('overview.controls-not-ready', latest ? { ...latest } : {});
    throw new ConnectorError('REPORT_LOAD_TIMEOUT', '后台报表刷新超时，请检查网络或登录状态后重试。');
  }

  private async findReportFrameControlPoint(target: ReportFrameControl, value?: string): Promise<ReportFrameControlPoint> {
    const point = await this.execute<ReportFrameControlPoint>(`${findActiveReportFrame.toString()}
      (${function findControl(request: { target: ReportFrameControl; value?: string }, dayAriaLabel: (value: string) => string) {
      const iframe = findActiveReportFrame();
      const doc = iframe?.contentDocument;
      if (!iframe || !doc) throw new Error('report iframe');
      const isVisible = (element: Element) => {
        const node = element as HTMLElement;
        return node.offsetParent !== null || node.getClientRects().length > 0;
      };
      const textOf = (element: Element) => ((element as HTMLElement).innerText || element.textContent || '').replace(/\s+/gu, '').trim();
      const pointOf = (element: Element) => {
        const outer = iframe.getBoundingClientRect();
        const rect = (element as HTMLElement).getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) throw new Error('control bounds');
        const top = doc.elementFromPoint(rect.left + (rect.width / 2), rect.top + (rect.height / 2));
        if (!top || (top !== element && !(element as HTMLElement).contains(top))) throw new Error('control covered');
        return { x: Math.round(outer.left + rect.left + (rect.width / 2)), y: Math.round(outer.top + rect.top + (rect.height / 2)) };
      };
      const visibleButtons = () => Array.from(doc.querySelectorAll('button')).filter(isVisible) as HTMLButtonElement[];
      const visibleText = (element: Element) => textOf(element);
      const dateLabel = request.target === 'date-start'
        ? '开始日期'
        : request.target === 'date-end'
          ? '结束日期'
          : request.target === 'date-payment'
            ? '付费统计结束日期'
            : '';
      if (dateLabel) {
        const button = visibleButtons().find((element) => !element.disabled && element.getAttribute('aria-disabled') !== 'true' && element.getAttribute('aria-label') === dateLabel);
        if (!button) throw new Error('date button');
        return pointOf(button);
      }
      if (request.target === 'pid-filter') {
        const button = visibleButtons().find((element) => !element.disabled && element.getAttribute('aria-disabled') !== 'true' && /渠道id(?:名称|筛选)/iu.test(textOf(element)));
        if (!button) throw new Error('pid filter');
        return pointOf(button);
      }
      if (request.target === 'query') {
        const button = visibleButtons().find((element) => !element.disabled && element.getAttribute('aria-disabled') !== 'true' && textOf(element) === '查询');
        if (!button) throw new Error('query');
        return pointOf(button);
      }
      const dialog = Array.from(doc.querySelectorAll('[role="dialog"]')).filter(isVisible).at(-1) as HTMLElement | undefined;
      if (request.target === 'pid-search') {
        if (!dialog) throw new Error('pid dialog');
        const input = Array.from(dialog.querySelectorAll('input'))
          .find((element) => isVisible(element) && /多个关键词|关键词|以,隔开/gu.test(element.getAttribute('placeholder') || ''));
        if (!input) throw new Error('pid search');
        return pointOf(input);
      }
      if (request.target === 'pid-option') {
        if (!dialog || !request.value) throw new Error('pid option');
        const hasPid = (text: string) => new RegExp(`(^|[^0-9])${request.value}([^0-9]|$)`).test(text);
        const rowFor = (checkbox: HTMLInputElement) => {
          let node: HTMLElement | null = checkbox.parentElement;
          while (node && node !== dialog) {
            const checkboxes = Array.from(node.querySelectorAll('input[type="checkbox"]')).filter(isVisible);
            if (checkboxes.length === 1 && checkboxes[0] === checkbox && hasPid(visibleText(node))) return node;
            node = node.parentElement;
          }
          return null;
        };
        const checkbox = Array.from(dialog.querySelectorAll('input[type="checkbox"]'))
          .filter(isVisible)
          .find((element) => rowFor(element as HTMLInputElement) !== null);
        if (!checkbox) throw new Error('pid option');
        return pointOf(checkbox);
      }
      if (request.target === 'pid-apply') {
        if (!dialog) throw new Error('pid dialog');
        const button = Array.from(dialog.querySelectorAll('button')).find((element) => isVisible(element) && !(element as HTMLButtonElement).disabled && textOf(element) === '添加筛选器');
        if (!button) throw new Error('pid apply');
        return pointOf(button);
      }
      const calendarHeaderControls = visibleButtons()
        .filter((element) => String((element as HTMLElement).className || '').includes('DatePicker-calendarHeaderControl'))
        .sort((left, right) => (left as HTMLElement).getBoundingClientRect().x - (right as HTMLElement).getBoundingClientRect().x);
      if (request.target === 'date-level') {
        const button = visibleButtons().find((element) => String((element as HTMLElement).className || '').includes('DatePicker-calendarHeaderLevel'));
        if (!button) throw new Error('date level');
        return pointOf(button);
      }
      if (request.target === 'date-previous' || request.target === 'date-next') {
        const button = request.target === 'date-previous' ? calendarHeaderControls[0] : calendarHeaderControls.at(-1);
        if (!button) throw new Error('date navigation');
        return pointOf(button);
      }
      if (request.target === 'date-month-option') {
        if (!request.value) throw new Error('date month option');
        const button = visibleButtons().find((element) => String((element as HTMLElement).className || '').includes('DatePicker-monthsListControl') && visibleText(element) === request.value);
        if (!button) throw new Error('date month option');
        return pointOf(button);
      }
      if (request.target === 'date-option') {
        if (!request.value) throw new Error('date option');
        const button = visibleButtons().find((element) => String((element as HTMLElement).className || '').includes('DatePicker-day') && element.getAttribute('aria-label') === dayAriaLabel(request.value!));
        if (!button) throw new Error('date option');
        return pointOf(button);
      }
      if (request.target === 'income-selector') {
        const button = visibleButtons().find((element) => visibleText(element).includes('收入类型'));
        if (!button) throw new Error('income selector');
        return pointOf(button);
      }
      if (request.target === 'income-option') {
        if (!request.value) throw new Error('income option');
        const containers = Array.from(doc.querySelectorAll('[role="dialog"],[role="listbox"],[role="menu"]')).filter(isVisible);
        const option = containers.flatMap((container) => Array.from(container.querySelectorAll('[role="option"],button,label,li,[data-value],span,div')))
          .filter(isVisible)
          .map((element) => element as HTMLElement)
          .filter((element) => {
            const text = visibleText(element);
            return text === request.value || text.endsWith(`:${request.value}`) || text.endsWith(`：${request.value}`);
          })
          .sort((left, right) => visibleText(left).length - visibleText(right).length)[0];
        if (!option) throw new Error('income option');
        return pointOf(option);
      }
      throw new Error('unknown control');
    }})(${JSON.stringify({ target, value })}, (${datePickerDayAriaLabel.toString()}))`, `controls.${target}`);
    return point;
  }

  private async sendReportFrameClick(point: ReportFrameControlPoint): Promise<void> {
    this.browser.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    await new Promise((resolve) => setTimeout(resolve, 80));
    this.browser.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    this.browser.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  private async sendReportFrameDebuggerClick(point: ReportFrameControlPoint): Promise<void> {
    const debuggerClient = this.browser.webContents.debugger;
    let attachedHere = false;
    try {
      if (!debuggerClient.isAttached()) {
        debuggerClient.attach('1.3');
        attachedHere = true;
      }
      await debuggerClient.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
      await new Promise((resolve) => setTimeout(resolve, 80));
      await debuggerClient.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
      await new Promise((resolve) => setTimeout(resolve, 80));
      await debuggerClient.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
      await new Promise((resolve) => setTimeout(resolve, 120));
    } finally {
      if (attachedHere && debuggerClient.isAttached()) debuggerClient.detach();
    }
  }

  private async clickReportFrameControl(target: ReportFrameControl, mode: ReportFrameClickMode = 'web-contents', value?: string): Promise<void> {
    this.browser.focus();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const point = await this.findReportFrameControlPoint(target, value);
    if (mode === 'debugger') await this.sendReportFrameDebuggerClick(point);
    else await this.sendReportFrameClick(point);
  }

  private async hasPidDialog(): Promise<boolean> {
    return this.execute<boolean>(`${findActiveReportFrame.toString()}
      (()=>{
      const iframe = findActiveReportFrame();
      const doc = iframe?.contentDocument;
      return Array.from(doc?.querySelectorAll('[role="dialog"]') ?? []).some((element) => {
        const node = element;
        return (node.offsetParent !== null || node.getClientRects().length > 0)
          && Array.from(node.querySelectorAll('input')).some((input) => /多个关键词|关键词|以,隔开/gu.test(input.getAttribute('placeholder') || ''));
      });
    })()`, 'filters.pid.dialog-state').catch(() => false);
  }

  private async waitForPidDialog(open: boolean): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await this.hasPidDialog() === open) return;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    throw new ConnectorError('PID_FILTER_NOT_APPLIED', open ? '后台 PID 筛选器无法打开，请重新尝试。' : '后台 PID 筛选没有成功提交，请重新尝试。');
  }

  private async preparePidValueFilter(stage: string): Promise<void> {
    await this.diagnosePidFilter(`${stage}.before`);
    const clickModes: ReportFrameClickMode[] = [...REPORT_FRAME_CLICK_MODES];
    for (const mode of clickModes) {
      try {
        if (!await this.hasPidDialog()) {
          await this.clickReportFrameControl('pid-filter', mode);
          await this.waitForPidDialog(true);
        }
        await this.diagnostics.event('filters.pid.open-click', { mode, result: 'true' });
        await this.diagnosePidFilter(`${stage}.after`);
        return;
      } catch {
        await this.diagnostics.event('filters.pid.open-click', { mode, result: 'false' });
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    await this.diagnosePidFilter(`${stage}.failed`);
    throw new ConnectorError('PID_FILTER_NOT_APPLIED', '后台 PID 筛选器无法打开，请重新尝试。');
  }

  private async hasFocusedPidSearchInput(): Promise<boolean> {
    return this.execute<boolean>(`${findActiveReportFrame.toString()}
      (()=>{
      const iframe = findActiveReportFrame();
      const doc = iframe?.contentDocument;
      const dialog = Array.from(doc?.querySelectorAll('[role="dialog"]') ?? []).filter((element) => {
        const node = element;
        return node.offsetParent !== null || node.getClientRects().length > 0;
      }).at(-1);
      const input = Array.from(dialog?.querySelectorAll('input') ?? [])
        .find((element) => /多个关键词|关键词|以,隔开/gu.test(element.getAttribute('placeholder') || ''));
      return Boolean(input && doc?.activeElement === input);
    })()`, 'filters.pid.search-focus-state').catch(() => false);
  }

  private async focusPidSearchInput(): Promise<void> {
    const clickModes: ReportFrameClickMode[] = [...REPORT_FRAME_CLICK_MODES];
    for (const mode of clickModes) {
      try {
        await this.clickReportFrameControl('pid-search', mode);
        const deadline = Date.now() + 1_000;
        while (Date.now() < deadline) {
          if (await this.hasFocusedPidSearchInput()) {
            await this.diagnostics.event('filters.pid.search-focus', { mode, result: 'true' });
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
      } catch {
        // Try the next real click path. The DOM fallback that opens the dialog is
        // intentionally not used to claim focus for text input.
      }
      await this.diagnostics.event('filters.pid.search-focus', { mode, result: 'false' });
    }
    throw new ConnectorError('PID_FILTER_NOT_APPLIED', '后台 PID 搜索框没有进入可输入状态，请重新尝试。');
  }

  private async setPidSearchValue(pid: string): Promise<void> {
    const payload = JSON.stringify(pid);
    await this.focusPidSearchInput();

    const debuggerClient = this.browser.webContents.debugger;
    let attachedHere = false;
    try {
      if (!debuggerClient.isAttached()) {
        debuggerClient.attach('1.3');
        attachedHere = true;
      }
      for (const event of buildPidSearchKeyEvents(pid)) {
        await debuggerClient.sendCommand('Input.dispatchKeyEvent', event);
        if (event.type === 'keyUp' && event.key !== 'Control') await new Promise((resolve) => setTimeout(resolve, 70));
      }
      await this.diagnostics.event('filters.pid.search-input', { mode: 'keyboard', digits: pid.length });
    } catch (error) {
      await this.diagnostics.error('filters.pid.search-input', error);
      throw new ConnectorError('PID_FILTER_NOT_APPLIED', '后台 PID 搜索输入未生效，请重新尝试。');
    } finally {
      if (attachedHere && debuggerClient.isAttached()) debuggerClient.detach();
    }

    const populated = await this.execute<boolean>(`${findActiveReportFrame.toString()}
      (${function verify(value: string) {
      const iframe = findActiveReportFrame();
      const doc = iframe?.contentDocument;
      const dialog = Array.from(doc?.querySelectorAll('[role="dialog"]') ?? []).filter((element) => {
        const node = element as HTMLElement;
        return node.offsetParent !== null || node.getClientRects().length > 0;
      }).at(-1);
      const input = Array.from(dialog?.querySelectorAll('input') ?? [])
        .find((element) => /多个关键词|关键词|以,隔开/gu.test(element.getAttribute('placeholder') || '')) as HTMLInputElement | undefined;
      return input?.value.trim() === value;
    }})(${payload})`, 'filters.pid.search-verify').catch(() => false);
    if (!populated) throw new ConnectorError('PID_FILTER_NOT_APPLIED', '后台 PID 搜索条件未生效，请重新尝试。');
  }

  private async readPidDialogOptionState(pid: string, stage: string): Promise<PidDialogOptionState> {
    const payload = JSON.stringify(pid);
    return this.execute<PidDialogOptionState>(`${findActiveReportFrame.toString()}
      (${function inspect(value: string) {
      const iframe = findActiveReportFrame();
      const doc = iframe?.contentDocument;
      const dialog = Array.from(doc?.querySelectorAll('[role="dialog"]') ?? []).filter((element) => {
        const node = element as HTMLElement;
        return node.offsetParent !== null || node.getClientRects().length > 0;
      }).at(-1);
      if (!dialog) throw new Error('pid dialog');
      const visible = (element: Element) => {
        const node = element as HTMLElement;
        return node.offsetParent !== null || node.getClientRects().length > 0;
      };
      const hasPid = (text: string) => new RegExp('(^|[^0-9])' + value + '([^0-9]|$)').test(text);
      const textOf = (element: Element) => ((element as HTMLElement).innerText || element.textContent || '').replace(/\s+/gu, '').trim();
      const rowFor = (checkbox: HTMLInputElement) => {
        let node: HTMLElement | null = checkbox.parentElement;
        while (node && node !== dialog) {
          const checkboxes = Array.from(node.querySelectorAll('input[type="checkbox"]')).filter(visible);
          if (checkboxes.length === 1 && checkboxes[0] === checkbox && hasPid(textOf(node))) return node;
          node = node.parentElement;
        }
        return null;
      };
      const rows = Array.from(dialog.querySelectorAll('input[type="checkbox"]'))
        .filter((element) => visible(element))
        .map((element) => ({ checkbox: element as HTMLInputElement, row: rowFor(element as HTMLInputElement) }))
        .filter((entry): entry is { checkbox: HTMLInputElement; row: HTMLElement } => entry.row !== null);
      const matches = rows.filter((entry) => hasPid(textOf(entry.row)));
      const input = Array.from(dialog.querySelectorAll('input'))
        .find((element) => /多个关键词|关键词|以,隔开/gu.test(element.getAttribute('placeholder') || '')) as HTMLInputElement | undefined;
      return {
        visiblePidOptions: rows.length,
        matchingPidOptions: matches.length,
        checkedMatchingPidOptions: matches.filter((entry) => entry.checkbox.checked).length,
        checkedPidOptions: rows.filter((entry) => entry.checkbox.checked).length,
        searchValueMatches: input?.value.trim() === value,
      };
    }})(${payload})`, stage);
  }

  private async waitForPidDialogOption(pid: string, stage: string): Promise<PidDialogOptionState> {
    const deadline = Date.now() + 5000;
    let latest: PidDialogOptionState | null = null;
    while (Date.now() < deadline) {
      latest = await this.readPidDialogOptionState(pid, stage).catch(() => null);
      if (latest?.searchValueMatches && latest.matchingPidOptions === 1) {
        await this.diagnostics.event('filters.pid.option-state', { ...latest });
        return latest;
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    if (latest) await this.diagnostics.event('filters.pid.option-state', { ...latest });
    throw new ConnectorError('PID_FILTER_NOT_APPLIED', '后台 PID 搜索结果未能唯一定位到对应 PID，请重新尝试。');
  }

  private async selectPidInDialog(pid: string): Promise<void> {
    await this.setPidSearchValue(pid);
    const initialState = await this.waitForPidDialogOption(pid, 'filters.pid.option-ready');
    if (initialState.checkedMatchingPidOptions === 1) return;
    const clickModes: ReportFrameClickMode[] = [...REPORT_FRAME_CLICK_MODES];
    for (const mode of clickModes) {
      try {
        await this.clickReportFrameControl('pid-option', mode, pid);
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline) {
          const state = await this.readPidDialogOptionState(pid, 'filters.pid.option-checked').catch(() => null);
          if (state?.checkedMatchingPidOptions === 1) {
            await this.diagnostics.event('filters.pid.option-click', { mode, result: 'true' });
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
      } catch {
        // Continue through the real input routes only.
      }
      await this.diagnostics.event('filters.pid.option-click', { mode, result: 'false' });
    }
    throw new ConnectorError('PID_FILTER_NOT_APPLIED', '后台 PID 复选框未保持选中，请重新尝试。');
  }

  private async clickPidAddFilter(expectedPids: string[]): Promise<void> {
    await this.diagnosePidFilter('apply.before', expectedPids);
    for (let attempt = 0; attempt < REPORT_FRAME_CLICK_MODES.length; attempt += 1) {
      try {
        if (attempt === 0) await this.clickReportFrameControl('pid-apply', 'web-contents');
        else await this.clickReportFrameControl('pid-apply', 'debugger');
        await this.waitForPidDialog(false);
        await this.diagnosePidFilter('apply.after', expectedPids);
        return;
      } catch {
        if (!await this.hasPidDialog()) {
          await this.diagnosePidFilter('apply.after', expectedPids);
          return;
        }
        if (attempt === 0) {
          await this.diagnostics.event('filters.pid.apply-debugger-retry', { result: 'retry', rows: expectedPids.length });
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      }
    }
    await this.diagnostics.event('filters.pid.apply-timeout', { result: 'false', rows: expectedPids.length });
    throw new ConnectorError('PID_FILTER_NOT_APPLIED', '后台 PID 筛选没有成功提交，请重新尝试。');
  }

  private async setPidFilters(pids: string[]): Promise<void> {
    try {
      for (const [index, pid] of pids.entries()) {
        await this.preparePidValueFilter(`filters.pid.prepare.${index + 1}`);
        await this.selectPidInDialog(pid);
        await this.clickPidAddFilter([pid]);
        await this.diagnostics.event('filters.pid.item-applied', { result: 'true', rows: index + 1 });
      }
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError('PID_FILTER_NOT_APPLIED', '后台 PID 筛选没有成功提交，请重新尝试。');
    }
  }

  private startQueryBatch(): QueryBatch {
    const urls = new Set<string>();
    const webRequest = this.browser.webContents.session.webRequest;
    let stopped = false;
    let lastRequestAt = 0;
    let requestCount = 0;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      webRequest.onCompleted(null);
    };
    webRequest.onCompleted({ urls: [`${OPS_ORIGIN}/*`] }, (details) => {
      if (stopped || details.webContentsId !== this.browser.webContents.id || !isOpsDashcardUrl(details.url)) return;
      urls.add(details.url);
      requestCount += 1;
      lastRequestAt = Date.now();
    });
    const waitFor = async (requireAdditional: boolean): Promise<boolean> => {
      const requestCountBefore = requestCount;
      const deadline = Date.now() + (requireAdditional ? 15000 : 30000);
      while (Date.now() < deadline) {
        const hasRequiredResult = requireAdditional ? requestCount > requestCountBefore : urls.size > 0;
        if (hasRequiredResult && Date.now() - lastRequestAt >= DASHCARD_IDLE_WINDOW_MS) return true;
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      if (!requireAdditional && urls.size === 0) {
        throw new ConnectorError('QUERY_RESULT_TIMEOUT', '后台查询后未返回本次查询的数据卡片，请确认筛选条件后重试。');
      }
      return false;
    };
    return {
      waitForInitialResults: () => waitFor(false),
      waitForAdditionalResults: () => waitFor(true),
      urls: () => [...urls],
      requestCount: () => requestCount,
      stop,
    };
  }

  private async clickQuery(): Promise<QueryBatch> {
    const batch = this.startQueryBatch();
    try {
      await this.clickReportFrameControl('query');
      await this.waitForReportPage('filters.query-page-ready');
      await batch.waitForInitialResults();
      const urls = batch.urls();
      await this.diagnostics.event('overview.query-batch.captured', { requests: urls.length, idleWindowMs: DASHCARD_IDLE_WINDOW_MS });
      return batch;
    } catch (error) {
      batch.stop();
      throw error;
    }
  }

  private async readQueryBatch(date: string, query: ReportQuery, config: ProjectConfig, batch: QueryBatch, options: PullOptions, requireRadid: boolean): Promise<ReportData> {
    const requestCountBeforeRead = batch.requestCount();
    try {
      return await this.readOverviewStructured(date, query, config, batch.urls(), options, requireRadid);
    } catch (error) {
      if (!(error instanceof ConnectorError) || error.code !== 'DETAIL_CARD_UNAVAILABLE') throw error;
      const receivedDuringRead = batch.requestCount() > requestCountBeforeRead;
      if (!receivedDuringRead) {
        await this.diagnostics.event('overview.data-card.waiting-late-detail', { date, requests: batch.urls().length });
        if (!await batch.waitForAdditionalResults()) throw error;
      }
      await this.diagnostics.event('overview.query-batch.extended', { requests: batch.urls().length, idleWindowMs: DASHCARD_IDLE_WINDOW_MS });
      return this.readOverviewStructured(date, query, config, batch.urls(), options, requireRadid);
    } finally {
      batch.stop();
    }
  }

  private async readOverviewStructured(date: string, query: ReportQuery, config: ProjectConfig, dashcardUrls: string[], options: PullOptions = {}, requireRadid = false): Promise<ReportData> {
    const pidsPayload = JSON.stringify(query.pids);
    const urlsPayload = JSON.stringify(dashcardUrls);
    const structured = await this.execute<OverviewStructuredPayload & { matchingCandidateCount: number }>(`${findActiveReportFrame.toString()}
      (${async function readOverview(pids: string[], dashcardUrls: string[], requireRadid: boolean) {
      const iframe = findActiveReportFrame();
      const win = iframe?.contentWindow;
      if (!win) throw new Error('iframe');
      const normalize = (value: unknown) => String(value ?? '').replace(/\\s+/gu, '').trim().toLowerCase();
      const namesOf = (columns: Array<Record<string, unknown>>) => columns.map((column) => normalize(column.display_name ?? column.name));
      const fingerprint = (names: string[]) => {
        let value = 2166136261;
        for (const name of names) {
          for (let index = 0; index < name.length; index += 1) value = Math.imul(value ^ name.charCodeAt(index), 16777619);
        }
        return `fp-${(value >>> 0).toString(16)}-${names.length}`;
      };
      const hasOneOf = (names: string[], values: string[]) => values.some((value) => names.includes(value));
      const valueAt = (row: unknown[] | Record<string, unknown>, names: string[], aliases: string[]) => {
        const index = names.findIndex((name) => aliases.some((alias) => normalize(alias) === name));
        if (Array.isArray(row)) return index >= 0 ? row[index] : undefined;
        const wanted = new Set(aliases.map(normalize));
        const found = Object.entries(row).find(([key]) => wanted.has(normalize(key)));
        return found?.[1];
      };
      const currentUrls = [...new Set(dashcardUrls)].reverse();
      const candidates: Array<{ rows: unknown[]; columns: Array<Record<string, unknown>>; score: number; matched: number; targetPidCount: number; unexpectedPidCount: number; hasPid: boolean; hasDetail: boolean; hasRevenue: boolean; hasRadid: boolean; hasSpend: boolean; hasActivatedDevices: boolean; fieldFingerprint: string; isCurrentQuery: boolean; pagination: { hasMetadata: boolean; hasNext: boolean }; fieldPresence: { spend: number; activatedDevices: number; sameDayPayment: number; payment: number } }> = [];
      for (const rawUrl of currentUrls) {
        try {
          const response = await win.fetch(rawUrl, { credentials: 'include' });
          if (!response.ok && response.status !== 202) continue;
          const payload = await response.json() as Record<string, unknown>;
          const data = payload.data && typeof payload.data === 'object' ? payload.data as Record<string, unknown> : payload;
          const columns = (Array.isArray(data.cols) ? data.cols : Array.isArray(data.columns) ? data.columns : []) as Array<Record<string, unknown>>;
          const rows = (Array.isArray(data.rows) ? data.rows : Array.isArray(data.data) ? data.data : []) as unknown[];
          if (columns.length === 0) continue;
          const names = namesOf(columns);
          const hasPid = hasOneOf(names, ['渠道id', '渠道pid', 'pid', 'channel_id']);
          const hasDetail = hasOneOf(names, ['radid', '渠道名', '渠道名称', '媒体', '媒体名称', '操作系统']);
          const hasRadid = hasOneOf(names, ['radid']);
          const hasSpend = hasOneOf(names, ['消耗', '原始消耗', 'spend', 'cost']);
          const hasActivatedDevices = hasOneOf(names, ['激活设备数', '激活数', 'activateddevices']);
          const hasRevenue = hasOneOf(names, ['付费金额', '付费总金额', 'payment', '首日付费金额']);
          if (!hasPid || !hasDetail) continue;
          const returnedPids = new Set(rows
            .map((row) => String(valueAt(row as unknown[] | Record<string, unknown>, names, ['渠道id', '渠道ID', '渠道Pid', 'pid', 'channel_id'])).trim())
            .filter((pid) => /^\d+$/u.test(pid)));
          const targetPidCount = pids.filter((pid) => returnedPids.has(pid)).length;
          const unexpectedPidCount = [...returnedPids].filter((pid) => !pids.includes(pid)).length;
          const matched = rows.filter((row) => pids.includes(String(valueAt(row as unknown[] | Record<string, unknown>, names, ['渠道id', '渠道ID', '渠道Pid', 'pid', 'channel_id'])))).length;
          const hasValue = (value: unknown) => {
            const text = String(value ?? '').trim();
            return text.length > 0 && text !== '-';
          };
          const presentCount = (aliases: string[]) => rows.filter((row) => hasValue(valueAt(row as unknown[] | Record<string, unknown>, names, aliases))).length;
          const fieldPresence = {
            spend: presentCount(['消耗', '原始消耗', 'spend', 'cost']),
            activatedDevices: presentCount(['激活设备数', '激活数', 'activateddevices']),
            sameDayPayment: presentCount(['当日付费金额', '当日付费总金额', 'sameDayPayment']),
            payment: presentCount(['付费金额', '付费总金额', 'payment']),
          };
          const score = (hasRadid ? 4 : 0) + (hasOneOf(names, ['媒体', '媒体名称']) ? 2 : 0) + (hasSpend ? 8 : 0) + (hasActivatedDevices ? 5 : 0) + (hasRevenue ? 6 : 0) + (matched > 0 ? 8 : 0) + Math.min(rows.length, 100) / 100;
          const paginationSource = data.pagination && typeof data.pagination === 'object' ? data.pagination as Record<string, unknown> : {};
          const pagination = {
            hasMetadata: ['total', 'page', 'next'].some((key) => key in data || key in paginationSource),
            hasNext: Boolean(data.next ?? paginationSource.next),
          };
          candidates.push({ rows, columns, score, matched, targetPidCount, unexpectedPidCount, hasPid, hasDetail, hasRevenue, hasRadid, hasSpend, hasActivatedDevices, fieldFingerprint: fingerprint(names), isCurrentQuery: true, pagination, fieldPresence });
        } catch {
          // 资源列表中可能包含已失效或非 JSON 的请求，继续尝试其他数据卡片。
        }
      }
      const hasCoreMetric = (candidate: typeof candidates[number]) => candidate.hasSpend || candidate.hasActivatedDevices || candidate.hasRevenue;
      const primaryScore = (candidate: typeof candidates[number]) => candidate.score
        + (candidate.hasSpend ? 12 : 0)
        + (candidate.hasActivatedDevices ? 8 : 0)
        + (candidate.hasRevenue ? 8 : 0)
        + (candidate.hasRadid ? 2 : 0);
      const summaryScore = (candidate: typeof candidates[number]) => candidate.score
        + (candidate.hasSpend ? 12 : 0)
        + (candidate.hasActivatedDevices ? 8 : 0)
        + (candidate.hasRevenue ? 8 : 0)
        + (candidate.hasRadid ? 0 : 4);
      const ordered = (items: typeof candidates, score: (candidate: typeof candidates[number]) => number) => [...items]
        .sort((left, right) => score(right) - score(left) || right.matched - left.matched);
      const currentCandidates = candidates.filter((candidate) => candidate.isCurrentQuery !== false);
      const matchesTargetPid = (candidate: typeof candidates[number]) => candidate.targetPidCount > 0;
      const matchingCandidates = currentCandidates.filter(matchesTargetPid);
      const exactCandidates = matchingCandidates.filter((candidate) => candidate.unexpectedPidCount === 0);
      const primaryCandidates = exactCandidates.length > 0 ? exactCandidates : matchingCandidates;
      const selected = ordered(primaryCandidates.filter((candidate) => candidate.hasPid && candidate.hasDetail && hasCoreMetric(candidate) && (!requireRadid || candidate.hasRadid)), primaryScore)[0]
        ?? ordered(primaryCandidates.filter((candidate) => candidate.hasPid && hasCoreMetric(candidate) && (!requireRadid || candidate.hasRadid)), primaryScore)[0];
      const summaryCandidates = currentCandidates.filter((candidate) => candidate !== selected && candidate.hasPid && !candidate.hasRadid && hasCoreMetric(candidate) && matchesTargetPid(candidate));
      const exactSummaryCandidates = summaryCandidates.filter((candidate) => candidate.unexpectedPidCount === 0);
      const summary = ordered(exactSummaryCandidates.length > 0 ? exactSummaryCandidates : summaryCandidates, summaryScore)[0];
      return {
        rows: selected?.rows ?? [],
        columns: selected?.columns ?? [],
        summaryRows: summary?.rows,
        summaryColumns: summary?.columns,
        selectedCard: selected,
        summaryCard: summary,
        candidateCount: candidates.length,
        candidateProfiles: candidates.map((candidate) => ({
          hasPid: candidate.hasPid,
          hasDetail: candidate.hasDetail,
          hasRadid: candidate.hasRadid,
          hasSpend: candidate.hasSpend,
          hasActivatedDevices: candidate.hasActivatedDevices,
          hasRevenue: candidate.hasRevenue,
          rows: candidate.rows.length,
          spendAvailableRows: candidate.fieldPresence.spend,
          activatedDevicesAvailableRows: candidate.fieldPresence.activatedDevices,
          sameDayPaymentAvailableRows: candidate.fieldPresence.sameDayPayment,
          paymentAvailableRows: candidate.fieldPresence.payment,
        })),
        matchingCandidateCount: matchingCandidates.length,
        emptyCurrentResult: !selected && currentCandidates.length > 0 && currentCandidates.every((candidate) => candidate.rows.length === 0),
      };
    }})(${pidsPayload}, ${urlsPayload}, ${JSON.stringify(requireRadid)})`, 'overview.data.read');
    await this.diagnostics.event('overview.data-card.candidates', {
      date,
      candidateCount: structured.candidateCount,
      selected: Boolean(structured.selectedCard),
    });
    for (const [index, candidate] of (structured.candidateProfiles ?? []).entries()) {
      await this.diagnostics.event('overview.data-card.profile', {
        date,
        candidateIndex: index + 1,
        rows: candidate.rows,
        hasRadid: candidate.hasRadid,
        hasSpend: candidate.hasSpend,
        hasActivatedDevices: candidate.hasActivatedDevices,
        hasRevenue: candidate.hasRevenue,
        spendAvailableRows: candidate.spendAvailableRows,
        activatedDevicesAvailableRows: candidate.activatedDevicesAvailableRows,
        sameDayPaymentAvailableRows: candidate.sameDayPaymentAvailableRows,
        paymentAvailableRows: candidate.paymentAvailableRows,
      });
    }
    if (structured.selectedCard) {
      await this.diagnostics.event('overview.data-card.selected', {
        date,
        candidateCount: structured.candidateCount,
        hasRadid: structured.selectedCard.hasRadid,
        hasSpend: structured.selectedCard.hasSpend,
        hasActivatedDevices: structured.selectedCard.hasActivatedDevices,
        hasRevenue: structured.selectedCard.hasRevenue,
        rows: structured.selectedCard.rows.length,
        targetPidCount: structured.selectedCard.targetPidCount ?? structured.selectedCard.matched,
        unexpectedPidCount: structured.selectedCard.unexpectedPidCount ?? 0,
        fieldFingerprint: structured.selectedCard.fieldFingerprint ?? '',
        paginationMetadata: structured.selectedCard.pagination?.hasMetadata === true,
        paginationNext: structured.selectedCard.pagination?.hasNext === true,
      });
    }
    const selectedCard = structured.selectedCard;
    if (!selectedCard) {
      if (structured.emptyCurrentResult) return { rows: [], detailRows: [], pidSummaryRows: [], issues: [], source: 'structured', baselines: [] };
      if (requireRadid && structured.matchingCandidateCount > 0) {
        throw new ConnectorError('DETAIL_CARD_UNAVAILABLE', `后台 ${date} 未返回包含 RADID 的投放明细卡片，已停止生成以避免导出缺失的媒体、消耗和成本数据。`);
      }
      throw new ConnectorError('TARGET_PID_NOT_FOUND', '后台本次查询返回的数据卡片未命中目标 PID，已停止生成以避免使用历史数据。');
    }
    const hasUnexpectedPids = (selectedCard.unexpectedPidCount ?? 0) > 0 || (structured.summaryCard?.unexpectedPidCount ?? 0) > 0;
    const normalized = normalizeStructuredRows(structured.rows, structured.columns, { ...config, pidWhitelist: query.pids }, date, 'structured', query.includeReattribution, options);
    if (hasUnexpectedPids) normalized.issues.push({ level: 'warning', code: 'unexpected_pid_rows_excluded', message: '后台数据卡片包含非目标 PID，程序已按本次输入的 PID 排除这些数据，不计入报表。' });
    if (!selectedCard.hasRadid) {
      return {
        rows: normalized.rows,
        detailRows: [],
        pidSummaryRows: normalized.rows,
        issues: normalized.issues,
        source: 'structured',
        baselines: structured.summaryRows && structured.summaryColumns
          ? amountBaselinesFromSummaryRows(normalizeStructuredRows(structured.summaryRows, structured.summaryColumns, { ...config, pidWhitelist: query.pids }, date, 'structured', query.includeReattribution, options).rows)
          : [],
      };
    }
    if (!structured.summaryRows || !structured.summaryColumns) {
      return { rows: normalized.rows, detailRows: normalized.rows, pidSummaryRows: [], issues: normalized.issues, source: 'structured', baselines: [] };
    }
    const summary = normalizeStructuredRows(structured.summaryRows, structured.summaryColumns, { ...config, pidWhitelist: query.pids }, date, 'structured', query.includeReattribution, options);
    const merged = mergeOverviewRows(normalized.rows, summary.rows);
    return {
      rows: merged.rows,
      detailRows: normalized.rows,
      pidSummaryRows: summary.rows,
      issues: [...normalized.issues, ...summary.issues, ...merged.issues],
      source: 'structured',
      baselines: amountBaselinesFromSummaryRows(summary.rows),
    };
  }

  private async waitForCondition(read: () => Promise<boolean>, timeout = 3_000): Promise<boolean> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await read()) return true;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    return false;
  }

  private async clickControlUntil(target: ReportFrameControl, stage: string, read: () => Promise<boolean>, value?: string, clickModes: ReportFrameClickMode[] = [...REPORT_FRAME_CLICK_MODES]): Promise<void> {
    for (const mode of clickModes) {
      try {
        await this.clickReportFrameControl(target, mode, value);
        if (await this.waitForCondition(read)) {
          await this.diagnostics.event(stage, { mode, result: 'true' });
          return;
        }
      } catch {
        // Only real browser/OS input paths are attempted.
      }
      await this.diagnostics.event(stage, { mode, result: 'false' });
    }
    throw new ConnectorError('QUERY_CONDITIONS_NOT_APPLIED', '后台查询控件未能通过真实点击完成操作，请刷新后台页面后重试。');
  }

  private async visibleDateInputCount(): Promise<number> {
    return this.execute<number>(`${findActiveReportFrame.toString()}
      (()=>{
      const doc = findActiveReportFrame()?.contentDocument;
      const visible = (element) => {
        const node = element;
        const style = doc?.defaultView?.getComputedStyle(node);
        return (node.offsetParent !== null || node.getClientRects().length > 0) && style?.display !== 'none' && style?.visibility !== 'hidden';
      };
      return Array.from(doc?.querySelectorAll('input[aria-label="日期"]') ?? []).filter(visible).length;
    })()`, 'filters.date.input-count').catch(() => 0);
  }

  private async readDatePickerYear(): Promise<number | null> {
    const header = await this.execute<string>(`${findActiveReportFrame.toString()}
      (${function readHeader() {
      const doc = findActiveReportFrame()?.contentDocument;
      const visible = (element: Element) => {
        const node = element as HTMLElement;
        const style = doc?.defaultView?.getComputedStyle(node);
        return (node.offsetParent !== null || node.getClientRects().length > 0) && style?.display !== 'none' && style?.visibility !== 'hidden';
      };
      const button = Array.from(doc?.querySelectorAll('button') ?? [])
        .filter(visible)
        .find((element) => String((element as HTMLElement).className || '').includes('DatePicker-calendarHeaderLevel'));
      return ((button as HTMLElement | undefined)?.innerText || button?.textContent || '').trim();
    }})()`, 'filters.date.year-readback').catch(() => '');
    return datePickerYearFromHeader(header);
  }

  private async hasDateMonthOptions(): Promise<boolean> {
    return this.execute<boolean>(`${findActiveReportFrame.toString()}
      (${function hasMonthOptions() {
      const doc = findActiveReportFrame()?.contentDocument;
      const visible = (element: Element) => {
        const node = element as HTMLElement;
        const style = doc?.defaultView?.getComputedStyle(node);
        return (node.offsetParent !== null || node.getClientRects().length > 0) && style?.display !== 'none' && style?.visibility !== 'hidden';
      };
      return Array.from(doc?.querySelectorAll('button') ?? [])
        .filter(visible)
        .filter((element) => String((element as HTMLElement).className || '').includes('DatePicker-monthsListControl')).length === 12;
    }})()`, 'filters.date.month-options').catch(() => false);
  }

  private async hasDateOption(value: string): Promise<boolean> {
    const dayAriaLabel = JSON.stringify(datePickerDayAriaLabel(value));
    return this.execute<boolean>(`${findActiveReportFrame.toString()}
      (${function hasDayOption(label: string) {
      const doc = findActiveReportFrame()?.contentDocument;
      const visible = (element: Element) => {
        const node = element as HTMLElement;
        const style = doc?.defaultView?.getComputedStyle(node);
        return (node.offsetParent !== null || node.getClientRects().length > 0) && style?.display !== 'none' && style?.visibility !== 'hidden';
      };
      return Array.from(doc?.querySelectorAll('button') ?? [])
        .filter(visible)
        .some((element) => String((element as HTMLElement).className || '').includes('DatePicker-day') && element.getAttribute('aria-label') === label);
    }})(${dayAriaLabel})`, 'filters.date.day-option').catch(() => false);
  }

  private async navigateDatePickerYear(value: string, label: string): Promise<void> {
    const targetYear = Number(value.slice(0, 4));
    let currentYear = await this.readDatePickerYear();
    if (!currentYear) throw new ConnectorError('QUERY_CONDITIONS_NOT_APPLIED', `后台“${label}”日期年份未能读取，请刷新后台页面后重试。`);
    const direction = currentYear < targetYear ? 'date-next' : 'date-previous';
    const step = currentYear < targetYear ? 1 : -1;
    while (currentYear !== targetYear) {
      const previousYear: number = currentYear;
      await this.clickControlUntil(direction, `filters.date.year.${direction}`, async () => (await this.readDatePickerYear()) === previousYear + step);
      currentYear = previousYear + step;
    }
  }

  private async setReportDate(target: Extract<ReportFrameControl, 'date-start' | 'date-end' | 'date-payment'>, value: string, label: string): Promise<void> {
    if (await this.visibleDateInputCount() !== 0) {
      throw new ConnectorError('QUERY_CONDITIONS_NOT_APPLIED', `后台“${label}”日期面板未正常关闭，请刷新后台页面后重试。`);
    }
    await this.clickControlUntil(target, `filters.date.open.${target}`, async () => (await this.visibleDateInputCount()) === 1);
    await this.clickControlUntil('date-level', `filters.date.level.${target}`, () => this.hasDateMonthOptions());
    await this.navigateDatePickerYear(value, label);
    await this.clickControlUntil('date-month-option', `filters.date.month.${target}`, () => this.hasDateOption(value), `${Number(value.slice(5, 7))}月`);
    await this.clickControlUntil('date-option', `filters.date.select.${target}`, async () => (await this.visibleDateInputCount()) === 0, value);
  }

  private async hasIncomeOption(label: string): Promise<boolean> {
    const payload = JSON.stringify(label);
    return this.execute<boolean>(`${findActiveReportFrame.toString()}
      ((${function hasOption(value: string) {
      const doc = findActiveReportFrame()?.contentDocument;
      const visible = (element: Element) => {
        const node = element as HTMLElement;
        const style = doc?.defaultView?.getComputedStyle(node);
        return (node.offsetParent !== null || node.getClientRects().length > 0) && style?.display !== 'none' && style?.visibility !== 'hidden';
      };
      const textOf = (element: Element) => ((element as HTMLElement).innerText || element.textContent || '').replace(/\s+/gu, '').trim();
      return Array.from(doc?.querySelectorAll('[role="dialog"],[role="listbox"],[role="menu"]') ?? [])
        .filter(visible)
        .flatMap((container) => Array.from(container.querySelectorAll('[role="option"],button,label,li,[data-value],span,div')))
        .filter(visible)
        .some((element) => {
          const text = textOf(element);
          return text === value || text.endsWith(`:${value}`) || text.endsWith(`：${value}`);
        });
    }})(${payload}))`, 'filters.income.option-state').catch(() => false);
  }

  private async hasIncomeLabelSelected(label: string): Promise<boolean> {
    const payload = JSON.stringify(label);
    return this.execute<boolean>(`${findActiveReportFrame.toString()}
      ((${function hasSelected(value: string) {
      const doc = findActiveReportFrame()?.contentDocument;
      const visible = (element: Element) => {
        const node = element as HTMLElement;
        return node.offsetParent !== null || node.getClientRects().length > 0;
      };
      const textOf = (element: Element) => ((element as HTMLElement).innerText || element.textContent || '').replace(/\s+/gu, '').trim();
      return Array.from(doc?.querySelectorAll('button') ?? []).filter(visible)
        .some((element) => textOf(element).includes('收入类型') && textOf(element).includes(value));
    }})(${payload}))`, 'filters.income.selected-state').catch(() => false);
  }

  private async setReportFilters(query: ReportQuery): Promise<void> {
    await this.waitForReportPage('filters.page-interactive');
    const datePickerCountBefore = await this.visibleDateInputCount();
    await this.setReportDate('date-start', query.startDate, '开始日期');
    await this.setReportDate('date-end', query.endDate, '结束日期');
    await this.setReportDate('date-payment', query.paymentStatsEndDate, '付费统计结束日期');
    const incomeLabel = incomeLabelForType(query.incomeType);
    await this.clickControlUntil('income-selector', 'filters.income.open', () => this.hasIncomeOption(incomeLabel));
    await this.clickControlUntil('income-option', 'filters.income.select', () => this.hasIncomeLabelSelected(incomeLabel), incomeLabel);
    await this.diagnostics.event('filters.report.readback', {
      datePickerCountBefore,
      datePickerCountAfter: await this.visibleDateInputCount(),
    });
  }

  private async prepareDailyOverview(query: ReportQuery): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.openOverviewPage(query.gameId, query.gameVersionId, query.includeReattribution, true);
        await this.setReportFilters(query);
        await this.setPidFilters(query.pids);
        await this.waitForReportPage('overview.pid-page-ready');
        return;
      } catch (error) {
        if (!shouldRetryDailyPageSetup(error, attempt)) throw error;
        await this.diagnostics.event('overview.day.setup-retry', {
          stage: 'daily-page-setup',
          code: error.code,
          result: 'retry',
        });
      }
    }
  }

  private async pullOverviewDaily(query: ReportQuery, config: ProjectConfig, onProgress?: (value: number) => void, options: PullOptions = {}): Promise<ReportData> {
    const dates = dateRange(query.startDate, query.endDate);
    if (dates.length === 0) throw new ConnectorError('INVALID_DATE_RANGE', '开始日期不能晚于结束日期，请重新选择日期范围。');
    const rows: RawAdRow[] = [];
    const detailRows: RawAdRow[] = [];
    const pidSummaryRows: RawAdRow[] = [];
    const issues: ReportData['issues'] = [];
    for (const [index, date] of dates.entries()) {
      const dayQuery = buildDailyQuery(query, date);
      await this.diagnostics.event('overview.day.started', { mode: 'single-day' });
      await this.prepareDailyOverview(dayQuery);
      const batch = await this.clickQuery();
      onProgress?.((index + 0.55) / dates.length);
      const report = await this.readQueryBatch(date, dayQuery, config, batch, options, true);
      rows.push(...report.rows);
      detailRows.push(...(report.detailRows ?? report.rows.filter((row) => Boolean(row.radid))));
      pidSummaryRows.push(...(report.pidSummaryRows ?? []));
      issues.push(...report.issues);
      await this.diagnostics.event('overview.day.succeeded', { mode: 'single-day', rows: report.rows.length });
      onProgress?.((index + 1) / dates.length);
    }
    let baselines: ValidationBaseline[] = [];
    try {
      onProgress?.(0.95);
      // The last daily query already submitted and verified the PID filter. Keep
      // that page state for the authoritative range baseline; reloading here
      // would force a second fragile PID-dialog submission without changing the
      // selected project or PID set.
      await this.openOverviewPage(query.gameId, query.gameVersionId, query.includeReattribution, false);
      await this.setReportFilters(query);
      await this.diagnostics.event('overview.range-baseline.reused-pid-filter', { result: 'true' });
      await this.waitForReportPage('overview.range-baseline-page-ready');
      const batch = await this.clickQuery();
      const range = await this.readQueryBatch(query.startDate, query, config, batch, options, false);
      baselines = range.baselines ?? [];
      if (!baselines.some((baseline) => baseline.available !== false)) {
        issues.push({ level: 'warning', code: 'amount_baseline_unavailable', message: '后台未返回可用于日期范围金额核对的权威 PID 汇总数据，已跳过金额差异校验。' });
      }
      onProgress?.(1);
    } catch (error) {
      await this.diagnostics.error('overview.range-baseline.failed', error);
      issues.push({ level: 'warning', code: 'amount_baseline_unavailable', message: '后台日期范围汇总读取失败，已跳过金额差异校验，不影响本次报表生成。' });
    }
    return { rows, detailRows, pidSummaryRows, issues, source: 'structured', baselines };
  }

  async pull(query: ReportQuery, config: ProjectConfig, onProgress?: (value: number) => void, options: PullOptions = {}): Promise<ReportData> {
    await this.diagnostics.begin();
    await this.diagnostics.event('pull.started');
    try {
      const report = await this.pullOverviewDaily(query, config, onProgress, options);
      if (report.rows.length === 0) throw new ConnectorError('EMPTY_REPORT_DATA', '后台查询完成，但没有识别到符合当前 PID、日期和筛选条件的数据。请检查筛选条件后重试。');
      return report;
    } catch (error) {
      await this.diagnostics.error('overview.daily.failed', error);
      if (error instanceof ConnectorError && ['NOT_LOGGED_IN', 'PID_FILTER_NOT_APPLIED', 'QUERY_CONDITIONS_NOT_APPLIED', 'QUERY_RESULT_TIMEOUT', 'TARGET_PID_NOT_FOUND', 'DETAIL_CARD_UNAVAILABLE', 'EMPTY_REPORT_DATA'].includes(error.code)) throw error;
      throw new ConnectorError('DATA_SOURCE_UNAVAILABLE', '广告概览逐日数据读取失败，请检查后台登录状态、筛选条件和导出权限后重试。');
    }
  }
}
