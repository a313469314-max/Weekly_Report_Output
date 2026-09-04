import type { DeliveryTarget, DeliveryTargetInput, DingTalkLoginQrInput, DingTalkLoginQrStatus, FilterTemplate, LoginCredentialInput, LoginCredentialStatus, ProjectConfig, ProjectConfigSection, RealtimeQuery, ReportQuery, ScheduledExecutionRecord, ScheduledReport, TaskQueueItem } from '../shared/contracts';

type BrowserTabState = { id: string; title: string; url: string; active: boolean };
type BrowserState = { open: boolean; tabs: BrowserTabState[] };
type BrowserCommandResult = { ok: true; state: BrowserState } | { ok: false; error: { code: string; message: string } };

interface DesktopApi {
  openLogin(): Promise<boolean>;
  hideBrowser(): Promise<boolean>;
  showBrowser(): Promise<BrowserState>;
  browserState(): Promise<BrowserState>;
  browserSelectTab(id: string): Promise<BrowserCommandResult>;
  browserNewTab(url?: string): Promise<BrowserCommandResult>;
  browserCloseTab(id: string): Promise<BrowserCommandResult>;
  browserNavigate(url: string): Promise<BrowserCommandResult>;
  taskState(): Promise<{ active: boolean; queued: number }>;
  taskQueueState(): Promise<TaskQueueItem[]>;
  moveTaskQueueItem(taskId: string, direction: -1 | 1): Promise<{ ok: boolean; state: TaskQueueItem[] }>;
  removeTaskQueueItem(taskId: string): Promise<{ ok: boolean; state: TaskQueueItem[] }>;
  cancelTaskQueueItem(taskId: string): Promise<{ ok: boolean; state: TaskQueueItem[] }>;
  cancelCurrentTask(): Promise<{ ok: boolean; cancelled: boolean }>;
  loginStatus(): Promise<boolean>;
  loginCredentialStatus(): Promise<LoginCredentialStatus>;
  saveLoginCredentials(input: LoginCredentialInput): Promise<unknown>;
  clearLoginCredentials(): Promise<unknown>;
  dingTalkLoginQrStatus(): Promise<DingTalkLoginQrStatus>;
  saveDingTalkLoginQr(input: DingTalkLoginQrInput): Promise<unknown>;
  clearDingTalkLoginQr(): Promise<unknown>;
  bindDingTalkLoginQrGroup(): Promise<unknown>;
  testDingTalkLoginText(): Promise<unknown>;
  testDingTalkLoginQr(): Promise<unknown>;
  loadConfig(gameId?: string): Promise<ProjectConfig>;
  saveConfig(config: ProjectConfig, gameId?: string): Promise<ProjectConfig>;
  saveConfigSection(config: ProjectConfig, section: ProjectConfigSection): Promise<ProjectConfig>;
  loadFilterTemplates(): Promise<FilterTemplate[]>;
  saveFilterTemplates(templates: FilterTemplate[]): Promise<FilterTemplate[]>;
  loadDeliveryTargets(): Promise<DeliveryTarget[]>;
  saveDeliveryTarget(input: DeliveryTargetInput): Promise<unknown>;
  deleteDeliveryTarget(targetId: string): Promise<unknown>;
  testDeliveryTarget(targetId: string): Promise<unknown>;
  loadScheduledReports(): Promise<ScheduledReport[]>;
  loadScheduledExecutions(): Promise<ScheduledExecutionRecord[]>;
  runScheduledReport(reportId: string): Promise<unknown>;
  previewScheduledReport(reportId: string): Promise<unknown>;
  resolveVersion(gameId: string): Promise<unknown>;
  lookupPids(gameId: string, versionId: string, input: string, config: ProjectConfig): Promise<unknown>;
  generate(query: ReportQuery, config: ProjectConfig): Promise<unknown>;
  generateRealtime(query: RealtimeQuery): Promise<unknown>;
  pickOutputDirectory(): Promise<string | null>;
  openOutputDirectory(path: string): Promise<boolean>;
  onBrowserState(callback: (value: BrowserState) => void): () => void;
  onProgress(callback: (value: { phase: string; value: number; message: string }) => void): () => void;
  onTaskState(callback: (value: { active: boolean; queued: number }) => void): () => void;
  onTaskQueueState(callback: (value: TaskQueueItem[]) => void): () => void;
  onLoginState(callback: (value: { loggedIn: boolean }) => void): () => void;
  onScheduledStatus(callback: (value: ScheduledExecutionRecord) => void): () => void;
}

declare global {
  interface Window { desktopApi: DesktopApi; }
}

export {};
