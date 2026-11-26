import { $, uid } from '../ui/dom.js';
import { hosted } from './workspace.js';
import { readLocal, fileData, pageKey, workflowPageKey } from './browser.js';
import {
  profile,
  template,
  workbenchId,
  legacyFrameform,
} from '../comfy/config.js';
import { mediaKeyForRef } from '../media/types.js';
import { jobSession, workflowSessionKey } from './jobs.js';
import { jobKey } from '../jobs/state.js';
import { triggerDownload, mediaKey } from '../media/outputs.js';

async function exportLegacy() {
  const builtin = 'pika-h3';
  const scope = workbenchId || (legacyFrameform ? builtin : profile.storageKey);
  const manifest = { format: 1, records: {}, jobs: [], media: [], missing: [] };
  const parts = [],
    wanted = new Map();
  const workflows = (await fileData('workflow-library:' + pageKey)) || [];
  if (scope !== builtin && !workflows.some((e) => e.id === scope)) {
    workflows.push({
      id: scope,
      title: profile.title,
      profile,
      graph: template,
      video: !!profile.duration,
    });
  }
  manifest.records['workflow-library:' + builtin] = workflows;
  const scopes = new Map([
    [pageKey, scope],
    ...workflows
      .filter((e) => e.id !== scope)
      .map((e) => [workflowPageKey(e.profile.storageKey), e.id]),
  ]);
  function copy(key, target = key) {
    const value = readLocal(key, null);
    if (value !== null) manifest.records[target] = value;
    return value;
  }
  for (const key of [
    'frameform.servers.v1',
    'frameform.theme.v1',
    'frameform.video.v1',
  ])
    copy(key);
  const base = localStorage.getItem('frameform.server');
  if (base) manifest.records['frameform.server'] = base;
  copy(
    'frameform.active-workflow.v1.' + pageKey,
    'frameform.active-workflow.v1.' + builtin,
  );
  function addRef(ref) {
    if (ref?.id) wanted.set(mediaKeyForRef(ref), ref.name);
  }
  for (const [old, id] of scopes) {
    const library =
      copy(
        'frameform.material-library.v1.' + old,
        'frameform.material-library.v1.' + id,
      ) || [];
    const draft = copy('frameform.draft.v1.' + old, 'frameform.draft.v1.' + id);
    copy('frameform.batch.v1.' + old, 'frameform.batch.v1.' + id);
    const folders = await fileData('material-folders:' + old);
    if (folders) manifest.records['material-folders:' + id] = folders;
    library.forEach(addRef);
    draft?.refs?.forEach(addRef);
    const removed = new Set(readLocal('frameform.deleted-jobs.v1.' + old, []));
    const session =
      id === builtin ? 'frameform.jobs.v1' : workflowSessionKey(old);
    const rows = new Map();
    for (const j of [
      ...readLocal('frameform.history.v2.' + old, []),
      ...jobSession(session),
    ]) {
      if (!removed.has(j.client) && !removed.has(jobKey(j)))
        rows.set(jobKey(j), j);
    }
    for (const j of rows.values()) {
      manifest.jobs.push({
        workflow: id,
        job: { ...j, client: j.client || uid() },
      });
      j.form?.refs?.forEach(addRef);
      for (const item of j.results || [])
        wanted.set(mediaKey(j, item), item.filename);
    }
  }
  for (const [key, name] of wanted) {
    const file = await fileData(key);
    if (!(file instanceof Blob)) {
      manifest.missing.push({ key, name });
      continue;
    }
    manifest.media.push({
      key,
      name: file.name || name,
      mime: file.type,
      size: file.size,
    });
    parts.push(file);
  }
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  // A length-prefixed manifest and concatenated blobs allow media larger than ZIP32.
  triggerDownload(
    new Blob(['FRAMEFORM-1\n' + json.length + '\n', json, ...parts]),
    'Frameform-legacy.ffdata',
  );
  return manifest;
}

export function setupTransfer() {
  const control = $('exportWorkspace'),
    status = $('workspaceStatus');
  if (hosted) {
    control.textContent = '备份工作区';
    status.textContent =
      '素材、任务和结果归档保存在工作区主机；完成的任务还会保存到你在设置中选择的文件夹。';
  }
  control.onclick = async () => {
    if (hosted) {
      const link = document.createElement('a');
      link.href = '/workspace/backup';
      link.download = 'Frameform-workspace.zip';
      link.click();
      return;
    }
    if (location.href === 'about:srcdoc') {
      window.parent.document.getElementById('exportWorkspace').click();
      status.textContent = '已从主工作台导出全部工作流的数据。';
      return;
    }
    control.disabled = true;
    try {
      const data = await exportLegacy();
      status.textContent =
        '已导出 ' +
        data.media.length +
        ' 个媒体文件及 ' +
        data.jobs.length +
        ' 条任务。缺少本地副本 ' +
        data.missing.length +
        ' 项，清单保存在迁移包中。';
    } catch (error) {
      status.textContent = '导出失败。' + error.message;
    } finally {
      control.disabled = false;
    }
  };
}
