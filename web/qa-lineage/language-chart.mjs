import {element, svgElement, colorDot, format, compact} from './chart-utils.mjs';

const knownColors = {Python: '#438e7c', JavaScript: '#d9ae57', TypeScript: '#8179c8', TSX: '#9684c7', Rust: '#ce8c68', Go: '#60acb6', Markdown: '#94a8be', HTML: '#d58591', CSS: '#b09acb', JSON: '#c8ad79', QML: '#a0b56f'};
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
export function renderLanguageChart({container, list, languages, label, onSelect, dimension = 'language', colors}) {
  const byRepository = dimension === 'repository';
  const subject = dimension === 'repository' ? '仓库' : '语言';
  const action = dimension === 'repository' ? '复制仓库名称' : '筛选语言';
  const allLabel = `全部${subject}`;
  const itemKey = item => item.id ?? item.name;
  container.replaceChildren(); list.replaceChildren();
  const total = languages.reduce((sum, language) => sum + language.value, 0);
  if (!total) {
    container.append(element('div', 'pie-empty', `暂无${subject}数据`));
    list.append(element('p', 'inline-empty', `当前筛选下暂无${subject}数据。`)); return;
  }
  const svg = svgElement('svg', {viewBox: '0 0 320 320', 'aria-label': `${label}${subject}构成饼图，合计 ${format(total)}。可聚焦扇区查看详情${byRepository ? '，仓库名称按钮可复制名称' : '，回车筛选语言'}。`});
  const centerLabel = svgElement('text', {x: 160, y: 143, 'text-anchor': 'middle', class: 'pie-center-label'}, allLabel);
  const centerValue = svgElement('text', {x: 160, y: 177, 'text-anchor': 'middle', class: 'pie-center-value'}, compact(total));
  const centerShare = svgElement('text', {x: 160, y: 201, 'text-anchor': 'middle', class: 'pie-center-share'}, label);
  const slices = pieSlices(languages);
  const paths = new Map(), rows = new Map();
  const percentage = value => value / total * 100 < .1 ? '<0.1%' : `${(value / total * 100).toFixed(1)}%`;
  const highlight = key => {
    const item = languages.find(item => itemKey(item) === key);
    centerLabel.textContent = item ? (item.name.length > 13 ? item.name.slice(0, 12) + '…' : item.name) : allLabel; centerValue.textContent = compact(item?.value ?? total); centerShare.textContent = item ? `${percentage(item.value)} · ${label}` : label;
    for (const [id, path] of paths) path.style.opacity = !item || id === key ? '1' : '.27';
    for (const [id, row] of rows) row.classList.toggle('highlighted', id === key);
  };
  for (const item of slices) {
    const key = itemKey(item);
    const color = colors?.get(key) ?? languageColor(item.name);
    const path = svgElement('path', {d: sectorPath(item.start, item.end), fill: color, stroke: '#fff', 'stroke-width': slices.length > 1 ? 1.2 : 0, tabindex: 0, role: byRepository ? 'img' : 'button', 'aria-label': `${item.name}，${format(item.value)} ${label}，${percentage(item.value)}${byRepository ? '。' : '。点击筛选语言。'}`, class: byRepository ? 'pie-sector repository-sector' : 'pie-sector'});
    path.append(svgElement('title', {}, `${item.name} · ${format(item.value)} ${label} · ${percentage(item.value)}`));
    paths.set(key, path); svg.append(path);
    const row = element(byRepository ? 'div' : 'button', 'language-row');
    if (!byRepository) row.type = 'button';
    if (!byRepository) row.setAttribute('aria-label', `${item.name}，${format(item.value)} ${label}，${percentage(item.value)}。点击${action}。`);
    const name = element(byRepository ? 'button' : 'span', byRepository ? 'language-name composition-copy' : 'language-name', item.name); name.title = byRepository ? `复制 ${item.fullName ?? item.name}` : item.name;
    if (byRepository) { name.type = 'button'; name.setAttribute('aria-label', `复制完整仓库名称 ${item.fullName ?? item.name}`); name.addEventListener('click', () => onSelect(item.name, item)); }
    const text = element('span', 'language-count', format(item.value));
    const share = element('span', 'language-percent', percentage(item.value));
    row.append(colorDot(color), name, text, share);
    const bar = element('span', 'language-share'); bar.style.width = `${item.value / total * 100}%`; bar.style.backgroundColor = color; row.append(bar);
    rows.set(key, row); list.append(row);
    for (const node of [path, row, ...(byRepository ? [name] : [])]) {
      node.addEventListener('pointerenter', () => highlight(key));
      node.addEventListener('pointerleave', () => highlight(null));
      node.addEventListener('focus', () => highlight(key));
      node.addEventListener('blur', () => highlight(null));
      if (!byRepository) node.addEventListener('click', () => onSelect(item.name, item));
    }
    if (!byRepository) path.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(item.name, item); }
    });
  }
  const center = svgElement('g', {'pointer-events': 'none'}); center.append(centerLabel, centerValue, centerShare); svg.append(center); container.append(svg);
}
