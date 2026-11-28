import { hosted, watchWorkspace, workspaceRequest } from '../storage/workspace.js';
import { setupTransfer } from '../storage/transfer.js';
import { $ } from './dom.js';
import { pageKey, readLocal, writeLocal, storage } from '../storage/browser.js';
import { legacyFrameform, workbenchId } from '../comfy/config.js';

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

const directoryKey = 'frameform.output-directory.v2.' + pageKey;
const legacyDirectoryKey = 'directory:' + pageKey;

function idbRequest(key, mode, value) {
  return storage().then(
    (db) =>
      new Promise((resolve) => {
        if (!db) return resolve(undefined);
        const tx = db.transaction('files', mode === 'get' ? 'readonly' : 'readwrite');
        const store = tx.objectStore('files');
        const request =
          mode === 'get' ? store.get(key) : store.put(value, key);
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = tx.onabort = () => resolve(undefined);
      }),
    () => undefined,
  );
}

let directory;
const directoryReady = refreshDirectory();
const settingsQuery = new URLSearchParams({ workflow: pageKey });
const settingsRoute = 'settings?' + settingsQuery;
const settingsDialog = $('settingsDialog');
let outputsRev = 0;
let savedOutput = null;
let chosenOutput;
let defaultOutput = '浏览器下载目录';
let canPickDirectory = false;
let outputBusy = false;
let settingsEdit = 0;

function currentEdit(edit) {
  return settingsDialog.open && edit === settingsEdit;
}
function renderOutputSetting() {
  const selected = chosenOutput === undefined ? savedOutput : chosenOutput;
  $('directoryName').textContent = (hosted ? selected : selected?.name) || defaultOutput;
  $('pickDirectory').disabled = outputBusy || !canPickDirectory;
  $('saveOutputsPath').disabled = outputBusy || chosenOutput === undefined;
  $('clearDirectory').disabled = outputBusy || !selected;
}
function applyHostOutput(data) {
  outputsRev = data.rev;
  savedOutput = data.configured ? data.outputs : null;
  defaultOutput = '默认下载目录 · ' + data.default;
  canPickDirectory = data.canChooseDirectory === true;
}
async function loadOutputSetting(edit) {
  chosenOutput = undefined;
  outputBusy = true;
  renderOutputSetting();
  $('outputsStatus').textContent = '';
  try {
    if (hosted) {
      const data = await workspaceRequest(settingsRoute);
      if (!currentEdit(edit)) return;
      applyHostOutput(data);
      if (data.canChooseDirectory === undefined)
        $('outputsStatus').textContent = '重启工作区服务后即可使用系统目录选择器。';
      else if (!canPickDirectory)
        $('outputsStatus').textContent = '请在工作区主机的本地桌面打开 Frameform，以使用系统目录选择器。';
    } else {
      const handle = await refreshDirectory();
      if (!currentEdit(edit)) return;
      savedOutput = handle || null;
      canPickDirectory = !!window.showDirectoryPicker;
      if (!canPickDirectory)
        $('outputsStatus').textContent = '当前浏览器无法选择文件夹，结果将下载到浏览器下载目录。';
    }
  } catch (e) {
    if (currentEdit(edit)) $('outputsStatus').textContent = '无法读取保存目录。' + e.message;
  } finally {
    if (currentEdit(edit)) {
      outputBusy = false;
      renderOutputSetting();
    }
  }
}

async function pickDirectory() {
  const edit = settingsEdit;
  outputBusy = true;
  renderOutputSetting();
  try {
    const selected = hosted
      ? (await workspaceRequest('settings/choose-directory?' + settingsQuery, 'POST')).path
      : await window.showDirectoryPicker({ mode: 'readwrite', startIn: savedOutput || 'downloads' });
    if (!currentEdit(edit) || !selected) return;
    chosenOutput = selected;
    $('outputsStatus').textContent = '已选择文件夹，点击「保存」后生效。';
  } catch (e) {
    if (currentEdit(edit) && e.name !== 'AbortError')
      $('outputsStatus').textContent = '无法选择文件夹。' + e.message;
  } finally {
    if (currentEdit(edit)) {
      outputBusy = false;
      renderOutputSetting();
    }
  }
}

async function saveOutputSetting() {
  const edit = settingsEdit;
  const selected = chosenOutput;
  if (selected === undefined) return;
  outputBusy = true;
  renderOutputSetting();
  try {
    if (hosted) {
      const data = await workspaceRequest(settingsRoute, 'PUT', {
        rev: outputsRev,
        outputs: selected || '',
      });
      if (!currentEdit(edit)) return;
      applyHostOutput(data);
    } else {
      if (!await idbRequest(directoryKey, 'put', selected))
        throw Error('浏览器无法记住目录授权。');
      directory = selected;
      if (!currentEdit(edit)) return;
      savedOutput = selected;
    }
    chosenOutput = undefined;
    $('outputsStatus').textContent = '已保存当前工作流的结果目录。';
  } catch (e) {
    if (currentEdit(edit)) {
      if (e.status === 409) await loadOutputSetting(edit);
      if (currentEdit(edit)) $('outputsStatus').textContent = '保存失败。' + e.message;
    }
  } finally {
    if (currentEdit(edit)) {
      outputBusy = false;
      renderOutputSetting();
    }
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

async function refreshDirectory() {
  if (hosted || !window.showDirectoryPicker) return undefined;
  const handle = await idbRequest(directoryKey, 'get');
  directory = handle;
  if (handle === undefined) {
    directory = await idbRequest(legacyDirectoryKey, 'get');
    if (!directory && (legacyFrameform || workbenchId === 'pika-h3'))
      directory = await idbRequest('frameform.output-directory.v1', 'get');
  }
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
  $('clearDirectory').onclick = () => {
    chosenOutput = null;
    renderOutputSetting();
    $('outputsStatus').textContent = '点击「保存」使用默认目录。';
  };
  $('saveOutputsPath').onclick = saveOutputSetting;
  $('runninghubSettings').hidden = !hosted;
  if (hosted) {
    $('saveRunningHubKey').onclick = saveRunningHub;
    $('clearRunningHubKey').onclick = clearRunningHub;
  }
  $('openSettings').onclick = () => {
    settingsDialog.showModal();
    loadOutputSetting(++settingsEdit);
    if (hosted) loadRunningHub();
  };
  $('closeSettings').onclick = () => settingsDialog.close();
}

export {
  setupSettings,
  applyTheme,
  directoryReady,
  directory,
  refreshDirectory,
};
