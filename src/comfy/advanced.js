import {
  activeNodes,
  field,
  isH3Conditioning,
  isLink,
  sourceField,
} from '../library/graph.js';

export const fieldKey = (pair) => JSON.stringify(pair);
const scalar = (value) =>
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  (typeof value === 'number' &&
    Number.isFinite(value) &&
    (!Number.isInteger(value) || Number.isSafeInteger(value)));

const materialFiles = {
  LoadImage: 'image',
  LoadVideo: 'file',
  LoadAudio: 'audio',
  VHS_LoadVideo: 'video',
};

export function protectedFields(graph, profile) {
  const fields = new Map();
  const add = (pair, reason) => {
    if (pair) fields.set(fieldKey(pair), reason);
  };
  for (const pair of [
    profile.prompt,
    profile.duration?.field,
    profile.steps?.field,
    profile.size?.ratio,
    profile.size?.megapixels,
    profile.size?.width,
    profile.size?.height,
  ])
    add(pair, '已由常用控件设置');
  for (const slot of profile.references ?? []) {
    add(slot.file, '由素材选择器设置');
    for (const pair of slot.targets) add(pair, '素材连接');
  }
  for (const id of activeNodes(graph, profile.outputs ?? [])) {
    const node = graph[id];
    const length = node.inputs.length;
    if (
      profile.duration?.alignment &&
      isH3Conditioning(node.class_type) &&
      isLink(graph, length) &&
      graph[length[0]].class_type === 'ComfyMathExpression'
    )
      add([length[0], 'expression'], '用于视频时长与帧数对齐');
    if (node.class_type === 'ComfySwitchNode')
      add(sourceField(graph, [id, 'switch']), '决定常用控件的映射分支');
    if (profile.size?.mode === 'selector' && id === profile.size.megapixels[0])
      add([id, 'multiple'], '用于计算当前分辨率');
    if (profile.fps && node.class_type === 'CreateVideo')
      add(sourceField(graph, [id, 'fps']), '用于计算视频时长');
    if (profile.fps && node.class_type === 'VHS_VideoCombine')
      add(sourceField(graph, [id, 'frame_rate']), '用于计算视频时长');
  }
  return fields;
}

function inputSpec(registry, node, key) {
  if (!Object.hasOwn(registry, node.class_type)) return {};
  const input = registry[node.class_type]?.input;
  if (input?.hidden && Object.hasOwn(input.hidden, key))
    return { hidden: true };
  const entry = input?.required?.[key] ?? input?.optional?.[key];
  return Array.isArray(entry) ? { type: entry[0], widget: entry[1] ?? {} } : {};
}

export function describeAdvancedField(graph, pair, protection, registry = {}) {
  const [id, key] = pair;
  const node = graph[id];
  const value = field(graph, pair);
  const protectedReason = protection.get(fieldKey(pair));
  if (protectedReason) return { reason: protectedReason };
  if (isLink(graph, value))
    return { reason: '连接自节点 ' + value[0] + '，请查看对应上游输入' };
  if (!scalar(value)) return { reason: '复合类型或超出可安全编辑的数值范围' };
  const { type, widget = {}, hidden } = inputSpec(registry, node, key);
  if (hidden) return { reason: '服务器声明为隐藏输入' };
  if (
    (Object.hasOwn(materialFiles, node.class_type) &&
      materialFiles[node.class_type] === key) ||
    widget.image_upload ||
    widget.video_upload ||
    widget.audio_upload
  )
    return { reason: '文件输入由素材上传管理' };
  if (widget.forceInput) return { reason: '服务器声明为连接输入' };

  const enumValues = Array.isArray(type) ? type : widget.options;
  if (
    Array.isArray(enumValues) &&
    enumValues.length &&
    enumValues.every(scalar)
  ) {
    const options = [
      ...new Set([
        value,
        ...enumValues.filter((option) => typeof option === typeof value),
      ]),
    ];
    return { definition: { field: pair, kind: 'enum', options } };
  }
  let kind;
  if (typeof value === 'boolean' && (!type || type === 'BOOLEAN'))
    kind = 'boolean';
  if (typeof value === 'string' && (!type || type === 'STRING')) kind = 'text';
  if (typeof value === 'number') {
    if (type === 'FLOAT' || (!type && !Number.isInteger(value)))
      kind = 'number';
    if ((type === 'INT' || !type) && Number.isSafeInteger(value))
      kind ??= 'integer';
  }
  if (!kind) return { reason: '当前节点类型需要专用控件' };
  const definition = { field: pair, kind };
  if (kind === 'text' && (widget.multiline || value.includes('\n')))
    definition.multiline = true;
  if (kind === 'integer' || kind === 'number') {
    for (const property of ['min', 'max', 'step']) {
      if (
        Number.isFinite(widget[property]) &&
        (property !== 'step' || widget.step > 0)
      )
        definition[property] = widget[property];
    }
  }
  return { definition };
}

export function allowsAdvancedValue(definition, value, original) {
  if (!scalar(value) || typeof value !== typeof original) return false;
  if (value === original) return true;
  if (definition.kind === 'enum') return definition.options?.includes(value);
  if (definition.kind === 'text') return typeof value === 'string';
  if (definition.kind === 'boolean') return typeof value === 'boolean';
  if (
    typeof value !== 'number' ||
    !['integer', 'number'].includes(definition.kind)
  )
    return false;
  if (definition.kind === 'integer' && !Number.isSafeInteger(value))
    return false;
  if (value < definition.min || value > definition.max) return false;
  if (definition.step) {
    const units = (value - (definition.min ?? original)) / definition.step;
    if (
      Math.abs(units - Math.round(units)) >
      Math.max(1e-7, Math.abs(units) * 1e-14)
    )
      return false;
  }
  return true;
}

export function advancedDefinitions(graph, profile) {
  if (!Array.isArray(profile.advanced)) return [];
  const protection = protectedFields(graph, profile);
  const seen = new Set();
  return profile.advanced.filter((definition) => {
    const pair = definition?.field;
    const key = fieldKey(pair);
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      !pair.every((part) => typeof part === 'string') ||
      seen.has(key) ||
      !Object.hasOwn(graph, pair[0]) ||
      !Object.hasOwn(graph[pair[0]].inputs, pair[1]) ||
      !describeAdvancedField(graph, pair, protection).definition
    )
      return false;
    const original = field(graph, pair);
    const { kind, options, min, max, step } = definition;
    const valid =
      (kind === 'text' && typeof original === 'string') ||
      (kind === 'boolean' && typeof original === 'boolean') ||
      (kind === 'enum' &&
        Array.isArray(options) &&
        options.includes(original) &&
        options.every(
          (option) => scalar(option) && typeof option === typeof original,
        )) ||
      (typeof original === 'number' &&
        (kind === 'number' ||
          (kind === 'integer' && Number.isSafeInteger(original))) &&
        [min, max, step].every(
          (value) => value === undefined || Number.isFinite(value),
        ) &&
        !(min > max) &&
        (step === undefined || step > 0));
    if (valid) seen.add(key);
    return valid;
  });
}

export function filterAdvancedValues(graph, definitions, values = {}) {
  return Object.fromEntries(
    definitions.flatMap((definition) => {
      const key = fieldKey(definition.field);
      const original = field(graph, definition.field);
      const value = values?.[key];
      return value !== original &&
        allowsAdvancedValue(definition, value, original)
        ? [[key, value]]
        : [];
    }),
  );
}
