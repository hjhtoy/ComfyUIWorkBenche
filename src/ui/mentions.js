import { elem } from './dom.js';
import { materialKind, refKind } from '../media/types.js';

function mentionChip(key, name, kind = materialKind(name) || 'image') {
  const chip = elem('span', 'mention', name);
  chip.contentEditable = 'false';
  chip.dataset.key = String(key);
  chip.dataset.kind = kind;
  chip.tabIndex = 0;
  return chip;
}
function promptFragment(html) {
  const template = document.createElement('template');
  template.innerHTML = String(html || '');
  function copy(node) {
    if (node.nodeType === Node.TEXT_NODE)
      return document.createTextNode(node.data);
    if (node.nodeType !== Node.ELEMENT_NODE)
      return document.createDocumentFragment();
    const key = Number(node.dataset.key);
    if (
      node.classList.contains('mention') &&
      Number.isSafeInteger(key) &&
      key > 0
    )
      return mentionChip(
        key,
        node.textContent,
        refKind({ kind: node.dataset.kind, name: node.textContent }),
      );
    const target = ['DIV', 'P', 'BR'].includes(node.tagName)
      ? document.createElement(node.tagName)
      : document.createDocumentFragment();
    for (const child of node.childNodes) target.append(copy(child));
    return target;
  }
  const fragment = document.createDocumentFragment();
  for (const child of template.content.childNodes) fragment.append(copy(child));
  return fragment;
}
function formatServerPrompt(prompt, bindings, appendUnmentioned = false) {
  const content = elem('div');
  const tags = new Map(
    bindings
      .filter((item) => item.tag)
      .map(({ tag, ref }) => [tag.toLowerCase(), ref]),
  );
  const shown = new Set();
  for (const part of prompt.split(/(<[A-Za-z][A-Za-z0-9 _-]* \d+>)/g)) {
    const ref = tags.get(part.toLowerCase());
    if (ref) {
      content.append(mentionChip(ref.key, ref.name, ref.kind));
      shown.add(ref.key);
    } else content.append(part);
  }
  if (appendUnmentioned) {
    for (const { ref, tag } of bindings) {
      if (tag || shown.has(ref.key)) continue;
      if (content.childNodes.length) content.append(' ');
      content.append(mentionChip(ref.key, ref.name, ref.kind));
    }
  }
  return content;
}

export { mentionChip, promptFragment, formatServerPrompt };
