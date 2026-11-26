import { hosted, watchWorkspace, workspaceRequest } from '../storage/workspace.js';
import { setupTransfer } from '../storage/transfer.js';
import { $ } from './dom.js';
import { pageKey, readLocal, writeLocal, storage } from '../storage/browser.js';

const themeKey = 'frameform.theme.v1';
const themeControls = [
  ...$('themeSettings').querySelectorAll('input[name="theme"]'),
];
function applyTheme(value) {
  const selected =
    themeControls.find((input) => input.value === value) || themeControls[0];
  document.documentElement.dataset.theme = selected.value;
  selected.checked = true;
}

// The chosen folder is a FileSystemDirectoryHandle. It only exists in the
// browser, so it is always kept in this browser's IndexedDB, for both the
// hosted workspace and a standalone HTML page.
const directoryKey = 'frameform.output-directory.v1';
const legacyDirectoryKey = 'directory:' + pageKey;

function idbRequest(key, mode, value) {
  return storage().then(
    (db) =>
      new Promise((resolve) => {
        if (!db) return resolve(undefined);
        const tx = db.transaction('files', mode === 'get' ? 'readonly' : 'readwrite');
        const store = tx.objectStore('files');
        const request =
          mode === 'get'
            ? store.get(key)
            : mode === 'delete'
              ? store.delete(key)
              : store.put(value, key);
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = tx.onabort = () => resolve(undefined);
      }),
    () => undefined,
  );
}

let directory;
const directoryReady = window.showDirectoryPicker
  ? idbRequest(directoryKey, 'get')
      .then(async (handle) => {
        // Older standalone pages stored the handle under a page-scoped key.
        directory = handle || (await idbRequest(legacyDirectoryKey, 'get'));
      })
      .catch(() => {})
  : Promise.resolve();

function directorySetting() {
  $('directoryName').textContent = directory?.name || '未选择';
  $('pickDirectory').disabled = !window.showDirectoryPicker;
  $('clearDirectory').hidden = !directory;
}

async function pickDirectory() {
  try {
    directory = await window.showDirectoryPicker({ mode: 'readwrite' });
    directorySetting();
    $('outputsStatus').textContent =
      '之后完成的任务会保存到「' + directory.name + '」。';
    await idbRequest(directoryKey, 'put', directory);
  } catch (e) {
    if (e.name !== 'AbortError')
      $('outputsStatus').textContent = '无法保存目录设置。' + e.message;
  }
}

async function clearDirectory() {
  directory = undefined;
  directorySetting();
  $('outputsStatus').textContent =
    '已清除选择，之后完成的任务会下载到浏览器下载目录。';
  await idbRequest(directoryKey, 'delete');
}

// The workspace host can write an absolute path itself, which survives reloads
// and does not depend on browser folder permissions.
let outputsRev = 0;
async function loadOutputs() {
  try {
    const data = await workspaceRequest('settings');
    outputsRev = data.rev;
    $('outputsPath').value = data.outputs;
    $('outputsDefault').textContent = '默认 ' + data.default;
  } catch (e) {
    $('hostedOutputsStatus').textContent = '无法读取输出目录。' + e.message;
  }
}
async function saveOutputsPath() {
  $('saveOutputsPath').disabled = true;
  try {
    const data = await workspaceRequest('settings', 'PUT', {
      rev: outputsRev,
      outputs: $('outputsPath').value.trim(),
    });
    outputsRev = data.rev;
    $('outputsPath').value = data.outputs;
    $('hostedOutputsStatus').textContent =
      '已保存，之后完成的任务会写入 ' + data.outputs;
  } catch (e) {
    $('hostedOutputsStatus').textContent = '保存失败。' + e.message;
    if (e.status === 409) loadOutputs();
  } finally {
    $('saveOutputsPath').disabled = false;
  }
}

async function loadRunningHub() {
  try {
    const data = await workspaceRequest('provider');
    $('runninghubStatus').textContent = data.runninghub
      ? '已配置 API Key'
      : '未配置';
    $('clearRunningHubKey').hidden = !data.runninghub;
  } catch (e) {
    $('runninghubStatus').textContent = '无法读取配置。' + e.message;
  }
}

async function saveRunningHub() {
  const key = $('runninghubKey').value.trim();
  if (!key) {
    $('runninghubStatus').textContent = '请输入 API Key';
    return;
  }
  $('saveRunningHubKey').disabled = true;
  try {
    const data = await workspaceRequest('provider', 'PUT', {
      runninghubApiKey: key,
    });
    $('runninghubKey').value = '';
    $('runninghubStatus').textContent = data.runninghub ? '已保存' : '未保存';
    $('clearRunningHubKey').hidden = !data.runninghub;
  } catch (e) {
    $('runninghubStatus').textContent = '保存失败。' + e.message;
  } finally {
    $('saveRunningHubKey').disabled = false;
  }
}

async function clearRunningHub() {
  try {
    await workspaceRequest('provider', 'PUT', { clear: true });
    await loadRunningHub();
    $('runninghubStatus').textContent = '已清除';
  } catch (e) {
    $('runninghubStatus').textContent = '清除失败。' + e.message;
  }
}

// Workbench pages run in separate iframes; always re-read the shared handle
// before saving so a folder chosen in another page takes effect here too.
async function refreshDirectory() {
  if (!window.showDirectoryPicker) return undefined;
  const handle = await idbRequest(directoryKey, 'get');
  if (handle) directory = handle;
  return directory;
}

function setupSettings() {
  setupTransfer();
  watchWorkspace(themeKey, applyTheme);
  applyTheme(readLocal(themeKey, 'classic'));
  $('themeSettings').onchange = async (event) => {
    applyTheme(event.target.value);
    $('themeStatus').textContent = await writeLocal(themeKey, event.target.value)
      ? ''
      : '当前浏览器无法记住此主题。';
  };
  window.addEventListener('storage', (event) => {
    if (event.key === themeKey) applyTheme(readLocal(themeKey, 'classic'));
  });

  $('pickDirectory').onclick = pickDirectory;
  $('clearDirectory').onclick = clearDirectory;
  $('hostedOutputSettings').hidden = !hosted;
  if (hosted) $('saveOutputsPath').onclick = saveOutputsPath;
  $('runninghubSettings').hidden = !hosted;
  if (hosted) {
    $('saveRunningHubKey').onclick = saveRunningHub;
    $('clearRunningHubKey').onclick = clearRunningHub;
  }
  if (!window.showDirectoryPicker)
    $('outputsStatus').textContent =
      '当前浏览器不支持选择文件夹，任务完成后会自动下载视频和首帧。';

  $('openSettings').onclick = async () => {
    // Re-read the stored handle: another window may have picked a new folder.
    if (window.showDirectoryPicker)
      directory = (await idbRequest(directoryKey, 'get')) || directory;
    directorySetting();
    if (directory) {
      try {
        if ((await directory.queryPermission({ mode: 'readwrite' })) !== 'granted')
          $('outputsStatus').textContent =
            '保存目录需要重新授权：请点「选择文件夹…」再选一次该目录。';
      } catch {}
    }
    if (hosted) {
      loadRunningHub();
      loadOutputs();
    }
    $('settingsDialog').showModal();
  };
  $('closeSettings').onclick = () => $('settingsDialog').close();
  directorySetting();
}

export {
  setupSettings,
  applyTheme,
  directoryReady,
  directory,
  refreshDirectory,
};
