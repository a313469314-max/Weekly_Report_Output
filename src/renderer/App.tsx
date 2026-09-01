import { useEffect, useMemo, useRef, useState } from 'react';
import type { FilterTemplate, MediaRule, MetricKey, PidDirectoryEntry, ProjectConfig, RealtimeConfig, RealtimeMetricKey, RealtimeQuery, ReportQuery, SheetConfig, VersionCandidate } from '../shared/contracts';
import { createDefaultProjectConfig } from '../shared/defaults';
import { METRICS, metricByKey } from '../shared/metrics';
import { REALTIME_METRICS, realtimeMetricByKey } from '../shared/realtime-metrics';
import { inferPackageName, inferPidClassification, isMixedPidName, parsePidInput, removePidFromInput, validatePids, type PidValidationResult } from '../domain/pid';
import { createQueryValidationSnapshot, isQueryValidationSnapshotCurrent, type QueryValidationSnapshot } from '../shared/query-validation';

type Tab = 'generate' | 'realtime' | 'project';
type ConfigModal = 'report' | 'realtime' | null;
type Result<T> = { ok: true; [key: string]: any } | { ok: false; error: { code: string; message: string } };
type BrowserTabState = { id: string; title: string; url: string; active: boolean };
type BrowserState = { open: boolean; tabs: BrowserTabState[] };
type BrowserCommandResult = { ok: true; state: BrowserState } | { ok: false; error: { code: string; message: string } };
type ProgressState = { phase: string; value: number; message: string };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());

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

function updateRecord(record: Record<string, string>, key: string, value: string): Record<string, string> {
  const next = { ...record };
  if (key.trim()) next[key.trim()] = value.trim();
  return next;
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
  const [filterTemplates, setFilterTemplates] = useState<FilterTemplate[]>([]);
  const [selectedFilterTemplateId, setSelectedFilterTemplateId] = useState('');
  const [filterTemplateName, setFilterTemplateName] = useState('');
  const [filterTemplatePendingDelete, setFilterTemplatePendingDelete] = useState<FilterTemplate | null>(null);
  const [newBidCode, setNewBidCode] = useState('');
  const [newBidName, setNewBidName] = useState('');
  const [newPitcherCode, setNewPitcherCode] = useState('');
  const [newPitcherName, setNewPitcherName] = useState('');
  const [loggedIn, setLoggedIn] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserState, setBrowserState] = useState<BrowserState>({ open: false, tabs: [] });
  const [addressValue, setAddressValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ProgressState>({ phase: 'idle', value: 0, message: '准备生成报表' });
  const [status, setStatus] = useState('请先登录后台，然后填写查询条件。');
  const [error, setError] = useState('');
  const [activeSheet, setActiveSheet] = useState('overall');
  const [configModal, setConfigModal] = useState<ConfigModal>(null);
  const projectLoadSequence = useRef(0);

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
    const stopProgress = window.desktopApi.onProgress((progress) => {
      setBusy(progress.phase !== 'done');
      setProgress(progress);
    });
    const stopBrowserState = window.desktopApi.onBrowserState((nextState) => {
      setBrowserState(nextState);
      setBrowserOpen(nextState.open);
    });
    void window.desktopApi.browserState().then((nextState) => {
      setBrowserState(nextState);
      setBrowserOpen(nextState.open);
    });
    void refreshLogin();
    return () => { stopProgress(); stopBrowserState(); };
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

  async function saveFilterTemplate() {
    setError('');
    const name = filterTemplateName.trim();
    if (!name) { setError('请填写筛选模板名称。'); return; }
    if (!/^\d{4,}$/u.test(gameId)) { setError('保存模板前请填写数字 gameid。'); return; }
    if (!version || version.gameId !== gameId) { setError('保存模板前请先读取当前有效版本。'); return; }
    if (parsePidInput(pidInput).length === 0) { setError('保存模板前至少填写一个数字 PID。'); return; }
    if (filterTemplates.some((template) => template.name === name)) { setError('已存在同名筛选模板，请换一个名称。'); return; }
    const template: FilterTemplate = {
      id: globalThis.crypto.randomUUID?.() ?? `filter-template-${Date.now()}`,
      name,
      gameId,
      gameVersionId: version.key,
      pidInput: pidInput.trim(),
      incomeType,
      includeReattribution,
      includePitcherDetails,
    };
    const saved = await window.desktopApi.saveFilterTemplates([...filterTemplates, template]);
    setFilterTemplates(saved);
    setSelectedFilterTemplateId(template.id);
    setFilterTemplateName('');
    setStatus(`筛选模板“${template.name}”已保存。`);
  }

  function deleteSelectedFilterTemplate() {
    const template = filterTemplates.find((item) => item.id === selectedFilterTemplateId);
    if (!template) { setError('请先选择要删除的筛选模板。'); return; }
    setError('');
    setFilterTemplatePendingDelete(template);
  }

  async function confirmDeleteFilterTemplate() {
    const template = filterTemplatePendingDelete;
    if (!template) return;
    const saved = await window.desktopApi.saveFilterTemplates(filterTemplates.filter((item) => item.id !== template.id));
    setFilterTemplates(saved);
    setSelectedFilterTemplateId('');
    setFilterTemplatePendingDelete(null);
    setStatus(`筛选模板“${template.name}”已删除。`);
  }

  function updateGameId(value: string) {
    const nextGameId = value.trim();
    projectLoadSequence.current += 1;
    setGameId(value);
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

  async function clearSession() {
    if (!window.confirm('确定要清理本机保存的后台登录缓存吗？清理后需要重新登录。')) return;
    await window.desktopApi.clearSession();
    setBrowserOpen(false);
    setLoggedIn(false);
    setStatus('已清除本机缓存的后台登录状态。');
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
    if (!result.ok) {
      setError(result.error.message);
      setVersion(null);
      setVersionCandidates(result.candidates ?? []);
      if ((result.candidates ?? []).length > 1) setStatus('后台返回多个有效版本，请选择一个版本后继续。');
      return;
    }
    setVersion(result.version);
    setVersionCandidates([]);
    const next = await window.desktopApi.saveConfig({ ...config, gameId, currentGameVersionId: result.version.key });
    setConfig(next);
    setStatus(`已确认当前版本：${result.version.name}`);
  }

  async function chooseVersion(candidate: VersionCandidate) {
    const next = await window.desktopApi.saveConfig({ ...config, gameId, currentGameVersionId: candidate.key });
    setConfig(next);
    setVersion(candidate);
    setVersionCandidates([]);
    setPidValidation(null);
    setPidValidationSnapshot(null);
    setDirectory([]);
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
    setStatus('正在读取实时播报所用的当前有效版本…');
    const result = await window.desktopApi.resolveVersion(realtime.gameId) as Result<{ version: VersionCandidate; candidates?: VersionCandidate[] }> & { candidates?: VersionCandidate[] };
    if (!result.ok) {
      setError(result.error.message);
      setRealtimeVersionCandidates(result.candidates ?? []);
      if ((result.candidates ?? []).length > 1) setStatus('后台返回多个有效版本，请选择一个版本后继续。');
      return;
    }
    const saved = await window.desktopApi.saveConfig({
      ...config,
      realtimeConfig: { ...realtime, currentGameVersionId: result.version.key },
    });
    setConfig(saved);
    setRealtimeVersion(result.version);
    setStatus(`实时播报已确认版本：${result.version.name}`);
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
    setError('');
    setStatus(`实时播报已选择版本：${candidate.name}`);
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
    setProgress({ phase: 'prepare', value: 0, message: '正在准备实时播报…' });
    setStatus('正在读取实时 BI 数据…');
    const result = await window.desktopApi.generateRealtime(query) as Result<{ text: string; issues: unknown[] }>;
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      setProgress({ phase: 'failed', value: 0, message: '实时播报生成失败' });
      setStatus('实时播报生成失败');
      return;
    }
    setRealtimeOutput(result.text);
    setProgress({ phase: 'done', value: 1, message: '实时播报已生成' });
    setStatus('实时播报已生成，可直接复制发送。');
  }

  async function copyRealtimeOutput() {
    if (!realtimeOutput) { setError('请先获取实时数据。'); return; }
    try {
      await navigator.clipboard.writeText(realtimeOutput);
      setError('');
      setStatus('实时播报文本已复制。');
    } catch {
      setError('复制失败，请手动选中文本后复制。');
    }
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
    const query: ReportQuery = { gameId, gameVersionId: version.key, pids: pidValidation.accepted, startDate, endDate, paymentStatsEndDate, incomeType, includeReattribution, includePitcherDetails };
    setBusy(true);
    setProgress({ phase: 'prepare', value: 0, message: '正在准备生成…' });
    setStatus('正在准备生成…');
    const saved = await window.desktopApi.saveConfig({ ...config, gameId, currentGameVersionId: version.key, defaultIncomeType: incomeType });
    setConfig(saved);
    const result = await window.desktopApi.generate(query, saved) as Result<{ path: string; rowCount: number; source: string; issues: unknown[] }>;
    setBusy(false);
    if (!result.ok) { setError(result.error.message); setProgress({ phase: 'failed', value: 0, message: '生成失败' }); setStatus('生成失败'); return; }
    setProgress({ phase: 'done', value: 1, message: '生成完成' });
    setStatus(`生成完成：共处理 ${result.rowCount} 行，数据来源：后台结构化数据`);
    await window.desktopApi.openOutputDirectory(result.path);
  }

  async function saveConfig(message = '项目配置已保存。') {
    const saved = await window.desktopApi.saveConfig(config);
    setConfig(saved);
    setStatus(message);
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

  const selectedSheet = useMemo(() => config.sheetConfigs.find((sheet) => sheet.id === activeSheet) ?? config.sheetConfigs[0], [activeSheet, config.sheetConfigs]);
  const pidRows = pidValidation?.entries ?? [];
  const pidConfigIds = Array.from(new Set([...Object.keys(config.pidNames), ...Object.keys(config.pidPackageMap)])).sort();
  const realtime = config.realtimeConfig;

  return (
    <>
      <div className={`app-shell${browserOpen ? ' browser-open' : ''}`}>
       <div className="app-chrome">
         <header className="topbar">
           <div><div className="eyebrow">Q1 OPERATIONS</div><h1>后台数据报表生成器</h1></div>
           <div className="top-actions">
             <span className={loggedIn ? 'status-pill ok' : 'status-pill'}>{loggedIn ? '后台已登录' : '未登录'}</span>
             {browserOpen ? <button className="secondary" onClick={() => void hideBrowser()}>隐藏浏览器</button> : browserState.tabs.length > 0 ? <button className="secondary" onClick={() => void showBrowser()}>显示浏览器</button> : <button className="secondary" onClick={() => void login()}>{loggedIn ? '打开后台浏览器' : '登录后台'}</button>}
             <button className="ghost" onClick={() => void refreshLogin()}>刷新状态</button>
             {loggedIn && <button className="ghost" onClick={() => void clearSession()}>清除登录缓存</button>}
           </div>
         </header>

         <nav className="tabs">
           <button className={tab === 'generate' ? 'active' : ''} onClick={() => setTab('generate')}>生成报表</button>
           <button className={tab === 'realtime' ? 'active' : ''} onClick={() => setTab('realtime')}>实时播报</button>
           <button className={tab === 'project' ? 'active' : ''} onClick={() => setTab('project')}>项目配置</button>
         </nav>
       </div>

      <main className="content">
        {tab === 'generate' && <>
           <section className="card hero-card">
             <div className="section-title"><div><h2>快速生成</h2><p>普通用户只需登录、填写 gameid、PID 和日期，即可生成固定格式 Excel。</p></div><div className="section-actions"><span className="beijing">统一使用北京时间</span><button className="secondary" onClick={() => setConfigModal('report')}>报表配置</button></div></div>
             <div className="template-grid">
               <label>筛选模板<select value={selectedFilterTemplateId} onChange={(event) => { const id = event.target.value; setSelectedFilterTemplateId(id); const template = filterTemplates.find((item) => item.id === id); if (template) void applyFilterTemplate(template); }}><option value="">选择模板后立即带入配置</option>{filterTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}（{template.gameId} / {template.gameVersionId}）</option>)}</select><small>会带入 gameid、版本、PID、收入类型和查询选项。</small></label>
               <div className="field-button"><span>模板操作</span><div className="template-actions"><button className="ghost" onClick={() => void deleteSelectedFilterTemplate()} disabled={!selectedFilterTemplateId || busy}>删除所选模板</button></div></div>
               <label>新模板名称<input value={filterTemplateName} onChange={(event) => setFilterTemplateName(event.target.value)} placeholder="例如：国服安卓收入" /></label>
               <div className="field-button"><span>保存当前筛选</span><div className="template-actions"><button className="secondary" onClick={() => void saveFilterTemplate()} disabled={busy}>保存为模板</button></div></div>
             </div>
             <div className="form-grid four">
              <label>gameid<input value={gameId} onChange={(event) => updateGameId(event.target.value)} placeholder="例如：2170" /></label>
              <div className="field-button"><span>当前有效版本</span><div className="readonly-field">{version?.name ?? '尚未读取'}</div><button className="inline" onClick={() => void resolveVersion()} disabled={busy}>自动读取</button></div>
              <label>收入类型<select value={incomeType} onChange={(event) => setIncomeType(event.target.value as 'amount' | 'realamount')}><option value="amount">收入</option><option value="realamount">实收</option></select></label>
              <label className="toggle-label">重归因<input className="checkbox" type="checkbox" checked={includeReattribution} onChange={(event) => setIncludeReattribution(event.target.checked)} /><small>默认关闭，开启后读取重归因报表</small></label>
              <label className="toggle-label">生成分投手明细<input className="checkbox" type="checkbox" checked={includePitcherDetails} onChange={(event) => setIncludePitcherDetails(event.target.checked)} /><small>按 RADID 第二段汇总为独立 Sheet</small></label>
            </div>
            {versionCandidates.length > 1 && <div className="version-choice"><div className="version-choice-title">检测到多个有效版本，请选择本次报表使用的版本</div><div className="version-choice-list">{versionCandidates.map((candidate) => <div className="version-choice-row" key={candidate.key}><div><strong>{candidate.name}</strong><small>版本标识：{candidate.key}</small></div><button className="secondary" onClick={() => void chooseVersion(candidate)} disabled={busy}>选择此版本</button></div>)}</div></div>}
            <div className="form-grid dates">
              <label>开始日期<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
              <label>结束日期<input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label>
              <label>付费统计结束日期<input type="date" value={paymentStatsEndDate} onChange={(event) => setPaymentStatsEndDate(event.target.value)} /><small>默认本机当天；逐日取数时保持此日期不变</small></label>
              <div className="output-picker"><span>输出目录</span><div className="path-field">{config.outputDirectory || '默认使用系统下载目录'}</div><button className="inline" onClick={() => void chooseOutputDirectory()}>选择目录</button></div>
            </div>
          </section>

          <section className="card">
            <div className="section-title"><div><h2>PID确认</h2><p>多个 PID 请填写为 2170405,2170304；也支持空格或换行分隔。程序会按 PID 分别向后台查找，并逐个显示名称、投放类型、渠道和校验结果。</p></div><button className="secondary" onClick={() => void verifyPids()} disabled={busy}>读取名称并验证</button></div>
            <textarea value={pidInput} onChange={(event) => { setPidInput(event.target.value); setPidValidation(null); setPidValidationSnapshot(null); }} placeholder="例如：2170405, 2170304" rows={3} />
            {pidRows.length > 0 && <div className="pid-table"><div className="pid-row pid-head"><span>PID</span><span>后台中文名称</span><span>投放类型</span><span>状态</span><span>渠道</span><span>操作系统</span><span>操作</span></div>{pidRows.map((entry, index) => <div className="pid-row" key={`${entry.id}-${entry.status}-${index}`}><span className="mono">{entry.id}</span><span>{entry.name || '未找到'}</span><span className={`tag ${entry.deliveryType === '直播' ? 'delivery-live' : entry.deliveryType === '信息流' ? 'delivery-flow' : entry.deliveryType === '自然量' ? 'delivery-natural' : 'unknown'}`}>{entry.deliveryType}</span><span className={`tag ${entry.status}`}>{entry.status === 'ok' ? '通过' : entry.status === 'duplicate' ? '重复' : '有误'}</span><span>{entry.channel ?? entry.packageName ?? '未识别'}</span><span>{entry.operatingSystem ?? '未识别'}</span><button className="pid-remove" aria-label={`移除 PID ${entry.id}`} onClick={() => removePid(entry.id)} disabled={busy}>移除</button></div>)}</div>}
          </section>

        </>}

        {tab === 'realtime' && <>
          <section className="card hero-card">
            <div className="section-title"><div><h2>实时播报</h2><p>从已登录的 BI 后台读取数据，按选定指标生成可直接复制发送的文字。这里的参数和指标配置不会影响 Excel 报表。</p></div><div className="section-actions"><span className="beijing">统一使用北京时间</span><button className="secondary" onClick={() => setConfigModal('realtime')}>实时配置</button></div></div>
            <div className="form-grid four">
              <label>gameid<input value={realtime.gameId} onChange={(event) => { const nextGameId = event.target.value; updateRealtimeConfig((current) => ({ ...current, gameId: nextGameId, currentGameVersionId: nextGameId === current.gameId ? current.currentGameVersionId : null })); setRealtimeVersion(null); setRealtimeVersionCandidates([]); setRealtimeOutput(''); }} placeholder="例如：2170" /></label>
              <div className="field-button"><span>当前有效版本</span><div className="readonly-field">{realtimeVersion?.name ?? '尚未读取'}</div><button className="inline" onClick={() => void resolveRealtimeVersion()} disabled={busy}>自动读取</button></div>
              <label>收入类型<select value={realtime.incomeType} onChange={(event) => updateRealtimeConfig((current) => ({ ...current, incomeType: event.target.value as 'amount' | 'realamount' }))}><option value="amount">收入</option><option value="realamount">实收</option></select></label>
              <label className="toggle-label">重归因<input className="checkbox" type="checkbox" checked={realtime.includeReattribution} onChange={(event) => updateRealtimeConfig((current) => ({ ...current, includeReattribution: event.target.checked }))} /><small>默认关闭，开启后读取重归因数据</small></label>
            </div>
            {realtimeVersionCandidates.length > 1 && <div className="version-choice"><div className="version-choice-title">检测到多个有效版本，请选择本次实时播报使用的版本</div><div className="version-choice-list">{realtimeVersionCandidates.map((candidate) => <div className="version-choice-row" key={candidate.key}><div><strong>{candidate.name}</strong><small>版本标识：{candidate.key}</small></div><button className="secondary" onClick={() => void chooseRealtimeVersion(candidate)} disabled={busy}>选择此版本</button></div>)}</div></div>}
            <div className="form-grid dates">
              <label>开始日期<input type="date" value={realtime.startDate} onChange={(event) => updateRealtimeConfig((current) => ({ ...current, startDate: event.target.value }))} /></label>
              <label>结束日期<input type="date" value={realtime.endDate} onChange={(event) => updateRealtimeConfig((current) => ({ ...current, endDate: event.target.value }))} /></label>
              <label>付费统计结束日期<input type="date" value={realtime.paymentStatsEndDate} onChange={(event) => updateRealtimeConfig((current) => ({ ...current, paymentStatsEndDate: event.target.value }))} /><small>默认本机当天</small></label>
            </div>
          </section>

          <section className="card">
            <div className="section-title"><div><h2>播报对象</h2><p>填写一个或多个数字 PID，使用逗号、空格或换行分隔。程序会在后台校验 PID 并自动使用后台中文名称。</p></div></div>
            <label>PID<textarea value={realtime.pidInput} onChange={(event) => { updateRealtimeConfig((current) => ({ ...current, pidInput: event.target.value })); setRealtimeOutput(''); }} placeholder="例如：2170405, 2170304" rows={3} /></label>
          </section>

          <section className="card realtime-card">
            <div className="section-title"><div><h2>可复制文本</h2><p>指标、顺序和标题格式可通过上方“实时配置”统一调整；文本不会写入 Excel。</p></div><button className="secondary" onClick={() => void copyRealtimeOutput()} disabled={!realtimeOutput}>复制文本</button></div>
            <div className="realtime-output"><textarea readOnly value={realtimeOutput} placeholder="点击窗口底部的“生成实时播报”后，文本会显示在这里。" rows={18} /></div>
          </section>
        </>}

        {tab === 'project' && <>
           <section className="card config-card"><div className="section-title"><div><h2>项目基础配置</h2><p>配置在客户端保存，普通用户不需要接触 JSON 或命令行。</p></div><button className="primary small" onClick={() => void saveConfig()}>保存配置</button></div><div className="form-grid two"><label>项目 gameid<input value={config.gameId} onChange={(event) => updateGameId(event.target.value)} /></label><label>默认收入类型<select value={config.defaultIncomeType} onChange={(event) => setConfig({ ...config, defaultIncomeType: event.target.value as 'amount' | 'realamount' })}><option value="amount">收入</option><option value="realamount">实收</option></select></label><label>TAP ADN/联盟识别关键词<textarea value={config.tapAdnKeywords.join('\n')} onChange={(event) => setConfig({ ...config, tapAdnKeywords: splitList(event.target.value) })} rows={4} placeholder="每行一个关键词" /><small>命中 PID 名称、RADID 或广告账号时进入 TAP ADN/联盟表。</small></label><label>金额差异阈值<input type="number" min={0} step={0.1} value={config.thresholds.amount} onChange={(event) => setConfig({ ...config, thresholds: { ...config.thresholds, amount: Number(event.target.value) } })} /></label><label>比例差异阈值（百分点）<input type="number" min={0} step={0.1} value={config.thresholds.percentagePoint} onChange={(event) => setConfig({ ...config, thresholds: { ...config.thresholds, percentagePoint: Number(event.target.value) } })} /></label><label className="span-two">文件名规则<input value={config.fileNameRule} onChange={(event) => setConfig({ ...config, fileNameRule: event.target.value })} /><small>可用变量：{'{gameid}'}、{'{start}'}、{'{end}'}、{'{income}'}</small></label></div></section>

           <section className="card"><div className="section-title"><div><h2>PID → 渠道 / 操作系统自动识别</h2><p>PID 名称由后台自动读取。APK、IOS、鸿蒙使用固定系统；微小和抖小只有名称明确写“混端投放”或“混投”时按混端处理。未标记混端时按 PID 名称判断系统；如果后台实际同时返回多个系统，媒体数据汇总会额外显示“多端合计”，但不改变 PID 本身的系统判断。</p></div></div>{pidConfigIds.length > 0 ? <div className="mapping-table"><div className="mapping-row mapping-head mapping-row-five"><span>PID</span><span>后台中文名称</span><span>渠道</span><span>操作系统</span><span></span></div>{pidConfigIds.map((pid) => { const pidName = config.pidNames[pid] ?? ''; const classification = inferPidClassification(pidName); const channel = classification?.channel ?? config.pidPackageMap[pid] ?? ''; const operatingSystem = isMixedPidName(pidName, channel) ? '混投（按后台明细拆分）' : config.pidOperatingSystemMap[pid] ?? classification?.operatingSystem ?? (channel === 'APK' ? '安卓' : channel === 'IOS' ? 'IOS' : channel === '鸿蒙' ? '鸿蒙' : ''); return <div className="mapping-row mapping-row-five" key={pid}><span className="mono">{pid}</span><span>{pidName || '未读取名称'}</span><span className={channel ? 'tag ok' : 'tag unknown'}>{channel || '未识别'}</span><span className={operatingSystem ? 'tag ok' : 'tag unknown'}>{operatingSystem || '未识别'}</span><button className="ghost" onClick={() => setConfig((old) => { const nextNames = { ...old.pidNames }; const nextPackages = { ...old.pidPackageMap }; const nextOperatingSystems = { ...old.pidOperatingSystemMap }; delete nextNames[pid]; delete nextPackages[pid]; delete nextOperatingSystems[pid]; return { ...old, pidNames: nextNames, pidPackageMap: nextPackages, pidOperatingSystemMap: nextOperatingSystems }; })}>删除缓存</button></div>; })}</div> : <div className="empty-state">请先在“生成报表”页读取并验证 PID，程序会自动缓存 PID 名称、渠道和操作系统识别结果。</div>}</section>

          <section className="card"><div className="section-title"><div><h2>媒体识别规则</h2><p>优先匹配后台媒体字段；媒体字段为空时使用 RADID 第一段。</p></div></div><div className="rule-table"><div className="rule-row rule-head"><span>媒体</span><span>后台字段别名（逗号分隔）</span><span>RADID前缀（逗号分隔）</span></div>{config.mediaRules.map((rule, index) => <div className="rule-row" key={rule.name}><strong>{rule.name}</strong><input value={rule.aliases.join(', ')} onChange={(event) => updateMediaRule(index, (old) => ({ ...old, aliases: splitList(event.target.value) }))} /><input value={rule.radidPrefixes.join(', ')} onChange={(event) => updateMediaRule(index, (old) => ({ ...old, radidPrefixes: splitList(event.target.value) }))} /></div>)}</div></section>

            <section className="card"><div className="section-title"><div><h2>出价代码映射</h2><p>未配置的出价代码保留原始代码，并写入数据校验 Sheet。</p></div></div><div className="mapping-table"><div className="mapping-row mapping-add"><input value={newBidCode} onChange={(event) => setNewBidCode(event.target.value)} placeholder="原始代码，例如 newroi" /><input value={newBidName} onChange={(event) => setNewBidName(event.target.value)} placeholder="显示名称（不填则显示原始代码）" /><button className="secondary" onClick={addBidCode}>添加</button></div><div className="mapping-row mapping-head"><span>原始代码</span><span>显示名称</span><span></span></div>{Object.entries(config.bidCodeMap).map(([code, name]) => <div className="mapping-row" key={code}><input value={code} readOnly /><input value={name} onChange={(event) => setConfig((old) => ({ ...old, bidCodeMap: { ...old.bidCodeMap, [code]: event.target.value } }))} /><button className="ghost" onClick={() => setConfig((old) => { const next = { ...old.bidCodeMap }; delete next[code]; return { ...old, bidCodeMap: next }; })}>删除</button></div>)}</div></section>
            <section className="card"><div className="section-title"><div><h2>投手名映射</h2><p>投手代码取 RADID 第二段，严格区分大小写。未配置时显示原始代码；后台 PID 汇总未返回 RADID 时会单独标明，不能映射为投手。</p></div></div><div className="mapping-table"><div className="mapping-row mapping-add"><input value={newPitcherCode} onChange={(event) => setNewPitcherCode(event.target.value)} placeholder="投手代码，例如 kz" /><input value={newPitcherName} onChange={(event) => setNewPitcherName(event.target.value)} placeholder="实际投手名称（不填则显示代码）" /><button className="secondary" onClick={addPitcherName}>添加</button></div><div className="mapping-row mapping-head"><span>投手代码</span><span>显示名称</span><span></span></div>{Object.entries(config.pitcherNameMap).map(([code, name]) => <div className="mapping-row" key={code}><input value={code} readOnly /><input value={name} onChange={(event) => setConfig((old) => ({ ...old, pitcherNameMap: { ...old.pitcherNameMap, [code]: event.target.value } }))} /><button className="ghost" onClick={() => setConfig((old) => { const next = { ...old.pitcherNameMap }; delete next[code]; return { ...old, pitcherNameMap: next }; })}>删除</button></div>)}</div></section>
        </>}

       </main>

       {configModal === 'report' && <div className={`config-modal-backdrop${browserOpen ? ' browser-open' : ''}`}>
         <section className="config-modal" role="dialog" aria-modal="true" aria-labelledby="report-config-title">
           <div className="config-modal-header"><div><h2 id="report-config-title">Excel 报表配置</h2><p>设置 Sheet 顺序、每张 Sheet 的固定指标和日期明细展示。这些设置会作为后续 Excel 报表的默认配置。</p></div><button className="ghost modal-close" onClick={() => setConfigModal(null)} aria-label="关闭报表配置">×</button></div>
           <div className="config-modal-body metrics-layout">
             <div className="sheet-list"><h3>Sheet顺序</h3>{config.sheetConfigs.map((sheet, index) => <div className={`sheet-item ${sheet.id === activeSheet ? 'selected' : ''}`} key={sheet.id} onClick={() => setActiveSheet(sheet.id)}><span>{index + 1}. {sheet.name}</span><span className="move-buttons"><button onClick={(event) => { event.stopPropagation(); setConfig({ ...config, sheetConfigs: moveItem(config.sheetConfigs, index, -1) }); }}>↑</button><button onClick={(event) => { event.stopPropagation(); setConfig({ ...config, sheetConfigs: moveItem(config.sheetConfigs, index, 1) }); }}>↓</button></span></div>)}</div>
             <div className="metric-panel"><div className="modal-panel-heading"><h3>{selectedSheet?.name}</h3><button className="secondary" onClick={syncMetrics}>同步到全部 Sheet</button></div>{selectedSheet?.kind === 'overall' ? <p className="hint">首个“媒体数据汇总”Sheet 固定只输出日期范围汇总，不显示逐日数据。</p> : selectedSheet && <label className="daily-toggle"><input type="checkbox" checked={selectedSheet.showDaily} onChange={(event) => updateSheet(selectedSheet.id, (sheet) => ({ ...sheet, showDaily: event.target.checked }))} />显示日期明细（同时保留日期范围合计）</label>}<div className="metric-list">{METRICS.map((metric) => { const checked = selectedSheet?.metricOrder.includes(metric.key) ?? false; return <label className="metric-item" key={metric.key}><input type="checkbox" checked={checked} onChange={(event) => { if (!selectedSheet) return; const next = event.target.checked ? [...selectedSheet.metricOrder, metric.key] : selectedSheet.metricOrder.filter((key) => key !== metric.key); updateSheet(selectedSheet.id, (sheet) => ({ ...sheet, metricOrder: next })); }} /><span>{metric.label}</span><small>{metric.group}</small></label>; })}</div><div className="selected-order"><h3>当前顺序</h3>{selectedSheet?.metricOrder.length ? selectedSheet.metricOrder.map((key, index) => <div className="order-row" key={key}><span>{index + 1}. {metricByKey.get(key as MetricKey)?.label ?? key}</span><span><button onClick={() => selectedSheet && updateSheet(selectedSheet.id, (sheet) => ({ ...sheet, metricOrder: moveItem(sheet.metricOrder, index, -1) }))}>↑</button><button onClick={() => selectedSheet && updateSheet(selectedSheet.id, (sheet) => ({ ...sheet, metricOrder: moveItem(sheet.metricOrder, index, 1) }))}>↓</button></span></div>) : <div className="empty-state">当前 Sheet 未选择指标，生成时只保留固定分组列。</div>}</div></div>
           </div>
           <div className="config-modal-footer"><button className="ghost" onClick={() => setConfigModal(null)}>取消</button><button className="primary small" onClick={() => void saveModalConfig('Excel 报表配置已保存。')}>保存配置</button></div>
         </section>
       </div>}

        {configModal === 'realtime' && <div className={`config-modal-backdrop${browserOpen ? ' browser-open' : ''}`}>
         <section className="config-modal realtime-config-modal" role="dialog" aria-modal="true" aria-labelledby="realtime-config-title">
           <div className="config-modal-header"><div><h2 id="realtime-config-title">实时播报配置</h2><p>设置标题格式、播报指标和显示顺序。不会影响 Excel 报表的任何设置。</p></div><button className="ghost modal-close" onClick={() => setConfigModal(null)} aria-label="关闭实时播报配置">×</button></div>
           <div className="config-modal-body realtime-layout">
             <div className="metric-panel realtime-metric-panel"><h3>可用指标</h3><div className="metric-list realtime-metric-list">{REALTIME_METRICS.map((metric) => { const checked = realtime.metricOrder.includes(metric.key); return <label className="metric-item" key={metric.key}><input type="checkbox" checked={checked} onChange={(event) => updateRealtimeConfig((current) => ({ ...current, metricOrder: event.target.checked ? [...current.metricOrder, metric.key] : current.metricOrder.filter((key) => key !== metric.key) }))} /><span>{metric.label}</span><small>{metric.group}</small></label>; })}</div></div>
             <div className="metric-panel"><label>标题格式<input value={realtime.titleTemplate} onChange={(event) => updateRealtimeConfig((current) => ({ ...current, titleTemplate: event.target.value }))} placeholder="【{pidName}】" /><small>可用变量：{'{pidName}'}（后台中文名）、{'{pid}'}（数字 ID）</small></label><div className="selected-order"><h3>当前顺序</h3>{realtime.metricOrder.length > 0 ? realtime.metricOrder.map((key, index) => <div className="order-row" key={key}><span>{index + 1}. {realtimeMetricByKey.get(key as RealtimeMetricKey)?.label ?? key}</span><span><button onClick={() => updateRealtimeConfig((current) => ({ ...current, metricOrder: moveItem(current.metricOrder, index, -1) }))}>↑</button><button onClick={() => updateRealtimeConfig((current) => ({ ...current, metricOrder: moveItem(current.metricOrder, index, 1) }))}>↓</button></span></div>) : <div className="empty-state">尚未选择指标，生成后只显示标题。</div>}</div></div>
           </div>
           <div className="config-modal-footer"><button className="ghost" onClick={() => setConfigModal(null)}>取消</button><button className="primary small" onClick={() => void saveModalConfig('实时播报配置已保存。')}>保存配置</button></div>
          </section>
        </div>}

        {filterTemplatePendingDelete && <div className={`config-modal-backdrop${browserOpen ? ' browser-open' : ''}`}>
          <section className="config-modal filter-template-delete-modal" role="dialog" aria-modal="true" aria-labelledby="filter-template-delete-title">
            <div className="config-modal-header"><div><h2 id="filter-template-delete-title">删除筛选模板</h2><p>此操作只会删除本机保存的模板，不会删除项目配置或已生成的报表。</p></div><button className="ghost modal-close" onClick={() => setFilterTemplatePendingDelete(null)} aria-label="关闭删除筛选模板确认">×</button></div>
            <div className="config-modal-body"><p className="filter-template-delete-message">确定删除筛选模板“<strong>{filterTemplatePendingDelete.name}</strong>”吗？</p></div>
            <div className="config-modal-footer"><button className="ghost" onClick={() => setFilterTemplatePendingDelete(null)}>取消</button><button className="primary small danger" onClick={() => void confirmDeleteFilterTemplate()}>确认删除</button></div>
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
           <button className="browser-hide" type="button" onClick={() => void hideBrowser()}>隐藏</button>
         </form>
      </aside>}
      </div>

      <section className={`card action-card generation-dock${browserOpen ? ' browser-open' : ''}`}><div className="generation-progress"><div className="progress-message">{progress.phase === 'idle' ? status : progress.message}</div><div className="progress-track" role="progressbar" aria-label="生成进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.value * 100)}><div className="progress-fill" style={{ width: `${Math.round(progress.value * 100)}%` }} /></div><div className="progress-meta"><small>{status}</small><small>{Math.round(progress.value * 100)}%</small></div>{error && <div className="error-box">{error}</div>}</div>{tab === 'generate' && <button className="primary" onClick={() => void generate()} disabled={busy || !loggedIn || !version || !pidValidation || pidValidation.issues.some((issue) => issue.level === 'error')}>{busy ? '处理中…' : '生成 Excel'}</button>}{tab === 'realtime' && <button className="primary" onClick={() => void generateRealtime()} disabled={busy || !loggedIn || !realtimeVersion || parsePidInput(realtime.pidInput).length === 0}>{busy ? '处理中…' : '生成实时播报'}</button>}</section>
    </>
  );
}
