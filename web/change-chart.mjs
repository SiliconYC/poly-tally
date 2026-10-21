import {element, svgElement, compact, format, dateLabel} from './chart-utils.mjs';

export function periodLabelIndices(count, stride) {
  if (!count) return [];
  const step = Math.max(1, Math.ceil(58 / Math.max(1, stride)));
  return Array.from({length:count}, (_, index) => index).filter(index => index === count - 1 || (index % step === 0 && count - 1 - index >= step));
}

export function changeGeometry(periods, width = 440) {
  const height = 210, left = 48, right = 12, top = 18, bottom = 30;
  const positive = Math.max(0, ...periods.map(item => item.change ?? 0));
  const negative = Math.min(0, ...periods.map(item => item.change ?? 0));
  const span = positive - negative || 1;
  const upper = positive + span * .15, lower = negative - span * .15;
  const y = value => top + (upper - value) / (upper - lower) * (height - top - bottom);
  const zero = y(0), stride = (width - left - right) / Math.max(1, periods.length);
  const barWidth = Math.min(42, stride * .6);
  const bars = periods.map((item, index) => ({x:left + stride * (index + .5), y:Math.min(zero, y(item.change ?? 0)), height:Math.abs(y(item.change ?? 0) - zero), unknown:item.change === null}));
  return {width, height, left, right, top, bottom, positive, negative, zero, stride, barWidth, bars, y};
}

export function periodDescription(period, label) {
  const value = period.change === null ? '暂无可比数据' : `${period.change < 0 ? '−' : period.change > 0 ? '+' : ''}${format(Math.abs(period.change))} ${label}`;
  const note = [period.partial ? '非完整周期' : '', period.missing ? `${period.missing} 个仓库缺少期初` : ''].filter(Boolean).join(' · ');
  return {summary:`${period.label}　${value}`, note, context:`${period.compared} 个可比仓库 · ${dateLabel(period.since)} — ${dateLabel(period.until)} UTC${note ? ` · ${note}` : ''}`};
}

export function renderPeriodChanges({container, details, periods, label, onSelect}) {
  container.replaceChildren(); details.replaceChildren(); details.title = '';
  if (!periods.length) { container.append(element('p', 'chart-empty', '当前范围没有可用历史')); return; }
  const geometry = changeGeometry(periods, Math.max(280, container.clientWidth));
  const {width, height, left, right, positive, negative, zero, stride, barWidth, bars, y} = geometry;
  const periodName = {day:'每日', week:'每周', month:'每月'}[periods[0].period] ?? '';
  const svg = svgElement('svg', {viewBox:`0 0 ${width} ${height}`, 'aria-label':`${label}${periodName}净变化，零线以上为增加，以下为减少；只比较有期初快照的仓库。`});
  for (const value of [...new Set([positive, 0, negative])].filter(value => value === 0 || Math.abs(y(value) - zero) > 16)) {
    svg.append(svgElement('line', {x1:left, x2:width-right, y1:y(value), y2:y(value), class:value === 0 ? 'monthly-zero' : 'chart-grid'}), svgElement('text', {x:left-8, y:y(value)+3, 'text-anchor':'end', class:'chart-tick'}, compact(value)));
  }
  const show = period => {
    const description = periodDescription(period, label);
    const summary = element('strong', period.change < 0 ? 'negative' : '', description.summary);
    details.title = description.context;
    details.replaceChildren(summary);
    if (description.note) details.append(element('span', '', description.note));
    details.append(element('span', 'sr-only', description.context));
  };
  const labelIndices = new Set(periodLabelIndices(periods.length, stride));
  periods.forEach((period, index) => {
    const geometry = bars[index], description = periodDescription(period, label);
    const group = svgElement('g', {tabindex:0, role:'button', class:'monthly-bar', 'aria-label':`${description.summary}，${description.context}。点击缩放趋势图。`});
    // Separate hit regions from truthful bar lengths; never overlap adjacent date buckets.
    group.append(svgElement('rect', {x:geometry.x - Math.min(stride, Math.max(24, barWidth))/2, y:18, width:Math.min(stride, Math.max(24, barWidth)), height:height-48, fill:'transparent'}));
    if (geometry.height) group.append(svgElement('rect', {x:geometry.x-barWidth/2, y:geometry.y, width:barWidth, height:geometry.height, rx:2, fill:period.change < 0 ? '#c58b81' : '#66a08c'}));
    else group.append(svgElement('line', {x1:geometry.x-barWidth/2, x2:geometry.x+barWidth/2, y1:zero, y2:zero, stroke:geometry.unknown ? '#9fa99a' : '#66a08c', 'stroke-width':2, 'stroke-dasharray':geometry.unknown ? '2 2' : 'none'}));
    group.addEventListener('pointerenter', () => show(period)); group.addEventListener('focus', () => show(period));
    group.addEventListener('click', () => onSelect(period));
    group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(period); } });
    group.append(svgElement('title', {}, `${description.summary} · ${description.context}`));
    svg.append(group);
    if (labelIndices.has(index)) svg.append(svgElement('text', {x:geometry.x, y:height-9, 'text-anchor':'middle', class:'chart-tick'}, period.period === 'month' ? period.label : period.label.slice(5)));
  });
  container.append(svg); show(periods.at(-1));
}
