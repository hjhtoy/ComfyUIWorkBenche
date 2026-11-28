import { $, uid } from '../ui/dom.js';
import { pageKey } from '../storage/browser.js';
import { workspaceRequest } from '../storage/workspace.js';
import {
  buildGraph,
  graphJobData,
  matchWorkflow,
  outputNodeIds,
} from '../comfy/workflow.js';
import { legacyFrameform, profile, template } from '../comfy/config.js';
import { mediaKeyForRef } from '../media/types.js';
import { currentQueueBase } from '../ui/servers.js';
import { api } from '../comfy/api.js';
import { jobs, serverJobKey, terminal } from './state.js';

export function setupWorkspaceRunner({ render, updateQueueTools, removeRows }) {
  let refreshing,
    revision = -1;
  async function sync() {
    if (refreshing) return refreshing;
    refreshing = workspaceRequest(
      'jobs?' + new URLSearchParams({ workflow: pageKey, since: revision }),
    )
      .then(({ rev, rows, connection }) => {
        // One shared note beats a red message on every queued card.
        $('queueSync').textContent = connection || '';
        if (!rows) return;
        const incoming = new Set(rows.map((row) => row.client));
        removeRows(
          new Set(
            jobs.filter((j) => !incoming.has(j.client)).map((j) => j.client),
          ),
        );
        const known = new Map(jobs.map((j) => [j.client, j]));
        for (const data of rows) {
          let job = known.get(data.client);
          const signature = JSON.stringify(data);
          if (job?.workspaceSnapshot === signature) continue;
          if (!job) {
            job = {};
            jobs.push(job);
          }
          Object.assign(job, data, { workspaceSnapshot: signature });
          render(job);
        }
        updateQueueTools();
        revision = rev;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }
  setInterval(
    () =>
      sync().catch((error) => {
        $('queueSync').textContent = error.message;
      }),
    1500,
  );

  // ComfyUI reports the running node and its step counter over its WebSocket;
  // the worker collects it and hands us a small snapshot once a second.
  function stageText(progress) {
    if (!progress) return '';
    const label = progress.label || '';
    if (!progress.max) return label;
    return (
      (label ? label + ' · ' : '生成中 · ') +
      progress.value +
      ' / ' +
      progress.max +
      ' 步'
    );
  }
  async function refreshProgress() {
    const { clients } = await workspaceRequest('progress');
    for (const job of jobs) {
      if (!job.row || job.imported) continue;
      // Finished jobs drop the live line instead of freezing the last step.
      const progress = terminal(job) ? undefined : clients[job.client];
      const stage = stageText(progress);
      const value = progress?.max ? progress.value : null;
      const total = progress?.max || null;
      if (job.stage === stage && job.value === value && job.total === total)
        continue;
      job.stage = stage;
      job.value = value;
      job.total = total;
      render(job);
    }
  }
  setInterval(() => refreshProgress().catch(() => {}), 1000);

  async function enqueue(values) {
    const batch = uid();
    const cloud = (base) =>
      /^https?:\/\/(www\.)?runninghub\.(cn|ai)$/i.test(base || '');
    const records = values.map((value) => {
      const client = uid();
      // Mark actual loader fields while using the same graph builder as standalone mode.
      const markers = value.files.map(() => ({}));
      const graph = buildGraph(value, markers);
      const inputs = value.form.refs.map((ref) => ({
        key: mediaKeyForRef(ref),
        fields: [],
      }));
      for (const [node, entry] of Object.entries(graph))
        for (const [field, input] of Object.entries(entry.inputs)) {
          const index = markers.indexOf(input);
          if (index >= 0) {
            inputs[index].fields.push([node, field]);
            entry.inputs[field] = '';
          }
        }
      // Only send fields that differ from the imported graph; RunningHub applies
      // them as nodeInfoList overrides on its own workflow copy.
      const nodeInfoList = [];
      for (const [nodeId, entry] of Object.entries(graph))
        for (const [field, input] of Object.entries(entry.inputs || {}))
          if (template?.[nodeId]?.inputs?.[field] !== input)
            nodeInfoList.push({ nodeId, fieldName: field, fieldValue: input });
      const { title, form, base, dimensions, steps, duration } = value;
      return {
        job: {
          client,
          title,
          form,
          base,
          dimensions,
          steps,
          duration,
          ...(cloud(base) && { provider: 'runninghub' }),
          ...(!legacyFrameform && { outputNodes: outputNodeIds(graph) }),
        },
        plan: {
          workflow: pageKey,
          batch,
          graph,
          inputs,
          nodeInfoList,
          ...(profile.runninghubWorkflowId && {
            runninghubWorkflowId: profile.runninghubWorkflowId,
          }),
        },
      };
    });
    await workspaceRequest('jobs', 'POST', {
      workflow: pageKey,
      jobs: records,
    });
    await sync();
  }
  async function refreshCurrentQueue(reportErrors = false) {
    try {
      await sync();
      const base = currentQueueBase();
      if (!base) return;
      // Cloud providers keep their queue behind the OpenAPI, not on /queue.
      if (/^https?:\/\/(www\.)?runninghub\.(cn|ai)$/i.test(base)) return;
      const queue = await api(base, '/queue');
      const records = [];
      for (const [, id, graph, meta] of queue.queue_running || []) {
        if (
          meta?.frameform_workflow_id &&
          meta.frameform_workflow_id !== pageKey
        )
          continue;
        if (
          jobs.some(
            (j) =>
              j.base === base && (j.id === id || j.client === meta?.client_id),
          )
        )
          continue;
        const mapped = matchWorkflow(graph);
        if (!mapped) continue;
        records.push({
          job: {
            ...graphJobData(base, graph, mapped),
            base,
            id,
            client: serverJobKey(base, id),
            ...(!legacyFrameform && {
              outputNodes: outputNodeIds(graph, mapped),
            }),
            state: 'running',
            note: '从服务器同步',
            sent: true,
            imported: true,
            startedAt: Date.now(),
            observedStart: true,
          },
        });
      }
      if (records.length) {
        await workspaceRequest('jobs', 'POST', {
          workflow: pageKey,
          jobs: records,
        });
        await sync();
      }
    } catch (error) {
      if (reportErrors) $('queueSync').textContent = error.message;
    }
  }
  async function requestCancel(job) {
    try {
      await workspaceRequest('cancel', 'POST', { client: job.client });
      await sync();
    } catch (error) {
      $('queueSync').textContent = error.message;
    }
  }
  return { enqueue, requestCancel, refreshCurrentQueue, submitWaiting() {} };
}
