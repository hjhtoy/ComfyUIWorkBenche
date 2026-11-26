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
const directSizes =
  sizeConfig?.mode === 'preset'
    ? [initialDimensions, ...(sizeConfig.presets || [])].filter(
        (entry, i, list) =>
          list.findIndex((x) => String(x) === String(entry)) === i,
      )
    : [];
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
  fps,
  pixelDimensions,
  stepsFrom,
};
