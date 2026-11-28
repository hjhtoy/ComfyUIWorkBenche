import { $, elem } from './dom.js';
import {
  profile,
  legacyFrameform,
  ratios,
  readField,
  sizeConfig,
  defaultDuration,
  durationInFrames,
  durationSeconds,
  defaultRatio,
  directSizes,
  commonResolutions,
  exactResolution,
  validResolution,
  fps,
  pixelDimensions,
  stepsFrom,
} from '../comfy/config.js';

function populateSizeOptions(select, ratio, requestedMP) {
  if (!sizeConfig) return;
  const previous = select.value;
  const custom = exactResolution ? [new Option('自定义宽高', 'custom')] : [];
  if (sizeConfig.mode === 'preset') {
    const value = requestedMP ?? Number(select.value);
    select.replaceChildren(
      ...directSizes.map((pair, i) => new Option(pair.join(' × '), String(i))),
      ...custom,
    );
    select.value = String(directSizes[value] ? value : 0);
    return;
  }
  const initial = readField(sizeConfig.megapixels);
  const options = sizeConfig.megapixelsOptions;
  const choices = legacyFrameform ? options : [initial, ...options];
  const allowed = legacyFrameform
    ? (mp) => mp >= Math.min(...options) && mp <= Math.max(...options)
    : (mp) => choices.includes(mp);
  const current = select.value === '' ? initial : Number(select.value);
  const selected =
    legacyFrameform && !allowed(requestedMP)
      ? current
      : (requestedMP ?? current);
  const labelFor = (mp) => pixelDimensions(ratio, mp);
  const commonSizes = sizeConfig.commonMegapixels || [];
  const popular = new Map(
    (legacyFrameform ? commonSizes : [initial, ...commonSizes]).map((mp) => [
      labelFor(mp),
      mp,
    ]),
  );
  const unique = new Map(choices.map((mp) => [labelFor(mp), mp]));
  for (const [label, mp] of popular) unique.set(label, mp);
  if (allowed(selected)) unique.set(labelFor(selected), selected);
  const common = elem('optgroup'),
    more = elem('optgroup');
  common.label = '常用尺寸';
  more.label = '更多尺寸';
  for (const [label, mp] of unique)
    (popular.has(label) ? common : more).append(new Option(label, String(mp)));
  const [x, y] = ratio.split(':').map(Number);
  const exact = exactResolution ? commonResolutions.filter(([w, h]) =>
    w * y === h * x && !unique.has(w + ' × ' + h),
  ) : [];
  for (const pair of exact) common.append(new Option(pair.join(' × '), pair.join('x')));
  select.replaceChildren(common, ...(more.childElementCount ? [more] : []), ...custom);
  if ([...unique.values()].includes(selected)) select.value = String(selected);
  if (requestedMP === undefined && previous === 'custom') select.value = previous;
}
function setupSlider(input, config, value, unit) {
  const group = input.closest('.slider');
  group.hidden = !config;
  if (!config) return;
  input.min = config.min;
  input.max = config.max;
  input.step = config.increment ?? 1;
  input.value = value;
  const ends = group.querySelectorAll('.scale span');
  ends[0].textContent = config.min + unit;
  ends[1].textContent = config.max + unit;
}

const manualPicture = {
  ratio: $('ratio'),
  size: $('size'),
  steps: $('steps'),
  width: $('width'),
  height: $('height'),
};

function setupPictureControls({ ratio, size, steps }) {
  size.closest('label.size-field, .size-field').hidden = !sizeConfig;
  ratio.closest('label').hidden = !defaultRatio;
  ratio.replaceChildren(
    ...Object.keys(ratios).map((value) => new Option(value, value)),
  );
  if (defaultRatio) ratio.value = defaultRatio;
  setupSlider(
    steps,
    profile.steps,
    stepsFrom(readField(profile.steps?.field)),
    '',
  );
  populateSizeOptions(size, ratio.value);
}
function setupParameters() {
  setupPictureControls(manualPicture);
  setupSlider(
    $('duration'),
    profile.duration,
    defaultDuration,
    durationInFrames ? ' 帧' : ' 秒',
  );
  controls();
}
function controls() {
  $('stepval').value = $('steps').value;
  const value = $('duration').valueAsNumber;
  const seconds = durationSeconds(value);
  const label = value + (durationInFrames ? ' 帧' : ' 秒');
  $('durationValue').value = label;
  $('duration').setAttribute('aria-valuetext', label);
  const timing = [];
  if (profile.duration) {
    const alignment = profile.duration.alignment;
    if (durationInFrames) {
      timing.push('时长 ' + seconds.toFixed(2) + ' 秒');
    } else if (alignment && fps) {
      const requested = Math.max(alignment.base, Math.round(seconds * fps));
      const frames =
        alignment.base +
        alignment.period *
          Math.ceil((requested - alignment.base) / alignment.period);
      timing.push(
        '预计 ' + (frames / fps).toFixed(2) + ' 秒（' + frames + ' 帧）',
      );
    } else timing.push('目标 ' + seconds + ' 秒');
  }
  if (fps) timing.push(fps + ' fps');
  if (legacyFrameform) timing.push('MP4');
  $('timing').textContent = timing.join('　·　');
  updateSliderFill($('steps'));
  updateSliderFill($('duration'));
}
function updateSliderFill(input) {
  if (Number(input.max) > Number(input.min)) {
    const progress =
      (100 * (input.value - input.min)) / (input.max - input.min);
    input.style.setProperty('--fill', progress + '%');
  }
}
function showCustomResolution({ ratio, size, width, height }) {
  const custom = size.value === 'custom';
  ratio.disabled = custom;
  width.parentElement.parentElement.hidden = !custom;
  if (custom && !width.value && !height.value) {
    const dimensions = size.dataset.previousSize?.match(/^(\d+) × (\d+)$/);
    if (dimensions) [width.value, height.value] = dimensions.slice(1);
  } else if (!custom) size.dataset.previousSize = size.selectedOptions[0]?.text || '';
}

function bindResolution(picture, changed) {
  const { ratio, size, width, height } = picture;
  ratio.onchange = () => {
    populateSizeOptions(size, ratio.value);
    showCustomResolution(picture);
    changed();
  };
  size.onchange = () => {
    showCustomResolution(picture);
    changed();
  };
  width.oninput = height.oninput = changed;
  showCustomResolution(picture);
}

function restoreResolution(picture, saved) {
  const { ratio, size, width, height } = picture;
  populateSizeOptions(size, ratio.value, saved.mp);
  if (exactResolution && Array.isArray(saved.resolution)) {
    const preset = saved.resolution.join('x');
    size.value = !saved.customResolution && [...size.options].some((o) => o.value === preset)
      ? preset : 'custom';
    [width.value, height.value] = saved.resolution.map((value) => value ?? '');
  } else if (size.value === 'custom') size.selectedIndex = 0;
  showCustomResolution(picture);
}

function pictureSettings({ ratio, size, steps, width, height }, validate = false) {
  const customResolution = size.value === 'custom';
  const resolution = customResolution
    ? [width.valueAsNumber, height.valueAsNumber]
    : size.value.includes('x') ? size.value.split('x').map(Number) : undefined;
  if (validate && customResolution && !validResolution(resolution))
    throw Error('请输入大于 0 的整数宽度和高度。');
  return {
    steps: profile.steps ? steps.valueAsNumber : undefined,
    mp: sizeConfig && !resolution ? Number(size.value) : undefined,
    ratio: defaultRatio && !customResolution ? ratio.value : undefined,
    dimensions: resolution
      ? validResolution(resolution) ? resolution.join(' × ') : undefined
      : size.selectedOptions[0]?.text,
    ...(resolution && { resolution, customResolution }),
  };
}
function generationSettings(validate = false) {
  return {
    ...pictureSettings(manualPicture, validate),
    duration: profile.duration
      ? durationSeconds($('duration').valueAsNumber)
      : undefined,
  };
}

export {
  setupParameters,
  bindResolution,
  restoreResolution,
  manualPicture,
  controls,
  generationSettings,
  setupPictureControls,
  pictureSettings,
  populateSizeOptions,
  updateSliderFill,
};
