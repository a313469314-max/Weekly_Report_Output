import { describe, expect, it } from 'vitest';
import { createDefaultProjectConfig, PACKAGE_OPTIONS } from '../src/shared/defaults';
import { normalizeProjectConfig } from '../src/shared/config';
import { mergeProjectConfigSection, migrateStoredProjectConfig, projectConfigForGame, scheduledReportsFromDocument } from '../src/main/config-store';

describe('project configuration', () => {
  it('keeps fixed default sheet order and removes obsolete exclusion switches', () => {
    const config = createDefaultProjectConfig();
    expect(config.sheetConfigs.map((sheet) => sheet.name)).toEqual([
      '媒体数据汇总',
      '媒体数据汇总-头条',
      '头条出价方式对比',
      '媒体数据汇总-广点通',
      '广点通出价方式对比',
      '媒体数据汇总-B站',
      '媒体数据汇总-TapTap',
      '媒体数据汇总-小红书',
      '媒体数据汇总-快手',
      '媒体数据汇总-百度',
      '分投手明细',
      '数据校验',
    ]);
    expect('includeNaturalVolume' in config).toBe(false);
    expect('liveExcludePids' in config).toBe(false);
    const legacyConfig = normalizeProjectConfig({ ...config, liveExcludePids: ['2170305'] });
    expect('liveExcludePids' in legacyConfig).toBe(false);
  });

  it('falls back to safe defaults for malformed config', () => {
    const config = normalizeProjectConfig({ gameId: 123 });
    expect(config.gameId).toBe('');
    expect(config.thresholds.amount).toBe(0.1);
  });

  it('keeps only fixed package options in PID mappings', () => {
    const config = normalizeProjectConfig({
      ...createDefaultProjectConfig(),
      pidPackageMap: { '2170405': '鸿蒙', '2170304': '自定义包体', 临时: 'APK' },
    });
    expect(PACKAGE_OPTIONS).toEqual(['APK', 'IOS', '抖小', '微小', '鸿蒙']);
    expect(config.pidPackageMap).toEqual({ '2170405': '鸿蒙' });
  });

  it('adds an independent realtime configuration when loading legacy report settings', () => {
    const current = createDefaultProjectConfig();
    const { realtimeConfig: _realtimeConfig, ...legacyConfig } = current;
    const config = normalizeProjectConfig({ ...legacyConfig, gameId: '2170', defaultMetrics: ['roi'] });
    expect(config.gameId).toBe('2170');
    expect(config.defaultMetrics).toEqual(['roi']);
    expect(config.realtimeConfig.gameId).toBe('');
    expect(config.realtimeConfig.metricOrder).toEqual([
      'spend', 'activatedDevices', 'activationCost', 'loginDevices', 'loginCost', 'activationLoginRate', 'payingDevices', 'loginPayRate', 'sameDayPayingCost', 'firstDayRoi',
    ]);
    expect(config.realtimeConfig.includePitcherDetails).toBe(false);
  });

  it('keeps realtime metrics separate from Excel metrics', () => {
    const source = createDefaultProjectConfig();
    const config = normalizeProjectConfig({
      ...source,
      defaultMetrics: ['roi'],
      realtimeConfig: { ...source.realtimeConfig, includePitcherDetails: true, metricOrder: ['loginDevices', 'not-a-metric', 'loginDevices', 'spend'] },
    });
    expect(config.defaultMetrics).toEqual(['roi']);
    expect(config.realtimeConfig.metricOrder).toEqual(['loginDevices', 'spend']);
    expect(config.realtimeConfig.includePitcherDetails).toBe(true);
  });

  it('adds the new pitcher sheet to existing project settings and preserves case-sensitive mappings', () => {
    const { pitcherNameMap: _pitcherNameMap, ...legacy } = createDefaultProjectConfig();
    const config = normalizeProjectConfig({
      ...legacy,
      sheetConfigs: legacy.sheetConfigs.filter((sheet) => sheet.id !== 'pitcher'),
      pitcherNameMap: { KZ: '投手A', kz: '投手B', ' ': '忽略' },
    });
    expect(config.sheetConfigs.map((sheet) => sheet.id)).toContain('pitcher');
    expect(config.sheetConfigs.findIndex((sheet) => sheet.id === 'pitcher')).toBe(config.sheetConfigs.findIndex((sheet) => sheet.id === 'validation') - 1);
    expect(config.pitcherNameMap).toEqual({ KZ: '投手A', kz: '投手B' });
  });

  it('migrates a legacy single-project config without losing its values', () => {
    const legacy = { ...createDefaultProjectConfig(), gameId: '2170', defaultMetrics: ['roi' as const] };
    const result = migrateStoredProjectConfig(legacy);
    expect(result.migrated).toBe(true);
    expect(result.document.activeGameId).toBe('2170');
    expect(result.document.projects['2170'].defaultMetrics).toEqual(['roi']);
  });

  it('isolates project settings by gameid and returns defaults for a new project', () => {
    const first = { ...createDefaultProjectConfig(), gameId: '2170', fileNameRule: 'first' };
    const second = { ...createDefaultProjectConfig(), gameId: '2171', fileNameRule: 'second' };
    const result = migrateStoredProjectConfig({ version: 2, activeGameId: '2170', projects: { '2170': first, '2171': second } });
    expect(projectConfigForGame(result.document, '2170').fileNameRule).toBe('first');
    expect(projectConfigForGame(result.document, '2171').fileNameRule).toBe('second');
    expect(projectConfigForGame(result.document, '2172').gameId).toBe('2172');
    expect(projectConfigForGame(result.document, '2172').fileNameRule).toBe(createDefaultProjectConfig().fileNameRule);
  });

  it('saves only the selected settings card without writing other pending changes', () => {
    const saved = {
      ...createDefaultProjectConfig(),
      gameId: '2170',
      fileNameRule: '已保存的文件名',
      bidCodeMap: { old: '已保存出价' },
    };
    const updated = {
      ...saved,
      fileNameRule: '新的文件名',
      bidCodeMap: { new: '未保存出价' },
      mediaRules: saved.mediaRules.map((rule, index) => index === 0 ? { ...rule, aliases: ['未保存媒体别名'] } : rule),
    };

    const result = mergeProjectConfigSection(saved, updated, 'basic');

    expect(result.fileNameRule).toBe('新的文件名');
    expect(result.bidCodeMap).toEqual({ old: '已保存出价' });
    expect(result.mediaRules).toEqual(saved.mediaRules);
  });

  it('lists scheduled reports from every project without changing project ownership', () => {
    const report = (id: string, gameId: string) => ({
      id,
      name: `任务-${id}`,
      enabled: true,
      gameId,
      gameVersionId: 'version-a',
      pidInput: `${gameId}0304`,
      incomeType: 'amount' as const,
      includeReattribution: false,
      includePitcherDetails: false,
      titleTemplate: '【{pidName}】',
      metricOrder: ['spend' as const],
      times: ['20:00'],
      targetIds: ['target-a'],
    });
    const first = { ...createDefaultProjectConfig(), gameId: '2170', scheduledReports: [report('schedule-a', '2170')] };
    const second = { ...createDefaultProjectConfig(), gameId: '2171', scheduledReports: [report('schedule-b', '2171')] };
    const result = migrateStoredProjectConfig({
      version: 4,
      activeGameId: '2170',
      projects: { '2170': first, '2171': second },
      filterTemplates: [],
      deliveryTargets: [],
      scheduledExecutionLedger: {},
    });

    expect(scheduledReportsFromDocument(result.document).map((item) => `${item.gameId}:${item.id}`)).toEqual([
      '2170:schedule-a',
      '2171:schedule-b',
    ]);
  });

  it('migrates global filter templates with their saved game version to the scheduled-report config format', () => {
    const project = { ...createDefaultProjectConfig(), gameId: '2170' };
    const result = migrateStoredProjectConfig({
      version: 3,
      activeGameId: '2170',
      projects: { '2170': project },
      filterTemplates: [{
        id: 'template-1',
        name: '国服安卓收入',
        gameId: '2170',
        gameVersionId: 'version-42',
        pidInput: '2170405, 2170304',
        incomeType: 'amount',
        includeReattribution: false,
        pitcherFilters: ['投手A', ' 投手A '],
        includePitcherDetails: true,
      }],
    });

    expect(result.migrated).toBe(true);
    expect(result.document.filterTemplates).toEqual([{
      id: 'template-1',
      name: '国服安卓收入',
      gameId: '2170',
      gameVersionId: 'version-42',
      pidInput: '2170405, 2170304',
      incomeType: 'amount',
      includeReattribution: false,
      pitcherFilters: ['投手A'],
      includePitcherDetails: true,
    }]);
    expect(migrateStoredProjectConfig({ version: 2, activeGameId: '2170', projects: { '2170': project } }).document.filterTemplates).toEqual([]);
  });

  it('keeps independent scheduled-report snapshots and discards malformed plans', () => {
    const source = createDefaultProjectConfig();
    const config = normalizeProjectConfig({
      ...source,
      scheduledReports: [
        {
          id: 'schedule-a', name: '下午实时汇报', enabled: true, gameId: '2170', gameVersionId: 'version-a', pidInput: '2170304',
          incomeType: 'amount', includeReattribution: false, pitcherFilters: [' 投手A ', '投手A'], includePitcherDetails: true, titleTemplate: '【{pidName}】', metricOrder: ['spend', 'not-a-metric', 'spend'],
          times: ['20:00', '15:30', '15:30', 'invalid'], targetIds: ['target-a', 'target-a'],
        },
        {
          id: 'schedule-invalid', name: '', enabled: true, gameId: '2170', gameVersionId: 'version-a', pidInput: '2170304',
          incomeType: 'amount', includeReattribution: false, titleTemplate: '', metricOrder: [], times: ['15:30'], targetIds: ['target-a'],
        },
      ],
    });
    expect(config.scheduledReports).toEqual([{
      id: 'schedule-a', name: '下午实时汇报', enabled: true, gameId: '2170', gameVersionId: 'version-a', pidInput: '2170304',
      incomeType: 'amount', includeReattribution: false, pitcherFilters: ['投手A'], includePitcherDetails: true, titleTemplate: '【{pidName}】', metricOrder: ['spend'],
      times: ['15:30', '20:00'], targetIds: ['target-a'],
    }]);
  });

  it('keeps valid date-bounded interval plans and rejects invalid interval plans', () => {
    const source = createDefaultProjectConfig();
    const config = normalizeProjectConfig({
      ...source,
      scheduledReports: [
        {
          id: 'schedule-interval', name: '循环汇报', enabled: true, gameId: '2170', gameVersionId: 'version-a', pidInput: '2170304',
          incomeType: 'amount', includeReattribution: false, titleTemplate: '【{pidName}】', metricOrder: ['spend'],
          scheduleMode: 'interval', startDate: '2026-09-03', endDate: '2026-09-05', intervalMinutes: 30, intervalEndTime: '20:00', times: ['08:00'], targetIds: ['target-a'],
        },
        {
          id: 'schedule-invalid-interval', name: '错误循环汇报', enabled: true, gameId: '2170', gameVersionId: 'version-a', pidInput: '2170304',
          incomeType: 'amount', includeReattribution: false, titleTemplate: '【{pidName}】', metricOrder: ['spend'],
          scheduleMode: 'interval', startDate: '2026-09-05', endDate: '2026-09-03', intervalMinutes: 0, intervalEndTime: '08:00', times: ['08:00'], targetIds: ['target-a'],
        },
        {
          id: 'schedule-equal-time-interval', name: '相同时间循环汇报', enabled: true, gameId: '2170', gameVersionId: 'version-a', pidInput: '2170304',
          incomeType: 'amount', includeReattribution: false, titleTemplate: '【{pidName}】', metricOrder: ['spend'],
          scheduleMode: 'interval', startDate: '2026-09-03', endDate: null, intervalMinutes: 30, intervalEndTime: '08:00', times: ['08:00'], targetIds: ['target-a'],
        },
        {
          id: 'schedule-reversed-time-interval', name: '倒置时间循环汇报', enabled: true, gameId: '2170', gameVersionId: 'version-a', pidInput: '2170304',
          incomeType: 'amount', includeReattribution: false, titleTemplate: '【{pidName}】', metricOrder: ['spend'],
          scheduleMode: 'interval', startDate: '2026-09-03', endDate: null, intervalMinutes: 30, intervalEndTime: '07:59', times: ['08:00'], targetIds: ['target-a'],
        },
      ],
    });
    expect(config.scheduledReports).toEqual([{
      id: 'schedule-interval', name: '循环汇报', enabled: true, gameId: '2170', gameVersionId: 'version-a', pidInput: '2170304',
      incomeType: 'amount', includeReattribution: false, pitcherFilters: [], includePitcherDetails: false, titleTemplate: '【{pidName}】', metricOrder: ['spend'],
      scheduleMode: 'interval', startDate: '2026-09-03', endDate: '2026-09-05', intervalMinutes: 30, intervalEndTime: '20:00', times: ['08:00'], targetIds: ['target-a'],
    }]);
  });

  it('refreshes the realtime payment statistics end date when loading a saved project', () => {
    const saved = createDefaultProjectConfig();
    saved.gameId = '2170';
    saved.realtimeConfig.startDate = '2026-08-10';
    saved.realtimeConfig.endDate = '2026-08-16';
    saved.realtimeConfig.paymentStatsEndDate = '2026-08-31';
    const result = migrateStoredProjectConfig({ version: 2, activeGameId: '2170', projects: { '2170': saved } });

    const loaded = projectConfigForGame(result.document, undefined, '2026-09-01');

    expect(loaded.realtimeConfig.startDate).toBe('2026-08-10');
    expect(loaded.realtimeConfig.endDate).toBe('2026-08-16');
    expect(loaded.realtimeConfig.paymentStatsEndDate).toBe('2026-09-01');
  });
});
