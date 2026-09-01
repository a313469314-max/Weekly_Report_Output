import { describe, expect, it } from 'vitest';
import { createDefaultProjectConfig, PACKAGE_OPTIONS } from '../src/shared/defaults';
import { normalizeProjectConfig } from '../src/shared/config';
import { migrateStoredProjectConfig, projectConfigForGame } from '../src/main/config-store';

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
      '媒体数据汇总-TAP',
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
  });

  it('keeps realtime metrics separate from Excel metrics', () => {
    const source = createDefaultProjectConfig();
    const config = normalizeProjectConfig({
      ...source,
      defaultMetrics: ['roi'],
      realtimeConfig: { ...source.realtimeConfig, metricOrder: ['loginDevices', 'not-a-metric', 'loginDevices', 'spend'] },
    });
    expect(config.defaultMetrics).toEqual(['roi']);
    expect(config.realtimeConfig.metricOrder).toEqual(['loginDevices', 'spend']);
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
