import type { ProjectConfig, RealtimeQuery, ReportQuery } from '../shared/contracts';

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
  loginStatus(): Promise<boolean>;
  clearSession(): Promise<boolean>;
  loadConfig(gameId?: string): Promise<ProjectConfig>;
  saveConfig(config: ProjectConfig, gameId?: string): Promise<ProjectConfig>;
  resolveVersion(gameId: string): Promise<unknown>;
  lookupPids(gameId: string, versionId: string, input: string, config: ProjectConfig): Promise<unknown>;
  generate(query: ReportQuery, config: ProjectConfig): Promise<unknown>;
  generateRealtime(query: RealtimeQuery): Promise<unknown>;
  pickOutputDirectory(): Promise<string | null>;
  openOutputDirectory(path: string): Promise<boolean>;
  onBrowserState(callback: (value: BrowserState) => void): () => void;
  onProgress(callback: (value: { phase: string; value: number; message: string }) => void): () => void;
}

declare global {
  interface Window { desktopApi: DesktopApi; }
}

export {};
