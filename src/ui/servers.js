import { hosted, watchWorkspace } from '../storage/workspace.js';
import { $, elem, button, uid } from './dom.js';
import { normalizeServer, probe } from '../comfy/api.js';
import { readLocal, writeLocal } from '../storage/browser.js';

function serverAddress() {
  return normalizeServer($('server').value);
}
function currentQueueBase() {
  try {
    return serverAddress();
  } catch {
    return null;
  }
}
const serverKey = 'frameform.servers.v1';

function connection(text, cls = '') {
  $('connectionHelp').hidden = cls !== 'bad';
  $('connection').className = 'connect-state ' + cls;
  $('connection').lastElementChild.textContent = text;
}
function remember(base) {
  if (hosted) return writeLocal('frameform.server',base);
  try {
    localStorage.setItem('frameform.server', base);
  } catch {}
}

export function setupServers({
  updateQueueTools,
  refreshCurrentQueue,
  saveDraft,
}) {
  let testRevision = 0;
  let serverProfiles = readLocal(serverKey, []),
    editingServer = null;
  try {
    const value =
      document.documentElement.dataset.initialServer ||
      (hosted ? readLocal('frameform.server',null) : localStorage.getItem('frameform.server'));
    if (value) $('server').value = value;
  } catch {}
  function syncServerSelection(preferred = $('serverList').value) {
    const url = currentQueueBase();
    const matching = serverProfiles.filter((profile) => profile.url === url);
    $('serverList').value =
      (matching.find((profile) => profile.id === preferred) || matching[0])
        ?.id || '';
  }
  function serverChanged(save = true, profileId) {
    testRevision++;
    connection('未测试连接');
    $('serverError').textContent = '';
    $('queueSync').textContent = '';
    $('test').disabled = false;
    syncServerSelection(profileId);
    updateQueueTools();
    if (save) saveDraft();
  }
  $('server').oninput = () => serverChanged();
  $('server').onchange = () => refreshCurrentQueue(true);
  $('server').onkeydown = (event) => {
    if (event.key === 'Enter') refreshCurrentQueue(true);
  };
  function renderServers() {
    const list = $('serverList');
    const selected = list.value;
    const options = serverProfiles.map((profile) => {
      const duplicateName = serverProfiles.some(
        (other) => other.id !== profile.id && other.name === profile.name,
      );
      return new Option(
        duplicateName ? profile.name + ' · ' + profile.url : profile.name,
        profile.id,
      );
    });
    list.replaceChildren(new Option('已保存地址', ''), ...options);
    syncServerSelection(selected);
    $('savedServers').replaceChildren(
      ...serverProfiles.map((p) => {
        const row = elem('div', 'saved-server'),
          label = elem('div'),
          actions = elem('div', 'inline');
        label.append(elem('strong', '', p.name), elem('p', 'note', p.url));
        const edit = button('编辑', () => {
          editingServer = p.id;
          $('serverName').value = p.name;
          $('serverURL').value = p.url;
          $('saveServer').textContent = '保存修改';
          $('cancelServerEdit').hidden = false;
          $('addressError').textContent = '';
          $('serverName').focus();
        });
        const remove = button('移除', async () => {
          if (
            !await saveProfiles(
              readLocal(serverKey, serverProfiles).filter(
                (item) => item.id !== p.id,
              ),
            )
          )
            return;
          if (editingServer === p.id) resetServerForm();
        });
        remove.classList.add('danger');
        actions.append(
          button('使用', () => useServer(p)),
          edit,
          remove,
        );
        row.append(label, actions);
        return row;
      }),
    );
  }
  async function saveProfiles(next) {
    if (!await writeLocal(serverKey, next)) {
      $('addressError').textContent = '浏览器无法保存服务器地址。';
      return false;
    }
    serverProfiles = next;
    $('addressError').textContent = '';
    renderServers();
    return true;
  }
  function resetServerForm() {
    editingServer = null;
    $('serverForm').reset();
    $('saveServer').textContent = '新增地址';
    $('cancelServerEdit').hidden = true;
  }
  $('cancelServerEdit').onclick = () => {
    resetServerForm();
    $('addressError').textContent = '';
    $('serverName').focus();
  };
  function useServer(p) {
    $('server').value = p.url;
    serverChanged(true, p.id);
    refreshCurrentQueue(true);
    if ($('serversDialog').open) $('serversDialog').close();
  }
  $('serverList').onchange = () => {
    const p = serverProfiles.find((p) => p.id === $('serverList').value);
    if (p) useServer(p);
  };
  $('manageServers').onclick = () => {
    resetServerForm();
    $('addressError').textContent = '';
    serverProfiles = readLocal(serverKey, serverProfiles);
    const url = $('server').value.trim();
    if (!serverProfiles.some((profile) => profile.url === url))
      $('serverURL').value = url;
    renderServers();
    $('serversDialog').showModal();
  };
  $('closeServers').onclick = () => $('serversDialog').close();
  $('serverForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const name = $('serverName').value.trim(),
        url = normalizeServer($('serverURL').value);
      if (!name) throw Error('请输入服务器名。');
      const profiles = readLocal(serverKey, serverProfiles);
      if (
        editingServer &&
        !profiles.some((profile) => profile.id === editingServer)
      ) {
        throw Error('这条地址已在其他页面移除。请取消编辑后重新新增。');
      }
      const profile = { id: editingServer || uid(), name, url };
      const next = editingServer
        ? profiles.map((item) => (item.id === editingServer ? profile : item))
        : [...profiles, profile];
      if (await saveProfiles(next)) {
        resetServerForm();
        useServer(profile);
      }
    } catch (e) {
      $('addressError').textContent = e.message;
    }
  };
  watchWorkspace(serverKey, profiles => { serverProfiles = profiles; renderServers(); });
  window.addEventListener('storage', (event) => {
    if (event.key !== serverKey) return;
    serverProfiles = readLocal(serverKey, []);
    renderServers();
  });
  renderServers();
  syncServerSelection(document.documentElement.dataset.initialServerProfile);
  $('test').onclick = async () => {
    const revision = ++testRevision;
    $('serverError').textContent = '';
    $('test').disabled = true;
    connection('测试中…');
    try {
      const base = serverAddress();
      await probe(base);
      if (revision === testRevision) {
        connection('已连接', 'ok');
        remember(base);
        await refreshCurrentQueue(true);
      }
    } catch (e) {
      if (revision === testRevision) {
        connection('连接失败', 'bad');
        $('serverError').textContent = e.message;
      }
    } finally {
      if (revision === testRevision) $('test').disabled = false;
    }
  };

  return { serverChanged };
}

export { serverAddress, currentQueueBase, serverKey, connection, remember };
