export const isH3Conditioning = (type) =>
  type === 'MiniMaxH3ReferenceToVideo' || type === 'MiniMaxH3ImageToVideo';

const isRecord = (value) =>
  value && typeof value === 'object' && !Array.isArray(value);

export function parseWorkflow(source) {
  let document;
  try {
    document = JSON.parse(source.replace(/^\uFEFF/, ''));
  } catch {
    throw Error('无法读取 JSON。请确认文件完整且为 UTF-8 编码。');
  }
  if (Array.isArray(document?.nodes))
    throw Error('这是 ComfyUI 编辑器格式。请在 ComfyUI 中重新导出 API 格式。');
  const graph =
    isRecord(document?.prompt) && !isRecord(document.prompt.inputs)
      ? document.prompt
      : document;
  if (
    !isRecord(graph) ||
    !Object.keys(graph).length ||
    !Object.values(graph).every(
      (node) =>
        isRecord(node) &&
        typeof node.class_type === 'string' &&
        node.class_type.trim() &&
        isRecord(node.inputs),
    )
  )
    throw Error(
      '需要 ComfyUI API 节点图。每个节点应包含 class_type 和 inputs。',
    );
  return graph;
}

export function stableGraph(value) {
  if (Array.isArray(value)) return '[' + value.map(stableGraph).join(',') + ']';
  if (isRecord(value))
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + stableGraph(value[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}

export function field(graph, pair) {
  return pair && graph[pair[0]]?.inputs[pair[1]];
}

export function isLink(graph, value) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    Object.hasOwn(graph, value[0]) &&
    Number.isInteger(value[1]) &&
    value[1] >= 0
  );
}

const primitive = new Set([
  'PrimitiveString',
  'PrimitiveStringMultiline',
  'PrimitiveInt',
  'PrimitiveFloat',
  'PrimitiveBoolean',
]);

function switchPort(graph, node) {
  const choice = node.inputs.switch;
  const control = isLink(graph, choice) && graph[choice[0]];
  const value =
    control?.class_type === 'PrimitiveBoolean' ? control.inputs.value : choice;
  return typeof value === 'boolean' ? (value ? 'on_true' : 'on_false') : null;
}

export function activeNodes(graph, outputs) {
  const seen = new Set();
  const pending = [...outputs];
  while (pending.length) {
    const id = pending.shift();
    if (seen.has(id) || !Object.hasOwn(graph, id)) continue;
    seen.add(id);
    const node = graph[id];
    const port =
      node.class_type === 'ComfySwitchNode' && switchPort(graph, node);
    const values = port
      ? [node.inputs.switch, node.inputs[port]]
      : Object.values(node.inputs);
    for (const value of values)
      if (isLink(graph, value)) pending.push(value[0]);
  }
  return [...seen];
}

// Follow the writable end of known pass-through nodes on the selected branch.
export function sourceField(graph, pair) {
  const visited = new Set();
  while (pair) {
    const key = JSON.stringify(pair);
    if (visited.has(key)) return null;
    visited.add(key);
    const value = field(graph, pair);
    if (!isLink(graph, value)) return value === undefined ? null : pair;
    const [id, output] = value;
    if (output !== 0) return null;
    const node = graph[id];
    if (primitive.has(node.class_type)) pair = [id, 'value'];
    else if (node.class_type === 'PreviewAny') pair = [id, 'source'];
    else if (node.class_type === 'ComfySwitchNode') {
      const port = switchPort(graph, node);
      pair = port ? [id, port] : null;
    } else return null;
  }
  return null;
}

export function fieldLabel(graph, pair) {
  return pair[0] + ' · ' + graph[pair[0]].class_type + ' · ' + pair[1];
}
