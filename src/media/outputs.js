import { elem } from '../ui/dom.js';
import { outputURL } from '../comfy/api.js';
import { storage, fileData } from '../storage/browser.js';
import { isJobDeleted } from '../jobs/state.js';
import { readRemovedJobs, persist } from '../storage/jobs.js';
import { videoPrefs, directoryReady, directory } from '../ui/settings.js';

function mediaFiles(outputs) {
  const result = [],
    seen = new Set();
  for (const output of Object.values(outputs || {}))
    for (const [group, items] of Object.entries(output || {})) {
      if (!Array.isArray(items)) continue;
      for (const x of items) {
        if (typeof x?.filename !== 'string') continue;
        const ext = x.filename.split('.').pop().toLowerCase();
        const kind =
          /^(mp4|webm|mov|m4v|mkv|avi)$/.test(ext) ||
          String(x.format).startsWith('video/')
            ? 'video'
            : /^(png|jpe?g|webp|gif|avif|bmp)$/.test(ext) || group === 'images'
              ? 'image'
              : '';
        const key = JSON.stringify([x.filename, x.subfolder, x.type]);
        if (kind && !seen.has(key)) {
          seen.add(key);
          result.push({
            kind,
            filename: x.filename,
            subfolder: x.subfolder || '',
            type: x.type || 'output',
          });
        }
      }
    }
  return result.sort(
    (a, b) => Number(b.kind === 'video') - Number(a.kind === 'video'),
  );
}
const videoOf = (j) => j.results?.find((x) => x.kind === 'video');
const stillOf = (j) => j.results?.find((x) => x.kind === 'image');
function mediaKey(j, x) {
  return 'output:' + j.base + ':' + j.id + ':' + x.filename + ':' + x.subfolder;
}
async function cachedOutput(j, x) {
  return fileData(mediaKey(j, x)).catch(() => null);
}
async function outputBlob(j, x) {
  const cached = await cachedOutput(j, x);
  if (cached instanceof Blob) return cached;
  const res = await fetch(outputURL(j, x));
  if (!res.ok) throw Error('HTTP ' + res.status);
  return res.blob();
}
function setPoster(j, img) {
  const still = stillOf(j);
  if (!still) return;
  const revision = ++j.posterRevision;
  cachedOutput(j, still).then((blob) => {
    if (revision !== j.posterRevision || !img.isConnected) return;
    if (j.posterURL) URL.revokeObjectURL(j.posterURL);
    j.posterURL = blob ? URL.createObjectURL(blob) : null;
    img.src = j.posterURL || outputURL(j, still);
  });
}
async function saveOutputs(j, render) {
  if (!videoPrefs.cache && !videoPrefs.disk) return;
  const video = videoOf(j);
  if (!video) return;
  j.mediaNote = '正在保存视频…';
  render(j);
  try {
    const data = await outputBlob(j, video);
    if (j.removed || isJobDeleted(readRemovedJobs(), j)) return;
    if (videoPrefs.cache) {
      await fileData(mediaKey(j, video), data);
      const still = stillOf(j);
      if (still) {
        try {
          const poster = await outputBlob(j, still);
          if (j.removed || isJobDeleted(readRemovedJobs(), j)) return;
          await fileData(mediaKey(j, still), poster);
        } catch {
          j.mediaNote = '视频已缓存，首帧保存失败';
        }
      }
    }
    if (videoPrefs.disk) {
      await directoryReady;
      if (j.removed || isJobDeleted(readRemovedJobs(), j)) return;
      if (
        !directory ||
        (await directory.queryPermission({ mode: 'readwrite' })) !== 'granted'
      )
        throw Error('请在设置中重新选择并授权保存目录。');
      const original = video.filename.split(/[\\/]/).pop();
      const file = await directory.getFileHandle(
        'Frameform-' + j.id.slice(0, 8) + '-' + original,
        { create: true },
      );
      const writer = await file.createWritable();
      await writer.write(data);
      await writer.close();
    }
    if (j.mediaNote === '正在保存视频…')
      j.mediaNote = videoPrefs.disk ? '已保存到本机目录' : '视频已缓存';
  } catch (e) {
    j.mediaNote = '自动保存失败。' + e.message;
  }
  j.coverState = null;
  render(j);
  persist();
}
async function downloadOutput(j, x) {
  triggerDownload(await outputBlob(j, x), outputFilename(x));
}
const downloadable = (j) => j.state === 'done' && (videoOf(j) || stillOf(j));
async function clearOutputCache(j) {
  if (!j.results?.length) return;
  const db = await storage();
  if (!db) return;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    const store = tx.objectStore('files');
    for (const item of j.results) store.delete(mediaKey(j, item));
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
  });
}
function outputFilename(item) {
  return (
    item.filename
      .split(/[\\/]/)
      .pop()
      .replace(/[<>:"|?*\u0000-\u001f]/g, '_') || 'output'
  );
}
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = elem('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// ZIP stored entries avoid recompressing the generated videos.
async function zipOutputs(files) {
  const limit = 0xffffffff;
  if (files.length > 0xffff) throw Error('任务太多，请分批下载。');
  const encoder = new TextEncoder();
  const table = Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++)
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    return value;
  });
  const body = [],
    central = [];
  let offset = 0,
    directorySize = 0;
  for (const { data, name } of files) {
    const filename = encoder.encode(name);
    if (
      filename.length > 0xffff ||
      offset +
        30 +
        filename.length +
        data.size +
        directorySize +
        46 +
        filename.length +
        22 >
        limit
    )
      throw Error('ZIP 超过 4 GB 或文件名过长，请分批或单独下载。');
    let crc = limit;
    const reader = data.stream().getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const byte of value) crc = (crc >>> 8) ^ table[(crc ^ byte) & 255];
      }
    } finally {
      reader.releaseLock();
    }
    crc = (crc ^ limit) >>> 0;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 filenames
    local.setUint16(12, 33, true); // 1980-01-01
    local.setUint32(14, crc, true);
    local.setUint32(18, data.size, true);
    local.setUint32(22, data.size, true);
    local.setUint16(26, filename.length, true);
    body.push(local.buffer, filename, data);

    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, 20, true);
    new Uint8Array(header.buffer, 6, 26).set(
      new Uint8Array(local.buffer, 4, 26),
    );
    header.setUint32(42, offset, true);
    central.push(header.buffer, filename);
    offset += 30 + filename.length + data.size;
    directorySize += 46 + filename.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);
  return new Blob([...body, ...central, end.buffer], {
    type: 'application/zip',
  });
}

export {
  mediaFiles,
  videoOf,
  stillOf,
  mediaKey,
  cachedOutput,
  outputBlob,
  setPoster,
  saveOutputs,
  downloadOutput,
  downloadable,
  clearOutputCache,
  outputFilename,
  triggerDownload,
  zipOutputs,
};
