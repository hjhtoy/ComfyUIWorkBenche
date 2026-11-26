import { hosted, updateWorkspace, writeWorkspace, watchWorkspace } from '../storage/workspace.js';
import { $, elem, uid } from './dom.js';
import { setupMaterialPicker } from './material-picker.js';
import { materialFolders } from '../storage/material-folders.js';
import { mentionChip, promptFragment } from './mentions.js';
import { advancedSettings } from './advanced-parameters.js';
import { fieldKey } from '../comfy/advanced.js';
import {
  profile,
  legacyFrameform,
  ratios,
  sizeConfig,
  durationSeconds,
  durationFieldValue,
  readField,
} from '../comfy/config.js';
import { materialLimit, referenceTag, slotsFor } from '../comfy/references.js';
import { outputURL } from '../comfy/api.js';
import { parseStoryboard } from '../batch/project.js';
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

// Reuse old snapshots where these controls were saved only as advanced values.
export function restoreH3Form(data) {
  const restored = profile.restoredH3Controls;
  if (!restored || data.h3ControlsRestored) return data;
  const advanced = { ...data.advanced };
  const next = { ...data, advanced, h3ControlsRestored: true };
  const take = (pair) => {
    const key = fieldKey(pair);
    const value = advanced[key];
    delete advanced[key];
    return value;
  };
  if (restored.prompt) {
    const value = take(profile.prompt);
    if (!next.html) {
      const content = elem('div');
      content.textContent =
        typeof value === 'string' ? value : readField(profile.prompt);
      next.html = content.innerHTML;
    }
  }
  if (restored.duration) {
    const { field, min, max, increment = 1 } = profile.duration;
    const value = take(field);
    if (!Number.isFinite(next.duration)) {
      const units = (value - min) / increment;
      next.duration =
        Number.isFinite(value) &&
        value >= min &&
        value <= max &&
        Math.abs(units - Math.round(units)) < 1e-7
          ? value
          : readField(field);
    }
  }
  return next;
}

export function setupComposer(serverChanged) {
  const editor = $('editor'),
    picker = $('picker'),
    tooltip = $('tooltip');
  const assets = [],
    mentions = new Map();
  let nextMention = 0,
    restoring = false,
    restoreRevision = 0,
    storyboardFilename = '';
  const draftKey = 'frameform.draft.v1.' + pageKey;
  const assetCache = new Map();
  const draftStatus = $('draftStatus');
  const advanced = advancedSettings('openAdvanced', '手动生成', saveDraft);
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
      ...(storyboardFilename && { storyboardFilename }),
      refs,
      server: $('server').value,
      serverProfileId: $('serverList').value,
      ratio: $('ratio').value,
      mp: sizeConfig ? Number($('size').value) : undefined,
      duration: profile.duration
        ? durationSeconds($('duration').valueAsNumber)
        : undefined,
      steps: profile.steps ? $('steps').valueAsNumber : undefined,
      height: editor.style.height,
      advanced: advanced.snapshot(),
      ...(profile.restoredH3Controls && { h3ControlsRestored: true }),
    };
  }
  let draftWrite = 0, draftConflict = false;
  async function saveDraft() {
    if (restoring) return;
    const draft = composerData();
    const revision = ++draftWrite;
    let saved;
    if (hosted) {
      draftStatus.textContent = '正在保存到工作区…';
      try { saved = await writeWorkspace(draftKey, draft); }
      catch (error) {
        if (revision === draftWrite) {
          draftStatus.textContent = error.message;
          draftConflict = true;
        }
        return;
      }
      if (revision !== draftWrite) return;
      draftConflict = false;
    } else saved = writeLocal(draftKey, draft);
    const available = draft.refs.every((ref) => mentions.get(ref.key)?.stored);
    draftStatus.textContent = !saved
      ? '浏览器存储不可用，刷新可能丢失草稿'
      : !available
        ? '部分素材未保存，刷新后可能要重新选择'
        : '草稿已保存';
  }
  async function applyComposer(saved) {
    const data = restoreH3Form(saved);
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
      if (Number.isFinite(data.duration))
        $('duration').value = durationFieldValue(data.duration);
      if (Number.isInteger(data.steps)) $('steps').value = data.steps;
      if (typeof data.height === 'string') editor.style.height = data.height;
      advanced.set(data.advanced);
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
      storyboardFilename =
        typeof data.storyboardFilename === 'string' ? data.storyboardFilename : '';
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
    if (editor.dataset.empty === 'true') storyboardFilename = '';
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
  // A single storyboard TXT: resolve its picture names against the library and
  // write the text with the same @-chips the picker inserts.
  async function importStoryboard(file) {
    if (!file) return;
    const error = $('formError');
    error.classList.remove('success');
    error.textContent = '';
    let text;
    try {
      text = await file.text();
    } catch {
      error.textContent = '无法读取 ' + file.name + '，请检查文件内容。';
      return;
    }
    await restoreMaterialLibrary();
    // Older copies of a renamed/redrawn asset are replaced by the newest take.
    const dropped = await pruneDuplicateMaterials();
    const materials = assets.map((asset) => ({
      name: asset.file.name,
      item: asset,
    }));
    const scene = parseStoryboard(file.name, text, materials);
    if (scene.errors.length) {
      error.textContent =
        '无法导入 ' + file.name + '：' + scene.errors.join('；');
      return;
    }
    const slots = new Map(scene.assets.map((slot) => [slot.key, slot]));
    const keys = new Map();
    for (const slot of scene.assets)
      if (!keys.has(slot.file.id)) keys.set(slot.file.id, ++nextMention);
    for (const slot of scene.assets) mentions.set(keys.get(slot.file.id), slot.file);
    const content = elem('div');
    for (const part of scene.fragments) {
      if (typeof part === 'string') content.append(part);
      else {
        const slot = slots.get(part.key);
        content.append(mentionChip(keys.get(slot.file.id), slot.name, slot.kind));
      }
    }
    // insertHTML keeps the change undoable, unlike replacing the child nodes.
    editor.focus();
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('insertHTML', false, content.innerHTML + '&#8203;');
    if (profile.duration && Number.isFinite(scene.duration)) {
      $('duration').value = durationFieldValue(scene.duration);
      controls();
    }
    storyboardFilename = file.name;
    editorChanged();
    const count = scene.assets.length;
    error.textContent =
      '已从 ' + file.name + ' 导入提示词' +
      (count ? '，引用 ' + count + ' 个素材。' : '。') +
      (dropped.length
        ? ' 素材库里的 ' +
          dropped.length +
          ' 条重名旧条目已移除，保留最近导入的一份。'
        : '');
    error.classList.add('success');
  }
  $('importTxt').onclick = () => $('txtFile').click();
  $('txtFile').onchange = async () => {
    const file = $('txtFile').files?.[0];
    $('txtFile').value = '';
    try {
      await importStoryboard(file);
    } catch (failure) {
      $('formError').textContent = '导入失败：' + failure.message;
    }
  };
  const openPicker = setupMaterialPicker({
    assets,
    restoreMaterialLibrary,
    importMaterial,
    materialPreview,
    insertMention,
  });
  const libraryKey = 'frameform.material-library.v1.' + pageKey;
  function assetRecord(asset) {
    return { id: asset.id, kind: asset.kind, name: asset.file.name };
  }
  function rememberMaterial(asset) {
    if (!asset.stored) return;
    if (hosted) return updateWorkspace(libraryKey, [], entries => [
      ...entries.filter(ref => ref.id !== asset.id), assetRecord(asset),
    ]);
    const entries = readLocal(libraryKey, []).filter(
      (ref) => ref.id !== asset.id,
    );
    entries.push(assetRecord(asset));
    writeLocal(libraryKey, entries);
  }
  // Clean up copies left by earlier versions: keep the newest, unlist the rest.
  async function pruneDuplicateMaterials() {
    const seen = new Set(),
      dropped = [];
    for (let i = assets.length - 1; i >= 0; i--) {
      const name = assets[i].file.name.normalize('NFC');
      if (seen.has(name)) dropped.push(assets[i]);
      else seen.add(name);
    }
    if (!dropped.length) return dropped;
    for (const asset of dropped) {
      const index = assets.indexOf(asset);
      if (index >= 0) assets.splice(index, 1);
    }
    const ids = new Set(dropped.map((asset) => asset.id));
    const keep = (ref) => !ids.has(ref.id);
    if (hosted) await updateWorkspace(libraryKey, [], (entries) => entries.filter(keep));
    else writeLocal(libraryKey, readLocal(libraryKey, []).filter(keep));
    return dropped;
  }
  let libraryReady;
  function restoreMaterialLibrary() {
    if (hosted) return updateWorkspace(libraryKey, []).then(entries => Promise.all(entries.map(loadAsset)));
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
      await rememberMaterial(existing);
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
    } catch (error) {
      if (hosted) { URL.revokeObjectURL(asset.url); throw error; }
    }
    assetCache.set(asset.id, asset);
    assets.push(asset);
    await rememberMaterial(asset);
    return asset;
  }
  // Batch imports keep their project folder so the library mirrors the source tree.
  const reservedFolderNames = new Set(['全部素材', '未分类']);
  async function fileMaterials(folderName, assetIds) {
    let name = String(folderName || '').trim().slice(0, 80);
    if (!name || !assetIds.length) return;
    if (reservedFolderNames.has(name)) name += '（项目）';
    await materialFolders((state) => {
      let folder = state.folders.find((item) => item.name === name);
      if (!folder) {
        folder = { id: uid(), name };
        state.folders.push(folder);
      }
      for (const id of assetIds) state.byAsset[id] = folder.id;
    });
  }
  function insertMention(asset, range) {
    if (
      !editor.contains(range.commonAncestorContainer) ||
      !/^[@＠]$/.test(range.toString())
    ) {
      $('pickError').textContent = '引用位置已更改，请重新输入 @ 选择素材。';
      return;
    }
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
    const chip = mentionChip(key, asset.file.name, kind);
    picker.close();
    editor.focus();
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
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
    // Keep a version without material chips: titles should describe the task.
    const titleCopy = copy.cloneNode(true);
    for (const chip of copy.querySelectorAll('.mention'))
      chip.replaceWith(tags.get(+chip.dataset.key) || '');
    document.body.append(copy);
    const prompt = copy.innerText.replaceAll('\u200b', '').trim();
    copy.remove();
    if (profile.prompt && !prompt)
      throw Error('请填写提示词，再加入生成队列。');
    for (const chip of titleCopy.querySelectorAll('.mention')) chip.remove();
    document.body.append(titleCopy);
    const titleText = titleCopy.innerText
      .replaceAll('\u200b', '')
      .replace(/\s+/g, ' ')
      .trim();
    titleCopy.remove();
    const title = storyboardFilename || titleText.slice(0, 80) || profile.title;
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
    editor.dataset.placeholder = '输入 @ 引用素材';
    if (!hasMaterialSlots) {
      $('promptRegion').hidden = true;
      $('promptRegion').parentElement.classList.add('no-prompt-region');
    }
  }

  watchWorkspace(draftKey, saved => applyComposer(saved), () =>
    !draftConflict && !restoring && !$('composer').contains(document.activeElement));
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
    else if (!legacyFrameform && readField(profile.prompt)) {
      // A default that references material slots cannot be prefilled safely, but
      // plain instructions (such as edit prompts) are useful starting text.
      const fallback = readField(profile.prompt);
      const tags = /<(?:Picture|Video|Audio)\s*\d+>/i.test(fallback);
      if (!hasMaterialSlots || !tags) {
        editor.textContent = fallback;
        editorChanged();
      }
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
    fileMaterials,
  };
}
