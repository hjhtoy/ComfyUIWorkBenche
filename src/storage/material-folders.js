import { hosted, updateWorkspace } from './workspace.js';
import { pageKey, storage } from './browser.js';

const key = 'material-folders:' + pageKey;
export const emptyFolders = () => ({ folders: [], byAsset: {} });

// Each edit reads the latest classification in the same transaction as the write.
export async function materialFolders(edit) {
  if (hosted) return updateWorkspace(key, emptyFolders(), edit && (state => {
    edit(state);
    return state;
  }));
  const db = await storage();
  if (!db) throw Error('无法访问素材目录存储。');
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', edit ? 'readwrite' : 'readonly');
    const store = tx.objectStore('files');
    const request = store.get(key);
    let state, error;
    request.onsuccess = () => {
      state = request.result ?? emptyFolders();
      if (!edit) return;
      try {
        edit(state);
        store.put(state, key);
      } catch (e) {
        error = e;
        tx.abort();
      }
    };
    tx.oncomplete = () => resolve(state);
    tx.onabort = () => reject(error || tx.error || Error('无法保存素材目录。'));
  });
}
