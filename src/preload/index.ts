import { contextBridge, ipcRenderer } from 'electron';
import type { DeliveryTarget, DeliveryTargetInput, DingTalkLoginQrInput, DingTalkLoginQrStatus, FilterTemplate, LoginCredentialInput, LoginCredentialStatus, ProjectConfig, ProjectConfigSection, RealtimeQuery, ReportQuery, ScheduledExecutionRecord, ScheduledReport, TaskQueueItem } from '../shared/contracts';

type BrowserTabState = { id: string; title: string; url: string; active: boolean };
type BrowserState = { open: boolean; tabs: BrowserTabState[] };
type BrowserCommandResult = { ok: true; state: BrowserState } | { ok: false; error: { code: string; message: string } };

contextBridge.exposeInMainWorld('desktopApi', {
  openLogin: (): Promise<boolean> => ipcRenderer.invoke('app:open-login'),
  hideBrowser: (): Promise<boolean> => ipcRenderer.invoke('app:hide-browser'),
  showBrowser: (): Promise<BrowserState> => ipcRenderer.invoke('app:show-browser'),
  browserState: (): Promise<BrowserState> => ipcRenderer.invoke('app:browser-state'),
  browserSelectTab: (id: string): Promise<BrowserCommandResult> => ipcRenderer.invoke('app:browser-select-tab', id),
  browserNewTab: (url?: string): Promise<BrowserCommandResult> => ipcRenderer.invoke('app:browser-new-tab', url),
  browserCloseTab: (id: string): Promise<BrowserCommandResult> => ipcRenderer.invoke('app:browser-close-tab', id),
  browserNavigate: (url: string): Promise<BrowserCommandResult> => ipcRenderer.invoke('app:browser-navigate', url),
  taskState: (): Promise<{ active: boolean; queued: number }> => ipcRenderer.invoke('app:task-state'),
  taskQueueState: (): Promise<TaskQueueItem[]> => ipcRenderer.invoke('app:task-queue-state'),
  moveTaskQueueItem: (taskId: string, direction: -1 | 1): Promise<{ ok: boolean; state: TaskQueueItem[] }> => ipcRenderer.invoke('app:task-queue-move', taskId, direction),
  removeTaskQueueItem: (taskId: string): Promise<{ ok: boolean; state: TaskQueueItem[] }> => ipcRenderer.invoke('app:task-queue-remove', taskId),
  cancelTaskQueueItem: (taskId: string): Promise<{ ok: boolean; state: TaskQueueItem[] }> => ipcRenderer.invoke('app:task-queue-cancel', taskId),
  cancelCurrentTask: (): Promise<{ ok: boolean; cancelled: boolean }> => ipcRenderer.invoke('app:cancel-current-task'),
  loginStatus: (): Promise<boolean> => ipcRenderer.invoke('app:login-status'),
  loginCredentialStatus: (): Promise<LoginCredentialStatus> => ipcRenderer.invoke('app:login-credential-status'),
  saveLoginCredentials: (input: LoginCredentialInput): Promise<unknown> => ipcRenderer.invoke('app:save-login-credentials', input),
  clearLoginCredentials: (): Promise<unknown> => ipcRenderer.invoke('app:clear-login-credentials'),
  dingTalkLoginQrStatus: (): Promise<DingTalkLoginQrStatus> => ipcRenderer.invoke('app:dingtalk-login-qr-status'),
  saveDingTalkLoginQr: (input: DingTalkLoginQrInput): Promise<unknown> => ipcRenderer.invoke('app:save-dingtalk-login-qr', input),
  clearDingTalkLoginQr: (): Promise<unknown> => ipcRenderer.invoke('app:clear-dingtalk-login-qr'),
  bindDingTalkLoginQrGroup: (): Promise<unknown> => ipcRenderer.invoke('app:bind-dingtalk-login-qr-group'),
  testDingTalkLoginText: (): Promise<unknown> => ipcRenderer.invoke('app:test-dingtalk-login-text'),
  testDingTalkLoginQr: (): Promise<unknown> => ipcRenderer.invoke('app:test-dingtalk-login-qr'),
  loadConfig: (gameId?: string): Promise<ProjectConfig> => ipcRenderer.invoke('app:load-config', gameId),
  saveConfig: (config: ProjectConfig, gameId?: string): Promise<ProjectConfig> => ipcRenderer.invoke('app:save-config', config, gameId),
  saveConfigSection: (config: ProjectConfig, section: ProjectConfigSection): Promise<ProjectConfig> => ipcRenderer.invoke('app:save-config-section', config, section),
  loadFilterTemplates: (): Promise<FilterTemplate[]> => ipcRenderer.invoke('app:load-filter-templates'),
  saveFilterTemplates: (templates: FilterTemplate[]): Promise<FilterTemplate[]> => ipcRenderer.invoke('app:save-filter-templates', templates),
  loadDeliveryTargets: (): Promise<DeliveryTarget[]> => ipcRenderer.invoke('app:load-delivery-targets'),
  saveDeliveryTarget: (input: DeliveryTargetInput): Promise<unknown> => ipcRenderer.invoke('app:save-delivery-target', input),
  deleteDeliveryTarget: (targetId: string): Promise<unknown> => ipcRenderer.invoke('app:delete-delivery-target', targetId),
  testDeliveryTarget: (targetId: string): Promise<unknown> => ipcRenderer.invoke('app:test-delivery-target', targetId),
  loadScheduledReports: (): Promise<ScheduledReport[]> => ipcRenderer.invoke('app:load-scheduled-reports'),
  loadScheduledExecutions: (): Promise<ScheduledExecutionRecord[]> => ipcRenderer.invoke('app:load-scheduled-executions'),
  runScheduledReport: (reportId: string): Promise<unknown> => ipcRenderer.invoke('app:run-scheduled-report', reportId),
  previewScheduledReport: (reportId: string): Promise<unknown> => ipcRenderer.invoke('app:preview-scheduled-report', reportId),
  resolveVersion: (gameId: string): Promise<unknown> => ipcRenderer.invoke('app:resolve-version', gameId),
  lookupPids: (gameId: string, versionId: string, input: string, config: ProjectConfig): Promise<unknown> => ipcRenderer.invoke('app:lookup-pids', gameId, versionId, input, config),
  generate: (query: ReportQuery, config: ProjectConfig): Promise<unknown> => ipcRenderer.invoke('app:generate', query, config),
  generateRealtime: (query: RealtimeQuery): Promise<unknown> => ipcRenderer.invoke('app:generate-realtime', query),
  pickOutputDirectory: (): Promise<string | null> => ipcRenderer.invoke('app:pick-output-directory'),
  openOutputDirectory: (path: string): Promise<boolean> => ipcRenderer.invoke('app:open-output-directory', path),
  onBrowserState: (callback: (value: BrowserState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: BrowserState) => callback(value);
    ipcRenderer.on('app:browser-state', listener);
    return () => ipcRenderer.removeListener('app:browser-state', listener);
  },
  onProgress: (callback: (value: { phase: string; value: number; message: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: { phase: string; value: number; message: string }) => callback(value);
    ipcRenderer.on('app:progress', listener);
    return () => ipcRenderer.removeListener('app:progress', listener);
  },
  onTaskState: (callback: (value: { active: boolean }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: { active: boolean; queued: number }) => callback(value);
    ipcRenderer.on('app:task-state', listener);
    return () => ipcRenderer.removeListener('app:task-state', listener);
  },
  onTaskQueueState: (callback: (value: TaskQueueItem[]) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: TaskQueueItem[]) => callback(value);
    ipcRenderer.on('app:task-queue-state', listener);
    return () => ipcRenderer.removeListener('app:task-queue-state', listener);
  },
  onLoginState: (callback: (value: { loggedIn: boolean }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: { loggedIn: boolean }) => callback(value);
    ipcRenderer.on('app:login-state', listener);
    return () => ipcRenderer.removeListener('app:login-state', listener);
  },
  onScheduledStatus: (callback: (value: ScheduledExecutionRecord) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: ScheduledExecutionRecord) => callback(value);
    ipcRenderer.on('app:scheduled-status', listener);
    return () => ipcRenderer.removeListener('app:scheduled-status', listener);
  },
});
