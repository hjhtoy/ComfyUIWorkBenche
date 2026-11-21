import { api } from '../comfy/api.js';
import { matchWorkflow, graphJobData } from '../comfy/workflow.js';
import { terminal, hasJobForm, jobKey } from './state.js';
import { historyKey, persist } from '../storage/jobs.js';
import { readLocal } from '../storage/browser.js';

function restoreHistoryForm(job, entry) {
  if (hasJobForm(job) || job.removed) return;
  const graph = Array.isArray(entry?.prompt)
    ? entry.prompt[2]
    : entry?.prompt?.prompt || entry?.prompt;
  const mapped = matchWorkflow(graph);
  if (!mapped) return;
  const restored = graphJobData(job.base, graph, mapped);
  job.form = restored.form;
  job.title ||= restored.title;
  job.dimensions ||= restored.dimensions;
  job.duration ??= restored.duration;
  job.steps ??= restored.steps;
}
async function ensureJobForm(job, render) {
  if (hasJobForm(job)) return true;
  const saved = readLocal(historyKey, []).find(
    (entry) => jobKey(entry) === jobKey(job) && hasJobForm(entry),
  );
  if (saved) {
    job.form = saved.form;
    return true;
  }
  if (!job.id || !job.base || !terminal(job) || job.removed) return false;
  if (!job.detailsRequest) {
    job.detailsError = '';
    job.detailsRequest = (async () => {
      try {
        const response = await api(
          job.base,
          '/history/' + encodeURIComponent(job.id),
        );
        restoreHistoryForm(job, response[job.id]);
        if (hasJobForm(job)) {
          render(job);
          persist();
          return true;
        }
        return false;
      } catch (e) {
        job.detailsError = '暂时无法读取 ComfyUI 历史记录。' + e.message;
        return false;
      } finally {
        job.detailsRequest = null;
      }
    })();
  }
  return job.detailsRequest;
}

export { restoreHistoryForm, ensureJobForm };
