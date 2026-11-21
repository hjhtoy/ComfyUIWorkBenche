const $ = (id) => document.getElementById(id);
function elem(tag, cls, value) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (value !== undefined) node.textContent = value;
  return node;
}
function button(label, action) {
  const node = elem('button', 'button', label);
  node.onclick = action;
  return node;
}
function uid() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  return Array.from(
    bytes,
    (v, i) =>
      ([4, 6, 8, 10].includes(i) ? '-' : '') + v.toString(16).padStart(2, '0'),
  ).join('');
}

export { $, elem, button, uid };
