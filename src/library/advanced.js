import { $, elem } from '../ui/dom.js';
import {
  describeAdvancedField,
  fieldKey,
  protectedFields,
} from '../comfy/advanced.js';

const kindNames = {
  boolean: '开关',
  integer: '整数',
  number: '数值',
  text: '文本',
  enum: '下拉选项',
};

function originalText(value) {
  const text = String(
    typeof value === 'string' ? value : JSON.stringify(value),
  );
  return text.length > 80 ? text.slice(0, 80) + '…' : text || '空文本';
}

export function setupNodePicker() {
  const panel = $('workflowAdvanced');
  const search = $('workflowNodeFilter');
  const list = $('workflowNodeFields');
  const choices = new Map();
  const selected = new Set();
  let groups = [];

  function updateCount() {
    $('workflowAdvancedCount').textContent = selected.size + ' 项已选';
  }

  function draw() {
    const query = search.value.trim().toLowerCase();
    const expanded = new Set(
      [...list.querySelectorAll('details[open]')].map(
        (item) => item.dataset.node,
      ),
    );
    const container = document.createDocumentFragment();
    for (const { id, type, inputs } of groups) {
      const matchesNode = (id + ' ' + type).toLowerCase().includes(query);
      const rows = matchesNode
        ? inputs
        : inputs.filter((input) => input.name.toLowerCase().includes(query));
      if (!rows.length) continue;
      const group = elem('details', 'workflow-node');
      group.dataset.node = id;
      group.open = Boolean(query) || expanded.has(id);
      group.append(
        elem('summary', '', id + ' · ' + type + ' · ' + rows.length + ' 项'),
      );
      for (const { name, key, definition, reason, value } of rows) {
        const row = elem('label', 'workflow-node-field');
        const input = elem('input');
        input.type = 'checkbox';
        input.dataset.node = id;
        input.dataset.field = name;
        input.setAttribute('aria-label', id + ' · ' + type + ' · ' + name);
        input.disabled = !definition;
        input.checked = selected.has(key);
        input.onchange = () => {
          if (input.checked) selected.add(key);
          else selected.delete(key);
          updateCount();
        };
        const label = elem('span', 'workflow-node-label');
        label.append(
          elem('strong', '', name),
          elem('span', 'note', reason ?? kindNames[definition.kind]),
        );
        const original = elem(
          'span',
          'note workflow-node-value',
          originalText(value),
        );
        row.append(input, label, original);
        group.append(row);
      }
      container.append(group);
    }
    if (!container.childElementCount)
      container.append(elem('p', 'note', '没有匹配的节点参数。'));
    list.replaceChildren(container);
  }

  search.oninput = draw;
  function render(graph, profile, registry) {
    choices.clear();
    const protection = protectedFields(graph, profile);
    groups = Object.entries(graph).map(([id, node]) => ({
      id,
      type: node.class_type,
      inputs: Object.entries(node.inputs).map(([name, value]) => {
        const pair = [id, name];
        const key = fieldKey(pair);
        const { definition, reason } = describeAdvancedField(
          graph,
          pair,
          protection,
          registry,
        );
        if (definition) choices.set(key, definition);
        return { name, key, value, definition, reason };
      }),
    }));
    for (const key of selected) if (!choices.has(key)) selected.delete(key);
    updateCount();
    draw();
  }
  function clear() {
    selected.clear();
    choices.clear();
    groups = [];
    search.value = '';
    panel.open = false;
    list.replaceChildren();
    updateCount();
  }
  return {
    clear,
    render,
    definitions: () =>
      [...choices]
        .filter(([key]) => selected.has(key))
        .map(([, value]) => value),
  };
}
