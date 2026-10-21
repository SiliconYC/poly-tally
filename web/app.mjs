import {renderLanguageChart} from './language-chart.mjs';
import {renderStackedChart} from './stacked-chart.mjs';
import {repositoryColors} from './chart-utils.mjs';
import { METRIC_LABELS, STATUS_LABELS, aggregateHistory, selectRepositories, latestTotals, languageTotals, loadStats, publicationSummary, repositoryVisibility, repositoryDisplayName, sortRepositories, repositoryOptions, stockChange } from './model.mjs';

const $ = id => document.getElementById(id);
const format = number => new Intl.NumberFormat('zh-CN').format(number);
const compact = number => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(number);
const dateFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const shortDate = new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', month: '2-digit', day: '2-digit' });
const formatDate = value => Number.isFinite(Date.parse(value)) ? dateFormat.format(new Date(value)) : '尚未成功';
const palette = ['#2563eb', '#7c6ad8', '#0d9488', '#d89a40', '#df7280', '#5c9eca', '#7cab68', '#94a3b8'];
const languageColors = { Python: '#4485d8', JavaScript: '#e0b34b', TypeScript: '#7e72d4', Rust: '#d58d69', Go: '#59aebc', Markdown: '#8da2ba', HTML: '#df8591', CSS: '#9a85cd', Shell: '#6aaf96' };
let data;
let colors;
const chartView = {hidden: new Set(), range: null, percent: false};
const state = { mode: 'current', ids: [], scope: 'all', language: 'all', metric: 'code', period: 'all', includeStale: false, tableSort: 'name', tableDirection: 'asc', pickerSort: 'name-asc', query: '', languageSort: 'value-desc' };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function svgElement(tag, attributes = {}, text) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}
function badge(text, style = '') { return element('span', `status-badge ${style}`, text); }
function repositoryLink(repository) {
  const name = element('span', 'repo-name', repositoryDisplayName(repository));
  if (repositoryVisibility(repository) === 'private') return name;
  try {
    const url = new URL(repository.url);
    if (url.protocol === 'https:' && url.hostname === 'github.com') {
      const link = element('a', 'repo-name', repositoryDisplayName(repository));
      link.href = url.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      return link;
    }
  } catch {}
  return name;
}
function setLoading() {
  $('dashboard').hidden = true;
  $('load-state').hidden = false;
  $('load-state').replaceChildren(element('span', 'loader'), element('h2', '', '正在读取代码历史'), element('p', '', '即将呈现仓库与时间之间的联系。'));
  $('refresh').disabled = true;
}
async function initialize() {
  setLoading();
  try {
    data = await loadStats();
    colors = repositoryColors(data.repositories);
    state.ids = data.repositories.map(repository => repository.id);
    populateFilters();
    $('load-state').hidden = true;
    $('dashboard').hidden = false;
    $('updated-at').textContent = `更新于 ${formatDate(data.generatedAt)} UTC`;
    $('rules-description').textContent = `规则 ${data.rules.version} · ${data.rules.description ?? '所有纳入仓库采用相同统计规则。'}`;
    $('footer-version').textContent = `采集器 ${data.collector?.version ?? '—'} · 规则 ${data.rules.version}`;
    render();
    renderPublication();
    renderRun();
  } catch (error) {
    const retry = element('button', 'retry-button', '重新加载');
    retry.addEventListener('click', initialize);
    $('load-state').replaceChildren(element('span', 'state-symbol', '↻'), element('h2', '', '暂时无法读取统计数据'), element('p', '', `${error.message || '连接失败'} 请检查网络，或等待首次采集与发布完成后重试。`), retry);
    $('updated-at').replaceChildren(document.createTextNode('数据尚未就绪'), element('small', '', '可稍后重新加载'));
  } finally { $('refresh').disabled = false; }
}
function renderPublication() {
  const summary = publicationSummary(data);
  $('publication-counts').textContent = `已发布 ${format(summary.publicRepositories)} 个公开仓库 + ${format(summary.privateRepositories)} 个私有仓库`;
  const source = { local: '本地采集', 'github-actions': 'GitHub Actions' }[summary.privateSource];
  const status = { available: '可用', 'not-configured': '未配置私有采集凭据', stale: '保留旧指标，尚未刷新' }[summary.privateStatus] ?? '采集状态未知';
  $('private-updated-at').textContent = `私有指标：${status} · 最后成功 ${summary.privateUpdatedAt ? `${formatDate(summary.privateUpdatedAt)} UTC` : '尚无独立采集时间'}${source ? ` · ${source}` : ''}${summary.privateRepositories ? '' : ' · 尚无已发布私有指标'}`;
}
function renderRepositoryOptions() {
  const options = $('repository-options');
  const focusedId = options.contains(document.activeElement) ? document.activeElement.value : null;
  const [key, direction] = state.pickerSort.split('-');
  const repositories = repositoryOptions(data.repositories, { query: state.query, key, direction, language: state.language, metric: state.metric });
  options.replaceChildren();
  for (const repository of repositories) {
    const label = element('label', 'repository-option');
    const input = element('input');
    input.type = 'checkbox'; input.value = repository.id; input.checked = state.ids.includes(repository.id);
    input.addEventListener('change', () => {
      state.ids = input.checked ? [...new Set([...state.ids, repository.id])] : state.ids.filter(id => id !== repository.id);
      render();
    });
    label.append(input, element('span', '', repositoryDisplayName(repository)), element('small', '', key === 'metric' ? format(latestTotals([repository], state.language)[state.metric]) : repositoryVisibility(repository) === 'private' ? '私有' : '公开'));
    options.append(label);
  }
  if (!repositories.length) options.append(element('p', 'inline-empty', data.repositories.length ? '没有匹配的仓库' : '暂无已发布仓库'));
  if (focusedId) [...options.querySelectorAll('input')].find(input => input.value === focusedId)?.focus({ preventScroll: true });
}
function populateFilters() {
  renderRepositoryOptions();
  const languages = [...new Set(data.repositories.flatMap(repository => repository.history.flatMap(snapshot => Object.keys(snapshot.languages))))].sort();
  $('language').replaceChildren();
  for (const [value, name] of [['all', '全部语言'], ...languages.map(name => [name, name])]) {
    const option = element('option', '', name); option.value = value; $('language').append(option);
  }
  if (!languages.includes(state.language)) state.language = 'all';
  $('language').value = state.language;
}
function render() {
  const selected = selectRepositories(data, state);
  const scoped = data.repositories.filter(repository => state.scope === 'all' || repositoryVisibility(repository) === state.scope);
  const total = latestTotals(selected, state.language);
  $('current-view').classList.toggle('selected', state.mode === 'current');
  $('archive-view').classList.toggle('selected', state.mode === 'archive');
  $('current-view').setAttribute('aria-pressed', String(state.mode === 'current'));
  $('archive-view').setAttribute('aria-pressed', String(state.mode === 'archive'));
  $('scope-description').textContent = state.mode === 'current' ? '当前可用仓库 · 公开提交 / 私有按日规模' : '包含已退役仓库的同口径历史快照';
  $('repository-label').textContent = state.ids.length === data.repositories.length ? '全部仓库' : `已选 ${state.ids.length} 个仓库`;
  $('stat-label').textContent = '当前' + METRIC_LABELS[state.metric];
  $('stat-total').textContent = format(total[state.metric]);
  const privateCount = selected.filter(repository => repositoryVisibility(repository) === 'private').length;
  $('stat-context').textContent = format(selected.length) + ' 个仓库 · 公开 ' + format(selected.length - privateCount) + ' / 私有 ' + format(privateCount) + ' · 最新已知快照';
  const filtered = [state.scope === 'all' ? '' : state.scope === 'private' ? '仅私有仓库' : '仅公开仓库', state.language === 'all' ? '' : state.language, state.mode === 'archive' ? '历史档案' : '', state.includeStale ? '含过期快照' : ''].filter(Boolean);
  $('active-filters').hidden = !filtered.length;
  $('active-filters').textContent = filtered.join(' · ');
  const messages = [];
  if (!data.repositories.length) messages.push('尚无可发布的仓库数据。首次成功采集后，这里会自动呈现默认分支历史。');
  const mismatched = scoped.filter(repository => state.ids.includes(repository.id) && repository.rulesVersion !== data.rules.version && repository.history.length);
  if (mismatched.length) messages.push(`${mismatched.length} 个仓库保留旧规则快照，已隔离出汇总。`);
  const stale = selected.filter(repository => ['stale', 'inaccessible'].includes(repository.status));
  if (stale.length) messages.push(`已明确纳入 ${stale.length} 个过期或不可访问仓库的最后成功快照；它们可能与源仓库当前状态不同。`);
  else {
    const omitted = scoped.filter(repository => state.ids.includes(repository.id) && ['stale', 'inaccessible'].includes(repository.status));
    if (omitted.length) messages.push(`${omitted.length} 个过期或不可访问仓库未纳入汇总，可勾选“包含过期快照”查看同规则的旧数据。`);
  }
  const incomplete = selected.filter(repository => !repository.historyComplete);
  if (incomplete.length) messages.push(`${incomplete.length} 个仓库的历史尚不完整；曲线仅反映已采集快照。`);
  const cold = selected.filter(repository => repository.status === 'cold');
  if (cold.length) messages.push(`历史档案纳入 ${cold.length} 个冷数据仓库，保留最后成功快照并向后延续。`);
  $('warnings').hidden = !messages.length;
  $('warnings').textContent = messages.join(' ');
  $('timeline-title').textContent = `${METRIC_LABELS[state.metric]}存量趋势`;
  const until = data.generatedAt;
  const since = state.period === 'all' ? undefined : new Date(Date.parse(until) - Number(state.period) * 86400000).toISOString();
  renderStackedChart({container: $('chart'), navigator: $('chart-navigator'), legend: $('chart-legend'), details: $('chart-details'), rangeLabel: $('chart-range'), repositories: selected, colors, metric: state.metric, label: METRIC_LABELS[state.metric], language: state.language, since, until, view: chartView});
  renderLanguages(selected);
  renderTable();
  const changeDays = state.period === 'all' ? 30 : Number(state.period);
  const change = stockChange(selected, { since: new Date(Date.parse(until) - changeDays * 86400000).toISOString(), until, language: state.language, metric: state.metric });
  $('change-label').textContent = '近 ' + changeDays + ' 天净变化';
  $('stat-change').textContent = change.change === null ? '暂不可比' : (change.change > 0 ? '+' : '') + format(change.change);
  $('stat-change').className = change.change === null ? 'unavailable' : change.change < 0 ? 'negative' : '';
  $('change-context').textContent = !selected.length ? '先选择可用仓库' : change.missing ? change.missing + ' 个仓库缺少期初快照' : METRIC_LABELS[state.metric] + ' · 对比期初已知存量';
  renderRepositoryOptions();
}
function renderLanguages(repositories) {
  const [key, direction] = state.languageSort.split('-');
  const languages = languageTotals(repositories, state.metric, { key, direction }).filter(language => state.language === 'all' || language.name === state.language);
  const total = languages.reduce((sum, language) => sum + language.value, 0);
  $('language-total').textContent = format(total);
  $('language-unit').textContent = `${METRIC_LABELS[state.metric]} · 最新快照`;
  $('language-reset').hidden = state.language === 'all';
  renderLanguageChart({container: $('language-chart'), list: $('language-list'), languages, label: METRIC_LABELS[state.metric], onSelect: name => {
    state.language = name; $('language').value = name; render();
  }});
}
function renderTable() {
  const repositories = sortRepositories(selectRepositories(data, state), { key: state.tableSort, direction: state.tableDirection, metric: state.metric, language: state.language });
  for (const button of document.querySelectorAll('[data-sort]')) {
    const active = button.dataset.sort === state.tableSort;
    button.closest('th').setAttribute('aria-sort', active ? state.tableDirection === 'asc' ? 'ascending' : 'descending' : 'none');
    button.lastElementChild.textContent = active ? state.tableDirection === 'asc' ? '↑' : '↓' : '↕';
  }
  $('repository-count').textContent = format(repositories.length);
  const tbody = $('repository-table'); tbody.replaceChildren();
  if (!repositories.length) {
    const row = element('tr'), cell = element('td', 'empty-table', data.repositories.length ? '没有选中的仓库，请调整筛选范围。' : '暂无仓库；等待首次成功采集。');
    cell.colSpan = 7; row.append(cell); tbody.append(row);
  }
  for (const repository of repositories) {
    const isPrivate = repositoryVisibility(repository) === 'private';
    const row = element('tr');
    const name = element('td'); name.append(repositoryLink(repository), element('span', 'repo-secondary', isPrivate ? '私有 · 按日规模' : `公开 · ⑂ ${repository.branch || '尚无默认分支'}`));
    const totals = latestTotals([repository], state.language);
    row.append(name);
    for (const metric of ['total', 'code', 'comment', 'documentation', 'blank', 'files']) {
      row.append(element('td', 'repo-number', format(totals[metric])));
    }
    tbody.append(row);
  }
}
function renderRun() {
  const runs = [...(data.runs ?? [])].sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt));
  const run = runs[0];
  if (!run) { $('run-summary').replaceChildren(element('p', '', '暂无运行记录')); return; }
  $('run-status').textContent = run.failed ? `${format(run.failed)} 个失败` : '采集完成';
  $('run-status').classList.toggle('warning-status', Boolean(run.failed));
  const fields = [[format(run.repositories ?? 0), '公开仓库'], [`${Number(run.durationSeconds ?? 0).toFixed(1)}s`, '运行耗时'], [format(run.cacheHits ?? 0), '缓存命中'], [format(run.parsedBlobs ?? 0), '解析文件对象'], [format(run.objectReads ?? 0), '对象读取'], [format(run.recomputedCommits ?? 0), '重算提交']];
  $('run-summary').replaceChildren();
  for (const [value, name] of fields) { const item = element('div'); item.append(element('strong', '', value), element('span', '', name)); $('run-summary').append(item); }
  $('run-summary').append(element('p', 'run-time', `${formatDate(run.finishedAt)} UTC · 只读采集`));
}
$('current-view').addEventListener('click', () => { state.mode = 'current'; render(); });
$('archive-view').addEventListener('click', () => { state.mode = 'archive'; render(); });
$('include-stale').addEventListener('change', event => { state.includeStale = event.target.checked; render(); });
for (const id of ['scope', 'language', 'metric', 'period']) $(id).addEventListener('change', event => { state[id] = event.target.value; if (id === 'period') chartView.range = null; render(); });
for (const [id, checked] of [['select-all', true], ['select-none', false]]) $(id).addEventListener('click', () => {
  for (const checkbox of $('repository-options').querySelectorAll('input')) checkbox.checked = checked;
  state.ids = checked ? data.repositories.map(repository => repository.id) : []; render();
});
$('reset-filters').addEventListener('click', () => {
  chartView.hidden.clear(); chartView.range = null; chartView.percent = false;
  $('chart-absolute').setAttribute('aria-pressed', 'true'); $('chart-percent').setAttribute('aria-pressed', 'false');
  state.ids = data.repositories.map(repository => repository.id); state.scope = 'all'; state.language = 'all'; state.metric = 'code'; state.period = 'all'; state.includeStale = false; state.mode = 'current'; state.query = ''; state.pickerSort = 'name-asc'; state.tableSort = 'name'; state.tableDirection = 'asc'; state.languageSort = 'value-desc';
  $('repository-search').value = ''; $('repository-sort').value = 'name-asc'; $('language-sort').value = 'value-desc';
  for (const id of ['scope', 'language', 'metric', 'period']) $(id).value = state[id];
  $('include-stale').checked = false;
  for (const checkbox of $('repository-options').querySelectorAll('input')) checkbox.checked = true;
  render();
});
$('repository-search').addEventListener('input', event => { state.query = event.target.value; renderRepositoryOptions(); });
$('repository-sort').addEventListener('change', event => { state.pickerSort = event.target.value; renderRepositoryOptions(); });
$('language-reset').addEventListener('click', () => { state.language = 'all'; $('language').value = 'all'; render(); });
$('language-sort').addEventListener('change', event => { state.languageSort = event.target.value; renderLanguages(selectRepositories(data, state)); });
for (const button of document.querySelectorAll('[data-sort]')) button.addEventListener('click', () => {
  state.tableDirection = state.tableSort === button.dataset.sort ? state.tableDirection === 'asc' ? 'desc' : 'asc' : button.dataset.sort !== 'name' ? 'desc' : 'asc';
  state.tableSort = button.dataset.sort;
  renderTable();
});
for (const [id, percent] of [['chart-absolute', false], ['chart-percent', true]]) $(id).addEventListener('click', () => {
  chartView.percent = percent;
  $('chart-absolute').setAttribute('aria-pressed', String(!percent)); $('chart-percent').setAttribute('aria-pressed', String(percent));
  render();
});
$('refresh').addEventListener('click', initialize);
document.addEventListener('click', event => { for (const picker of document.querySelectorAll('.repository-picker, .more-filters')) if (!picker.contains(event.target)) picker.open = false; });
document.addEventListener('keydown', event => { if (event.key === 'Escape') for (const picker of document.querySelectorAll('.repository-picker, .more-filters')) picker.open = false; });
initialize();
let resizeFrame;
window.addEventListener('resize', () => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => { if (data && !$('dashboard').hidden) render(); });
});
