import {latestTotals, repositoryDisplayName, repositoryVisibility, stockChange} from './model.mjs';

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

// UTC calendar buckets, with a strictly earlier opening stock and an inclusive
// end. A missing opening snapshot remains unknown, never an invented zero.
export function periodChanges(repositories, {period = 'month', since, until, metric = 'code', language = 'all', limit = 12} = {}) {
  if (!repositories.length || !['day', 'week', 'month'].includes(period) || !Number.isSafeInteger(limit) || limit < 1) return [];
  const end = Date.parse(until);
  const times = repositories.flatMap(repository => repository.history).map(snapshot => Date.parse(snapshot.timestamp)).filter(Number.isFinite);
  const from = since ? Date.parse(since) : times.reduce((first, time) => Math.min(first, time), Infinity);
  if (!Number.isFinite(from) || !Number.isFinite(end) || from > end) return [];
  const oldest = advancePeriod(periodStart(end, period), period, 1 - limit);
  let bucketStart = periodStart(Math.max(from, oldest), period);
  const result = [];
  while (bucketStart <= end) {
    const next = advancePeriod(bucketStart, period);
    const start = Math.max(bucketStart, from), finish = Math.min(end, next - 1);
    let change = 0, compared = 0;
    for (const repository of repositories) {
      const comparison = stockChange([repository], {since: new Date(start - 1).toISOString(), until: new Date(finish).toISOString(), metric, language});
      if (comparison.change !== null) { change += comparison.change; compared++; }
    }
    const key = new Date(bucketStart).toISOString().slice(0, period === 'month' ? 7 : 10);
    result.push({period, key, label: key, ...(period === 'month' ? {month: key} : {}), since: new Date(start).toISOString(), until: new Date(finish).toISOString(), change: compared ? change : null, compared, missing: repositories.length - compared, partial: start > bucketStart || finish < next - 1});
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
