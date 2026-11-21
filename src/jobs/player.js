import { $, elem } from '../ui/dom.js';
import { promptFragment } from '../ui/mentions.js';
import { materialSpecs, refKind } from '../media/types.js';
import { outputURL } from '../comfy/api.js';
import { states, terminal, hasJobForm, jobParams } from './state.js';
import { ensureJobForm } from './history.js';
import {
  stillOf,
  cachedOutput,
  downloadOutput,
  downloadable,
} from '../media/outputs.js';

export function setupPlayer(
  { applyComposer, loadAsset, materialPreview, draftStatus },
  render,
) {
  let selectedJob,
    playingJob,
    playerRevision = 0;
  const player = $('player');
  let playerURLs = [];
  function clearPlayer() {
    $('playerStage').replaceChildren();
    for (const url of playerURLs) URL.revokeObjectURL(url);
    playerURLs = [];
  }
  async function selectJob(j, preview = true) {
    selectedJob?.row?.classList.remove('selected');
    selectedJob = j;
    j.row.classList.add('selected');
    const openEarly = preview && terminal(j) && !hasJobForm(j);
    if (openEarly) showResult(j);
    const ready = await ensureJobForm(j, render);
    if (selectedJob !== j || j.removed) return;
    if (ready) {
      if (!(await applyComposer(j.form)) || selectedJob !== j) return;
    } else if (!openEarly) {
      draftStatus.textContent = '这条任务缺少可恢复的提示词和参数。';
    }
    if (preview && terminal(j) && !openEarly) showResult(j);
  }
  async function renderPlayerDetails(j, revision) {
    const prompt = $('playerPrompt');
    prompt.textContent = '正在恢复任务详情…';
    $('reuse').disabled = true;
    $('playerRefs').replaceChildren();
    $('refsLabel').hidden = true;
    const ready = await ensureJobForm(j, render);
    if (revision !== playerRevision || !player.open) return;
    if (!ready) {
      prompt.textContent =
        j.detailsError || '本地记录和 ComfyUI 历史中均没有可恢复的提示词。';
      return;
    }
    $('playerParams').textContent = jobParams(j);
    prompt.replaceChildren(promptFragment(j.form.html));
    $('reuse').disabled = false;
    const refs = j.form.refs;
    $('refsLabel').hidden = !refs.length;
    const loaded = await Promise.all(refs.map(loadAsset));
    if (revision !== playerRevision || !player.open) return;
    const mediaCounts = { image: 0, video: 0, audio: 0 };
    refs.forEach((ref, i) => {
      const asset = loaded[i];
      const figure = elem('div', 'player-ref');
      figure.title = ref.name || '参考图';
      const kind = refKind(ref);
      const label = materialSpecs[kind].label + ' ' + ++mediaCounts[kind];
      figure.classList.add('player-' + kind);
      if (asset) figure.append(materialPreview(asset, kind !== 'image'));
      figure.append(elem('span', '', asset ? label : label + ' 已丢失'));
      $('playerRefs').append(figure);
    });
  }
  async function showResult(j) {
    if (!terminal(j) || j.removed) return;
    const item = downloadable(j);
    const revision = ++playerRevision;
    playingJob = j;
    clearPlayer();
    $('playerTitle').textContent = '任务 ' + String(j.n).padStart(2, '0');
    $('playerParams').textContent = jobParams(j);
    $('playerError').textContent = '';
    $('download').hidden = !item;
    if (item) {
      const loading = elem('div', 'spinner');
      loading.setAttribute('aria-label', '正在读取视频');
      $('playerStage').append(loading);
    } else {
      const status = elem('div', 'player-no-output');
      const icon = elem(
        'span',
        'player-status-icon',
        j.state === 'cancelled' ? '—' : '!',
      );
      icon.setAttribute('aria-hidden', 'true');
      status.append(icon, elem('h3', '', states[j.state]));
      status.append(elem('p', '', j.note || '这条任务没有可播放的结果。'));
      $('playerStage').append(status);
    }
    if (!player.open) player.showModal();
    renderPlayerDetails(j, revision);
    if (!item) return;
    const still = stillOf(j);
    const [blob, poster] = await Promise.all([
      cachedOutput(j, item),
      still && item.kind === 'video' ? cachedOutput(j, still) : null,
    ]);
    if (revision !== playerRevision || !player.open) return;
    const cachedURL = (x, data) => {
      if (!data) return outputURL(j, x);
      const url = URL.createObjectURL(data);
      playerURLs.push(url);
      return url;
    };
    const media = elem(item.kind === 'video' ? 'video' : 'img');
    if (item.kind === 'video') {
      media.controls = true;
      media.playsInline = true;
      media.preload = 'metadata';
      if (still) media.poster = cachedURL(still, poster);
    } else media.alt = item.filename;
    media.onerror = () => {
      $('playerError').textContent =
        '无法加载预览，请确认服务器输出文件可访问。';
    };
    media.src = cachedURL(item, blob);
    $('playerStage').replaceChildren(media);
  }
  let backdropPressed = false;
  function isPlayerBackdrop(event) {
    if (event.target !== player) return false;
    const { left, right, top, bottom } = player.getBoundingClientRect();
    return (
      event.clientX < left ||
      event.clientX >= right ||
      event.clientY < top ||
      event.clientY >= bottom
    );
  }
  player.addEventListener('pointerdown', (event) => {
    backdropPressed = event.button === 0 && isPlayerBackdrop(event);
  });
  player.addEventListener('pointercancel', () => {
    backdropPressed = false;
  });
  player.addEventListener('click', (event) => {
    const shouldClose = backdropPressed && isPlayerBackdrop(event);
    backdropPressed = false;
    if (shouldClose) player.close();
  });
  $('closePlayer').onclick = () => player.close();
  player.onclose = () => {
    if (player.open) return;
    backdropPressed = false;
    playerRevision++;
    playingJob = null;
    clearPlayer();
  };
  $('reuse').onclick = async () => {
    const j = playingJob;
    if (!j?.form) return;
    player.close();
    await selectJob(j, false);
    $('composer').querySelector('h2').setAttribute('tabindex', '-1');
    $('composer').querySelector('h2').focus();
    window.scrollTo({ top: $('composer').offsetTop - 14, behavior: 'smooth' });
  };
  $('download').onclick = async () => {
    const j = playingJob;
    const item = j && downloadable(j);
    if (!item) return;
    const button = $('download');
    button.disabled = true;
    try {
      await downloadOutput(j, item);
    } catch (e) {
      if (playingJob === j)
        $('playerError').textContent = '下载失败。' + e.message;
    } finally {
      button.disabled = false;
    }
  };

  function dropSelectionForServer(base) {
    if (selectedJob && selectedJob.base !== base) {
      selectedJob.row.classList.remove('selected');
      selectedJob = null;
    }
  }
  function releaseJob(job) {
    if (playingJob === job && player.open) player.close();
    if (selectedJob === job) selectedJob = null;
  }

  return { player, selectJob, showResult, dropSelectionForServer, releaseJob };
}
