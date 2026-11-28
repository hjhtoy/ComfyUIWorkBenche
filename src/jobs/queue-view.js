import { hosted, workspaceRequest } from '../storage/workspace.js';
import { $, elem, button } from '../ui/dom.js';
import { currentQueueBase } from '../ui/servers.js';
import { writeLocal, readLocal } from '../storage/browser.js';
import {
  jobs,
  states,
  terminal,
  jobKey,
  isJobDeleted,
  jobParams,
  timeText,
} from './state.js';
import { deletedJobsKey, readRemovedJobs, persist } from '../storage/jobs.js';
import {
  videoOf,
  stillOf,
  setPoster,
  downloadable,
  clearOutputCache,
  deleteOutputFiles,
  outputBlob,
  downloadOutput,
  outputFilename,
  triggerDownload,
  zipOutputs,
} from '../media/outputs.js';

export function serverJobs(base = currentQueueBase()) {
  return jobs.filter((j) => j.base === base);
}

export function setupQueueView({
  selectJob,
  updatePlayer,
  dropSelectionForServer,
  releaseJob,
  requestCancel,
}) {
  // Sorting is a view preference: the job number keeps its original order.
  const sortKey = 'frameform.queue-sort.v1';
  const sortOptions = new Set([
    'default',
    'name:asc',
    'name:desc',
    'duration:asc',
    'duration:desc',
    'elapsed:asc',
    'elapsed:desc',
  ]);
  let queueSort = readLocal(sortKey, 'default');
  if (!sortOptions.has(queueSort)) queueSort = 'default';
  $('queueSort').value = queueSort;

  function sortValue(j, field) {
    if (field === 'name') return j.title || '';
    if (field === 'duration')
      return typeof j.duration === 'number' && Number.isFinite(j.duration)
        ? j.duration
        : null;
    // Elapsed only exists once a job finished; running jobs stay at the end.
    if (field === 'elapsed')
      return j.startedAt && j.endedAt ? j.endedAt - j.startedAt : null;
    return null;
  }
  function orderedJobs() {
    const list = jobs.filter((j) => j.row && !j.removed);
    const newestFirst = (a, b) => (b.n || 0) - (a.n || 0);
    const [field, direction] = queueSort.split(':');
    if (!direction) return list.sort(newestFirst);
    const sign = direction === 'desc' ? -1 : 1;
    return list.sort((a, b) => {
      const left = sortValue(a, field);
      const right = sortValue(b, field);
      if (left === null || right === null) {
        if (left === null && right === null) return newestFirst(a, b);
        // Jobs without the metric go last in either direction.
        return left === null ? 1 : -1;
      }
      const result =
        typeof left === 'string'
          ? left.localeCompare(right, 'zh-Hans-CN', { numeric: true })
          : left - right;
      return result ? result * sign : newestFirst(a, b);
    });
  }
  function applyQueueOrder() {
    const container = $('jobs');
    const wanted = orderedJobs();
    const current = [...container.children];
    if (
      wanted.length === current.length &&
      wanted.every((job, index) => job.row === current[index])
    )
      return;
    for (const job of wanted) container.append(job.row);
  }
  $('queueSort').onchange = () => {
    queueSort = $('queueSort').value;
    writeLocal(sortKey, queueSort);
    applyQueueOrder();
  };

  function coverIcon(j) {
    const cover = j.cover;
    if (j.coverState === j.state) return;
    j.coverState = j.state;
    const playable = j.state === 'done' && !!(videoOf(j) || stillOf(j));

    cover.classList.toggle(
      'failed',
      j.state === 'failed' || j.state === 'lost',
    );
    cover.replaceChildren();
    if (playable) {
      const poster = elem('img');
      poster.alt = '';
      poster.onerror = () => {
        poster.remove();
      };
      cover.append(poster, elem('span', 'playmark', videoOf(j) ? '▶' : '查看'));
      j.posterRevision = 0;
      setPoster(j, poster);
      cover.setAttribute(
        'aria-label',
        videoOf(j) ? '播放任务 ' + j.n : '查看任务 ' + j.n + ' 图片',
      );
    } else {
      const symbol = terminal(j) ? (j.state === 'cancelled' ? '—' : '!') : '';
      const icon = elem(
        'span',
        terminal(j) ? 'terminal-mark' : 'spinner',
        symbol,
      );
      icon.setAttribute('aria-hidden', 'true');
      cover.append(icon);
      cover.setAttribute('aria-label', '查看任务详情 ' + j.n + ' · ' + states[j.state]);
    }
  }
  function render(j) {
    if (j.removed) return;
    if (!j.row) {
      j.row = elem('article', 'job');
      j.check = elem('input', 'job-check');
      j.check.type = 'checkbox';
      j.check.setAttribute('aria-label', '勾选任务 ' + j.n);
      j.check.onchange = () => {
        if (j.check.checked) batchSelection.add(j.client);
        else batchSelection.delete(j.client);
        updateQueueTools();
      };
      j.cover = button('', () => selectJob(j, true));
      j.cover.className = 'job-cover';
      const content = elem('div', 'job-content');
      const line = elem('div', 'queue-line');
      j.nameEl = button('', () => selectJob(j));
      j.nameEl.className = 'job-name job-name-button';
      j.act = elem('div', 'job-act');
      j.copy = button('复制 ID', () => copyTaskId(j));
      j.copy.setAttribute('aria-label', '复制任务 ID');
      j.download = button('下载', () => downloadSelected([j], false));
      j.remove = button('删除', () => confirmRemoval([j]));
      j.remove.classList.add('danger');
      j.cancelButton = button('取消', () => requestCancel(j));
      j.act.append(j.download, j.copy, j.remove, j.cancelButton);
      line.append(j.nameEl, j.act);
      const details = elem('div', 'job-details');
      j.badge = elem('span', 'state');
      j.clock = elem('span', 'note job-clock');
      j.meta = elem('span', 'note');
      j.stageEl = elem('span', 'note job-stage');
      details.append(j.badge, j.clock, j.meta, j.stageEl);
      if (j.imported) details.append(elem('span', 'state', '服务器同步'));
      j.metrics = elem('div', 'job-metrics');
      j.info = elem('div', 'notice');
      j.info.setAttribute('role', 'status');
      j.bar = elem('progress', 'progress');
      j.bar.setAttribute('aria-label', '任务阶段进度');
      content.append(line, details, j.metrics, j.bar, j.info);
      j.row.append(j.check, j.cover, content);
      j.row.onclick = (e) => {
        if (!e.target.closest('button,input')) selectJob(j);
      };
      $('jobs').prepend(j.row);
    }
    coverIcon(j);
    j.nameEl.textContent = String(j.n).padStart(2, '0') + '　' + j.title;
    j.nameEl.title = j.title;
    j.badge.textContent = states[j.state];
    j.badge.className =
      'state ' +
      (j.state === 'done'
        ? 'success'
        : j.state === 'failed' || j.state === 'lost'
          ? 'failure'
          : terminal(j)
            ? ''
            : 'live');
    j.clock.textContent = timeText(j);
    j.metrics.textContent = jobParams(j);
    j.meta.textContent = j.note || '';
    // Standalone mode already folds the node text into the note; hosted mode
    // keeps the server note and adds the live node/step line beside it.
    j.stageEl.textContent = j.stage && j.stage !== j.note ? j.stage : '';
    j.stageEl.hidden = !j.stageEl.textContent;
    j.info.textContent = [j.warn, j.mediaNote].filter(Boolean).join('\n');
    // An unmeasured bar only means "busy"; queued jobs must not look half done.
    j.bar.hidden = terminal(j) || (!j.total && j.state !== 'running');
    j.bar.max = j.total || 1;
    if (j.value == null) j.bar.removeAttribute('value');
    else j.bar.value = j.value;
    j.copy.hidden = !j.id;
    j.download.hidden = !downloadable(j);
    j.remove.hidden = !terminal(j);
    j.remove.disabled = !!j.archivePending;
    j.remove.title = j.archivePending ? '正在保存结果' : '';
    j.cancelButton.hidden = terminal(j);
    j.cancelButton.textContent = j.cancel ? '等待确认' : '取消';
    j.cancelButton.disabled = !!j.cancel;
    updatePlayer(j);
    updateQueueTools();
    applyQueueOrder();
  }
  setInterval(() => {
    for (const j of jobs)
      if (j.clock && j.startedAt && !terminal(j))
        j.clock.textContent = timeText(j);
  }, 1000);
  const batchSelection = new Set();
  const queueTabs = [...$('queueTabs').querySelectorAll('[role="tab"]')];
  let queueFilter = 'all';
  const queueFilters = {
    all: () => true,
    processing: (job) => !terminal(job),
    done: (job) => job.state === 'done',
    cancelled: (job) => job.state === 'cancelled',
    failed: (job) => job.state === 'failed' || job.state === 'lost',
  };
  const queueEmptyLabels = {
    all: '当前服务器暂无任务',
    processing: '暂无处理中的任务',
    done: '暂无已完成的任务',
    cancelled: '暂无已取消的任务',
    failed: '暂无失败的任务',
  };
  let shownQueueBase;
  let downloadingJobs = false;
  let pendingDeletes = [];
  const deleteDialog = $('deleteTasks');
  function queueNotice(message, warning = false) {
    const node = $('queueNotice');
    node.textContent = message;
    node.classList.toggle('danger', warning);
  }
  function visibleJobs(base = currentQueueBase()) {
    return serverJobs(base).filter(queueFilters[queueFilter]);
  }
  function activateQueueTab(tab) {
    if (queueFilter === tab.dataset.filter) return;
    queueFilter = tab.dataset.filter;
    batchSelection.clear();
    queueNotice('');
    for (const option of queueTabs) {
      const active = option === tab;
      option.setAttribute('aria-selected', String(active));
      option.tabIndex = active ? 0 : -1;
    }
    $('queuePanel').setAttribute('aria-labelledby', tab.id);
    updateQueueTools();
  }
  for (const [index, tab] of queueTabs.entries()) {
    tab.onclick = () => activateQueueTab(tab);
    tab.onkeydown = (event) => {
      let next;
      switch (event.key) {
        case 'ArrowLeft':
          next = (index + queueTabs.length - 1) % queueTabs.length;
          break;
        case 'ArrowRight':
          next = (index + 1) % queueTabs.length;
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = queueTabs.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      queueTabs[next].focus();
      activateQueueTab(queueTabs[next]);
    };
  }
  function updateQueueTools() {
    const base = currentQueueBase();
    if (shownQueueBase !== base) {
      shownQueueBase = base;
      batchSelection.clear();
      queueNotice('');
      dropSelectionForServer(base);
    }
    const onServer = serverJobs(base);
    const visible = onServer.filter(queueFilters[queueFilter]);
    for (const tab of queueTabs) {
      const count = onServer.filter(queueFilters[tab.dataset.filter]).length;
      const badge = tab.querySelector('.queue-tab-count');
      if (badge.textContent !== String(count)) {
        badge.textContent = String(count);
        tab.setAttribute('aria-description', count + ' 条任务');
      }
    }
    const shown = new Set(visible);
    const selected = visible.filter((j) => batchSelection.has(j.client));
    $('empty').hidden = visible.length > 0;
    $('queueEmptyTitle').textContent = base
      ? queueEmptyLabels[queueFilter]
      : '请输入有效的服务器地址';
    $('queueEmptyHint').textContent = !base
      ? '选择已保存的地址，或输入服务器 URL。'
      : queueFilter === 'all'
        ? '提交任务后，可以在这里查看进度或取消任务。'
        : '切回「全部」可查看当前服务器的所有任务。';
    $('queueTools').hidden = visible.length === 0;
    $('jobCount').textContent = String(visible.length).padStart(2, '0');
    $('selectedCount').textContent = selected.length
      ? '已选 ' + selected.length + ' 条'
      : '';
    const all = $('selectAllJobs');
    all.checked = visible.length > 0 && selected.length === visible.length;
    all.indeterminate = selected.length > 0 && selected.length < visible.length;
    $('batchDownload').disabled =
      downloadingJobs || !selected.some(downloadable);
    const pending = selected.some((j) => !terminal(j) || j.archivePending);
    $('batchDelete').disabled = !selected.length || pending;
    $('batchDelete').title = pending
      ? '请等待选中的任务执行并保存结果'
      : '';
    for (const j of jobs) {
      j.row.hidden = !shown.has(j);
      if (j.row.hidden) batchSelection.delete(j.client);
      const checked = batchSelection.has(j.client);
      j.check.checked = checked;
      j.row.classList.toggle('act-selected', checked);
      j.download.disabled = downloadingJobs;
    }
  }
  $('selectAllJobs').onchange = () => {
    batchSelection.clear();
    if ($('selectAllJobs').checked)
      for (const j of visibleJobs()) batchSelection.add(j.client);
    updateQueueTools();
  };
  $('batchDownload').onclick = () =>
    downloadSelected(
      visibleJobs().filter((j) => batchSelection.has(j.client)),
      true,
    );
  $('batchDelete').onclick = () =>
    confirmRemoval(visibleJobs().filter((j) => batchSelection.has(j.client)));

  async function copyTaskId(j) {
    if (!j.id) return;
    try {
      await navigator.clipboard.writeText(j.id);
    } catch {
      const field = elem('textarea');
      field.value = j.id;
      field.style.cssText = 'position:fixed;left:-9999px';
      document.body.append(field);
      field.select();
      let copied = false;
      try {
        copied = document.execCommand('copy');
      } catch {
      } finally {
        field.remove();
        j.copy.focus();
      }
      if (!copied) {
        queueNotice('无法访问剪贴板。可手动复制任务 ID ' + j.id, true);
        return;
      }
    }
    queueNotice('已复制任务 ID ' + j.id);
  }

  function confirmRemoval(tasks) {
    if (!tasks.length || tasks.some((j) => !terminal(j) || j.archivePending)) return;
    pendingDeletes = tasks;
    $('deleteMessage').textContent = '将删除 ' + tasks.length + ' 条任务记录。';
    $('deleteFiles').checked = false;
    $('deleteError').textContent = '';
    deleteDialog.showModal();
    $('keepTasks').focus();
  }
  $('keepTasks').onclick = () => deleteDialog.close();
  deleteDialog.onclose = () => {
    pendingDeletes = [];
  };
  deleteDialog.oncancel = (event) => {
    if ($('confirmDelete').disabled) event.preventDefault();
  };
  $('confirmDelete').onclick = async () => {
    const tasks = pendingDeletes.filter((j) => jobs.includes(j) && terminal(j));
    if (!tasks.length) {
      deleteDialog.close();
      return;
    }
    const deleteFiles = $('deleteFiles').checked;
    $('confirmDelete').disabled = $('keepTasks').disabled = $('deleteFiles').disabled = true;
    $('deleteError').textContent = '';
    try {
      if (hosted) {
        // Older servers only expose /workspace/delete and ignore the file option.
        await workspaceRequest('jobs/delete', 'POST', {
          clients: tasks.map((job) => job.client),
          deleteFiles,
        });
        removeDeletedRows(new Set(tasks.map(j => j.client)));
      } else {
        const removed = readRemovedJobs();
        for (const j of tasks) {
          if (deleteFiles) {
            await deleteOutputFiles(j);
            await clearOutputCache(j);
          } else await j.savingOutputs;
          removed.add(j.client);
          removed.add(jobKey(j));
        }
        if (!writeLocal(deletedJobsKey, [...removed]))
          throw Error('无法保存删除操作。请检查浏览器存储设置。');
        removeDeletedRows(removed);
      }
      deleteDialog.close();
      queueNotice('已删除 ' + tasks.length + ' 条任务记录', true);
    } catch (error) {
      $('deleteError').textContent = error.message;
    } finally {
      $('confirmDelete').disabled = $('keepTasks').disabled = $('deleteFiles').disabled = false;
    }
  };
  function removeDeletedRows(removed) {
    let changed = false;
    for (let i = jobs.length - 1; i >= 0; i--) {
      const j = jobs[i];
      if (!isJobDeleted(removed, j)) continue;
      j.removed = true;
      clearTimeout(j.timer);
      clearTimeout(j.reconnect);
      if (j.ws) {
        j.ws.onclose = null;
        j.ws.close();
        j.ws = null;
      }
      changed = true;
      releaseJob(j);
      if (j.posterURL) URL.revokeObjectURL(j.posterURL);
      batchSelection.delete(j.client);
      j.row.remove();
      jobs.splice(i, 1);
    }
    if (changed) {
      updateQueueTools();
      persist();
    }
  }
  window.addEventListener('storage', (event) => {
    if (event.key === deletedJobsKey) removeDeletedRows(readRemovedJobs());
  });
  async function downloadSelected(tasks, zip) {
    if (downloadingJobs) return;
    const targets = tasks.filter(downloadable);
    if (!targets.length) return;
    downloadingJobs = true;
    updateQueueTools();
    const errors = [];
    try {
      if (!zip) {
        const [job] = targets;
        await downloadOutput(job, downloadable(job));
        queueNotice('已提交下载');
        return;
      }
      const files = [];
      const skipped = tasks.length - targets.length;
      for (const [index, job] of targets.entries()) {
        const item = downloadable(job);
        queueNotice(
          '正在读取 ' + (index + 1) + ' / ' + targets.length + ' 个结果…',
        );
        try {
          const data = await outputBlob(job, item);
          files.push({
            data,
            name:
              '任务-' + job.n + '-' + (index + 1) + '-' + outputFilename(item),
          });
        } catch (e) {
          errors.push('任务 ' + job.n + ' 获取失败（' + e.message + '）');
        }
      }
      if (files.length) {
        queueNotice('正在打包 ' + files.length + ' 个文件…');
        const date = new Date().toISOString().slice(0, 10);
        triggerDownload(await zipOutputs(files), 'Frameform-' + date + '.zip');
      }
      const messages = [];
      if (files.length)
        messages.push('已提交 ZIP 下载，共 ' + files.length + ' 个文件');
      if (skipped) messages.push('跳过 ' + skipped + ' 条无可下载结果的任务');
      queueNotice([...messages, ...errors].join('。'), errors.length > 0);
    } catch (e) {
      queueNotice('下载失败。' + e.message, true);
    } finally {
      downloadingJobs = false;
      updateQueueTools();
    }
  }

  return { render, updateQueueTools, activateQueueTab, queueNotice, removeRows:removeDeletedRows };
}
