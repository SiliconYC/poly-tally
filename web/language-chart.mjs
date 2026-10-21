import {element, svgElement, colorDot, format, compact} from './chart-utils.mjs';

const knownColors = {Python: '#5c8dd3', JavaScript: '#d9ae57', TypeScript: '#8179c8', TSX: '#9684c7', Rust: '#ce8c68', Go: '#60acb6', Markdown: '#94a8be', HTML: '#d58591', CSS: '#b09acb', JSON: '#6cab9c', QML: '#a0b56f'};
function languageColor(name) {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return knownColors[name] ?? `hsl(${hash % 360} 38% 62%)`;
}
export function pieSlices(languages) {
  const total = languages.reduce((sum, item) => sum + item.value, 0);
  let position = 0;
  return languages.filter(item => item.value > 0).map(item => {
    const start = position;
    position += item.value / total;
    return {...item, start, end: position};
  });
}
function sectorPath(start, end) {
  const point = (turn, radius) => [160 + Math.sin(turn * Math.PI * 2) * radius, 160 - Math.cos(turn * Math.PI * 2) * radius].join(',');
  // 整圆需要拆成两段弧；起终点相同的一段 SVG 弧不会绘制。
  const middle = (start + end) / 2;
  return `M${point(start, 135)}A135,135 0 0 1 ${point(middle, 135)}A135,135 0 0 1 ${point(end, 135)}L${point(end, 87)}A87,87 0 0 0 ${point(middle, 87)}A87,87 0 0 0 ${point(start, 87)}Z`;
}
export function renderLanguageChart({container, list, languages, label, onSelect}) {
  container.replaceChildren(); list.replaceChildren();
  const total = languages.reduce((sum, language) => sum + language.value, 0);
  if (!total) {
    container.append(element('div', 'pie-empty', '暂无语言数据'));
    list.append(element('p', 'inline-empty', '当前筛选下暂无语言数据。')); return;
  }
  const svg = svgElement('svg', {viewBox: '0 0 320 320', 'aria-label': `${label}语言构成饼图，合计 ${format(total)}。可聚焦扇区或语言行，回车筛选。`});
  const centerLabel = svgElement('text', {x: 160, y: 143, 'text-anchor': 'middle', class: 'pie-center-label'}, '全部语言');
  const centerValue = svgElement('text', {x: 160, y: 177, 'text-anchor': 'middle', class: 'pie-center-value'}, compact(total));
  const centerShare = svgElement('text', {x: 160, y: 201, 'text-anchor': 'middle', class: 'pie-center-share'}, label);
  const slices = pieSlices(languages);
  const paths = new Map(), rows = new Map();
  const percentage = value => value / total * 100 < .1 ? '<0.1%' : `${(value / total * 100).toFixed(1)}%`;
  const highlight = name => {
    const item = languages.find(item => item.name === name);
    centerLabel.textContent = item?.name ?? '全部语言'; centerValue.textContent = compact(item?.value ?? total); centerShare.textContent = item ? `${percentage(item.value)} · ${label}` : label;
    for (const [key, path] of paths) path.style.opacity = !item || key === name ? '1' : '.27';
    for (const [key, row] of rows) row.classList.toggle('highlighted', key === name);
  };
  for (const item of slices) {
    const color = languageColor(item.name);
    const path = svgElement('path', {d: sectorPath(item.start, item.end), fill: color, stroke: '#fff', 'stroke-width': slices.length > 1 ? 1.2 : 0, tabindex: 0, role: 'button', 'aria-label': `${item.name}，${format(item.value)} ${label}，${percentage(item.value)}。点击筛选。`, class: 'pie-sector'});
    path.append(svgElement('title', {}, `${item.name} · ${format(item.value)} ${label} · ${percentage(item.value)}`));
    paths.set(item.name, path); svg.append(path);
    const row = element('button', 'language-row'); row.type = 'button';
    row.setAttribute('aria-label', `${item.name}，${format(item.value)} ${label}，${percentage(item.value)}。点击筛选。`);
    const name = element('span', 'language-name', item.name);
    const text = element('span', 'language-count', format(item.value));
    const share = element('span', 'language-percent', percentage(item.value));
    row.append(colorDot(color), name, text, share);
    const bar = element('span', 'language-share'); bar.style.width = `${item.value / total * 100}%`; bar.style.backgroundColor = color; row.append(bar);
    rows.set(item.name, row); list.append(row);
    for (const node of [path, row]) {
      node.addEventListener('pointerenter', () => highlight(item.name));
      node.addEventListener('pointerleave', () => highlight(null));
      node.addEventListener('focus', () => highlight(item.name));
      node.addEventListener('blur', () => highlight(null));
      node.addEventListener('click', () => onSelect(item.name));
    }
    path.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(item.name); }
    });
  }
  const center = svgElement('g', {'pointer-events': 'none'}); center.append(centerLabel, centerValue, centerShare); svg.append(center); container.append(svg);
}
