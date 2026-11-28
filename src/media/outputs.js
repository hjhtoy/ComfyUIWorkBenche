import { hosted } from '../storage/workspace.js';
import { elem } from '../ui/dom.js';
import { outputURL } from '../comfy/api.js';
import { storage, fileData, pageKey } from '../storage/browser.js';
import { isJobDeleted } from '../jobs/state.js';
import { readRemovedJobs, persist } from '../storage/jobs.js';
import { refreshDirectory } from '../ui/settings.js';

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
function resultURL(j, item) {
  if (!hosted) return outputURL(j,item);
  return '/workspace/result?' + new URLSearchParams({client:j.client,index:j.results.indexOf(item)});
}
async function cachedOutput(j, x) {
  return fileData(mediaKey(j, x)).catch(() => null);
}
async function outputBlob(j, x) {
  const cached = await cachedOutput(j, x);
  if (cached instanceof Blob) return cached;
  const res = await fetch(resultURL(j, x));
  if (!res.ok) throw Error('HTTP ' + res.status);
  return res.blob();
}
function setPoster(j, img) {
  const still = stillOf(j);
  if (!still) return;
  if (hosted) { img.src = resultURL(j,still); return; }
  const revision = ++j.posterRevision;
  cachedOutput(j, still).then((blob) => {
    if (revision !== j.posterRevision || !img.isConnected) return;
    if (j.posterURL) URL.revokeObjectURL(j.posterURL);
    j.posterURL = blob ? URL.createObjectURL(blob) : null;
    img.src = j.posterURL || outputURL(j, still);
  });
}
const savedOutputsKey = 'frameform.saved-outputs.v1';
function savedOutputClients() {
  try {
    return new Set(JSON.parse(localStorage.getItem(savedOutputsKey) || '[]'));
  } catch {
    return new Set();
  }
}
function markOutputSaved(client) {
  const list = [...savedOutputClients()].filter((id) => id !== client);
  list.push(client);
  try {
    localStorage.setItem(savedOutputsKey, JSON.stringify(list.slice(-500)));
  } catch {}
}

const exportKey = (job) => 'output-files:' + pageKey + ':' + job.client;
const withOutputLock = (action) => navigator.locks
  ? navigator.locks.request('frameform-output-files', action)
  : action();

function saveOutputs(j, render) {
  j.savingOutputs ??= saveLocalOutputs(j, render).finally(() => {
    delete j.savingOutputs;
  });
  return j.savingOutputs;
}

async function saveLocalOutputs(j, render) {
  const video = videoOf(j);
  const still = stillOf(j);
  // Video workflows save the video plus its poster; image-only jobs save the image.
  if (hosted || (!video && !still)) return;
  // Several workbench tabs can watch the same queue; save each job once.
  if (savedOutputClients().has(j.client)) return;
  const primary = video || still;
  j.mediaNote = video ? '正在保存视频和首帧…' : '正在保存图片…';
  render(j);
  try {
    const data = await outputBlob(j, primary);
    if (j.removed || isJobDeleted(readRemovedJobs(), j)) return;
    let poster;
    if (video && still) {
      try {
        poster = await outputBlob(j, still);
      } catch {
        /* A missing poster must not block saving the video. */
      }
    }
    if (j.removed || isJobDeleted(readRemovedJobs(), j)) return;
    const base = taskFileBase(j.title);
    const filename = (item) => base + outputExtension(item.filename);
    const posterName =
      poster && filename(still) === filename(primary)
        ? base + '-首帧' + outputExtension(still.filename)
        : poster && filename(still);
    const handle = await refreshDirectory();
    let granted = false;
    if (handle) {
      try {
        granted =
          (await handle.queryPermission({ mode: 'readwrite' })) === 'granted';
        if (!granted)
          // After a reload the handle usually needs a fresh grant.
          granted =
            (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
      } catch {
        granted = false;
      }
    }
    await withOutputLock(async () => {
      if (savedOutputClients().has(j.client) || isJobDeleted(readRemovedJobs(), j))
        return;
      if (granted && handle) {
        const exports = await fileData(exportKey(j)) || [];
        const files = [[filename(primary), data], ...(poster ? [[posterName, poster]] : [])];
        for (const [name, blob] of files) {
          const file = await writeFile(handle, name, blob, j.client);
          exports.push({ directory: handle, name: file.name, size: file.size, modified: file.lastModified });
          await fileData(exportKey(j), exports);
        }
        j.mediaNote = '已保存到本机目录';
      } else {
        triggerDownload(data, filename(primary));
        if (poster) triggerDownload(poster, posterName);
        j.mediaNote = '已自动下载到浏览器下载目录';
      }
      markOutputSaved(j.client);
    });
    try {
      await fileData(mediaKey(j, primary), data);
      if (poster) await fileData(mediaKey(j, still), poster);
    } catch {
      /* The saved copies remain usable when browser storage is unavailable. */
    }
  } catch (e) {
    j.mediaNote = '自动保存失败。' + e.message;
  }
  j.coverState = null;
  render(j);
  persist();
}
async function existingFile(directory, name) {
  try {
    return await (await directory.getFileHandle(name)).getFile();
  } catch (error) {
    if (error.name === 'NotFoundError' || error.name === 'TypeMismatchError') return null;
    throw error;
  }
}

async function writeFile(directory, filename, blob, client) {
  const ext = outputExtension(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;
  const tag = client.replace(/[^a-z0-9]/gi, '').slice(0, 8);
  let name = filename;
  for (let n = 1; await existingFile(directory, name); n++)
    name = stem + '-' + tag + (n > 1 ? '-' + n : '') + ext;
  const file = await directory.getFileHandle(name, { create: true });
  const writer = await file.createWritable();
  await writer.write(blob);
  await writer.close();
  return file.getFile();
}

async function deleteOutputFiles(job) {
  if (!job.results?.length) return;
  await job.savingOutputs;
  await withOutputLock(async () => {
    const exports = await fileData(exportKey(job));
    if (!exports) {
      const directory = await refreshDirectory();
      if (!directory || (await directory.queryPermission({ mode: 'readwrite' })) !== 'granted') return;
      const video = videoOf(job);
      const still = stillOf(job);
      const base = taskFileBase(job.title);
      for (const item of [video, still].filter(Boolean)) {
        const cached = await cachedOutput(job, item);
        if (!(cached instanceof Blob)) continue;
        const extension = outputExtension(item.filename);
        const tag = item === still && video && outputExtension(video.filename) === extension ? '-首帧' : '';
        const name = base + tag + extension;
        const file = await existingFile(directory, name);
        if (file && await sameContents(file, cached)) await directory.removeEntry(name);
      }
      return;
    }
    for (const saved of exports) {
      const directory = saved.directory;
      const mode = { mode: 'readwrite' };
      if ((await directory.queryPermission(mode)) !== 'granted' &&
          (await directory.requestPermission(mode)) !== 'granted')
        throw Error('删除文件需要授权「' + directory.name + '」。');
      const file = await existingFile(directory, saved.name);
      if (!file || file.size !== saved.size || file.lastModified !== saved.modified)
        continue;
      try {
        await directory.removeEntry(saved.name);
      } catch (error) {
        if (error.name !== 'NotFoundError') throw error;
      }
    }
    await fileData(exportKey(job), []);
  });
}
async function sameContents(first, second) {
  if (first.size !== second.size) return false;
  const chunk = 1024 ** 2;
  for (let offset = 0; offset < first.size; offset += chunk) {
    const bytes = await Promise.all([first, second].map(async (blob) =>
      new Uint8Array(await blob.slice(offset, offset + chunk).arrayBuffer()),
    ));
    if (bytes[0].some((byte, index) => byte !== bytes[1][index])) return false;
  }
  return true;
}
async function downloadOutput(j, x) {
  triggerDownload(
    await outputBlob(j, x),
    taskFileBase(j.title) + outputExtension(x.filename),
  );
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
function taskFileBase(value) {
  const name = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    // A title may end with a material name such as "参考.png";
    // strip that extension so the result does not read "参考.png.webm".
    .replace(
      /\.(?:png|jpe?g|webp|gif|avif|bmp|mp4|webm|mov|m4v|mkv|avi|wav|mp3|ogg|flac)$/i,
      '',
    );
  return (name || '任务').slice(0, 80);
}
function outputExtension(filename) {
  const match = String(filename || '').match(/\.[a-z0-9]{1,8}$/i);
  return match ? match[0] : '';
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
  resultURL,
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
  deleteOutputFiles,
  outputFilename,
  triggerDownload,
  zipOutputs,
};
