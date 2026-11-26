import {
  activeNodes,
  field,
  isH3Conditioning,
  isLink,
  sourceField,
} from './graph.js';

export const mappingVersion = 4;

const imageOutputs = new Set([
  'SaveImage',
  'SaveImageAdvanced',
  'PreviewImage',
]);
const videoOutputs = new Set(['SaveVideo', 'VHS_VideoCombine', 'SaveWEBM']);
const samplerTypes = new Set([
  'KSampler',
  'KSamplerAdvanced',
  'SamplerCustom',
  'SamplerCustomAdvanced',
]);
const sizeTypes = new Set([
  'EmptyLatentImage',
  'EmptySD3LatentImage',
  'EmptyFlux2LatentImage',
  'EmptyHunyuanLatentVideo',
  'ImageScale',
]);
const loaders = {
  LoadImage: ['image', 'image'],
  LoadVideo: ['video', 'file'],
  VHS_LoadVideo: ['video', 'video'],
  LoadAudio: ['audio', 'audio'],
};
const knownRatios = {
  '16:9': '16:9 (Widescreen)',
  '9:16': '9:16 (Portrait Widescreen)',
  '1:1': '1:1 (Square)',
};
const h3TimeExpression = 'max(5,round(a*24))+(5-(max(5,round(a*24))%17))%17';

export function outputChoices(graph, registry = {}) {
  return Object.entries(graph).filter(
    ([, node]) =>
      (imageOutputs.has(node.class_type) ||
        videoOutputs.has(node.class_type) ||
        registry[node.class_type]?.output_node) &&
      (node.class_type !== 'VHS_VideoCombine' ||
        node.inputs.save_output !== false),
  );
}

const unique = (values) => (values.length === 1 ? values[0] : undefined);
const float = (value) => typeof value === 'number' && Number.isFinite(value);
const numericSpecs = (registry, graph, pair) => {
  const inputs = registry[graph[pair[0]].class_type]?.input;
  return (inputs?.required?.[pair[1]] ?? inputs?.optional?.[pair[1]])?.[1];
};

function slider(graph, pair, registry, bounds, mode) {
  const value = field(graph, pair);
  const original =
    mode === 'sigmas' && validSigmas(value)
      ? value.split(',').length - 1
      : value;
  if (
    !float(original) ||
    original <= 0 ||
    (mode && mode !== 'sigmas' && !Number.isInteger(original))
  )
    return undefined;
  const limits = numericSpecs(registry, graph, pair);
  // Manual sigma nodes take a string. Their length has a separate UI policy.
  const increment = !mode
    ? limits?.step || (Number.isInteger(original) ? 1 : 0.1)
    : 1;
  const low = Math.max(increment, limits?.min ?? bounds[0]);
  const high = Math.min(
    Math.max(bounds[1], original),
    limits?.max ?? Number.MAX_SAFE_INTEGER,
  );
  if (!float(increment) || increment <= 0 || low > original || high < original)
    return undefined;
  const min = Number(
    (
      original -
      Math.floor((original - low) / increment + 1e-7) * increment
    ).toFixed(8),
  );
  const max = Number(
    (
      original +
      Math.floor((high - original) / increment + 1e-7) * increment
    ).toFixed(8),
  );
  if (min >= max) return undefined;
  return { field: pair, min, max, increment, ...(mode && { mode }) };
}

function positiveField(graph, sampler, h3) {
  if (h3) return promptSource(graph, [h3, 'prompt']);
  if (!sampler) return undefined;
  const positive = field(graph, [sampler, 'positive']);
  if (!isLink(graph, positive) || positive[1] !== 0) return undefined;
  const [id] = positive;
  const key = {
    CLIPTextEncode: 'text',
    TextEncodeQwenImage21: 'prompt',
    MiniMaxH3ImageConditioning: 'prompt',
  }[graph[id].class_type];
  return key && promptSource(graph, [id, key]);
}

// Text-to-image graphs can inject the user's text through prompt templating:
// user text -> StringReplace -> TextGenerate -> JSON extract -> switch -> conditioning.
// The writable field is then several pass-through nodes away from the conditioning
// input, so follow the chain and pick the field a person actually edits.
function chainNodes(graph, first) {
  const seen = new Set();
  const ids = [];
  const push = (value) => {
    if (!isLink(graph, value) || seen.has(value[0])) return;
    seen.add(value[0]);
    ids.push(value[0]);
  };
  push(first);
  for (let index = 0; index < ids.length; index++)
    for (const value of Object.values(graph[ids[index]].inputs)) push(value);
  return ids;
}

function promptSource(graph, pair) {
  const direct = sourceField(graph, pair);
  if (direct && typeof field(graph, direct) === 'string') return direct;
  const start = field(graph, pair);
  if (!isLink(graph, start)) return undefined;
  const ids = chainNodes(graph, start);
  const writable = (id, key) => {
    const candidate = sourceField(graph, [id, key]);
    return candidate && typeof field(graph, candidate) === 'string'
      ? candidate
      : undefined;
  };
  // Text nodes reached through a link (CR Text, JjkText, constants…).
  const textNode = (id, key) => {
    const value = graph[id].inputs?.[key];
    if (!isLink(graph, value)) return undefined;
    const node = graph[value[0]];
    for (const name of ['text', 'value', 'string', 'prompt'])
      if (typeof node.inputs?.[name] === 'string') return [value[0], name];
    return undefined;
  };
  // An explicit user-prompt primitive is the most reliable signal.
  for (const id of ids)
    if (
      /user[_\s-]?prompt|用户提示词/i.test(graph[id]._meta?.title ?? '') &&
      typeof graph[id].inputs.value === 'string'
    )
      return [id, 'value'];
  // Otherwise the template placeholder shows where the user's text is inserted.
  for (const id of ids) {
    const { class_type, inputs } = graph[id];
    if (class_type !== 'StringReplace' || typeof inputs.find !== 'string')
      continue;
    if (!/\{[^{}]+\}/.test(inputs.find)) continue;
    const source = writable(id, 'replace');
    if (source) return source;
  }
  // Comfyroll text replace: find1..3 hold placeholders, replace1..3 the user text.
  for (const id of ids) {
    const { class_type, inputs } = graph[id];
    if (!/^CR[ _]Text[ _]Replace$/i.test(class_type)) continue;
    for (const index of [1, 2, 3]) {
      const find = inputs[`find${index}`];
      if (typeof find !== 'string' || !find.trim()) continue;
      const source =
        textNode(id, `replace${index}`) ?? writable(id, `replace${index}`);
      if (source) return source;
    }
  }
  // A switch fallback branch can also hold the text written by the user.
  for (const id of ids)
    if (graph[id].class_type === 'ComfySwitchNode')
      for (const key of ['on_false', 'on_true']) {
        const source = writable(id, key);
        if (source) return source;
      }
  return undefined;
}

function validSigmas(value) {
  return (
    typeof value === 'string' &&
    /^\s*-?(?:\d+(?:\.\d*)?|\.\d+)(?:\s*,\s*-?(?:\d+(?:\.\d*)?|\.\d+))+\s*$/.test(
      value,
    )
  );
}

function hyperflowSteps(graph, pair) {
  if ([4, 6, 8].includes(field(graph, pair)))
    return { field: pair, mode: 'integer', min: 4, max: 8, increment: 2 };
}

function samplingConfig(graph, sampler, h3, registry) {
  if (!sampler) return undefined;
  const integerSteps = (id) => {
    const pair = sourceField(graph, [id, 'steps']);
    return pair && slider(graph, pair, registry, [1, 50], 'integer');
  };
  if (Object.hasOwn(graph[sampler].inputs, 'steps'))
    return integerSteps(sampler);
  const sigmas = graph[sampler].inputs.sigmas;
  if (!isLink(graph, sigmas)) return undefined;
  const [id] = sigmas;
  if (sigmas[1] === 0 && graph[id].class_type === 'HyperFlowSigmas')
    return hyperflowSteps(graph, sourceField(graph, [id, 'steps']));
  if (graph[id].class_type === 'BasicScheduler')
    return integerSteps(id);
  if (graph[id].class_type === 'ExtendIntermediateSigmas') {
    // Schedule extension nodes sit between the sampler and BasicScheduler.
    const inner = graph[id].inputs.sigmas;
    return isLink(graph, inner) && graph[inner[0]].class_type === 'BasicScheduler'
      ? integerSteps(inner[0])
      : undefined;
  }
  if (
    h3 &&
    graph[id].class_type === 'ManualSigmas' &&
    validSigmas(graph[id].inputs.sigmas)
  )
    return slider(graph, [id, 'sigmas'], registry, [1, 50], 'sigmas');
}

function durationConfig(graph, h3, fps, registry) {
  if (!h3 || fps !== 24) return undefined;
  const length = graph[h3].inputs.length;
  if (
    Number.isInteger(length) && length >= 5 && length <= 3600 &&
    (length - 5) % 17 === 0
  ) {
    // Keep the original frame count exact; H3 uses 5 + 17k at 24 fps.
    const max = Math.max(length, 5 + 17 * Math.ceil((30 * fps - 5) / 17));
    return { field: [h3, 'length'], unit: 'frames', min: 5, max, increment: 17 };
  }
  if (!isLink(graph, length) || length[1] !== 1) return undefined;
  const [id] = length;
  const { class_type, inputs } = graph[id];
  if (
    class_type !== 'ComfyMathExpression' ||
    inputs.expression?.replace(/\s+/g, '') !== h3TimeExpression
  )
    return undefined;
  const source = sourceField(graph, [id, 'values.a']);
  if (!source) return undefined;
  const control = slider(graph, source, registry, [1, 30]);
  return control && { ...control, alignment: { base: 5, period: 17 } };
}

function sizeConfig(graph, id, registry) {
  const { class_type, inputs } = graph[id];
  if (class_type === 'ResolutionSelector') {
    const ratio =
      typeof inputs.aspect_ratio === 'string' &&
      inputs.aspect_ratio.match(/^[1-9]\d*:[1-9]\d*/)?.[0];
    if (
      !ratio ||
      !float(inputs.megapixels) ||
      inputs.megapixels <= 0 ||
      !Number.isInteger(inputs.multiple) ||
      inputs.multiple <= 0
    )
      return undefined;
    const nodeMeta = registry[class_type]?.input?.required?.aspect_ratio;
    const available = Array.isArray(nodeMeta?.[0])
      ? nodeMeta[0]
      : nodeMeta?.[1]?.options;
    const ratios = Array.isArray(available)
      ? Object.fromEntries(
          available
            .filter(
              (value) =>
                typeof value === 'string' && /^[1-9]\d*:[1-9]\d*/.test(value),
            )
            .map((value) => [value.match(/^[1-9]\d*:[1-9]\d*/)[0], value]),
        )
      : knownRatios;
    const mp = [id, 'megapixels'];
    const range = numericSpecs(registry, graph, mp);
    const choices = [0.25, 0.4, 0.56, 0.75, 0.88, 0.98, 1, 1.25, 1.5, 2].filter(
      (value) =>
        value >= (range?.min ?? 0.25) &&
        value <= (range?.max ?? 2) &&
        (!range?.step ||
          Math.abs(
            (value - inputs.megapixels) / range.step -
              Math.round((value - inputs.megapixels) / range.step),
          ) < 1e-7),
    );
    return {
      mode: 'selector',
      ratio: [id, 'aspect_ratio'],
      megapixels: mp,
      multiple: inputs.multiple,
      ratios: { ...ratios, [ratio]: inputs.aspect_ratio },
      megapixelsOptions: choices,
    };
  }
  const h3 = isH3Conditioning(class_type);
  if (!sizeTypes.has(class_type) && !h3) return undefined;
  const width = sourceField(graph, [id, 'width']);
  const height = sourceField(graph, [id, 'height']);
  const dims = [field(graph, width), field(graph, height)];
  if (!dims.every((value) => Number.isInteger(value) && value > 0))
    return undefined;
  return {
    mode: 'preset',
    width,
    height,
    presets: h3 ? [
      [1344, 768], [768, 1344], [1024, 1024], [768, 448], [448, 768],
    ] : [
      [512, 512],
      [768, 512],
      [512, 768],
      [1024, 1024],
    ],
  };
}

function referenceSlots(graph, active, h3) {
  const slots = new Map();
  for (const owner of active) {
    const entries = Object.entries(graph[owner].inputs);
    if (owner === h3)
      entries.sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }));
    for (const [key, value] of entries) {
      if (!isLink(graph, value)) continue;
      const [id] = value;
      const loader = graph[id];
      const spec =
        Object.hasOwn(loaders, loader.class_type) && loaders[loader.class_type];
      if (!spec) continue;
      const [kind, file] = spec;
      if (typeof loader.inputs[file] !== 'string') continue;
      const optional =
        owner === h3 && /^ref_(images|videos|audios)\./.test(key);
      const slot = slots.get(id) ?? {
        kind,
        file: [id, file],
        targets: [],
        required: false,
      };
      slot.targets.push([owner, key]);
      slot.required ||= !optional;
      slots.set(id, slot);
    }
  }
  // Required ordinary loaders precede optional slots of the same kind.
  return [...slots.values()].sort(
    (a, b) => Number(b.required) - Number(a.required),
  );
}

export function mappingCandidates(graph, output, registry = {}) {
  if (!Object.hasOwn(graph, output)) throw Error('请选择一个有效的输出节点。');
  const active = activeNodes(graph, [output]);
  const byType = (type) => active.filter((id) => graph[id].class_type === type);
  const h3 = unique(
    active.filter((id) => isH3Conditioning(graph[id].class_type)),
  );
  const h3Reference =
    h3 && graph[h3].class_type === 'MiniMaxH3ReferenceToVideo' ? h3 : undefined;
  const sampler = unique(
    active.filter((id) => samplerTypes.has(graph[id].class_type)),
  );
  const expectedPrompt = positiveField(graph, sampler, h3);
  const prompt =
    typeof field(graph, expectedPrompt) === 'string'
      ? expectedPrompt
      : undefined;
  const steps = samplingConfig(graph, sampler, h3, registry);
  const sizes = active
    .map((id) => sizeConfig(graph, id, registry))
    .filter(Boolean);
  const size =
    unique(sizes.filter((item) => item.mode === 'selector')) ??
    (!sizes.some((item) => item.mode === 'selector')
      ? unique(sizes)
      : undefined);
  const references = referenceSlots(graph, active, h3Reference);
  const seed =
    sampler &&
    (sourceField(graph, [sampler, 'seed']) ??
      sourceField(graph, [sampler, 'noise_seed']));
  const noise = unique(byType('RandomNoise'));
  const seedField =
    seed || (noise && sourceField(graph, [noise, 'noise_seed']));
  const target = graph[output];
  const video = videoOutputs.has(target.class_type);
  const videoNode =
    target.class_type === 'SaveVideo' &&
    isLink(graph, target.inputs.video) &&
    graph[target.inputs.video[0]];
  const frames =
    target.class_type === 'VHS_VideoCombine'
      ? target.inputs.images
      : videoNode?.class_type === 'CreateVideo'
        ? videoNode.inputs.images
        : null;
  const firstFrame =
    video &&
    isLink(graph, frames) &&
    graph[frames[0]].class_type === 'VAEDecode'
      ? frames
      : undefined;
  const fps = video && (target.inputs.frame_rate ?? videoNode?.inputs?.fps);
  const duration = durationConfig(graph, h3, fps, registry);
  const profile = {
    outputs: [output],
    ...(prompt && { prompt }),
    ...(size && { size }),
    ...(steps && { steps }),
    ...(duration && { duration }),
    ...(float(fps) && fps > 0 && { fps }),
    ...(Number.isInteger(field(graph, seedField)) && { seed: seedField }),
    ...(sampler && { sampler }),
    ...(firstFrame && { firstFrame }),
    ...(references.length && { references }),
    ...(h3Reference && {
      h3ReferenceNode: h3Reference,
      referenceTags: { image: 'Picture', video: 'Video', audio: 'Audio' },
    }),
    ...(typeof target.inputs.filename_prefix === 'string' && {
      matchIgnore: [[output, 'filename_prefix']],
    }),
  };
  const prompts = [];
  const sliders = [];
  const seconds = [];
  for (const id of active) {
    for (const [key, value] of Object.entries(graph[id].inputs)) {
      const pair = [id, key];
      if (typeof value === 'string') prompts.push(pair);
      if (
        Number.isInteger(value) &&
        value > 0 &&
        /^(steps|value)$/i.test(key)
      ) {
        const candidate = graph[id].class_type === 'HyperFlowSigmas'
          ? hyperflowSteps(graph, pair)
          : slider(graph, pair, registry, [1, 50], 'integer');
        if (candidate) sliders.push(candidate);
      }
      if (
        float(value) &&
        value > 0 &&
        /^(duration|seconds|value)$/i.test(key)
      ) {
        const candidate = slider(graph, pair, registry, [1, 30]);
        if (candidate) seconds.push(candidate);
      }
    }
  }
  return {
    profile,
    prompts,
    sliders,
    seconds,
    sizes,
    references,
    video,
    image: imageOutputs.has(target.class_type),
  };
}

// Older imports recognized the H3 reference node, leaving these two controls unmapped
// when the official image-to-video node was used without an input image.
function repairLegacyH3Mapping(entry) {
  const { graph, profile } = entry;
  const output = profile?.outputs?.[0];
  if (
    entry.mappingVersion >= 1 ||
    !output ||
    !graph ||
    (profile.prompt && profile.duration)
  )
    return entry;
  const active = activeNodes(graph, [output]);
  const h3 = unique(
    active.filter((id) => isH3Conditioning(graph[id].class_type)),
  );
  if (!h3 || graph[h3].class_type !== 'MiniMaxH3ImageToVideo') return entry;

  const inferred = mappingCandidates(graph, output).profile;
  const restored = {};
  const next = { ...profile };
  for (const key of ['prompt', 'duration']) {
    if (!next[key] && inferred[key] && inferred[key].unit !== 'frames') {
      next[key] = inferred[key];
      restored[key] = true;
    }
  }
  if (!Object.keys(restored).length) return entry;
  const promoted = new Set([
    restored.prompt && JSON.stringify(next.prompt),
    restored.duration && JSON.stringify(next.duration.field),
  ]);
  const advanced = next.advanced?.filter(
    ({ field }) => !promoted.has(JSON.stringify(field)),
  );
  if (advanced?.length) next.advanced = advanced;
  else delete next.advanced;
  return {
    ...entry,
    profile: { ...next, restoredH3Controls: restored },
  };
}

export function repairSavedMapping(entry) {
  if (entry.mappingVersion >= mappingVersion) return entry;
  entry = repairLegacyH3Mapping(entry);
  const { graph, profile } = entry;
  const output = profile?.outputs?.[0];
  if (!graph || !Object.hasOwn(graph, output)) return entry;
  const inferred = mappingCandidates(graph, output).profile;
  const next = { ...profile };
  const boundFields = new Set([
    ...(profile.advanced ?? []).map(({ field }) => field),
    profile.steps?.field, profile.duration?.field, profile.prompt,
    profile.size?.width, profile.size?.height,
  ].filter(Boolean).map((pair) => JSON.stringify(pair)));
  const available = (pair) => !boundFields.has(JSON.stringify(pair));
  // Only promote fields that older importers could not infer. Keep manual bindings.
  const { size, duration, steps } = inferred;
  if (!next.prompt && inferred.prompt && available(inferred.prompt))
    next.prompt = inferred.prompt;
  if (
    !next.size && size?.mode === 'preset' &&
    isH3Conditioning(graph[size.width[0]].class_type) &&
    available(size.width) && available(size.height)
  )
    next.size = size;
  if (
    !next.duration && duration?.unit === 'frames' &&
    profile.fps === inferred.fps && available(duration.field)
  )
    next.duration = duration;
  const sigmas = graph[inferred.sampler]?.inputs.sigmas;
  if (!next.steps && steps && available(steps.field))
    next.steps = steps;
  return { ...entry, mappingVersion, profile: next };
}
