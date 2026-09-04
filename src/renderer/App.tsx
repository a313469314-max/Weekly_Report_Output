import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import appLogo from './assets/logo.png';
import type { DeliveryTarget, DeliveryTargetInput, DingTalkLoginQrStatus, FilterTemplate, LoginCredentialStatus, MediaRule, MetricKey, PidDirectoryEntry, ProjectConfig, ProjectConfigSection, RealtimeConfig, RealtimeMetricKey, RealtimeQuery, ReportQuery, ScheduledExecutionRecord, ScheduledReport, SheetConfig, TaskQueueItem, TaskQueueStatus, VersionCandidate } from '../shared/contracts';
import { createDefaultProjectConfig } from '../shared/defaults';
import { METRICS, metricByKey } from '../shared/metrics';
import { DEFAULT_REALTIME_METRICS, REALTIME_METRICS, realtimeMetricByKey } from '../shared/realtime-metrics';
import { inferPackageName, inferPidClassification, isMixedPidName, parsePidInput, removePidFromInput, validatePids, type PidValidationResult } from '../domain/pid';
import { createQueryValidationSnapshot, isQueryValidationSnapshotCurrent, type QueryValidationSnapshot } from '../shared/query-validation';
import { nextScheduledRun, normalizeScheduleTimeInputs, scheduleTimeInputsFromTimes, type ScheduleTimeInput } from '../shared/schedule';

type Tab = 'generate' | 'realtime' | 'scheduled' | 'project';
type ConfigModal = 'report' | 'realtime' | 'delivery' | 'onboarding' | null;
type VersionPickerContext = 'report' | 'realtime' | 'scheduled' | null;
type Result<T> = { ok: true; [key: string]: any } | { ok: false; error: { code: string; message: string } };
type BrowserTabState = { id: string; title: string; url: string; active: boolean };
type BrowserState = { open: boolean; tabs: BrowserTabState[] };
type BrowserCommandResult = { ok: true; state: BrowserState } | { ok: false; error: { code: string; message: string } };
type ProgressState = { phase: string; value: number; message: string };
type PendingConfirmation = { title: string; message: string; confirmLabel: string; action: () => Promise<void> | void };
type ProjectSection = ProjectConfigSection | 'unattendedLogin' | 'dingtalkLoginQr';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const TITLE_PLACEHOLDERS = [
  { value: '{pidName}', label: 'PID 名称' },
  { value: '{pid}', label: '数字 PID' },
] as const;
const ONBOARDING_GUIDE_SEEN_KEY = 'ops-report-generator.onboarding-guide-seen.v1';

function isTaskCancelledResult(result: Result<unknown>): boolean {
  return !result.ok && result.error.code === 'TASK_CANCELLED';
}

function moveItem<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const next = [...items];
  const target = index + direction;
  if (target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

function splitList(value: string): string[] {
  return value.split(/[,，\s]+/u).map((item) => item.trim()).filter(Boolean);
}

function splitPitcherFilters(value: string): string[] {
  return [...new Set(value.split(/[,，\n]+/u).map((item) => item.trim()).filter(Boolean))];
}

function updateRecord(record: Record<string, string>, key: string, value: string): Record<string, string> {
  const next = { ...record };
  if (key.trim()) next[key.trim()] = value.trim();
  return next;
}

function scheduledResultLabel(result: ScheduledExecutionRecord['result']): string {
  if (result === 'running') return '执行中';
  if (result === 'waiting_login') return '等待登录';
  if (result === 'success') return '发送成功';
  if (result === 'partial_failure') return '部分失败';
  if (result === 'failed') return '发送失败';
  return '结果未知';
}

function taskQueueStatusLabel(status: TaskQueueStatus): string {
  if (status === 'queued') return '排队中';
  if (status === 'running') return '执行中';
  if (status === 'success') return '已完成';
  if (status === 'cancelled') return '已终止';
  return '失败';
}

function taskQueueKindLabel(kind: TaskQueueItem['kind']): string {
  if (kind === 'report') return 'Excel 报表';
  if (kind === 'realtime') return '即时播报';
  if (kind === 'scheduled') return '定时汇报';
  if (kind === 'preview') return '预览';
  return '后台查询';
}

function emptyDeliveryTargetDraft(): DeliveryTargetInput {
  return { name: '', platform: 'dingtalk', enabled: true, webhookUrl: '', signingSecret: '' };
}

function HelpTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return <span className={`help-tip${open ? ' open' : ''}`}>
    <button type="button" className="help-tip-button" aria-label="查看说明" aria-expanded={open} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setOpen((current) => !current); }} onBlur={() => setOpen(false)}>?</button>
    <span className="help-tip-popover" role="tooltip">{text}</span>
  </span>;
}

function FieldLabel({ text, help }: { text: string; help: string }) {
  return <span className="field-label"><span>{text}</span><HelpTip text={help} /></span>;
}

function CollapseToggle({ expanded, label, onClick }: { expanded: boolean; label: string; onClick: () => void }) {
  return <button className={`project-collapse-toggle${expanded ? ' expanded' : ''}`} type="button" onClick={onClick} aria-label={`${expanded ? '收起' : '展开'}${label}`} aria-expanded={expanded}>▸</button>;
}

function ActionMenu({ label = '更多', children }: { label?: string; children: ReactNode }) {
  return <details className="action-menu">
    <summary>{label}<span aria-hidden="true">⌄</span></summary>
    <div className="action-menu-panel">{children}</div>
  </details>;
}

export default function App() {
  const [tab, setTab] = useState<Tab>('generate');
  const [config, setConfig] = useState<ProjectConfig>(createDefaultProjectConfig());
  const [gameId, setGameId] = useState('');
  const [version, setVersion] = useState<VersionCandidate | null>(null);
  const [versionCandidates, setVersionCandidates] = useState<VersionCandidate[]>([]);
  const [realtimeVersion, setRealtimeVersion] = useState<VersionCandidate | null>(null);
  const [realtimeVersionCandidates, setRealtimeVersionCandidates] = useState<VersionCandidate[]>([]);
  const [realtimeOutput, setRealtimeOutput] = useState('');
  const [pidInput, setPidInput] = useState('');
  const [directory, setDirectory] = useState<PidDirectoryEntry[]>([]);
  const [pidValidation, setPidValidation] = useState<PidValidationResult | null>(null);
  const [pidValidationSnapshot, setPidValidationSnapshot] = useState<QueryValidationSnapshot | null>(null);
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [paymentStatsEndDate, setPaymentStatsEndDate] = useState(today);
  const [incomeType, setIncomeType] = useState<'amount' | 'realamount'>('amount');
  const [includeReattribution, setIncludeReattribution] = useState(false);
  const [includePitcherDetails, setIncludePitcherDetails] = useState(false);
  const [pitcherFilterInput, setPitcherFilterInput] = useState('');
  const [filterTemplates, setFilterTemplates] = useState<FilterTemplate[]>([]);
  const [selectedFilterTemplateId, setSelectedFilterTemplateId] = useState('');
  const [filterTemplateName, setFilterTemplateName] = useState('');
  const [filterTemplateModalOpen, setFilterTemplateModalOpen] = useState(false);
  const [filterTemplateSaveOpen, setFilterTemplateSaveOpen] = useState(false);
  const [filterTemplateEditingId, setFilterTemplateEditingId] = useState<string | null>(null);
  const [filterTemplateSaveError, setFilterTemplateSaveError] = useState('');
  const [filterTemplatePendingDelete, setFilterTemplatePendingDelete] = useState<FilterTemplate | null>(null);
  const [newBidCode, setNewBidCode] = useState('');
  const [newBidName, setNewBidName] = useState('');
  const [newPitcherCode, setNewPitcherCode] = useState('');
  const [newPitcherName, setNewPitcherName] = useState('');
  const [projectSectionsExpanded, setProjectSectionsExpanded] = useState<Record<ProjectSection, boolean>>({
    basic: true,
    unattendedLogin: false,
    dingtalkLoginQr: false,
    pidCache: false,
    mediaRules: false,
    bidCodes: false,
    pitcherNames: false,
  });
  const [loggedIn, setLoggedIn] = useState(false);
  const [loginCredentialStatus, setLoginCredentialStatus] = useState<LoginCredentialStatus>({ configured: false, username: '' });
  const [loginCredentialUsername, setLoginCredentialUsername] = useState('');
  const [loginCredentialPassword, setLoginCredentialPassword] = useState('');
  const [dingTalkLoginQrStatus, setDingTalkLoginQrStatus] = useState<DingTalkLoginQrStatus>({ configured: false, groupBound: false });
  const [dingTalkLoginQrAppKey, setDingTalkLoginQrAppKey] = useState('');
  const [dingTalkLoginQrAppSecret, setDingTalkLoginQrAppSecret] = useState('');
  const [dingTalkLoginQrRobotCode, setDingTalkLoginQrRobotCode] = useState('');
  const [bindingDingTalkLoginQr, setBindingDingTalkLoginQr] = useState(false);
  const [testingDingTalkLoginText, setTestingDingTalkLoginText] = useState(false);
  const [testingDingTalkLoginQr, setTestingDingTalkLoginQr] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserState, setBrowserState] = useState<BrowserState>({ open: false, tabs: [] });
  const [addressValue, setAddressValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [taskActive, setTaskActive] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [progress, setProgress] = useState<ProgressState>({ phase: 'idle', value: 0, message: '准备生成报表' });
  const [status, setStatus] = useState('请先登录后台，然后填写查询条件。');
  const [error, setError] = useState('');
  const [activeSheet, setActiveSheet] = useState('overall');
  const [configModal, setConfigModal] = useState<ConfigModal>(null);
  const [deliveryTargets, setDeliveryTargets] = useState<DeliveryTarget[]>([]);
  const [scheduledReports, setScheduledReports] = useState<ScheduledReport[]>([]);
  const [scheduledExecutions, setScheduledExecutions] = useState<ScheduledExecutionRecord[]>([]);
  const [taskQueueItems, setTaskQueueItems] = useState<TaskQueueItem[]>([]);
  const [taskQueueModalOpen, setTaskQueueModalOpen] = useState(false);
  const [scheduledHistoryOpen, setScheduledHistoryOpen] = useState(false);
  const [scheduleDraft, setScheduleDraft] = useState<ScheduledReport | null>(null);
  const [scheduledVersion, setScheduledVersion] = useState<VersionCandidate | null>(null);
  const [scheduledVersionCandidates, setScheduledVersionCandidates] = useState<VersionCandidate[]>([]);
  const [scheduleTimeInputs, setScheduleTimeInputs] = useState<ScheduleTimeInput[]>(scheduleTimeInputsFromTimes(['15:30']));
  const [intervalEndTimeInput, setIntervalEndTimeInput] = useState<ScheduleTimeInput>({ hour: '23', minute: '59' });
  const [scheduleTimeError, setScheduleTimeError] = useState('');
  const [schedulePreview, setSchedulePreview] = useState('');
  const [scheduleSuccessMessage, setScheduleSuccessMessage] = useState<string | null>(null);
  const [deliveryTargetDraft, setDeliveryTargetDraft] = useState<DeliveryTargetInput>(emptyDeliveryTargetDraft());
  const [versionPickerContext, setVersionPickerContext] = useState<VersionPickerContext>(null);
  const [versionPickerCandidates, setVersionPickerCandidates] = useState<VersionCandidate[]>([]);
  const [versionPickerSelection, setVersionPickerSelection] = useState('');
  const projectLoadSequence = useRef(0);
  const scheduledReportsLoadSequence = useRef(0);

  useEffect(() => {
    const requestId = ++projectLoadSequence.current;
    void window.desktopApi.loadConfig().then((loaded) => {
      if (requestId !== projectLoadSequence.current) return;
      setConfig(loaded);
      setGameId(loaded.gameId);
      setIncomeType(loaded.defaultIncomeType);
      if (loaded.currentGameVersionId) setVersion({ key: loaded.currentGameVersionId, name: '已保存版本', gameId: loaded.gameId, flag: 1 });
      if (loaded.realtimeConfig.currentGameVersionId) setRealtimeVersion({ key: loaded.realtimeConfig.currentGameVersionId, name: '已保存版本', gameId: loaded.realtimeConfig.gameId, flag: 1 });
    });
    void window.desktopApi.loadFilterTemplates().then(setFilterTemplates);
    void window.desktopApi.loadDeliveryTargets().then(setDeliveryTargets);
    void window.desktopApi.loginCredentialStatus().then((value) => { setLoginCredentialStatus(value); setLoginCredentialUsername(value.username); });
    void window.desktopApi.dingTalkLoginQrStatus().then(setDingTalkLoginQrStatus);
    void refreshScheduledReports();
    void window.desktopApi.loadScheduledExecutions().then(setScheduledExecutions);
    const stopProgress = window.desktopApi.onProgress((progress) => {
      setBusy(progress.phase !== 'done');
      setProgress(progress);
    });
    const stopTaskState = window.desktopApi.onTaskState((value) => {
      setTaskActive(value.active);
      if (!value.active) setBusy(false);
    });
    const stopTaskQueueState = window.desktopApi.onTaskQueueState(setTaskQueueItems);
    const stopLoginState = window.desktopApi.onLoginState((value) => setLoggedIn(value.loggedIn));
    const stopBrowserState = window.desktopApi.onBrowserState((nextState) => {
      setBrowserState(nextState);
      setBrowserOpen(nextState.open);
    });
    const stopScheduledStatus = window.desktopApi.onScheduledStatus((record) => {
      setScheduledExecutions((current) => [record, ...current.filter((item) => item.slotKey !== record.slotKey)].slice(0, 30));
    });
    void window.desktopApi.browserState().then((nextState) => {
      setBrowserState(nextState);
      setBrowserOpen(nextState.open);
    });
    void window.desktopApi.taskState().then((value) => setTaskActive(value.active));
    void window.desktopApi.taskQueueState().then(setTaskQueueItems);
    void refreshLogin();
    return () => { stopProgress(); stopTaskState(); stopTaskQueueState(); stopLoginState(); stopBrowserState(); stopScheduledStatus(); };
  }, []);

  useEffect(() => {
    if (window.localStorage.getItem(ONBOARDING_GUIDE_SEEN_KEY)) return;
    setConfigModal('onboarding');
  }, []);

  useEffect(() => {
    const active = browserState.tabs.find((browserTab) => browserTab.active);
    if (active) setAddressValue(active.url);
  }, [browserState]);

  async function refreshLogin() {
    const value = await window.desktopApi.loginStatus();
    setLoggedIn(value);
    setStatus(value ? '后台已登录，可以开始查询。' : '请先登录后台，然后填写查询条件。');
  }

  async function refreshScheduledReports() {
    const requestId = ++scheduledReportsLoadSequence.current;
    const reports = await window.desktopApi.loadScheduledReports();
    if (requestId === scheduledReportsLoadSequence.current) setScheduledReports(reports);
    return reports;
  }

  async function loadProjectConfig(gameIdValue: string) {
    const requestId = ++projectLoadSequence.current;
    const loaded = await window.desktopApi.loadConfig(gameIdValue || undefined);
    if (requestId !== projectLoadSequence.current) return;
    setConfig(loaded);
    setIncomeType(loaded.defaultIncomeType);
    if (loaded.currentGameVersionId) {
      setVersion({ key: loaded.currentGameVersionId, name: '已保存版本', gameId: loaded.gameId, flag: 1 });
    } else {
      setVersion(null);
    }
    setVersionCandidates([]);
    setPidValidation(null);
    setPidValidationSnapshot(null);
    setDirectory([]);
  }

  async function applyFilterTemplate(template: FilterTemplate) {
    setError('');
    const requestId = ++projectLoadSequence.current;
    setGameId(template.gameId);
    setVersion(null);
    setVersionCandidates([]);
    setPidInput(template.pidInput);
    setPitcherFilterInput((template.pitcherFilters ?? []).join(', '));
    setPidValidation(null);
    setPidValidationSnapshot(null);
    setDirectory([]);
    const loaded = await window.desktopApi.loadConfig(template.gameId);
    if (requestId !== projectLoadSequence.current) return;
    setConfig({ ...loaded, gameId: template.gameId, currentGameVersionId: template.gameVersionId });
    setVersion({ key: template.gameVersionId, name: '模板保存版本', gameId: template.gameId, flag: 1 });
    setIncomeType(template.incomeType);
    setIncludeReattribution(template.includeReattribution);
    setIncludePitcherDetails(template.includePitcherDetails);
    setStatus(`已应用筛选模板“${template.name}”，请先重新校验 PID。`);
  }

  function openFilterTemplateManager() {
    setFilterTemplateModalOpen(true);
    setFilterTemplateSaveError('');
  }

  function openFilterTemplateSave() {
    setFilterTemplateSaveError('');
    const editingTemplate = filterTemplates.find((template) => template.id === filterTemplateEditingId);
    setFilterTemplateName(editingTemplate?.name ?? '');
    setFilterTemplateSaveOpen(true);
  }

  async function editFilterTemplate(template: FilterTemplate) {
    setFilterTemplateModalOpen(false);
    setSelectedFilterTemplateId(template.id);
    setFilterTemplateEditingId(template.id);
    setFilterTemplateName(template.name);
    await applyFilterTemplate(template);
    setStatus(`已载入筛选模板“${template.name}”，修改配置后可在底部保存。`);
  }

  async function useFilterTemplate(template: FilterTemplate) {
    setFilterTemplateEditingId(null);
    setFilterTemplateName('');
    setSelectedFilterTemplateId(template.id);
    await applyFilterTemplate(template);
    setFilterTemplateModalOpen(false);
  }

  async function saveFilterTemplate() {
    setFilterTemplateSaveError('');
    setError('');
    const name = filterTemplateName.trim();
    const editingId = filterTemplateEditingId;
    if (!name) { setFilterTemplateSaveError('请填写筛选模板名称。'); return; }
    if (!/^\d{4,}$/u.test(gameId)) { setFilterTemplateSaveError('请先填写数字 gameid。'); return; }
    if (!version || version.gameId !== gameId) { setFilterTemplateSaveError('请先读取当前有效版本。'); return; }
    if (parsePidInput(pidInput).length === 0) { setFilterTemplateSaveError('至少填写一个数字 PID。'); return; }
    if (filterTemplates.some((template) => template.name === name && template.id !== editingId)) { setFilterTemplateSaveError('已存在同名筛选模板，请换一个名称。'); return; }
    const template: FilterTemplate = {
      id: editingId ?? globalThis.crypto.randomUUID?.() ?? `filter-template-${Date.now()}`,
      name,
      gameId,
      gameVersionId: version.key,
      pidInput: pidInput.trim(),
      incomeType,
      includeReattribution,
      pitcherFilters: splitPitcherFilters(pitcherFilterInput),
      includePitcherDetails,
    };
    const nextTemplates = editingId
      ? filterTemplates.map((item) => item.id === editingId ? template : item)
      : [...filterTemplates, template];
    const saved = await window.desktopApi.saveFilterTemplates(nextTemplates);
    setFilterTemplates(saved);
    setSelectedFilterTemplateId(template.id);
    setFilterTemplateName('');
    setFilterTemplateEditingId(null);
    setFilterTemplateSaveOpen(false);
    setStatus(`筛选模板“${template.name}”已${editingId ? '更新' : '保存'}。`);
  }

  async function confirmDeleteFilterTemplate() {
    const template = filterTemplatePendingDelete;
    if (!template) return;
    const saved = await window.desktopApi.saveFilterTemplates(filterTemplates.filter((item) => item.id !== template.id));
    setFilterTemplates(saved);
    setSelectedFilterTemplateId('');
    if (filterTemplateEditingId === template.id) setFilterTemplateEditingId(null);
    setFilterTemplatePendingDelete(null);
    setStatus(`筛选模板“${template.name}”已删除。`);
  }

  function requestConfirmation(title: string, message: string, confirmLabel: string, action: () => Promise<void> | void) {
    setPendingConfirmation({ title, message, confirmLabel, action });
  }

  async function confirmPendingAction() {
    const pending = pendingConfirmation;
    if (!pending) return;
    setConfirming(true);
    try {
      await pending.action();
      setPendingConfirmation(null);
    } finally {
      setConfirming(false);
    }
  }

  function requestCancelCurrentTask() {
    requestConfirmation('终止当前任务', '确定终止正在执行的任务吗？后台查询、自动重试和后续机器人发送都会停止；已经发出的消息不会撤回。', '确认终止', async () => {
      const result = await window.desktopApi.cancelCurrentTask();
      if (!result.ok) { setError('终止任务失败，请稍后重试。'); return; }
      setStatus(result.cancelled ? '正在终止当前任务…' : '当前没有正在执行的任务。');
    });
  }

  function updateGameId(value: string) {
    const nextGameId = value.trim();
    projectLoadSequence.current += 1;
    setGameId(value);
    setPitcherFilterInput('');
    setVersion(null);
    setVersionCandidates([]);
    setPidValidation(null);
    setPidValidationSnapshot(null);
    setDirectory([]);
    setConfig((old) => ({ ...old, gameId: nextGameId, currentGameVersionId: null, pidWhitelist: [] }));
    if (/^\d{4,}$/u.test(nextGameId)) void loadProjectConfig(nextGameId);
  }

  async function login() {
    setError('');
    await window.desktopApi.openLogin();
    setBrowserOpen(true);
    setStatus('请在右侧可见浏览器中完成账号、密码和短信验证码登录。');
    window.setTimeout(() => void refreshLogin(), 2500);
  }

  async function hideBrowser() {
    await window.desktopApi.hideBrowser();
    setBrowserOpen(false);
    setStatus('后台浏览器已隐藏，登录状态和已打开标签会保留。');
  }

  async function showBrowser() {
    const nextState = await window.desktopApi.showBrowser();
    setBrowserState(nextState);
    setBrowserOpen(nextState.open);
  }

  function applyBrowserCommand(result: BrowserCommandResult): boolean {
    if (!result.ok) {
      setError(result.error.message);
      return false;
    }
    setBrowserState(result.state);
    setBrowserOpen(result.state.open);
    return true;
  }

  async function selectBrowserTab(id: string) {
    setError('');
    applyBrowserCommand(await window.desktopApi.browserSelectTab(id));
  }

  async function newBrowserTab() {
    setError('');
    applyBrowserCommand(await window.desktopApi.browserNewTab());
  }

  async function closeBrowserTab(id: string) {
    setError('');
    applyBrowserCommand(await window.desktopApi.browserCloseTab(id));
  }

  async function navigateBrowser() {
    setError('');
    if (!addressValue.trim()) return;
    const succeeded = applyBrowserCommand(await window.desktopApi.browserNavigate(addressValue));
    if (succeeded) setStatus('正在打开浏览器地址…');
  }

  async function resolveVersion() {
    setError('');
    if (!/^\d{4,}$/u.test(gameId)) { setError('gameid 必须填写数字。'); return; }
    setVersionCandidates([]);
    setVersion(null);
    setPidValidation(null);
    setPidValidationSnapshot(null);
    setDirectory([]);
    setStatus('正在读取当前有效版本…');
    const result = await window.desktopApi.resolveVersion(gameId) as Result<{ version: VersionCandidate; candidates?: VersionCandidate[] }> & { candidates?: VersionCandidate[] };
    const candidates = result.ok ? [result.version] : (result.candidates ?? []);
    if (candidates.length === 0) {
      setError(result.ok ? '后台没有返回有效版本。' : result.error.message);
      return;
    }
    setVersionCandidates(candidates);
    openVersionPicker('report', candidates);
    setStatus('请选择当前有效版本。');
  }

  async function saveLoginCredentials() {
    setError('');
    const result = await window.desktopApi.saveLoginCredentials({ username: loginCredentialUsername, password: loginCredentialPassword }) as Result<{ status: LoginCredentialStatus }>;
    if (!result.ok) { setError(result.error.message); return; }
    setLoginCredentialStatus(result.status);
    setLoginCredentialPassword('');
    setStatus('无人值守登录账号已加密保存。密码不会在界面中回显。');
  }

  async function clearLoginCredentials() {
    const result = await window.desktopApi.clearLoginCredentials() as Result<{ status: LoginCredentialStatus }>;
    if (!result.ok) { setError(result.error.message); return; }
    setLoginCredentialStatus(result.status);
    setLoginCredentialUsername('');
    setLoginCredentialPassword('');
    setStatus('已清除无人值守登录账号。');
  }

  async function saveDingTalkLoginQr() {
    setError('');
    const result = await window.desktopApi.saveDingTalkLoginQr({ appKey: dingTalkLoginQrAppKey, appSecret: dingTalkLoginQrAppSecret, robotCode: dingTalkLoginQrRobotCode }) as Result<{ status: DingTalkLoginQrStatus }>;
    if (!result.ok) { setError(result.error.message); return; }
    setDingTalkLoginQrStatus(result.status);
    setDingTalkLoginQrAppKey('');
    setDingTalkLoginQrAppSecret('');
    setDingTalkLoginQrRobotCode('');
    setStatus('钉钉企业机器人配置已加密保存。请点击“绑定接收群”，再到目标群里 @机器人发送“绑定二维码”。');
  }

  async function clearDingTalkLoginQr() {
    const result = await window.desktopApi.clearDingTalkLoginQr() as Result<{ status: DingTalkLoginQrStatus }>;
    if (!result.ok) { setError(result.error.message); return; }
    setDingTalkLoginQrStatus(result.status);
    setDingTalkLoginQrAppKey('');
    setDingTalkLoginQrAppSecret('');
    setDingTalkLoginQrRobotCode('');
    setStatus('已清除钉钉扫码登录机器人配置。');
  }

  async function bindDingTalkLoginQrGroup() {
    setError('');
    setBindingDingTalkLoginQr(true);
    setStatus('请在 2 分钟内到目标钉钉群 @机器人，发送“绑定二维码”。');
    try {
      const result = await window.desktopApi.bindDingTalkLoginQrGroup() as Result<{ status: DingTalkLoginQrStatus }>;
      if (!result.ok) { setError(result.error.message); return; }
      setDingTalkLoginQrStatus(result.status);
      setStatus('已绑定接收登录二维码的钉钉群。现在可以发送文字测试或模拟发送。');
    } catch {
      setError('绑定接收群的请求没有成功到达程序。请关闭后重新打开工具，再点击绑定。');
    } finally {
      setBindingDingTalkLoginQr(false);
    }
  }

  async function testDingTalkLoginQr() {
    setError('');
    setTestingDingTalkLoginQr(true);
    setStatus('正在模拟钉钉扫码登录…');
    try {
      const result = await window.desktopApi.testDingTalkLoginQr() as Result<{}>;
      if (!result.ok) { setError(result.error.message); return; }
      setStatus('测试二维码已发送到专用钉钉群；扫码后会登录后台。');
    } catch {
      setError('模拟发送请求没有成功到达程序。请关闭后重新打开工具，再点击测试。');
    } finally {
      setTestingDingTalkLoginQr(false);
    }
  }

  async function testDingTalkLoginText() {
    setError('');
    setTestingDingTalkLoginText(true);
    try {
      const result = await window.desktopApi.testDingTalkLoginText() as Result<{}>;
      if (!result.ok) { setError(result.error.message); return; }
      setStatus('测试消息已发送到专用钉钉群。');
    } catch {
      setError('文字测试请求没有成功到达程序。请关闭后重新打开工具，再点击测试。');
    } finally {
      setTestingDingTalkLoginText(false);
    }
  }

  async function chooseVersion(candidate: VersionCandidate) {
    const next = await window.desktopApi.saveConfig({ ...config, gameId, currentGameVersionId: candidate.key });
    setConfig(next);
    setVersion(candidate);
    setVersionCandidates([]);
    setPidValidation(null);
    setPidValidationSnapshot(null);
    setDirectory([]);
    closeVersionPicker();
    setError('');
    setStatus(`已选择版本：${candidate.name}`);
  }

  function updateRealtimeConfig(updater: (realtime: RealtimeConfig) => RealtimeConfig) {
    setConfig((old) => ({ ...old, realtimeConfig: updater(old.realtimeConfig) }));
  }

  async function resolveRealtimeVersion() {
    setError('');
    const realtime = config.realtimeConfig;
    if (!/^\d{4,}$/u.test(realtime.gameId)) { setError('gameid 必须填写数字。'); return; }
    setRealtimeVersionCandidates([]);
    setRealtimeVersion(null);
    setRealtimeOutput('');
    setStatus('正在读取即时播报所用的当前有效版本…');
    const result = await window.desktopApi.resolveVersion(realtime.gameId) as Result<{ version: VersionCandidate; candidates?: VersionCandidate[] }> & { candidates?: VersionCandidate[] };
    const candidates = result.ok ? [result.version] : (result.candidates ?? []);
    if (candidates.length === 0) {
      setError(result.ok ? '后台没有返回有效版本。' : result.error.message);
      return;
    }
    setRealtimeVersionCandidates(candidates);
    openVersionPicker('realtime', candidates);
    setStatus('请选择即时播报使用的有效版本。');
  }

  async function chooseRealtimeVersion(candidate: VersionCandidate) {
    const saved = await window.desktopApi.saveConfig({
      ...config,
      realtimeConfig: { ...config.realtimeConfig, currentGameVersionId: candidate.key },
    });
    setConfig(saved);
    setRealtimeVersion(candidate);
    setRealtimeVersionCandidates([]);
    setRealtimeOutput('');
    closeVersionPicker();
    setError('');
    setStatus(`即时播报已选择版本：${candidate.name}`);
  }

  async function generateRealtime() {
    setError('');
    const realtime = config.realtimeConfig;
    if (!loggedIn) { setError('请先登录后台。'); return; }
    if (!realtimeVersion) { setError('请先读取当前有效版本。'); return; }
    if (parsePidInput(realtime.pidInput).length === 0) { setError('至少填写一个数字 PID。'); return; }
    if (realtime.startDate > realtime.endDate) { setError('开始日期不能晚于结束日期。'); return; }
    if (!realtime.paymentStatsEndDate) { setError('请选择付费统计结束日期。'); return; }
    const saved = await window.desktopApi.saveConfig({
      ...config,
      realtimeConfig: { ...realtime, currentGameVersionId: realtimeVersion.key },
    });
    setConfig(saved);
    const query: RealtimeQuery = { ...saved.realtimeConfig, gameVersionId: realtimeVersion.key };
    setBusy(true);
    setProgress({ phase: 'prepare', value: 0, message: '正在准备即时播报…' });
    setStatus('正在读取即时 BI 数据…');
    const result = await window.desktopApi.generateRealtime(query) as Result<{ text: string; issues: unknown[] }>;
    setBusy(false);
    if (!result.ok) {
      if (isTaskCancelledResult(result)) {
        setProgress({ phase: 'failed', value: 0, message: '即时播报已终止' });
        setStatus('当前任务已终止。');
        return;
      }
      setError(result.error.message);
      setProgress({ phase: 'failed', value: 0, message: '即时播报生成失败' });
      setStatus('即时播报生成失败');
      return;
    }
    setRealtimeOutput(result.text);
    setProgress({ phase: 'done', value: 1, message: '即时播报已生成' });
    const hasPitcherDetailWarning = result.issues.some((issue: { code?: string }) => issue.code === 'pitcher_detail_no_data' || issue.code === 'pitcher_detail_query_timeout');
    setStatus(hasPitcherDetailWarning ? '即时播报已生成，但有投手明细读取失败，已跳过。' : '即时播报已生成，可直接复制发送。');
  }

  async function copyRealtimeOutput() {
    if (!realtimeOutput) { setError('请先生成即时播报。'); return; }
    try {
      await navigator.clipboard.writeText(realtimeOutput);
      setError('');
      setStatus('即时播报文本已复制。');
    } catch {
      setError('复制失败，请手动选中文本后复制。');
    }
  }

  async function copyTitlePlaceholder(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setError('');
      setStatus(`已复制通配符 ${value}。`);
    } catch {
      setError('复制失败，请手动复制通配符。');
    }
  }

  async function openScheduledExecutionHistory() {
    const records = await window.desktopApi.loadScheduledExecutions();
    setScheduledExecutions(records);
    setScheduledHistoryOpen(true);
  }

  function newScheduleId(): string {
    return globalThis.crypto.randomUUID?.() ?? `schedule-${Date.now()}`;
  }

  function beginNewScheduledReport() {
    setError('');
    setScheduleTimeError('');
    setScheduleSuccessMessage(null);
    setScheduleDraft({
      id: newScheduleId(),
      name: '',
      enabled: true,
      gameId: '',
      gameVersionId: '',
      pidInput: '',
      incomeType: config.defaultIncomeType,
      includeReattribution: false,
      pitcherFilters: [],
      includePitcherDetails: false,
      titleTemplate: '【{pidName}】',
      metricOrder: [...DEFAULT_REALTIME_METRICS],
      scheduleMode: 'fixed',
      startDate: today,
      endDate: null,
      intervalEndTime: '23:59',
      times: ['15:30'],
      targetIds: [],
    });
    setScheduledVersion(null);
    setScheduledVersionCandidates([]);
    setScheduleTimeInputs(scheduleTimeInputsFromTimes(['15:30']));
    setIntervalEndTimeInput({ hour: '23', minute: '59' });
    setSchedulePreview('');
  }

  function editScheduledReport(report: ScheduledReport) {
    setError('');
    setScheduleTimeError('');
    setScheduleSuccessMessage(null);
    setScheduleDraft({ ...report, pitcherFilters: [...(report.pitcherFilters ?? [])], includePitcherDetails: report.includePitcherDetails === true, metricOrder: [...report.metricOrder], times: [...report.times], targetIds: [...report.targetIds], scheduleMode: report.scheduleMode ?? 'fixed', startDate: report.startDate ?? today, endDate: report.endDate ?? null, intervalEndTime: report.intervalEndTime ?? '23:59' });
    setScheduledVersion({ key: report.gameVersionId, name: '已保存版本', gameId: report.gameId, flag: 1 });
    setScheduledVersionCandidates([]);
    setScheduleTimeInputs(scheduleTimeInputsFromTimes(report.times));
    setIntervalEndTimeInput(scheduleTimeInputsFromTimes([report.intervalEndTime ?? '23:59'])[0]);
    setSchedulePreview('');
  }

  function closeScheduledReportEditor() {
    setScheduleDraft(null);
    setScheduledVersionCandidates([]);
    setSchedulePreview('');
  }

  function updateScheduleTime(index: number, field: keyof ScheduleTimeInput, value: string) {
    const digits = value.replace(/\D/gu, '').slice(0, 2);
    const max = field === 'hour' ? 23 : 59;
    const label = field === 'hour' ? '小时' : '分钟';
    if (digits.length === 2 && Number(digits) > max) {
      const message = `${label}只能输入 0-${max}。`;
      setScheduleTimeError(message);
      setError(message);
      return;
    }
    if (scheduleTimeError) {
      setScheduleTimeError('');
      setError('');
    }
    setScheduleTimeInputs((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: digits } : item));
  }

  function formatScheduleTimePart(index: number, field: keyof ScheduleTimeInput) {
    setScheduleTimeInputs((current) => current.map((item, itemIndex) => {
      if (itemIndex !== index || !item[field]) return item;
      return { ...item, [field]: item[field].padStart(2, '0') };
    }));
  }

  function updateIntervalEndTime(field: keyof ScheduleTimeInput, value: string) {
    const digits = value.replace(/\D/gu, '').slice(0, 2);
    const max = field === 'hour' ? 23 : 59;
    const label = field === 'hour' ? '小时' : '分钟';
    if (digits.length === 2 && Number(digits) > max) {
      const message = `${label}只能输入 0-${max}。`;
      setScheduleTimeError(message);
      setError(message);
      return;
    }
    if (scheduleTimeError) {
      setScheduleTimeError('');
      setError('');
    }
    setIntervalEndTimeInput((current) => ({ ...current, [field]: digits }));
  }

  function formatIntervalEndTimePart(field: keyof ScheduleTimeInput) {
    setIntervalEndTimeInput((current) => current[field] ? { ...current, [field]: current[field].padStart(2, '0') } : current);
  }

  function addScheduleTime() {
    setScheduleTimeInputs((current) => [...current, { hour: '', minute: '' }]);
  }

  function removeScheduleTime(index: number) {
    setScheduleTimeInputs((current) => current.length > 1 ? current.filter((_, itemIndex) => itemIndex !== index) : current);
  }

  function openVersionPicker(context: Exclude<VersionPickerContext, null>, candidates: VersionCandidate[]) {
    setVersionPickerContext(context);
    setVersionPickerCandidates(candidates);
    setVersionPickerSelection(candidates[0]?.key ?? '');
  }

  function closeVersionPicker() {
    setVersionPickerContext(null);
    setVersionPickerCandidates([]);
    setVersionPickerSelection('');
  }

  async function confirmVersionSelection() {
    const candidate = versionPickerCandidates.find((item) => item.key === versionPickerSelection);
    if (!candidate || !versionPickerContext) return;
    if (versionPickerContext === 'report') await chooseVersion(candidate);
    if (versionPickerContext === 'realtime') await chooseRealtimeVersion(candidate);
    if (versionPickerContext === 'scheduled') chooseScheduledVersion(candidate);
  }

  async function resolveScheduledVersion() {
    if (!scheduleDraft) return;
    setError('');
    if (!/^\d{4,}$/u.test(scheduleDraft.gameId)) { setError('定时汇报的 gameid 必须填写数字。'); return; }
    setScheduledVersion(null);
    setScheduledVersionCandidates([]);
    setStatus('正在读取定时汇报所用的当前有效版本…');
    const result = await window.desktopApi.resolveVersion(scheduleDraft.gameId) as Result<{ version: VersionCandidate; candidates?: VersionCandidate[] }> & { candidates?: VersionCandidate[] };
    const candidates = result.ok ? [result.version] : (result.candidates ?? []);
    if (candidates.length === 0) {
      setError(result.ok ? '后台没有返回有效版本。' : result.error.message);
      return;
    }
    setScheduledVersionCandidates(candidates);
    openVersionPicker('scheduled', candidates);
    setStatus('请选择定时汇报使用的有效版本。');
  }

  function chooseScheduledVersion(candidate: VersionCandidate) {
    if (!scheduleDraft) return;
    setScheduleDraft({ ...scheduleDraft, gameVersionId: candidate.key });
    setScheduledVersion(candidate);
    setScheduledVersionCandidates([]);
    closeVersionPicker();
    setError('');
    setStatus(`定时汇报已选择版本：${candidate.name}`);
  }

  async function saveScheduledReport(closeAfterSave = false): Promise<ScheduledReport | null> {
    if (!scheduleDraft) return null;
    const scheduleMode = scheduleDraft.scheduleMode ?? 'fixed';
    const times = normalizeScheduleTimeInputs(scheduleMode === 'interval' ? scheduleTimeInputs.slice(0, 1) : scheduleTimeInputs);
    if (!scheduleDraft.name.trim()) { setError('请填写定时计划名称。'); return null; }
    if (!/^\d{4,}$/u.test(scheduleDraft.gameId) || !scheduleDraft.gameVersionId || parsePidInput(scheduleDraft.pidInput).length === 0) {
      setError('定时计划需要有效的 gameid、版本和至少一个 PID。'); return null;
    }
    if (!times || times.length === 0) {
      const message = '发送时间请填写小时和分钟数字，小时范围为 00-23，分钟范围为 00-59。';
      setScheduleTimeError(message);
      setError(message);
      return null;
    }
    const intervalEndTimes = scheduleMode === 'interval' ? normalizeScheduleTimeInputs([intervalEndTimeInput]) : null;
    if (scheduleMode === 'interval' && !intervalEndTimes) {
      const message = '每天结束时间请填写小时和分钟数字，小时范围为 00-23，分钟范围为 00-59。';
      setScheduleTimeError(message);
      setError(message);
      return null;
    }
    const intervalEndTime = intervalEndTimes?.[0];
    if (scheduleMode === 'interval' && (!intervalEndTime || times[0] >= intervalEndTime)) {
      const message = '循环播报的每天结束时间必须晚于开始时间。';
      setScheduleTimeError(message);
      setError(message);
      return null;
    }
    const startDate = scheduleDraft.startDate?.trim() ?? '';
    const endDate = scheduleDraft.endDate === null || scheduleDraft.endDate === undefined ? null : scheduleDraft.endDate.trim();
    if (scheduleMode === 'interval' && !/^\d{4}-\d{2}-\d{2}$/u.test(startDate)) {
      setError('循环播报必须选择开始日期。');
      return null;
    }
    if (scheduleMode === 'fixed' && scheduleDraft.startDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/u.test(startDate)) {
      setError('定时播报请选择开始日期。');
      return null;
    }
    if (endDate && !/^\d{4}-\d{2}-\d{2}$/u.test(endDate)) {
      setError('结束日期格式不正确，请重新选择。');
      return null;
    }
    if (startDate && endDate && endDate < startDate) {
      setError('结束日期不能早于开始日期。');
      return null;
    }
    const intervalMinutes = scheduleDraft.intervalMinutes;
    if (scheduleMode === 'interval' && (!Number.isInteger(intervalMinutes) || (intervalMinutes ?? 0) < 1 || (intervalMinutes ?? 0) > 1440)) {
      setError('循环间隔必须填写 1-1440 分钟。');
      return null;
    }
    if (scheduleDraft.targetIds.length === 0) { setError('请至少选择一个机器人目标。'); return null; }
    const report = {
      ...scheduleDraft,
      name: scheduleDraft.name.trim(),
      pitcherFilters: [...new Set((scheduleDraft.pitcherFilters ?? []).map((value) => value.trim()).filter(Boolean))],
      includePitcherDetails: scheduleDraft.includePitcherDetails === true,
      scheduleMode,
      startDate,
      endDate,
      intervalMinutes: scheduleMode === 'interval' ? intervalMinutes : undefined,
      intervalEndTime: scheduleMode === 'interval' ? intervalEndTime : undefined,
      times: scheduleMode === 'interval' ? [times[0]] : times,
    };
    const currentGameId = config.gameId.trim();
    const targetGameId = report.gameId.trim();
    projectLoadSequence.current += 1;
    const targetConfig = await window.desktopApi.loadConfig(targetGameId);
    const saved = await window.desktopApi.saveConfig({
      ...targetConfig,
      gameId: targetGameId,
      scheduledReports: [...targetConfig.scheduledReports.filter((item) => item.id !== report.id), report],
    }, targetGameId);
    if (currentGameId === targetGameId) setConfig(saved);
    await refreshScheduledReports();
    const normalized = saved.scheduledReports.find((item) => item.id === report.id) ?? report;
    setScheduleDraft({ ...normalized });
    setScheduleTimeInputs(scheduleTimeInputsFromTimes(times));
    setIntervalEndTimeInput(scheduleTimeInputsFromTimes([normalized.intervalEndTime ?? '23:59'])[0]);
    setScheduleTimeError('');
    setStatus(`定时计划“${report.name}”已保存。`);
    setError('');
    if (closeAfterSave) {
      const action = scheduledReports.some((item) => item.id === report.id) ? '编辑成功' : '新建成功';
      closeScheduledReportEditor();
      setScheduleSuccessMessage(`定时计划“${report.name}”${action}。`);
    }
    return normalized;
  }

  async function deleteScheduledReport(report: ScheduledReport) {
    const currentGameId = config.gameId.trim();
    const targetGameId = report.gameId.trim();
    projectLoadSequence.current += 1;
    const targetConfig = await window.desktopApi.loadConfig(targetGameId);
    const saved = await window.desktopApi.saveConfig({
      ...targetConfig,
      gameId: targetGameId,
      scheduledReports: targetConfig.scheduledReports.filter((item) => item.id !== report.id),
    }, targetGameId);
    if (currentGameId === targetGameId) setConfig(saved);
    setScheduledReports((current) => current.filter((item) => item.id !== report.id || item.gameId.trim() !== targetGameId));
    await refreshScheduledReports();
    if (scheduleDraft?.id === report.id && scheduleDraft.gameId.trim() === targetGameId) closeScheduledReportEditor();
    setSchedulePreview('');
    setStatus(`定时计划“${report.name}”已删除。`);
  }

  function toggleScheduleTarget(targetId: string, checked: boolean) {
    if (!scheduleDraft) return;
    setScheduleDraft({
      ...scheduleDraft,
      targetIds: checked ? [...new Set([...scheduleDraft.targetIds, targetId])] : scheduleDraft.targetIds.filter((id) => id !== targetId),
    });
  }

  function toggleScheduledMetric(metricKey: RealtimeMetricKey, checked: boolean) {
    setScheduleDraft((current) => current ? {
      ...current,
      metricOrder: checked ? [...new Set([...current.metricOrder, metricKey])] : current.metricOrder.filter((key) => key !== metricKey),
    } : current);
  }

  function moveScheduledMetric(index: number, direction: -1 | 1) {
    setScheduleDraft((current) => current ? { ...current, metricOrder: moveItem(current.metricOrder, index, direction) } : current);
  }

  async function previewScheduledReport() {
    if (!scheduleDraft) return;
    const savedReport = await saveScheduledReport();
    if (!savedReport) return;
    setBusy(true);
    setProgress({ phase: 'prepare', value: 0, message: '正在准备定时汇报预览…' });
    const result = await window.desktopApi.previewScheduledReport(savedReport.id) as Result<{ text: string }>;
    setBusy(false);
    if (!result.ok) {
      if (isTaskCancelledResult(result)) { setStatus('当前任务已终止。'); return; }
      setError(result.error.message); setStatus('定时汇报预览失败'); return;
    }
    setSchedulePreview(result.text);
    setStatus('已按当前北京时间的即时数据生成预览，尚未发送。');
  }

  async function runScheduledReport(report: ScheduledReport) {
    setError('');
    setBusy(true);
    setStatus('正在手动执行定时汇报…');
    const result = await window.desktopApi.runScheduledReport(report.id) as Result<{ record: ScheduledExecutionRecord }>;
    setBusy(false);
    if (!result.ok) { setError(result.error.message); setStatus('定时汇报执行失败'); return; }
    setScheduledExecutions((current) => [result.record, ...current.filter((item) => item.slotKey !== result.record.slotKey)].slice(0, 30));
    setStatus(result.record.code === 'TASK_CANCELLED' ? '当前任务已终止。' : result.record.result === 'success' ? '定时汇报已发送。' : '定时汇报已执行，请查看最近执行记录。');
  }

  async function saveDeliveryTarget() {
    setError('');
    const result = await window.desktopApi.saveDeliveryTarget(deliveryTargetDraft) as Result<{ targets: DeliveryTarget[] }>;
    if (!result.ok) { setError(result.error.message); return; }
    setDeliveryTargets(result.targets);
    setDeliveryTargetDraft(emptyDeliveryTargetDraft());
    setStatus('机器人配置已加密保存。可点击“发送测试”验证配置。');
  }

  function openDeliveryConfig() {
    setDeliveryTargetDraft(emptyDeliveryTargetDraft());
    setConfigModal('delivery');
    setError('');
  }

  function closeOnboardingGuide() {
    window.localStorage.setItem(ONBOARDING_GUIDE_SEEN_KEY, 'true');
    setConfigModal(null);
  }

  function editDeliveryTarget(target: DeliveryTarget) {
    setDeliveryTargetDraft({ id: target.id, name: target.name, platform: target.platform, enabled: target.enabled, webhookUrl: '', signingSecret: '' });
    setConfigModal('delivery');
    setError('');
  }

  async function testDeliveryTarget(target: DeliveryTarget) {
    setError('');
    setBusy(true);
    const result = await window.desktopApi.testDeliveryTarget(target.id) as Result<Record<string, never>>;
    setBusy(false);
    if (!result.ok) { setError(result.error.message); return; }
    setStatus(`已向“${target.name}”发送测试消息。`);
  }

  async function deleteDeliveryTarget(target: DeliveryTarget) {
    setError('');
    const result = await window.desktopApi.deleteDeliveryTarget(target.id) as Result<Record<string, never>>;
    if (!result.ok) { setError(result.error.message); return; }
    setDeliveryTargets((current) => current.filter((item) => item.id !== target.id));
    await refreshScheduledReports();
    setConfig((current) => ({ ...current, scheduledReports: current.scheduledReports.map((report) => {
      const targetIds = report.targetIds.filter((id) => id !== target.id);
      return { ...report, targetIds, enabled: targetIds.length > 0 && report.enabled };
    }) }));
    setStatus(`机器人目标“${target.name}”已删除。失去全部目标的计划已自动停用，重新选择目标后保存即可启用。`);
  }

  async function verifyPids() {
    setError('');
    if (!version) { setError('请先读取 gameid 对应的当前有效版本。'); return; }
    if (parsePidInput(pidInput).length === 0) { setError('至少填写一个数字 PID。'); return; }
    setStatus('正在读取 PID 中文名称并校验…');
    const result = await window.desktopApi.lookupPids(gameId, version.key, pidInput, config) as Result<{ directory: PidDirectoryEntry[]; validation: PidValidationResult }>;
    if (!result.ok) { setError(result.error.message); setPidValidation(null); return; }
    setDirectory(result.directory);
    setPidValidation(result.validation);
    setPidValidationSnapshot(createQueryValidationSnapshot(gameId, version.key, pidInput));
    const nextConfig = {
      ...config,
      pidWhitelist: result.validation.accepted,
      pidNames: { ...config.pidNames },
      pidPackageMap: { ...config.pidPackageMap },
      pidOperatingSystemMap: { ...config.pidOperatingSystemMap },
    };
    for (const entry of result.validation.entries) {
      if (!entry.name) continue;
      nextConfig.pidNames[entry.id] = entry.name;
      const channel = entry.channel ?? inferPackageName(entry.name);
      if (channel) nextConfig.pidPackageMap[entry.id] = channel;
      else delete nextConfig.pidPackageMap[entry.id];
      if (entry.operatingSystem) nextConfig.pidOperatingSystemMap[entry.id] = entry.operatingSystem;
      else delete nextConfig.pidOperatingSystemMap[entry.id];
    }
    setConfig(nextConfig);
    void window.desktopApi.saveConfig(nextConfig);
    setStatus(result.validation.issues.some((issue: PidValidationResult['issues'][number]) => issue.level === 'error') ? 'PID 校验未通过，请按提示修正。' : 'PID 校验通过，可以生成报表。');
  }

  function removePid(pid: string) {
    const nextInput = removePidFromInput(pidInput, pid);
    setPidInput(nextInput);
    if (!nextInput) {
      setPidValidation(null);
      setPidValidationSnapshot(null);
      setConfig((old) => ({ ...old, pidWhitelist: [] }));
      setStatus(`已移除 PID ${pid}，请继续填写需要查询的 PID。`);
      return;
    }
    const nextValidation = validatePids(gameId, nextInput, directory, config);
    setPidValidation(nextValidation);
    setPidValidationSnapshot(version ? createQueryValidationSnapshot(gameId, version.key, nextInput) : null);
    setConfig((old) => ({ ...old, pidWhitelist: nextValidation.accepted }));
    setStatus(`已移除 PID ${pid}，剩余 PID 已重新校验。`);
  }

  function deletePidCache(pid: string) {
    setConfig((old) => {
      const nextNames = { ...old.pidNames };
      const nextPackages = { ...old.pidPackageMap };
      const nextOperatingSystems = { ...old.pidOperatingSystemMap };
      delete nextNames[pid];
      delete nextPackages[pid];
      delete nextOperatingSystems[pid];
      return { ...old, pidNames: nextNames, pidPackageMap: nextPackages, pidOperatingSystemMap: nextOperatingSystems };
    });
  }

  function deleteBidCode(code: string) {
    setConfig((old) => {
      const next = { ...old.bidCodeMap };
      delete next[code];
      return { ...old, bidCodeMap: next };
    });
  }

  function deletePitcherName(code: string) {
    setConfig((old) => {
      const next = { ...old.pitcherNameMap };
      delete next[code];
      return { ...old, pitcherNameMap: next };
    });
  }

  async function generate() {
    setError('');
    if (!loggedIn) { setError('请先登录后台。'); return; }
    if (!version) { setError('请先读取当前有效版本。'); return; }
    const versionResult = await window.desktopApi.resolveVersion(gameId) as Result<{ version: VersionCandidate; candidates?: VersionCandidate[] }> & { candidates?: VersionCandidate[] };
    const currentCandidates = versionResult.candidates ?? (versionResult.ok ? [versionResult.version] : []);
    const currentVersion = currentCandidates.find((candidate) => candidate.key === version.key && candidate.gameId === gameId);
    if (!currentVersion) {
      if (currentCandidates.length > 0 || versionResult.ok) {
        const resetConfig = await window.desktopApi.saveConfig({ ...config, gameId, currentGameVersionId: null, pidWhitelist: [] });
        setConfig(resetConfig);
        setVersion(null);
        setVersionCandidates(currentCandidates);
        if (currentCandidates.length > 0) openVersionPicker('report', currentCandidates);
        setPidValidation(null);
        setPidValidationSnapshot(null);
        setDirectory([]);
        setError('已保存或已选择的版本不再是当前 gameid 的有效版本，请重新选择版本并验证 PID。');
      } else {
        setError(versionResult.error.message);
      }
      return;
    }
    setVersion(currentVersion);
    if (!pidValidation || pidValidation.issues.some((issue) => issue.level === 'error')) { setError('请先完成 PID 校验，并修正错误。'); return; }
    if (!isQueryValidationSnapshotCurrent(pidValidationSnapshot, gameId, version.key, pidInput)) {
      setError('查询条件已变化，请重新读取名称并验证 PID 后再生成。');
      return;
    }
    if (startDate > endDate) { setError('开始日期不能晚于结束日期。'); return; }
    if (!paymentStatsEndDate) { setError('请选择付费统计结束日期。'); return; }
    const query: ReportQuery = { gameId, gameVersionId: version.key, pids: pidValidation.accepted, startDate, endDate, paymentStatsEndDate, incomeType, includeReattribution, pitcherFilters: splitPitcherFilters(pitcherFilterInput), includePitcherDetails };
    setBusy(true);
    setProgress({ phase: 'prepare', value: 0, message: '正在准备生成…' });
    setStatus('正在准备生成…');
    const saved = await window.desktopApi.saveConfig({ ...config, gameId, currentGameVersionId: version.key, defaultIncomeType: incomeType });
    setConfig(saved);
    const result = await window.desktopApi.generate(query, saved) as Result<{ path: string; rowCount: number; source: string; issues: Array<{ code?: string }> }>;
    setBusy(false);
    if (!result.ok) {
      if (isTaskCancelledResult(result)) {
        setProgress({ phase: 'failed', value: 0, message: '报表生成已终止' });
        setStatus('当前任务已终止。');
        return;
      }
      setError(result.error.message); setProgress({ phase: 'failed', value: 0, message: '生成失败' }); setStatus('生成失败'); return;
    }
    setProgress({ phase: 'done', value: 1, message: '生成完成' });
    const hasPitcherDetailWarning = result.issues.some((issue: { code?: string }) => issue.code === 'pitcher_detail_no_data' || issue.code === 'pitcher_detail_query_timeout');
    setStatus(hasPitcherDetailWarning
      ? '报表已生成，但有投手明细读取失败，请检查数据校验 Sheet。'
      : `生成完成：共处理 ${result.rowCount} 行，数据来源：后台结构化数据`);
    await window.desktopApi.openOutputDirectory(result.path);
  }

  async function saveConfig(message = '设置已保存。') {
    const saved = await window.desktopApi.saveConfig(config);
    setConfig(saved);
    setStatus(message);
  }

  async function saveProjectConfigSection(section: ProjectConfigSection) {
    await window.desktopApi.saveConfigSection(config, section);
    const sectionName: Record<ProjectConfigSection, string> = {
      basic: '项目基础配置',
      pidCache: 'PID 自动识别配置',
      mediaRules: '媒体识别规则',
      bidCodes: '出价代码映射',
      pitcherNames: '投手名映射',
    };
    setStatus(`${sectionName[section]}已保存。`);
  }

  async function saveModalConfig(message: string) {
    await saveConfig(message);
    setConfigModal(null);
  }

  async function chooseOutputDirectory() {
    const selected = await window.desktopApi.pickOutputDirectory();
    if (!selected) return;
    const next = await window.desktopApi.saveConfig({ ...config, outputDirectory: selected });
    setConfig(next);
  }

  function updateSheet(id: string, updater: (sheet: SheetConfig) => SheetConfig) {
    setConfig((old) => ({ ...old, sheetConfigs: old.sheetConfigs.map((sheet) => sheet.id === id ? updater(sheet) : sheet) }));
  }

  function syncMetrics() {
    const source = config.sheetConfigs.find((sheet) => sheet.id === activeSheet);
    if (!source) return;
    setConfig((old) => ({ ...old, defaultMetrics: [...source.metricOrder], sheetConfigs: old.sheetConfigs.map((sheet) => ({ ...sheet, metricOrder: [...source.metricOrder] })) }));
    setStatus('当前 Sheet 指标配置已同步到全部 Sheet。');
  }

  function updateMediaRule(index: number, updater: (rule: MediaRule) => MediaRule) {
    setConfig((old) => ({ ...old, mediaRules: old.mediaRules.map((rule, ruleIndex) => ruleIndex === index ? updater(rule) : rule) }));
  }

  function addBidCode() {
    const key = newBidCode.trim();
    if (!key) { setError('请先填写出价代码。'); return; }
    setConfig((old) => ({ ...old, bidCodeMap: updateRecord(old.bidCodeMap, key, newBidName || key) }));
    setNewBidCode('');
    setNewBidName('');
    setError('');
  }

  function addPitcherName() {
    const code = newPitcherCode.trim();
    if (!code) { setError('请先填写投手代码。'); return; }
    setConfig((old) => ({ ...old, pitcherNameMap: updateRecord(old.pitcherNameMap, code, newPitcherName || code) }));
    setNewPitcherCode('');
    setNewPitcherName('');
    setError('');
  }

  function toggleProjectSection(section: ProjectSection) {
    setProjectSectionsExpanded((current) => ({ ...current, [section]: !current[section] }));
  }

  async function moveTaskQueueItem(task: TaskQueueItem, direction: -1 | 1) {
    const result = await window.desktopApi.moveTaskQueueItem(task.id, direction);
    if (!result.ok) {
      setError('只能调整排队中的任务顺序。');
      return;
    }
    setTaskQueueItems(result.state);
  }

  function requestRemoveTaskQueueItem(task: TaskQueueItem) {
    requestConfirmation('删除队列任务', `确定从任务队列中删除“${task.name}”吗？删除后不会再执行。`, '确认删除', async () => {
      const result = await window.desktopApi.removeTaskQueueItem(task.id);
      if (!result.ok) {
        setError('当前任务正在执行，不能删除。');
        return;
      }
      setTaskQueueItems(result.state);
      setStatus(`队列任务“${task.name}”已删除。`);
    });
  }

  function requestCancelTaskQueueItem(task: TaskQueueItem) {
    requestConfirmation('终止队列任务', `确定终止“${task.name}”吗？已经发出的消息不会撤回。`, '确认终止', async () => {
      const result = await window.desktopApi.cancelTaskQueueItem(task.id);
      if (!result.ok) {
        setError('终止任务失败，请稍后重试。');
        return;
      }
      setTaskQueueItems(result.state);
      setStatus(`正在终止“${task.name}”…`);
    });
  }

  function renderTaskQueue() {
    const queuedItems = taskQueueItems.filter((item) => item.status === 'queued');
    return <section id="task-queue-modal" className="config-modal task-queue-modal" role="dialog" aria-modal="true" aria-labelledby="task-queue-title">
      <div className="config-modal-header">
        <div><h2 id="task-queue-title">任务队列</h2><span className="section-meta">BI 查询按顺序执行，新的任务会自动排到末尾</span></div>
        <div className="task-queue-header-actions"><span className="tag">{taskQueueItems.filter((item) => item.status === 'running' || item.status === 'queued').length} 个待处理</span><button className="ghost modal-close" onClick={() => setTaskQueueModalOpen(false)} aria-label="关闭任务队列">×</button></div>
      </div>
      <div className="config-modal-body">
      {taskQueueItems.length === 0 ? <div className="empty-state">当前没有任务。点击“生成 Excel”“生成即时播报”或“立即发送”后，任务会显示在这里。</div> : <div className="task-queue-list">
        {taskQueueItems.map((task) => {
          const queuedIndex = task.status === 'queued' ? queuedItems.findIndex((item) => item.id === task.id) : -1;
          return <div className={`task-queue-item task-queue-${task.status}`} key={task.id}>
            <div className="task-queue-summary"><div><strong>{task.name}</strong><span className="tag">{taskQueueKindLabel(task.kind)}</span><span className={`tag ${task.status === 'success' ? 'ok' : task.status === 'failed' || task.status === 'cancelled' ? 'unknown' : ''}`}>{taskQueueStatusLabel(task.status)}</span></div><small>{task.message}{task.status === 'queued' && queuedIndex >= 0 ? ` · 队列第 ${queuedIndex + 1} 位` : ''}</small></div>
            <div className="task-queue-actions">
              {task.status === 'queued' && <><button className="ghost small" onClick={() => void moveTaskQueueItem(task, -1)} disabled={queuedIndex <= 0} aria-label={`上移${task.name}`}>↑</button><button className="ghost small" onClick={() => void moveTaskQueueItem(task, 1)} disabled={queuedIndex < 0 || queuedIndex >= queuedItems.length - 1} aria-label={`下移${task.name}`}>↓</button></>}
              {task.status === 'running' && <button className="danger-action small" onClick={() => requestCancelTaskQueueItem(task)}>终止</button>}
              {task.status !== 'running' && <button className="ghost danger-text small" onClick={() => requestRemoveTaskQueueItem(task)}>删除</button>}
            </div>
          </div>;
        })}
      </div>}
      </div>
      <div className="config-modal-footer"><button className="ghost" onClick={() => setTaskQueueModalOpen(false)}>关闭</button></div>
    </section>;
  }

  const selectedSheet = useMemo(() => config.sheetConfigs.find((sheet) => sheet.id === activeSheet) ?? config.sheetConfigs[0], [activeSheet, config.sheetConfigs]);
  const pidRows = pidValidation?.entries ?? [];
  const pidConfigIds = Array.from(new Set([...Object.keys(config.pidNames), ...Object.keys(config.pidPackageMap)])).sort();
  const realtime = config.realtimeConfig;
  const canQueueAnotherTask = taskQueueItems.some((item) => item.status === 'running' || item.status === 'queued');
  const pendingTaskCount = taskQueueItems.filter((item) => item.status === 'running' || item.status === 'queued').length;

  return (
    <>
      <div className={`app-shell${browserOpen ? ' browser-open' : ''}`}>
       <div className="app-chrome">
          <header className="topbar">
            <div className="brand-lockup"><img className="app-logo" src={appLogo} alt="Q1 Operations Logo" /><div><div className="eyebrow">Q1 OPERATIONS</div><h1>后台数据报表生成器</h1></div></div>
           <div className="top-actions">
              <button type="button" className={loggedIn ? 'login-status ok' : 'login-status'} onClick={() => void refreshLogin()} title="点击刷新登录状态"><span aria-hidden="true" />{loggedIn ? '后台已登录' : '未登录'}</button>
              <button className={`browser-toggle${browserOpen ? ' open' : ''}`} onClick={() => void (browserOpen ? hideBrowser() : browserState.tabs.length > 0 ? showBrowser() : login())}>{browserOpen ? '收起浏览器' : loggedIn ? '打开浏览器' : '登录后台'}</button>
              <button type="button" className={`task-queue-toggle${taskQueueModalOpen ? ' active' : ''}`} onClick={() => setTaskQueueModalOpen(true)} aria-expanded={taskQueueModalOpen} aria-controls="task-queue-modal" aria-label="打开任务队列"><span className="task-queue-toggle-icon" aria-hidden="true">☷</span><span>任务队列</span>{pendingTaskCount > 0 && <span className="task-queue-count">{pendingTaskCount}</span>}</button>
              <button className="help-entry" onClick={() => setConfigModal('onboarding')} aria-label="打开使用教程" title="使用教程">?</button>
           </div>
         </header>

          <nav className="tabs">
            <button className={tab === 'generate' ? 'active' : ''} onClick={() => setTab('generate')}>生成报表</button>
            <button className={tab === 'realtime' ? 'active' : ''} onClick={() => setTab('realtime')}>即时播报</button>
            <button className={tab === 'scheduled' ? 'active' : ''} onClick={() => setTab('scheduled')}>定时汇报</button>
            <button className={tab === 'project' ? 'active' : ''} onClick={() => setTab('project')}>设置</button>
          </nav>
       </div>

      <main className="content">
        {tab === 'generate' && <>
           <section className="card hero-card">
             <div className="section-title"><div className="section-heading"><h2>快速生成</h2><span className="section-meta">统一使用北京时间</span></div><ActionMenu label="页面工具"><button className="ghost" onClick={openFilterTemplateManager}>筛选模板</button><button className="ghost" onClick={() => setConfigModal('report')}>报表配置</button></ActionMenu></div>
             <div className="form-grid four">
              <label><FieldLabel text="gameid" help="填写项目编号，只能填写数字。" /><div className="gameid-input-row"><input value={gameId} onChange={(event) => updateGameId(event.target.value)} placeholder="例如：2170" /><button type="button" className="inline gameid-version-button" onClick={() => void resolveVersion()}>读取有效版本</button></div></label>
              <div className="field-button"><FieldLabel text="当前有效版本" help="显示已确认使用的版本。需要更换版本时，点击 gameid 右侧的“读取有效版本”。" /><div className="readonly-field">{version?.name ?? '尚未读取'}</div></div>
              <label><FieldLabel text="收入类型" help="收入是后台收入口径，实收是扣除相关因素后的实收口径。" /><select value={incomeType} onChange={(event) => setIncomeType(event.target.value as 'amount' | 'realamount')}><option value="amount">收入</option><option value="realamount">实收</option></select></label>
               <label className="toggle-label"><FieldLabel text="重归因" help="默认关闭；只有需要查看重归因数据时才打开。" /><input className="checkbox" type="checkbox" checked={includeReattribution} onChange={(event) => setIncludeReattribution(event.target.checked)} /></label>
               <label className="toggle-label"><FieldLabel text="生成分投手明细" help="打开后，Excel 会按投手生成额外明细 Sheet。" /><input className="checkbox" type="checkbox" checked={includePitcherDetails} onChange={(event) => setIncludePitcherDetails(event.target.checked)} /></label>
               <label><FieldLabel text="投手筛选" help="按广告概览里的投手筛选器筛选投手；多个用逗号或换行分隔，留空表示全部投手。" /><input value={pitcherFilterInput} onChange={(event) => setPitcherFilterInput(event.target.value)} placeholder="填写投手代码；留空表示全部投手" /></label>
            </div>
            <div className="form-grid dates">
              <label>开始日期<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
              <label>结束日期<input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label>
              <label>付费统计结束日期<input type="date" value={paymentStatsEndDate} onChange={(event) => setPaymentStatsEndDate(event.target.value)} /></label>
              <div className="output-picker"><span>输出目录</span><div className="path-field">{config.outputDirectory || '默认使用系统下载目录'}</div><button className="inline" onClick={() => void chooseOutputDirectory()}>选择目录</button></div>
            </div>
          </section>

          <section className="card">
            <div className="section-title"><div><h2>PID确认</h2></div><button className="secondary" onClick={() => void verifyPids()}>读取名称并验证</button></div>
            <FieldLabel text="PID" help="可填写多个数字 PID，使用逗号、空格或换行分隔。填写后先点击“读取名称并验证”。" /><textarea value={pidInput} onChange={(event) => { setPidInput(event.target.value); setPidValidation(null); setPidValidationSnapshot(null); }} placeholder="例如：2170405, 2170304" rows={3} />
            {pidRows.length > 0 && <div className="pid-table"><div className="pid-row pid-head"><span>PID</span><span>后台中文名称</span><span>投放类型</span><span>状态</span><span>渠道</span><span>操作系统</span><span>操作</span></div>{pidRows.map((entry, index) => <div className="pid-row" key={`${entry.id}-${entry.status}-${index}`}><span className="mono">{entry.id}</span><span>{entry.name || '未找到'}</span><span className={`tag ${entry.deliveryType === '直播' ? 'delivery-live' : entry.deliveryType === '信息流' ? 'delivery-flow' : entry.deliveryType === '自然量' ? 'delivery-natural' : 'unknown'}`}>{entry.deliveryType}</span><span className={`tag ${entry.status}`}>{entry.status === 'ok' ? '通过' : entry.status === 'duplicate' ? '重复' : '有误'}</span><span>{entry.channel ?? entry.packageName ?? '未识别'}</span><span>{entry.operatingSystem ?? '未识别'}</span><button className="pid-remove" aria-label={`移除 PID ${entry.id}`} onClick={() => removePid(entry.id)}>移除</button></div>)}</div>}
          </section>

        </>}

         {tab === 'realtime' && <>
          <section className="card hero-card">
            <div className="section-title"><div className="section-heading"><h2>即时播报</h2><span className="section-meta">手动获取当前北京时间数据</span></div><button className="ghost" onClick={() => setConfigModal('realtime')}>指标与标题</button></div>
            <div className="form-grid four">
              <label><FieldLabel text="gameid" help="填写需要播报的项目编号，只能填写数字。" /><div className="gameid-input-row"><input value={realtime.gameId} onChange={(event) => { const nextGameId = event.target.value; updateRealtimeConfig((current) => ({ ...current, gameId: nextGameId, currentGameVersionId: nextGameId === current.gameId ? current.currentGameVersionId : null })); setRealtimeVersion(null); setRealtimeVersionCandidates([]); setRealtimeOutput(''); }} placeholder="例如：2170" /><button type="button" className="inline gameid-version-button" onClick={() => void resolveRealtimeVersion()}>读取有效版本</button></div></label>
              <div className="field-button"><FieldLabel text="当前有效版本" help="显示已确认使用的版本。需要更换版本时，点击 gameid 右侧的“读取有效版本”。" /><div className="readonly-field">{realtimeVersion?.name ?? '尚未读取'}</div></div>
              <label><FieldLabel text="收入类型" help="选择播报数据使用“收入”还是“实收”口径。" /><select value={realtime.incomeType} onChange={(event) => updateRealtimeConfig((current) => ({ ...current, incomeType: event.target.value as 'amount' | 'realamount' }))}><option value="amount">收入</option><option value="realamount">实收</option></select></label>
              <label className="toggle-label"><FieldLabel text="重归因" help="默认关闭；打开后读取重归因数据。" /><input className="checkbox" type="checkbox" checked={realtime.includeReattribution} onChange={(event) => updateRealtimeConfig((current) => ({ ...current, includeReattribution: event.target.checked }))} /></label>
              <label><FieldLabel text="投手筛选" help="按广告概览里的投手筛选器筛选投手；多个用逗号或换行分隔，留空表示全部投手。" /><input value={(realtime.pitcherFilters ?? []).join(', ')} onChange={(event) => { const pitcherFilters = splitPitcherFilters(event.target.value); updateRealtimeConfig((current) => ({ ...current, pitcherFilters, includePitcherDetails: pitcherFilters.length > 0 ? current.includePitcherDetails : false })); setRealtimeOutput(''); }} placeholder="填写投手代码；留空表示全部投手" /></label>
              <label className="toggle-label"><FieldLabel text="生成分投手明细" help="填写投手筛选并打开后，先生成全部投手合计，再逐位生成各投手明细；无数据或超时的投手会跳过并提示。" /><input className="checkbox" type="checkbox" checked={realtime.includePitcherDetails} disabled={(realtime.pitcherFilters ?? []).length === 0} onChange={(event) => updateRealtimeConfig((current) => ({ ...current, includePitcherDetails: event.target.checked }))} /></label>
            </div>
            <div className="form-grid dates">
              <label>开始日期<input type="date" value={realtime.startDate} onChange={(event) => updateRealtimeConfig((current) => ({ ...current, startDate: event.target.value }))} /></label>
              <label>结束日期<input type="date" value={realtime.endDate} onChange={(event) => updateRealtimeConfig((current) => ({ ...current, endDate: event.target.value }))} /></label>
              <label>付费统计结束日期<input type="date" value={realtime.paymentStatsEndDate} onChange={(event) => updateRealtimeConfig((current) => ({ ...current, paymentStatsEndDate: event.target.value }))} /></label>
            </div>
          </section>

           <section className="card">
             <div className="section-title"><div><h2>播报对象</h2></div></div>
               <label><FieldLabel text="PID" help="填写一个或多个需要播报的数字 PID，使用逗号、空格或换行分隔。" /><textarea value={realtime.pidInput} onChange={(event) => { updateRealtimeConfig((current) => ({ ...current, pidInput: event.target.value })); setRealtimeOutput(''); }} placeholder="例如：2170405, 2170304" rows={3} /></label>
           </section>

          <section className="card realtime-card">
            <div className="section-title"><div><h2>可复制文本</h2></div><button className="secondary" onClick={() => void copyRealtimeOutput()} disabled={!realtimeOutput}>复制文本</button></div>
            <div className="realtime-output"><textarea readOnly value={realtimeOutput} placeholder="点击窗口底部的“生成即时播报”后，文本会显示在这里。" rows={18} /></div>
           </section>
         </>}

         {tab === 'scheduled' && <>
           <section className="card hero-card">
              <div className="section-title"><div className="section-heading"><h2>定时汇报</h2><span className="section-meta">固定时区：Asia/Shanghai</span></div><div className="section-actions"><ActionMenu label="管理"><button className="ghost" onClick={() => void openScheduledExecutionHistory()}>执行记录</button><button className="ghost" onClick={openDeliveryConfig}>机器人配置</button></ActionMenu><button className="primary small" onClick={beginNewScheduledReport}>新建计划</button></div></div>
              {scheduledReports.length > 0 ? <div className="schedule-list">{scheduledReports.map((report) => <div className={`schedule-item${scheduleDraft?.id === report.id ? ' editing' : ''}`} key={report.id}><div className="schedule-item-summary"><div><strong>{report.name}</strong><span className={report.enabled ? 'tag ok' : 'tag'}>{report.enabled ? '已启用' : '已停用'}</span>{scheduleDraft?.id === report.id && <span className="tag editing-tag">正在编辑</span>}</div><small>项目 {report.gameId} · {report.scheduleMode === 'interval' ? `每 ${report.intervalMinutes} 分钟，每天 ${report.times[0]} 至 ${report.intervalEndTime ?? '23:59'}` : `每天 ${report.times.join('、')}`} · 下次：{nextScheduledRun(report) ?? '未启用'} · {report.targetIds.length} 个机器人配置</small></div><div className="schedule-item-actions"><button className="secondary" onClick={() => void runScheduledReport(report)}>立即发送</button><ActionMenu label="更多"><button className="ghost" onClick={() => editScheduledReport(report)}>编辑</button><button className="ghost danger-text" onClick={() => requestConfirmation('删除定时计划', `确定删除定时计划“${report.name}”吗？删除后无法恢复。`, '确认删除', () => deleteScheduledReport(report))}>删除</button></ActionMenu></div></div>)}</div> : <div className="empty-state">还没有定时计划。点击“新建计划”后，直接在本页填写项目、版本和 PID。</div>}
           </section>

            {scheduleDraft && <div className={`config-modal-backdrop${browserOpen ? ' browser-open' : ''}`}>
              <section className="config-modal scheduled-report-modal" role="dialog" aria-modal="true" aria-labelledby="scheduled-report-title">
                <div className="config-modal-header"><div><h2 id="scheduled-report-title">{scheduledReports.some((report) => report.id === scheduleDraft.id) ? '编辑定时计划' : '新建定时计划'}</h2></div><button className="ghost modal-close" onClick={closeScheduledReportEditor} aria-label="关闭定时计划编辑">×</button></div>
                <div className="config-modal-body">
                  {scheduleTimeError && <div className="schedule-time-error" role="alert">{scheduleTimeError}</div>}
                  <div className="schedule-project-panel">
                    <h3>定时汇报项目配置</h3>
                    <div className="form-grid four">
                      <label><FieldLabel text="任务名称" help="给这条定时汇报起一个容易认出的名字。" /><input value={scheduleDraft.name} onChange={(event) => setScheduleDraft({ ...scheduleDraft, name: event.target.value })} placeholder="例如：国服下午定时汇报" /></label>
                      <div className="schedule-time-field"><FieldLabel text="播报方式" help="定时播报是在每天固定时间发送；循环播报会在每天设定的开始和结束时间之间，每隔指定分钟发送一次。" /><select value={scheduleDraft.scheduleMode ?? 'fixed'} onChange={(event) => setScheduleDraft({ ...scheduleDraft, scheduleMode: event.target.value as 'fixed' | 'interval' })}><option value="fixed">定时播报（每天固定时间）</option><option value="interval">循环播报（每隔 X 分钟）</option></select>{(scheduleDraft.scheduleMode ?? 'fixed') === 'fixed' ? <><div className="interval-config-grid"><label><span>开始日期</span><input type="date" value={scheduleDraft.startDate ?? today} onChange={(event) => setScheduleDraft({ ...scheduleDraft, startDate: event.target.value })} /></label><label><span>结束日期</span><div className="date-end-control"><input type="date" value={scheduleDraft.endDate ?? ''} min={scheduleDraft.startDate ?? today} onChange={(event) => setScheduleDraft({ ...scheduleDraft, endDate: event.target.value || null })} /><span className="inline-toggle"><input type="checkbox" checked={scheduleDraft.endDate === null} onChange={(event) => setScheduleDraft({ ...scheduleDraft, endDate: event.target.checked ? null : (scheduleDraft.startDate ?? today) })} />永久</span></div></label></div><div className="schedule-time-list">{scheduleTimeInputs.map((time, index) => <div className="schedule-time-row" key={index}><div className="schedule-time-input"><input type="text" inputMode="numeric" maxLength={2} min="0" max="23" pattern="[0-9]*" value={time.hour} onChange={(event) => updateScheduleTime(index, 'hour', event.target.value)} onBlur={() => formatScheduleTimePart(index, 'hour')} aria-label={`第 ${index + 1} 个发送时间的小时`} placeholder="时" /><span>:</span><input type="text" inputMode="numeric" maxLength={2} min="0" max="59" pattern="[0-9]*" value={time.minute} onChange={(event) => updateScheduleTime(index, 'minute', event.target.value)} onBlur={() => formatScheduleTimePart(index, 'minute')} aria-label={`第 ${index + 1} 个发送时间的分钟`} placeholder="分" /></div><button className="ghost" onClick={() => removeScheduleTime(index)} disabled={scheduleTimeInputs.length === 1}>删除</button></div>)}</div><button className="secondary small schedule-time-add" onClick={addScheduleTime}>添加发送时间</button></> : <div className="interval-config-grid"><label><span>开始日期</span><input type="date" value={scheduleDraft.startDate ?? today} onChange={(event) => setScheduleDraft({ ...scheduleDraft, startDate: event.target.value })} /></label><label><span>每天开始时间</span><div className="schedule-time-input"><input type="text" inputMode="numeric" maxLength={2} min="0" max="23" pattern="[0-9]*" value={scheduleTimeInputs[0]?.hour ?? ''} onChange={(event) => updateScheduleTime(0, 'hour', event.target.value)} onBlur={() => formatScheduleTimePart(0, 'hour')} aria-label="循环播报每天开始时间的小时" placeholder="时" /><span>:</span><input type="text" inputMode="numeric" maxLength={2} min="0" max="59" pattern="[0-9]*" value={scheduleTimeInputs[0]?.minute ?? ''} onChange={(event) => updateScheduleTime(0, 'minute', event.target.value)} onBlur={() => formatScheduleTimePart(0, 'minute')} aria-label="循环播报每天开始时间的分钟" placeholder="分" /></div></label><label><span>每天结束时间</span><div className="schedule-time-input"><input type="text" inputMode="numeric" maxLength={2} min="0" max="23" pattern="[0-9]*" value={intervalEndTimeInput.hour} onChange={(event) => updateIntervalEndTime('hour', event.target.value)} onBlur={() => formatIntervalEndTimePart('hour')} aria-label="循环播报每天结束时间的小时" placeholder="时" /><span>:</span><input type="text" inputMode="numeric" maxLength={2} min="0" max="59" pattern="[0-9]*" value={intervalEndTimeInput.minute} onChange={(event) => updateIntervalEndTime('minute', event.target.value)} onBlur={() => formatIntervalEndTimePart('minute')} aria-label="循环播报每天结束时间的分钟" placeholder="分" /></div></label><label><span>结束日期</span><div className="date-end-control"><input type="date" value={scheduleDraft.endDate ?? ''} min={scheduleDraft.startDate ?? today} onChange={(event) => setScheduleDraft({ ...scheduleDraft, endDate: event.target.value || null })} /><span className="inline-toggle"><input type="checkbox" checked={scheduleDraft.endDate === null} onChange={(event) => setScheduleDraft({ ...scheduleDraft, endDate: event.target.checked ? null : (scheduleDraft.startDate ?? today) })} />永久</span></div></label><label><span>间隔分钟数</span><input type="number" min="1" max="1440" step="1" value={scheduleDraft.intervalMinutes ?? ''} onChange={(event) => setScheduleDraft({ ...scheduleDraft, intervalMinutes: Number(event.target.value) || undefined })} placeholder="例如：30" /></label></div>}</div>
                      <label><FieldLabel text="gameid" help="填写需要定时汇报的项目编号，只能填写数字。" /><div className="gameid-input-row"><input value={scheduleDraft.gameId} onChange={(event) => { const gameId = event.target.value; setScheduleDraft({ ...scheduleDraft, gameId, gameVersionId: '' }); setScheduledVersion(null); setScheduledVersionCandidates([]); }} placeholder="例如：2170" /><button type="button" className="inline gameid-version-button" onClick={() => void resolveScheduledVersion()} disabled={busy}>读取有效版本</button></div></label>
                      <div className="field-button"><FieldLabel text="当前有效版本" help="显示已确认使用的版本。需要更换版本时，点击 gameid 右侧的“读取有效版本”。" /><div className="readonly-field">{scheduledVersion?.name ?? '尚未读取'}</div></div>
                      <label><FieldLabel text="收入类型" help="选择定时汇报使用“收入”还是“实收”口径。" /><select value={scheduleDraft.incomeType} onChange={(event) => setScheduleDraft({ ...scheduleDraft, incomeType: event.target.value as 'amount' | 'realamount' })}><option value="amount">收入</option><option value="realamount">实收</option></select></label>
                      <label className="toggle-label"><FieldLabel text="任务开启状态" help="关闭后不会按时自动发送，但计划仍会保留。" /><input className="checkbox" type="checkbox" checked={scheduleDraft.enabled} onChange={(event) => setScheduleDraft({ ...scheduleDraft, enabled: event.target.checked })} /></label>
                      <label className="toggle-label"><FieldLabel text="重归因" help="默认关闭；打开后读取重归因数据。" /><input className="checkbox" type="checkbox" checked={scheduleDraft.includeReattribution} onChange={(event) => setScheduleDraft({ ...scheduleDraft, includeReattribution: event.target.checked })} /></label>
                      <label><FieldLabel text="投手筛选" help="按广告概览里的投手筛选器筛选投手；多个用逗号或换行分隔，留空表示全部投手。" /><input value={(scheduleDraft.pitcherFilters ?? []).join(', ')} onChange={(event) => { const pitcherFilters = splitPitcherFilters(event.target.value); setScheduleDraft({ ...scheduleDraft, pitcherFilters, includePitcherDetails: pitcherFilters.length > 0 ? scheduleDraft.includePitcherDetails : false }); }} placeholder="填写投手代码；留空表示全部投手" /></label>
                      <label className="toggle-label"><FieldLabel text="生成分投手明细" help="填写投手筛选并打开后，消息会先显示全部投手合计，再逐位显示各投手明细；无数据或超时的投手会跳过并提示。" /><input className="checkbox" type="checkbox" checked={scheduleDraft.includePitcherDetails} disabled={(scheduleDraft.pitcherFilters ?? []).length === 0} onChange={(event) => setScheduleDraft({ ...scheduleDraft, includePitcherDetails: event.target.checked })} /></label>
                      <label><FieldLabel text="标题格式" help="可使用 {pidName} 代表 PID 名称，使用 {pid} 代表数字 PID。下方按钮可复制通配符。" /><input value={scheduleDraft.titleTemplate} onChange={(event) => setScheduleDraft({ ...scheduleDraft, titleTemplate: event.target.value })} placeholder="【{pidName}】" /><span className="title-placeholder-help">可用通配符：{TITLE_PLACEHOLDERS.map((placeholder) => <span className="title-placeholder" key={placeholder.value}><code>{placeholder.value}</code><span>{placeholder.label}</span><button type="button" className="ghost small" onClick={() => void copyTitlePlaceholder(placeholder.value)}>复制</button></span>)}</span></label>
                    </div>
                  </div>
                   <div className="schedule-editor-grid">
                     <label><FieldLabel text="PID" help="可填写多个数字 PID，使用逗号、空格或换行分隔；发送前程序会重新确认。" /><textarea value={scheduleDraft.pidInput} onChange={(event) => setScheduleDraft({ ...scheduleDraft, pidInput: event.target.value })} rows={4} placeholder="例如：2170405, 2170304" /></label>
                     <div className="schedule-target-picker"><h3><FieldLabel text="发送机器人配置" help="勾选要接收这条定时汇报的机器人，可以同时选择多个。" /></h3>{deliveryTargets.length > 0 ? deliveryTargets.map((target) => <label className="schedule-target-option" key={target.id}><input className="checkbox" type="checkbox" checked={scheduleDraft.targetIds.includes(target.id)} disabled={!target.enabled} onChange={(event) => toggleScheduleTarget(target.id, event.target.checked)} /><span><strong>{target.name}</strong><span>{target.platform === 'dingtalk' ? '钉钉群机器人' : '飞书群机器人'}{target.enabled ? '' : '（已停用）'}</span></span></label>) : <div className="empty-state">请先在页面顶部点击“机器人配置”添加至少一个机器人。</div>}</div>
                  </div>
                   <div className="schedule-metric-editor">
                     <div className="modal-panel-heading"><div><h3><FieldLabel text="播报指标" help="勾选要发送的指标，并用右侧上下按钮调整显示顺序。" /></h3></div></div>
                     <div className="schedule-metric-layout">
                       <div className="metric-list schedule-metric-list">{REALTIME_METRICS.map((metric) => <label className="metric-item" key={metric.key}><input type="checkbox" checked={scheduleDraft.metricOrder.includes(metric.key)} onChange={(event) => toggleScheduledMetric(metric.key, event.target.checked)} /><span>{metric.label}</span><small>{metric.group}</small></label>)}</div>
                       <div className="schedule-selected-order"><h3>当前顺序</h3>{scheduleDraft.metricOrder.length > 0 ? scheduleDraft.metricOrder.map((key, index) => <div className="order-row" key={key}><span>{index + 1}. {realtimeMetricByKey.get(key)?.label ?? key}</span><span><button onClick={() => moveScheduledMetric(index, -1)} aria-label={`上移${realtimeMetricByKey.get(key)?.label ?? key}`}>↑</button><button onClick={() => moveScheduledMetric(index, 1)} aria-label={`下移${realtimeMetricByKey.get(key)?.label ?? key}`}>↓</button></span></div>) : <div className="empty-state">尚未选择指标，发送时只显示标题。</div>}</div>
                     </div>
                   </div>
                   {schedulePreview && <div className="realtime-output schedule-preview"><div className="realtime-output-heading"><h3>当前数据预览</h3><span className="tag">未发送</span></div><textarea readOnly value={schedulePreview} rows={12} /></div>}
                </div>
                <div className="config-modal-footer"><button className="ghost" onClick={closeScheduledReportEditor} disabled={busy}>取消</button><button className="secondary" onClick={() => void previewScheduledReport()} disabled={busy}>预览并取数（不发送）</button><button className="primary small" onClick={() => void saveScheduledReport(true)} disabled={busy}>保存计划</button></div>
              </section>
            </div>}

         </>}

         {tab === 'project' && <>
           <section className="card config-card project-config-card">
             <div className="section-title"><div><h2>项目基础配置</h2></div><div className="section-actions"><button className="primary small" onClick={() => void saveProjectConfigSection('basic')} disabled={busy}>保存配置</button><CollapseToggle expanded={projectSectionsExpanded.basic} label="项目基础配置" onClick={() => toggleProjectSection('basic')} /></div></div>
             {projectSectionsExpanded.basic && <div className="form-grid two"><div className="field-button"><FieldLabel text="当前项目 gameid" help="这是当前配置所属的项目编号，由生成报表、即时播报或定时汇报中的项目自动确定，不需要在这里重复填写。" /><div className="readonly-field mono">{config.gameId || '尚未选择项目'}</div></div><label><FieldLabel text="默认收入类型" help="生成报表默认使用的收入口径；即时播报和定时汇报可单独设置。" /><select value={config.defaultIncomeType} onChange={(event) => setConfig({ ...config, defaultIncomeType: event.target.value as 'amount' | 'realamount' })}><option value="amount">收入</option><option value="realamount">实收</option></select></label><label><FieldLabel text="TapTap ADN/联盟识别关键词" help="仅用于 TapTap 数据。名称、RADID 或广告账号中命中这些关键词的数据，会归到 TapTap ADN/联盟；没有命中的归到 TapTap 主站。" /><textarea value={config.tapAdnKeywords.join('\n')} onChange={(event) => setConfig({ ...config, tapAdnKeywords: splitList(event.target.value) })} rows={4} placeholder="每行一个关键词" /></label><label><FieldLabel text="金额差异阈值" help="用于数据校验中判断金额差异是否需要提示。" /><input type="number" min={0} step={0.1} value={config.thresholds.amount} onChange={(event) => setConfig({ ...config, thresholds: { ...config.thresholds, amount: Number(event.target.value) } })} /></label><label><FieldLabel text="比例差异阈值（百分点）" help="用于数据校验中判断比例差异是否需要提示。" /><input type="number" min={0} step={0.1} value={config.thresholds.percentagePoint} onChange={(event) => setConfig({ ...config, thresholds: { ...config.thresholds, percentagePoint: Number(event.target.value) } })} /></label><label className="span-two"><FieldLabel text="文件名规则" help="用于生成 Excel 文件名，可使用界面提示的通配符。" /><input value={config.fileNameRule} onChange={(event) => setConfig({ ...config, fileNameRule: event.target.value })} /></label></div>}
           </section>

           <section className="card project-config-card"><div className="section-title"><div><h2>无人值守登录</h2></div><div className="section-actions"><button className="primary small" onClick={() => void saveLoginCredentials()} disabled={busy}>保存配置</button><CollapseToggle expanded={projectSectionsExpanded.unattendedLogin} label="无人值守登录" onClick={() => toggleProjectSection('unattendedLogin')} /></div></div>{projectSectionsExpanded.unattendedLogin && <div className="form-grid two"><label><FieldLabel text="后台账号" help="任务需要登录时，程序会使用此账号尝试自动登录；账号使用系统安全加密保存。" /><input value={loginCredentialUsername} onChange={(event) => setLoginCredentialUsername(event.target.value)} autoComplete="off" /></label><label><FieldLabel text="后台密码" help="密码只保存加密副本，不会在界面中回显。修改账号或密码后，需要重新填写密码并保存。" /><input type="password" value={loginCredentialPassword} onChange={(event) => setLoginCredentialPassword(event.target.value)} autoComplete="new-password" placeholder={loginCredentialStatus.configured ? '如需修改，请重新填写密码' : '填写后台密码'} /></label><div className="section-actions">{loginCredentialStatus.configured && <span className="tag ok">已配置：{loginCredentialStatus.username}</span>}{loginCredentialStatus.configured && <button className="ghost danger-text" onClick={() => requestConfirmation('清除无人值守登录账号', '确定清除已保存的后台账号和密码吗？之后定时任务将不能再用账号密码自动登录。', '确认清除', () => clearLoginCredentials())} disabled={busy}>清除账号</button>}</div></div>}</section>

           <section className="card project-config-card"><div className="section-title"><div><h2>钉钉扫码登录</h2></div><div className="section-actions"><button className="ghost small" onClick={() => void testDingTalkLoginText()} disabled={busy || bindingDingTalkLoginQr || testingDingTalkLoginText || testingDingTalkLoginQr || !dingTalkLoginQrStatus.groupBound}>{testingDingTalkLoginText ? '正在发送…' : '发送文字测试'}</button><button className="secondary small" onClick={() => void testDingTalkLoginQr()} disabled={busy || bindingDingTalkLoginQr || testingDingTalkLoginText || testingDingTalkLoginQr || !dingTalkLoginQrStatus.groupBound}>{testingDingTalkLoginQr ? '正在模拟…' : '模拟发送（测试）'}</button><button className="secondary small" onClick={() => void bindDingTalkLoginQrGroup()} disabled={busy || bindingDingTalkLoginQr || testingDingTalkLoginText || testingDingTalkLoginQr || !dingTalkLoginQrStatus.configured}>{bindingDingTalkLoginQr ? '等待群内绑定…' : dingTalkLoginQrStatus.groupBound ? '重新绑定接收群' : '绑定接收群'}</button><button className="primary small" onClick={() => void saveDingTalkLoginQr()} disabled={busy || bindingDingTalkLoginQr || testingDingTalkLoginText || testingDingTalkLoginQr}>保存配置</button><CollapseToggle expanded={projectSectionsExpanded.dingtalkLoginQr} label="钉钉扫码登录" onClick={() => toggleProjectSection('dingtalkLoginQr')} /></div></div>{projectSectionsExpanded.dingtalkLoginQr && <div className="form-grid two"><label><FieldLabel text="应用 AppKey" help="在钉钉开发者后台的企业内部应用凭据中复制，也可能显示为 Client ID。" /><input type="password" value={dingTalkLoginQrAppKey} onChange={(event) => setDingTalkLoginQrAppKey(event.target.value)} autoComplete="off" placeholder={dingTalkLoginQrStatus.configured ? '如需修改，请重新填写 AppKey' : '填写企业内部应用 AppKey'} /></label><label><FieldLabel text="应用 AppSecret" help="与 AppKey 配套的企业内部应用密钥，也可能显示为 Client Secret。" /><input type="password" value={dingTalkLoginQrAppSecret} onChange={(event) => setDingTalkLoginQrAppSecret(event.target.value)} autoComplete="new-password" placeholder={dingTalkLoginQrStatus.configured ? '如需修改，请重新填写 AppSecret' : '填写企业内部应用 AppSecret'} /></label><label><FieldLabel text="机器人编码" help="为该企业内部应用启用机器人后得到的 robotCode。" /><input type="password" value={dingTalkLoginQrRobotCode} onChange={(event) => setDingTalkLoginQrRobotCode(event.target.value)} autoComplete="off" placeholder={dingTalkLoginQrStatus.configured ? '如需修改，请重新填写机器人编码' : '填写 robotCode'} /></label><div className="section-actions">{dingTalkLoginQrStatus.configured && <span className="tag ok">已保存企业机器人配置</span>}{dingTalkLoginQrStatus.groupBound && <span className="tag ok">已绑定接收群</span>}{dingTalkLoginQrStatus.configured && !dingTalkLoginQrStatus.groupBound && <span className="tag unknown">请点击“绑定接收群”后，在目标群 @机器人发送“绑定二维码”</span>}{dingTalkLoginQrStatus.configured && <button className="ghost danger-text" onClick={() => requestConfirmation('清除钉钉扫码登录配置', '确定清除钉钉企业机器人和已绑定接收群吗？之后账号登录需要验证码时，程序将无法自动发送登录二维码。', '确认清除', () => clearDingTalkLoginQr())} disabled={busy || bindingDingTalkLoginQr || testingDingTalkLoginText || testingDingTalkLoginQr}>清除配置</button>}</div></div>}</section>

           <section className="card project-config-card"><div className="section-title"><div><h2>PID → 渠道 / 操作系统自动识别</h2></div><div className="section-actions"><button className="primary small" onClick={() => void saveProjectConfigSection('pidCache')} disabled={busy}>保存配置</button><CollapseToggle expanded={projectSectionsExpanded.pidCache} label="PID 自动识别" onClick={() => toggleProjectSection('pidCache')} /></div></div>{projectSectionsExpanded.pidCache && (pidConfigIds.length > 0 ? <div className="mapping-table"><div className="mapping-row mapping-head mapping-row-five"><span>PID</span><span>后台中文名称</span><span>渠道</span><span>操作系统</span><span></span></div>{pidConfigIds.map((pid) => { const pidName = config.pidNames[pid] ?? ''; const classification = inferPidClassification(pidName); const channel = classification?.channel ?? config.pidPackageMap[pid] ?? ''; const operatingSystem = isMixedPidName(pidName, channel) ? '混投（按后台明细拆分）' : config.pidOperatingSystemMap[pid] ?? classification?.operatingSystem ?? (channel === 'APK' ? '安卓' : channel === 'IOS' ? 'IOS' : channel === '鸿蒙' ? '鸿蒙' : ''); return <div className="mapping-row mapping-row-five" key={pid}><span className="mono">{pid}</span><span>{pidName || '未读取名称'}</span><span className={channel ? 'tag ok' : 'tag unknown'}>{channel || '未识别'}</span><span className={operatingSystem ? 'tag ok' : 'tag unknown'}>{operatingSystem || '未识别'}</span><button className="ghost" onClick={() => requestConfirmation('删除 PID 缓存', `确定删除 PID ${pid} 的名称、渠道和操作系统缓存吗？`, '确认删除', () => deletePidCache(pid))}>删除缓存</button></div>; })}</div> : <div className="empty-state">请先在“生成报表”页读取并验证 PID，程序会自动缓存 PID 名称、渠道和操作系统识别结果。</div>)}</section>

           <section className="card project-config-card"><div className="section-title"><div><h2>媒体识别规则</h2></div><div className="section-actions"><button className="primary small" onClick={() => void saveProjectConfigSection('mediaRules')} disabled={busy}>保存配置</button><CollapseToggle expanded={projectSectionsExpanded.mediaRules} label="媒体识别规则" onClick={() => toggleProjectSection('mediaRules')} /></div></div>{projectSectionsExpanded.mediaRules && <div className="rule-table"><div className="rule-row rule-head"><span>媒体</span><span>后台字段别名（逗号分隔）</span><span>RADID前缀（逗号分隔）</span></div>{config.mediaRules.map((rule, index) => <div className="rule-row" key={rule.name}><strong>{rule.name}</strong><input value={rule.aliases.join(', ')} onChange={(event) => updateMediaRule(index, (old) => ({ ...old, aliases: splitList(event.target.value) }))} /><input value={rule.radidPrefixes.join(', ')} onChange={(event) => updateMediaRule(index, (old) => ({ ...old, radidPrefixes: splitList(event.target.value) }))} /></div>)}</div>}</section>

             <section className="card project-config-card"><div className="section-title"><div><h2>出价代码映射</h2></div><div className="section-actions"><button className="primary small" onClick={() => void saveProjectConfigSection('bidCodes')} disabled={busy}>保存配置</button><CollapseToggle expanded={projectSectionsExpanded.bidCodes} label="出价代码映射" onClick={() => toggleProjectSection('bidCodes')} /></div></div>{projectSectionsExpanded.bidCodes && <div className="mapping-table"><div className="mapping-row mapping-add"><input value={newBidCode} onChange={(event) => setNewBidCode(event.target.value)} placeholder="原始代码，例如 newroi" /><input value={newBidName} onChange={(event) => setNewBidName(event.target.value)} placeholder="显示名称（不填则显示原始代码）" /><button className="secondary" onClick={addBidCode}>添加</button></div><div className="mapping-row mapping-head"><span>原始代码</span><span>显示名称</span><span></span></div>{Object.entries(config.bidCodeMap).map(([code, name]) => <div className="mapping-row" key={code}><input value={code} readOnly /><input value={name} onChange={(event) => setConfig((old) => ({ ...old, bidCodeMap: { ...old.bidCodeMap, [code]: event.target.value } }))} /><button className="ghost" onClick={() => requestConfirmation('删除出价代码映射', `确定删除出价代码“${code}”吗？`, '确认删除', () => deleteBidCode(code))}>删除</button></div>)}</div>}</section>
             <section className="card project-config-card"><div className="section-title"><div><h2>投手名映射</h2></div><div className="section-actions"><button className="primary small" onClick={() => void saveProjectConfigSection('pitcherNames')} disabled={busy}>保存配置</button><CollapseToggle expanded={projectSectionsExpanded.pitcherNames} label="投手名映射" onClick={() => toggleProjectSection('pitcherNames')} /></div></div>{projectSectionsExpanded.pitcherNames && <div className="mapping-table"><div className="mapping-row mapping-add"><input value={newPitcherCode} onChange={(event) => setNewPitcherCode(event.target.value)} placeholder="投手代码，例如 kz" /><input value={newPitcherName} onChange={(event) => setNewPitcherName(event.target.value)} placeholder="实际投手名称（不填则显示代码）" /><button className="secondary" onClick={addPitcherName}>添加</button></div><div className="mapping-row mapping-head"><span>投手代码</span><span>显示名称</span><span></span></div>{Object.entries(config.pitcherNameMap).map(([code, name]) => <div className="mapping-row" key={code}><input value={code} readOnly /><input value={name} onChange={(event) => setConfig((old) => ({ ...old, pitcherNameMap: { ...old.pitcherNameMap, [code]: event.target.value } }))} /><button className="ghost" onClick={() => requestConfirmation('删除投手名映射', `确定删除投手代码“${code}”的名称映射吗？`, '确认删除', () => deletePitcherName(code))}>删除</button></div>)}</div>}</section>
        </>}

       </main>

       {configModal === 'report' && <div className={`config-modal-backdrop${browserOpen ? ' browser-open' : ''}`}>
         <section className="config-modal" role="dialog" aria-modal="true" aria-labelledby="report-config-title">
           <div className="config-modal-header"><div><h2 id="report-config-title">Excel 报表配置</h2></div><button className="ghost modal-close" onClick={() => setConfigModal(null)} aria-label="关闭报表配置">×</button></div>
           <div className="config-modal-body metrics-layout">
             <div className="sheet-list"><h3>Sheet顺序</h3>{config.sheetConfigs.map((sheet, index) => <div className={`sheet-item ${sheet.id === activeSheet ? 'selected' : ''}`} key={sheet.id} onClick={() => setActiveSheet(sheet.id)}><span>{index + 1}. {sheet.name}</span><span className="move-buttons"><button onClick={(event) => { event.stopPropagation(); setConfig({ ...config, sheetConfigs: moveItem(config.sheetConfigs, index, -1) }); }}>↑</button><button onClick={(event) => { event.stopPropagation(); setConfig({ ...config, sheetConfigs: moveItem(config.sheetConfigs, index, 1) }); }}>↓</button></span></div>)}</div>
             <div className="metric-panel"><div className="modal-panel-heading"><h3>{selectedSheet?.name}</h3><button className="secondary" onClick={syncMetrics}>同步到全部 Sheet</button></div>{selectedSheet?.kind !== 'overall' && selectedSheet && <label className="daily-toggle"><input type="checkbox" checked={selectedSheet.showDaily} onChange={(event) => updateSheet(selectedSheet.id, (sheet) => ({ ...sheet, showDaily: event.target.checked }))} />显示日期明细</label>}<div className="metric-list">{METRICS.map((metric) => { const checked = selectedSheet?.metricOrder.includes(metric.key) ?? false; return <label className="metric-item" key={metric.key}><input type="checkbox" checked={checked} onChange={(event) => { if (!selectedSheet) return; const next = event.target.checked ? [...selectedSheet.metricOrder, metric.key] : selectedSheet.metricOrder.filter((key) => key !== metric.key); updateSheet(selectedSheet.id, (sheet) => ({ ...sheet, metricOrder: next })); }} /><span>{metric.label}</span><small>{metric.group}</small></label>; })}</div><div className="selected-order"><h3>当前顺序</h3>{selectedSheet?.metricOrder.length ? selectedSheet.metricOrder.map((key, index) => <div className="order-row" key={key}><span>{index + 1}. {metricByKey.get(key as MetricKey)?.label ?? key}</span><span><button onClick={() => selectedSheet && updateSheet(selectedSheet.id, (sheet) => ({ ...sheet, metricOrder: moveItem(sheet.metricOrder, index, -1) }))}>↑</button><button onClick={() => selectedSheet && updateSheet(selectedSheet.id, (sheet) => ({ ...sheet, metricOrder: moveItem(sheet.metricOrder, index, 1) }))}>↓</button></span></div>) : <div className="empty-state">当前 Sheet 未选择指标，生成时只保留固定分组列。</div>}</div></div>
           </div>
           <div className="config-modal-footer"><button className="ghost" onClick={() => setConfigModal(null)}>取消</button><button className="primary small" onClick={() => void saveModalConfig('Excel 报表配置已保存。')}>保存配置</button></div>
         </section>
       </div>}

         {configModal === 'realtime' && <div className={`config-modal-backdrop${browserOpen ? ' browser-open' : ''}`}>
         <section className="config-modal realtime-config-modal" role="dialog" aria-modal="true" aria-labelledby="realtime-config-title">
           <div className="config-modal-header"><div><h2 id="realtime-config-title">即时播报配置</h2></div><button className="ghost modal-close" onClick={() => setConfigModal(null)} aria-label="关闭即时播报配置">×</button></div>
           <div className="config-modal-body realtime-layout">
             <div className="metric-panel realtime-metric-panel"><h3><FieldLabel text="可用指标" help="勾选要播报的指标，并在右侧调整发送顺序。" /></h3><div className="metric-list realtime-metric-list">{REALTIME_METRICS.map((metric) => { const checked = realtime.metricOrder.includes(metric.key); return <label className="metric-item" key={metric.key}><input type="checkbox" checked={checked} onChange={(event) => updateRealtimeConfig((current) => ({ ...current, metricOrder: event.target.checked ? [...current.metricOrder, metric.key] : current.metricOrder.filter((key) => key !== metric.key) }))} /><span>{metric.label}</span><small>{metric.group}</small></label>; })}</div></div>
             <div className="metric-panel"><label><FieldLabel text="标题格式" help="可使用 {pidName} 代表 PID 名称，使用 {pid} 代表数字 PID。下方按钮可复制通配符。" /><input value={realtime.titleTemplate} onChange={(event) => updateRealtimeConfig((current) => ({ ...current, titleTemplate: event.target.value }))} placeholder="【{pidName}】" /><span className="title-placeholder-help">可用通配符：{TITLE_PLACEHOLDERS.map((placeholder) => <span className="title-placeholder" key={placeholder.value}><code>{placeholder.value}</code><span>{placeholder.label}</span><button type="button" className="ghost small" onClick={() => void copyTitlePlaceholder(placeholder.value)}>复制</button></span>)}</span></label><div className="selected-order"><h3>当前顺序</h3>{realtime.metricOrder.length > 0 ? realtime.metricOrder.map((key, index) => <div className="order-row" key={key}><span>{index + 1}. {realtimeMetricByKey.get(key as RealtimeMetricKey)?.label ?? key}</span><span><button onClick={() => updateRealtimeConfig((current) => ({ ...current, metricOrder: moveItem(current.metricOrder, index, -1) }))}>↑</button><button onClick={() => updateRealtimeConfig((current) => ({ ...current, metricOrder: moveItem(current.metricOrder, index, 1) }))}>↓</button></span></div>) : <div className="empty-state">尚未选择指标，生成后只显示标题。</div>}</div></div>
           </div>
           <div className="config-modal-footer"><button className="ghost" onClick={() => setConfigModal(null)}>取消</button><button className="primary small" onClick={() => void saveModalConfig('即时播报配置已保存。')}>保存配置</button></div>
         </section>
        </div>}

        {configModal === 'onboarding' && <div className={`config-modal-backdrop${browserOpen ? ' browser-open' : ''}`}>
          <section className="config-modal onboarding-guide-modal" role="dialog" aria-modal="true" aria-labelledby="onboarding-guide-title">
            <div className="config-modal-header"><div><h2 id="onboarding-guide-title">首次使用配置</h2></div><button className="ghost modal-close" onClick={closeOnboardingGuide} aria-label="关闭首次使用配置教程">×</button></div>
            <div className="config-modal-body onboarding-guide-body">
              <section className="onboarding-section"><h3>先完成这两步，就能生成报表</h3><ol><li><strong>登录后台：</strong>点击右上角“登录后台”，在内置浏览器中完成登录。</li><li><strong>填写查询条件：</strong>进入“生成报表”，填写 gameid，点击“读取有效版本”选择版本，再填写 PID。</li></ol></section>
              <section className="onboarding-section"><h3>定时汇报（需要时再配）</h3><p>先在“定时汇报”里创建计划，再点击“机器人配置”添加要接收消息的群机器人。</p></section>
              <details className="onboarding-details"><summary>钉钉群机器人配置攻略</summary><ol><li>打开要接收汇报的钉钉群。</li><li>点击群设置，找到“智能群助手”或“群机器人”，选择添加<strong>自定义机器人</strong>。</li><li>设置机器人名称；安全设置请选择<strong>加签</strong>，复制系统给出的“Webhook 地址”和“加签密钥”。</li><li>回到工具的“定时汇报 → 机器人配置”，平台选择“钉钉群机器人”。</li><li>填写任务名称，粘贴 Webhook 和签名密钥，保持“任务开启状态”打开，点击“加密保存机器人”。</li><li>点击“发送测试”，群里收到测试消息就说明配置完成。</li></ol><p className="guide-note">注意：这里配置的是用于发送定时汇报的“群自定义机器人”，不是“设置 → 钉钉扫码登录”里的企业机器人。</p></details>
              <details className="onboarding-details"><summary>飞书群机器人配置攻略</summary><ol><li>打开要接收汇报的飞书群。</li><li>点击右上角群设置，进入“群机器人”，选择添加<strong>自定义机器人</strong>。</li><li>完成机器人名称和安全设置；建议开启<strong>签名校验</strong>，复制 Webhook 地址和签名密钥。</li><li>回到工具的“定时汇报 → 机器人配置”，平台选择“飞书群机器人”。</li><li>填写任务名称，粘贴 Webhook 和签名密钥，点击“加密保存机器人”。</li><li>点击“发送测试”，群里收到测试消息就说明配置完成。</li></ol><p className="guide-note">如果飞书创建机器人时没有显示签名密钥，请开启签名校验后再复制；本工具的机器人发送需要同时填写 Webhook 和签名密钥。</p></details>
              <details className="onboarding-details"><summary>无人值守登录（可选）</summary><p>进入“设置”，在“无人值守登录”保存后台账号密码；也可配置“钉钉扫码登录”。定时任务发现后台掉线时，会优先使用账号密码登录，遇到短信验证码则发送钉钉二维码，扫码成功后自动补跑当天未完成任务。</p></details>
            </div>
          </section>
        </div>}

        {configModal === 'delivery' && <div className={`config-modal-backdrop${browserOpen ? ' browser-open' : ''}`}>
          <section className="config-modal delivery-config-modal" role="dialog" aria-modal="true" aria-labelledby="delivery-config-title">
            <div className="config-modal-header"><div><h2 id="delivery-config-title">机器人配置</h2></div><button className="ghost modal-close" onClick={() => setConfigModal(null)} aria-label="关闭机器人配置">×</button></div>
            <div className="config-modal-body delivery-target-grid">
              <div className="delivery-target-form"><h3>{deliveryTargetDraft.id ? '编辑机器人配置' : '新增机器人配置'}</h3><label><FieldLabel text="任务名称" help="给机器人配置起一个容易认出的名字，方便定时计划选择。" /><input value={deliveryTargetDraft.name} onChange={(event) => setDeliveryTargetDraft({ ...deliveryTargetDraft, name: event.target.value })} placeholder="例如：运营日报群" /><small>仅用于在计划中识别这项机器人配置。</small></label><label><FieldLabel text="平台" help="选择这个 Webhook 所属的平台，目前支持钉钉群机器人和飞书群机器人。" /><select value={deliveryTargetDraft.platform} onChange={(event) => setDeliveryTargetDraft({ ...deliveryTargetDraft, platform: event.target.value as 'dingtalk' | 'feishu' })}><option value="dingtalk">钉钉群机器人</option><option value="feishu">飞书群机器人</option></select></label><label><FieldLabel text="Webhook" help="粘贴机器人提供的 Webhook 地址；程序会加密保存，不会在界面中回显。" /><input type="password" value={deliveryTargetDraft.webhookUrl} onChange={(event) => setDeliveryTargetDraft({ ...deliveryTargetDraft, webhookUrl: event.target.value })} placeholder={deliveryTargetDraft.id ? '留空则沿用已保存的 Webhook' : '粘贴机器人 Webhook'} autoComplete="off" /></label><label><FieldLabel text="签名密钥" help="如果平台开启了加签，把对应密钥粘贴到这里；没有加签要求时可以留空。" /><input type="password" value={deliveryTargetDraft.signingSecret} onChange={(event) => setDeliveryTargetDraft({ ...deliveryTargetDraft, signingSecret: event.target.value })} placeholder={deliveryTargetDraft.id ? '留空则沿用已保存的签名密钥' : '粘贴机器人签名密钥'} autoComplete="off" /></label><label className="toggle-label"><FieldLabel text="任务开启状态" help="关闭后，这个机器人不会被定时计划自动使用，但配置仍会保留。" /><input className="checkbox" type="checkbox" checked={deliveryTargetDraft.enabled} onChange={(event) => setDeliveryTargetDraft({ ...deliveryTargetDraft, enabled: event.target.checked })} /></label><button className="primary small" onClick={() => void saveDeliveryTarget()} disabled={busy}>{deliveryTargetDraft.id ? '保存修改' : '加密保存机器人'}</button><small>{deliveryTargetDraft.id ? 'Webhook 与签名密钥均留空时，会保留原来的加密凭据；如需替换，请同时填写两项。' : '保存后请主动点击一次“发送测试”；测试会真实发送一条标记为“测试”的群消息。'}</small></div>
              <div className="delivery-target-list"><div className="modal-panel-heading"><h3>已配置机器人</h3><button className="ghost" onClick={() => setDeliveryTargetDraft(emptyDeliveryTargetDraft())} disabled={busy}>新增</button></div>{deliveryTargets.length > 0 ? deliveryTargets.map((target) => <div className="delivery-target-item" key={target.id}><div><strong>{target.name}</strong><small>{target.platform === 'dingtalk' ? '钉钉群机器人' : '飞书群机器人'} · {target.enabled ? '任务已开启' : '任务已关闭'}</small></div><div className="schedule-item-actions"><button className="ghost" onClick={() => editDeliveryTarget(target)} disabled={busy}>编辑</button><button className="secondary" onClick={() => void testDeliveryTarget(target)} disabled={busy || !target.enabled}>发送测试</button><button className="ghost danger-text" onClick={() => requestConfirmation('删除机器人配置', `确定删除机器人配置“${target.name}”吗？相关定时计划会失去这个发送目标。`, '确认删除', () => deleteDeliveryTarget(target))} disabled={busy}>删除</button></div></div>) : <div className="empty-state">暂未保存机器人配置。</div>}</div>
            </div>
            <div className="config-modal-footer"><button className="ghost" onClick={() => setConfigModal(null)}>关闭</button></div>
          </section>
        </div>}

        {filterTemplateModalOpen && <div className={`config-modal-backdrop${browserOpen ? ' browser-open' : ''}`}>
          <section className="config-modal filter-template-modal" role="dialog" aria-modal="true" aria-labelledby="filter-template-title">
            <div className="config-modal-header"><div><h2 id="filter-template-title">筛选模板</h2></div><button className="ghost modal-close" onClick={() => setFilterTemplateModalOpen(false)} aria-label="关闭筛选模板">×</button></div>
            <div className="config-modal-body">
              {filterTemplates.length > 0 ? <div className="filter-template-list">{filterTemplates.map((template) => <div className={`filter-template-item${selectedFilterTemplateId === template.id ? ' selected' : ''}`} key={template.id}><div className="filter-template-summary"><strong>{template.name}</strong><div>{template.gameId} · 版本 {template.gameVersionId} · {template.incomeType === 'amount' ? '收入' : '实收'}</div><div className="mono">PID：{template.pidInput}</div><div>投手：{template.pitcherFilters?.length ? template.pitcherFilters.join('、') : '全部'}</div></div><div className="schedule-item-actions"><button className="ghost" onClick={() => void useFilterTemplate(template)} disabled={busy}>使用</button><button className="secondary" onClick={() => void editFilterTemplate(template)} disabled={busy}>编辑</button><button className="ghost danger-text" onClick={() => { setFilterTemplateModalOpen(false); setFilterTemplatePendingDelete(template); }} disabled={busy}>删除</button></div></div>)}</div> : <div className="empty-state">还没有筛选模板。</div>}
            </div>
            <div className="config-modal-footer"><button className="ghost" onClick={() => setFilterTemplateModalOpen(false)}>关闭</button></div>
          </section>
        </div>}

        {filterTemplateSaveOpen && <div className={`config-modal-backdrop${browserOpen ? ' browser-open' : ''}`}>
          <section className="config-modal filter-template-save-modal" role="dialog" aria-modal="true" aria-labelledby="filter-template-save-title">
            <div className="config-modal-header"><div><h2 id="filter-template-save-title">{filterTemplateEditingId ? '保存模板修改' : '保存新模板'}</h2></div><button className="ghost modal-close" onClick={() => setFilterTemplateSaveOpen(false)} aria-label="关闭保存筛选模板">×</button></div>
            <div className="config-modal-body">
              <h3>当前配置</h3>
              <div className="filter-template-confirm-grid"><div><span>gameid</span><strong>{gameId || '未填写'}</strong></div><div><span>版本</span><strong>{version?.name ?? '未读取'}</strong></div><div><span>收入类型</span><strong>{incomeType === 'amount' ? '收入' : '实收'}</strong></div><div><span>重归因</span><strong>{includeReattribution ? '开启' : '关闭'}</strong></div><div><span>分投手明细</span><strong>{includePitcherDetails ? '开启' : '关闭'}</strong></div><div><span>投手筛选</span><strong>{pitcherFilterInput || '全部'}</strong></div><div className="span-two"><span>PID</span><strong className="mono">{pidInput || '未填写'}</strong></div></div>
              <label><span>模板名称</span><input value={filterTemplateName} onChange={(event) => { setFilterTemplateName(event.target.value); setFilterTemplateSaveError(''); }} placeholder="例如：国服安卓收入" autoFocus /></label>
              {filterTemplateSaveError && <div className="error-box" role="alert">{filterTemplateSaveError}</div>}
            </div>
            <div className="config-modal-footer"><button className="ghost" onClick={() => setFilterTemplateSaveOpen(false)}>取消</button><button className="primary small" onClick={() => void saveFilterTemplate()}>确认保存</button></div>
          </section>
        </div>}

        {filterTemplatePendingDelete && <div className={`config-modal-backdrop${browserOpen ? ' browser-open' : ''}`}>
          <section className="config-modal filter-template-delete-modal" role="dialog" aria-modal="true" aria-labelledby="filter-template-delete-title">
            <div className="config-modal-header"><div><h2 id="filter-template-delete-title">删除筛选模板</h2></div><button className="ghost modal-close" onClick={() => setFilterTemplatePendingDelete(null)} aria-label="关闭删除筛选模板确认">×</button></div>
            <div className="config-modal-body"><p className="filter-template-delete-message">确定删除筛选模板“<strong>{filterTemplatePendingDelete.name}</strong>”吗？</p></div>
            <div className="config-modal-footer"><button className="ghost" onClick={() => setFilterTemplatePendingDelete(null)}>取消</button><button className="primary small danger" onClick={() => void confirmDeleteFilterTemplate()}>确认删除</button></div>
          </section>
        </div>}

        {pendingConfirmation && <div className={`config-modal-backdrop${browserOpen ? ' browser-open' : ''}`}>
          <section className="config-modal filter-template-delete-modal" role="dialog" aria-modal="true" aria-labelledby="pending-confirmation-title">
            <div className="config-modal-header"><div><h2 id="pending-confirmation-title">{pendingConfirmation.title}</h2></div><button className="ghost modal-close" onClick={() => setPendingConfirmation(null)} disabled={confirming} aria-label="关闭操作确认">×</button></div>
            <div className="config-modal-body"><p className="filter-template-delete-message">{pendingConfirmation.message}</p></div>
            <div className="config-modal-footer"><button className="ghost" onClick={() => setPendingConfirmation(null)} disabled={confirming}>取消</button><button className="primary small danger" onClick={() => void confirmPendingAction()} disabled={confirming}>{confirming ? '正在处理…' : pendingConfirmation.confirmLabel}</button></div>
          </section>
        </div>}

        {scheduleSuccessMessage && <div className={`config-modal-backdrop${browserOpen ? ' browser-open' : ''}`}>
          <section className="config-modal schedule-success-modal" role="dialog" aria-modal="true" aria-labelledby="schedule-success-title">
            <div className="config-modal-header"><div><h2 id="schedule-success-title">操作成功</h2></div><button className="ghost modal-close" onClick={() => setScheduleSuccessMessage(null)} aria-label="关闭操作成功提示">×</button></div>
            <div className="config-modal-body"><p className="schedule-success-message">{scheduleSuccessMessage}</p></div>
            <div className="config-modal-footer"><button className="primary small" onClick={() => setScheduleSuccessMessage(null)}>知道了</button></div>
          </section>
        </div>}

        {scheduledHistoryOpen && <div className={`config-modal-backdrop${browserOpen ? ' browser-open' : ''}`}>
          <section className="config-modal scheduled-history-modal" role="dialog" aria-modal="true" aria-labelledby="scheduled-history-title">
            <div className="config-modal-header"><div><h2 id="scheduled-history-title">最近执行记录</h2></div><button className="ghost modal-close" onClick={() => setScheduledHistoryOpen(false)} aria-label="关闭最近执行记录">×</button></div>
            <div className="config-modal-body">{scheduledExecutions.length > 0 ? <div className="scheduled-history">{scheduledExecutions.map((record) => <div className="scheduled-history-row" key={record.slotKey}><span>{record.occurredAt.replace('T', ' ').slice(0, 16)}</span><strong>{record.scheduleName}</strong><span>{record.date} {record.time}</span><span className={`tag ${record.result === 'success' ? 'ok' : record.result === 'running' ? '' : 'unknown'}`}>{scheduledResultLabel(record.result)}</span><small>{record.code}</small></div>)}</div> : <div className="empty-state">暂无执行记录。</div>}</div>
            <div className="config-modal-footer"><button className="ghost" onClick={() => void window.desktopApi.loadScheduledExecutions().then(setScheduledExecutions)}>刷新</button><button className="primary small" onClick={() => setScheduledHistoryOpen(false)}>关闭</button></div>
          </section>
        </div>}

        {browserOpen && <aside className="browser-chrome">
        <div className="browser-tabs">
          {browserState.tabs.map((browserTab) => <div className={`browser-tab${browserTab.active ? ' active' : ''}`} key={browserTab.id} title={browserTab.url}>
            <button className="browser-tab-select" onClick={() => void selectBrowserTab(browserTab.id)}><span className="browser-tab-title">{browserTab.title || '新标签页'}</span></button>
            <button className="browser-tab-close" aria-label={`关闭${browserTab.title || '标签页'}`} onClick={() => void closeBrowserTab(browserTab.id)}>×</button>
          </div>)}
          <button className="browser-new-tab" onClick={() => void newBrowserTab()} aria-label="新建标签页">＋</button>
        </div>
        <form className="browser-address-row" onSubmit={(event) => { event.preventDefault(); void navigateBrowser(); }}>
           <input className="browser-address" value={addressValue} onChange={(event) => setAddressValue(event.target.value)} aria-label="浏览器地址" placeholder="输入网址" />
           <button className="browser-go" type="submit">前往</button>
         </form>
      </aside>}
      </div>

      <section className={`card action-card generation-dock${browserOpen ? ' browser-open' : ''}`}><div className="generation-dock-inner"><div className="generation-progress"><div className="progress-message">{progress.phase === 'idle' ? status : progress.message}</div><div className="progress-track" role="progressbar" aria-label="生成进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.value * 100)}><div className="progress-fill" style={{ width: `${Math.round(progress.value * 100)}%` }} /></div><div className="progress-meta"><small>{status}</small><small>{Math.round(progress.value * 100)}%</small></div>{error && <div className="error-box">{error}</div>}</div><div className="generation-actions">{taskActive && <button className="danger-action" onClick={requestCancelCurrentTask}>终止当前任务</button>}{tab === 'generate' && <><button className="secondary" onClick={openFilterTemplateSave}>{filterTemplateEditingId ? '保存模板修改' : '保存为模板'}</button><button className="primary" onClick={() => void generate()} disabled={!loggedIn || !version || !pidValidation || pidValidation.issues.some((issue) => issue.level === 'error')}>{canQueueAnotherTask ? '加入任务队列' : '生成 Excel'}</button></>}{tab === 'realtime' && <button className="primary" onClick={() => void generateRealtime()} disabled={!loggedIn || !realtimeVersion || parsePidInput(realtime.pidInput).length === 0}>{canQueueAnotherTask ? '加入任务队列' : '生成即时播报'}</button>}</div></div></section>

      {taskQueueModalOpen && <div className={`config-modal-backdrop${browserOpen ? ' browser-open' : ''}`}>
        {renderTaskQueue()}
      </div>}

      {versionPickerContext && <div className={`config-modal-backdrop${browserOpen ? ' browser-open' : ''}`}>
        <section className="config-modal version-picker-modal" role="dialog" aria-modal="true" aria-labelledby="version-picker-title">
          <div className="config-modal-header"><div><h2 id="version-picker-title">选择有效版本</h2></div><button className="ghost modal-close" onClick={closeVersionPicker} aria-label="关闭版本选择">×</button></div>
          <div className="config-modal-body">
            <div className="version-picker-list">{versionPickerCandidates.map((candidate) => <label className={`version-picker-option${versionPickerSelection === candidate.key ? ' selected' : ''}`} key={candidate.key}><input type="radio" name="version-picker" value={candidate.key} checked={versionPickerSelection === candidate.key} onChange={() => setVersionPickerSelection(candidate.key)} /><span><strong>{candidate.name}</strong><small>版本标识：{candidate.key}</small></span></label>)}</div>
          </div>
          <div className="config-modal-footer"><button className="ghost" onClick={closeVersionPicker}>取消</button><button className="primary small" onClick={() => void confirmVersionSelection()} disabled={!versionPickerSelection}>确认选择</button></div>
        </section>
      </div>}
    </>
  );
}
