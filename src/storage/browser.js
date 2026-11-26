import { hosted, workspaceValue, writeWorkspace, workspaceFile } from './workspace.js';
import { legacyFrameform, profile, workbenchId } from '../comfy/config.js';

const owningLocation =
  workbenchId && window.parent !== window && location.href === 'about:srcdoc'
    ? window.parent.location
    : location;
const openingPath =
  owningLocation.protocol === 'file:'
    ? owningLocation.pathname
    : owningLocation.pathname.replace(/\/$/, '');
const workflowPageKey = (storageKey) => hosted ? storageKey : storageKey + ':' + openingPath;
const pageKey = hosted ? (workbenchId || profile.storageKey) : legacyFrameform
  ? openingPath
  : workflowPageKey(profile.storageKey);
let storageDB;

function readLocal(key, fallback) {
  if (hosted) return workspaceValue(key, fallback);
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function writeLocal(key, value) {
  if (hosted) return writeWorkspace(key,value).catch(() => false);
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
function storage() {
  storageDB ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('frameform-local', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files');
    request.onsuccess = () => resolve(request.result);
    request.onerror = request.onblocked = () =>
      reject(request.error || Error('无法访问浏览器存储'));
  }).catch(() => null);
  return storageDB;
}
async function fileData(key, value) {
  if (hosted) return workspaceFile(key, value);
  const db = await storage();
  if (!db) throw Error('无法访问浏览器存储');
  return new Promise((resolve, reject) => {
    const writing = value !== undefined;
    const tx = db.transaction('files', writing ? 'readwrite' : 'readonly');
    const store = tx.objectStore('files');
    const request = writing ? store.put(value, key) : store.get(key);
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () =>
      reject(tx.error || request.error || Error('无法保存到浏览器'));
  });
}

export { pageKey, workflowPageKey, readLocal, writeLocal, storage, fileData };
