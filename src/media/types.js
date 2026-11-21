const materialSpecs = {
  image: {
    label: '图片',
    tag: 'Picture',
    extensions: 'png jpg jpeg webp',
    uploadType: 'image',
  },
  video: {
    label: '视频',
    tag: 'Video',
    extensions: 'mp4 webm mov m4v mkv avi',
    uploadType: 'video',
  },
  audio: {
    label: '音频',
    tag: 'Audio',
    extensions: 'wav mp3 m4a flac ogg aac opus',
    uploadType: 'audio',
  },
};
const materialKinds = Object.keys(materialSpecs);
const extensionKinds = new Map(
  materialKinds.flatMap((kind) =>
    materialSpecs[kind].extensions.split(' ').map((ext) => [ext, kind]),
  ),
);
const materialKind = (name) =>
  extensionKinds.get(String(name).split('.').pop().toLowerCase());
const refKind = (ref) =>
  Object.hasOwn(materialSpecs, ref.kind)
    ? ref.kind
    : materialKind(ref.name) || 'image';
const mediaKeyForRef = (ref) =>
  (refKind(ref) === 'image' ? 'image:' : 'material:') + ref.id;

export { materialSpecs, materialKinds, materialKind, refKind, mediaKeyForRef };
