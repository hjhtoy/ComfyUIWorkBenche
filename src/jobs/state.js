const jobs = [];
const states = {
  local: '等待提交',
  upload: '准备提交',
  sending: '正在提交',
  unknown: '核对提交状态',
  queued: '服务器排队',
  running: '生成中',
  stopping: '取消中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
  lost: '已停止跟踪',
};
const terminal = (j) =>
  ['done', 'failed', 'cancelled', 'lost'].includes(j.state);
const serverJobKey = (base, id) => 'server-job:' + JSON.stringify([base, id]);
const jobKey = (j) => (j.id ? serverJobKey(j.base, j.id) : j.client);
const isJobDeleted = (removed, j) =>
  removed.has(j.client) || removed.has(jobKey(j));
function hasJobForm(job) {
  return typeof job?.form?.html === 'string' && Array.isArray(job.form.refs);
}
function mergeJobRecord(previous, next) {
  if (hasJobForm(previous) && !hasJobForm(next)) {
    return {
      ...next,
      form: previous.form,
      dimensions: next.dimensions || previous.dimensions,
      duration: next.duration ?? previous.duration,
      steps: next.steps ?? previous.steps,
    };
  }
  return next;
}
function jobParams(j) {
  return [
    j.form?.ratio,
    j.dimensions,
    j.duration != null ? j.duration + ' 秒' : null,
    j.steps != null ? j.steps + ' 步' : null,
  ]
    .filter(Boolean)
    .join('  ·  ');
}
function timeText(j) {
  if (!j.startedAt && !terminal(j)) return '';
  if (!j.startedAt && !j.endedAt) return '';
  const elapsed = j.startedAt
    ? Math.floor(Math.max(0, (j.endedAt || Date.now()) - j.startedAt) / 1000)
    : 0;
  const parts = [Math.floor(elapsed / 60), elapsed % 60];
  if (parts[0] >= 60)
    parts.splice(0, 1, Math.floor(parts[0] / 60), parts[0] % 60);
  const label = j.observedStart
    ? j.endedAt
      ? '跟踪耗时 '
      : '已跟踪 '
    : j.endedAt
      ? '总耗时 '
      : '运行 ';
  return label + parts.map((n) => String(n).padStart(2, '0')).join(':');
}
function startClock(j, timestamp) {
  const reported = Number(timestamp);
  if (reported > 1e12 && reported <= Date.now() + 60000) {
    j.startedAt = reported;
    j.observedStart = false;
  } else j.startedAt ||= Date.now();
}

export {
  jobs,
  states,
  terminal,
  serverJobKey,
  jobKey,
  isJobDeleted,
  hasJobForm,
  mergeJobRecord,
  jobParams,
  timeText,
  startClock,
};
