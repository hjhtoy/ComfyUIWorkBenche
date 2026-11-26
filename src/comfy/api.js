import { comfyURL, hosted, workspaceRequest } from '../storage/workspace.js';
const runninghubHost = (value) => {
  try {
    return /^(www\.)?runninghub\.(cn|ai)$/i.test(new URL(value).hostname);
  } catch {
    return false;
  }
};
function normalizeServer(value) {
  let u;
  try {
    u = new URL(value.trim());
  } catch {}
  if (
    !u ||
    !['http:', 'https:'].includes(u.protocol) ||
    u.search ||
    u.hash ||
    u.username ||
    u.password
  )
    throw Error('请填写完整的 HTTP 或 HTTPS 服务器地址，可包含代理路径。');
  return u.href.replace(/\/+$/, '');
}
function apiMessage(body) {
  const main = body?.error;
  const reasons = Object.entries(body?.node_errors || {}).map(
    ([id, node]) =>
      '节点 ' +
      id +
      ' ' +
      (node.class_type || '') +
      ' · ' +
      (node.errors || [])
        .map((e) => [e.message, e.details].filter(Boolean).join(' — '))
        .join('\n'),
  );
  return [
    typeof main === 'string'
      ? main
      : [main?.message, main?.details].filter(Boolean).join(' — '),
    ...reasons,
  ]
    .filter(Boolean)
    .join('\n');
}
async function api(base, path, options = {}, timeout = 12000) {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), timeout);
  try {
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    const response = await fetch(comfyURL(base,path), {
      cache: 'no-store',
      ...options,
      signal,
    });
    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {}
    if (!response.ok) {
      const err = Error(
        'HTTP ' +
          response.status +
          ' · ' +
          (apiMessage(data) || raw.slice(0, 320) || response.statusText),
      );
      err.status = response.status;
      throw err;
    }
    if (raw.trim() && data === undefined)
      throw Error('服务器返回了非 JSON 内容，请检查 API 地址和代理设置。');
    return data ?? {};
  } catch (e) {
    if (e.name === 'AbortError')
      throw Error('请求超时，请检查服务器状态和网络。');
    if (e instanceof TypeError)
      throw Error(
        '连接失败。请检查服务器地址、网络和跨域（CORS）配置；HTTPS 页面需连接 HTTPS 服务。',
      );
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
const post = (data) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data),
});
function outputURL(j, x) {
  return (
    comfyURL(j.base, '/view?' +
    new URLSearchParams({
      filename: x.filename,
      subfolder: x.subfolder,
      type: x.type,
    }))
  );
}
async function probe(base, signal) {
  // The RunningHub OpenAPI has no /system_stats; its key lives on the host.
  if (runninghubHost(base)) {
    if (!hosted)
      throw Error('RunningHub 需要以工作区模式打开（npm start），浏览器直连会被跨域拦截。');
    const data = await workspaceRequest('provider');
    if (!data.runninghub)
      throw Error('请先在设置 → RunningHub 中配置 API Key。');
    return;
  }
  const stats = await api(base, '/system_stats', { signal });
  if (!stats.system || !Array.isArray(stats.devices))
    throw Error('该地址没有返回 ComfyUI 系统信息，请检查端口和代理路径。');
}

export { normalizeServer, api, post, outputURL, probe, runninghubHost };
