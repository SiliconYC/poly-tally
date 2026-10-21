import {repositoryDisplayName, repositoryVisibility} from './model.mjs';

// Keep the live region mounted. Updating it does not steal focus from the button.
export function createToast(node, {schedule = setTimeout, cancel = clearTimeout} = {}) {
  let timer;
  return (message, {error = false} = {}) => {
    cancel(timer);
    node.textContent = message;
    node.dataset.error = String(error);
    node.dataset.visible = 'true';
    timer = schedule(() => { node.dataset.visible = 'false'; node.textContent = ''; }, error ? 6000 : 3500);
  };
}

export async function copyRepositoryName(repository, {clipboard = globalThis.navigator?.clipboard, notify} = {}) {
  // The data contract's name is one real representative, not the lineage's member list.
  const name = repository.name;
  try {
    if (!clipboard?.writeText || typeof name !== 'string' || !name) throw new Error('Clipboard unavailable');
    await clipboard.writeText(name);
    notify(`已复制 ${name}`);
    return true;
  } catch {
    notify(`复制失败：${name}。${clipboard?.writeText ? '请检查浏览器剪贴板权限后重试。' : '此页面无法访问剪贴板。'}`, {error: true});
    return false;
  }
}

export function repositoryActions(repository, {document = globalThis.document, onCopy} = {}) {
  const actions = document.createElement('span'); actions.className = 'repo-actions';
  const button = document.createElement('button'); button.className = 'repo-name'; button.type = 'button';
  button.textContent = repositoryDisplayName(repository);
  button.title = `复制 ${repository.name}`;
  button.setAttribute('aria-label', `复制完整仓库名称 ${repository.name}`);
  button.addEventListener('click', () => onCopy(repository));
  actions.append(button);
  if (repositoryVisibility(repository) !== 'private') {
    try {
      const url = new URL(repository.url);
      if (url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password) {
        const link = document.createElement('a'); link.className = 'repo-external'; link.href = url.href;
        link.target = '_blank'; link.rel = 'noopener noreferrer';
        link.title = `在 GitHub 打开 ${repository.name}`;
        link.setAttribute('aria-label', `在 GitHub 打开 ${repository.name}（新标签页）`);
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        for (const [key, value] of Object.entries({class:'control-icon', viewBox:'0 0 24 24', 'aria-hidden':'true', focusable:'false'})) icon.setAttribute(key, value);
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5');
        icon.append(path); link.append(icon); actions.append(link);
      }
    } catch { /* Invalid or non-public URLs never become navigation targets. */ }
  }
  return actions;
}
