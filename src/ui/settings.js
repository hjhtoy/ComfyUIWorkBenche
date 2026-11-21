import { $ } from './dom.js';
import {
  pageKey,
  readLocal,
  writeLocal,
  fileData,
} from '../storage/browser.js';

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

function setupSettings() {
  applyTheme(readLocal(themeKey, 'classic'));
  $('themeSettings').onchange = (event) => {
    applyTheme(event.target.value);
    $('themeStatus').textContent = writeLocal(themeKey, event.target.value)
      ? ''
      : '当前浏览器无法记住此主题。';
  };
  window.addEventListener('storage', (event) => {
    if (event.key === themeKey) applyTheme(readLocal(themeKey, 'classic'));
  });
  $('autoCache').onchange = () => {
    videoPrefs.cache = $('autoCache').checked;
    saveVideoPrefs();
  };
  $('autoDisk').onchange = () => {
    videoPrefs.disk = $('autoDisk').checked;
    saveVideoPrefs();
  };
  $('openSettings').onclick = async () => {
    await directoryReady;
    $('autoCache').checked = !!videoPrefs.cache;
    directorySetting();
    $('settingsError').textContent = window.showDirectoryPicker
      ? ''
      : '当前浏览器支持浏览器缓存和手动下载。选择本机保存目录需要支持目录访问的浏览器。';
    $('pickDirectory').disabled = !window.showDirectoryPicker;
    $('settingsDialog').showModal();
  };
  $('closeSettings').onclick = () => $('settingsDialog').close();
  $('pickDirectory').onclick = async () => {
    try {
      directory = await window.showDirectoryPicker({ mode: 'readwrite' });
      videoPrefs.disk = true;
      directorySetting();
      await fileData('directory:' + pageKey, directory);
      saveVideoPrefs();
      $('settingsError').textContent = '';
    } catch (e) {
      if (e.name !== 'AbortError')
        $('settingsError').textContent = '无法保存目录设置。' + e.message;
    }
  };
}
const videoPrefsKey = 'frameform.video.v1';
const videoPrefs = readLocal(videoPrefsKey, {});
let directory;
function directorySetting() {
  $('directoryName').textContent = directory?.name || '尚未选择目录';
  $('autoDisk').disabled = !directory;
  $('autoDisk').checked = !!directory && !!videoPrefs.disk;
}
const directoryReady = window.showDirectoryPicker
  ? fileData('directory:' + pageKey)
      .then((handle) => {
        directory = handle;
      })
      .catch(() => {})
  : Promise.resolve();
function saveVideoPrefs() {
  if (!writeLocal(videoPrefsKey, videoPrefs))
    $('settingsError').textContent = '浏览器无法保存当前设置。';
}

export { setupSettings, applyTheme, videoPrefs, directoryReady, directory };
