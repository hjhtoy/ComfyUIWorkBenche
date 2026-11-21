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
    const response = await fetch(base + path, {
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
    j.base +
    '/view?' +
    new URLSearchParams({
      filename: x.filename,
      subfolder: x.subfolder,
      type: x.type,
    })
  );
}
async function probe(base, signal) {
  const stats = await api(base, '/system_stats', { signal });
  if (!stats.system || !Array.isArray(stats.devices))
    throw Error('该地址没有返回 ComfyUI 系统信息，请检查端口和代理路径。');
}

export { normalizeServer, api, post, outputURL, probe };
