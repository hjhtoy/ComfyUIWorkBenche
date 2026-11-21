import { $, elem, uid, button } from './dom.js';
import { mentionChip, promptFragment } from './mentions.js';
import {
  profile,
  legacyFrameform,
  ratios,
  sizeConfig,
  readField,
} from '../comfy/config.js';
import { materialLimit, referenceTag, slotsFor } from '../comfy/references.js';
import { outputURL } from '../comfy/api.js';
import {
  materialKind,
  materialKinds,
  materialSpecs,
  refKind,
  mediaKeyForRef,
} from '../media/types.js';
import {
  pageKey,
  readLocal,
  writeLocal,
  fileData,
} from '../storage/browser.js';
import {
  generationSettings,
  updateSizeOptions,
  controls,
} from './parameters.js';

export function setupComposer(serverChanged) {
  const editor = $('editor'),
    picker = $('picker'),
    tooltip = $('tooltip');
  const assets = [],
    mentions = new Map();
  let nextMention = 0,
    savedRange,
    restoring = false,
    restoreRevision = 0;
  const draftKey = 'frameform.draft.v1.' + pageKey;
  const assetCache = new Map();
  const draftStatus = $('draftStatus');
  async function readServerReference(ref) {
    if (!ref.source) return null;
    const { base, ...item } = ref.source;
    try {
      const response = await fetch(outputURL({ base }, item), {
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) return null;
      const blob = await response.blob();
      const kind = refKind(ref);
      if (
        blob.type &&
        !blob.type.startsWith(kind + '/') &&
        blob.type !== 'application/octet-stream' &&
        !(kind === 'audio' && blob.type === 'video/mp4')
      )
        return null;
      return new File([blob], ref.name, { type: blob.type });
    } catch {
      return null;
    }
  }
  const referenceSources = new Map();
  async function loadAsset(ref) {
    if (!ref?.id) return null;
    if (assetCache.has(ref.id)) return assetCache.get(ref.id);
    let file = await fileData(mediaKeyForRef(ref)).catch(() => null);
    let stored = file instanceof File;
    if (!stored) {
      file = await readServerReference(ref);
      if (!file) return null;
      try {
        await fileData(mediaKeyForRef(ref), file);
        stored = true;
      } catch {}
    }
    const existing = assetCache.get(ref.id);
    if (existing) return existing;
    const asset = {
      id: ref.id,
      file,
      kind: refKind(ref),
      url: URL.createObjectURL(file),
      stored,
    };
    assetCache.set(asset.id, asset);
    assets.push(asset);
    return asset;
  }
  function composerData() {
    const copy = document.createElement('div');
    copy.append(promptFragment(editor.innerHTML));
    const refs = activeMentions().map((key) => {
      const asset = mentions.get(key);
      return {
        ...referenceSources.get(key),
        key,
        kind: asset?.kind || referenceSources.get(key)?.kind,
        id: asset?.id ?? referenceSources.get(key)?.id,
        name:
          asset?.file.name ||
          copy.querySelector('[data-key="' + key + '"]')?.textContent,
      };
    });
    return {
      html: copy.innerHTML,
      refs,
      server: $('server').value,
      serverProfileId: $('serverList').value,
      ratio: $('ratio').value,
      mp: sizeConfig ? Number($('size').value) : undefined,
      duration: profile.duration ? $('duration').valueAsNumber : undefined,
      steps: profile.steps ? $('steps').valueAsNumber : undefined,
      height: editor.style.height,
    };
  }
  function saveDraft() {
    if (restoring) return;
    const draft = composerData();
    const saved = writeLocal(draftKey, draft);
    const available = draft.refs.every((ref) => mentions.get(ref.key)?.stored);
    draftStatus.textContent = !saved
      ? '浏览器存储不可用，刷新可能丢失草稿'
      : !available
        ? '部分素材未保存，刷新后可能要重新选择'
        : '草稿已保存';
  }
  async function applyComposer(data) {
    const revision = ++restoreRevision;
    restoring = true;
    $('promptRegion').inert = true;
    $('generate').disabled = true;
    draftStatus.textContent = '正在恢复草稿…';
    try {
      if (typeof data.server === 'string') {
        $('server').value = data.server;
        serverChanged(false, data.serverProfileId);
      }
      if (Object.hasOwn(ratios, data.ratio)) $('ratio').value = data.ratio;
      if (Number.isFinite(data.mp)) updateSizeOptions(data.mp);
      else updateSizeOptions();
      if (Number.isFinite(data.duration)) $('duration').value = data.duration;
      if (Number.isInteger(data.steps)) $('steps').value = data.steps;
      if (typeof data.height === 'string') editor.style.height = data.height;
      controls();
      const refs = data.refs || [];
      const resolved = await Promise.all(refs.map(loadAsset));
      if (revision !== restoreRevision) return false;
      refs.forEach((ref, i) => {
        if (ref.source) referenceSources.set(ref.key, ref);
        else referenceSources.delete(ref.key);
        if (resolved[i]) mentions.set(ref.key, resolved[i]);
        else mentions.delete(ref.key);
        nextMention = Math.max(nextMention, ref.key);
      });
      editor.replaceChildren(promptFragment(data.html));
      editorChanged();
      return true;
    } finally {
      if (revision === restoreRevision) {
        restoring = false;
        $('promptRegion').inert = false;
        $('generate').disabled = false;
        saveDraft();
      }
    }
  }

  function activeMentions() {
    const keys = Array.from(editor.querySelectorAll('.mention'), (node) =>
      Number(node.dataset.key),
    );
    return [...new Set(keys)].sort((a, b) => a - b);
  }
  function editorChanged() {
    const keys = activeMentions();
    const count = keys.length;
    $('refCount').textContent = count;
    $('refUsage').textContent = materialKinds
      .filter(materialLimit)
      .map((kind) => {
        const used = keys.filter(
          (key) => mentions.get(key)?.kind === kind,
        ).length;
        return (
          materialSpecs[kind].label + ' ' + used + '/' + materialLimit(kind)
        );
      })
      .join(' · ');
    editor.dataset.empty = String(
      !count && !editor.textContent.replaceAll('\u200b', '').trim(),
    );
    $('formError').textContent = '';
    saveDraft();
  }
  function selectionRange() {
    const selection = getSelection();
    if (
      selection.rangeCount &&
      editor.contains(selection.getRangeAt(0).commonAncestorContainer)
    )
      return selection.getRangeAt(0).cloneRange();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    return range;
  }
  function detectMention() {
    if (!materialKinds.some(materialLimit) || picker.open) return;
    const range = selectionRange(),
      node = range.startContainer,
      end = range.startOffset;
    if (
      range.collapsed &&
      node.nodeType === 3 &&
      /[@＠]/.test(node.data.charAt(end - 1)) &&
      end > 0
    ) {
      range.setStart(node, end - 1);
      openPicker(range);
    }
  }
  editor.oninput = (e) => {
    editorChanged();
    if (!e.isComposing && /[@＠]/.test(e.data || '')) detectMention();
  };
  editor.oncompositionend = (e) => {
    if (/[@＠]$/.test(e.data)) queueMicrotask(detectMention);
  };
  editor.onpaste = (e) => {
    e.preventDefault();
    document.execCommand(
      'insertText',
      false,
      e.clipboardData.getData('text/plain'),
    );
    editorChanged();
  };
  editor.ondrop = (e) => e.preventDefault();
  $('addRef').onmousedown = (e) => e.preventDefault();
  $('addRef').onclick = () => openPicker(selectionRange());
  $('closePicker').onclick = () => picker.close();
  $('browse').onclick = () => $('file').click();
  let libraryFilter = 'all';
  const libraryKey = 'frameform.material-library.v1.' + pageKey;
  const materialTabs = [...$('materialTabs').querySelectorAll('[role="tab"]')];
  function assetRecord(asset) {
    return { id: asset.id, kind: asset.kind, name: asset.file.name };
  }
  function rememberMaterial(asset) {
    if (!asset.stored) return;
    const entries = readLocal(libraryKey, []).filter(
      (ref) => ref.id !== asset.id,
    );
    entries.push(assetRecord(asset));
    writeLocal(libraryKey, entries);
  }
  let libraryReady;
  function restoreMaterialLibrary() {
    libraryReady ??= Promise.all(readLocal(libraryKey, []).map(loadAsset));
    return libraryReady;
  }
  function materialPreview(asset, controls = false) {
    const kind = asset.kind;
    if (kind === 'audio' && !controls)
      return elem('span', 'media-tile-icon', '♪');
    const media = elem(kind === 'image' ? 'img' : kind);
    media.src = asset.url;
    if (kind === 'image') {
      media.alt = '';
      media.loading = 'lazy';
    } else {
      media.preload = 'metadata';
      media.controls = controls;
      if (kind === 'video') {
        media.muted = !controls;
        media.playsInline = true;
      }
      if (controls) media.setAttribute('aria-label', asset.file.name);
    }
    return media;
  }
  function renderMaterialLibrary() {
    for (const tab of materialTabs) {
      const key = tab.dataset.kind;
      const count =
        key === 'all'
          ? assets.length
          : assets.filter((a) => a.kind === key).length;
      tab.querySelector('.queue-tab-count').textContent = count;
      tab.setAttribute('aria-description', count + ' 个素材');
      const active = key === libraryFilter;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active) $('materialPanel').setAttribute('aria-labelledby', tab.id);
    }
    const visible = assets.filter(
      (asset) => libraryFilter === 'all' || asset.kind === libraryFilter,
    );
    $('emptyLibrary').hidden = visible.length > 0;
    $('library').replaceChildren(
      ...visible.map((asset) => {
        const card = button('', () => insertMention(asset));
        card.className = 'thumb material-thumb';
        card.title = asset.file.name;
        card.setAttribute('aria-label', asset.file.name);
        const preview = elem('div', 'material-thumb-media');
        preview.setAttribute('aria-hidden', 'true');
        const media = materialPreview(asset);
        if (media.tagName === 'VIDEO' || media.tagName === 'IMG')
          media.onerror = () =>
            preview.replaceChildren(
              elem('span', 'media-tile-icon', materialSpecs[asset.kind].label),
            );
        preview.append(media);
        card.append(preview, elem('span', 'material-name', asset.file.name));
        return card;
      }),
    );
  }
  for (const [index, tab] of materialTabs.entries()) {
    const choose = () => {
      libraryFilter = tab.dataset.kind;
      $('pickError').textContent = '';
      renderMaterialLibrary();
    };
    tab.onclick = choose;
    tab.onkeydown = (event) => {
      const nav = {
        ArrowLeft: (index + materialTabs.length - 1) % materialTabs.length,
        ArrowRight: (index + 1) % materialTabs.length,
        Home: 0,
        End: materialTabs.length - 1,
      };
      if (!Object.hasOwn(nav, event.key)) return;
      event.preventDefault();
      const next = materialTabs[nav[event.key]];
      next.focus();
      next.click();
    };
  }
  function openPicker(range) {
    savedRange = range;
    $('pickError').textContent = '';
    $('file').value = '';
    libraryFilter = 'all';
    renderMaterialLibrary();
    picker.showModal();
    restoreMaterialLibrary().then(() => {
      if (picker.open) renderMaterialLibrary();
    });
  }
  async function matchingAsset(file, kind) {
    const candidates = assets.filter(
      (asset) => asset.kind === kind && asset.file.size === file.size,
    );
    const chunkSize = 1024 * 1024;
    for (const asset of candidates) {
      let same = true;
      for (let i = 0; i < file.size; i += chunkSize) {
        const [a, b] = await Promise.all([
          file.slice(i, i + chunkSize).arrayBuffer(),
          asset.file.slice(i, i + chunkSize).arrayBuffer(),
        ]);
        const one = new Uint8Array(a);
        const other = new Uint8Array(b);
        if (one.some((value, index) => value !== other[index])) {
          same = false;
          break;
        }
      }
      if (same) return asset;
    }
    return null;
  }
  async function importMaterial(file) {
    const kind = materialKind(file.name);
    if (!kind || !file.size)
      throw Error('无法导入 ' + file.name + '，请检查文件格式和内容。');
    const existing = await matchingAsset(file, kind);
    if (existing) {
      rememberMaterial(existing);
      return existing;
    }
    const copy = new File([file], file.name, {
      type: file.type,
      lastModified: file.lastModified,
    });
    const asset = {
      file: copy,
      kind,
      id: uid(),
      url: URL.createObjectURL(copy),
      stored: false,
    };
    if (kind === 'image') {
      const image = new Image();
      image.src = asset.url;
      try {
        await image.decode();
      } catch {
        URL.revokeObjectURL(asset.url);
        throw Error('无法读取图片 ' + file.name + '。');
      }
    }
    try {
      await fileData(mediaKeyForRef(asset), copy);
      asset.stored = true;
    } catch {}
    assetCache.set(asset.id, asset);
    assets.push(asset);
    rememberMaterial(asset);
    return asset;
  }
  $('file').onchange = async () => {
    const files = [...$('file').files];
    if (!files.length) return;
    const range = savedRange;
    const stillPicking = () => picker.open && savedRange === range;
    $('browse').disabled = true;
    const imported = [],
      errors = [];
    try {
      await restoreMaterialLibrary();
      for (const file of files) {
        try {
          imported.push(await importMaterial(file));
        } catch (e) {
          errors.push(e.message);
        }
        if (!stillPicking()) break;
      }
      if (!stillPicking()) return;
      renderMaterialLibrary();
      $('pickError').textContent = errors.join('\n');
      if (files.length === 1 && imported.length)
        insertMention(imported[0], files[0].name);
    } finally {
      $('browse').disabled = false;
      $('file').value = '';
    }
  };
  function insertMention(asset, displayName = asset.file.name) {
    const kind = asset.kind,
      limit = materialLimit(kind);
    if (!limit) {
      $('pickError').textContent =
        '当前工作流没有' +
        materialSpecs[kind].label +
        '输入槽位。素材已保存在素材库。';
      return false;
    }
    const active = activeMentions();
    let key = active.find((k) => mentions.get(k) === asset);
    if (key === undefined) {
      const count = active.filter((k) => mentions.get(k)?.kind === kind).length;
      if (count >= limit) {
        $('pickError').textContent =
          '已达到' +
          materialSpecs[kind].label +
          '素材上限（' +
          limit +
          '）。仍可重复引用已选素材。';
        return false;
      }
      key = ++nextMention;
      mentions.set(key, asset);
    }
    const chip = mentionChip(key, displayName, kind);
    picker.close();
    editor.focus();
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(savedRange);
    document.execCommand('insertHTML', false, chip.outerHTML + '&#8203;');
    editorChanged();
    return true;
  }
  function showTooltip(event) {
    const chip = event.target.closest('.mention');
    const asset = chip && mentions.get(+chip.dataset.key);
    if (!asset) return;
    const preview = materialPreview(asset);
    tooltip.querySelector('.tooltip-media').replaceChildren(preview);
    if (preview.tagName === 'VIDEO') {
      preview.loop = true;
      preview.play().catch(() => {});
    }
    tooltip.querySelector('p').textContent = chip.textContent;
    tooltip.hidden = false;
    const b = chip.getBoundingClientRect();
    tooltip.style.left =
      Math.max(4, Math.min(b.left, innerWidth - tooltip.offsetWidth - 5)) +
      'px';
    tooltip.style.top =
      (b.bottom + tooltip.offsetHeight + 7 < innerHeight
        ? b.bottom + 5
        : Math.max(4, b.top - tooltip.offsetHeight - 5)) + 'px';
  }
  function hideTooltip() {
    tooltip.hidden = true;
    tooltip.querySelector('.tooltip-media').replaceChildren();
  }
  for (const type of ['pointerover', 'focusin', 'click'])
    editor.addEventListener(type, showTooltip);
  for (const type of ['pointerout', 'focusout', 'input'])
    editor.addEventListener(type, hideTooltip);
  window.addEventListener('scroll', hideTooltip, true);

  function collectComposerMedia() {
    const keys = activeMentions();
    if (keys.some((k) => !mentions.has(k)))
      throw Error('部分素材无法读取，请删除对应标签并重新选择。');
    const files = [],
      fileKinds = [],
      tags = new Map(),
      counts = { image: 0, video: 0, audio: 0 };
    for (const key of keys) {
      const asset = mentions.get(key);
      const kind = asset.kind;
      files.push(asset.file);
      fileKinds.push(kind);
      tags.set(key, referenceTag(kind, ++counts[kind]));
    }
    for (const kind of materialKinds) {
      if (counts[kind] > materialLimit(kind))
        throw Error(materialSpecs[kind].label + '素材数量超过工作流上限。');
      const minimum = slotsFor(kind).findLastIndex((slot) => slot.required) + 1;
      if (counts[kind] < minimum)
        throw Error(
          '请按顺序添加至少 ' +
            minimum +
            ' 个' +
            materialSpecs[kind].label +
            '素材。',
        );
    }
    return { files, fileKinds, tags };
  }
  function snapshot() {
    const { files, fileKinds, tags } = collectComposerMedia();
    // innerText on a rendered copy preserves line breaks across browser editing modes.
    const copy = editor.cloneNode(true);
    copy.removeAttribute('id');
    copy.removeAttribute('data-placeholder');
    copy.contentEditable = 'false';
    copy.style.cssText =
      'position:fixed;left:-200vw;top:0;white-space:pre-wrap;';
    for (const chip of copy.querySelectorAll('.mention'))
      chip.replaceWith(tags.get(+chip.dataset.key) || '');
    document.body.append(copy);
    const prompt = copy.innerText.replaceAll('\u200b', '').trim();
    copy.remove();
    if (profile.prompt && !prompt)
      throw Error('请填写提示词，再加入生成队列。');
    const title =
      editor.innerText.replaceAll('\u200b', '').trim().slice(0, 80) ||
      profile.title;
    return {
      ...generationSettings(),
      prompt,
      form: composerData(),
      files,
      fileKinds,
      title,
    };
  }
  const hasMaterialSlots = materialKinds.some(materialLimit);
  $('refTools').hidden = $('refHint').hidden = !hasMaterialSlots;
  if (!profile.prompt) {
    $('promptLabel').textContent = '素材';
    editor.dataset.placeholder = '点击下方添加素材，或输入 @';
    if (!hasMaterialSlots) {
      $('promptRegion').hidden = true;
      $('promptRegion').parentElement.classList.add('no-prompt-region');
    }
  }

  function restoreDraft() {
    $('ratio').onchange = () => {
      updateSizeOptions();
      saveDraft();
    };
    $('size').onchange = saveDraft;
    for (const id of ['steps', 'duration'])
      $(id).oninput = () => {
        controls();
        saveDraft();
      };
    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        if (
          editor.style.height &&
          !restoring &&
          editor.style.height !== readLocal(draftKey, {})?.height
        )
          saveDraft();
      }).observe(editor);
    }
    const savedDraft = readLocal(draftKey, null);
    if (savedDraft)
      applyComposer(savedDraft).catch(() => {
        draftStatus.textContent = '草稿恢复失败，请检查浏览器存储。';
      });
    else if (
      !legacyFrameform &&
      !hasMaterialSlots &&
      readField(profile.prompt)
    ) {
      editor.textContent = readField(profile.prompt);
      editorChanged();
    }

    if (!savedDraft) editorChanged();
  }

  return {
    editor,
    draftStatus,
    restoreDraft,
    saveDraft,
    applyComposer,
    editorChanged,
    snapshot,
    assetRecord,
    loadAsset,
    materialPreview,
    restoreMaterialLibrary,
    importMaterial,
  };
}
