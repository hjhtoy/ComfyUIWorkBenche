import { $ } from '../ui/dom.js';

const template = JSON.parse($('workflow').textContent);
const profile = JSON.parse($('profile').textContent);
const slots = profile.references || [];
const ratios = profile.size?.ratios || {};
const readField = (pair, graph = template) =>
  pair && graph[pair[0]]?.inputs?.[pair[1]];
const writeField = (graph, [id, key], value) => {
  graph[id].inputs[key] = value;
};
const workbenchId = document.documentElement.dataset.workbenchId;
const legacyFrameform = profile.legacyFrameform === true;
const sizeConfig = profile.size;
const defaultDuration = readField(profile.duration?.field);
const defaultRatio = Object.keys(ratios).find(
  (ratio) => ratios[ratio] === readField(sizeConfig?.ratio),
);
const initialDimensions = [
  readField(sizeConfig?.width),
  readField(sizeConfig?.height),
];
const commonResolutions = [
  [512, 512], [768, 512], [512, 768], [768, 768], [1024, 1024],
  [1024, 768], [768, 1024], [1280, 720], [720, 1280], [1344, 768],
  [768, 1344], [1536, 1024], [1024, 1536], [1920, 1080], [1080, 1920],
  [2048, 2048], [2560, 1440], [1440, 2560], [3840, 2160], [2160, 3840],
];
const directSizes =
  sizeConfig?.mode === 'preset'
    ? [initialDimensions, ...(sizeConfig.presets || []), ...commonResolutions].filter(
        (entry, i, list) =>
          list.findIndex((x) => String(x) === String(entry)) === i,
      )
    : [];
const selectorNode = sizeConfig?.mode === 'selector' && sizeConfig.ratio[0];
const resolutionLinks = [[], []];
if (selectorNode && template[selectorNode]?.class_type === 'ResolutionSelector') {
  for (const [id, node] of Object.entries(template)) {
    for (const [field, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && value.length === 2 && value[0] === selectorNode &&
          (value[1] === 0 || value[1] === 1))
        resolutionLinks[value[1]].push([id, field]);
    }
  }
}
const exactResolution = sizeConfig?.mode === 'preset' ||
  resolutionLinks.every((fields) => fields.length);
const validResolution = (pair) => Array.isArray(pair) && pair.length === 2 &&
  pair.every((value) => Number.isSafeInteger(value) && value > 0);
const fps = profile.fps;
const durationInFrames = profile.duration?.unit === 'frames';
// Forms, job history and batch TXT use seconds. A direct H3 length uses frames.
function durationSeconds(value) {
  return durationInFrames && Number.isFinite(value) ? value / fps : value;
}
function durationFieldValue(seconds) {
  if (!durationInFrames || !Number.isFinite(seconds)) return seconds;
  const { min, increment = 1 } = profile.duration;
  const frames = Math.max(min, Math.round(seconds * fps));
  return min + Math.ceil((frames - min) / increment) * increment;
}
function pixelDimensions(ratio, mp, multiple = sizeConfig.multiple) {
  const [x, y] = ratio.split(':').map(Number);
  const scale = 1024 * Math.sqrt(mp / (x * y));
  return [x, y]
    .map((side) => Math.round((side * scale) / multiple) * multiple)
    .join(' × ');
}
function stepsFrom(value) {
  return profile.steps?.mode === 'sigmas'
    ? String(value)
        .split(',')
        .filter((v) => v.trim()).length - 1
    : value;
}

export {
  template,
  profile,
  legacyFrameform,
  workbenchId,
  slots,
  ratios,
  readField,
  writeField,
  sizeConfig,
  defaultDuration,
  durationInFrames,
  durationSeconds,
  durationFieldValue,
  defaultRatio,
  directSizes,
  commonResolutions,
  resolutionLinks,
  exactResolution,
  validResolution,
  fps,
  pixelDimensions,
  stepsFrom,
};
