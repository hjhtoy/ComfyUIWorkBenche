import { $, elem } from './dom.js';
import {
  profile,
  legacyFrameform,
  ratios,
  readField,
  sizeConfig,
  defaultDuration,
  defaultRatio,
  directSizes,
  fps,
  pixelDimensions,
  stepsFrom,
} from '../comfy/config.js';

function updateSizeOptions(requestedMP) {
  if (!sizeConfig) return;
  const select = $('size');
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
  const selected = legacyFrameform && !allowed(requestedMP)
    ? current
    : requestedMP ?? current;
  const labelFor = (mp) => pixelDimensions($('ratio').value, mp);
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
function setupSlider(id, config, value, unit) {
  const input = $(id),
    group = input.closest('.slider');
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

function setupParameters() {
  $('size').closest('.size-field').hidden = !sizeConfig;
  $('ratio').closest('label').hidden = !defaultRatio;
  $('ratio').replaceChildren(
    ...Object.keys(ratios).map((ratio) => new Option(ratio, ratio)),
  );
  if (defaultRatio) $('ratio').value = defaultRatio;
  setupSlider(
    'steps',
    profile.steps,
    stepsFrom(readField(profile.steps?.field)),
    '',
  );
  setupSlider('duration', profile.duration, defaultDuration, ' 秒');
  updateSizeOptions();
  controls();
}
function controls() {
  $('stepval').value = $('steps').value;
  const seconds = $('duration').valueAsNumber;
  $('durationValue').value = seconds + ' 秒';
  $('duration').setAttribute('aria-valuetext', seconds + ' 秒');
  const timing = [];
  if (profile.duration) {
    const alignment = profile.duration.alignment;
    if (alignment && fps) {
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
  for (const input of [$('steps'), $('duration')]) {
    if (Number(input.max) > Number(input.min)) {
      const p = (100 * (input.value - input.min)) / (input.max - input.min);
      input.style.setProperty('--fill', p + '%');
    }
  }
}
function generationSettings() {
  return {
    duration: profile.duration ? $('duration').valueAsNumber : undefined,
    steps: profile.steps ? $('steps').valueAsNumber : undefined,
    mp: sizeConfig ? Number($('size').value) : undefined,
    ratio: defaultRatio ? $('ratio').value : undefined,
    dimensions: $('size').selectedOptions[0]?.text,
  };
}

export { setupParameters, updateSizeOptions, controls, generationSettings };
