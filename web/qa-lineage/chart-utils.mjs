export const format = number => new Intl.NumberFormat('zh-CN').format(number);
export const compact = number => new Intl.NumberFormat('zh-CN', {notation: 'compact', maximumFractionDigits: 1}).format(number);
export const maximumStock = points => points.reduce((maximum, point) => Math.max(maximum, point.value), 1);
export const dayLabel = timestamp => new Date(timestamp).toISOString().slice(0, 10);
export const dateLabel = timestamp => new Intl.DateTimeFormat('zh-CN', {timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false}).format(new Date(timestamp));
export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
export function svgElement(tag, attributes = {}, text) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}
const colors = ['#438e7c', '#d0ac72', '#839bb4', '#a19db4', '#bd8b80', '#9eaf8b', '#b8b079', '#6c9ca5', '#acbb9d', '#b49781', '#8a99af', '#c1a1aa', '#75a994', '#b9b09a', '#97a6a2', '#ac9bb8'];
export const repositoryColors = repositories => new Map([...repositories].sort((a, b) => a.id.localeCompare(b.id)).map((repository, index) => [repository.id, index < colors.length ? colors[index] : `hsl(${((index * 137.508) % 360).toFixed(2)} 35% ${index % 2 ? 60 : 68}%)`]));
export function colorDot(color) {
  const dot = element('i', 'color-dot'); dot.style.backgroundColor = color; return dot;
}
