import { $, elem } from '../ui/dom.js';
import { mentionChip } from '../ui/mentions.js';
import { serverAddress } from '../ui/servers.js';
import { generationSettings } from '../ui/parameters.js';
import { profile } from '../comfy/config.js';
import { materialKinds, materialSpecs } from '../media/types.js';
import { readBatchProject } from './project.js';

export function setupBatch(
  { editor, assetRecord, importMaterial, restoreMaterialLibrary },
  { enqueue, submitWaiting },
  { activateQueueTab, queueNotice },
) {
  const batchDialog = $('batchDialog');
  let batchPreview = null;
  let batchRevision = 0;
  let batchBusy = false;
  function formatSceneDuration(seconds) {
    return Number.isFinite(seconds) ? seconds + ' 秒' : '—';
  }
  function batchSettings() {
    return {
      ...generationSettings(),
      base: serverAddress(),
      serverProfileId: $('serverList').value,
      editorHeight: editor.style.height,
    };
  }
  function resetBatchPreview() {
    batchPreview = null;
    $('batchProjectName').textContent = '';
    $('batchError').textContent = '';
    $('batchRows').replaceChildren();
    $('batchSummary').textContent = '';
    $('batchTableWrap').hidden = true;
    $('batchEnqueue').disabled = true;
    $('batchEnqueue').textContent = '批量加入队列';
  }
  function renderBatchPreview() {
    const { root, settings, scenes } = batchPreview;
    const ready = scenes.filter((scene) => !scene.errors.length).length;
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
    $('batchSummary').textContent =
      '共 ' +
      scenes.length +
      ' 条 · 可提交 ' +
      ready +
      ' 条' +
      (ready < scenes.length
        ? ' · 跳过 ' + (scenes.length - ready) + ' 条'
        : '');
    $('batchTableWrap').hidden = false;
    $('batchRows').replaceChildren(
      ...scenes.map((scene) => {
        const row = elem('tr');
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
    $('batchEnqueue').disabled = batchBusy || !ready;
    $('batchEnqueue').textContent = ready
      ? '将 ' + ready + ' 条加入生成队列'
      : '批量加入队列';
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
      steps,
      duration: scene.duration,
      height: editorHeight,
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
      steps,
      duration: scene.duration,
    };
  }
  $('openBatch').onclick = () => {
    if (!batchDialog.open) batchDialog.showModal();
  };
  $('closeBatch').onclick = () => batchDialog.close();
  batchDialog.onclose = () => {
    if (batchDialog.open) return;
    batchRevision++;
    batchBusy = false;
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
    const revision = batchRevision,
      { settings, scenes } = batchPreview;
    const preflight = scenes.filter((scene) => !scene.errors.length);
    if (!preflight.length) return;
    batchBusy = true;
    $('batchEnqueue').disabled = $('chooseBatchFolder').disabled = true;
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
      enqueue(staged);
      batchDialog.close();
      activateQueueTab($('queueTab-processing'));
      const skipped = scenes.filter((scene) => scene.errors.length);
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
        $('chooseBatchFolder').disabled = false;
        $('batchProgress').textContent = '';
        if (batchDialog.open && batchPreview) renderBatchPreview();
      }
    }
  };

  $('openBatch').hidden = !profile.prompt || !profile.duration;
}
