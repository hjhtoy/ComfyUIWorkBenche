import { profile, slots, template } from './config.js';
import { materialKind, materialKinds, materialSpecs } from '../media/types.js';

const h3ReferenceNode = profile.h3ReferenceNode;
const materialTags = {
  image: profile.referenceTag ?? (h3ReferenceNode ? 'Picture' : ''),
  video: h3ReferenceNode ? 'Video' : '',
  audio: h3ReferenceNode ? 'Audio' : '',
  ...profile.referenceTags,
};
const slotsFor = (kind) =>
  slots.filter((slot) => (slot.kind || 'image') === kind);
const usesDynamicH3 = (kind) =>
  !!h3ReferenceNode && kind !== 'image' && !slotsFor(kind).length;
const materialLimit = (kind) =>
  usesDynamicH3(kind) ? 3 : slotsFor(kind).length;
const referenceTag = (kind, number) => {
  const tag = materialTags[kind];
  return tag ? '<' + tag + ' ' + number + '>' : '';
};
function groupPaths(j, paths) {
  const grouped = { image: [], video: [], audio: [] };
  paths.forEach((path, i) => {
    const kind = j.fileKinds?.[i] || materialKind(path) || 'image';
    grouped[kind].push(path);
  });
  return grouped;
}
function h3Port(kind, index) {
  return kind === 'video'
    ? 'ref_videos.ref_video_' + index
    : 'ref_audios.ref_audio_' + index;
}
function bindDynamicH3(graph, grouped) {
  if (!h3ReferenceNode) return;
  const inputs = graph[h3ReferenceNode].inputs;
  for (const kind of ['video', 'audio']) {
    if (!usesDynamicH3(kind)) continue;
    for (const [index, path] of grouped[kind].entries()) {
      let id = 167;
      while (Object.hasOwn(graph, String(id))) id++;
      id = String(id);
      graph[id] =
        kind === 'video'
          ? {
              class_type: 'VHS_LoadVideo',
              inputs: {
                video: path,
                force_rate: 24,
                custom_width: 0,
                custom_height: 0,
                frame_load_cap: 360,
                skip_first_frames: 0,
                select_every_nth: 1,
              },
            }
          : { class_type: 'LoadAudio', inputs: { audio: path } };
      inputs[h3Port(kind, index)] = [id, 0];
    }
  }
}
function serverMaterialRefs(base, graph, mapped) {
  const result = [];
  const add = (kind, index, path) => {
    const ref = serverReference(base, path, result.length + 1, kind);
    if (ref) result.push({ ref, tag: referenceTag(kind, index + 1) });
  };
  const input = (id, key) => graph[mapped.get(id)]?.inputs?.[key];
  for (const kind of materialKinds) {
    for (const [index, slot] of slotsFor(kind).entries()) {
      const [target, key] = slot.targets[0];
      const link = input(target, key);
      if (!Array.isArray(link)) continue;
      const loader = graph[link[0]];
      if (loader?.class_type === template[slot.file[0]]?.class_type)
        add(kind, index, loader.inputs?.[slot.file[1]]);
    }
    if (!usesDynamicH3(kind)) continue;
    // A separately wired video soundtrack uses an Audio index in H3.
    const conditioning = graph[mapped.get(h3ReferenceNode)]?.inputs || {};
    const soundtrackCount =
      kind === 'audio'
        ? Object.keys(conditioning).filter((key) =>
            /^ref_video_audios\.ref_video_audio_\d+$/.test(key),
          ).length
        : 0;
    for (let index = 0; index < 3; index++) {
      const link = conditioning[h3Port(kind, index)];
      if (!Array.isArray(link)) continue;
      let loader = graph[link[0]];
      if (kind === 'video' && loader?.class_type === 'GetVideoComponents')
        loader = graph[loader.inputs?.video?.[0]];
      add(
        kind,
        index + soundtrackCount,
        loader?.inputs?.[materialSpecs[kind].uploadType],
      );
    }
  }
  return result;
}
function serverReference(base, path, key, kind) {
  if (typeof path !== 'string' || !path) return null;
  const type = path.match(/\s+\[(input|output|temp)\]$/);
  const parts = (type ? path.slice(0, type.index) : path)
    .replaceAll('\\', '/')
    .split('/');
  const filename = parts.pop();
  if (!filename) return null;
  const source = {
    base,
    filename,
    subfolder: parts.join('/'),
    type: type?.[1] || 'input',
  };
  return {
    key,
    kind,
    id: 'server:' + JSON.stringify(kind === 'image' ? source : [kind, source]),
    name: filename,
    source,
  };
}

export {
  slotsFor,
  materialLimit,
  referenceTag,
  groupPaths,
  bindDynamicH3,
  serverMaterialRefs,
};
