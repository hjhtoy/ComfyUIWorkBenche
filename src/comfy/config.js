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
  slots,
  ratios,
  readField,
  writeField,
  sizeConfig,
  defaultDuration,
  defaultRatio,
  directSizes,
  fps,
  pixelDimensions,
  stepsFrom,
};
