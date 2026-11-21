import { $ } from './ui/dom.js';
import { setupComposer } from './ui/composer.js';
import { setupParameters } from './ui/parameters.js';
import { serverAddress, setupServers } from './ui/servers.js';
import { setupSettings } from './ui/settings.js';
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
  const runner = setupRunner(queue);

  setupSettings();
  setupBatch(composer, runner, queue);
  $('generate').onclick = () => {
    $('formError').textContent = '';
    try {
      const base = serverAddress();
      runner.enqueue([{ ...composer.snapshot(), base }]);
      runner.submitWaiting();
    } catch (error) {
      $('formError').textContent = error.message;
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

  restoreJobs(runner.resume);
  composer.restoreDraft();
  runner.refreshCurrentQueue();
  return { composer, player, queue, runner };
}
