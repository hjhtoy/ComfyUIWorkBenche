import { hosted } from './storage/workspace.js';
import { setupWorkspaceRunner } from './jobs/workspace-runner.js';
import { $ } from './ui/dom.js';
import { setupComposer } from './ui/composer.js';
import { setupParameters } from './ui/parameters.js';
import { serverAddress, setupServers } from './ui/servers.js';
import { setupSettings } from './ui/settings.js';
import { setupStandaloneNotice } from './ui/standalone.js';
import { setupBatch } from './batch/dialog.js';
import { setupPlayer } from './jobs/player.js';
import { setupQueueView } from './jobs/queue-view.js';
import { setupRunner } from './jobs/runner.js';
import { restoreJobs } from './storage/jobs.js';

export function startWorkbench() {
  setupParameters();

  const servers = setupServers({
    updateQueueTools: () => queue.updateQueueTools(),
    refreshCurrentQueue: (reportErrors) =>
      runner.refreshCurrentQueue(reportErrors),
    saveDraft: () => composer.saveDraft(),
  });
  const composer = setupComposer(servers.serverChanged);
  const player = setupPlayer(composer, (job) => queue.render(job));
  const queue = setupQueueView({
    ...player,
    requestCancel: (job) => runner.requestCancel(job),
  });
  const runner = hosted ? setupWorkspaceRunner(queue) : setupRunner(queue);

  setupSettings();
  setupStandaloneNotice();
  setupBatch(composer, runner, queue);
  $('generate').onclick = async () => {
    if ($('generate').disabled) return;
    const label = $('generateLabel');
    $('generate').disabled = true;
    $('formError').classList.remove('success');
    $('formError').textContent = '';
    label.textContent = '正在加入…';
    try {
      const base = serverAddress();
      await runner.enqueue([{ ...composer.snapshot(), base }]);
      runner.submitWaiting();
      label.textContent = '已加入队列';
      $('formError').textContent = '任务已加入队列，可在下方查看进度。';
      $('formError').classList.add('success');
      setTimeout(() => {
        if ($('generateLabel').textContent !== '已加入队列') return;
        $('generateLabel').textContent = '加入生成队列';
        $('formError').textContent = '';
        $('formError').classList.remove('success');
      }, 2500);
    } catch (error) {
      label.textContent = '加入生成队列';
      $('formError').textContent = error.message;
    } finally {
      $('generate').disabled = false;
    }
  };
  composer.editor.onkeydown = (event) => {
    if (
      event.key === 'Enter' &&
      (event.ctrlKey || event.metaKey) &&
      !event.isComposing
    ) {
      event.preventDefault();
      $('generate').click();
    }
  };
  const links = document.querySelectorAll('.links a');
  for (const link of links) {
    link.onclick = () => {
      for (const item of links) item.classList.toggle('active', item === link);
    };
  }

  if (!hosted) restoreJobs(runner.resume);
  composer.restoreDraft();
  runner.refreshCurrentQueue();
  window.addEventListener('frameform:activate', () =>
    runner.refreshCurrentQueue(),
  );
  document.documentElement.dataset.workbenchReady = 'true';
  return { composer, player, queue, runner };
}
