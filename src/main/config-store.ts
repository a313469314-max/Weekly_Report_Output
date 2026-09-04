import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { DeliveryTarget, FilterTemplate, ProjectConfig, ProjectConfigSection, ScheduledExecutionRecord, ScheduledReport } from '../shared/contracts';
import { normalizeProjectConfig } from '../shared/config';
import { beijingToday } from '../shared/defaults';

export interface StoredProjectConfigFile {
  version: 4;
  activeGameId: string;
  projects: Record<string, ProjectConfig>;
  filterTemplates: FilterTemplate[];
  deliveryTargets: DeliveryTarget[];
  scheduledExecutionLedger: Record<string, ScheduledExecutionRecord>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStoredProjectConfigFile(value: unknown): value is StoredProjectConfigFile {
  return isRecord(value)
    && value.version === 4
    && typeof value.activeGameId === 'string'
    && isRecord(value.projects)
    && Array.isArray(value.filterTemplates)
    && Array.isArray(value.deliveryTargets)
    && isRecord(value.scheduledExecutionLedger);
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
      pitcherFilters: Array.isArray(item.pitcherFilters)
        ? [...new Set(item.pitcherFilters.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean))]
        : [],
      includePitcherDetails: item.includePitcherDetails === true,
    }];
  });
}

function normalizeDeliveryTargets(value: unknown): DeliveryTarget[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value.flatMap((item): DeliveryTarget[] => {
    if (!isRecord(item)) return [];
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const platform = item.platform === 'dingtalk' || item.platform === 'feishu' ? item.platform : null;
    const secretId = typeof item.secretId === 'string' ? item.secretId.trim() : '';
    if (!id || ids.has(id) || !name || !platform || !secretId) return [];
    ids.add(id);
    return [{ id, name, platform, secretId, enabled: item.enabled !== false }];
  });
}

function normalizeScheduledExecutionLedger(value: unknown): Record<string, ScheduledExecutionRecord> {
  if (!isRecord(value)) return {};
  const valid = Object.values(value).flatMap((item): ScheduledExecutionRecord[] => {
    if (!isRecord(item)) return [];
    const slotKey = typeof item.slotKey === 'string' ? item.slotKey.trim() : '';
    const scheduleId = typeof item.scheduleId === 'string' ? item.scheduleId.trim() : '';
    const scheduleName = typeof item.scheduleName === 'string' ? item.scheduleName.trim() : '';
    const date = typeof item.date === 'string' ? item.date.trim() : '';
    const time = typeof item.time === 'string' ? item.time.trim() : '';
    const result = item.result === 'running' || item.result === 'waiting_login' || item.result === 'success' || item.result === 'partial_failure' || item.result === 'failed' || item.result === 'unknown' ? item.result : null;
    const code = typeof item.code === 'string' ? item.code.trim().slice(0, 80) : '';
    const occurredAt = typeof item.occurredAt === 'string' ? item.occurredAt : '';
    if (!slotKey || !scheduleId || !scheduleName || !/^\d{4}-\d{2}-\d{2}$/u.test(date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(time) || !result || !code || !occurredAt) return [];
    return [{ slotKey, scheduleId, scheduleName, date, time, result, code, occurredAt }];
  });
  return Object.fromEntries(valid
    .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))
    .slice(0, 180)
    .map((record) => [record.slotKey, record]));
}

export function migrateStoredProjectConfig(value: unknown): { document: StoredProjectConfigFile; migrated: boolean } {
  if (isStoredProjectConfigFile(value)) {
    const projects = Object.fromEntries(
      Object.entries(value.projects).map(([gameId, config]) => [gameId, { ...normalizeProjectConfig(config), gameId }]),
    );
    return {
      document: {
        version: 4,
        activeGameId: value.activeGameId.trim(),
        projects,
        filterTemplates: normalizeFilterTemplates(value.filterTemplates),
        deliveryTargets: normalizeDeliveryTargets(value.deliveryTargets),
        scheduledExecutionLedger: normalizeScheduledExecutionLedger(value.scheduledExecutionLedger),
      },
      migrated: false,
    };
  }

  const versionThreeDocument = isRecord(value) && value.version === 3 && typeof value.activeGameId === 'string' && isRecord(value.projects)
    ? value
    : null;
  if (versionThreeDocument) {
    const projects = Object.fromEntries(
      Object.entries(versionThreeDocument.projects as Record<string, unknown>).map(([gameId, config]) => [gameId, { ...normalizeProjectConfig(config), gameId }]),
    );
    return {
      document: {
        version: 4,
        activeGameId: String(versionThreeDocument.activeGameId).trim(),
        projects,
        filterTemplates: normalizeFilterTemplates(versionThreeDocument.filterTemplates),
        deliveryTargets: [],
        scheduledExecutionLedger: {},
      },
      migrated: true,
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
      document: { version: 4, activeGameId: String(legacyDocument.activeGameId).trim(), projects, filterTemplates: [], deliveryTargets: [], scheduledExecutionLedger: {} },
      migrated: true,
    };
  }

  const legacy = normalizeProjectConfig(value);
  const gameId = legacy.gameId.trim();
  return {
    document: {
      version: 4,
      activeGameId: gameId,
      projects: gameId ? { [gameId]: legacy } : {},
      filterTemplates: [],
      deliveryTargets: [],
      scheduledExecutionLedger: {},
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

export function scheduledReportsFromDocument(document: StoredProjectConfigFile): ScheduledReport[] {
  return Object.values(document.projects).flatMap((config) => config.scheduledReports);
}

export function mergeProjectConfigSection(saved: ProjectConfig, updated: ProjectConfig, section: ProjectConfigSection): ProjectConfig {
  switch (section) {
    case 'basic':
      return {
        ...saved,
        gameId: updated.gameId,
        defaultIncomeType: updated.defaultIncomeType,
        tapAdnKeywords: updated.tapAdnKeywords,
        thresholds: updated.thresholds,
        fileNameRule: updated.fileNameRule,
      };
    case 'pidCache':
      return {
        ...saved,
        pidNames: updated.pidNames,
        pidPackageMap: updated.pidPackageMap,
        pidOperatingSystemMap: updated.pidOperatingSystemMap,
      };
    case 'mediaRules':
      return { ...saved, mediaRules: updated.mediaRules };
    case 'bidCodes':
      return { ...saved, bidCodeMap: updated.bidCodeMap };
    case 'pitcherNames':
      return { ...saved, pitcherNameMap: updated.pitcherNameMap };
  }
}

export class ConfigStore {
  private writeQueue: Promise<void> = Promise.resolve();

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
        document: { version: 4, activeGameId: '', projects: {}, filterTemplates: [], deliveryTargets: [], scheduledExecutionLedger: {} },
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

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeQueue;
    let release!: () => void;
    this.writeQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
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
    return this.withWriteLock(async () => {
      const normalized = normalizeProjectConfig({ ...config, gameId: gameId?.trim() || config.gameId });
      const { document, migrated } = await this.readDocument();
      if (migrated) await this.backupLegacyConfig();
      const key = normalized.gameId.trim();
      if (key) document.projects[key] = normalized;
      document.activeGameId = key || document.activeGameId;
      await fs.mkdir(app.getPath('userData'), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(document, null, 2), 'utf8');
      return normalized;
    });
  }

  async saveSection(config: ProjectConfig, section: ProjectConfigSection): Promise<ProjectConfig> {
    return this.withWriteLock(async () => {
      const key = config.gameId.trim();
      const { document, migrated } = await this.readDocument();
      if (migrated) await this.backupLegacyConfig();
      const saved = key && document.projects[key]
        ? normalizeProjectConfig(document.projects[key])
        : normalizeProjectConfig({ gameId: key });
      const normalized = normalizeProjectConfig(mergeProjectConfigSection(saved, { ...config, gameId: key }, section));
      if (key) document.projects[key] = normalized;
      document.activeGameId = key || document.activeGameId;
      await fs.mkdir(app.getPath('userData'), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(document, null, 2), 'utf8');
      return normalized;
    });
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
    return this.withWriteLock(async () => {
      const { document, migrated } = await this.readDocument();
      if (migrated) await this.backupLegacyConfig();
      document.filterTemplates = normalizeFilterTemplates(templates);
      await fs.mkdir(app.getPath('userData'), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(document, null, 2), 'utf8');
      return document.filterTemplates;
    });
  }

  async loadDeliveryTargets(): Promise<DeliveryTarget[]> {
    const { document, migrated } = await this.readDocument();
    if (migrated) {
      await this.backupLegacyConfig();
      await fs.mkdir(app.getPath('userData'), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(document, null, 2), 'utf8');
    }
    return document.deliveryTargets;
  }

  async saveDeliveryTargets(targets: DeliveryTarget[]): Promise<DeliveryTarget[]> {
    return this.withWriteLock(async () => {
      const { document, migrated } = await this.readDocument();
      if (migrated) await this.backupLegacyConfig();
      document.deliveryTargets = normalizeDeliveryTargets(targets);
      await fs.mkdir(app.getPath('userData'), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(document, null, 2), 'utf8');
      return document.deliveryTargets;
    });
  }

  async removeDeliveryTarget(targetId: string): Promise<void> {
    await this.withWriteLock(async () => {
      const { document, migrated } = await this.readDocument();
      if (migrated) await this.backupLegacyConfig();
      const id = targetId.trim();
      document.deliveryTargets = document.deliveryTargets.filter((target) => target.id !== id);
      document.projects = Object.fromEntries(Object.entries(document.projects).map(([gameId, config]) => [gameId, {
        ...config,
        scheduledReports: config.scheduledReports.map((report) => {
          const targetIds = report.targetIds.filter((candidate) => candidate !== id);
          return { ...report, targetIds, enabled: targetIds.length > 0 && report.enabled };
        }),
      }]));
      await fs.mkdir(app.getPath('userData'), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(document, null, 2), 'utf8');
    });
  }

  async listScheduledReports(): Promise<ScheduledReport[]> {
    const { document } = await this.readDocument();
    return scheduledReportsFromDocument(document);
  }

  async listEnabledScheduledReports(): Promise<ScheduledReport[]> {
    const { document } = await this.readDocument();
    return scheduledReportsFromDocument(document).filter((report) => report.enabled);
  }

  async scheduledReport(reportId: string): Promise<ScheduledReport | null> {
    const { document } = await this.readDocument();
    const id = reportId.trim();
    return scheduledReportsFromDocument(document).find((report) => report.id === id) ?? null;
  }

  async scheduledExecution(slotKey: string): Promise<ScheduledExecutionRecord | null> {
    const { document } = await this.readDocument();
    return document.scheduledExecutionLedger[slotKey] ?? null;
  }

  async saveScheduledExecution(record: ScheduledExecutionRecord): Promise<void> {
    await this.withWriteLock(async () => {
      const { document, migrated } = await this.readDocument();
      if (migrated) await this.backupLegacyConfig();
      document.scheduledExecutionLedger = normalizeScheduledExecutionLedger({ ...document.scheduledExecutionLedger, [record.slotKey]: record });
      await fs.mkdir(app.getPath('userData'), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(document, null, 2), 'utf8');
    });
  }

  async recentScheduledExecutions(limit = 30): Promise<ScheduledExecutionRecord[]> {
    const { document } = await this.readDocument();
    return Object.values(document.scheduledExecutionLedger)
      .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))
      .slice(0, Math.max(0, Math.min(limit, 180)));
  }

  async waitingLoginExecutions(): Promise<ScheduledExecutionRecord[]> {
    const { document } = await this.readDocument();
    return Object.values(document.scheduledExecutionLedger).filter((record) => record.result === 'waiting_login');
  }
}
