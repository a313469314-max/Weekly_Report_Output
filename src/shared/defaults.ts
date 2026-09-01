import type { ProjectConfig, SheetConfig, SupportedMedia } from './contracts';
import { DEFAULT_METRICS } from './metrics';
import { DEFAULT_REALTIME_METRICS } from './realtime-metrics';

export const PLATFORM_ORDER: SupportedMedia[] = ['头条', '广点通', 'B站', 'TapTap', '小红书', '快手', '百度', 'apple_cn'];
export const PACKAGE_OPTIONS = ['APK', 'IOS', '抖小', '微小', '鸿蒙'] as const;

export function beijingToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

const mediaRules = PLATFORM_ORDER.map((name) => ({
  name,
  aliases: name === '头条' ? ['头条', '今日头条', '巨量引擎'] : name === '广点通' ? ['广点通', '腾讯广告'] : name === 'B站' ? ['bilibili', 'B站', '哔哩哔哩'] : name === 'TapTap' ? ['TapTap', 'TAP'] : name === 'apple_cn' ? ['apple_cn', 'Apple', 'Apple Search Ads'] : [name],
  radidPrefixes: name === '头条' ? ['tt'] : name === '广点通' ? ['qq'] : name === 'B站' ? ['bli'] : name === 'TapTap' ? ['tap'] : name === '快手' ? ['ks'] : name === '小红书' ? ['xhs'] : name === '百度' ? ['bd', 'baidu'] : ['apple', 'asa'],
}));

const sheet = (id: string, name: string, kind: SheetConfig['kind'], media?: SupportedMedia): SheetConfig => ({
  id,
  name,
  kind,
  media,
  showDaily: kind !== 'overall',
  metricOrder: [...DEFAULT_METRICS],
});

export function createDefaultProjectConfig(): ProjectConfig {
  const today = beijingToday();
  return {
    gameId: '',
    currentGameVersionId: null,
    pidWhitelist: [],
    pidNames: {},
    pidPackageMap: {},
    pidOperatingSystemMap: {},
    mediaRules,
    bidCodeMap: {
      jh: '激活',
      uscff: '首次付费',
      scff: '首次付费',
      umcff: '每次付费',
      mcff: '每次付费',
      mroi7: '7R',
      ztroi7: '智投7R',
    },
    pitcherNameMap: {},
    tapAdnKeywords: ['ADN', '联盟', 'TAP ADN'],
    defaultIncomeType: 'amount',
    defaultMetrics: [...DEFAULT_METRICS],
    sheetConfigs: [
      sheet('overall', '媒体数据汇总', 'overall'),
      sheet('tt', '媒体数据汇总-头条', 'media', '头条'),
      sheet('tt-bid', '头条出价方式对比', 'bid', '头条'),
      sheet('qq', '媒体数据汇总-广点通', 'media', '广点通'),
      sheet('qq-bid', '广点通出价方式对比', 'bid', '广点通'),
      sheet('bili', '媒体数据汇总-B站', 'media', 'B站'),
      sheet('tap', '媒体数据汇总-TAP', 'media', 'TapTap'),
      sheet('xhs', '媒体数据汇总-小红书', 'media', '小红书'),
      sheet('ks', '媒体数据汇总-快手', 'media', '快手'),
      sheet('bd', '媒体数据汇总-百度', 'media', '百度'),
      sheet('pitcher', '分投手明细', 'pitcher'),
      sheet('validation', '数据校验', 'validation'),
    ],
    thresholds: { amount: 0.1, percentagePoint: 0.1 },
    outputDirectory: '',
    fileNameRule: '{gameid}_{start}_{end}_{income}',
    realtimeConfig: {
      gameId: '',
      currentGameVersionId: null,
      pidInput: '',
      startDate: today,
      endDate: today,
      paymentStatsEndDate: today,
      incomeType: 'amount',
      includeReattribution: false,
      titleTemplate: '【{pidName}】',
      metricOrder: [...DEFAULT_REALTIME_METRICS],
    },
  };
}
