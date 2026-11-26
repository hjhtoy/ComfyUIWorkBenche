// Standalone pages keep their browser-local store; point users to the workspace instead.
import { hosted } from '../storage/workspace.js';
import { $ } from './dom.js';

const dismissKey = 'frameform.standalone-notice.v1';
const urlKey = 'frameform.workspace-url.v1';

function readPreference(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function savePreference(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* The notice still works when storage is unavailable. */
  }
}

export function setupStandaloneNotice() {
  if (hosted || location.href === 'about:srcdoc') return;
  if (readPreference(dismissKey) === 'dismissed') return;
  $('standaloneNotice').hidden = false;
  const saved = readPreference(urlKey);
  if (saved) $('workspaceUrl').value = saved;
  $('openWorkspace').onclick = () => {
    let url;
    try {
      url = new URL($('workspaceUrl').value.trim());
      if (url.protocol !== 'http:' && url.protocol !== 'https:')
        throw new Error('protocol');
    } catch {
      $('standaloneStatus').textContent =
        '请输入有效的 http(s) 工作区地址，例如 http://127.0.0.1:8787。';
      return;
    }
    savePreference(urlKey, url.href);
    window.open(url.href, '_blank', 'noopener');
    $('standaloneStatus').textContent =
      '若工作区尚未启动，请先在项目目录运行 npm run build 和 npm start。';
  };
  $('exportForWorkspace').onclick = () => {
    // Reuse the legacy exporter so the archive format has a single implementation.
    $('exportWorkspace').click();
    $('standaloneStatus').textContent =
      '导出完成后，在工作区主机运行 python3 -m workspace migrate <导出的 .ffdata 文件> 即可导入全部数据。';
  };
  $('dismissStandalone').onclick = () => {
    $('standaloneNotice').hidden = true;
    savePreference(dismissKey, 'dismissed');
  };
}
