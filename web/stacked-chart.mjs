import {stackedHistory} from './model.mjs';
import {element, svgElement, colorDot, format, compact, maximumStock, dayLabel, dateLabel} from './chart-utils.mjs';

export function renderStackedChart({container, navigator, legend, details, rangeLabel, repositories, colors, metric, label, language, since, until, view, onRangeChange}) {
  const restoreLegendFocus = legend.contains(document.activeElement);
  const focusedRepository = restoreLegendFocus ? document.activeElement.dataset.repositoryId : null;
  const visible = repositories.filter(repository => !view.hidden.has(repository.id));
  const full = stackedHistory(visible, {metric, language, since, until});
  const first = full.points[0]?.timestamp, last = full.points.at(-1)?.timestamp;
  const start = first && view.range ? Math.max(Date.parse(first), view.range[0]) : Date.parse(first);
  const end = last && view.range ? Math.min(Date.parse(last), view.range[1]) : Date.parse(last);
  const result = view.range && start <= end ? stackedHistory(visible, {metric, language, since: new Date(start).toISOString(), until: new Date(end).toISOString()}) : full;
  const {series, points} = result;
  const rerender = () => renderStackedChart({container, navigator, legend, details, rangeLabel, repositories, colors, metric, label, language, since, until, view, onRangeChange});
  container.replaceChildren(); legend.replaceChildren(); details.replaceChildren(); navigator.replaceChildren();
  rangeLabel.textContent = points.length ? `${dayLabel(points[0].timestamp)} — ${dayLabel(points.at(-1).timestamp)} · UTC` : 'UTC';
  for (const repository of repositories) {
    const button = element('button', 'series-toggle', repository.name.includes('/') ? repository.name.split('/').slice(1).join('/') : repository.name);
    button.dataset.repositoryId = repository.id;
    button.prepend(colorDot(colors.get(repository.id)));
    button.setAttribute('aria-pressed', String(!view.hidden.has(repository.id)));
    button.title = '点击显示或隐藏此仓库；Shift 点击只看此仓库（只影响趋势图）';
    button.addEventListener('click', event => {
      if (event.shiftKey) { view.hidden = new Set(repositories.filter(r => r.id !== repository.id).map(r => r.id)); rerender(); return; }
      if (view.hidden.has(repository.id)) view.hidden.delete(repository.id); else view.hidden.add(repository.id);
      rerender();
    });
    legend.append(button);
  }
  if (view.hidden.size) {
    const restore = element('button', 'text-button', '全部显示');
    restore.addEventListener('click', () => { view.hidden.clear(); rerender(); }); legend.append(restore);
  }
  if (restoreLegendFocus) {
    const buttons = [...legend.querySelectorAll('button')];
    (buttons.find(button => button.dataset.repositoryId === focusedRepository) ?? buttons[0])?.focus({preventScroll: true});
  }
  if (!points.length) {
    const empty = element('div', 'chart-empty');
    empty.append(element('strong', '', !visible.length && repositories.length ? '所有仓库图层均已隐藏' : '这个范围还没有可用快照'), element('span', '', '选择仓库或点击图例恢复图层，调整筛选后查看趋势。'));
    container.append(empty); return;
  }
  const width = Math.max(280, container.clientWidth), height = container.clientHeight;
  const left = width < 480 ? 42 : 58, right = 16, top = 24, bottom = 32;
  const min = Date.parse(points[0].timestamp), max = Date.parse(points.at(-1).timestamp), span = max - min || 86400000;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const maximum = view.percent ? 100 : niceMaximum(maximumStock(points));
  const x = timestamp => left + (Date.parse(timestamp) - min) / span * plotWidth;
  const y = value => height - bottom - value / maximum * plotHeight;
  const svg = svgElement('svg', {viewBox: `0 0 ${width} ${height}`, tabindex: 0, role: 'img', 'aria-label': `${label}按仓库堆叠面积图。${series.length} 个仓库。左右方向键查看快照，Home、End 跳到首尾，Escape 返回最新。`, 'aria-describedby': 'snapshot-heading'});
  for (let i = 0; i <= 4; i++) {
    const value = maximum * i / 4;
    svg.append(svgElement('line', {x1: left, x2: width - right, y1: y(value), y2: y(value), class: 'chart-grid'}), svgElement('text', {x: left - 10, y: y(value) + 3, 'text-anchor': 'end', class: 'chart-tick'}, view.percent ? `${value}%` : compact(value)));
  }
  const layers = stackLayers(points, series.length, view.percent);
  const paths = [];
  for (const [index, seriesItem] of series.entries()) {
    const layer = layers[index];
    let d = `M${x(points[0].timestamp)},${y(layer.upper[0])}`;
    for (let i = 1; i < points.length; i++) d += `H${x(points[i].timestamp)}V${y(layer.upper[i])}`;
    if (points.length === 1) d += `H${width - right}V${y(layer.lower[0])}H${left}`;
    else {
      d += `L${x(points.at(-1).timestamp)},${y(layer.lower.at(-1))}`;
      for (let i = points.length - 1; i > 0; i--) d += `V${y(layer.lower[i - 1])}H${x(points[i - 1].timestamp)}`;
    }
    const path = svgElement('path', {d: `${d}Z`, fill: colors.get(seriesItem.id), 'fill-opacity': .82, stroke: colors.get(seriesItem.id), 'stroke-width': .7, class: 'stack-layer', 'data-series': seriesItem.id});
    svg.append(path); paths.push(path);
    path.addEventListener('pointerenter', () => paths.forEach(p => p.style.opacity = p === path ? '1' : '.4'));
    path.addEventListener('pointerleave', () => paths.forEach(p => p.style.opacity = '1'));
  }
  const ticks = max === min ? 1 : width < 480 ? 3 : 6;
  for (let i = 0; i < ticks; i++) {
    const time = min + (ticks === 1 ? 0 : span * i / (ticks - 1));
    const text = span > 370 * 86400000 ? dayLabel(time).slice(0, 7) : dayLabel(time).slice(5);
    svg.append(svgElement('text', {x: left + (ticks === 1 ? 0 : plotWidth * i / (ticks - 1)), y: height - 9, 'text-anchor': i === 0 ? 'start' : i === ticks - 1 ? 'end' : 'middle', class: 'chart-tick'}, text));
  }
  const cursor = svgElement('line', {y1: top, y2: height - bottom, class: 'chart-cursor', visibility: 'hidden', 'pointer-events': 'none'});
  svg.append(cursor);
  const tooltip = element('div', 'chart-tooltip stack-tooltip'); tooltip.hidden = true;
  container.append(svg, tooltip);
  let active = points.length - 1, pinned = false;
  function showPoint(index, showTooltip = true) {
    active = Math.max(0, Math.min(points.length - 1, index));
    const point = points[active];
    const cx = x(point.timestamp);
    cursor.setAttribute('x1', cx); cursor.setAttribute('x2', cx); cursor.setAttribute('visibility', showTooltip ? 'visible' : 'hidden');
    details.replaceChildren();
    const heading = element('div', 'snapshot-heading'); heading.id = 'snapshot-heading';
    heading.append(element('span', '', `${dateLabel(point.timestamp)} UTC${pinned ? ' · 已固定' : ''}`), element('strong', '', `可见合计 ${format(point.value)} ${label}`));
    const rows = series.map((item, i) => ({...item, value: point.values[i]})).sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
    const list = element('div', 'snapshot-list');
    for (const item of rows) {
      const row = element('div', 'snapshot-row');
      row.append(colorDot(colors.get(item.id)), element('span', 'snapshot-name', item.name), element('strong', '', item.value === null ? '未观测' : format(item.value)), element('span', 'snapshot-percent', item.value === null || !point.value ? '—' : `${(item.value / point.value * 100).toFixed(1)}%`));
      list.append(row);
    }
    details.append(heading, list);
    tooltip.replaceChildren(element('span', '', `${dateLabel(point.timestamp)} UTC`), element('strong', '', `${format(point.value)} ${label}`));
    for (const item of rows.slice(0, 5)) {
      const row = element('div', 'tooltip-row'); row.append(colorDot(colors.get(item.id)), element('span', '', item.name), element('b', '', item.value === null ? '未观测' : format(item.value))); tooltip.append(row);
    }
    if (rows.length > 5) tooltip.append(element('small', '', `其余 ${rows.length - 5} 个仓库见下方快照明细`));
    tooltip.hidden = !showTooltip;
    tooltip.style.left = `${Math.max(0, Math.min(width - tooltip.offsetWidth, cx + 16 + tooltip.offsetWidth > width ? cx - tooltip.offsetWidth - 12 : cx + 12))}px`;
    tooltip.style.top = '12px';
  }
  function pointAt(event) {
    const rect = svg.getBoundingClientRect();
    const time = min + Math.max(0, Math.min(1, ((event.clientX - rect.left) / rect.width * width - left) / plotWidth)) * span;
    let low = 0, high = points.length - 1;
    while (low < high) { const middle = Math.ceil((low + high) / 2); if (Date.parse(points[middle].timestamp) <= time) low = middle; else high = middle - 1; }
    return low;
  }
  svg.addEventListener('pointermove', event => { if (!pinned) showPoint(pointAt(event)); });
  svg.addEventListener('pointerleave', () => { if (!pinned && document.activeElement !== svg) showPoint(points.length - 1, false); });
  svg.addEventListener('click', event => { pinned = !pinned; showPoint(pointAt(event)); });
  svg.addEventListener('dblclick', () => { view.range = null; onRangeChange?.(); rerender(); });
  svg.addEventListener('focus', () => showPoint(active));
  svg.addEventListener('blur', () => { if (!pinned) showPoint(points.length - 1, false); });
  svg.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return;
    event.preventDefault(); pinned = event.key !== 'Escape';
    showPoint(event.key === 'Home' ? 0 : ['End', 'Escape'].includes(event.key) ? points.length - 1 : active + (event.key === 'ArrowRight' ? 1 : -1), event.key !== 'Escape');
  });
  showPoint(active, false);
  renderNavigator({navigator, points: full.points, range: [Date.parse(points[0].timestamp), Date.parse(points.at(-1).timestamp)], onChange: range => { view.range = range; onRangeChange?.(); rerender(); }});
}

export function stackLayers(points, count, percent = false) {
  const totals = Array(points.length).fill(0);
  return Array.from({length: count}, (_, index) => {
    const lower = [...totals];
    const upper = points.map((point, i) => totals[i] += percent ? point.value ? (point.values[index] ?? 0) / point.value * 100 : 0 : point.values[index] ?? 0);
    return {lower, upper};
  });
}

function niceMaximum(value) {
  const unit = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / unit / .5) * unit * .5;
}

function renderNavigator({navigator, points, range, onChange}) {
  if (points.length < 2) return;
  const min = Date.parse(points[0].timestamp), max = Date.parse(points.at(-1).timestamp), span = max - min;
  if (!span) return;
  const box = element('div', 'navigator-plot');
  const svg = svgElement('svg', {viewBox: '0 0 1000 52', preserveAspectRatio: 'none', 'aria-hidden': 'true'});
  const maximum = maximumStock(points);
  let d = `M0,52V${50 - points[0].value / maximum * 44}`;
  for (const point of points.slice(1)) d += `H${(Date.parse(point.timestamp) - min) / span * 1000}V${50 - point.value / maximum * 44}`;
  d += 'V52H0Z'; svg.append(svgElement('path', {d, fill: '#bacbe7'})); box.append(svg);
  const window = element('div', 'navigator-window');
  const start = element('button', 'navigator-handle start'), end = element('button', 'navigator-handle end');
  start.setAttribute('aria-label', '拖动时间范围起点（键盘请使用下方日期输入）'); end.setAttribute('aria-label', '拖动时间范围终点（键盘请使用下方日期输入）');
  window.append(start, end); box.append(window);
  const controls = element('div', 'navigator-controls');
  const dates = range.map((time, i) => {
    const label = element('label', '', i ? '结束' : '开始');
    const input = element('input'); input.type = 'date'; input.value = dayLabel(time); input.min = dayLabel(min); input.max = dayLabel(max);
    input.setAttribute('aria-label', i ? '时间范围结束日期 UTC' : '时间范围开始日期 UTC');
    input.addEventListener('change', () => {
      if (!input.value || !input.validity.valid) return;
      const date = Date.parse(`${input.value}T${i ? '23:59:59.999' : '00:00:00'}Z`);
      const next = [...range]; next[i] = Math.max(min, Math.min(max, date));
      if (next[0] <= next[1]) onChange(next); else input.value = dayLabel(range[i]);
    });
    label.append(input); controls.append(label); return input;
  });
  const reset = element('button', 'text-button', '重置缩放'); reset.addEventListener('click', () => onChange(null));
  controls.append(element('span', 'navigator-hint', '拖动手柄或窗口缩放 · 双击图表重置'), reset);
  navigator.append(box, controls);
  let current = [...range], drag;
  const draw = () => { window.style.left = `${(current[0] - min) / span * 100}%`; window.style.width = `${(current[1] - current[0]) / span * 100}%`; dates.forEach((input, i) => input.value = dayLabel(current[i])); };
  draw();
  box.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag = {x: event.clientX, range: [...current], mode: event.target === start ? 0 : event.target === end ? 1 : window.contains(event.target) ? 2 : 3};
    box.setPointerCapture(event.pointerId);
  });
  box.addEventListener('pointermove', event => {
    if (!drag) return;
    const bounds = box.getBoundingClientRect(), delta = (event.clientX - drag.x) / bounds.width * span;
    const gap = Math.min(span, Math.max(1, span / 200));
    if (drag.mode === 0) current[0] = Math.max(min, Math.min(current[1] - gap, drag.range[0] + delta));
    else if (drag.mode === 1) current[1] = Math.min(max, Math.max(current[0] + gap, drag.range[1] + delta));
    else {
      const length = drag.range[1] - drag.range[0];
      const from = drag.mode === 3 ? min + (event.clientX - bounds.left) / bounds.width * span - length / 2 : drag.range[0] + delta;
      current[0] = Math.max(min, Math.min(max - length, from)); current[1] = current[0] + length;
    }
    draw();
  });
  box.addEventListener('pointerup', event => { if (!drag) return; drag = null; box.releasePointerCapture(event.pointerId); onChange(current); });
  box.addEventListener('pointercancel', () => { drag = null; current = [...range]; draw(); });
}
