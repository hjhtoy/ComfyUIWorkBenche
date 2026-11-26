// The service marks only its own HTML. A standalone HTML keeps its legacy store.
const owningWindow = location.href === 'about:srcdoc' ? window.parent : window;
const marker =
  document.getElementById('frameformWorkspace') ||
  owningWindow.document.getElementById('frameformWorkspace');
export const hosted = !!marker;
const records = marker
  ? new Map(Object.entries(JSON.parse(marker.textContent)))
  : new Map();
const writes = new Map();
const empty = { rev: 0, value: null };

export async function workspaceRequest(route, method = 'GET', body) {
  const response = await fetch('/workspace/' + route, {
    method,
    headers: {
      'X-Frameform': '1',
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  if (!response.ok) {
    const message = await response.json().catch(() => null);
    const error = Error(
      message?.error || '无法访问工作区（HTTP ' + response.status + '）',
    );
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export function workspaceValue(key, fallback) {
  return structuredClone(records.get(key)?.value ?? fallback);
}

function recordRoute(key) {
  return 'records?' + new URLSearchParams({ key });
}

function serializeWrite(key, action) {
  const next = (writes.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(action);
  writes.set(key, next);
  const done = () => {
    if (writes.get(key) === next) writes.delete(key);
  };
  next.then(done, done);
  return next;
}

export function writeWorkspace(key, value) {
  const copy = structuredClone(value);
  return serializeWrite(key, async () => {
    const current = records.get(key) ?? empty;
    if (JSON.stringify(current.value) === JSON.stringify(copy)) return true;
    const result = await workspaceRequest(recordRoute(key), 'PUT', {
      rev: current.rev,
      value: copy,
    });
    records.set(key, result);
    return true;
  });
}

// Rerun only intent-based mutations (e.g. add one asset) after a concurrent edit.
export function updateWorkspace(key, fallback, edit) {
  return serializeWrite(key, async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await workspaceRequest(recordRoute(key));
      const value = structuredClone(current.value ?? fallback);
      const next = edit ? edit(value) : value;
      if (!edit || JSON.stringify(next) === JSON.stringify(current.value)) {
        records.set(key, current);
        return next;
      }
      try {
        records.set(
          key,
          await workspaceRequest(recordRoute(key), 'PUT', {
            rev: current.rev,
            value: next,
          }),
        );
        return next;
      } catch (error) {
        if (error.status !== 409 || attempt === 4) throw error;
      }
    }
  });
}

export async function workspaceFile(key, value) {
  const query = new URLSearchParams({ key });
  if (value !== undefined) {
    query.set('name', value.name || '');
    const res = await fetch('/workspace/media?' + query, {
      method: 'PUT',
      headers: {
        'X-Frameform': '1',
        'Content-Type': value.type || 'application/octet-stream',
      },
      body: value,
    });
    if (!res.ok) throw Error('素材写入工作区失败（HTTP ' + res.status + '）');
    return;
  }
  const res = await fetch('/workspace/media?' + query);
  if (res.status === 404) return null;
  if (!res.ok) throw Error('读取工作区媒体失败');
  const blob = await res.blob();
  return new File(
    [blob],
    decodeURIComponent(res.headers.get('X-File-Name') || ''),
    { type: blob.type },
  );
}

export function comfyURL(base, path) {
  return hosted
    ? '/workspace/comfy?' + new URLSearchParams({ base, path })
    : base + path;
}

if (hosted) {
  window.addEventListener('beforeunload', (event) => {
    if (writes.size) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}

const watchers = new Map();
let checking = false;
export function watchWorkspace(key, apply, ready = () => true) {
  if (!hosted) return;
  watchers.set(key, { apply, ready });
  if (watchers.size !== 1) return;
  async function refresh() {
    if (checking || !watchers.size) return;
    checking = true;
    try {
      const revisions = await workspaceRequest('versions');
      for (const [key, { apply, ready }] of watchers) {
        if (
          !ready() ||
          writes.has(key) ||
          !revisions[key] ||
          records.get(key)?.rev === revisions[key]
        )
          continue;
        const before = records.get(key)?.rev;
        const row = await workspaceRequest(recordRoute(key));
        if (writes.has(key) || records.get(key)?.rev !== before || !ready())
          continue;
        records.set(key, row);
        await apply(structuredClone(row.value));
      }
    } catch {
      /* The next refresh resumes after the connection returns. */
    } finally {
      checking = false;
    }
  }
  setInterval(refresh, 1500);
  window.addEventListener('focus', refresh);
}
