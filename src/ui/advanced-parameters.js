import { $, elem } from './dom.js';
import { profile, readField, template } from '../comfy/config.js';
import {
  advancedDefinitions,
  allowsAdvancedValue,
  fieldKey,
  filterAdvancedValues,
} from '../comfy/advanced.js';

const definitions = advancedDefinitions(template, profile);

function fieldControl(definition, value) {
  const { kind, options } = definition;
  if (kind === 'enum') {
    const input = elem('select');
    input.replaceChildren(
      ...options.map((item, index) => new Option(String(item), String(index))),
    );
    input.value = String(options.indexOf(value));
    return { input, read: () => options[Number(input.value)] };
  }
  if (kind === 'text' && definition.multiline) {
    const input = elem('textarea');
    input.rows = 3;
    input.value = value;
    return { input, read: () => input.value };
  }
  const input = elem('input');
  if (kind === 'boolean') {
    input.type = 'checkbox';
    input.checked = value;
    return { input, read: () => input.checked };
  }
  if (kind === 'integer' || kind === 'number') {
    input.type = 'number';
    // Validate against the model's bounds and increments on save.
    input.step = 'any';
    input.value = value;
    return { input, read: () => input.valueAsNumber };
  }
  input.type = 'text';
  input.value = value;
  return { input, read: () => input.value };
}

function showAdvanced(context, values, save) {
  const dialog = $('advancedDialog');
  if (dialog.open) return;
  const container = $('advancedFields');
  const error = $('advancedError');
  const form = $('advancedForm');
  $('advancedTitle').textContent = context + '高级参数';
  error.textContent = '';

  function render(current) {
    container.replaceChildren();
    return definitions.map((definition) => {
      const [id, key] = definition.field;
      const index = fieldKey(definition.field);
      const original = readField(definition.field);
      const { input, read } = fieldControl(
        definition,
        current[index] ?? original,
      );
      input.dataset.node = id;
      input.dataset.field = key;
      const row = elem('label', 'advanced-row');
      const text = elem('span', 'advanced-label');
      text.append(
        elem('strong', '', key),
        elem('span', 'note', id + ' · ' + template[id].class_type),
      );
      row.append(text, input);
      container.append(row);
      return { definition, index, original, input, read };
    });
  }

  let fields = render(values);
  $('advancedReset').onclick = () => {
    fields = render({});
    error.textContent = '';
  };
  $('advancedClose').onclick = $('advancedCancel').onclick = () =>
    dialog.close();
  form.onsubmit = (event) => {
    event.preventDefault();
    const overrides = Object.create(null);
    for (const item of fields) {
      const { definition, original, index, input, read } = item;
      const value = read();
      if (!allowsAdvancedValue(definition, value, original)) {
        const bounds = [];
        if (Number.isFinite(definition.min))
          bounds.push('最小 ' + definition.min);
        if (Number.isFinite(definition.max))
          bounds.push('最大 ' + definition.max);
        if (definition.step) bounds.push('步长 ' + definition.step);
        error.textContent =
          definition.field[1] +
          ' 的值无效' +
          (bounds.length ? ' · ' + bounds.join(' · ') : '。');
        input.focus();
        return;
      }
      if (value !== original) overrides[index] = value;
    }
    save(overrides);
    dialog.close();
  };
  dialog.showModal();
}

export function advancedSettings(triggerId, context, onSave) {
  const trigger = $(triggerId);
  trigger.hidden = !definitions.length;
  let values = {};
  const set = (next) => {
    values = filterAdvancedValues(template, definitions, next);
    const count = Object.keys(values).length;
    trigger.textContent = count ? '高级参数 · ' + count : '高级参数';
  };
  trigger.onclick = () =>
    showAdvanced(context, values, (next) => {
      set(next);
      onSave();
    });
  return { set, snapshot: () => ({ ...values }) };
}

export function showJobAdvanced(values) {
  const fields = filterAdvancedValues(template, definitions, values);
  const list = $('playerAdvanced');
  list.replaceChildren();
  for (const { field } of definitions) {
    const key = fieldKey(field);
    if (!Object.hasOwn(fields, key)) continue;
    const [id, input] = field;
    const value = fields[key];
    list.append(
      elem('dt', '', id + ' · ' + input),
      elem(
        'dd',
        '',
        typeof value === 'boolean' ? (value ? '开启' : '关闭') : String(value),
      ),
    );
  }
  list.hidden = $('playerAdvancedLabel').hidden = !list.childElementCount;
}
