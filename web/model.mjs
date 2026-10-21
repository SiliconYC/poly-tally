export const METRICS = ['code', 'comment', 'blank', 'documentation', 'files'];
export const METRIC_LABELS = { total: '总行数', code: '代码行', comment: '注释行', blank: '空行', documentation: '文档行', files: '文件数' };
export const STATUS_LABELS = { active: '正常', archived: '已归档', empty: '空仓库', inaccessible: '不可访问', excluded: '已排除', cold: '冷数据', stale: '数据过期' };

const emptyMetrics = () => Object.fromEntries(METRICS.map(key => [key, 0]));
const numeric = value => Number.isFinite(value) && value >= 0 ? value : 0;
export const metricValue = (metrics, metric) => metric === 'total'
  ? ['code', 'comment', 'blank', 'documentation'].reduce((sum, key) => sum + numeric(metrics?.[key]), 0)
  : numeric(metrics?.[metric]);
const instant = value => Date.parse(value);
const iso = time => new Date(time).toISOString().replace('.000Z', 'Z');
const sortedHistory = repository => repository.history.map((snapshot, index) => ({ ...snapshot, time: instant(snapshot.timestamp), index })).filter(snapshot => Number.isFinite(snapshot.time)).sort((a, b) => a.time - b.time || a.index - b.index);
const snapshotMetrics = (snapshot, language) => language === 'all' ? snapshot?.metrics : snapshot?.languages?.[language];

export const repositoryVisibility = repository => repository.visibility ?? 'public';
export const repositoryDisplayName = repository => repository.name.includes('/') ? repository.name.slice(repository.name.indexOf('/') + 1) : repository.name;

export function publicationSummary(data) {
  const privateRepositories = data.repositories.filter(repository => repositoryVisibility(repository) === 'private').length;
  const publication = data.publication ?? {};
  const privateUpdatedAt = Number.isFinite(instant(publication.privateUpdatedAt)) ? publication.privateUpdatedAt : null;
  return {
    publicRepositories: data.repositories.length - privateRepositories,
    privateRepositories,
    privateUpdatedAt,
    privateStatus: publication.privateStatus ?? (privateRepositories ? 'stale' : 'not-configured'),
    privateSource: publication.privateSource ?? null,
  };
}

export function selectRepositories(data, { mode = 'current', ids, includeStale = false, scope = 'all' } = {}) {
  const statuses = new Set(['active', 'archived']);
  if (mode === 'archive') statuses.add('cold');
  if (includeStale) { statuses.add('stale'); statuses.add('inaccessible'); }
  const selected = ids === undefined ? null : new Set(ids);
  return data.repositories.filter(repository => (scope === 'all' || repositoryVisibility(repository) === scope) && repository.rulesVersion === data.rules.version && statuses.has(repository.status) && repository.history.length > 0 && (!selected || selected.has(repository.id)));
}

export function latestTotals(repositories, language = 'all') {
  const total = emptyMetrics();
  for (const repository of repositories) {
    const metrics = snapshotMetrics(sortedHistory(repository).at(-1), language);
    for (const metric of METRICS) total[metric] += numeric(metrics?.[metric]);
  }
  total.total = metricValue(total, 'total');
  return total;
}

export function languageTotals(repositories, metric = 'code', { key = 'value', direction = 'desc' } = {}) {
  const totals = new Map();
  for (const repository of repositories) {
    const snapshot = sortedHistory(repository).at(-1);
    for (const [name, metrics] of Object.entries(snapshot?.languages ?? {})) totals.set(name, (totals.get(name) ?? 0) + metricValue(metrics, metric));
  }
  return [...totals].map(([name, value]) => ({ name, value })).filter(language => language.value > 0).sort((a, b) => (key === 'name' ? a.name.localeCompare(b.name) : a.value - b.value) * (direction === 'desc' ? -1 : 1) || a.name.localeCompare(b.name));
}

export function stackedHistory(repositories, { language = 'all', metric = 'code', since, until } = {}) {
  const series = repositories.map(repository => ({ id: repository.id, name: repositoryDisplayName(repository) }));
  const events = repositories.flatMap((repository, repoIndex) => sortedHistory(repository).map(snapshot => ({ ...snapshot, repoIndex })));
  events.sort((a, b) => a.time - b.time || a.index - b.index);
  const points = [];
  if (!events.length) return { series, points };
  const start = since ? instant(since) : events[0].time;
  const end = until ? instant(until) : events.at(-1).time;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || events[0].time > end) return { series, points };
  const stocks = Array(repositories.length).fill(null);
  const emit = time => points.push({ timestamp: iso(time), value: stocks.reduce((sum, value) => sum + (value ?? 0), 0), values: [...stocks] });
  let index = 0;
  // 首次观测前保留 null；窗口起点只延续已经存在的存量，不假造新增。
  while (index < events.length && events[index].time < start) {
    const event = events[index++];
    stocks[event.repoIndex] = metricValue(snapshotMetrics(event, language), metric);
  }
  if (index > 0 && (index === events.length || events[index].time > start)) emit(start);
  while (index < events.length && events[index].time <= end) {
    const time = events[index].time;
    // 同刻快照全部更新后再发出观察点，避免并不存在的中间总量。
    while (index < events.length && events[index].time === time) {
      const event = events[index++];
      stocks[event.repoIndex] = metricValue(snapshotMetrics(event, language), metric);
    }
    emit(time);
  }
  if (points.length && instant(points.at(-1).timestamp) < end) emit(end);
  return { series, points };
}

export function aggregateHistory(repositories, options = {}) {
  return stackedHistory(repositories, options).points.map(({timestamp, value}) => ({timestamp, value}));
}

export async function loadStats(fetcher = fetch) {
  const response = await fetcher('./data/stats.json', { cache: 'no-cache' });
  if (!response.ok) throw new Error(`无法读取统计数据（HTTP ${response.status}）`);
  const data = await response.json();
  if (data?.schemaVersion !== 1) throw new Error('统计数据版本暂不受支持，请更新看板。');
  const validMetrics = metrics => metrics && METRICS.every(metric => Number.isFinite(metrics[metric]) && metrics[metric] >= 0);
  const validPrivate = repository => repositoryVisibility(repository) !== 'private' || (
    repository.url === null && repository.branch === null && repository.head === null && repository.snapshotKind === 'daily'
    && repository.history.every(snapshot => !['sha', 'committedAt', 'authoredAt'].some(key => key in snapshot))
  );
  if (!Number.isFinite(instant(data.generatedAt)) || !data.rules?.version || !Array.isArray(data.repositories) || !data.repositories.every(repository => typeof repository.id === 'string' && typeof repository.name === 'string' && typeof repository.status === 'string' && Array.isArray(repository.history) && repository.history.every(snapshot => Number.isFinite(instant(snapshot.timestamp)) && validMetrics(snapshot.metrics) && snapshot.languages && Object.values(snapshot.languages).every(validMetrics)) && validPrivate(repository))) throw new Error('统计数据结构不完整或存在无效数值。');
  return data;
}

export function sortRepositories(repositories, { key = 'name', direction = 'asc', metric = 'code', language = 'all' } = {}) {
  const compareNames = (a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }) || a.id.localeCompare(b.id);
  const value = repository => {
    if (key === 'metric') return repository.history.length ? latestTotals([repository], language)[metric] : null;
    if (key === 'total' || METRICS.includes(key)) return repository.history.length ? latestTotals([repository], language)[key] : null;
    if (key === 'updated') return Number.isFinite(instant(repository.lastSuccessAt)) ? instant(repository.lastSuccessAt) : null;
    if (key === 'status') return STATUS_LABELS[repository.status] ?? repository.status;
    if (key === 'rules') return repository.rulesVersion || null;
    return repository.name;
  };
  return [...repositories].sort((a, b) => {
    const left = value(a), right = value(b);
    if (left === null || right === null) return left === right ? compareNames(a, b) : left === null ? 1 : -1;
    const result = typeof left === 'number' ? left - right : String(left).localeCompare(String(right), 'zh-CN', { numeric: true, sensitivity: 'base' });
    return result * (direction === 'desc' ? -1 : 1) || compareNames(a, b);
  });
}

export function repositoryOptions(repositories, { query = '', ...sorting } = {}) {
  const search = query.trim().toLocaleLowerCase();
  return sortRepositories(repositories.filter(repository => repository.name.toLocaleLowerCase().includes(search)), sorting);
}

export function stockChange(repositories, { since, until, language = 'all', metric = 'code' } = {}) {
  let baseline = 0, latest = 0, missing = 0;
  const start = instant(since), end = instant(until);
  for (const repository of repositories) {
    const history = sortedHistory(repository).filter(snapshot => snapshot.time <= end);
    const before = history.filter(snapshot => snapshot.time <= start).at(-1);
    if (!before) missing++;
    else baseline += metricValue(snapshotMetrics(before, language), metric);
    latest += metricValue(snapshotMetrics(history.at(-1), language), metric);
  }
  // 首次采集前没有事实基线：首次看到的存量不能被解释成期间新增。
  if (!repositories.length || missing) return { baseline: null, latest, change: null, missing };
  return { baseline, latest, change: latest - baseline, missing: 0 };
}
