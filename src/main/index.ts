import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray, WebContentsView } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { ConfigStore } from './config-store';
import { SessionVault } from './security-store';
import { ConnectorError, isSelectedVersionCurrent, Q1Connector, type BrowserHost } from './q1-connector';
import { createDefaultProjectConfig } from '../shared/defaults';
import type { FilterTemplate, ProjectConfig, RealtimeQuery, ReportQuery } from '../shared/contracts';
import { parsePidInput, validatePids, validateRealtimePids } from '../domain/pid';
import { writeWorkbook } from '../export/workbook';
import { buildRealtimeText } from '../engine/realtime';
import { parseCaptureProbe, type CaptureProbeRequest } from './capture-probe';

const currentDir = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let vault: SessionVault;
let connector: Q1Connector | null = null;
let isExplicitQuit = false;
const configStore = new ConfigStore();
const BROWSER_PANEL_WIDTH = 480;
const BROWSER_TOOLBAR_HEIGHT = 82;
const OPS_ORIGIN = 'https://ops.q1.com';
const captureProbe = parseCaptureProbe(process.env.OPS_REPORT_CAPTURE_PROBE);

function applicationIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.ico')
    : join(app.getAppPath(), 'build', 'icon.ico');
}

interface BrowserTab {
  id: string;
  view: WebContentsView;
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
      x: Math.max(0, width - BROWSER_PANEL_WIDTH),
      y: BROWSER_TOOLBAR_HEIGHT,
      width: Math.min(BROWSER_PANEL_WIDTH, width),
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
  if (active && isOpsUrl(active.view.webContents.getURL())) return active;
  return browserTabs.find((tab) => isOpsUrl(tab.view.webContents.getURL())) ?? null;
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
  const tab: BrowserTab = {
    id: `browser-tab-${Date.now()}-${browserTabSequence += 1}`,
    view,
    connector: new Q1Connector(new EmbeddedBrowserHost(view)),
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
  if (activate || !activeBrowserTabId) {
    browserPanelOpen = true;
    activateBrowserTab(tab.id);
  } else {
    view.setVisible(false);
    sendBrowserState();
  }
  await view.webContents.loadURL(url);
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
  if (!tab) tab = await createBrowserTab(`${OPS_ORIGIN}/`, true);
  else activateBrowserTab(tab.id);
  browserPanelOpen = true;
  layoutBrowserViews();
  sendBrowserState();
  if (!isOpsUrl(tab.view.webContents.getURL())) await tab.view.webContents.loadURL(`${OPS_ORIGIN}/`);
  tab.view.webContents.focus();
}

async function getOperationalConnector(): Promise<Q1Connector> {
  const tab = operationalBrowserTab();
  if (tab) {
    activateBrowserTab(tab.id);
    browserPanelOpen = true;
    layoutBrowserViews();
    return tab.connector;
  }
  await openLogin();
  if (!connector) throw new ConnectorError('NOT_LOGGED_IN', '请先在内置浏览器中登录运营后台。');
  return connector;
}

async function clearBrowserTabs(): Promise<void> {
  for (const tab of [...browserTabs]) {
    if (mainWindow) mainWindow.contentView.removeChildView(tab.view);
    tab.view.setVisible(false);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  }
  browserTabs.length = 0;
  activeBrowserTabId = null;
  connector = null;
  browserPanelOpen = false;
  sendBrowserState();
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
  const activeConnector = await getOperationalConnector();
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
  await activeConnector.pull({
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
  });
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('app:progress', { phase: 'done', value: 1, message: '后台读取探测完成' });
  }
}

function registerIpc(): void {
  ipcMain.handle('app:open-login', async () => { await openLogin(); return true; });
  ipcMain.handle('app:login-status', async () => {
    const tab = operationalBrowserTab();
    if (!tab) return false;
    connector = tab.connector;
    return tab.connector.isLoggedIn();
  });
  ipcMain.handle('app:hide-browser', async () => { hideBrowserPanel(); return true; });
  ipcMain.handle('app:show-browser', async () => showBrowserPanel());
  ipcMain.handle('app:clear-session', async () => { await vault.clear(); await clearBrowserTabs(); return true; });
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
  ipcMain.handle('app:load-filter-templates', async () => configStore.loadFilterTemplates());
  ipcMain.handle('app:save-filter-templates', async (_event, templates: FilterTemplate[]) => configStore.saveFilterTemplates(templates));
  ipcMain.handle('app:resolve-version', async (_event, gameId: string) => {
    try {
      const activeConnector = await getOperationalConnector();
      const candidates = await activeConnector.resolveVersionCandidates(gameId);
      if (candidates.length === 0) return { ok: false, error: { code: 'NO_VALID_GAME_VERSION', message: '后台没有返回当前 gameid 的有效版本，暂时无法生成。请刷新后台登录状态后重试。' }, candidates };
      if (candidates.length > 1) return { ok: false, error: { code: 'AMBIGUOUS_GAME_VERSION', message: '后台检测到多个有效版本，请在下方选择本次要使用的版本。' }, candidates };
      return { ok: true, version: candidates[0], candidates };
    } catch (error) { return { ok: false, error: friendlyError(error) }; }
  });
  ipcMain.handle('app:lookup-pids', async (_event, gameId: string, gameVersionId: string, input: string, config: ProjectConfig) => {
    try {
      const activeConnector = await getOperationalConnector();
      const directory = await activeConnector.lookupPids(gameId, gameVersionId);
      return { ok: true, directory, validation: validatePids(gameId, input, directory, config) };
    } catch (error) { return { ok: false, error: friendlyError(error) }; }
  });
  ipcMain.handle('app:generate', async (event, query: ReportQuery, config: ProjectConfig) => {
    try {
      const activeConnector = await getOperationalConnector();
      const pids = parsePidInput(query.pids.join(','));
      if (pids.length === 0) throw new ConnectorError('MISSING_PID', '至少填写一个 PID。');
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(query.paymentStatsEndDate)) throw new ConnectorError('INVALID_PAYMENT_STATS_END_DATE', '付费统计结束日期格式不正确，请重新选择。');
      const currentVersions = await activeConnector.resolveVersionCandidates(query.gameId);
      if (!isSelectedVersionCurrent(currentVersions, query.gameId, query.gameVersionId)) {
        throw new ConnectorError('STALE_GAME_VERSION', '保存或已选择的 gameVersionID 已不在后台当前有效版本中，请重新读取版本并验证 PID。');
      }
      const outputDirectory = config.outputDirectory || app.getPath('downloads');
      const outputPath = await nextOutputPath(outputDirectory, reportFileName(config, query));
      event.sender.send('app:progress', { phase: 'pull', value: 0, message: '正在从后台读取数据…' });
      const data = await activeConnector.pull({ ...query, pids }, config, (value) => event.sender.send('app:progress', { phase: 'pull', value: value * 0.75, message: '正在从后台读取数据…' }));
      event.sender.send('app:progress', { phase: 'export', value: 0.75, message: '正在生成 Excel…' });
      await writeWorkbook(data.rows, config, outputPath, (value) => event.sender.send('app:progress', { phase: 'export', value: 0.75 + value * 0.25, message: '正在生成 Excel…' }), data.issues, data.baselines ?? [], {
        includePitcherDetails: query.includePitcherDetails,
        detailRows: data.detailRows,
        pidSummaryRows: data.pidSummaryRows,
      });
      event.sender.send('app:progress', { phase: 'done', value: 1, message: '生成完成' });
      return { ok: true, path: outputPath, rowCount: data.rows.length, source: data.source, issues: data.issues };
    } catch (error) { return { ok: false, error: friendlyError(error) }; }
  });
  ipcMain.handle('app:generate-realtime', async (event, query: RealtimeQuery) => {
    try {
      const activeConnector = await getOperationalConnector();
      if (!/^\d{4,}$/u.test(query.gameId)) throw new ConnectorError('INVALID_GAME_ID', 'gameid 必须填写数字。');
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(query.paymentStatsEndDate)) throw new ConnectorError('INVALID_PAYMENT_STATS_END_DATE', '付费统计结束日期格式不正确，请重新选择。');
      const directory = await activeConnector.lookupPids(query.gameId, query.gameVersionId);
      const validation = validateRealtimePids(query.gameId, query.pidInput, directory);
      const firstError = validation.issues.find((issue) => issue.level === 'error');
      if (firstError) throw new ConnectorError('INVALID_REALTIME_PID', firstError.message);
      event.sender.send('app:progress', { phase: 'realtime', value: 0, message: '正在读取实时 BI 数据…' });
      const realtimePullConfig = createDefaultProjectConfig();
      realtimePullConfig.pidWhitelist = validation.accepted;
      realtimePullConfig.pidNames = validation.pidNames;
      const data = await activeConnector.pull({
        gameId: query.gameId,
        gameVersionId: query.gameVersionId,
        pids: validation.accepted,
        startDate: query.startDate,
        endDate: query.endDate,
        paymentStatsEndDate: query.paymentStatsEndDate,
        incomeType: query.incomeType,
        includeReattribution: query.includeReattribution,
        includePitcherDetails: false,
      }, realtimePullConfig, (value) => event.sender.send('app:progress', { phase: 'realtime', value, message: '正在读取实时 BI 数据…' }), { allowUnclassified: true });
      const text = buildRealtimeText(data.rows, {
        pids: validation.accepted,
        pidNames: validation.pidNames,
        titleTemplate: query.titleTemplate,
        metricOrder: query.metricOrder,
      });
      event.sender.send('app:progress', { phase: 'done', value: 1, message: '实时播报已生成' });
      return { ok: true, text, rowCount: data.rows.length, issues: data.issues };
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
  Menu.setApplicationMenu(null);
  app.setAppUserModelId('com.q1.ops-report-generator');
  vault = new SessionVault();
  await vault.restore();
  registerIpc();
  createTray();
  await createMainWindow();
  if (captureProbe) {
    void runCaptureProbe(captureProbe).catch((error) => {
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('app:progress', { phase: 'done', value: 0, message: friendlyError(error).message });
      }
    });
  }
  app.on('activate', () => { void showMainWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { isExplicitQuit = true; });
