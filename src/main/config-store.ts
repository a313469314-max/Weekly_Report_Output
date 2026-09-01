import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { ProjectConfig } from '../shared/contracts';
import { normalizeProjectConfig } from '../shared/config';
import { beijingToday } from '../shared/defaults';

export interface StoredProjectConfigFile {
  version: 2;
  activeGameId: string;
  projects: Record<string, ProjectConfig>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStoredProjectConfigFile(value: unknown): value is StoredProjectConfigFile {
  return isRecord(value)
    && value.version === 2
    && typeof value.activeGameId === 'string'
    && isRecord(value.projects);
}

export function migrateStoredProjectConfig(value: unknown): { document: StoredProjectConfigFile; migrated: boolean } {
  if (isStoredProjectConfigFile(value)) {
    const projects = Object.fromEntries(
      Object.entries(value.projects).map(([gameId, config]) => [gameId, { ...normalizeProjectConfig(config), gameId }]),
    );
    return {
      document: { version: 2, activeGameId: value.activeGameId.trim(), projects },
      migrated: false,
    };
  }

  const legacy = normalizeProjectConfig(value);
  const gameId = legacy.gameId.trim();
  return {
    document: {
      version: 2,
      activeGameId: gameId,
      projects: gameId ? { [gameId]: legacy } : {},
    },
    migrated: isRecord(value),
  };
}

export function projectConfigForGame(document: StoredProjectConfigFile, gameId?: string, currentDate = beijingToday()): ProjectConfig {
  const requested = gameId?.trim() ?? '';
  const selected = requested || document.activeGameId;
  const existing = selected ? document.projects[selected] : undefined;
  if (existing) {
    const config = normalizeProjectConfig(existing);
    return {
      ...config,
      gameId: selected,
      realtimeConfig: { ...config.realtimeConfig, paymentStatsEndDate: currentDate },
    };
  }
  const defaults = normalizeProjectConfig(undefined);
  const config = selected ? { ...defaults, gameId: selected } : defaults;
  return {
    ...config,
    realtimeConfig: { ...config.realtimeConfig, paymentStatsEndDate: currentDate },
  };
}

export class ConfigStore {
  private get filePath(): string {
    return join(app.getPath('userData'), 'project-config.json');
  }

  private get legacyBackupPath(): string {
    return join(app.getPath('userData'), 'project-config.legacy-backup.json');
  }

  async load(gameId?: string): Promise<ProjectConfig> {
    try {
      const rawText = await fs.readFile(this.filePath, 'utf8');
      const raw = JSON.parse(rawText) as unknown;
      const { document, migrated } = migrateStoredProjectConfig(raw);
      if (migrated) {
        try {
          await fs.copyFile(this.filePath, this.legacyBackupPath);
        } catch {
          // A backup failure must not prevent loading the user's configuration.
        }
        await fs.writeFile(this.filePath, JSON.stringify(document, null, 2), 'utf8');
      }
      return projectConfigForGame(document, gameId);
    } catch {
      const defaults = normalizeProjectConfig(undefined);
      return gameId?.trim() ? { ...defaults, gameId: gameId.trim() } : defaults;
    }
  }

  async save(config: ProjectConfig, gameId?: string): Promise<ProjectConfig> {
    const normalized = normalizeProjectConfig({ ...config, gameId: gameId?.trim() || config.gameId });
    let document: StoredProjectConfigFile = { version: 2, activeGameId: '', projects: {} };
    try {
      const rawText = await fs.readFile(this.filePath, 'utf8');
      const raw = JSON.parse(rawText) as unknown;
      const migrated = migrateStoredProjectConfig(raw);
      document = migrated.document;
      if (migrated.migrated) {
        try {
          await fs.copyFile(this.filePath, this.legacyBackupPath);
        } catch {
          // A backup failure must not prevent saving the migrated configuration.
        }
      }
    } catch {
      // Start a new multi-project document when no local config exists.
    }
    const key = normalized.gameId.trim();
    if (key) document.projects[key] = normalized;
    document.activeGameId = key || document.activeGameId;
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(document, null, 2), 'utf8');
    return normalized;
  }
}
