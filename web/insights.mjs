import {latestTotals, repositoryDisplayName, repositoryVisibility, stockChange} from './model.mjs';
import {element, svgElement, compact, format, dateLabel} from './chart-utils.mjs';

export function monthlyChanges(repositories, {since, until, metric = 'code', language = 'all', limit = 12} = {}) {
  if (!repositories.length) return [];
  const end = Date.parse(until);
  const first = repositories.flatMap(repository => repository.history).reduce((time, snapshot) => Math.min(time, Date.parse(snapshot.timestamp)), Infinity);
  const from = since ? Date.parse(since) : first;
  if (!Number.isFinite(from) || !Number.isFinite(end) || from > end) return [];
  const lastDate = new Date(end);
  const oldest = Date.UTC(lastDate.getUTCFullYear(), lastDate.getUTCMonth() - limit + 1, 1);
  let date = new Date(Math.max(from, oldest));
  let monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const result = [];
  while (monthStart <= end) {
    date = new Date(monthStart);
    const nextMonth = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    const start = Math.max(monthStart, from), finish = Math.min(end, nextMonth - 1);
    let change = 0, compared = 0;
    for (const repository of repositories) {
      const comparison = stockChange([repository], {since: new Date(start - 1).toISOString(), until: new Date(finish).toISOString(), metric, language});
      if (comparison.change !== null) { change += comparison.change; compared++; }
    }
    result.push({month: date.toISOString().slice(0, 7), since: new Date(start).toISOString(), until: new Date(finish).toISOString(), change: compared ? change : null, compared, missing: repositories.length - compared, partial: start > monthStart || finish < nextMonth - 1});
    monthStart = nextMonth;
  }
  return result;
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

// Keep the latest month visible without crowding it with the previous label.
export function monthLabelIndices(count, stride) {
  if (count <= 0) return [];
  const step = Math.max(1, Math.ceil(75 / Math.max(1, stride)));
  return Array.from({length: count}, (_, index) => index).filter(index => index === count - 1 || (index % step === 0 && count - 1 - index >= step));
}

export function renderMonthlyChanges({container, details, months, label, onSelect}) {
  container.replaceChildren(); details.replaceChildren();
  if (!months.length) { container.append(element('p', 'chart-empty', '当前范围没有可用历史')); return; }
  const width = Math.max(280, container.clientWidth), height = 210, left = 48, right = 12, top = 18, bottom = 30;
  const maxPositive = Math.max(...months.map(month => month.change ?? 0), 0), minNegative = Math.min(...months.map(month => month.change ?? 0), 0);
  const span = maxPositive - minNegative || 1;
  const upper = maxPositive + span * .15, lower = minNegative - span * .15;
  const y = value => top + (upper - value) / (upper - lower) * (height - top - bottom);
  const zero = y(0), stride = (width - left - right) / months.length, barWidth = Math.min(42, stride * .6);
  const svg = svgElement('svg', {viewBox: `0 0 ${width} ${height}`, 'aria-label': `${label}月度净变化；只比较有期初快照的仓库。`});
  for (const value of [...new Set([maxPositive, 0, minNegative])].filter(value => value === 0 || Math.abs(y(value) - zero) > 16)) {
    svg.append(svgElement('line', {x1:left, x2:width-right, y1:y(value), y2:y(value), class:value === 0 ? 'monthly-zero' : 'chart-grid'}), svgElement('text', {x:left-8, y:y(value)+3, 'text-anchor':'end', class:'chart-tick'}, compact(value)));
  }
  const show = month => {
    details.replaceChildren(element('strong', month.change < 0 ? 'negative' : '', `${month.month}${month.partial ? ' · 部分月份' : ''}　${month.change === null ? '暂无可比数据' : `${month.change > 0 ? '+' : ''}${format(month.change)} ${label}`}`), element('span', '', `${month.compared} 个可比仓库${month.missing ? ` · ${month.missing} 个缺少期初快照，未参与计算` : ' · 所选仓库均可比'} · ${dateLabel(month.since)} — ${dateLabel(month.until)} UTC`));
  };
  const labelIndices = new Set(monthLabelIndices(months.length, stride));
  months.forEach((month, index) => {
    const x = left + stride * (index + .5);
    const bar = svgElement('rect', {x: x - barWidth / 2, y: month.change === null ? zero - 2 : Math.min(zero, y(month.change)), width:barWidth, height:month.change === null || month.change === 0 ? 3 : Math.abs(y(month.change) - zero), rx:2, fill:month.change === null ? '#cbd3c6' : month.change < 0 ? '#c58b81' : '#66a08c', tabindex:0, role:'button', class:'monthly-bar', 'aria-label': `${month.month}，${month.change === null ? '暂无可比数据' : `${month.change} ${label}`}，${month.compared} 个可比仓库，${month.missing} 个缺少期初。点击缩放趋势图。`});
    bar.addEventListener('pointerenter', () => show(month)); bar.addEventListener('focus', () => show(month));
    bar.addEventListener('click', () => onSelect(month));
    bar.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(month); } });
    bar.append(svgElement('title', {}, `${month.month} · ${month.change === null ? '无可比数据' : `${month.change > 0 ? '+' : ''}${format(month.change)} ${label}`} · ${month.compared} 个可比仓库`));
    svg.append(bar);
    if (labelIndices.has(index)) svg.append(svgElement('text', {x, y:height-9, 'text-anchor':'middle', class:'chart-tick'}, month.month));
  });
  container.append(svg); show(months.at(-1));
}
