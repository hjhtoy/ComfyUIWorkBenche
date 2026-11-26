import { watchWorkspace } from '../storage/workspace.js';
import { pageKey } from '../storage/browser.js';
import { $, button, elem, uid } from './dom.js';
import { materialSpecs } from '../media/types.js';
import { emptyFolders, materialFolders } from '../storage/material-folders.js';

const all = { id: 'all', name: '全部素材' };
const unfiled = { id: 'unfiled', name: '未分类' };

export function setupMaterialPicker({
  assets, restoreMaterialLibrary, importMaterial, materialPreview, insertMention,
}) {
  const picker = $('picker');
  const tabs = [...$('materialTabs').querySelectorAll('[role="tab"]')];
  const selected = new Set();
  let catalog = emptyFolders();
  let folder = all.id;
  let kind = 'all';
  let mentionRange = null;
  let opening = 0;

  function clearMessages() {
    $('pickError').textContent = '';
    $('materialStatus').textContent = '';
  }

  function renderMove() {
    $('materialMove').hidden = !selected.size || !!mentionRange;
    $('materialMoveHint').hidden =
      !!mentionRange || !!selected.size || !$('library').childElementCount;
    $('selectionCount').textContent = '已选 ' + selected.size + ' 项';
    $('moveMaterials').disabled = !$('moveFolder').value;
  }

  function renderFolders() {
    const folders = [all, unfiled, ...catalog.folders];
    if (!folders.some((f) => f.id === folder)) folder = all.id;
    $('folderList').replaceChildren(...folders.map(({ id, name }) => {
      const item = button(name, () => {
        folder = id;
        selected.clear();
        clearMessages();
        renderView();
      });
      item.dataset.folder = id;
      item.title = name;
      return item;
    }));
    $('moveFolder').replaceChildren(
      new Option('移至目录…', ''),
      ...[unfiled, ...catalog.folders].map(({ id, name }) => new Option(name, id)),
    );
  }

  function cardFor(asset) {
    const card = button('', () => {
      if (mentionRange) {
        insertMention(asset, mentionRange);
        return;
      }
      if (selected.has(asset.id)) selected.delete(asset.id);
      else selected.add(asset.id);
      card.setAttribute('aria-pressed', String(selected.has(asset.id)));
      renderMove();
    });
    card.className = 'thumb material-thumb';
    card.title = asset.file.name;
    card.setAttribute('aria-label', asset.file.name);
    if (!mentionRange) card.setAttribute('aria-pressed', String(selected.has(asset.id)));
    const preview = elem('div', 'material-thumb-media');
    preview.setAttribute('aria-hidden', 'true');
    const media = materialPreview(asset);
    if (media.tagName === 'VIDEO' || media.tagName === 'IMG') {
      media.onerror = () => preview.replaceChildren(
        elem('span', 'media-tile-icon', materialSpecs[asset.kind].label),
      );
    }
    preview.append(media);
    card.append(preview, elem('span', 'material-name', asset.file.name));
    return card;
  }

  function renderView() {
    for (const item of $('folderList').children)
      item.setAttribute('aria-pressed', String(item.dataset.folder === folder));
    const items = folder === all.id ? assets : assets.filter(
      (asset) => (catalog.byAsset[asset.id] || unfiled.id) === folder,
    );
    for (const tab of tabs) {
      const key = tab.dataset.kind;
      const count = key === 'all' ? items.length : items.filter((a) => a.kind === key).length;
      tab.querySelector('.queue-tab-count').textContent = count;
      tab.setAttribute('aria-description', count + ' 个素材');
      const active = key === kind;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active) $('materialPanel').setAttribute('aria-labelledby', tab.id);
    }
    const visible = items.filter((asset) => kind === 'all' || asset.kind === kind);
    $('emptyLibrary').hidden = visible.length > 0;
    $('emptyLibrary').textContent = kind === 'all'
      ? '暂无素材，可从本机导入。'
      : '当前目录没有' + materialSpecs[kind].label + '素材。';
    $('library').replaceChildren(...visible.map(cardFor));
    renderMove();
  }

  for (const [index, tab] of tabs.entries()) {
    tab.onclick = () => {
      kind = tab.dataset.kind;
      selected.clear();
      clearMessages();
      renderView();
    };
    tab.onkeydown = (event) => {
      const nav = {
        ArrowLeft: (index + tabs.length - 1) % tabs.length,
        ArrowRight: (index + 1) % tabs.length,
        Home: 0, End: tabs.length - 1,
      };
      if (!Object.hasOwn(nav, event.key)) return;
      event.preventDefault();
      tabs[nav[event.key]].focus();
      tabs[nav[event.key]].click();
    };
  }

  function showFolderForm(show) {
    $('folderForm').hidden = !show;
    $('newFolder').setAttribute('aria-expanded', String(show));
    $('folderName').value = '';
    if (show) $('folderName').focus();
  }
  $('newFolder').onclick = () => showFolderForm($('folderForm').hidden);
  $('folderForm').onsubmit = async (event) => {
    event.preventDefault();
    const name = $('folderName').value.trim();
    const id = uid();
    const session = opening;
    clearMessages();
    try {
      catalog = await materialFolders((state) => {
        if (!name) throw Error('请输入目录名称。');
        if ([all, unfiled, ...state.folders].some((f) => f.name === name))
          throw Error('已存在同名目录。');
        state.folders.push({ id, name });
      });
      if (opening !== session || !picker.open) return;
      folder = id;
      kind = 'all';
      selected.clear();
      showFolderForm(false);
      renderFolders();
      renderView();
      $('folderList').querySelector('[aria-pressed="true"]').focus();
    } catch (e) {
      if (opening === session) $('pickError').textContent = e.message;
    }
  };

  function moveTo(ids, destination) {
    return materialFolders((state) => {
      if (destination !== unfiled.id && !state.folders.some((f) => f.id === destination))
        throw Error('找不到目标目录。');
      for (const id of ids) {
        if (destination === unfiled.id) delete state.byAsset[id];
        else state.byAsset[id] = destination;
      }
    });
  }
  $('moveFolder').onchange = renderMove;
  $('moveMaterials').onclick = async () => {
    const ids = [...selected];
    const destination = $('moveFolder').selectedOptions[0];
    const session = opening;
    clearMessages();
    try {
      catalog = await moveTo(ids, destination.value);
      if (opening !== session || !picker.open) return;
      selected.clear();
      renderView();
      $('materialStatus').textContent = '已将 ' + ids.length + ' 项移至「' + destination.text + '」。';
    } catch (e) {
      if (opening === session) $('pickError').textContent = e.message;
    }
  };

  $('browse').onclick = () => $('file').click();
  $('file').onchange = async () => {
    const files = [...$('file').files];
    if (!files.length) return;
    const destination = folder;
    const session = opening;
    const imported = [];
    const errors = [];
    $('browse').disabled = true;
    clearMessages();
    try {
      await restoreMaterialLibrary();
      for (const file of files) {
        try {
          imported.push(await importMaterial(file));
        } catch (e) {
          errors.push(e.message);
        }
      }
      if (imported.length && destination !== all.id)
        catalog = await moveTo(imported.map((asset) => asset.id), destination);
    } catch (e) {
      errors.push(e.message);
    } finally {
      $('browse').disabled = false;
      $('file').value = '';
      if (picker.open) {
        renderView();
        if (opening === session) {
          $('pickError').textContent = errors.join('\n');
          if (imported.length === 1)
            $('materialStatus').textContent = '已入库「' + imported[0].file.name + '」。';
          else if (imported.length)
            $('materialStatus').textContent =
              '已入库 ' + new Set(imported.map((asset) => asset.id)).size + ' 项。';
        }
      }
    }
  };

  async function openPicker(range = null) {
    const session = ++opening;
    mentionRange = range;
    kind = 'all';
    selected.clear();
    clearMessages();
    $('pickerTitle').textContent = range ? '选择素材' : '管理素材';
    $('newFolder').hidden = !!range;
    showFolderForm(false);
    renderFolders();
    renderView();
    picker.showModal();
    try {
      const [, state] = await Promise.all([restoreMaterialLibrary(), materialFolders()]);
      if (opening !== session || !picker.open) return;
      catalog = state;
      renderFolders();
      renderView();
    } catch (e) {
      if (opening === session && picker.open) $('pickError').textContent = e.message;
    }
  }
  watchWorkspace('material-folders:'+pageKey, state => {
    catalog = state;
    renderFolders();
    renderView();
  }, () => picker.open);
  watchWorkspace('frameform.material-library.v1.'+pageKey, async () => {
    await restoreMaterialLibrary();
    if (picker.open) renderView();
  }, () => picker.open);
  $('addRef').onmousedown = (e) => e.preventDefault();
  $('addRef').onclick = () => openPicker();
  $('closePicker').onclick = () => picker.close();
  return openPicker;
}
