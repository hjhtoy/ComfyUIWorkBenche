import { $, uid } from '../ui/dom.js';
import { currentQueueBase, connection, remember } from '../ui/servers.js';
import { api, post, probe } from '../comfy/api.js';
import {
  template,
  profile,
  legacyFrameform,
  workbenchId,
} from '../comfy/config.js';
import {
  buildGraph,
  matchWorkflow,
  graphJobData,
  outputNodeIds,
} from '../comfy/workflow.js';
import { materialSpecs, materialKind } from '../media/types.js';
import { mediaFiles, saveOutputs } from '../media/outputs.js';
import { jobs, terminal, startClock, serverJobKey } from './state.js';
import { restoreHistoryForm } from './history.js';
import { serverJobs } from './queue-view.js';
import { persist, readRemovedJobs } from '../storage/jobs.js';

export function setupRunner({ render, updateQueueTools }) {
  let submitting = false;
  const mappedOutputs = workbenchId && !legacyFrameform;

  function finish(j, state, note) {
    if (terminal(j) || j.removed) return;
    j.endedAt ||= Date.now();
    j.state = state;
    j.note = note;
    j.warn = '';
    j.cancel = false;
    j.files = [];
    j.prompt = '';
    clearTimeout(j.timer);
    clearTimeout(j.reconnect);
    if (j.ws) {
      j.ws.onclose = null;
      j.ws.close();
      j.ws = null;
    }
    render(j);
    persist();
    if (state === 'done') saveOutputs(j, render);
  }
  function historyResult(j, entry) {
    if (!entry || terminal(j)) return false;
    restoreHistoryForm(j, entry);
    const messages = entry.status?.messages || [];
    const started = messages.find(([type]) => type === 'execution_start')?.[1]
      ?.timestamp;
    if (started) startClock(j, started);
    const stopped = messages.find(([type]) =>
      [
        'execution_success',
        'execution_error',
        'execution_interrupted',
      ].includes(type),
    )?.[1]?.timestamp;
    if (Number(stopped) > 1e12) j.endedAt = stopped;
    const failure = messages.find(
      ([t]) => t === 'execution_error' || t === 'execution_interrupted',
    );
    if (failure) {
      const [type, d] = failure;
      finish(
        j,
        type === 'execution_interrupted' ? 'cancelled' : 'failed',
        type === 'execution_interrupted' ? '服务器已中断执行' : nodeError(d),
      );
      return true;
    }
    if (entry.status?.status_str === 'error') {
      finish(j, 'failed', '服务器执行失败，请查看 ComfyUI 控制台。');
      return true;
    }
    if (
      entry.status?.completed ||
      entry.status?.status_str === 'success' ||
      (!entry.status && entry.outputs)
    ) {
      const outputs = entry.outputs || {};
      const selected = mappedOutputs
        ? Object.fromEntries(
            (j.outputNodes ?? profile.outputs).map((id) => [id, outputs[id]]),
          )
        : outputs;
      j.results = mediaFiles(selected);
      if (!j.results.length)
        finish(
          j,
          'failed',
          '任务已执行完毕，历史记录中没有可预览的视频或图片。',
        );
      else
        finish(
          j,
          'done',
          legacyFrameform
            ? j.results.some((x) => x.kind === 'video')
              ? j.dimensions + ' · ' + j.steps + ' 步'
              : '仅返回图片，请检查视频合成节点。'
            : '结果已生成',
        );
      return true;
    }
    return false;
  }
  function nodeError(d = {}) {
    return (
      '节点 ' +
      (d.node_type || d.node_id || '未知') +
      ' · ' +
      (d.exception_message || d.exception_type || '执行失败')
    );
  }
  function attachSocket(j) {
    if (terminal(j) || j.removed || j.imported || j.ws) return;
    const url = new URL(j.base + '/ws');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('clientId', j.client);
    let ws;
    try {
      ws = new WebSocket(url);
      j.ws = ws;
    } catch {
      return;
    }
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string' || terminal(j)) return;
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      const d = msg.data || {};
      if (d.prompt_id !== (j.id || j.client) || !j.sent) return;
      if (!j.id) {
        j.id = d.prompt_id;
        persist();
      }
      if (
        ['execution_start', 'executing', 'progress'].includes(msg.type) &&
        !(msg.type === 'executing' && d.node === null)
      ) {
        startClock(j, msg.type === 'execution_start' ? d.timestamp : undefined);
        if (!j.clockSaved) {
          j.clockSaved = true;
          persist();
        }
      }
      if (
        [
          'execution_error',
          'execution_interrupted',
          'execution_success',
        ].includes(msg.type) &&
        Number(d.timestamp) > 1e12
      )
        j.endedAt = d.timestamp;
      if (msg.type === 'execution_error') {
        finish(j, 'failed', nodeError(d));
        return;
      }
      if (msg.type === 'execution_interrupted') {
        finish(j, 'cancelled', '服务器已中断执行');
        return;
      }
      if (
        msg.type === 'execution_success' ||
        (msg.type === 'executing' && d.node === null)
      ) {
        schedule(j, 0);
        return;
      }
      if (j.cancel) return;
      if (msg.type === 'progress' && d.max > 0) {
        j.state = 'running';
        j.value = d.value;
        j.total = d.max;
        j.stage =
          (String(d.node) === profile.sampler
            ? '采样'
            : '节点 ' + (d.node || '')) +
          ' ' +
          d.value +
          ' / ' +
          d.max;
      } else if (msg.type === 'executing' || msg.type === 'execution_start') {
        j.state = 'running';
        j.value = null;
        j.stage =
          profile.stages?.[d.node] ||
          template[d.node]?._meta?.title ||
          template[d.node]?.class_type ||
          '开始执行';
      } else return;
      j.note = j.stage;
      render(j);
    };
    ws.onerror = () => {}; // Queue and history polling also work without a WebSocket.
    ws.onclose = () => {
      j.ws = null;
      if (!terminal(j)) j.reconnect = setTimeout(() => attachSocket(j), 6000);
    };
  }
  function schedule(j, delay) {
    if (terminal(j) || j.removed) return;
    clearTimeout(j.timer);
    if (j.polling) {
      j.wake = true;
      return;
    }
    j.timer = setTimeout(() => poll(j), delay);
  }
  async function cancelRemote(j, running) {
    if (!j.legacyCancel) {
      try {
        const res = await api(
          j.base,
          '/api/jobs/' + encodeURIComponent(j.id) + '/cancel',
          post({}),
        );
        if (typeof res.cancelled === 'boolean') return res.cancelled;
        j.legacyCancel = true;
      } catch (e) {
        if (![404, 405].includes(e.status)) throw e;
        j.legacyCancel = true;
      }
    }
    if (running) await api(j.base, '/interrupt', post({ prompt_id: j.id }));
    else await api(j.base, '/queue', post({ delete: [j.id] }));
    return true;
  }
  async function poll(j) {
    if (terminal(j) || j.removed || j.polling) return;
    j.polling = true;
    j.wake = false;
    try {
      const queue = await readQueue(j.base);
      if (
        !Array.isArray(queue.queue_running) ||
        !Array.isArray(queue.queue_pending)
      )
        throw Error('队列响应格式异常，请检查服务器地址。');
      const belongs = (row) =>
        j.id ? row[1] === j.id : row[3]?.client_id === j.client;
      const running = queue.queue_running.find(belongs),
        pending = queue.queue_pending.find(belongs);
      const row = running || pending;
      if (terminal(j)) return;
      if (running && !j.startedAt) {
        startClock(j);
        persist();
      }
      if (row) {
        j.id = row[1];
        j.absent = 0;
        j.warn = '';
        if (j.cancel) {
          j.state = 'stopping';
          j.note = '等待服务器确认…';
          const mode = running ? 'running' : 'pending';
          if (j.lastMode !== mode || Date.now() - (j.lastStop || 0) > 12000) {
            const ack = await cancelRemote(j, !!running);
            if (terminal(j)) return;
            j.cancelAck ||= ack;
            j.lastMode = mode;
            j.lastStop = Date.now();
            persist();
          }
        } else if (running) {
          j.state = 'running';
          j.note =
            j.ws?.readyState === WebSocket.OPEN
              ? j.stage || '正在执行工作流'
              : j.imported
                ? '正在执行 · 服务器轮询'
                : '正在执行 · 轮询模式';
        } else {
          j.state = 'queued';
          j.value = null;
          j.note = '排队位置 ' + (queue.queue_pending.indexOf(row) + 1);
        }
      } else {
        const path = j.id
          ? '/history/' + encodeURIComponent(j.id)
          : '/history?max_items=100';
        const data = await api(j.base, path);
        if (terminal(j)) return;
        const entry = j.id
          ? data[j.id]
          : Object.values(data).find(
              (x) => x.prompt?.[3]?.client_id === j.client,
            );
        if (entry && !j.id) {
          j.id = entry.prompt?.[1];
          persist();
        }
        if (historyResult(j, entry)) return;
        j.absent = (j.absent || 0) + 1;
        if (j.cancel && j.cancelAck && j.absent >= 2) {
          finish(j, 'cancelled', '已确认任务离开服务器队列');
          return;
        }
        if (j.cancel && j.absent >= 4) {
          finish(j, 'lost', '多次核对后仍未找到任务，已停止本页跟踪。');
          return;
        }
        j.note = j.cancel
          ? '核对服务器取消状态…'
          : j.id
            ? '等待服务器写入执行结果…'
            : '正在查找本次提交…';
        j.warn =
          j.absent >= 4
            ? '队列和历史中暂未找到本任务。请检查服务器是否重启或清除了记录。页面会继续核对。'
            : '';
      }
      j.syncFailures = 0;
      render(j);
    } catch (e) {
      if (!terminal(j)) {
        j.syncFailures = (j.syncFailures || 0) + 1;
        if (j.cancel && j.syncFailures >= 5) {
          finish(j, 'lost', '服务器连续无法响应，已停止本页跟踪。');
          return;
        }
        j.warn =
          (j.cancel ? '尚未确认取消，正在重试。' : '状态同步失败，正在重试。') +
          ' ' +
          e.message;
        render(j);
      }
    } finally {
      j.polling = false;
      if (!terminal(j))
        schedule(j, j.wake ? 0 : j.cancel ? 850 : j.warn ? 5000 : 2000);
    }
  }
  function requestCancel(j) {
    if (terminal(j) || j.cancel) return;
    j.cancel = true;
    j.absent = 0;
    j.syncFailures = 0;
    if (!j.sent) {
      j.preparation?.abort();
      finish(j, 'cancelled', '已在提交服务器前取消');
      return;
    }
    j.state = 'stopping';
    j.note = '正在请求取消…';
    render(j);
    persist();
    schedule(j, 0);
  }
  async function submit(j) {
    j.state = 'upload';
    j.note = '正在连接服务器…';
    render(j);
    let body;
    j.preparation = new AbortController();
    try {
      await probe(j.base, j.preparation.signal);
      if (terminal(j)) return;
      if ($('server').value.trim().replace(/\/+$/, '') === j.base) {
        connection('已连接', 'ok');
        $('serverError').textContent = '';
        remember(j.base);
      }
      const paths = [];
      for (let i = 0; i < j.files.length; i++) {
        if (terminal(j)) return;
        const file = j.files[i],
          key = j.uploadKeys?.[i];
        const cached = key && j.batchUploads?.get(key);
        if (cached) {
          paths.push(cached);
          continue;
        }
        j.note = '上传素材 ' + (i + 1) + ' / ' + j.files.length;
        render(j);
        const form = new FormData();
        form.append('image', file, file.name);
        form.append('type', 'input');
        form.append('subfolder', 'frameform');
        const saved = await api(
          j.base,
          '/upload/image',
          { method: 'POST', body: form, signal: j.preparation.signal },
          120000,
        );
        if (!saved.name) throw Error('服务器没有返回素材文件名。');
        const path = [saved.subfolder, saved.name].filter(Boolean).join('/');
        if (key) j.batchUploads?.set(key, path);
        paths.push(path);
      }
      if (terminal(j)) return;
      const graph = buildGraph(j, paths);
      if (mappedOutputs) j.outputNodes = outputNodeIds(graph);
      body = post({
        prompt: graph,
        client_id: j.client,
        prompt_id: j.client,
        ...(workbenchId && {
          extra_data: { frameform_workflow_id: workbenchId },
        }),
      });
    } catch (e) {
      if (
        !terminal(j) &&
        j.note === '正在连接服务器…' &&
        $('server').value.trim().replace(/\/+$/, '') === j.base
      ) {
        connection('连接失败', 'bad');
        $('serverError').textContent = e.message;
      }
      finish(j, 'failed', e.message);
      return;
    } finally {
      j.preparation = null;
      j.batchUploads = null;
      j.uploadKeys = null;
    }
    j.sent = true;
    j.state = 'sending';
    j.note = '等待服务器接收…';
    render(j);
    persist();
    attachSocket(j);
    try {
      const data = await api(j.base, '/prompt', body, 90000);
      if (terminal(j)) return;
      if (!data.prompt_id) throw Error('服务器未返回任务编号。');
      j.id = data.prompt_id;
      if (!j.cancel && j.state !== 'running') {
        j.state = 'queued';
        j.note = '已提交到服务器';
      }
    } catch (e) {
      if (terminal(j)) return;
      if (e.status >= 400 && e.status < 500 && e.status !== 408) {
        finish(j, 'failed', e.message);
        return;
      }
      j.state = j.cancel ? 'stopping' : 'unknown';
      j.warn = '提交结果待确认。' + e.message;
    } finally {
      j.files = [];
      j.prompt = '';
    }
    persist();
    render(j);
    schedule(j, 0);
  }
  const queueScans = new Map();
  function readQueue(base) {
    let request = queueScans.get(base);
    if (!request) {
      request = api(base, '/queue');
      queueScans.set(base, request);
      const clear = () => {
        if (queueScans.get(base) === request) queueScans.delete(base);
      };
      request.then(clear, clear);
    }
    return request;
  }
  async function scanRunning(base, reportErrors = false) {
    try {
      const queue = await readQueue(base);
      if (currentQueueBase() !== base) return;
      if (!Array.isArray(queue.queue_running))
        throw Error('服务器未返回运行队列。');
      const removed = readRemovedJobs();
      const existing = new Set(
        jobs.filter((j) => j.base === base && j.id).map((j) => j.id),
      );
      const submittingClients = new Set(
        jobs
          .filter((j) => j.base === base && j.sent && !j.id)
          .map((j) => j.client),
      );
      let next = Math.max(0, ...jobs.map((job) => job.n)),
        count = 0;
      for (const row of queue.queue_running) {
        if (!Array.isArray(row)) continue;
        const [, id, graph, meta] = row;
        if (
          workbenchId &&
          meta?.frameform_workflow_id &&
          meta.frameform_workflow_id !== workbenchId
        )
          continue;
        const client = serverJobKey(base, id);
        if (
          typeof id !== 'string' ||
          !id ||
          existing.has(id) ||
          removed.has(client) ||
          submittingClients.has(meta?.client_id)
        )
          continue;
        const mapped = matchWorkflow(graph);
        if (!mapped) continue;
        const job = {
          ...graphJobData(base, graph, mapped),
          ...(mappedOutputs && { outputNodes: outputNodeIds(graph, mapped) }),
          base,
          id,
          client,
          n: ++next,
          sent: true,
          imported: true,
          state: 'running',
          note: '从服务器同步',
          startedAt: Date.now(),
          observedStart: true,
        };
        existing.add(id);
        jobs.push(job);
        render(job);
        schedule(job, 1000);
        count++;
      }
      if (count) persist();
      $('queueSync').textContent = count
        ? '已载入 ' + count + ' 条服务器任务'
        : '';
    } catch (e) {
      if (reportErrors && currentQueueBase() === base)
        $('queueSync').textContent = '运行队列同步失败。' + e.message;
    }
  }
  function refreshCurrentQueue(reportErrors = false) {
    updateQueueTools();
    const base = currentQueueBase();
    if (!base) return;
    const refresh = scanRunning(base, reportErrors);
    for (const job of serverJobs(base))
      if (job.sent && !terminal(job)) schedule(job, 0);
    return refresh;
  }

  async function submitWaiting() {
    if (submitting) return;
    submitting = true;
    try {
      let j;
      while ((j = jobs.find((x) => x.state === 'local'))) await submit(j);
    } finally {
      submitting = false;
    }
  }

  function resume(job) {
    render(job);
    if (!terminal(job) && job.sent) {
      attachSocket(job);
      schedule(job, 0);
    }
  }

  function enqueue(values) {
    let next = Math.max(0, ...jobs.map((job) => job.n));
    for (const value of values) {
      const job = {
        ...value,
        client: uid(),
        n: ++next,
        state: 'local',
        note: '等待提交到服务器',
      };
      jobs.push(job);
      render(job);
    }
  }

  return {
    finish,
    refreshCurrentQueue,
    requestCancel,
    submitWaiting,
    resume,
    enqueue,
  };
}
