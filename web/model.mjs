export const METRICS = ['code', 'comment', 'blank', 'documentation', 'files'];
export const METRIC_LABELS = { code: '代码行', comment: '注释行', blank: '空行', documentation: '文档行', files: '文件数' };
export const STATUS_LABELS = { active: '正常', archived: '已归档', empty: '空仓库', inaccessible: '不可访问', excluded: '已排除', cold: '冷数据', stale: '数据过期' };

const emptyMetrics = () => Object.fromEntries(METRICS.map(key => [key, 0]));
const numeric = value => Number.isFinite(value) && value >= 0 ? value : 0;
const instant = value => Date.parse(value);
const iso = time => new Date(time).toISOString().replace('.000Z', 'Z');
const sortedHistory = repository => repository.history.map((snapshot, index) => ({ ...snapshot, time: instant(snapshot.timestamp), index })).filter(snapshot => Number.isFinite(snapshot.time)).sort((a, b) => a.time - b.time || a.index - b.index);
const snapshotMetrics = (snapshot, language) => language === 'all' ? snapshot?.metrics : snapshot?.languages?.[language];

export const repositoryVisibility = repository => repository.visibility ?? 'public';

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
  return total;
}

export function languageTotals(repositories, metric = 'code') {
  const totals = new Map();
  for (const repository of repositories) {
    const snapshot = sortedHistory(repository).at(-1);
    for (const [name, metrics] of Object.entries(snapshot?.languages ?? {})) totals.set(name, (totals.get(name) ?? 0) + numeric(metrics[metric]));
  }
  return [...totals].map(([name, value]) => ({ name, value })).filter(language => language.value > 0).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
}

export function aggregateHistory(repositories, { language = 'all', metric = 'code', since, until } = {}) {
  const events = repositories.flatMap((repository, repoIndex) => sortedHistory(repository).map(snapshot => ({ ...snapshot, repoIndex })));
  events.sort((a, b) => a.time - b.time || a.index - b.index);
  if (!events.length) return [];
  const start = since ? instant(since) : events[0].time;
  const end = until ? instant(until) : events.at(-1).time;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || events[0].time > end) return [];
  const stocks = new Map();
  let total = 0;
  const points = [];
  let beforeWindow = false;
  for (let index = 0; index < events.length;) {
    const time = events[index].time;
    if (time > end) break;
    // 同刻快照先更新所有仓库，再发出一个观察点，避免显示并不存在的中间总量。
    while (index < events.length && events[index].time === time) {
      const event = events[index++];
      const value = numeric(snapshotMetrics(event, language)?.[metric]);
      total += value - (stocks.get(event.repoIndex) ?? 0);
      stocks.set(event.repoIndex, value);
    }
    if (time < start) beforeWindow = true;
    else {
      points.push({ timestamp: iso(time), value: total });
    }
  }
  if (beforeWindow && !points.some(point => instant(point.timestamp) === start)) {
    const baseline = latestTotals(repositories.map(repository => ({ ...repository, history: repository.history.filter(snapshot => instant(snapshot.timestamp) < start) })), language)[metric];
    points.unshift({ timestamp: iso(start), value: baseline });
  }
  if (points.length && instant(points.at(-1).timestamp) < end) points.push({ timestamp: iso(end), value: points.at(-1).value });
  return points;
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
