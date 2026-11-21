import { legacyFrameform } from '../comfy/config.js';
import {
  jobs,
  terminal,
  jobKey,
  isJobDeleted,
  mergeJobRecord,
} from '../jobs/state.js';
import { pageKey, readLocal, writeLocal } from './browser.js';

const sessionKey = legacyFrameform
  ? 'frameform.jobs.v1'
  : 'frameform.jobs.v1.' + pageKey;
const historyKey = 'frameform.history.v2.' + pageKey;
const deletedJobsKey = 'frameform.deleted-jobs.v1.' + pageKey;
const readRemovedJobs = () => new Set(readLocal(deletedJobsKey, []));
function persist() {
  const removed = readRemovedJobs();
  const owned = jobs.filter(
    (j) => !isJobDeleted(removed, j) && (j.sent || terminal(j)),
  );
  const fields = [
    'n',
    'base',
    'client',
    'id',
    'sent',
    'state',
    'note',
    'title',
    'steps',
    'duration',
    'dimensions',
    'cancel',
    'cancelAck',
    'results',
    'form',
    'startedAt',
    'endedAt',
    'mediaNote',
    'imported',
    'observedStart',
  ];
  const serialize = (j) =>
    Object.fromEntries(fields.map((key) => [key, j[key]]));
  const active = owned.filter((j) => !terminal(j)).map(serialize);
  const finished = new Map(
    readLocal(historyKey, [])
      .filter((j) => terminal(j) && !isJobDeleted(removed, j))
      .map((j) => [jobKey(j), j]),
  );
  for (const j of owned.filter(terminal)) {
    const key = jobKey(j);
    finished.set(key, mergeJobRecord(finished.get(key), serialize(j)));
  }
  const archive = [...finished.values()]
    .sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0))
    .slice(-25);
  writeLocal(historyKey, archive);
  try {
    sessionStorage.setItem(sessionKey, JSON.stringify([...active, ...archive]));
  } catch {}
}

function restoreJobs(onRestore) {
  try {
    const current = JSON.parse(sessionStorage.getItem(sessionKey) || '[]');
    const saved = new Map(current.map((j) => [jobKey(j), j]));
    for (const j of readLocal(historyKey, [])) {
      if (!terminal(j)) continue;
      const key = jobKey(j);
      saved.set(key, mergeJobRecord(saved.get(key), j));
    }
    const removed = readRemovedJobs();
    for (const j of [...saved.values()].sort((a, b) => a.n - b.n)) {
      if (isJobDeleted(removed, j)) continue;
      jobs.push(j);
      onRestore(j);
    }
    if (saved.size) persist();
  } catch {}
}

export {
  sessionKey,
  historyKey,
  deletedJobsKey,
  readRemovedJobs,
  persist,
  restoreJobs,
};
