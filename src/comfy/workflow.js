import {
  profile,
  legacyFrameform,
  template,
  slots,
  sizeConfig,
  ratios,
  directSizes,
  readField,
  writeField,
  stepsFrom,
  pixelDimensions,
  durationSeconds,
  durationFieldValue,
} from './config.js';
import {
  groupPaths,
  slotsFor,
  bindDynamicH3,
  serverMaterialRefs,
} from './references.js';
import { materialKinds } from '../media/types.js';
import { formatServerPrompt } from '../ui/mentions.js';
import {
  advancedDefinitions,
  fieldKey,
  filterAdvancedValues,
} from './advanced.js';

const advanced = advancedDefinitions(template, profile);
const editableSeed = advanced.some(
  ({ field }) => fieldKey(field) === fieldKey(profile.seed),
);

function buildGraph(j, paths) {
  const graph = JSON.parse(JSON.stringify(template));
  const overrides = filterAdvancedValues(template, advanced, j.form?.advanced);
  for (const { field } of advanced) {
    const key = fieldKey(field);
    if (Object.hasOwn(overrides, key)) writeField(graph, field, overrides[key]);
  }
  const grouped = groupPaths(j, paths);
  // The original Frameform strips stray image loaders left in the H3 export.
  const unused = new Set();
  if (legacyFrameform) {
    for (const [id, node] of Object.entries(graph)) {
      if (node.class_type === 'LoadImage') unused.add(id);
    }
  }
  for (const kind of materialKinds) {
    for (const [i, slot] of slotsFor(kind).entries()) {
      if (i < grouped[kind].length)
        writeField(graph, slot.file, grouped[kind][i]);
      else {
        for (const [id, key] of slot.targets) delete graph[id].inputs[key];
        unused.add(slot.file[0]);
      }
    }
  }
  // Keep loaders still used by fixed inputs elsewhere in the graph.
  for (const id of unused) {
    const used = Object.values(graph).some((node) =>
      Object.values(node.inputs).some(
        (value) => Array.isArray(value) && String(value[0]) === id,
      ),
    );
    if (!used) delete graph[id];
  }
  bindDynamicH3(graph, grouped);
  if (profile.prompt) writeField(graph, profile.prompt, j.prompt);
  if (profile.duration)
    writeField(graph, profile.duration.field, durationFieldValue(j.duration));
  if (sizeConfig?.mode === 'selector') {
    writeField(graph, sizeConfig.ratio, ratios[j.ratio]);
    writeField(graph, sizeConfig.megapixels, j.mp);
  } else if (sizeConfig?.mode === 'preset') {
    const [width, height] = directSizes[j.mp];
    writeField(graph, sizeConfig.width, width);
    writeField(graph, sizeConfig.height, height);
  }
  if (profile.seed && !editableSeed)
    writeField(
      graph,
      profile.seed,
      crypto.getRandomValues(new Uint32Array(1))[0],
    );
  if (profile.steps?.mode === 'integer')
    writeField(graph, profile.steps.field, j.steps);
  if (profile.steps?.mode === 'sigmas') {
    const original = readField(profile.steps.field).split(',').map(Number);
    if (j.steps !== original.length - 1) {
      const curve = Array.from({ length: j.steps + 1 }, (_, i) => {
        const t = (i * (original.length - 1)) / j.steps,
          lo = Math.floor(t),
          hi = Math.ceil(t);
        return Number(
          (original[lo] + (original[hi] - original[lo]) * (t - lo)).toFixed(7),
        );
      });
      writeField(graph, profile.steps.field, curve.join(', '));
    }
  }
  if (profile.firstFrame) {
    const freeId = () => {
      let id = 1;
      while (Object.hasOwn(graph, String(id))) id++;
      return String(id);
    };
    const [batch, saver] = profile.firstFrameIds || [];
    const batchId = batch && !Object.hasOwn(graph, batch) ? batch : freeId();
    graph[batchId] = {
      class_type: 'ImageFromBatch',
      inputs: { image: profile.firstFrame, batch_index: 0, length: 1 },
    };
    graph[saver && !Object.hasOwn(graph, saver) ? saver : freeId()] = {
      class_type: 'SaveImage',
      inputs: {
        images: [batchId, 0],
        filename_prefix: profile.firstFramePrefix || 'Frameform/first_frame',
      },
    };
  }
  return graph;
}
const mutableFields = [
  profile.prompt,
  profile.seed,
  profile.steps?.field,
  profile.duration?.field,
  sizeConfig?.ratio,
  sizeConfig?.megapixels,
  sizeConfig?.width,
  sizeConfig?.height,
  ...(profile.matchIgnore || []),
  ...advanced.map(({ field }) => field),
  ...slots.flatMap((slot) => slot.targets),
].filter(Boolean);
const mutableFieldKeys = new Set(
  mutableFields.map((pair) => JSON.stringify(pair)),
);
function matchWorkflow(graph) {
  if (!graph || typeof graph !== 'object') return null;
  const entries = Object.entries(graph);
  function match(original, id, mapped) {
    const expected = template[original],
      actual = graph[id];
    if (
      !expected ||
      expected.class_type !== actual?.class_type ||
      !actual.inputs
    )
      return false;
    if (mapped.has(original)) return mapped.get(original) === id;
    if ([...mapped.values()].includes(id)) return false;
    mapped.set(original, id);
    return Object.entries(expected.inputs).every(([name, value]) => {
      if (mutableFieldKeys.has(JSON.stringify([original, name]))) return true;
      const input = actual.inputs[name];
      if (
        Array.isArray(value) &&
        value.length === 2 &&
        Object.hasOwn(template, String(value[0])) &&
        Number.isInteger(value[1])
      )
        return (
          Array.isArray(input) &&
          input.length === 2 &&
          input[1] === value[1] &&
          match(String(value[0]), String(input[0]), mapped)
        );
      return JSON.stringify(input) === JSON.stringify(value);
    });
  }
  function matchOutputs(index, mapped) {
    if (index === profile.outputs.length) return mapped;
    const original = profile.outputs[index];
    for (const [id, node] of entries) {
      if (node?.class_type !== template[original].class_type) continue;
      const branch = new Map(mapped);
      if (match(original, id, branch)) {
        const resolved = matchOutputs(index + 1, branch);
        if (resolved) return resolved;
      }
    }
    return null;
  }
  return matchOutputs(0, new Map());
}
function graphJobData(base, graph, mapped) {
  const read = (pair) => pair && graph[mapped.get(pair[0])]?.inputs?.[pair[1]];
  const duration = durationSeconds(read(profile.duration?.field)),
    steps = stepsFrom(read(profile.steps?.field));
  const ratio = Object.keys(ratios).find(
    (key) => ratios[key] === read(sizeConfig?.ratio),
  );
  let mp = read(sizeConfig?.megapixels),
    dimensions;
  if (sizeConfig?.mode === 'selector' && ratio && Number.isFinite(mp))
    dimensions = pixelDimensions(ratio, mp);
  if (sizeConfig?.mode === 'preset') {
    const pair = [read(sizeConfig.width), read(sizeConfig.height)];
    if (pair.every(Number.isFinite)) {
      dimensions = pair.join(' × ');
      const index = directSizes.findIndex(
        (item) => String(item) === String(pair),
      );
      if (index >= 0) mp = index;
    }
  }
  const prompt = String(read(profile.prompt) ?? '');
  const bindings = serverMaterialRefs(base, graph, mapped);
  const content = formatServerPrompt(prompt, bindings, true);
  const refs = bindings.map((item) => item.ref);
  const form = {
    html: content.innerHTML,
    refs,
    server: base,
    ratio,
    mp,
    duration,
    steps,
    advanced: filterAdvancedValues(
      template,
      advanced,
      Object.fromEntries(
        advanced.map(({ field }) => [fieldKey(field), read(field)]),
      ),
    ),
  };
  return {
    form,
    steps: steps > 0 ? steps : undefined,
    duration: Number.isFinite(duration) ? duration : undefined,
    dimensions,
    title: content.textContent.trim().slice(0, 80) || '服务器运行中的任务',
  };
}

function outputNodeIds(graph, mapped) {
  const ids = profile.outputs.map((id) => mapped?.get(id) ?? id);
  if (!profile.firstFrame) return ids;
  const [source, index] = profile.firstFrame;
  const frameSource = mapped?.get(source) ?? source;
  const prefix = profile.firstFramePrefix || 'Frameform/first_frame';
  for (const [id, node] of Object.entries(graph)) {
    if (
      node.class_type !== 'SaveImage' ||
      node.inputs.filename_prefix !== prefix
    )
      continue;
    const batch = graph[node.inputs.images?.[0]];
    if (
      batch?.class_type === 'ImageFromBatch' &&
      batch.inputs.image?.[0] === frameSource &&
      batch.inputs.image?.[1] === index
    )
      ids.push(id);
  }
  return ids;
}

export { buildGraph, matchWorkflow, graphJobData, outputNodeIds };
