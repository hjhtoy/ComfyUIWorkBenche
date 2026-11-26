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
  fps,
  pixelDimensions,
  stepsFrom,
} from '../comfy/config.js';

function populateSizeOptions(select, ratio, requestedMP) {
  if (!sizeConfig) return;
  if (sizeConfig.mode === 'preset') {
    const value = requestedMP ?? Number(select.value);
    select.replaceChildren(
      ...directSizes.map((pair, i) => new Option(pair.join(' × '), String(i))),
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
  select.replaceChildren(common, ...(more.childElementCount ? [more] : []));
  if ([...unique.values()].includes(selected)) select.value = String(selected);
}
function updateSizeOptions(requestedMP) {
  populateSizeOptions($('size'), $('ratio').value, requestedMP);
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
  setupPictureControls({
    ratio: $('ratio'),
    size: $('size'),
    steps: $('steps'),
  });
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
function pictureSettings({ ratio, size, steps }) {
  return {
    steps: profile.steps ? steps.valueAsNumber : undefined,
    mp: sizeConfig ? Number(size.value) : undefined,
    ratio: defaultRatio ? ratio.value : undefined,
    dimensions: size.selectedOptions[0]?.text,
  };
}
function generationSettings() {
  return {
    ...pictureSettings({
      ratio: $('ratio'),
      size: $('size'),
      steps: $('steps'),
    }),
    duration: profile.duration
      ? durationSeconds($('duration').valueAsNumber)
      : undefined,
  };
}

export {
  setupParameters,
  updateSizeOptions,
  controls,
  generationSettings,
  setupPictureControls,
  pictureSettings,
  populateSizeOptions,
  updateSliderFill,
};
