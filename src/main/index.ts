import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray, WebContentsView } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ConfigStore } from './config-store';
import { SessionVault } from './security-store';
import { ConnectorError, isSelectedVersionCurrent, Q1Connector, type BrowserHost } from './q1-connector';
import { beijingToday, createDefaultProjectConfig } from '../shared/defaults';
import type { DeliveryTarget, DeliveryTargetInput, DingTalkLoginQrInput, FilterTemplate, LoginCredentialInput, ProjectConfig, ProjectConfigSection, RawAdRow, RealtimeQuery, ReportQuery, ScheduledReport, ScheduledExecutionRecord, TaskQueueKind, ValidationIssue } from '../shared/contracts';
import { parsePidInput, validatePids, validateRealtimePids } from '../domain/pid';
import { writeWorkbook } from '../export/workbook';
import { buildRealtimeBroadcastText, buildRealtimeText } from '../engine/realtime';
import { parseCaptureProbe, type CaptureProbeRequest } from './capture-probe';
import { DeliverySecretVault } from './delivery-secret-vault';
import { DeliveryError, sendDeliveryMessage } from './delivery-client';
import { DingTalkAppBotError, sendDingTalkAppBotImage, sendDingTalkAppBotText } from './dingtalk-app-bot-client';
import { ScheduledReportService, type ScheduledReportExecutionOutcome } from './scheduled-report-service';
import { AsyncMutex } from './query-lock';
import { TaskQueue, TaskQueueCancelledError, type TaskQueueRunContext } from './task-queue';
import { LoginCredentialVault } from './login-credential-vault';
import { DingTalkLoginQrVault } from './dingtalk-login-qr-vault';
import { DingTalkLoginQrBindingError, DingTalkLoginQrBindingService } from './dingtalk-login-qr-binding';

const currentDir = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let vault: SessionVault;
let deliverySecretVault: DeliverySecretVault;
let loginCredentialVault: LoginCredentialVault;
let dingTalkLoginQrVault: DingTalkLoginQrVault;
let dingTalkLoginQrBindingService: DingTalkLoginQrBindingService;
let scheduledReportService: ScheduledReportService | null = null;
let connector: Q1Connector | null = null;
const biQueryLock = new AsyncMutex();
const taskQueue = new TaskQueue();
let isExplicitQuit = false;
const configStore = new ConfigStore();
const BROWSER_DRAWER_WIDTH = 420;
const BROWSER_TOOLBAR_HEIGHT = 82;
const OPS_ORIGIN = 'https://ops.q1.com';
const captureProbe = parseCaptureProbe(process.env.OPS_REPORT_CAPTURE_PROBE);
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const LOGIN_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
let loginRefreshTimer: NodeJS.Timeout | null = null;
let lastDingTalkQrSentAt = 0;
let lastLoginRecoveryAttemptAt = 0;

if (!hasSingleInstanceLock) app.quit();

function sendTaskState(): void {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('app:task-state', { active: taskQueue.hasRunningTask(), queued: taskQueue.pendingCount() });
}

function sendTaskQueueState(items = taskQueue.snapshot()): void {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('app:task-queue-state', items);
}

function sendLoginState(loggedIn: boolean): void {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('app:login-state', { loggedIn });
}

function sendScheduledProgress(phase: string, value: number, message: string): void {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('app:progress', { phase, value, message });
}

function throwIfTaskCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ConnectorError('TASK_CANCELLED', '当前任务已终止。');
}

async function runCancellableTask<T>(name: string, kind: TaskQueueKind, task: (context: TaskQueueRunContext) => Promise<T>): Promise<T> {
  return taskQueue.enqueue({
    name,
    kind,
    run: async (context) => {
      try {
        return await task(context);
      } catch (error) {
        if (context.signal.aborted) throw new ConnectorError('TASK_CANCELLED', '当前任务已终止。');
        throw error;
      }
    },
  });
}

function cancelCurrentTasks(): boolean {
  return taskQueue.cancelCurrentTask();
}

taskQueue.onChange((items) => {
  sendTaskState();
  sendTaskQueueState(items);
});

function applicationIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.ico')
    : join(app.getAppPath(), 'build', 'icon.ico');
}

interface BrowserTab {
  id: string;
  view: WebContentsView;
  host: EmbeddedBrowserHost;
  connector: Q1Connector;
  title: string;
  url: string;
}

interface BrowserTabState {
  id: string;
  title: string;
  url: string;
  active: boolean;
}

interface BrowserState {
  open: boolean;
  tabs: BrowserTabState[];
}

type BrowserCommandResult =
  | { ok: true; state: BrowserState }
  | { ok: false; error: { code: string; message: string } };

const browserTabs: BrowserTab[] = [];
let activeBrowserTabId: string | null = null;
let browserPanelOpen = false;
let browserTabSequence = 0;

function friendlyError(error: unknown): { code: string; message: string } {
  if (error instanceof ConnectorError) return { code: error.code, message: error.message };
  if (error instanceof TaskQueueCancelledError) return { code: error.code, message: error.message };
  if (error instanceof DingTalkAppBotError) {
    const diagnostic = [
      error.httpStatus === undefined ? '' : `HTTP 状态：${error.httpStatus}`,
      error.providerCode ? `钉钉错误码：${error.providerCode}` : '',
    ].filter(Boolean).join('；');
    const label = error.code.includes('TOKEN') ? '企业机器人鉴权失败'
      : error.code.includes('MEDIA') ? '二维码上传到钉钉失败'
        : error.code.includes('MESSAGE') ? '企业机器人向目标群发送失败'
          : error.code === 'DINGTALK_APP_BOT_NETWORK_ERROR' ? '企业机器人网络请求失败'
            : '企业机器人调用失败';
    return { code: error.code, message: `${label}${diagnostic ? `（${diagnostic}）` : ''}。请检查企业应用凭据、机器人编码、接收群绑定和应用权限后重试。` };
  }
  if (error instanceof DingTalkLoginQrBindingError) {
    if (error.code === 'DINGTALK_BIND_TIMEOUT') return { code: error.code, message: '等待绑定超时。请确认机器人已加入目标群、应用已开启 Stream 模式，然后重新点击“绑定接收群”。' };
    if (error.code === 'DINGTALK_BIND_CONNECTION_FAILED') return { code: error.code, message: '无法连接钉钉的消息接收服务。请检查网络、AppKey、AppSecret，以及钉钉后台是否已开启 Stream 模式。' };
    return { code: error.code, message: '当前正在等待另一次群绑定，请完成或等待它超时后再试。' };
  }
  if (error instanceof DeliveryError) {
    const diagnostic = [
      error.providerHttpStatus === undefined ? '' : `HTTP 状态：${error.providerHttpStatus}`,
      error.providerErrorCode ? `钉钉错误码：${error.providerErrorCode}` : '',
    ].filter(Boolean).join('；');
    return { code: error.code, message: `机器人投递失败${diagnostic ? `（${diagnostic}）` : ''}。请检查 Webhook、签名密钥和群机器人状态后重试。` };
  }
  if (error instanceof Error && error.message === 'ENCRYPTION_UNAVAILABLE') return { code: error.message, message: '当前系统没有可用的安全加密存储，无法保存登录凭据。' };
  if (error instanceof Error && error.message === 'INVALID_LOGIN_CREDENTIALS') return { code: error.message, message: '请填写账号和密码后再保存。' };
  if (error instanceof Error && error.message === 'INVALID_DINGTALK_LOGIN_QR') return { code: error.message, message: '请完整填写钉钉企业机器人 AppKey、AppSecret 和机器人编码后再保存。' };
  if (error instanceof Error && error.message === 'DINGTALK_QR_CONFIG_REQUIRED') return { code: error.message, message: '请先保存钉钉企业机器人配置，再绑定接收群。' };
  return { code: 'UNEXPECTED_ERROR', message: '操作失败，请稍后重试。如果问题持续存在，请联系管理员。' };
}

class EmbeddedBrowserHost implements BrowserHost {
  constructor(private readonly view: WebContentsView) {}

  get webContents() {
    return this.view.webContents;
  }

  isDestroyed(): boolean {
    return this.view.webContents.isDestroyed();
  }

  focus(): void {
    this.view.webContents.focus();
  }

  loadURL(url: string): Promise<void> {
    return this.view.webContents.loadURL(url);
  }
}

function isOpsUrl(url: string): boolean {
  return url === OPS_ORIGIN || url.startsWith(`${OPS_ORIGIN}/`);
}

function isOperationalBrowserUrl(url: string): boolean {
  return isOpsUrl(url)
    || url.startsWith('https://sso-auth.q1.com/')
    || url.startsWith('https://login.dingtalk.com/');
}

function browserTitle(url: string): string {
  if (isOpsUrl(url)) return '运营后台';
  try { return new URL(url).hostname || '新标签页'; } catch { return '新标签页'; }
}

function browserState(): BrowserState {
  return {
    open: browserPanelOpen && browserTabs.length > 0,
    tabs: browserTabs.map((tab) => ({ id: tab.id, title: tab.title, url: tab.url, active: tab.id === activeBrowserTabId })),
  };
}

function sendBrowserState(): void {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('app:browser-state', browserState());
}

function layoutBrowserViews(): void {
  if (!mainWindow) return;
  const [width, height] = mainWindow.getContentSize();
  for (const tab of browserTabs) {
    if (tab.view.webContents.isDestroyed()) continue;
    tab.view.setBounds({
      x: Math.max(0, width - BROWSER_DRAWER_WIDTH),
      y: BROWSER_TOOLBAR_HEIGHT,
      width: Math.min(BROWSER_DRAWER_WIDTH, width),
      height: Math.max(0, height - BROWSER_TOOLBAR_HEIGHT),
    });
    tab.view.setVisible(browserPanelOpen && tab.id === activeBrowserTabId);
  }
}

function activateBrowserTab(id: string): BrowserTab | null {
  const tab = browserTabs.find((candidate) => candidate.id === id) ?? null;
  if (!tab) return null;
  activeBrowserTabId = tab.id;
  connector = tab.connector;
  layoutBrowserViews();
  if (mainWindow) mainWindow.contentView.addChildView(tab.view);
  sendBrowserState();
  return tab;
}

function activeBrowserTab(): BrowserTab | null {
  return browserTabs.find((tab) => tab.id === activeBrowserTabId) ?? null;
}

function operationalBrowserTab(): BrowserTab | null {
  const active = activeBrowserTab();
  if (active && isOperationalBrowserUrl(active.view.webContents.getURL())) return active;
  return browserTabs.find((tab) => isOperationalBrowserUrl(tab.view.webContents.getURL())) ?? null;
}

function dingTalkBrowserTab(): BrowserTab | null {
  const active = activeBrowserTab();
  if (active && active.view.webContents.getURL().startsWith('https://login.dingtalk.com/')) return active;
  return browserTabs.find((tab) => tab.view.webContents.getURL().startsWith('https://login.dingtalk.com/')) ?? null;
}

function resolveDingTalkBrowserHost(): BrowserHost | null {
  const tab = dingTalkBrowserTab();
  if (!tab) return null;
  activateBrowserTab(tab.id);
  browserPanelOpen = true;
  layoutBrowserViews();
  return tab.host;
}

function normalizeBrowserUrl(value: string): string {
  const input = value.trim();
  if (!input) throw new ConnectorError('INVALID_BROWSER_URL', '请输入要打开的地址。');
  const candidate = /^[a-z][a-z\d+.-]*:\/\//iu.test(input) || input === 'about:blank' ? input : `https://${input}`;
  const parsed = new URL(candidate);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && candidate !== 'about:blank') {
    throw new ConnectorError('INVALID_BROWSER_URL', '地址只支持 http 或 https 页面。');
  }
  return candidate;
}

async function createBrowserTab(rawUrl = `${OPS_ORIGIN}/`, activate = true): Promise<BrowserTab> {
  if (!mainWindow) throw new ConnectorError('APP_NOT_READY', '客户端窗口尚未准备好，请稍后重试。');
  const url = normalizeBrowserUrl(rawUrl);
  const view = new WebContentsView({
    webPreferences: {
      session: vault.browserSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const host = new EmbeddedBrowserHost(view);
  const tab: BrowserTab = {
    id: `browser-tab-${Date.now()}-${browserTabSequence += 1}`,
    view,
    host,
    connector: new Q1Connector(host),
    title: browserTitle(url),
    url,
  };
  browserTabs.push(tab);
  mainWindow.contentView.addChildView(view);
  view.setBackgroundColor('#f4f6f8');
  view.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
    void createBrowserTab(popupUrl || `${OPS_ORIGIN}/`, true).catch(() => undefined);
    return { action: 'deny' };
  });
  const updateUrl = (nextUrl: string) => {
    const previousFallbackTitle = browserTitle(tab.url);
    tab.url = nextUrl || tab.view.webContents.getURL() || tab.url;
    if (!tab.title || tab.title === previousFallbackTitle) tab.title = browserTitle(tab.url);
    sendBrowserState();
  };
  view.webContents.on('did-navigate', (_event, nextUrl) => updateUrl(nextUrl));
  view.webContents.on('did-navigate-in-page', (_event, nextUrl) => updateUrl(nextUrl));
  view.webContents.on('page-title-updated', (_event, title) => {
    const nextTitle = title.trim();
    if (nextTitle) tab.title = nextTitle;
    sendBrowserState();
  });
  view.webContents.on('did-finish-load', () => {
    updateUrl(view.webContents.getURL());
    if (isOpsUrl(view.webContents.getURL())) void vault.save();
  });
  view.webContents.on('destroyed', () => {
    const index = browserTabs.findIndex((candidate) => candidate.id === tab.id);
    if (index < 0) return;
    browserTabs.splice(index, 1);
    if (activeBrowserTabId === tab.id) {
      const next = browserTabs[index] ?? browserTabs[index - 1] ?? null;
      activeBrowserTabId = next?.id ?? null;
      connector = next?.connector ?? null;
    }
    if (browserTabs.length === 0) browserPanelOpen = false;
    layoutBrowserViews();
    sendBrowserState();
  });
  if (activate) {
    browserPanelOpen = true;
    activateBrowserTab(tab.id);
  } else {
    if (!activeBrowserTabId) {
      activeBrowserTabId = tab.id;
      connector = tab.connector;
    }
    view.setVisible(false);
    sendBrowserState();
  }
  try {
    await view.webContents.loadURL(url);
  } catch (error) {
    if (!isOperationalBrowserUrl(url)) throw error;
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if (!view.webContents.isDestroyed() && isOperationalBrowserUrl(view.webContents.getURL())) return tab;
      await wait(120);
    }
    throw error;
  }
  return tab;
}

function hideBrowserPanel(): void {
  browserPanelOpen = false;
  layoutBrowserViews();
  sendBrowserState();
}

function showBrowserPanel(): BrowserState {
  browserPanelOpen = browserTabs.length > 0;
  layoutBrowserViews();
  sendBrowserState();
  return browserState();
}

async function closeBrowserTab(id: string): Promise<void> {
  const tab = browserTabs.find((candidate) => candidate.id === id);
  if (!tab) return;
  const index = browserTabs.findIndex((candidate) => candidate.id === id);
  const wasActive = activeBrowserTabId === id;
  browserTabs.splice(index, 1);
  if (mainWindow) mainWindow.contentView.removeChildView(tab.view);
  tab.view.setVisible(false);
  if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  if (wasActive) {
    const next = browserTabs[index] ?? browserTabs[index - 1] ?? null;
    activeBrowserTabId = next?.id ?? null;
    connector = next?.connector ?? null;
  }
  if (browserTabs.length === 0) {
    activeBrowserTabId = null;
    connector = null;
    browserPanelOpen = false;
  }
  layoutBrowserViews();
  if (activeBrowserTabId && browserPanelOpen) activateBrowserTab(activeBrowserTabId);
  else sendBrowserState();
}

async function openLogin(): Promise<void> {
  let tab = operationalBrowserTab();
  if (!tab) {
    try {
      tab = await createBrowserTab(`${OPS_ORIGIN}/`, true);
    } catch (error) {
      // Initial navigation may report an abort while the redirect is still completing.
      tab = operationalBrowserTab() ?? browserTabs.at(-1) ?? null;
      if (!tab) throw error;
      activateBrowserTab(tab.id);
    }
  } else activateBrowserTab(tab.id);
  browserPanelOpen = true;
  layoutBrowserViews();
  sendBrowserState();
  if (!isOpsUrl(tab.view.webContents.getURL())) {
    try {
      await tab.view.webContents.loadURL(`${OPS_ORIGIN}/`);
    } catch (error) {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        if (!tab.view.webContents.isDestroyed() && isOperationalBrowserUrl(tab.view.webContents.getURL())) break;
        await wait(120);
      }
      if (!isOperationalBrowserUrl(tab.view.webContents.getURL())) throw error;
    }
  }
  tab.view.webContents.focus();
}

async function getOperationalConnector(options: { revealBrowser?: boolean } = {}): Promise<Q1Connector> {
  const revealBrowser = options.revealBrowser !== false;
  const tab = operationalBrowserTab();
  if (tab) {
    if (revealBrowser) {
      activateBrowserTab(tab.id);
      browserPanelOpen = true;
      layoutBrowserViews();
    } else {
      connector = tab.connector;
    }
    return tab.connector;
  }
  if (!revealBrowser) {
    const hiddenTab = await createBrowserTab(`${OPS_ORIGIN}/`, false);
    connector = hiddenTab.connector;
    return hiddenTab.connector;
  }
  try {
    await openLogin();
  } catch {
    throw new ConnectorError('BROWSER_OPEN_FAILED', '内置浏览器无法打开登录页。请关闭后重新打开工具，再尝试模拟发送。');
  }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const readyTab = operationalBrowserTab();
    if (readyTab && !readyTab.view.webContents.isDestroyed()) {
      connector = readyTab.connector;
      return readyTab.connector;
    }
    await wait(120);
  }
  throw new ConnectorError('BROWSER_OPEN_FAILED', '内置浏览器正在打开登录页，请稍后再试。');
}

function reportFileName(config: ProjectConfig, query: ReportQuery): string {
  return config.fileNameRule
    .replaceAll('{gameid}', query.gameId)
    .replaceAll('{start}', query.startDate)
    .replaceAll('{end}', query.endDate)
    .replaceAll('{income}', query.incomeType === 'amount' ? '收入' : '实收')
    .replace(/[\\/:*?"<>|]/gu, '_') + '.xlsx';
}

async function nextOutputPath(directory: string, fileName: string): Promise<string> {
  await fs.mkdir(directory, { recursive: true });
  const first = join(directory, fileName);
  try { await fs.access(first); } catch { return first; }
  const dot = fileName.lastIndexOf('.');
  const stem = dot >= 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot >= 0 ? fileName.slice(dot) : '';
  for (let index = 2; index < 10000; index += 1) {
    const candidate = join(directory, `${stem}（${index}）${ext}`);
    try { await fs.access(candidate); } catch { return candidate; }
  }
  throw new Error('output path');
}

async function createMainWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1100,
    minHeight: 720,
    title: '后台数据报表生成器',
    icon: applicationIconPath(),
    webPreferences: {
      preload: join(currentDir, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) await mainWindow.loadURL(devUrl);
  else await mainWindow.loadFile(join(currentDir, '../renderer/index.html'));
  mainWindow.on('close', (event) => {
    if (isExplicitQuit) return;
    event.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.on('resize', layoutBrowserViews);
  mainWindow.webContents.on('did-finish-load', sendBrowserState);
}

async function showMainWindow(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    await createMainWindow();
    return;
  }
  mainWindow.show();
  mainWindow.focus();
  layoutBrowserViews();
}

function createTray(): void {
  const icon = nativeImage.createFromPath(applicationIconPath());
  tray = new Tray(icon);
  tray.setToolTip('后台数据报表生成器');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => { void showMainWindow(); } },
    { type: 'separator' },
    { label: '退出程序', click: () => { isExplicitQuit = true; app.quit(); } },
  ]));
  tray.on('double-click', () => { void showMainWindow(); });
}

async function runCaptureProbe(request: CaptureProbeRequest): Promise<void> {
  const activeConnector = await ensureLoggedIn({ revealBrowser: true });
  const config = await configStore.load(request.gameId);
  const currentVersions = await activeConnector.resolveVersionCandidates(request.gameId);
  const gameVersionId = config.currentGameVersionId;
  if (!gameVersionId || !isSelectedVersionCurrent(currentVersions, request.gameId, gameVersionId)) {
    throw new ConnectorError('CAPTURE_PROBE_VERSION_REQUIRED', '探测需要项目当前已确认且仍有效的 gameVersionID，请先在客户端读取版本并验证 PID。');
  }
  const directory = await activeConnector.lookupPids(request.gameId, gameVersionId);
  const validation = validatePids(request.gameId, request.pids.join(','), directory, config);
  const firstError = validation.issues.find((issue) => issue.level === 'error');
  if (firstError) throw new ConnectorError('CAPTURE_PROBE_PID_INVALID', '探测 PID 校验未通过，请先在客户端完成 PID 验证。');
  const pidNames = Object.fromEntries(validation.entries
    .filter((entry) => entry.status === 'ok')
    .map((entry) => [entry.id, entry.name]));
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('app:progress', { phase: 'pull', value: 0, message: '正在执行后台读取探测…' });
  }
  await biQueryLock.runExclusive(() => activeConnector.pull({
    gameId: request.gameId,
    gameVersionId,
    pids: validation.accepted,
    startDate: request.startDate,
    endDate: request.endDate,
    paymentStatsEndDate: request.paymentStatsEndDate,
    incomeType: request.incomeType,
    includeReattribution: request.includeReattribution,
    includePitcherDetails: false,
  }, {
    ...config,
    currentGameVersionId: gameVersionId,
    pidWhitelist: validation.accepted,
    pidNames: { ...config.pidNames, ...pidNames },
  }, (value) => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('app:progress', { phase: 'pull', value, message: '正在执行后台读取探测…' });
    }
  }));
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('app:progress', { phase: 'done', value: 1, message: '后台读取探测完成' });
  }
}

async function refreshLoggedInSession(): Promise<void> {
  const tab = operationalBrowserTab();
  if (!tab) return;
  connector = tab.connector;
  sendLoginState(await tab.connector.refreshLoginSession());
}

const RETRYABLE_CONNECTOR_ERRORS = new Set([
  'BROWSER_EXECUTION_FAILED',
  'REPORT_LOAD_TIMEOUT',
  'QUERY_CONDITIONS_NOT_APPLIED',
  'QUERY_RESULT_TIMEOUT',
  'DATA_SOURCE_UNAVAILABLE',
  'DETAIL_CARD_UNAVAILABLE',
]);
const RETRYABLE_DELIVERY_ERRORS = new Set(['DELIVERY_NETWORK_ERROR', 'DELIVERY_HTTP_ERROR', 'DELIVERY_RESPONSE_INVALID']);

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isWaitingLoginError(error: unknown): boolean {
  return error instanceof ConnectorError && ['LOGIN_SMS_REQUIRED', 'LOGIN_WAITING_USER', 'NOT_LOGGED_IN'].includes(error.code);
}

function isRetryableConnectorError(error: unknown): boolean {
  return error instanceof ConnectorError && RETRYABLE_CONNECTOR_ERRORS.has(error.code);
}

function isRetryableDeliveryError(error: unknown): boolean {
  return error instanceof DeliveryError && RETRYABLE_DELIVERY_ERRORS.has(error.code);
}

function isRetryableDingTalkAppBotError(error: unknown): boolean {
  return error instanceof DingTalkAppBotError
    && (error.code === 'DINGTALK_APP_BOT_NETWORK_ERROR' || error.httpStatus === 429 || (error.httpStatus !== undefined && error.httpStatus >= 500));
}

async function deliverDingTalkLoginQr(activeConnector: Q1Connector, testMode = false, onStage?: (stage: string) => void): Promise<void> {
  if (!testMode && Date.now() - lastDingTalkQrSentAt < 120_000 && activeConnector.currentUrl().includes('login.dingtalk.com')) {
    throw new ConnectorError('LOGIN_WAITING_USER', '账号登录需要短信验证码，已将钉钉登录二维码发送到配置的群，请扫码后等待任务自动继续。');
  }
  onStage?.('读取专用钉钉机器人配置');
  const credentials = await dingTalkLoginQrVault.get();
  if (!credentials) throw new ConnectorError('DINGTALK_QR_CONFIG_REQUIRED', '账号登录需要短信验证码，请先在“设置”页保存专用企业机器人配置并绑定接收群。');
  if (testMode) {
    onStage?.('发送【测试】提示消息');
    await sendDingTalkAppBotText(credentials, '【测试】以下将发送一张模拟的钉钉登录二维码；扫码会登录后台。');
  }
  onStage?.('打开钉钉登录页并切换到扫码登录');
  const captured = await activeConnector.openDingTalkLogin({ resolveBrowser: resolveDingTalkBrowserHost });
  let deliveryError: unknown;
  onStage?.('发送钉钉登录二维码');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await sendDingTalkAppBotImage(credentials, captured.image);
      deliveryError = undefined;
      break;
    } catch (error) {
      deliveryError = error;
      if (!isRetryableDingTalkAppBotError(error) || attempt === 2) break;
      await wait(600);
    }
  }
  if (deliveryError) throw deliveryError;
  lastDingTalkQrSentAt = Date.now();
}

async function sendDingTalkLoginQr(activeConnector: Q1Connector): Promise<void> {
  await deliverDingTalkLoginQr(activeConnector);
  throw new ConnectorError('LOGIN_WAITING_USER', '账号登录需要短信验证码，已将钉钉登录二维码发送到配置的群，请扫码后等待任务自动继续。');
}

async function ensureLoggedIn(options: { revealBrowser?: boolean; signal?: AbortSignal; onLoginRecovery?: (message: string) => void } = {}): Promise<Q1Connector> {
  throwIfTaskCancelled(options.signal);
  const activeConnector = await getOperationalConnector({ revealBrowser: options.revealBrowser });
  if (options.signal) activeConnector.setTaskAbortSignal(options.signal);
  try {
    throwIfTaskCancelled(options.signal);
    if (await activeConnector.isLoggedIn()) {
      sendLoginState(true);
      options.onLoginRecovery?.('后台已登录，正在准备查询…');
      return activeConnector;
    }
    await activeConnector.recoverBlankAutoLoginPage(options.onLoginRecovery);
    if (await activeConnector.isLoggedIn()) {
      sendLoginState(true);
      options.onLoginRecovery?.('后台已登录，正在准备查询…');
      return activeConnector;
    }
    const currentUrl = activeConnector.currentUrl();
    if (Date.now() - lastDingTalkQrSentAt < 120_000 && currentUrl.includes('login.dingtalk.com')) {
      throw new ConnectorError('LOGIN_WAITING_USER', '钉钉登录二维码已发送到配置的群，请扫码后任务会自动继续。');
    }
    const credentials = await loginCredentialVault.get();
    if (!credentials) {
      try {
        await sendDingTalkLoginQr(activeConnector);
      } catch (error) {
        if (error instanceof ConnectorError && error.code === 'DINGTALK_QR_CONFIG_REQUIRED') {
          throw new ConnectorError('NOT_LOGGED_IN', '后台登录已失效，请先登录后台，或在“无人值守登录”中保存账号密码/配置钉钉二维码登录。');
        }
        throw error;
      }
      throw new ConnectorError('LOGIN_WAITING_USER', '已发送钉钉登录二维码，请扫码后任务会自动继续。');
    }
    const attempt = await activeConnector.loginWithCredentials(credentials.username, credentials.password);
    if (attempt.result === 'success') {
      await vault.save();
      sendLoginState(true);
      options.onLoginRecovery?.('后台已登录，正在准备查询…');
      return activeConnector;
    }
    if (attempt.result === 'needs_dingtalk') await sendDingTalkLoginQr(activeConnector);
    throw new ConnectorError(attempt.code ?? 'LOGIN_FAILED', '账号密码自动登录失败，请检查保存的账号密码。');
  } catch (error) {
    if (options.signal) activeConnector.setTaskAbortSignal();
    throw error;
  }
}

const SKIPPABLE_PITCHER_QUERY_ERRORS = new Set(['EMPTY_REPORT_DATA', 'TARGET_PID_NOT_FOUND', 'QUERY_RESULT_TIMEOUT']);

function isSkippablePitcherQueryError(error: unknown): error is ConnectorError {
  return error instanceof ConnectorError && SKIPPABLE_PITCHER_QUERY_ERRORS.has(error.code);
}

function pitcherQueryWarning(pitcherFilter: string, error?: ConnectorError): ValidationIssue {
  if (error?.code === 'QUERY_RESULT_TIMEOUT') {
    return { level: 'warning', code: 'pitcher_detail_query_timeout', message: `投手“${pitcherFilter}”的分投手明细查询超时，已跳过该投手；总体报表仍按总查询结果生成。` };
  }
  return { level: 'warning', code: 'pitcher_detail_no_data', message: `投手“${pitcherFilter}”没有返回符合当前条件的分投手明细，已跳过该投手；总体报表仍按总查询结果生成。` };
}

function startLoginRefresh(): void {
  if (loginRefreshTimer) return;
  loginRefreshTimer = setInterval(() => { void refreshLoggedInSession(); }, LOGIN_REFRESH_INTERVAL_MS);
}

function scheduledStatus(record: import('../shared/contracts').ScheduledExecutionRecord): void {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('app:scheduled-status', record);
}

async function buildRealtimeReport(query: RealtimeQuery, options: { revealBrowser?: boolean; onProgress?: (value: number) => void; onLoginRecovery?: (message: string) => void; signal?: AbortSignal } = {}): Promise<{ text: string; rowCount: number; issues: Awaited<ReturnType<Q1Connector['pull']>>['issues'] }> {
  return biQueryLock.runExclusive(async () => {
    throwIfTaskCancelled(options.signal);
    const activeConnector = await ensureLoggedIn({ revealBrowser: options.revealBrowser, signal: options.signal, onLoginRecovery: options.onLoginRecovery });
    try {
      if (!/^\d{4,}$/u.test(query.gameId)) throw new ConnectorError('INVALID_GAME_ID', 'gameid 必须填写数字。');
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(query.paymentStatsEndDate)) throw new ConnectorError('INVALID_PAYMENT_STATS_END_DATE', '付费统计结束日期格式不正确，请重新选择。');
      const versions = await activeConnector.resolveVersionCandidates(query.gameId);
      throwIfTaskCancelled(options.signal);
      if (!isSelectedVersionCurrent(versions, query.gameId, query.gameVersionId)) {
        throw new ConnectorError('STALE_GAME_VERSION', '保存的版本已不在后台当前有效版本中，请在即时播报页重新读取版本后保存定时计划。');
      }
      const directory = await activeConnector.lookupPids(query.gameId, query.gameVersionId);
      throwIfTaskCancelled(options.signal);
      const validation = validateRealtimePids(query.gameId, query.pidInput, directory);
      const firstError = validation.issues.find((issue) => issue.level === 'error');
      if (firstError) throw new ConnectorError('INVALID_REALTIME_PID', firstError.message);
      const realtimePullConfig = createDefaultProjectConfig();
      realtimePullConfig.pidWhitelist = validation.accepted;
      realtimePullConfig.pidNames = validation.pidNames;
      const requestedPitchers = [...new Set((query.pitcherFilters ?? []).map((value) => value.trim()).filter(Boolean))];
      const includePitcherDetails = query.includePitcherDetails && requestedPitchers.length > 0;
      const data = await activeConnector.pull({
        gameId: query.gameId,
        gameVersionId: query.gameVersionId,
        pids: validation.accepted,
        startDate: query.startDate,
        endDate: query.endDate,
        paymentStatsEndDate: query.paymentStatsEndDate,
        incomeType: query.incomeType,
        includeReattribution: query.includeReattribution,
        pitcherFilters: requestedPitchers,
        includePitcherDetails: false,
      }, realtimePullConfig, includePitcherDetails
        ? (value) => options.onProgress?.(value * 0.55)
        : options.onProgress, { allowUnclassified: true });
      throwIfTaskCancelled(options.signal);
      let issues = data.issues;
      const pitcherDetails: Array<{ pitcherFilter: string; text: string }> = [];
      if (includePitcherDetails) {
        for (const [index, pitcherFilter] of requestedPitchers.entries()) {
          throwIfTaskCancelled(options.signal);
          options.onProgress?.(0.55 + (index / requestedPitchers.length) * 0.45);
          try {
            const pitcherData = await activeConnector.pull({
              gameId: query.gameId,
              gameVersionId: query.gameVersionId,
              pids: validation.accepted,
              startDate: query.startDate,
              endDate: query.endDate,
              paymentStatsEndDate: query.paymentStatsEndDate,
              incomeType: query.incomeType,
              includeReattribution: query.includeReattribution,
              pitcherFilters: [pitcherFilter],
              includePitcherDetails: false,
            }, realtimePullConfig, (value) => options.onProgress?.(0.55 + ((index + value) / requestedPitchers.length) * 0.45), { allowUnclassified: true });
            const pitcherRows = pitcherData.detailRows ?? pitcherData.rows.filter((row) => row.radid.trim());
            if (pitcherRows.length === 0) {
              issues = [...issues, pitcherQueryWarning(pitcherFilter)];
              continue;
            }
            issues = [...issues, ...pitcherData.issues];
            pitcherDetails.push({
              pitcherFilter,
              text: buildRealtimeText(pitcherRows, {
                pids: validation.accepted,
                pidNames: validation.pidNames,
                titleTemplate: query.titleTemplate,
                metricOrder: query.metricOrder,
              }),
            });
          } catch (error) {
            if (!isSkippablePitcherQueryError(error)) throw error;
            issues = [...issues, pitcherQueryWarning(pitcherFilter, error)];
          }
        }
      }
      const totalText = buildRealtimeText(data.rows, {
        pids: validation.accepted,
        pidNames: validation.pidNames,
        titleTemplate: query.titleTemplate,
        metricOrder: query.metricOrder,
      });
      return {
        text: buildRealtimeBroadcastText(totalText, pitcherDetails, issues
          .filter((issue) => issue.code === 'pitcher_detail_no_data' || issue.code === 'pitcher_detail_query_timeout')
          .map((issue) => issue.message)),
        rowCount: data.rows.length,
        issues,
      };
    } finally {
      if (options.signal) activeConnector.setTaskAbortSignal();
    }
  }, options.signal);
}

function scheduledQuery(schedule: ScheduledReport): RealtimeQuery {
  const today = beijingToday();
  return {
    gameId: schedule.gameId,
    gameVersionId: schedule.gameVersionId,
    pidInput: schedule.pidInput,
    startDate: today,
    endDate: today,
    paymentStatsEndDate: today,
    incomeType: schedule.incomeType,
    includeReattribution: schedule.includeReattribution,
    pitcherFilters: [...(schedule.pitcherFilters ?? [])],
    includePitcherDetails: schedule.includePitcherDetails,
    titleTemplate: schedule.titleTemplate,
    metricOrder: schedule.metricOrder,
  };
}

function safeScheduledErrorCode(error: unknown): string {
  if (error instanceof DeliveryError || error instanceof ConnectorError) return error.code;
  if (error instanceof TaskQueueCancelledError) return error.code;
  return 'UNEXPECTED_ERROR';
}

async function executeScheduledReport(schedule: ScheduledReport): Promise<ScheduledReportExecutionOutcome> {
  sendScheduledProgress('realtime', 0, '正在读取定时汇报数据…');
  try {
    const outcome = await runCancellableTask(`定时汇报：${schedule.name}`, 'scheduled', (context) => executeScheduledReportWithSignal(schedule, context.signal, context.releaseBiQuery));
    const message = outcome.result === 'success'
      ? '定时汇报已发送。'
      : outcome.result === 'partial_failure'
        ? '定时汇报已完成，但部分机器人发送失败。'
        : outcome.code === 'TASK_CANCELLED'
          ? '定时汇报已终止。'
          : '定时汇报执行结束，请在执行记录中查看结果。';
    sendScheduledProgress('done', outcome.result === 'success' ? 1 : 0, message);
    return outcome;
  } catch (error) {
    sendScheduledProgress('done', 0, friendlyError(error).message);
    throw error;
  }
}

async function executeScheduledReportWithSignal(schedule: ScheduledReport, signal: AbortSignal, releaseBiQuery: () => void): Promise<ScheduledReportExecutionOutcome> {
  try {
    throwIfTaskCancelled(signal);
  let text = '';
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      text = (await buildRealtimeReport(scheduledQuery(schedule), {
        revealBrowser: true,
        signal,
        onProgress: (value) => sendScheduledProgress('realtime', value, '正在读取定时汇报数据…'),
        onLoginRecovery: (message) => sendScheduledProgress('login-recovery', 0, message),
      })).text;
      releaseBiQuery();
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      if (isWaitingLoginError(error)) return { result: 'waiting_login', code: safeScheduledErrorCode(error) };
      if (!isRetryableConnectorError(error) || attempt === 2) return { result: 'failed', code: safeScheduledErrorCode(error) };
      await wait(600);
    }
  }
  if (lastError || !text) return { result: 'failed', code: safeScheduledErrorCode(lastError) };
  const targets = (await configStore.loadDeliveryTargets())
    .filter((target) => target.enabled && schedule.targetIds.includes(target.id));
  if (targets.length === 0) return { result: 'failed', code: 'NO_ENABLED_TARGET' };
  let delivered = 0;
  let failureCode = 'DELIVERY_FAILED';
  for (const target of targets) {
    throwIfTaskCancelled(signal);
    let deliveredTarget = false;
    let targetError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        throwIfTaskCancelled(signal);
        const secret = await deliverySecretVault.get(target.secretId);
        if (!secret) throw new DeliveryError('DELIVERY_SECRET_NOT_FOUND');
        await sendDeliveryMessage(target, secret, text);
        delivered += 1;
        deliveredTarget = true;
        break;
      } catch (error) {
        targetError = error;
        failureCode = safeScheduledErrorCode(error);
        if (!isRetryableDeliveryError(error) || attempt === 2) break;
        await wait(600);
      }
    }
    if (deliveredTarget) continue;
    if (!targetError) failureCode = 'DELIVERY_FAILED';
  }
  if (delivered === targets.length) return { result: 'success', code: 'SENT' };
  if (delivered > 0) return { result: 'partial_failure', code: failureCode };
  return { result: 'failed', code: failureCode };
  } catch (error) {
    if ((error instanceof ConnectorError || error instanceof TaskQueueCancelledError) && error.code === 'TASK_CANCELLED') return { result: 'failed', code: error.code };
    throw error;
  }
}

function normalizeDeliveryTargetInput(input: DeliveryTargetInput): DeliveryTargetInput {
  const name = input.name.trim();
  const webhookUrl = input.webhookUrl.trim();
  const signingSecret = input.signingSecret.trim();
  if (!name) throw new ConnectorError('INVALID_DELIVERY_TARGET', '请填写机器人名称。');
  if (input.platform !== 'dingtalk' && input.platform !== 'feishu') throw new ConnectorError('INVALID_DELIVERY_TARGET', '机器人平台只能选择钉钉或飞书。');
  if ((!input.id && (!webhookUrl || !signingSecret)) || (Boolean(webhookUrl) !== Boolean(signingSecret))) {
    throw new ConnectorError('INVALID_DELIVERY_TARGET', '请同时填写机器人 Webhook 和签名密钥；编辑时两项都留空表示沿用原凭据。');
  }
  return { ...input, id: input.id?.trim() || undefined, name, webhookUrl, signingSecret };
}

function registerIpc(): void {
  ipcMain.handle('app:open-login', async () => { await openLogin(); return true; });
  ipcMain.handle('app:task-state', async () => ({ active: taskQueue.hasRunningTask(), queued: taskQueue.pendingCount() }));
  ipcMain.handle('app:task-queue-state', async () => taskQueue.snapshot());
  ipcMain.handle('app:task-queue-move', async (_event, taskId: string, direction: -1 | 1) => ({ ok: taskQueue.move(taskId, direction), state: taskQueue.snapshot() }));
  ipcMain.handle('app:task-queue-remove', async (_event, taskId: string) => ({ ok: taskQueue.remove(taskId), state: taskQueue.snapshot() }));
  ipcMain.handle('app:task-queue-cancel', async (_event, taskId: string) => ({ ok: taskQueue.cancel(taskId), state: taskQueue.snapshot() }));
  ipcMain.handle('app:cancel-current-task', async () => ({ ok: true, cancelled: cancelCurrentTasks() }));
  ipcMain.handle('app:login-status', async () => {
    const tab = operationalBrowserTab();
    if (!tab) return false;
    connector = tab.connector;
    return tab.connector.isLoggedIn();
  });
  ipcMain.handle('app:login-credential-status', async () => loginCredentialVault.status());
  ipcMain.handle('app:save-login-credentials', async (_event, input: LoginCredentialInput) => {
    try {
      return { ok: true, status: await loginCredentialVault.set(input) };
    } catch (error) { return { ok: false, error: friendlyError(error) }; }
  });
  ipcMain.handle('app:clear-login-credentials', async () => {
    await loginCredentialVault.clear();
    return { ok: true, status: { configured: false, username: '' } };
  });
  ipcMain.handle('app:dingtalk-login-qr-status', async () => dingTalkLoginQrVault.status());
  ipcMain.handle('app:save-dingtalk-login-qr', async (_event, input: DingTalkLoginQrInput) => {
    try {
      return { ok: true, status: await dingTalkLoginQrVault.set(input) };
    } catch (error) { return { ok: false, error: friendlyError(error) }; }
  });
  ipcMain.handle('app:clear-dingtalk-login-qr', async () => {
    await dingTalkLoginQrVault.clear();
    return { ok: true, status: { configured: false, groupBound: false } };
  });
  ipcMain.handle('app:bind-dingtalk-login-qr-group', async () => {
    try {
      const credentials = await dingTalkLoginQrVault.getBindingConfig();
      if (!credentials) throw new Error('DINGTALK_QR_CONFIG_REQUIRED');
      const openConversationId = await dingTalkLoginQrBindingService.bind(credentials);
      return { ok: true, status: await dingTalkLoginQrVault.bindGroup(openConversationId) };
    } catch (error) { return { ok: false, error: friendlyError(error) }; }
  });
  ipcMain.handle('app:test-dingtalk-login-text', async () => {
    try {
      const credentials = await dingTalkLoginQrVault.get();
      if (!credentials) throw new ConnectorError('DINGTALK_QR_CONFIG_REQUIRED', '请先在“设置”页保存专用企业机器人配置并绑定接收群。');
      await sendDingTalkAppBotText(credentials, '测试消息');
      return { ok: true };
    } catch (error) { return { ok: false, error: friendlyError(error) }; }
  });
  ipcMain.handle('app:test-dingtalk-login-qr', async () => {
    let stage = '打开内置浏览器';
    try {
      const activeConnector = await getOperationalConnector({ revealBrowser: true });
      stage = '确认后台未登录';
      if (await activeConnector.isLoggedIn()) throw new ConnectorError('LOGIN_ALREADY_ACTIVE', '当前后台仍处于登录状态。请先退出后台登录或清除登录状态后，再模拟发送二维码。');
      await deliverDingTalkLoginQr(activeConnector, true, (nextStage) => { stage = nextStage; });
      return { ok: true };
    } catch (error) {
      const friendly = friendlyError(error);
      return {
        ok: false,
        error: friendly.code === 'UNEXPECTED_ERROR'
          ? { code: 'DINGTALK_QR_TEST_FAILED', message: `模拟发送在“${stage}”时失败。请截图此提示发给我继续定位。` }
          : { ...friendly, message: `模拟发送在“${stage}”时失败：${friendly.message}` },
      };
    }
  });
  ipcMain.handle('app:hide-browser', async () => { hideBrowserPanel(); return true; });
  ipcMain.handle('app:show-browser', async () => showBrowserPanel());
  ipcMain.handle('app:browser-state', async () => browserState());
  ipcMain.handle('app:browser-select-tab', async (_event, id: string): Promise<BrowserCommandResult> => {
    const tab = activateBrowserTab(id);
    if (!tab) return { ok: false, error: { code: 'BROWSER_TAB_NOT_FOUND', message: '要切换的浏览器标签不存在。' } };
    browserPanelOpen = true;
    layoutBrowserViews();
    return { ok: true, state: browserState() };
  });
  ipcMain.handle('app:browser-new-tab', async (_event, url?: string): Promise<BrowserCommandResult> => {
    try {
      await createBrowserTab(url || `${OPS_ORIGIN}/`, true);
      return { ok: true, state: browserState() };
    } catch (error) { return { ok: false, error: friendlyError(error) }; }
  });
  ipcMain.handle('app:browser-close-tab', async (_event, id: string): Promise<BrowserCommandResult> => {
    await closeBrowserTab(id);
    return { ok: true, state: browserState() };
  });
  ipcMain.handle('app:browser-navigate', async (_event, value: string): Promise<BrowserCommandResult> => {
    try {
      const url = normalizeBrowserUrl(value);
      const tab = activeBrowserTab() ?? await createBrowserTab(`${OPS_ORIGIN}/`, true);
      browserPanelOpen = true;
      activateBrowserTab(tab.id);
      await tab.view.webContents.loadURL(url);
      return { ok: true, state: browserState() };
    } catch (error) { return { ok: false, error: friendlyError(error) }; }
  });
  ipcMain.handle('app:load-config', async (_event, gameId?: string) => configStore.load(gameId));
  ipcMain.handle('app:save-config', async (_event, config: ProjectConfig, gameId?: string) => configStore.save(config, gameId));
  ipcMain.handle('app:save-config-section', async (_event, config: ProjectConfig, section: ProjectConfigSection) => configStore.saveSection(config, section));
  ipcMain.handle('app:load-filter-templates', async () => configStore.loadFilterTemplates());
  ipcMain.handle('app:save-filter-templates', async (_event, templates: FilterTemplate[]) => configStore.saveFilterTemplates(templates));
  ipcMain.handle('app:load-delivery-targets', async () => configStore.loadDeliveryTargets());
  ipcMain.handle('app:save-delivery-target', async (_event, input: DeliveryTargetInput) => {
    try {
      const normalized = normalizeDeliveryTargetInput(input);
      const targets = await configStore.loadDeliveryTargets();
      const existing = normalized.id ? targets.find((target) => target.id === normalized.id) : undefined;
      if (normalized.id && !existing) throw new ConnectorError('DELIVERY_TARGET_NOT_FOUND', '要更新的机器人目标不存在。');
      const id = existing?.id ?? randomUUID();
      const target: DeliveryTarget = {
        id,
        name: normalized.name,
        platform: normalized.platform,
        enabled: normalized.enabled,
        secretId: existing?.secretId ?? `delivery-target:${id}`,
      };
      const existingSecret = existing ? await deliverySecretVault.get(existing.secretId) : null;
      if (existing && !normalized.webhookUrl && !normalized.signingSecret) {
        if (existing.platform !== normalized.platform) throw new ConnectorError('INVALID_DELIVERY_TARGET', '修改机器人平台时，请同时填写新平台对应的 Webhook 和签名密钥。');
        if (!existingSecret) throw new DeliveryError('DELIVERY_SECRET_NOT_FOUND');
      } else {
        await deliverySecretVault.set(target.secretId, { webhookUrl: normalized.webhookUrl, signingSecret: normalized.signingSecret });
      }
      return { ok: true, targets: await configStore.saveDeliveryTargets([...targets.filter((candidate) => candidate.id !== id), target]) };
    } catch (error) { return { ok: false, error: friendlyError(error) }; }
  });
  ipcMain.handle('app:delete-delivery-target', async (_event, targetId: string) => {
    try {
      const target = (await configStore.loadDeliveryTargets()).find((candidate) => candidate.id === targetId);
      if (!target) throw new ConnectorError('DELIVERY_TARGET_NOT_FOUND', '要删除的机器人目标不存在。');
      await configStore.removeDeliveryTarget(target.id);
      await deliverySecretVault.remove(target.secretId);
      return { ok: true };
    } catch (error) { return { ok: false, error: friendlyError(error) }; }
  });
  ipcMain.handle('app:test-delivery-target', async (_event, targetId: string) => {
    try {
      const target = (await configStore.loadDeliveryTargets()).find((candidate) => candidate.id === targetId);
      if (!target) throw new ConnectorError('DELIVERY_TARGET_NOT_FOUND', '要测试的机器人目标不存在。');
      const secret = await deliverySecretVault.get(target.secretId);
      if (!secret) throw new DeliveryError('DELIVERY_SECRET_NOT_FOUND');
      await sendDeliveryMessage(target, secret, '【测试】定时汇报机器人配置已验证。');
      return { ok: true };
    } catch (error) { return { ok: false, error: friendlyError(error) }; }
  });
  ipcMain.handle('app:load-scheduled-executions', async () => configStore.recentScheduledExecutions());
  ipcMain.handle('app:load-scheduled-reports', async () => configStore.listScheduledReports());
  ipcMain.handle('app:run-scheduled-report', async (_event, reportId: string) => {
    try {
      const report = await configStore.scheduledReport(reportId);
      if (!report) throw new ConnectorError('SCHEDULE_NOT_FOUND', '定时计划不存在。');
      if (!scheduledReportService) throw new ConnectorError('SCHEDULE_NOT_READY', '定时服务尚未准备好，请稍后重试。');
      return { ok: true, record: await scheduledReportService.runNow(report) };
    } catch (error) { return { ok: false, error: friendlyError(error) }; }
  });
  ipcMain.handle('app:preview-scheduled-report', async (event, reportId: string) => {
    try {
      return await runCancellableTask('定时汇报预览', 'preview', async (context) => {
        const report = await configStore.scheduledReport(reportId);
        if (!report) throw new ConnectorError('SCHEDULE_NOT_FOUND', '定时计划不存在。');
        const result = await buildRealtimeReport(scheduledQuery(report), {
          signal: context.signal,
          onProgress: (value) => event.sender.send('app:progress', { phase: 'realtime', value, message: '正在读取定时汇报预览数据…' }),
          onLoginRecovery: (message) => event.sender.send('app:progress', { phase: 'login-recovery', value: 0, message }),
        });
        context.releaseBiQuery();
        throwIfTaskCancelled(context.signal);
        event.sender.send('app:progress', { phase: 'done', value: 1, message: '定时汇报预览已生成' });
        return { ok: true, ...result };
      });
    } catch (error) { return { ok: false, error: friendlyError(error) }; }
  });
  ipcMain.handle('app:resolve-version', async (_event, gameId: string) => {
    try {
      const candidates = await biQueryLock.runExclusive(async () => {
        const activeConnector = await ensureLoggedIn({ revealBrowser: true });
        return activeConnector.resolveVersionCandidates(gameId);
      });
      if (candidates.length === 0) return { ok: false, error: { code: 'NO_VALID_GAME_VERSION', message: '后台没有返回当前 gameid 的有效版本，暂时无法生成。请刷新后台登录状态后重试。' }, candidates };
      if (candidates.length > 1) return { ok: false, error: { code: 'AMBIGUOUS_GAME_VERSION', message: '后台检测到多个有效版本，请在下方选择本次要使用的版本。' }, candidates };
      return { ok: true, version: candidates[0], candidates };
    } catch (error) { return { ok: false, error: friendlyError(error) }; }
  });
  ipcMain.handle('app:lookup-pids', async (_event, gameId: string, gameVersionId: string, input: string, config: ProjectConfig) => {
    try {
      const directory = await biQueryLock.runExclusive(async () => {
        const activeConnector = await ensureLoggedIn({ revealBrowser: true });
        return activeConnector.lookupPids(gameId, gameVersionId);
      });
      return { ok: true, directory, validation: validatePids(gameId, input, directory, config) };
    } catch (error) { return { ok: false, error: friendlyError(error) }; }
  });
  ipcMain.handle('app:generate', async (event, query: ReportQuery, config: ProjectConfig) => {
    try {
      return await runCancellableTask('生成 Excel 报表', 'report', async (context) => {
      const signal = context.signal;
      const pids = parsePidInput(query.pids.join(','));
      if (pids.length === 0) throw new ConnectorError('MISSING_PID', '至少填写一个 PID。');
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(query.paymentStatsEndDate)) throw new ConnectorError('INVALID_PAYMENT_STATS_END_DATE', '付费统计结束日期格式不正确，请重新选择。');
      const outputDirectory = config.outputDirectory || app.getPath('downloads');
      const outputPath = await nextOutputPath(outputDirectory, reportFileName(config, query));
      event.sender.send('app:progress', { phase: 'pull', value: 0, message: '正在从后台读取数据…' });
      const generation = await biQueryLock.runExclusive(async () => {
        throwIfTaskCancelled(signal);
        const activeConnector = await ensureLoggedIn({
          revealBrowser: true,
          signal,
          onLoginRecovery: (message) => event.sender.send('app:progress', { phase: 'login-recovery', value: 0, message }),
        });
        try {
          const currentVersions = await activeConnector.resolveVersionCandidates(query.gameId);
          throwIfTaskCancelled(signal);
          if (!isSelectedVersionCurrent(currentVersions, query.gameId, query.gameVersionId)) {
            throw new ConnectorError('STALE_GAME_VERSION', '保存或已选择的 gameVersionID 已不在后台当前有效版本中，请重新读取版本并验证 PID。');
          }
          const totalPullEnd = query.includePitcherDetails ? 0.55 : 0.75;
          const data = await activeConnector.pull({ ...query, pids }, config, (value) => event.sender.send('app:progress', { phase: 'pull', value: value * totalPullEnd, message: '正在从后台读取数据…' }));
          let pitcherDetailRows: RawAdRow[] | undefined;
          let reportIssues = data.issues;
          if (query.includePitcherDetails) {
            const requestedPitchers = [...new Set((query.pitcherFilters ?? []).map((value) => value.trim()).filter(Boolean))];
            const sourceRows = data.detailRows ?? data.rows.filter((row) => row.radid.trim());
            const pitcherFilters = requestedPitchers.length > 0
              ? requestedPitchers
              : [...new Set(sourceRows
                .map((row) => row.radid.split('_')[1]?.trim() ?? '')
                .filter(Boolean))];
            pitcherDetailRows = [];
            for (const [index, pitcherFilter] of pitcherFilters.entries()) {
              throwIfTaskCancelled(signal);
              event.sender.send('app:progress', {
                phase: 'pull',
                value: 0.55 + (index / Math.max(pitcherFilters.length, 1)) * 0.2,
                message: `正在读取分投手明细（${index + 1}/${pitcherFilters.length}）：${pitcherFilter}…`,
              });
              try {
                const pitcherData = await activeConnector.pull({
                  ...query,
                  pids,
                  pitcherFilters: [pitcherFilter],
                  includePitcherDetails: false,
                }, config, (value) => event.sender.send('app:progress', {
                  phase: 'pull',
                  value: 0.55 + ((index + value) / Math.max(pitcherFilters.length, 1)) * 0.2,
                  message: `正在读取分投手明细（${index + 1}/${pitcherFilters.length}）：${pitcherFilter}…`,
                }));
                const pitcherRows = pitcherData.detailRows ?? pitcherData.rows.filter((row) => row.radid.trim());
                reportIssues = [...reportIssues, ...pitcherData.issues];
                if (pitcherRows.length === 0) {
                  reportIssues = [...reportIssues, pitcherQueryWarning(pitcherFilter)];
                  continue;
                }
                pitcherDetailRows.push(...pitcherRows.filter((row) => row.radid.trim()));
              } catch (error) {
                if (!isSkippablePitcherQueryError(error)) throw error;
                reportIssues = [...reportIssues, pitcherQueryWarning(pitcherFilter, error)];
              }
            }
            event.sender.send('app:progress', { phase: 'pull', value: 0.75, message: '分投手明细读取完成，正在生成 Excel…' });
          } else {
            event.sender.send('app:progress', { phase: 'export', value: 0.75, message: '正在生成 Excel…' });
          }
          throwIfTaskCancelled(signal);
          return { data, pitcherDetailRows, reportIssues };
        } finally {
          activeConnector.setTaskAbortSignal();
        }
      }, signal);
      context.releaseBiQuery();
      throwIfTaskCancelled(signal);
      const { data, pitcherDetailRows, reportIssues } = generation;
      await writeWorkbook(data.rows, config, outputPath, (value) => event.sender.send('app:progress', { phase: 'export', value: 0.75 + value * 0.25, message: '正在生成 Excel…' }), reportIssues, data.baselines ?? [], {
        includePitcherDetails: query.includePitcherDetails,
        detailRows: data.detailRows,
        pidSummaryRows: data.pidSummaryRows,
        pitcherDetailRows,
      });
      event.sender.send('app:progress', { phase: 'done', value: 1, message: '生成完成' });
      return { ok: true, path: outputPath, rowCount: data.rows.length, source: data.source, issues: reportIssues };
      });
    } catch (error) { return { ok: false, error: friendlyError(error) }; }
  });
  ipcMain.handle('app:generate-realtime', async (event, query: RealtimeQuery) => {
    try {
      return await runCancellableTask('生成即时播报', 'realtime', async (context) => {
        event.sender.send('app:progress', { phase: 'realtime', value: 0, message: '正在读取即时 BI 数据…' });
        const result = await buildRealtimeReport(query, {
          signal: context.signal,
          onProgress: (value) => event.sender.send('app:progress', { phase: 'realtime', value, message: '正在读取即时 BI 数据…' }),
          onLoginRecovery: (message) => event.sender.send('app:progress', { phase: 'login-recovery', value: 0, message }),
        });
        context.releaseBiQuery();
        throwIfTaskCancelled(context.signal);
        event.sender.send('app:progress', { phase: 'done', value: 1, message: '即时播报已生成' });
        return { ok: true, ...result };
      });
    } catch (error) { return { ok: false, error: friendlyError(error) }; }
  });
  ipcMain.handle('app:pick-output-directory', async () => {
    const options = { properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('app:open-output-directory', async (_event, filePath: string) => { await shell.openPath(filePath); return true; });
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  Menu.setApplicationMenu(null);
  app.setAppUserModelId('com.q1.ops-report-generator');
  vault = new SessionVault();
  await vault.restore();
  deliverySecretVault = new DeliverySecretVault();
  loginCredentialVault = new LoginCredentialVault();
  dingTalkLoginQrVault = new DingTalkLoginQrVault();
  dingTalkLoginQrBindingService = new DingTalkLoginQrBindingService();
  registerIpc();
  createTray();
  await createMainWindow();
  startLoginRefresh();
  scheduledReportService = new ScheduledReportService({
    loadEnabledSchedules: () => configStore.listEnabledScheduledReports(),
    loadWaitingLoginExecutions: () => configStore.waitingLoginExecutions(),
    scheduledExecution: (slotKey) => configStore.scheduledExecution(slotKey),
    saveScheduledExecution: (record) => configStore.saveScheduledExecution(record),
    execute: executeScheduledReport,
    canRetryWaitingLogin: async (record) => {
      return biQueryLock.runExclusive(async () => {
        const existingTab = operationalBrowserTab();
        if (existingTab && await existingTab.connector.isLoggedIn()) return true;
        if (Date.now() - lastLoginRecoveryAttemptAt < 15_000) return false;
        lastLoginRecoveryAttemptAt = Date.now();
        try {
          await ensureLoggedIn({ revealBrowser: true });
          return true;
        } catch {
          return false;
        }
      });
    },
    onStatus: scheduledStatus,
  });
  scheduledReportService.start();
  if (captureProbe) {
    void runCaptureProbe(captureProbe).catch((error) => {
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('app:progress', { phase: 'done', value: 0, message: friendlyError(error).message });
      }
    });
  }
  app.on('activate', () => { void showMainWindow(); });
});

app.on('second-instance', () => { void showMainWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  isExplicitQuit = true;
  scheduledReportService?.stop();
  if (loginRefreshTimer) clearInterval(loginRefreshTimer);
  loginRefreshTimer = null;
});
