import { profile } from '../comfy/config.js';
import { referenceTag, materialLimit, slotsFor } from '../comfy/references.js';
import { materialKinds, materialKind, materialSpecs } from '../media/types.js';

const filenameCollator = new Intl.Collator('zh-Hans', { numeric: true });
const nameKey = (value) => String(value).normalize('NFC');
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
    errors.push('找不到视频时长');
    return undefined;
  }
  if (fromName !== undefined && unique.length && fromName !== unique[0])
    errors.push('正文 ' + duration + ' 秒与文件名 ' + fromName + ' 秒不一致');
  const { min, max, increment: step = 1 } = profile.duration;
  const units = (duration - min) / step;
  if (
    !Number.isFinite(duration) ||
    duration < min ||
    duration > max ||
    Math.abs(units - Math.round(units)) > 1e-6
  )
    errors.push(
      '时长不在当前工作流支持范围内（' +
        min +
        '–' +
        max +
        ' 秒，间隔 ' +
        step +
        ' 秒）',
    );
  return duration;
}
function resolveProjectMaterial(before, catalog) {
  if (!/[ \t\u00a0\u3000]$/.test(before)) return null;
  const value = before.replace(/[ \t\u00a0\u3000]+$/, '');
  for (const name of catalog.names) {
    if (!value.endsWith(name)) continue;
    const offset = value.length - name.length;
    if (offset === 0 || /\s/.test(value[offset - 1])) return { name, offset };
  }
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
    } else {
      const missing = before.match(
        /(?:^|[ \t\u00a0\u3000])([^\s<>]+\.[A-Za-z0-9]{1,5})[ \t\u00a0\u3000]+$/,
      );
      if (missing) {
        errors.push('assets 中找不到 ' + missing[1]);
        continue;
      }
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
  const catalog = { files: new Map(), names: [] },
    prompts = [];
  let root = '';
  for (const file of files) {
    const parts = file.webkitRelativePath.split('/');
    if (parts.length < 3) continue;
    if (!root) root = parts[0];
    if (parts[0] !== root) continue;
    if (
      parts[1] === 'prompts' &&
      parts.length === 3 &&
      /\.txt$/i.test(file.name) &&
      !file.name.startsWith('.')
    )
      prompts.push(file);
    if (
      parts[1] !== 'assets' ||
      file.name.startsWith('.') ||
      !materialKind(file.name)
    )
      continue;
    const key = nameKey(file.name);
    if (!catalog.files.has(key)) catalog.files.set(key, []);
    catalog.files.get(key).push(file);
  }
  if (!prompts.length)
    throw Error(
      '未找到 prompts 下的 TXT。请选择包含 prompts 和 assets 的项目根目录。',
    );
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
