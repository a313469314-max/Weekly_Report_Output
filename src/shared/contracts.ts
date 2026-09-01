export type IncomeType = 'amount' | 'realamount';

export type DeliveryType = '直播' | '信息流' | '自然量' | '未识别';

export type FieldAvailability = 'complete' | 'partial' | 'missing' | 'not_applicable';

export type SupportedMedia =
  | '头条'
  | '广点通'
  | 'TapTap'
  | 'B站'
  | '快手'
  | '小红书'
  | '百度'
  | 'apple_cn';

export type MetricKey =
  | 'spend'
  | 'activatedDevices'
  | 'activationCost'
  | 'sameDayPayingDevices'
  | 'sameDayPayingCost'
  | 'sameDayPayment'
  | 'payingDevices'
  | 'payingCost'
  | 'payment'
  | 'firstDayRoi'
  | 'roi'
  | 'loginDevices'
  | 'firstDayLtv'
  | 'ltv'
  | 'impressions'
  | 'clicks'
  | 'installs'
  | 'registrationDevices'
  | 'loginCost'
  | 'registrationCost'
  | 'firstDayArppu'
  | 'arppu'
  | 'clickRate'
  | 'cpm'
  | 'clickActivationRate'
  | 'activationRegistrationRate'
  | 'activationLoginRate'
  | 'activationPayRate'
  | 'day2Roi'
  | 'day3Roi'
  | 'day7Roi'
  | 'day30Roi';

export interface MetricDefinition {
  key: MetricKey;
  label: string;
  group: '基础' | '成本' | '收入' | '比例' | 'LTV' | '其他';
  format: 'number' | 'currency' | 'percent';
}

export type RealtimeMetricKey = MetricKey | 'activationLoginRate' | 'loginPayRate';

export interface RealtimeMetricDefinition {
  key: RealtimeMetricKey;
  label: string;
  group: MetricDefinition['group'];
  format: MetricDefinition['format'];
}

export interface ReportThresholds {
  amount: number;
  percentagePoint: number;
}

export interface SheetConfig {
  id: string;
  name: string;
  kind: 'overall' | 'media' | 'bid' | 'pitcher' | 'validation';
  media?: SupportedMedia;
  showDaily: boolean;
  metricOrder: MetricKey[];
}

export interface MediaRule {
  name: SupportedMedia;
  aliases: string[];
  radidPrefixes: string[];
}

export interface ProjectConfig {
  gameId: string;
  currentGameVersionId: string | null;
  pidWhitelist: string[];
  pidNames: Record<string, string>;
  pidPackageMap: Record<string, string>;
  pidOperatingSystemMap: Record<string, string>;
  mediaRules: MediaRule[];
  bidCodeMap: Record<string, string>;
  pitcherNameMap: Record<string, string>;
  tapAdnKeywords: string[];
  defaultIncomeType: IncomeType;
  defaultMetrics: MetricKey[];
  sheetConfigs: SheetConfig[];
  thresholds: ReportThresholds;
  outputDirectory: string;
  fileNameRule: string;
  realtimeConfig: RealtimeConfig;
}

export interface RealtimeConfig {
  gameId: string;
  currentGameVersionId: string | null;
  pidInput: string;
  startDate: string;
  endDate: string;
  paymentStatsEndDate: string;
  incomeType: IncomeType;
  includeReattribution: boolean;
  titleTemplate: string;
  metricOrder: RealtimeMetricKey[];
}

export interface ReportQuery {
  gameId: string;
  gameVersionId: string;
  pids: string[];
  startDate: string;
  endDate: string;
  paymentStatsEndDate: string;
  incomeType: IncomeType;
  includeReattribution: boolean;
  includePitcherDetails: boolean;
}

export interface FilterTemplate {
  id: string;
  name: string;
  gameId: string;
  gameVersionId: string;
  pidInput: string;
  incomeType: IncomeType;
  includeReattribution: boolean;
  includePitcherDetails: boolean;
}

export interface RealtimeQuery {
  gameId: string;
  gameVersionId: string;
  pidInput: string;
  startDate: string;
  endDate: string;
  paymentStatsEndDate: string;
  incomeType: IncomeType;
  includeReattribution: boolean;
  titleTemplate: string;
  metricOrder: RealtimeMetricKey[];
}

export interface PidDirectoryEntry {
  id: string;
  name: string;
  deliveryType?: DeliveryType;
  channel?: string | null;
  operatingSystem?: string | null;
  isMixed?: boolean;
}

export interface VersionCandidate {
  key: string;
  name: string;
  gameId: string;
  flag: number;
}

export interface RawAdRow {
  media: string;
  accountId: string;
  accountName: string;
  radid: string;
  operatingSystem: string;
  pid: string;
  pidName: string;
  deliveryType?: DeliveryType;
  packageName: string;
  bidCode: string;
  bidName: string;
  tapSegment: 'main' | 'adn';
  spend: number;
  impressions: number;
  clicks: number;
  installs: number;
  activatedDevices: number;
  sameDayPayingDevices: number;
  sameDayPayment: number;
  loginDevices: number;
  registrationDevices: number;
  payingDevices: number;
  payment: number;
  registrationCost: number;
  loginCost: number;
  roi: number;
  firstDayRoi: number;
  firstDayArppu: number;
  arppu: number;
  day2Payment?: number;
  day3Payment?: number;
  day7Payment?: number;
  day30Payment?: number;
  availableFields?: Partial<Record<MetricKey, boolean>>;
  partialFields?: Partial<Record<MetricKey, boolean>>;
  notApplicableFields?: Partial<Record<MetricKey, boolean>>;
  date: string;
  isReattribution: boolean;
  source: 'structured' | 'csv' | 'xlsx';
  isMixedPid?: boolean;
  isMixedSystemBreakdown?: boolean;
  isCrossSystemSummary?: boolean;
  frontEndMetricsAvailable?: boolean;
}

export interface AggregateTotals {
  spend: number;
  impressions: number;
  clicks: number;
  installs: number;
  activatedDevices: number;
  sameDayPayingDevices: number;
  sameDayPayment: number;
  loginDevices: number;
  registrationDevices: number;
  payingDevices: number;
  payment: number;
  day2Payment?: number;
  day3Payment?: number;
  day7Payment?: number;
  day30Payment?: number;
  availableFields?: Partial<Record<MetricKey, boolean>>;
  fieldAvailability?: Partial<Record<MetricKey, FieldAvailability>>;
  fieldAvailabilityCounts?: Partial<Record<MetricKey, { available: number; partial: number; missing: number; notApplicable: number }>>;
  frontEndMetricsAvailable: boolean;
}

export interface ValidationIssue {
  level: 'warning' | 'error';
  code: string;
  message: string;
  count?: number;
}

export type ValidationAmountMetric = 'spend' | 'sameDayPayment' | 'payment';

export interface ValidationBaseline {
  metric: ValidationAmountMetric;
  expected: number;
  available?: boolean;
  label?: string;
}

export interface ReportData {
  rows: RawAdRow[];
  detailRows?: RawAdRow[];
  pidSummaryRows?: RawAdRow[];
  issues: ValidationIssue[];
  source: 'structured' | 'csv' | 'xlsx';
  baselines?: ValidationBaseline[];
}
