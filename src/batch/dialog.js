import { $, elem } from '../ui/dom.js';
import { mentionChip } from '../ui/mentions.js';
import { serverAddress } from '../ui/servers.js';
import {
  setupPictureControls,
  pictureSettings,
  bindResolution,
  restoreResolution,
  updateSliderFill,
} from '../ui/parameters.js';
import { advancedSettings } from '../ui/advanced-parameters.js';
import { pageKey, readLocal, writeLocal } from '../storage/browser.js';
import { profile } from '../comfy/config.js';
import { materialKinds, materialSpecs } from '../media/types.js';
import { readBatchProject } from './project.js';

export function setupBatch(
  {
    editor,
    assetRecord,
    importMaterial,
    restoreMaterialLibrary,
    fileMaterials,
  },
  { enqueue, submitWaiting },
  { activateQueueTab, queueNotice },
) {
  const batchDialog = $('batchDialog');
  const picture = {
    ratio: $('batchRatio'),
    size: $('batchSize'),
    steps: $('batchSteps'),
    width: $('batchWidth'),
    height: $('batchHeight'),
  };
  const preferencesKey = 'frameform.batch.v1.' + pageKey;
  setupPictureControls(picture);
  const advanced = advancedSettings('batchAdvanced', '批量生成', saveSettings);
  const saved = readLocal(preferencesKey, {});
  if ([...picture.ratio.options].some((option) => option.value === saved.ratio))
    picture.ratio.value = saved.ratio;
  restoreResolution(picture, saved);
  if (Number.isInteger(saved.steps)) picture.steps.value = saved.steps;
  advanced.set(saved.advanced);
  refreshSteps();

  function refreshSteps() {
    $('batchStepsValue').value = picture.steps.value;
    updateSliderFill(picture.steps);
  }
  async function saveSettings() {
    const settings = {
      ...pictureSettings(picture),
      advanced: advanced.snapshot(),
    };
    $('batchSettingsStatus').textContent = await writeLocal(preferencesKey, settings)
      ? ''
      : '浏览器无法保存批量参数。';
    if (batchPreview) renderBatchPreview();
  }
  bindResolution(picture, saveSettings);
  picture.steps.oninput = () => {
    refreshSteps();
    saveSettings();
  };
  let batchPreview = null;
  let batchRevision = 0;
  let batchBusy = false;
  let selectedScenes = new Set();
  function formatSceneDuration(seconds) {
    return Number.isFinite(seconds) ? Number(seconds.toFixed(2)) + ' 秒' : '—';
  }
  function batchSettings() {
    return {
      base: serverAddress(),
      serverProfileId: $('serverList').value,
      editorHeight: editor.style.height,
    };
  }
  function resetBatchPreview() {
    batchPreview = null;
    selectedScenes.clear();
    $('batchSelectAll').checked = false;
    $('batchSelectAll').indeterminate = false;
    $('batchProjectName').textContent = '';
    $('batchError').textContent = '';
    $('batchRows').replaceChildren();
    $('batchSummary').textContent = '';
    $('batchTableWrap').hidden = true;
    $('batchEnqueue').disabled = true;
    $('batchEnqueue').textContent = '批量加入队列';
  }
  function updateBatchSelection() {
    if (!batchPreview) return;
    const { scenes } = batchPreview;
    const selectable = scenes.flatMap((scene, index) =>
      scene.errors.length ? [] : [index],
    );
    const chosen = selectable.filter((index) => selectedScenes.has(index));
    const all = $('batchSelectAll');
    all.disabled = batchBusy || !selectable.length;
    all.checked = !!selectable.length && chosen.length === selectable.length;
    all.indeterminate = chosen.length > 0 && chosen.length < selectable.length;
    $('batchSummary').textContent =
      '共 ' +
      scenes.length +
      ' 条 · 可提交 ' +
      selectable.length +
      ' 条 · 已选 ' +
      chosen.length +
      ' 条' +
      (selectable.length < scenes.length
        ? ' · 跳过 ' + (scenes.length - selectable.length) + ' 条'
        : '');
    $('batchEnqueue').disabled = batchBusy || !chosen.length;
    $('batchEnqueue').textContent = chosen.length
      ? '将 ' + chosen.length + ' 条加入生成队列'
      : '批量加入队列';
  }
  function renderBatchPreview() {
    const { root, scenes } = batchPreview;
    const settings = { ...batchPreview.settings, ...pictureSettings(picture) };
    $('batchProjectName').textContent =
      root +
      ' · ' +
      [
        settings.ratio,
        settings.dimensions,
        settings.steps != null ? settings.steps + ' 步' : null,
        settings.base,
      ]
        .filter(Boolean)
        .join(' · ');
    $('batchTableWrap').hidden = false;
    $('batchRows').replaceChildren(
      ...scenes.map((scene, index) => {
        const row = elem('tr');
        const select = elem('input');
        select.type = 'checkbox';
        select.checked = selectedScenes.has(index) && !scene.errors.length;
        select.disabled = !!scene.errors.length;
        select.setAttribute('aria-label', '选择 ' + scene.name);
        select.onchange = () => {
          if (select.checked) selectedScenes.add(index);
          else selectedScenes.delete(index);
          updateBatchSelection();
        };
        const selectCell = elem('td', 'batch-select');
        selectCell.append(select);
        const counts = Object.fromEntries(
          materialKinds.map((kind) => [kind, 0]),
        );
        for (const asset of scene.assets) counts[asset.kind]++;
        const description = materialKinds
          .filter((kind) => counts[kind])
          .map((kind) => materialSpecs[kind].label + ' ' + counts[kind])
          .join(' · ');
        const details = elem('td', '', description || '—');
        details.title = scene.assets.map((slot) => slot.name).join('\n');
        row.append(
          selectCell,
          elem('td', 'batch-scene-name', scene.name),
          elem('td', 'mono', formatSceneDuration(scene.duration)),
          details,
          elem(
            'td',
            scene.errors.length ? 'danger' : 'batch-ready',
            scene.errors.join('。') || '可提交',
          ),
        );
        return row;
      }),
    );
    updateBatchSelection();
  }
  function makeBatchJob(scene, settings, loaded, batchUploads) {
    const bindings = new Map(),
      files = [],
      fileKinds = [],
      uploadKeys = [];
    for (const [i, slot] of scene.assets.entries()) {
      const asset = loaded.get(slot.file);
      const ref = { ...assetRecord(asset), key: i + 1, name: slot.name };
      bindings.set(slot.key, ref);
      files.push(asset.file);
      fileKinds.push(slot.kind);
      uploadKeys.push(asset.id);
    }
    const content = elem('div');
    for (const part of scene.fragments) {
      if (typeof part === 'string') content.append(part);
      else {
        const ref = bindings.get(part.key);
        content.append(mentionChip(ref.key, ref.name, ref.kind));
      }
    }
    const {
      base,
      ratio,
      dimensions,
      mp,
      resolution,
      customResolution,
      steps,
      serverProfileId,
      editorHeight,
    } = settings;
    const form = {
      html: content.innerHTML,
      refs: [...bindings.values()],
      server: base,
      serverProfileId,
      ratio,
      mp,
      ...(resolution && { resolution, customResolution }),
      steps,
      duration: scene.duration,
      height: editorHeight,
      advanced: { ...settings.advanced },
    };
    return {
      prompt: scene.prompt,
      base,
      form,
      files,
      fileKinds,
      uploadKeys,
      batchUploads,
      title: scene.title,
      ratio,
      dimensions,
      mp,
      resolution,
      steps,
      duration: scene.duration,
    };
  }
  $('batchSelectAll').onchange = () => {
    if (!batchPreview) return;
    const on = $('batchSelectAll').checked;
    selectedScenes.clear();
    if (on)
      batchPreview.scenes.forEach((scene, index) => {
        if (!scene.errors.length) selectedScenes.add(index);
      });
    renderBatchPreview();
  };
  $('openBatch').onclick = () => {
    if (!batchDialog.open) batchDialog.showModal();
  };
  $('closeBatch').onclick = () => batchDialog.close();
  batchDialog.onclose = () => {
    if (batchDialog.open) return;
    batchRevision++;
    batchBusy = false;
    $('batchPicture').disabled = false;
    $('chooseBatchFolder').disabled = false;
    $('batchProgress').textContent = '';
    resetBatchPreview();
  };
  $('chooseBatchFolder').onclick = () => {
    $('batchFolder').value = '';
    $('batchFolder').click();
  };
  $('batchFolder').onchange = async () => {
    const files = [...$('batchFolder').files];
    if (!files.length) return;
    const revision = ++batchRevision;
    resetBatchPreview();
    $('batchError').textContent = '';
    $('batchProgress').textContent = '正在预检分镜…';
    $('chooseBatchFolder').disabled = true;
    try {
      const preview = await readBatchProject(files, batchSettings());
      if (revision !== batchRevision || !batchDialog.open) return;
      batchPreview = preview;
      renderBatchPreview();
    } catch (e) {
      if (revision === batchRevision) $('batchError').textContent = e.message;
    } finally {
      if (revision === batchRevision) {
        $('chooseBatchFolder').disabled = false;
        $('batchProgress').textContent = '';
        $('batchFolder').value = '';
      }
    }
  };
  $('batchEnqueue').onclick = async () => {
    if (batchBusy || !batchPreview) return;
    const revision = batchRevision;
    const { root, scenes } = batchPreview;
    let parameters;
    try {
      parameters = pictureSettings(picture, true);
    } catch (error) {
      $('batchError').textContent = error.message;
      return;
    }
    const settings = {
      ...batchPreview.settings,
      ...parameters,
      advanced: advanced.snapshot(),
    };
    const preflight = scenes.filter(
      (scene, index) => selectedScenes.has(index) && !scene.errors.length,
    );
    if (!preflight.length) return;
    batchBusy = true;
    $('batchPicture').disabled = true;
    $('batchEnqueue').disabled = $('chooseBatchFolder').disabled = true;
    $('batchSelectAll').disabled = true;
    $('batchError').textContent = '';
    const loaded = new Map(),
      failures = new Map(),
      batchUploads = new Map();
    const files = [
      ...new Set(
        preflight.flatMap((scene) => scene.assets.map((slot) => slot.file)),
      ),
    ];
    try {
      await restoreMaterialLibrary();
      for (const [i, file] of files.entries()) {
        if (revision !== batchRevision || !batchDialog.open) return;
        $('batchProgress').textContent =
          '正在准备素材 ' + (i + 1) + ' / ' + files.length + '…';
        try {
          loaded.set(file, await importMaterial(file));
        } catch (e) {
          failures.set(file, e.message);
        }
      }
      if (revision !== batchRevision || !batchDialog.open) return;
      try {
        await fileMaterials(
          root,
          [...new Set([...loaded.values()].map((asset) => asset.id))],
        );
      } catch {
        /* 归类失败不影响生成任务。 */
      }
      for (const scene of preflight) {
        const problems = scene.assets
          .map((slot) => failures.get(slot.file))
          .filter(Boolean);
        scene.errors.push(...new Set(problems));
      }
      const ready = preflight.filter((scene) => !scene.errors.length);
      if (!ready.length) {
        $('batchError').textContent = '没有通过素材读取检查的分镜。';
        return;
      }
      const staged = ready.map((scene) =>
        makeBatchJob(scene, settings, loaded, batchUploads),
      );
      await enqueue(staged);
      batchDialog.close();
      activateQueueTab($('queueTab-processing'));
      const skipped = preflight.filter((scene) => scene.errors.length);
      const first = skipped[0];
      const warning = first
        ? '跳过 ' +
          skipped.length +
          ' 条。' +
          first.name +
          '：' +
          first.errors[0]
        : '';
      queueNotice(
        '已将 ' + staged.length + ' 条分镜加入队列。' + warning,
        !!first,
      );
      submitWaiting();
    } catch (e) {
      if (revision === batchRevision)
        $('batchError').textContent = '无法准备批量任务。' + e.message;
    } finally {
      if (revision === batchRevision) {
        batchBusy = false;
        $('batchPicture').disabled = false;
        $('chooseBatchFolder').disabled = false;
        $('batchProgress').textContent = '';
        if (batchDialog.open && batchPreview) renderBatchPreview();
      }
    }
  };

  $('openBatch').hidden = !profile.prompt || !profile.duration;
}
