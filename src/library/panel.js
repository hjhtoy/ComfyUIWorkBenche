import { hosted, watchWorkspace, workspaceRequest } from '../storage/workspace.js';
import { pageKey } from '../storage/browser.js';
import { setupNodePicker } from './advanced.js';
import { api, normalizeServer } from '../comfy/api.js';
import { template, profile } from '../comfy/config.js';
import { $, elem, uid } from '../ui/dom.js';
import { terminal } from '../jobs/state.js';
import { workflowPageKey } from '../storage/browser.js';
import { jobSession, workflowSessionKey } from '../storage/jobs.js';
import { field, fieldLabel, parseWorkflow, stableGraph } from './graph.js';
import { mappingCandidates, mappingVersion, outputChoices } from './mapping.js';
import {
  addWorkflow,
  lastWorkflow,
  readWorkflows,
  rememberWorkflow,
  removeWorkflow,
} from './persistence.js';
import { workspaceDocument } from './render.js';

const builtin = {
  id: 'pika-h3',
  title: profile.title,
  graph: template,
  profile,
  video: true,
};
const shape = (value) => JSON.stringify(value);
const controlIds = [
  'workflowPrompt',
  'workflowSize',
  'workflowSteps',
  'workflowDuration',
];
const names = { image: '图片', video: '视频', audio: '音频' };
const select = $('workflowSelect');
const removeButton = $('workflowRemove');
const removeDialog = $('removeWorkflowDialog');
const views = $('workflowViews');
const dialog = $('workflowDialog');
const builtInView = $('builtinWorkbench');
const workspaceTemplate = JSON.parse(
  $('workflowWorkspaceTemplate').textContent,
);
const workspaceRuntime = $('workbenchRuntime').textContent;
const workspaceCSS = $('workflowLibraryStyles').textContent;
const frames = new Map();
const nodePicker = setupNodePicker();
let library = [];
let current = builtin.id;
let pending;
let revision = 0;
let saving = false;
let removing = false;
let removalTarget;
const availableWorkflows = () => [
  builtin,
  ...library.filter((entry) => !entry.removed),
];

function notice(message) {
  const status = $('workflowNotice');
  status.textContent = message;
  status.hidden = !message;
}
function importError(message) {
  $('workflowError').textContent = message;
}
function renderLibrary() {
  select.replaceChildren(
    ...availableWorkflows().map(({ id, title }) => new Option(title, id)),
  );
  select.value = current;
  updateRemoveButton();
}
function activateFrame(entry) {
  let frame = frames.get(entry.id);
  if (!frame) {
    frame = elem('iframe', 'workflow-frame');
    frame.title = entry.title + ' 工作台';
    frame.dataset.workflowId = entry.id;
    frame.hidden = current !== entry.id;
    frame.addEventListener(
      'load',
      () => {
        if (
          frame.contentDocument?.documentElement.dataset.workbenchReady !==
          'true'
        ) {
          notice(
            '这个工作流的页面未能启动。可切回其他工作流，或检查浏览器设置。',
          );
          return;
        }
        if (current === entry.id) notice('');
      },
      { once: true },
    );
    const filename = location.pathname.split('/').pop();
    let name = filename;
    try {
      name = decodeURIComponent(filename);
    } catch {}
    const content = workspaceDocument(
      workspaceTemplate,
      workspaceRuntime,
      entry,
      name,
      workspaceCSS,
    );
    if (hosted) {
      workspaceRequest('records').then(records => {
        const marker = document.createElement('script');
        marker.type = 'application/json';
        marker.id = 'frameformWorkspace';
        marker.textContent = JSON.stringify(records).replaceAll('<','\\u003c');
        frame.srcdoc = content.replace('<head>',() => '<head>'+marker.outerHTML);
        views.append(frame);
      }).catch(error => notice(error.message));
    } else { frame.srcdoc = content; views.append(frame); }
    frames.set(entry.id, frame);
  }
  return frame;
}
function activate(id) {
  const next = availableWorkflows().find((item) => item.id === id) || builtin;
  const previous = current;
  current = next.id;
  document.title = 'Frameform · ' + next.title;
  select.value = current;
  updateRemoveButton();
  notice('');
  builtInView.hidden = current !== builtin.id;
  views.hidden = !builtInView.hidden;
  if (views.hidden) {
    if (previous !== current)
      window.dispatchEvent(new Event('frameform:activate'));
  } else {
    const frame = activateFrame(next);
    for (const [id, other] of frames) other.hidden = id !== current;
    if (
      frame.contentDocument?.documentElement.dataset.workbenchReady ===
        'true' &&
      previous !== current
    )
      frame.contentWindow.dispatchEvent(new Event('frameform:activate'));
  }
  if (previous !== current) window.scrollTo({ top: 0, behavior: 'instant' });
  if (!rememberWorkflow(current)) notice('浏览器无法保存上次打开的工作流。');
}

function setOptions(id, entries, preferred, retain) {
  const control = $(id);
  const previous = control.value;
  control.replaceChildren(
    ...entries.map(([value, text]) => new Option(text, value)),
  );
  const choice =
    retain && entries.some(([key]) => key === previous) ? previous : preferred;
  if (entries.some(([key]) => key === choice)) control.value = choice;
}

function sizeLabel(config) {
  const graph = pending.graph;
  return config.mode === 'selector'
    ? fieldLabel(graph, config.megapixels)
    : fieldLabel(graph, config.width) + ' / ' + config.height[1];
}
function mappingOptions(id, candidates, suggested, label, retain) {
  const options = new Map();
  if (suggested) options.set(shape(suggested), suggested);
  for (const item of candidates) options.set(shape(item), item);
  const choices = [
    ['', '保留工作流原值'],
    ...[...options].map(([key, item]) => [key, label(item)]),
  ];
  setOptions(id, choices, shape(suggested) ?? '', retain);
}

function chosenProfile() {
  if (pending.builtin) return { ...builtin.profile, legacyFrameform: false };
  const result = { ...(pending.mapping?.profile ?? { outputs: [] }) };
  for (const [index, key] of [
    'prompt',
    'size',
    'steps',
    'duration',
  ].entries()) {
    const value = $(controlIds[index]).value;
    if (value) result[key] = JSON.parse(value);
    else delete result[key];
  }
  return result;
}
function reviewNodeFields() {
  nodePicker.render(pending.graph, chosenProfile(), pending.registry);
}

function refreshMapping(retain = false) {
  const output = $('workflowOutput').value;
  $('workflowCreate').disabled = !output || saving;
  if (!output) {
    pending.mapping = null;
    for (const id of controlIds) {
      $(id).replaceChildren(new Option('请先选择输出节点', ''));
      $(id).disabled = true;
    }
    $('workflowDuration').closest('label').hidden = false;
    $('workflowReferences').hidden = true;
    reviewNodeFields();
    return;
  }
  for (const id of controlIds) $(id).disabled = false;
  const graph = pending.graph;
  const mapping = mappingCandidates(graph, output, pending.registry);
  $('workflowDuration').closest('label').hidden = mapping.image;
  pending.mapping = mapping;
  const describe = (pair) => fieldLabel(graph, pair);
  mappingOptions(
    'workflowPrompt',
    mapping.prompts,
    mapping.profile.prompt,
    describe,
    retain,
  );
  mappingOptions(
    'workflowSize',
    mapping.sizes,
    mapping.profile.size,
    sizeLabel,
    retain,
  );
  const stepLabel = ({ field, mode }) =>
    describe(field) + (mode === 'sigmas' ? ' · Sigma 曲线' : '');
  mappingOptions(
    'workflowSteps',
    mapping.sliders,
    mapping.profile.steps,
    stepLabel,
    retain,
  );
  mappingOptions(
    'workflowDuration',
    mapping.seconds,
    mapping.profile.duration,
    ({ field, alignment, unit }) =>
      describe(field) + (unit === 'frames' ? ' · 帧数' : alignment ? ' · 秒转帧' : ' · 秒'),
    retain,
  );
  $('workflowReferences').hidden = !mapping.references.length;
  $('workflowRefCount').textContent = mapping.references.length + ' 个连接槽位';
  $('workflowReferenceList').replaceChildren(
    ...mapping.references.map((slot) => {
      const row = elem('div', 'workflow-reference note');
      row.append(
        elem('strong', '', names[slot.kind]),
        elem(
          'span',
          '',
          describe(slot.file) + (slot.required ? ' · 必填' : ' · 可选'),
        ),
      );
      return row;
    }),
  );
  reviewNodeFields();
}

function reviewOutputs(retain = false) {
  const { graph, registry } = pending;
  const choices = outputChoices(graph, registry);
  const recognized = outputChoices(graph);
  const auto =
    recognized.find(([, node]) => node.class_type !== 'PreviewImage') ||
    recognized[0];
  const all = choices.length ? choices : Object.entries(graph);
  setOptions(
    'workflowOutput',
    [
      ['', '选择主输出节点'],
      ...all.map(([id, node]) => [id, id + ' · ' + node.class_type]),
    ],
    auto?.[0] || '',
    retain,
  );
  refreshMapping(retain);
  $('workflowImportStatus').textContent =
    Object.keys(graph).length +
    ' 个节点 · ' +
    (recognized.length > 1
      ? '检测到多个输出，请确认主输出'
      : auto
        ? '已识别控件，可直接生成或调整'
        : '请选择用于输出图片或视频的节点');
  if (pending.builtin) {
    $('workflowImportStatus').textContent =
      '这份 JSON 与内置的 Pika H3 Flex 相同。勾选节点参数可创建自定义副本。';
  }
}

function currentServerSettings() {
  const selected =
    current === builtin.id ? document : frames.get(current)?.contentDocument;
  return {
    server: selected?.getElementById('server')?.value || $('server').value,
    serverProfile: selected?.getElementById('serverList')?.value || '',
  };
}

function resetImport() {
  revision++;
  pending = null;
  nodePicker.clear();
  importError('');
  $('workflowForm').reset();
  $('workflowImportStatus').textContent =
    '选择从 ComfyUI 导出的 API 格式 JSON。';
  $('workflowNodeStatus').textContent = '';
  $('workflowCheckNodes').disabled = false;
  $('workflowMapping').hidden = true;
  $('workflowCreate').disabled = true;
}
$('workflowImport').onclick = () => {
  resetImport();
  dialog.showModal();
};
$('workflowClose').onclick = $('workflowCancel').onclick = () => dialog.close();
dialog.onclose = () => {
  revision++;
};
$('workflowFile').onchange = async () => {
  const file = $('workflowFile').files[0];
  const ticket = ++revision;
  pending = null;
  nodePicker.clear();
  importError('');
  $('workflowMapping').hidden = true;
  $('workflowCreate').disabled = true;
  $('workflowCheckNodes').disabled = false;
  $('workflowNodeStatus').textContent = '';
  if (!file) {
    $('workflowImportStatus').textContent =
      '选择从 ComfyUI 导出的 API 格式 JSON。';
    return;
  }
  $('workflowImportStatus').textContent = '正在分析工作流…';
  try {
    const graph = parseWorkflow(await file.text());
    if (ticket !== revision) return;
    const same = stableGraph(graph) === stableGraph(builtin.graph);
    pending = { graph, registry: {}, mapping: null, builtin: same };
    $('workflowName').value = (
      same ? builtin.title : file.name.replace(/\.json$/i, '')
    ).slice(0, 100);
    $('workflowMapping').hidden = false;
    $('workflowMappingFields').hidden = same;
    reviewOutputs();
  } catch (error) {
    if (ticket !== revision) return;
    $('workflowImportStatus').textContent = '';
    importError(error.message);
  }
};
$('workflowOutput').onchange = () => {
  importError('');
  refreshMapping();
};
for (const id of controlIds) $(id).onchange = reviewNodeFields;
$('workflowCheckNodes').onclick = async () => {
  if (!pending) return;
  const ticket = revision;
  const status = $('workflowNodeStatus');
  $('workflowCheckNodes').disabled = true;
  status.textContent = '正在读取 ComfyUI 节点定义…';
  try {
    const registry = await api(
      normalizeServer(currentServerSettings().server),
      '/object_info',
    );
    if (ticket !== revision) return;
    if (!registry || !Object.keys(registry).length)
      throw Error('服务器没有返回节点定义。');
    pending.registry = registry;
    reviewOutputs(true);
    const classes = [
      ...new Set(Object.values(pending.graph).map((node) => node.class_type)),
    ];
    const missing = classes.filter((type) => !Object.hasOwn(registry, type));
    status.textContent = missing.length
      ? '服务器缺少节点 · ' + missing.join('、')
      : '服务器已提供全部 ' + classes.length + ' 种节点的定义。';
  } catch (error) {
    if (ticket === revision)
      status.textContent = '无法检查节点。' + error.message;
  } finally {
    if (ticket === revision) $('workflowCheckNodes').disabled = false;
  }
};

$('workflowForm').onsubmit = async (event) => {
  event.preventDefault();
  if (!pending?.mapping || saving) return;
  const ticket = revision;
  saving = true;
  $('workflowCreate').disabled = true;
  $('workflowFile').disabled = true;
  importError('');
  try {
    const advanced = nodePicker.definitions();
    if (pending.builtin && !advanced.length) {
      dialog.close();
      activate(builtin.id);
      return;
    }
    const { graph, mapping } = pending;
    let title = $('workflowName').value.trim();
    if (!title) throw Error('请输入工作流名称。');
    if (pending.builtin && title === builtin.title) title += ' · 自定义';
    const id = 'workflow-' + uid();
    const nextProfile = { ...chosenProfile(), title, storageKey: id };
    if (advanced.length) nextProfile.advanced = advanced;
    const runninghubWorkflowId = $('workflowRunningHub').value.trim();
    if (runninghubWorkflowId)
      nextProfile.runninghubWorkflowId = runninghubWorkflowId;
    const { selected, entries } = await addWorkflow({
      id,
      title,
      graph,
      profile: nextProfile,
      mappingVersion,
      video: mapping.video,
      ...currentServerSettings(),
    });
    library = entries;
    renderLibrary();
    if (ticket !== revision) return;
    dialog.close();
    activate(selected.id);
    if (selected.id !== id) notice('这个工作流已在库中，已打开原工作台。');
  } catch (error) {
    if (ticket === revision) importError(error.message);
  } finally {
    saving = false;
    $('workflowFile').disabled = false;
    $('workflowCreate').disabled = !pending?.mapping;
  }
};

function updateRemoveButton() {
  removeButton.disabled = removing || current === builtin.id;
  removeButton.title =
    current === builtin.id ? '内置工作流不可删除' : '删除所选工作流';
}
removeButton.onclick = () => {
  removalTarget = library.find(
    (entry) => entry.id === current && !entry.removed,
  );
  if (!removalTarget || removing) return;
  $('removeWorkflowMessage').textContent =
    '删除「' + removalTarget.title + '」？';
  $('removeWorkflowError').textContent = '';
  removeDialog.showModal();
};
removeDialog.oncancel = (event) => {
  if (removing) event.preventDefault();
};
$('cancelRemoveWorkflow').onclick = () => removeDialog.close();
$('confirmRemoveWorkflow').onclick = async () => {
  const target = removalTarget;
  if (!target || removing) return;
  removing = true;
  $('confirmRemoveWorkflow').disabled = $('cancelRemoveWorkflow').disabled =
    true;
  $('removeWorkflowError').textContent = '';
  try {
    library = await removeWorkflow(target.id);
    removeDialog.close();
    if (current === target.id) activate(builtin.id);
    renderLibrary();
    select.focus();
    notice('已删除工作流「' + target.title + '」。');
  } catch (error) {
    $('removeWorkflowError').textContent = '无法删除工作流。' + error.message;
  } finally {
    removing = false;
    $('confirmRemoveWorkflow').disabled = $('cancelRemoveWorkflow').disabled =
      false;
    updateRemoveButton();
  }
};

select.onchange = () => activate(select.value);
if (window.ResizeObserver) {
  new ResizeObserver(() => {
    document.documentElement.style.setProperty(
      '--workflow-bar-height',
      $('workflowBar').offsetHeight + 'px',
    );
  }).observe($('workflowBar'));
}

readWorkflows()
  .then((entries) => {
    library = entries;
    renderLibrary();
    const last = lastWorkflow();
    if (last && last !== builtin.id) activate(last);
    for (const entry of entries) {
      const key = workflowSessionKey(workflowPageKey(entry.profile.storageKey));
      if (jobSession(key).some((job) => job?.sent && !terminal(job)))
        activateFrame(entry);
    }
  })
  .catch(() => notice('浏览器的工作流库暂不可用。内置工作台可以继续使用。'));

watchWorkspace('workflow-library:'+pageKey, entries => {
  library = entries;
  if (!availableWorkflows().some(entry => entry.id === current)) activate(builtin.id);
  renderLibrary();
});
