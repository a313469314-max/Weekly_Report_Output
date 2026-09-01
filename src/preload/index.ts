import { contextBridge, ipcRenderer } from 'electron';
import type { ProjectConfig, RealtimeQuery, ReportQuery } from '../shared/contracts';

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
  loginStatus: (): Promise<boolean> => ipcRenderer.invoke('app:login-status'),
  clearSession: (): Promise<boolean> => ipcRenderer.invoke('app:clear-session'),
  loadConfig: (gameId?: string): Promise<ProjectConfig> => ipcRenderer.invoke('app:load-config', gameId),
  saveConfig: (config: ProjectConfig, gameId?: string): Promise<ProjectConfig> => ipcRenderer.invoke('app:save-config', config, gameId),
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
});
