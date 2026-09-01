import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { FilterTemplate, ProjectConfig } from '../shared/contracts';
import { normalizeProjectConfig } from '../shared/config';
import { beijingToday } from '../shared/defaults';

export interface StoredProjectConfigFile {
  version: 3;
  activeGameId: string;
  projects: Record<string, ProjectConfig>;
  filterTemplates: FilterTemplate[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStoredProjectConfigFile(value: unknown): value is StoredProjectConfigFile {
  return isRecord(value)
    && value.version === 3
    && typeof value.activeGameId === 'string'
    && isRecord(value.projects)
    && Array.isArray(value.filterTemplates);
}

function normalizeFilterTemplates(value: unknown): FilterTemplate[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value.flatMap((item): FilterTemplate[] => {
    if (!isRecord(item)) return [];
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const gameId = typeof item.gameId === 'string' ? item.gameId.trim() : '';
    const gameVersionId = typeof item.gameVersionId === 'string' ? item.gameVersionId.trim() : '';
    const pidInput = typeof item.pidInput === 'string' ? item.pidInput.trim() : '';
    const incomeType = item.incomeType === 'realamount' ? 'realamount' : item.incomeType === 'amount' ? 'amount' : null;
    if (!id || ids.has(id) || !name || !/^\d{4,}$/u.test(gameId) || !gameVersionId || !pidInput || !incomeType) return [];
    ids.add(id);
    return [{
      id,
      name,
      gameId,
      gameVersionId,
      pidInput,
      incomeType,
      includeReattribution: item.includeReattribution === true,
      includePitcherDetails: item.includePitcherDetails === true,
    }];
  });
}

export function migrateStoredProjectConfig(value: unknown): { document: StoredProjectConfigFile; migrated: boolean } {
  if (isStoredProjectConfigFile(value)) {
    const projects = Object.fromEntries(
      Object.entries(value.projects).map(([gameId, config]) => [gameId, { ...normalizeProjectConfig(config), gameId }]),
    );
    return {
      document: { version: 3, activeGameId: value.activeGameId.trim(), projects, filterTemplates: normalizeFilterTemplates(value.filterTemplates) },
      migrated: false,
    };
  }

  const legacyDocument = isRecord(value) && value.version === 2 && typeof value.activeGameId === 'string' && isRecord(value.projects)
    ? value
    : null;
  if (legacyDocument) {
    const projects = Object.fromEntries(
      Object.entries(legacyDocument.projects as Record<string, unknown>).map(([gameId, config]) => [gameId, { ...normalizeProjectConfig(config), gameId }]),
    );
    return {
      document: { version: 3, activeGameId: String(legacyDocument.activeGameId).trim(), projects, filterTemplates: [] },
      migrated: true,
    };
  }

  const legacy = normalizeProjectConfig(value);
  const gameId = legacy.gameId.trim();
  return {
    document: {
      version: 3,
      activeGameId: gameId,
      projects: gameId ? { [gameId]: legacy } : {},
      filterTemplates: [],
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

  private async readDocument(): Promise<{ document: StoredProjectConfigFile; migrated: boolean }> {
    try {
      const rawText = await fs.readFile(this.filePath, 'utf8');
      return migrateStoredProjectConfig(JSON.parse(rawText) as unknown);
    } catch {
      return {
        document: { version: 3, activeGameId: '', projects: {}, filterTemplates: [] },
        migrated: false,
      };
    }
  }

  private async backupLegacyConfig(): Promise<void> {
    try {
      await fs.copyFile(this.filePath, this.legacyBackupPath);
    } catch {
      // A backup failure must not prevent the user from using their configuration.
    }
  }

  async load(gameId?: string): Promise<ProjectConfig> {
    const { document, migrated } = await this.readDocument();
    if (migrated) {
      await this.backupLegacyConfig();
      await fs.writeFile(this.filePath, JSON.stringify(document, null, 2), 'utf8');
    }
    return projectConfigForGame(document, gameId);
  }

  async save(config: ProjectConfig, gameId?: string): Promise<ProjectConfig> {
    const normalized = normalizeProjectConfig({ ...config, gameId: gameId?.trim() || config.gameId });
    const { document, migrated } = await this.readDocument();
    if (migrated) await this.backupLegacyConfig();
    const key = normalized.gameId.trim();
    if (key) document.projects[key] = normalized;
    document.activeGameId = key || document.activeGameId;
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(document, null, 2), 'utf8');
    return normalized;
  }

  async loadFilterTemplates(): Promise<FilterTemplate[]> {
    const { document, migrated } = await this.readDocument();
    if (migrated) {
      await this.backupLegacyConfig();
      await fs.mkdir(app.getPath('userData'), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(document, null, 2), 'utf8');
    }
    return document.filterTemplates;
  }

  async saveFilterTemplates(templates: FilterTemplate[]): Promise<FilterTemplate[]> {
    const { document, migrated } = await this.readDocument();
    if (migrated) await this.backupLegacyConfig();
    document.filterTemplates = normalizeFilterTemplates(templates);
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(document, null, 2), 'utf8');
    return document.filterTemplates;
  }
}
