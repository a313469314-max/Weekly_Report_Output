import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ExcelJS from 'exceljs';
import { writeWorkbook } from '../src/export/workbook';
import { createDefaultProjectConfig } from '../src/shared/defaults';
import type { RawAdRow } from '../src/shared/contracts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('workbook export', () => {
  it('writes a WPS-compatible workbook from a normalized row', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ops-report-generator-'));
    temporaryDirectories.push(directory);
    const output = join(directory, 'report.xlsx');
    const config = createDefaultProjectConfig();
    await writeWorkbook([{
      media: '头条', accountId: 'account', accountName: 'account', radid: 'tt_user_jh_agency_test',
      operatingSystem: 'android', pid: '2170304', pidName: '测试渠道', packageName: 'APK',
      bidCode: 'jh', bidName: '激活', tapSegment: 'main', spend: 100, impressions: 1000, clicks: 100,
      installs: 10, activatedDevices: 10, sameDayPayingDevices: 1, sameDayPayment: 5, loginDevices: 8,
      registrationDevices: 7, payingDevices: 2, payment: 20, registrationCost: 10, loginCost: 12.5,
      roi: 0.2, firstDayRoi: 0.05, firstDayArppu: 5, arppu: 10, date: '2026-08-28',
      isReattribution: false, source: 'structured',
    }], config, output);
    expect((await stat(output)).isFile()).toBe(true);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output);
    expect(workbook.getWorksheet('媒体数据汇总')?.getCell('A1').value).toBe('收入类型：收入');
    expect(workbook.getWorksheet('分投手明细')).toBeUndefined();
    expect(workbook.worksheets.at(-1)?.name).toBe('源数据');
  });

  it('marks realamount workbooks and supports sheets with no selected metric', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ops-report-generator-'));
    temporaryDirectories.push(directory);
    const output = join(directory, 'zero-metric.xlsx');
    const config = createDefaultProjectConfig();
    config.defaultIncomeType = 'realamount';
    config.sheetConfigs = config.sheetConfigs.map((sheet) => ({ ...sheet, metricOrder: [] }));
    await writeWorkbook([{
      media: '头条', accountId: 'account', accountName: 'account', radid: 'tt_user_jh_agency_test',
      operatingSystem: '安卓', pid: '2170304', pidName: '测试渠道', packageName: 'APK',
      bidCode: 'jh', bidName: '激活', tapSegment: 'main', spend: 100, impressions: 0, clicks: 0,
      installs: 0, activatedDevices: 0, sameDayPayingDevices: 0, sameDayPayment: 0, loginDevices: 0,
      registrationDevices: 0, payingDevices: 0, payment: 0, registrationCost: 0, loginCost: 0,
      roi: 0, firstDayRoi: 0, firstDayArppu: 0, arppu: 0, date: '2026-08-28',
      isReattribution: false, source: 'structured',
    }], config, output);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output);
    const overall = workbook.getWorksheet('媒体数据汇总');
    expect(overall?.getCell('A1').value).toBe('收入类型：实收');
    expect(overall?.getCell('A3').value).toBe('汇总范围');
    expect(overall?.getRow(3).cellCount).toBe(1);
  });

  it('does not create a media sheet when that media has zero spend', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ops-report-generator-'));
    temporaryDirectories.push(directory);
    const output = join(directory, 'zero-spend-media.xlsx');
    const config = createDefaultProjectConfig();
    await writeWorkbook([{
      media: 'B站', accountId: 'account', accountName: 'account', radid: 'bli_user_jh_agency_test',
      operatingSystem: '安卓', pid: '2170304', pidName: '测试渠道', packageName: 'APK',
      bidCode: 'jh', bidName: '激活', tapSegment: 'main', spend: 0, impressions: 0, clicks: 0,
      installs: 0, activatedDevices: 0, sameDayPayingDevices: 0, sameDayPayment: 0, loginDevices: 0,
      registrationDevices: 0, payingDevices: 0, payment: 0, registrationCost: 0, loginCost: 0,
      roi: 0, firstDayRoi: 0, firstDayArppu: 0, arppu: 0, date: '2026-08-28',
      isReattribution: false, source: 'structured',
    }], config, output);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output);
    expect(workbook.getWorksheet('媒体数据汇总-B站')).toBeUndefined();
  });

  it('writes pitcher detail rows from RADID data and preserves both source layers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ops-report-generator-'));
    temporaryDirectories.push(directory);
    const output = join(directory, 'pitcher.xlsx');
    const config = createDefaultProjectConfig();
    config.pitcherNameMap = { kz: '凯泽' };
    const base: RawAdRow = {
      media: '头条', accountId: 'account', accountName: 'account', radid: 'tt_kz_jh_agency_first',
      operatingSystem: '安卓', pid: '2170304', pidName: '测试渠道', packageName: 'APK',
      bidCode: 'jh', bidName: '激活', tapSegment: 'main', spend: 100, impressions: 1000, clicks: 100,
      installs: 10, activatedDevices: 10, sameDayPayingDevices: 1, sameDayPayment: 5, loginDevices: 8,
      registrationDevices: 7, payingDevices: 2, payment: 20, registrationCost: 10, loginCost: 12.5,
      roi: 0.2, firstDayRoi: 0.05, firstDayArppu: 5, arppu: 10, date: '2026-08-28',
      isReattribution: false, source: 'structured',
    };
    const rows = [
      base,
      { ...base, radid: 'tt_kz_jh_agency_second', spend: 20 },
      { ...base, media: '广点通', radid: 'qq_lh_mroi7_agency_third', pid: '2170405', packageName: '微小', operatingSystem: 'IOS' },
      { ...base, media: 'apple_cn', radid: 'asa_kz_jh_agency_apple', pid: '2170409' },
      { ...base, radid: 'tt', pid: '2170407', spend: 40 },
    ];
    const pidSummaryRows = [{ ...base, radid: '', accountId: '', accountName: '', pid: '2170406', spend: 30 }];
    await writeWorkbook(rows, config, output, undefined, [], [], { includePitcherDetails: true, detailRows: rows, pidSummaryRows });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output);
    const pitcher = workbook.getWorksheet('分投手明细');
    const source = workbook.getWorksheet('源数据');
    expect(pitcher).toBeDefined();
    expect(workbook.worksheets.at(-1)?.name).toBe('源数据');
    const pitcherLabels = Array.from({ length: pitcher!.rowCount }, (_, index) => pitcher!.getCell(index + 1, 1).text);
    const pitcherTitleRow = pitcherLabels.indexOf('投手：凯泽（kz）') + 1;
    expect(pitcherTitleRow).toBeGreaterThan(0);
    const mediaSummaryTitleRow = pitcherLabels.indexOf('凯泽 · 头条汇总') + 1;
    expect(mediaSummaryTitleRow).toBeGreaterThan(pitcherTitleRow);
    expect(pitcher!.getCell(mediaSummaryTitleRow + 2, 2).text).toBe('头条');
    expect(pitcher!.getCell(mediaSummaryTitleRow + 2, 3).value).toBe(120);
    expect(pitcherLabels).toContain('投手：异常RADID（缺少投手段）');
    expect(pitcherLabels.some((label) => label.includes('apple_cn'))).toBe(false);
    expect(source?.getCell('A3').value).toBe('数据层级');
    expect(source?.getCell('A4').value).toBe('RADID明细');
    expect(source?.getCell('C4').value).toBe('2026-08-28');
    expect(source?.getCell('E4').value).toBe('凯泽');
    expect(source?.getCell('M4').value).toBe('tt_kz_jh_agency_first');
    const sourceLayers = Array.from({ length: source!.rowCount }, (_, index) => String(source!.getCell(index + 1, 1).text));
    expect(sourceLayers).toContain('PID汇总');
    expect(source?.rowCount).toBe(rows.length + pidSummaryRows.length + 3);
  });

  it('uses separately queried pitcher rows only for the pitcher sheet', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ops-report-generator-'));
    temporaryDirectories.push(directory);
    const output = join(directory, 'separate-pitcher-query.xlsx');
    const config = createDefaultProjectConfig();
    const base: RawAdRow = {
      media: '头条', accountId: 'account', accountName: 'account', radid: 'tt_total_jh_agency_total',
      operatingSystem: '安卓', pid: '2170304', pidName: '总查询渠道', packageName: 'APK',
      bidCode: 'jh', bidName: '激活', tapSegment: 'main', spend: 100, impressions: 1000, clicks: 100,
      installs: 10, activatedDevices: 10, sameDayPayingDevices: 1, sameDayPayment: 5, loginDevices: 8,
      registrationDevices: 7, payingDevices: 2, payment: 20, registrationCost: 10, loginCost: 12.5,
      roi: 0.2, firstDayRoi: 0.05, firstDayArppu: 5, arppu: 10, date: '2026-08-28',
      isReattribution: false, source: 'structured',
    };
    const queriedPitcherRow = { ...base, radid: 'tt_queried_jh_agency_pitcher', pidName: '投手筛选结果', spend: 30 };
    await writeWorkbook([base], config, output, undefined, [], [], {
      includePitcherDetails: true,
      detailRows: [base],
      pitcherDetailRows: [queriedPitcherRow],
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output);
    const pitcher = workbook.getWorksheet('分投手明细');
    const source = workbook.getWorksheet('源数据');
    expect(pitcher).toBeDefined();
    expect(source).toBeDefined();
    const pitcherLabels = Array.from({ length: pitcher!.rowCount }, (_, index) => pitcher!.getCell(index + 1, 1).text);
    expect(pitcherLabels).toContain('投手：queried（queried）');
    expect(pitcherLabels).not.toContain('投手：total（total）');
    const sourceRadids = Array.from({ length: source!.rowCount }, (_, index) => source!.getCell(index + 1, 13).text);
    expect(sourceRadids).toContain('tt_total_jh_agency_total');
    expect(sourceRadids).not.toContain('tt_queried_jh_agency_pitcher');
  });

  it('organizes pitcher details by pitcher, then media, with a media summary before bid details', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ops-report-generator-'));
    temporaryDirectories.push(directory);
    const output = join(directory, 'pitcher-order.xlsx');
    const config = createDefaultProjectConfig();
    config.pitcherNameMap = { kz: '凯泽' };
    const base: RawAdRow = {
      media: 'B站', accountId: 'account', accountName: 'account', radid: 'bli_kz_roi_stdt_001',
      operatingSystem: '安卓', pid: '2170325', pidName: '测试渠道', packageName: 'APK',
      bidCode: 'roi', bidName: 'roi', tapSegment: 'main', spend: 30, impressions: 0, clicks: 0,
      installs: 0, activatedDevices: 3, sameDayPayingDevices: 0, sameDayPayment: 0, loginDevices: 3,
      registrationDevices: 0, payingDevices: 0, payment: 0, registrationCost: 0, loginCost: 0,
      roi: 0, firstDayRoi: 0, firstDayArppu: 0, arppu: 0, date: '2026-08-28',
      isReattribution: false, source: 'structured',
    };
    await writeWorkbook([
      { ...base, media: 'B站', radid: 'bli_kz_roi_stdt_001', spend: 30 },
      { ...base, media: '头条', radid: 'tt_kz_mroi7_snk_002', bidCode: 'mroi7', bidName: '7R', spend: 20 },
      { ...base, media: '头条', radid: 'tt_kz_jh_snk_003', bidCode: 'jh', bidName: '激活', spend: 10 },
      { ...base, media: '广点通', radid: 'qq_kz_ztroi7_yr_004', bidCode: 'ztroi7', bidName: '智投7R', spend: 40 },
    ], config, output, undefined, [], [], { includePitcherDetails: true });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output);
    const pitcher = workbook.getWorksheet('分投手明细');
    expect(pitcher).toBeDefined();
    const labels = Array.from({ length: pitcher!.rowCount }, (_, index) => pitcher!.getCell(index + 1, 1).text);
    const headingRows = labels.map((label, index) => ({ label, row: index + 1 })).filter(({ label }) => label.includes('凯泽'));
    expect(headingRows.map(({ label }) => label)).toEqual([
      '投手：凯泽（kz）',
      '凯泽 · 头条汇总',
      '凯泽 · 头条明细',
      '凯泽 · 广点通汇总',
      '凯泽 · 广点通明细',
      '凯泽 · B站汇总',
      '凯泽 · B站明细',
    ]);
    const toutiaoDetailTitle = headingRows.find(({ label }) => label === '凯泽 · 头条明细')!.row;
    const toutiaoHeader = pitcher!.getRow(toutiaoDetailTitle + 1).values;
    expect(toutiaoHeader).toContain('出价方式');
    expect(pitcher!.getCell(toutiaoDetailTitle + 2, 2).text).toBe('头条');
    expect(pitcher!.getCell(toutiaoDetailTitle + 2, 3).text).toBe('APK');
    expect(pitcher!.getCell(toutiaoDetailTitle + 2, 4).text).toBe('安卓');
    expect(pitcher!.getCell(toutiaoDetailTitle + 2, 5).text).toBe('激活');
  });

  it('writes independent amount validation warnings and marks real zero values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ops-report-generator-'));
    temporaryDirectories.push(directory);
    const output = join(directory, 'validation.xlsx');
    const config = createDefaultProjectConfig();
    const base: RawAdRow = {
      media: '头条', accountId: 'account', accountName: 'account', radid: 'tt_user_jh_agency_test',
      operatingSystem: '安卓', pid: '2170304', pidName: '测试渠道', packageName: 'APK', bidCode: 'jh', bidName: '激活', tapSegment: 'main',
      spend: 100.1001, impressions: 0, clicks: 0, installs: 0, activatedDevices: 10, sameDayPayingDevices: 0,
      sameDayPayment: 0, loginDevices: 0, registrationDevices: 0, payingDevices: 0, payment: 0, registrationCost: 0, loginCost: 0,
      roi: 0, firstDayRoi: 0, firstDayArppu: 0, arppu: 0, date: '2026-08-29', isReattribution: false, source: 'structured',
      availableFields: { spend: true, payment: true, sameDayPayment: true, roi: true, firstDayRoi: true },
    };
    await writeWorkbook([base], config, output, undefined, [], [{ metric: 'spend', expected: 100 }]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output);
    const validation = workbook.getWorksheet('数据校验');
    expect(validation).toBeDefined();
    expect(Array.from({ length: validation!.rowCount }, (_, index) => String(validation!.getCell(index + 1, 2).text))).toContain('amount_spend_mismatch');
  });

  it('uses RADID detail for overall spend without repeating a matching PID summary as unallocated data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ops-report-generator-'));
    temporaryDirectories.push(directory);
    const output = join(directory, 'dual-granularity.xlsx');
    const config = createDefaultProjectConfig();
    const detail: RawAdRow = {
      media: '头条', accountId: 'account', accountName: 'account', radid: 'tt_user_jh_agency_test',
      operatingSystem: '安卓', pid: '2170304', pidName: '测试渠道', packageName: 'APK', bidCode: 'jh', bidName: '激活', tapSegment: 'main',
      spend: 100, impressions: 1000, clicks: 100, installs: 10, activatedDevices: 10, sameDayPayingDevices: 1,
      sameDayPayment: 5, loginDevices: 8, registrationDevices: 7, payingDevices: 2, payment: 20, registrationCost: 0, loginCost: 0,
      roi: 0.2, firstDayRoi: 0.05, firstDayArppu: 5, arppu: 10, date: '2026-08-28', isReattribution: false, source: 'structured',
      availableFields: { spend: true, sameDayPayment: true, payment: true },
    };
    const pidSummary = { ...detail, radid: '', accountId: '', accountName: '', spend: 0, payment: 20, availableFields: { ...detail.availableFields, spend: false } };
    await writeWorkbook([detail], config, output, undefined, [], [], { detailRows: [detail], pidSummaryRows: [pidSummary] });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output);
    const overall = workbook.getWorksheet('媒体数据汇总')!;
    const labels = Array.from({ length: overall.rowCount }, (_, index) => overall.getCell(index + 1, 1).text);
    const overallTitle = labels.indexOf('总体汇总（RADID明细层）') + 1;
    const mediaTitle = labels.indexOf('媒体数据汇总（RADID明细层）') + 1;
    expect(overall.getCell(overallTitle + 2, 2).value).toBe(100);
    expect(overall.getCell(mediaTitle + 2, 2).value).toBe(100);
    expect(labels).not.toContain('PID汇总未分配（不参与媒体、系统、出价或投手分类）');
    const source = workbook.getWorksheet('源数据')!;
    const sourceLayers = Array.from({ length: source.rowCount }, (_, index) => source.getCell(index + 1, 1).text);
    expect(sourceLayers).toContain('PID汇总');
  });

  it('does not hide overall spend when the PID summary has no spend field', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ops-report-generator-'));
    temporaryDirectories.push(directory);
    const output = join(directory, 'detail-overall-spend.xlsx');
    const config = createDefaultProjectConfig();
    const detail: RawAdRow = {
      media: '头条', accountId: 'account', accountName: 'account', radid: 'tt_user_jh_agent', operatingSystem: '安卓',
      pid: '2170304', pidName: '测试渠道', packageName: 'APK', bidCode: 'jh', bidName: '激活', tapSegment: 'main',
      spend: 100, impressions: 1000, clicks: 100, installs: 10, activatedDevices: 10, sameDayPayingDevices: 1,
      sameDayPayment: 5, loginDevices: 8, registrationDevices: 7, payingDevices: 2, payment: 20, registrationCost: 0, loginCost: 0,
      roi: 0.2, firstDayRoi: 0.05, firstDayArppu: 5, arppu: 10, date: '2026-08-28', isReattribution: false, source: 'structured',
      availableFields: { spend: true, activatedDevices: true, sameDayPayment: true, payment: true },
    };
    const pidSummary = { ...detail, radid: '', accountId: '', accountName: '', spend: 0, availableFields: { ...detail.availableFields, spend: false } };
    await writeWorkbook([detail], config, output, undefined, [], [], { detailRows: [detail], pidSummaryRows: [pidSummary] });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output);
    const overall = workbook.getWorksheet('媒体数据汇总')!;
    const labels = Array.from({ length: overall.rowCount }, (_, index) => String(overall.getCell(index + 1, 1).text));
    const overallTitle = labels.indexOf('总体汇总（RADID明细层）') + 1;
    expect(overall.getCell(overallTitle + 2, 2).value).toBe(100);
  });

  it('retains only PID summaries that have no matching RADID detail', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ops-report-generator-'));
    temporaryDirectories.push(directory);
    const output = join(directory, 'pid-summary-derived.xlsx');
    const config = createDefaultProjectConfig();
    config.sheetConfigs = config.sheetConfigs.map((sheet) => sheet.id === 'overall'
      ? { ...sheet, metricOrder: ['spend', 'activatedDevices', 'activationCost', 'sameDayPayment', 'firstDayRoi', 'payment', 'roi'] }
      : sheet);
    const detail: RawAdRow = {
      media: '头条', accountId: 'account', accountName: 'account', radid: 'tt_user_jh_agent', operatingSystem: '安卓',
      pid: '2170304', pidName: '测试渠道', packageName: 'APK', bidCode: 'jh', bidName: '激活', tapSegment: 'main',
      spend: 100, impressions: 1000, clicks: 100, installs: 10, activatedDevices: 10, sameDayPayingDevices: 2,
      sameDayPayment: 20, loginDevices: 8, registrationDevices: 7, payingDevices: 4, payment: 40, registrationCost: 0, loginCost: 0,
      roi: 0.4, firstDayRoi: 0.2, firstDayArppu: 10, arppu: 10, date: '2026-08-28', isReattribution: false, source: 'structured',
      availableFields: { spend: true, activatedDevices: true, sameDayPayment: true, payment: true },
    };
    const matchingPidSummary = { ...detail, radid: '', accountId: '', accountName: '' };
    const unmatchedPidSummary = {
      ...matchingPidSummary,
      pid: '2170405',
      pidName: '未匹配渠道',
      spend: 30,
      activatedDevices: 3,
      sameDayPayment: 6,
      payment: 12,
    };
    await writeWorkbook([detail], config, output, undefined, [], [], {
      detailRows: [detail],
      pidSummaryRows: [matchingPidSummary, unmatchedPidSummary],
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output);
    const overall = workbook.getWorksheet('媒体数据汇总')!;
    const labels = Array.from({ length: overall.rowCount }, (_, index) => overall.getCell(index + 1, 1).text);
    const pidTitle = labels.indexOf('PID汇总未分配（不参与媒体、系统、出价或投手分类）') + 1;
    const pidRow = pidTitle + 2;
    expect(overall.getCell(pidRow, 1).value).toBe('2170405');
    expect(overall.getCell(pidRow, 2).value).toBe('未匹配渠道');
    expect(overall.getCell(pidRow, 3).value).toBe(30);
    expect(overall.getCell(pidRow, 5).value).toBe(10);
    expect(overall.getCell(pidRow, 6).value).toBe(6);
    expect(overall.getCell(pidRow, 7).value).toBe(0.2);
    expect(overall.getCell(pidRow, 9).value).toBe(0.4);
    const mediaTitle = labels.indexOf('媒体数据汇总（RADID明细层）') + 1;
    const unallocatedPidValues = Array.from({ length: Math.max(0, mediaTitle - pidRow - 1) }, (_, index) => overall.getCell(pidRow + index, 1).text);
    expect(unallocatedPidValues).not.toContain('2170304');
  });

  it('aggregates matching PIDs into categorized media, channel, operating system and bid sections', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ops-report-generator-'));
    temporaryDirectories.push(directory);
    const output = join(directory, 'categorized-report.xlsx');
    const config = createDefaultProjectConfig();
    const base: RawAdRow = {
      media: '头条', accountId: 'account', accountName: 'account', radid: 'tt_user_jh_agency_test',
      operatingSystem: '安卓', pid: '2170304', pidName: '测试渠道A', packageName: 'APK',
      bidCode: 'jh', bidName: '激活', tapSegment: 'main', spend: 100, impressions: 1000, clicks: 100,
      installs: 10, activatedDevices: 10, sameDayPayingDevices: 1, sameDayPayment: 5, loginDevices: 8,
      registrationDevices: 7, payingDevices: 2, payment: 20, registrationCost: 10, loginCost: 12.5,
      roi: 0.2, firstDayRoi: 0.05, firstDayArppu: 5, arppu: 10, date: '2026-08-28',
      isReattribution: false, source: 'structured',
    };
    await writeWorkbook([
      base,
      { ...base, pid: '2170305', pidName: '测试渠道A-备用' },
      { ...base, pid: '2170405', pidName: '测试渠道B', packageName: '微小', operatingSystem: 'IOS', bidCode: 'mroi7', bidName: '7R' },
      { ...base, media: 'TapTap', pid: '2170410', pidName: '测试渠道C', packageName: '抖小', bidCode: 'mcff', bidName: '每次付费', tapSegment: 'main' },
      { ...base, media: 'TapTap', pid: '2170411', pidName: '测试渠道D', packageName: '抖小', bidCode: 'mcff', bidName: '每次付费', tapSegment: 'adn' },
    ], config, output);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output);
    const overall = workbook.getWorksheet('媒体数据汇总');
    const toutiao = workbook.getWorksheet('媒体数据汇总-头条');
    const bid = workbook.getWorksheet('头条出价方式对比');
    const tap = workbook.getWorksheet('媒体数据汇总-TapTap');
    expect(overall).toBeDefined();
    expect(toutiao).toBeDefined();
    expect(bid).toBeDefined();
    expect(tap).toBeDefined();

    const overallLabels = Array.from({ length: overall!.rowCount }, (_, index) => String(overall!.getCell(index + 1, 1).text));
    expect(overallLabels).toContain('分PID数据汇总（RADID明细层）');
    expect(overallLabels).toContain('媒体数据汇总（RADID明细层）');
    expect(overallLabels).toContain('媒体-渠道-系统汇总（RADID明细层）');
    expect(overallLabels).not.toContain('日期范围合计');
    const pidSummaryTitleRow = overallLabels.indexOf('分PID数据汇总（RADID明细层）') + 1;
    expect(overall!.getCell(pidSummaryTitleRow + 1, 1).value).toBe('渠道ID');
    expect(overall!.getCell(pidSummaryTitleRow + 1, 2).value).toBe('渠道名称');
    expect(overall!.getCell(pidSummaryTitleRow + 2, 1).value).toBe('2170304');
    expect(overall!.getCell(pidSummaryTitleRow + 2, 2).value).toBe('测试渠道A');
    expect(overall!.getCell(pidSummaryTitleRow + 2, 3).value).toBe(100);
    const overallSummaryTitleRow = overallLabels.indexOf('媒体-渠道-系统汇总（RADID明细层）') + 1;
    expect(overall!.getCell(overallSummaryTitleRow + 1, 1).text).toBe('媒体-渠道-系统');
    expect(Array.from({ length: overall!.rowCount }, (_, index) => String(overall!.getCell(index + 1, 1).text)).some((value) => /^2026-/u.test(value))).toBe(false);
    const toutiaoMediaRow = Array.from({ length: overall!.rowCount }, (_, index) => index + 1).find((row) => overall!.getCell(row, 1).text === '头条');
    expect(toutiaoMediaRow).toBeDefined();
    expect(overall!.getCell(toutiaoMediaRow!, 2).value).toBe(300);

    const titles = Array.from({ length: toutiao!.rowCount }, (_, index) => String(toutiao!.getCell(index + 1, 1).text));
    expect(titles).toContain('头条 · APK · 安卓');
    expect(titles).toContain('头条 · 微小 · IOS');
    expect(titles).toContain('头条数据汇总');
    expect(titles.filter((value) => value === '日期范围合计')).toHaveLength(3);
    expect(toutiao!.getRow(2).values).not.toContain('PID');
    expect(toutiao!.getCell('B4').value).toBe(200);
    const toutiaoSummaryRow = titles.indexOf('头条数据汇总') + 3;
    expect(toutiao!.getCell(toutiaoSummaryRow, 2).value).toBe(300);
    expect(toutiao!.autoFilter).toBeUndefined();

    const bidTitles = Array.from({ length: bid!.rowCount }, (_, index) => String(bid!.getCell(index + 1, 1).text));
    expect(bidTitles).toContain('头条 · APK · 安卓 · 激活');
    expect(bidTitles).toContain('头条 · 微小 · IOS · 7R');
    expect(bidTitles).toContain('头条出价方式汇总');
    const conditionalFormattings = (bid as unknown as { conditionalFormattings?: Array<{ rules: Array<{ type: string }> }> }).conditionalFormattings ?? [];
    expect(conditionalFormattings.some((item) => item.rules.some((rule) => rule.type === 'dataBar'))).toBe(true);

    const tapTitles = Array.from({ length: tap!.rowCount }, (_, index) => String(tap!.getCell(index + 1, 1).text));
    expect(tapTitles).toContain('TapTap主站 · 抖小 · 安卓');
    expect(tapTitles).toContain('TapTap ADN/联盟 · 抖小 · 安卓');
    expect(tapTitles).toContain('TapTap主站数据汇总');
    expect(tapTitles).toContain('TapTap ADN/联盟数据汇总');
  });

  it('orders overall media-channel-system summaries by configured media priority', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ops-report-generator-'));
    temporaryDirectories.push(directory);
    const output = join(directory, 'overall-order.xlsx');
    const config = createDefaultProjectConfig();
    const base: RawAdRow = {
      media: '头条', accountId: 'account', accountName: 'account', radid: 'tt_user_jh_agency_test',
      operatingSystem: '安卓', pid: '2170304', pidName: '测试渠道', packageName: 'APK',
      bidCode: 'jh', bidName: '激活', tapSegment: 'main', spend: 1, impressions: 0, clicks: 0,
      installs: 0, activatedDevices: 1, sameDayPayingDevices: 0, sameDayPayment: 0, loginDevices: 1,
      registrationDevices: 0, payingDevices: 0, payment: 0, registrationCost: 0, loginCost: 0,
      roi: 0, firstDayRoi: 0, firstDayArppu: 0, arppu: 0, date: '2026-08-28',
      isReattribution: false, source: 'structured',
    };
    const mediaRows: Array<[RawAdRow['media'], number]> = [
      ['百度', 500],
      ['小红书', 999],
      ['B站', 30],
      ['TapTap', 20],
      ['广点通', 10],
      ['头条', 1],
    ];
    await writeWorkbook(mediaRows.map(([media, spend], index) => ({ ...base, media, spend, pid: `2170${400 + index}`, pidName: `测试渠道${index}` })), config, output);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output);
    expect(workbook.worksheets.every((sheet) => !sheet.views?.some((view) => view.state === 'frozen'))).toBe(true);
    const overall = workbook.getWorksheet('媒体数据汇总');
    expect(overall).toBeDefined();
    const labels = Array.from({ length: overall!.rowCount }, (_, index) => String(overall!.getCell(index + 1, 1).text));
    const secondTitleIndex = labels.indexOf('媒体-渠道-系统汇总（RADID明细层）');
    const expected = ['头条 · APK · 安卓', '', '广点通 · APK · 安卓', '', 'TapTap · APK · 安卓', '', 'B站 · APK · 安卓', '', '小红书 · APK · 安卓', '', '百度 · APK · 安卓'];
    expect(labels.slice(secondTitleIndex + 2, secondTitleIndex + 2 + expected.length)).toEqual(expected);
  });

  it('orders channel-system summaries by the fixed channel and system sequence within each media', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ops-report-generator-'));
    temporaryDirectories.push(directory);
    const output = join(directory, 'channel-system-order.xlsx');
    const config = createDefaultProjectConfig();
    const base: RawAdRow = {
      media: '头条', accountId: 'account', accountName: 'account', radid: 'tt_user_jh_agency_test',
      operatingSystem: '安卓', pid: '2170304', pidName: '测试渠道', packageName: 'APK',
      bidCode: 'jh', bidName: '激活', tapSegment: 'main', spend: 1, impressions: 0, clicks: 0,
      installs: 0, activatedDevices: 1, sameDayPayingDevices: 0, sameDayPayment: 0, loginDevices: 1,
      registrationDevices: 0, payingDevices: 0, payment: 0, registrationCost: 0, loginCost: 0,
      roi: 0, firstDayRoi: 0, firstDayArppu: 0, arppu: 0, date: '2026-08-28',
      isReattribution: false, source: 'structured',
    };
    const combinations: Array<[string, string]> = [
      ['APP', '鸿蒙'],
      ['抖小', '多端合计'],
      ['抖小', '鸿蒙'],
      ['抖小', 'IOS'],
      ['抖小', '安卓'],
      ['微小', '多端合计'],
      ['微小', '鸿蒙'],
      ['微小', 'IOS'],
      ['微小', '安卓'],
      ['IOS', 'IOS'],
      ['APK', '安卓'],
    ];
    await writeWorkbook(combinations.map(([packageName, operatingSystem], index) => ({
      ...base,
      packageName,
      operatingSystem,
      pid: `2170${500 + index}`,
      radid: `tt_user_jh_agency_${index}`,
      spend: combinations.length - index,
    })), config, output);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output);
    const overall = workbook.getWorksheet('媒体数据汇总');
    expect(overall).toBeDefined();
    const labels = Array.from({ length: overall!.rowCount }, (_, index) => String(overall!.getCell(index + 1, 1).text));
    const titleIndex = labels.indexOf('媒体-渠道-系统汇总（RADID明细层）');
    const sectionLabels = labels.slice(titleIndex + 2).filter((label) => label.includes(' · '));
    expect(sectionLabels).toEqual([
      '头条 · APK · 安卓',
      '头条 · IOS · IOS',
      '头条 · 微小 · 安卓',
      '头条 · 微小 · IOS',
      '头条 · 微小 · 鸿蒙',
      '头条 · 微小 · 多端合计',
      '头条 · 抖小 · 安卓',
      '头条 · 抖小 · IOS',
      '头条 · 抖小 · 鸿蒙',
      '头条 · 抖小 · 多端合计',
      '头条 · APP · 鸿蒙',
    ]);
  });

  it('writes a mixed micro PID as one frontend total plus backend-only system breakdowns', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ops-report-generator-'));
    temporaryDirectories.push(directory);
    const output = join(directory, 'mixed-pid.xlsx');
    const config = createDefaultProjectConfig();
    const base: RawAdRow = {
      media: '广点通', accountId: 'account', accountName: 'account', radid: 'qq_user_mroi7_agent',
      operatingSystem: '安卓', pid: '2170405', pidName: '测试微小渠道', packageName: '微小',
      bidCode: 'mroi7', bidName: '7R', tapSegment: 'main', spend: 100, impressions: 1000, clicks: 100,
      installs: 10, activatedDevices: 10, sameDayPayingDevices: 2, sameDayPayment: 30, loginDevices: 8,
      registrationDevices: 8, payingDevices: 4, payment: 60, registrationCost: 0, loginCost: 0,
      roi: 0, firstDayRoi: 0, firstDayArppu: 0, arppu: 0, date: '2026-08-28',
      isReattribution: false, source: 'structured', isMixedPid: true,
    };
    await writeWorkbook([
      base,
      { ...base, operatingSystem: 'IOS', activatedDevices: 5, sameDayPayingDevices: 1, sameDayPayment: 20, loginDevices: 4, registrationDevices: 4, payingDevices: 2, payment: 40 },
    ], config, output);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output);
    const qq = workbook.getWorksheet('媒体数据汇总-广点通');
    expect(qq).toBeDefined();
    const labels = Array.from({ length: qq!.rowCount }, (_, index) => String(qq!.getCell(index + 1, 1).text));
    const mixedTitleRow = labels.indexOf('广点通 · 微小 · 多端合计') + 1;
    const androidTitleRow = labels.indexOf('广点通 · 微小 · 安卓（混投拆分）') + 1;
    const iosTitleRow = labels.indexOf('广点通 · 微小 · IOS（混投拆分）') + 1;
    expect(mixedTitleRow).toBeGreaterThan(0);
    expect(androidTitleRow).toBeGreaterThan(0);
    expect(iosTitleRow).toBeGreaterThan(0);
    expect(qq!.getCell(mixedTitleRow + 2, 2).value).toBe(100);
    expect(qq!.getCell(mixedTitleRow + 2, 3).value).toBe(15);
    expect(qq!.getCell(mixedTitleRow + 2, 3).numFmt).toBe('#,##0');
    expect(qq!.getCell(androidTitleRow + 2, 2).value).toBe('-');
    expect(qq!.getCell(androidTitleRow + 2, 3).value).toBe(10);
    expect(qq!.getCell(androidTitleRow + 2, 4).value).toBe('-');
    expect(qq!.getCell(iosTitleRow + 2, 2).value).toBe('-');
    expect(qq!.getCell(iosTitleRow + 2, 3).value).toBe(5);
  });

  it('writes Android, IOS and a dual-end total for an unmarked micro PID in the overall summary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ops-report-generator-'));
    temporaryDirectories.push(directory);
    const output = join(directory, 'dual-end-summary.xlsx');
    const config = createDefaultProjectConfig();
    const base: RawAdRow = {
      media: '广点通', accountId: 'account', accountName: 'account', radid: 'qq_user_mroi7_agent_dual',
      operatingSystem: '安卓', pid: '2170405', pidName: '测试微小安卓渠道', packageName: '微小',
      bidCode: 'mroi7', bidName: '7R', tapSegment: 'main', spend: 100, impressions: 1000, clicks: 100,
      installs: 10, activatedDevices: 10, sameDayPayingDevices: 2, sameDayPayment: 30, loginDevices: 8,
      registrationDevices: 8, payingDevices: 4, payment: 60, registrationCost: 0, loginCost: 0,
      roi: 0, firstDayRoi: 0, firstDayArppu: 0, arppu: 0, date: '2026-08-28',
      isReattribution: false, source: 'structured', isMixedPid: false,
    };
    await writeWorkbook([
      base,
      { ...base, operatingSystem: 'IOS', spend: 0, impressions: 0, clicks: 0, installs: 0, activatedDevices: 5, sameDayPayingDevices: 1, sameDayPayment: 20, loginDevices: 4, registrationDevices: 4, payingDevices: 2, payment: 40, availableFields: { spend: false, impressions: false, clicks: false, installs: false } },
    ], config, output);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output);
    const overall = workbook.getWorksheet('媒体数据汇总');
    expect(overall).toBeDefined();
    const labels = Array.from({ length: overall!.rowCount }, (_, index) => String(overall!.getCell(index + 1, 1).text));
    const androidRow = labels.indexOf('广点通 · 微小 · 安卓') + 1;
    const iosRow = labels.indexOf('广点通 · 微小 · IOS') + 1;
    const dualRow = labels.indexOf('广点通 · 微小 · 多端合计') + 1;
    expect(androidRow).toBeGreaterThan(0);
    expect(iosRow).toBeGreaterThan(0);
    expect(dualRow).toBeGreaterThan(0);
    expect(overall!.getCell(androidRow, 2).value).toBe(100);
    expect(overall!.getCell(iosRow, 2).value).toBe('-');
    expect(overall!.getCell(dualRow, 2).value).toBe(100);
    expect(overall!.getCell(dualRow, 3).value).toBe(15);
  });
});
