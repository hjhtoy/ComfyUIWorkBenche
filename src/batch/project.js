import {
  profile,
  template,
  durationInFrames,
  durationFieldValue,
  durationSeconds,
} from '../comfy/config.js';
import { referenceTag, materialLimit, slotsFor } from '../comfy/references.js';
import { materialKinds, materialKind, materialSpecs } from '../media/types.js';

const filenameCollator = new Intl.Collator('zh-Hans', { numeric: true });
const nameKey = (value) => String(value).normalize('NFC');
const materialBoundary = /[\s，。；：、！？（）【】《》「」『』“”‘’,;:!?()[\]{}"'<>]/u;
// A filename is often joined to its tag by prose ("...png，见 <Picture 1>",
// "...png as <Picture 1>"). Peeling these connectors off keeps the binding.
const materialConnector =
  /(?:[ \t\u00a0\u3000]+|[，,、。．；;：:！!？?…·—\-（）()【】\[\]「」『』“”"'`]|\b(?:as|from|with|using|in|into|for|to|is|at|by|of)\b|见|参看|参考|参照|如图|如下图|如下|所示|对应|即|图)$/iu;
const trailingSpace = /[ \t\u00a0\u3000]+$/;
const materialTagKinds = Object.fromEntries(
  materialKinds.map((kind) => [materialSpecs[kind].tag.toLowerCase(), kind]),
);
function projectDuration(fileName, text, errors) {
  const suffix = fileName.match(/_(\d+(?:\.\d+)?)s\.txt$/i);
  const fromName = suffix ? Number(suffix[1]) : undefined;
  const fromText = [
    ...Array.from(
      text.matchAll(/镜头保持到本片[ \t]*(\d+(?:\.\d+)?)[ \t]*秒处结束/g),
      (match) => Number(match[1]),
    ),
    ...Array.from(
      text.matchAll(
        /^[ \t]*(?:视频时长|总时长|目标时长|时长|duration)[ \t]*[:：][ \t]*(\d+(?:\.\d+)?)[ \t]*(?:秒|s(?:ec(?:onds?)?)?)[ \t]*$/gim,
      ),
      (match) => Number(match[1]),
    ),
  ];
  const unique = [...new Set(fromText)];
  if (unique.length > 1) errors.push('正文出现不同的目标时长');
  const duration = unique[0] ?? fromName;
  if (duration === undefined) {
    // Image workflows have no duration control; a single storyboard may omit it.
    if (!profile.duration) return undefined;
    errors.push('找不到视频时长');
    return undefined;
  }
  if (!profile.duration) return undefined;
  const { field: [node, key], min, max, increment: step = 1 } = profile.duration;
  // A whole-second UI slider can still target a floating-point seconds input.
  const fractionalSeconds = !durationInFrames && step === 1 &&
    template[node]?.class_type === 'PrimitiveFloat' && key === 'value';
  const value = durationFieldValue(duration);
  const units = (value - min) / step;
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    value < min ||
    value > max ||
    (!fractionalSeconds && Math.abs(units - Math.round(units)) > 1e-6)
  ) {
    const unit = durationInFrames ? '帧' : '秒';
    const interval = fractionalSeconds ? '' : `，间隔 ${step} ${unit}`;
    errors.push(`时长不在当前工作流支持范围内（${min}–${max} ${unit}${interval}）`);
  }
  return durationSeconds(value);
}
function matchProjectMaterial(value, catalog) {
  for (const name of catalog.names) {
    if (!value.endsWith(name)) continue;
    const offset = value.length - name.length;
    if (offset === 0 || materialBoundary.test(value[offset - 1]))
      return { name, offset };
  }
  return null;
}
function resolveProjectMaterial(before, catalog) {
  if (!/[ \t\u00a0\u3000]$/.test(before)) return null;
  let value = before.replace(trailingSpace, '');
  // Strip the shortest connector first so trailing prose stays in the prompt.
  for (let pass = 0; pass < 8; pass++) {
    const found = matchProjectMaterial(value, catalog);
    if (found) return found;
    const shorter = value.replace(materialConnector, '').replace(trailingSpace, '');
    if (shorter === value) break;
    value = shorter;
  }
  // Report just the filename when a reference following prose is genuinely missing.
  const token = value.split(materialBoundary).pop();
  if (/^.+\.[A-Za-z0-9]{1,5}$/.test(token))
    return { name: token, offset: value.length - token.length };
  return null;
}
function parseScene(name, source, catalog) {
  const errors = [];
  const text = nameKey(source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'));
  if (!text.trim()) errors.push('提示词为空');
  const duration = projectDuration(name, text, errors);
  const bindings = { image: new Map(), video: new Map(), audio: new Map() };
  const edits = [];
  for (const match of text.matchAll(/<(Picture|Video|Audio)\b[^<>\n]*>/gi)) {
    const parsed = match[0].match(/^<([A-Za-z]+)[ \t]+([1-9]\d*)>$/);
    if (!parsed) {
      errors.push('素材标签格式无效 ' + match[0]);
      continue;
    }
    const kind = materialTagKinds[parsed[1].toLowerCase()];
    const index = Number(parsed[2]);
    const token = referenceTag(kind, index);
    if (!token || !materialLimit(kind)) {
      errors.push('当前工作流没有可用的' + materialSpecs[kind].label + '槽位');
      continue;
    }
    if (!Number.isSafeInteger(index) || index > materialLimit(kind)) {
      errors.push(
        materialSpecs[kind].label +
          '编号 ' +
          parsed[2] +
          ' 超过 ' +
          materialLimit(kind) +
          ' 个槽位的上限',
      );
    }
    const lineStart = text.lastIndexOf('\n', match.index - 1) + 1;
    const before = text.slice(lineStart, match.index);
    const resolved = resolveProjectMaterial(before, catalog);
    const key = kind + ':' + parsed[2];
    const edit = {
      start: match.index,
      end: match.index + match[0].length,
      key,
      token,
      kind,
      index,
    };
    if (resolved) {
      edit.start = lineStart + resolved.offset;
      const candidates = catalog.files.get(resolved.name);
      if (!candidates) {
        errors.push('assets 中找不到 ' + resolved.name);
        continue;
      }
      if (candidates.length !== 1) {
        errors.push('存在同名素材 ' + resolved.name);
        continue;
      }
      if (materialKind(resolved.name) !== kind) {
        errors.push(resolved.name + ' 与 ' + match[0] + ' 的素材类型不一致');
        continue;
      }
      const previous = bindings[kind].get(index);
      if (previous && previous.file !== candidates[0]) {
        errors.push(
          match[0] + ' 同时指向 ' + previous.name + ' 和 ' + resolved.name,
        );
        continue;
      }
      bindings[kind].set(index, {
        key,
        kind,
        index,
        token,
        name: resolved.name,
        file: candidates[0],
      });
    }
    edits.push(edit);
  }
  for (const edit of edits) {
    if (!bindings[edit.kind].has(edit.index))
      errors.push('找不到 ' + edit.token + ' 对应的素材文件名');
  }
  const assets = [];
  for (const kind of materialKinds) {
    const slots = [...bindings[kind].values()].sort(
      (a, b) => a.index - b.index,
    );
    if (slots.some((slot, index) => slot.index !== index + 1))
      errors.push(materialSpecs[kind].label + '编号需要从 1 开始连续排列');
    if (new Set(slots.map((slot) => slot.file)).size !== slots.length)
      errors.push(materialSpecs[kind].label + '中同一文件用了不同编号');
    const required = slotsFor(kind).findLastIndex((slot) => slot.required) + 1;
    if (slots.length < required)
      errors.push(
        '至少需要 ' + required + ' 个' + materialSpecs[kind].label + '素材',
      );
    assets.push(...slots);
  }
  const fragments = [];
  let offset = 0;
  for (const edit of edits) {
    fragments.push(text.slice(offset, edit.start), edit);
    offset = edit.end;
  }
  fragments.push(text.slice(offset));
  const prompt = fragments
    .map((part) => (typeof part === 'string' ? part : part.token))
    .join('')
    .trim();
  return {
    name,
    title: name.replace(/\.txt$/i, ''),
    duration,
    assets,
    fragments,
    prompt,
    errors: [...new Set(errors)],
  };
}
async function readBatchProject(files, settings) {
  const catalog = { files: new Map(), names: [] };
  // Accept any nesting: "<root>/prompts/x.txt" or "parent/<root>/prompts/x.txt".
  const projects = new Map();
  for (const file of files) {
    const parts = file.webkitRelativePath.split('/');
    if (parts.length < 3) continue;
    const index = parts.lastIndexOf('prompts', parts.length - 2);
    if (index < 1 || parts.length !== index + 2) continue;
    if (!/\.txt$/i.test(file.name) || file.name.startsWith('.')) continue;
    const rootPath = parts.slice(0, index).join('/');
    if (!projects.has(rootPath)) projects.set(rootPath, []);
    projects.get(rootPath).push(file);
  }
  const rootPaths = [...projects.keys()];
  if (rootPaths.length > 1)
    throw Error(
      '所选目录中有多个项目（' +
        rootPaths.map((path) => path.split('/').pop()).join('、') +
        '），请选择其中一个项目根目录。',
    );
  if (!rootPaths.length) {
    const insidePrompts = files.some(
      (file) => file.webkitRelativePath.split('/')[0] === 'prompts',
    );
    throw Error(
      insidePrompts
        ? '所选目录是 prompts 本身，请选择它的上一级项目根目录（同级要有 assets）。'
        : '未找到 prompts 下的 TXT。请选择包含 prompts 和 assets 的项目根目录。',
    );
  }
  const rootPath = rootPaths[0];
  const root = rootPath.split('/').pop();
  const rootParts = rootPath.split('/');
  const prompts = projects.get(rootPath);
  for (const file of files) {
    const parts = file.webkitRelativePath.split('/');
    if (parts.length < rootParts.length + 2) continue;
    if (!rootParts.every((part, index) => parts[index] === part)) continue;
    if (
      parts[rootParts.length] !== 'assets' ||
      file.name.startsWith('.') ||
      !materialKind(file.name)
    )
      continue;
    const key = nameKey(file.name);
    if (!catalog.files.has(key)) catalog.files.set(key, []);
    catalog.files.get(key).push(file);
  }
  catalog.names = [...catalog.files.keys()].sort((a, b) => b.length - a.length);
  prompts.sort((a, b) => filenameCollator.compare(a.name, b.name));
  const scenes = await Promise.all(
    prompts.map(async (file) => {
      try {
        return parseScene(file.name, await file.text(), catalog);
      } catch {
        return {
          name: file.name,
          title: file.name,
          assets: [],
          errors: ['无法读取这份 TXT 文件'],
        };
      }
    }),
  );
  return { root, settings, scenes };
}

export { readBatchProject };

// One storyboard TXT dropped into the prompt editor: the same parsing rules as a
// batch import, but the materials come from the library instead of the folder.
export function parseStoryboard(name, source, materials) {
  const files = new Map();
  for (const { name: materialName, item } of materials) {
    const key = nameKey(materialName);
    if (!files.has(key)) files.set(key, []);
    files.get(key).push(item);
  }
  const catalog = {
    files,
    names: [...files.keys()].sort((a, b) => b.length - a.length),
  };
  return parseScene(name, source, catalog);
}
