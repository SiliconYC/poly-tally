import {latestTotals, metricValue, repositoryDisplayName, repositoryVisibility} from './model.mjs';

const DAY = 24 * 60 * 60 * 1000;
const periodStart = (time, period) => {
  const date = new Date(time);
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  if (period === 'month') return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  if (period === 'week') return day - ((date.getUTCDay() + 6) % 7) * DAY;
  return day;
};
const advancePeriod = (time, period, count = 1) => {
  if (period !== 'month') return time + count * DAY * (period === 'week' ? 7 : 1);
  const date = new Date(time);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1);
};

// Every period aggregates the SAME consecutive-snapshot deltas. The first
// observation of a repository is an unknown stock, never new code. A repository
// discovered mid-month can still contribute all of its subsequent changes.
// A displayBaseline restores exact-cutoff deltas without inventing changes at
// synthetic display boundaries.
const changeTimeline = (repository, metric, language) => {
  const source = repository.displayBaseline
    ? [repository.displayBaseline, ...repository.history]
    : repository.history;
  const observations = source.map((snapshot, index) => ({
    time: Date.parse(snapshot.timestamp), index,
    value: metricValue(language === 'all' ? snapshot.metrics : snapshot.languages?.[language], metric),
  })).filter(snapshot => Number.isFinite(snapshot.time))
    .sort((a, b) => a.time - b.time || a.index - b.index);
  return {
    first: observations[0]?.time ?? Infinity,
    events: observations.slice(1).map((snapshot, index) => ({
      time: snapshot.time,
      change: snapshot.value - observations[index].value,
    })),
  };
};

export function periodChanges(repositories, {period = 'month', since, until, metric = 'code', language = 'all', limit = 12} = {}) {
  if (!repositories.length || !['day', 'week', 'month'].includes(period) || !Number.isSafeInteger(limit) || limit < 1) return [];
  const end = Date.parse(until);
  const timelines = repositories.map(repository => changeTimeline(repository, metric, language));
  // A pre-window displayBaseline supports comparisons but must not extend the visible range.
  const visibleTimes = repositories.flatMap(repository => repository.history)
    .map(snapshot => Date.parse(snapshot.timestamp)).filter(Number.isFinite);
  const from = since ? Date.parse(since) : visibleTimes.reduce((first, time) => Math.min(first, time), Infinity);
  if (!Number.isFinite(from) || !Number.isFinite(end) || from > end) return [];
  const oldest = advancePeriod(periodStart(end, period), period, 1 - limit);
  let bucketStart = periodStart(Math.max(from, oldest), period);
  const changes = new Map();
  for (const timeline of timelines) {
    for (const event of timeline.events) {
      if (event.time < from || event.time > end) continue;
      const key = periodStart(event.time, period);
      if (key >= bucketStart) changes.set(key, (changes.get(key) ?? 0) + event.change);
    }
  }
  const result = [];
  while (bucketStart <= end) {
    const next = advancePeriod(bucketStart, period);
    const start = Math.max(bucketStart, from), finish = Math.min(end, next - 1);
    // An opening stock OR an actual pair inside this bucket establishes a
    // comparison. A single first observation on its own remains unknown.
    const compared = timelines.filter(timeline => timeline.first < start ||
      timeline.events.some(event => event.time >= start && event.time <= finish)).length;
    const key = new Date(bucketStart).toISOString().slice(0, period === 'month' ? 7 : 10);
    result.push({period, key, label: key, ...(period === 'month' ? {month: key} : {}), since: new Date(start).toISOString(), until: new Date(finish).toISOString(), change: compared ? (changes.get(bucketStart) ?? 0) : null, compared, missing: repositories.length - compared, partial: start > bucketStart || finish < next - 1});
    bucketStart = next;
  }
  return result;
}

export function monthlyChanges(repositories, options = {}) {
  return periodChanges(repositories, {...options, period: 'month'});
}

export function repositoryCsv(repositories, language = 'all') {
  const escape = value => {
    let text = String(value);
    if (/^[=+@\-\t\r\n]/.test(text)) text = "'" + text;
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const rows = [['仓库', '可见性', '语言', '总行数', '代码行', '注释行', '文档行', '空行', '文件数']];
  for (const repository of repositories) {
    const total = latestTotals([repository], language);
    rows.push([repositoryDisplayName(repository), repositoryVisibility(repository) === 'private' ? '私有' : '公开', language === 'all' ? '全部语言' : language, ...['total', 'code', 'comment', 'documentation', 'blank', 'files'].map(key => total[key])]);
  }
  return '\ufeff' + rows.map(row => row.map(escape).join(',')).join('\r\n') + '\r\n';
}
