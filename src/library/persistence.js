import { hosted, updateWorkspace } from '../storage/workspace.js';
import { pageKey, readLocal, storage, writeLocal } from '../storage/browser.js';
import { stableGraph } from './graph.js';
import { repairSavedMapping } from './mapping.js';

const workflowsKey = 'workflow-library:' + pageKey;
const mappingSignature = ({
  storageKey,
  restoredH3Controls,
  ...configuration
}) => stableGraph(configuration);
const activeKey = 'frameform.active-workflow.v1.' + pageKey;

export const lastWorkflow = () => readLocal(activeKey, '');
export const rememberWorkflow = (id) => writeLocal(activeKey, id);

async function updateWorkflows(update) {
  if (hosted) {
    let result;
    await updateWorkspace(workflowsKey, [], entries => {
      result = update(entries.map(repairSavedMapping));
      return result.entries;
    });
    return result;
  }
  const db = await storage();
  if (!db) throw Error('无法访问浏览器存储。');
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    const files = tx.objectStore('files');
    const request = files.get(workflowsKey);
    let result;
    request.onsuccess = () => {
      const previous = request.result ?? [];
      const repaired = previous.map(repairSavedMapping);
      result = update(repaired);
      if (
        result.entries !== repaired ||
        repaired.some((entry, i) => entry !== previous[i])
      )
        files.put(result.entries, workflowsKey);
    };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error || Error('无法保存工作流。'));
  });
}

export const readWorkflows = () =>
  updateWorkflows((entries) => ({ entries })).then(({ entries }) => entries);

export function addWorkflow(entry) {
  const signature = stableGraph(entry.graph);
  const configuration = mappingSignature(entry.profile);
  return updateWorkflows((entries) => {
    const selected = entries.find(
      (item) =>
        stableGraph(item.graph) === signature &&
        mappingSignature(item.profile) === configuration,
    );
    if (!selected) return { selected: entry, entries: [...entries, entry] };
    if (!selected.removed) return { selected, entries };
    const restored = { ...selected, removed: false };
    return {
      selected: restored,
      entries: entries.map((item) => (item === selected ? restored : item)),
    };
  });
}

export function removeWorkflow(id) {
  return updateWorkflows((entries) => ({
    entries: entries.map((entry) =>
      entry.id === id && !entry.removed ? { ...entry, removed: true } : entry,
    ),
  })).then(({ entries }) => entries);
}
