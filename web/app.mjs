import { METRIC_LABELS, STATUS_LABELS, aggregateHistory, selectRepositories, latestTotals, languageTotals, loadStats, publicationSummary, repositoryVisibility } from './model.mjs';

const $ = id => document.getElementById(id);
const format = number => new Intl.NumberFormat('zh-CN').format(number);
const compact = number => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(number);
const dateFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const shortDate = new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', month: '2-digit', day: '2-digit' });
const formatDate = value => Number.isFinite(Date.parse(value)) ? dateFormat.format(new Date(value)) : '尚未成功';
const palette = ['#9de7cb', '#d9b98c', '#91b5e7', '#ada7df', '#db9d9a', '#81bfc8', '#c4cc91', '#9faab8'];
const languageColors = { Python: '#d9b98c', JavaScript: '#c4cc91', TypeScript: '#91b5e7', Rust: '#db9d9a', Go: '#81bfc8', Markdown: '#ada7df', HTML: '#d7a780', CSS: '#99a5e7', Shell: '#9de7cb' };
let data;
const state = { mode: 'current', ids: [], scope: 'all', language: 'all', metric: 'code', period: 'all', includeStale: false };

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
  const name = element('span', 'repo-name', repository.name);
  if (repositoryVisibility(repository) === 'private') return name;
  try {
    const url = new URL(repository.url);
    if (url.protocol === 'https:' && url.hostname === 'github.com') {
      const link = element('a', 'repo-name', repository.name);
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
    state.ids = data.repositories.map(repository => repository.id);
    populateFilters();
    $('load-state').hidden = true;
    $('dashboard').hidden = false;
    const time = document.createTextNode(`数据发布于 ${formatDate(data.generatedAt)}`);
    $('updated-at').replaceChildren(time, element('small', '', 'UTC · 私有采集时间单独列示'));
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
function populateFilters() {
  const options = $('repository-options');
  options.replaceChildren();
  for (const repository of data.repositories) {
    const label = element('label', 'repository-option');
    const input = element('input');
    input.type = 'checkbox'; input.value = repository.id; input.checked = state.ids.includes(repository.id);
    input.addEventListener('change', () => {
      state.ids = [...options.querySelectorAll('input:checked')].map(checkbox => checkbox.value);
      render();
    });
    label.append(input, element('span', '', repository.name), element('small', '', STATUS_LABELS[repository.status] ?? repository.status));
    options.append(label);
  }
  if (!data.repositories.length) options.append(element('p', 'inline-empty', '暂无已发布仓库'));
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
  $('stat-code').textContent = format(total.code);
  $('stat-documentation').textContent = format(total.documentation);
  $('stat-comment').textContent = `${format(total.comment)} 注释行 · ${format(total.blank)} 空行`;
  $('stat-repositories').replaceChildren(document.createTextNode(format(selected.length)), element('span', '', '个'));
  $('stat-files').textContent = `${format(total.files)} 个已统计文件`;
  const privateCount = selected.filter(repository => repositoryVisibility(repository) === 'private').length;
  $('stat-repository-scope').textContent = `公开 ${format(selected.length - privateCount)} · 私有 ${format(privateCount)}`;
  $('stat-commits').textContent = format(selected.reduce((sum, repository) => sum + repository.history.length, 0));
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
  $('chart-legend').textContent = METRIC_LABELS[state.metric];
  $('timeline-title').textContent = `${METRIC_LABELS[state.metric]}存量趋势`;
  const until = data.generatedAt;
  const since = state.period === 'all' ? undefined : new Date(Date.parse(until) - Number(state.period) * 86400000).toISOString();
  const points = aggregateHistory(selected, { language: state.language, metric: state.metric, since, until });
  renderChart(points);
  renderLanguages(selected);
  renderTable();
  renderSpark(aggregateHistory(selected, { language: state.language, metric: 'code' }));
}
function renderSpark(points) {
  const path = document.querySelector('.stat-spark path');
  if (!points.length) { path.setAttribute('d', ''); return; }
  const first = Date.parse(points[0].timestamp), span = Date.parse(points.at(-1).timestamp) - first || 1;
  const max = points.reduce((maximum, point) => Math.max(maximum, point.value), 1);
  let d = `M0 ${54 - points[0].value / max * 48}`;
  for (const point of points.slice(1)) d += `H${((Date.parse(point.timestamp) - first) / span * 220).toFixed(1)}V${(54 - point.value / max * 48).toFixed(1)}`;
  path.setAttribute('d', d);
}
function renderLanguages(repositories) {
  const languages = languageTotals(repositories, state.metric).filter(language => state.language === 'all' || language.name === state.language);
  const total = languages.reduce((sum, language) => sum + language.value, 0);
  $('language-total').textContent = format(total);
  $('language-unit').textContent = `${METRIC_LABELS[state.metric]} · 最新快照`;
  $('language-bar').replaceChildren();
  $('language-list').replaceChildren();
  if (!languages.length) $('language-list').append(element('p', 'inline-empty', '当前筛选下暂无语言数据。'));
  for (const [index, language] of languages.entries()) {
    const color = languageColors[language.name] ?? palette[index % palette.length];
    const bar = element('span'); bar.style.backgroundColor = color; bar.style.width = `${language.value / total * 100}%`; $('language-bar').append(bar);
    const row = element('div', 'language-row');
    const dot = element('span', 'language-dot'); dot.style.backgroundColor = color;
    row.append(dot, element('span', 'language-name', language.name), element('span', 'language-count', format(language.value)), element('span', 'language-percent', `${(language.value / total * 100).toFixed(1)}%`));
    $('language-list').append(row);
  }
}
function renderTable() {
  const repositories = data.repositories.filter(repository => state.ids.includes(repository.id) && (state.scope === 'all' || repositoryVisibility(repository) === state.scope));
  const eligible = new Set(selectRepositories(data, state).map(repository => repository.id));
  $('repository-count').textContent = format(repositories.length);
  $('table-metric').textContent = METRIC_LABELS[state.metric];
  const tbody = $('repository-table'); tbody.replaceChildren();
  if (!repositories.length) {
    const row = element('tr'), cell = element('td', 'empty-table', data.repositories.length ? '没有选中的仓库，请调整筛选范围。' : '暂无仓库；等待首次成功采集。');
    cell.colSpan = 5; row.append(cell); tbody.append(row);
  }
  for (const repository of repositories) {
    const isPrivate = repositoryVisibility(repository) === 'private';
    const row = element('tr');
    const name = element('td'); name.append(repositoryLink(repository), element('span', 'repo-secondary', isPrivate ? '私有 · 按日规模' : `公开 · ⑂ ${repository.branch || '尚无默认分支'}`));
    const value = latestTotals([repository], state.language)[state.metric];
    const metric = element('td', 'repo-number', repository.history.length ? format(value) : '—');
    if (!eligible.has(repository.id)) metric.append(element('small', '', '未汇总'));
    const head = element('td');
    head.append(element('span', '', isPrivate ? '提交信息不公开' : repository.head ? repository.head.slice(0, 8) : '—'), element('span', 'repo-secondary', `${formatDate(repository.lastSuccessAt)}${repository.lastSuccessAt ? ' UTC' : ''}`));
    const status = element('td');
    const style = ['inaccessible', 'stale'].includes(repository.status) ? 'error-status' : ['active', 'archived'].includes(repository.status) ? '' : 'muted-status';
    status.append(badge(STATUS_LABELS[repository.status] ?? repository.status, style));
    if (repository.notice) { const notice = element('span', 'repo-secondary', repository.notice); notice.title = repository.notice; status.append(notice); }
    const rule = element('td');
    rule.append(element('span', repository.historyComplete ? 'rule-ok' : 'rule-bad', isPrivate ? '按日规模快照' : repository.historyComplete ? '提交历史完整' : '提交历史不完整'));
    const matching = repository.rulesVersion === data.rules.version;
    rule.append(element('span', `repo-secondary ${matching ? '' : 'rule-bad'}`, `${repository.rulesVersion || '未知规则'}${matching ? ' · 统一口径' : ' · 旧口径，已隔离'}`));
    row.append(name, metric, head, status, rule); tbody.append(row);
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
function renderChart(points) {
  const container = $('chart'); container.replaceChildren();
  if (!points.length) {
    const message = element('div', 'chart-empty');
    message.append(element('strong', '', state.ids.length ? '这个范围还没有可用快照' : '选择仓库，展开时间线'), element('span', '', '可调整时间、语言或仓库范围；旧口径数据不会混入曲线。'));
    container.append(message); $('chart-range').textContent = 'UTC'; return;
  }
  const width = Math.max(280, container.clientWidth), height = container.clientHeight, left = 49, right = 16, top = 20, bottom = 34;
  const minTime = Date.parse(points[0].timestamp), maxTime = Date.parse(points.at(-1).timestamp);
  const timeSpan = maxTime - minTime || 86400000;
  const maximum = points.reduce((maximum, point) => Math.max(maximum, point.value), 1) * 1.15;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const x = time => left + (time - minTime) / timeSpan * plotWidth;
  const y = value => top + plotHeight - value / maximum * plotHeight;
  const svg = svgElement('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', tabindex: '0', 'aria-label': `${METRIC_LABELS[state.metric]}阶梯历史曲线。共 ${points.length} 个观察点，最新 ${format(points.at(-1).value)}。使用左右方向键查看详情，Home 和 End 跳到首尾。`, 'aria-describedby': 'chart-details' });
  const defs = svgElement('defs'), gradient = svgElement('linearGradient', { id: 'chart-fill', x1: '0', y1: '0', x2: '0', y2: '1' });
  gradient.append(svgElement('stop', { offset: '0%', 'stop-color': '#9de7cb', 'stop-opacity': '.15' }), svgElement('stop', { offset: '100%', 'stop-color': '#9de7cb', 'stop-opacity': '0' })); defs.append(gradient); svg.append(defs);
  for (let i = 0; i <= 4; i++) {
    const value = maximum * i / 4, cy = y(value);
    svg.append(svgElement('line', { x1: left, x2: width - right, y1: cy, y2: cy, class: 'chart-grid' }), svgElement('text', { x: left - 12, y: cy + 3, 'text-anchor': 'end', class: 'chart-tick' }, compact(Math.round(value))));
  }
  const ticks = maxTime === minTime ? 1 : width < 450 ? 3 : 5;
  for (let i = 0; i < ticks; i++) {
    const time = minTime + (ticks === 1 ? 0 : timeSpan * i / (ticks - 1));
    svg.append(svgElement('text', { x: x(time), y: height - 10, 'text-anchor': i === 0 ? 'start' : i === ticks - 1 ? 'end' : 'middle', class: 'chart-tick' }, timeSpan > 370 * 86400000 ? new Date(time).toISOString().slice(0, 7) : shortDate.format(time)));
  }
  let d = `M${left},${y(points[0].value).toFixed(2)}`;
  for (const point of points.slice(1)) d += `H${x(Date.parse(point.timestamp)).toFixed(2)}V${y(point.value).toFixed(2)}`;
  const lastX = x(maxTime);
  if (points.length === 1) d += `H${width - right}`;
  svg.append(svgElement('path', { d: `${d}V${height - bottom}H${left}Z`, class: 'chart-area' }), svgElement('path', { d, class: 'chart-line' }));
  const cursor = svgElement('line', { x1: lastX, x2: lastX, y1: top, y2: height - bottom, class: 'chart-cursor', visibility: 'hidden' });
  const dot = svgElement('circle', { cx: lastX, cy: y(points.at(-1).value), r: 4, class: 'chart-dot', visibility: 'hidden' });
  svg.append(cursor, dot);
  const tooltip = element('div', 'chart-tooltip'); tooltip.hidden = true;
  const accessible = element('div', 'sr-only'); accessible.id = 'chart-details'; accessible.setAttribute('aria-live', 'polite');
  accessible.textContent = '聚焦曲线后，使用左右方向键逐个查看观察点。';
  const hint = element('span', 'chart-hint', '悬停查看 · 方向键浏览');
  container.append(svg, tooltip, accessible, hint);
  let activeIndex = points.length - 1;
  function showPoint(index) {
    activeIndex = Math.max(0, Math.min(points.length - 1, index));
    const point = points[activeIndex], cx = x(Date.parse(point.timestamp)), cy = y(point.value);
    cursor.setAttribute('x1', cx); cursor.setAttribute('x2', cx); cursor.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.setAttribute('visibility', 'visible');
    tooltip.hidden = false;
    tooltip.replaceChildren(document.createTextNode(`${formatDate(point.timestamp)} UTC`), element('strong', '', `${format(point.value)} ${METRIC_LABELS[state.metric]}`));
    tooltip.style.left = `${Math.max(5, Math.min(container.clientWidth - 170, cx / width * container.clientWidth + 12))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(container.clientHeight - 65, cy / height * container.clientHeight - 65))}px`;
    accessible.textContent = `${formatDate(point.timestamp)} UTC，${METRIC_LABELS[state.metric]} ${format(point.value)}。`;
  }
  svg.addEventListener('pointermove', event => {
    const bounds = svg.getBoundingClientRect();
    const time = minTime + Math.max(0, Math.min(1, ((event.clientX - bounds.left) / bounds.width * width - left) / plotWidth)) * timeSpan;
    let low = 0, high = points.length - 1;
    while (low < high) { const middle = Math.ceil((low + high) / 2); if (Date.parse(points[middle].timestamp) <= time) low = middle; else high = middle - 1; }
    showPoint(low);
  });
  const hide = () => { tooltip.hidden = true; cursor.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); };
  svg.addEventListener('pointerleave', () => { if (document.activeElement !== svg) hide(); });
  svg.addEventListener('focus', () => showPoint(activeIndex)); svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    showPoint(event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 : activeIndex + (event.key === 'ArrowRight' ? 1 : -1));
  });
  $('chart-range').textContent = `${new Date(minTime).toISOString().slice(0, 10)} — ${new Date(maxTime).toISOString().slice(0, 10)} · UTC`;
}
$('current-view').addEventListener('click', () => { state.mode = 'current'; render(); });
$('archive-view').addEventListener('click', () => { state.mode = 'archive'; render(); });
$('include-stale').addEventListener('change', event => { state.includeStale = event.target.checked; render(); });
for (const id of ['scope', 'language', 'metric', 'period']) $(id).addEventListener('change', event => { state[id] = event.target.value; render(); });
for (const [id, checked] of [['select-all', true], ['select-none', false]]) $(id).addEventListener('click', () => {
  for (const checkbox of $('repository-options').querySelectorAll('input')) checkbox.checked = checked;
  state.ids = checked ? data.repositories.map(repository => repository.id) : []; render();
});
$('reset-filters').addEventListener('click', () => {
  state.ids = data.repositories.map(repository => repository.id); state.scope = 'all'; state.language = 'all'; state.metric = 'code'; state.period = 'all'; state.includeStale = false;
  for (const id of ['scope', 'language', 'metric', 'period']) $(id).value = state[id];
  $('include-stale').checked = false;
  for (const checkbox of $('repository-options').querySelectorAll('input')) checkbox.checked = true;
  render();
});
$('refresh').addEventListener('click', initialize);
document.addEventListener('click', event => { if (!$('repository-picker').contains(event.target)) $('repository-picker').open = false; });
document.addEventListener('keydown', event => { if (event.key === 'Escape') $('repository-picker').open = false; });
initialize();
let resizeFrame;
window.addEventListener('resize', () => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => { if (data && !$('dashboard').hidden) render(); });
});
