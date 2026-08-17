/**
 * 个人效率中心 - GitHub Gist 云端同步模块（国内可用）
 * 
 * 为什么用 GitHub？
 * - Supabase 服务器在美国，国内连不上
 * - LeanCloud 国内服务已停止
 * - GitHub 国内可访问，且你已有账号，无需注册新服务
 * 
 * 原理：
 * - 在你的 GitHub 账号下创建一个私有 Gist 存储数据
 * - 手机电脑都访问这个 Gist，数据自动同步
 * 
 * 使用方式：
 * 1. 在 GitHub 生成一个 Personal Access Token（只需一次，1分钟）
 * 2. 在应用里粘贴这个 Token
 * 3. 数据自动同步，电脑关机也不影响
 */

(function() {
  'use strict';

  // ============ 配置 ============
  let GITHUB_TOKEN = localStorage.getItem('github_token') || '';
  let GIST_ID = localStorage.getItem('github_gist_id') || '';
  const GITHUB_API = 'https://api.github.com';
  const GIST_FILENAME = 'efficiency-hub-sync.json';

  // ============ 状态 ============
  let isConnected = false;
  let isPushing = false;
  let isPulling = false;
  let lastSnapshot = null;
  let pollTimer = null;
  let syncEnabled = localStorage.getItem('sync_enabled') !== 'false';
  const SYNC_VERSION_KEY = 'sync_version_github';
  const SYNC_INTERVAL = 30000;   // 定期拉取：30秒
  const POLL_INTERVAL = 5000;    // 本地变化检测：5秒

  // 需要排除的键
  const EXCLUDE_KEYS = new Set([
    'github_token',
    'github_gist_id',
    'sync_device_id',
    'sync_enabled',
    'sync_last_pull',
    'sync_timestamps',
    'hub_lastModule',
    'hub_theme',
    'hub_sidebar'
  ]);

  // ============ UI ============
  let statusEl = null;
  let syncBtn = null;

  function createSyncUI() {
    const sideFoot = document.querySelector('.side-foot');
    if (!sideFoot) {
      setTimeout(createSyncUI, 500);
      return;
    }
    if (document.getElementById('syncStatusBtn')) return;

    const syncRow = document.createElement('div');
    syncRow.className = 'side-btn';
    syncRow.id = 'syncStatusBtn';
    syncRow.style.cssText = 'cursor:pointer;';
    syncRow.innerHTML = `
      <span id="syncIcon" style="font-size:16px">🔄</span>
      <span style="flex:1">
        <div style="font-size:13px" id="syncLabel">云端同步</div>
        <div style="font-size:11px;color:#7c8aa5" id="syncStatus">配置中...</div>
      </span>
    `;
    sideFoot.insertBefore(syncRow, sideFoot.firstChild);

    statusEl = document.getElementById('syncStatus');
    syncBtn = document.getElementById('syncStatusBtn');
    syncBtn.addEventListener('click', () => {
      if (isConnected) {
        manualSync();
      } else {
        showConfigModal();
      }
    });
  }

  function updateStatus(text, icon) {
    if (statusEl) statusEl.textContent = text;
    const iconEl = document.getElementById('syncIcon');
    if (iconEl && icon) iconEl.textContent = icon;
  }

  // ============ 配置弹窗 ============
  function showConfigModal() {
    const mask = document.createElement('div');
    mask.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;';
    const modal = document.createElement('div');
    modal.style.cssText = 'background:white;border-radius:12px;padding:24px;max-width:460px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.2);';
    modal.innerHTML = `
      <h2 style="margin:0 0 8px;font-size:20px">🔄 配置云端同步</h2>
      <p style="margin:0 0 16px;color:#666;font-size:14px">用 GitHub Gist 存储数据，国内可访问，免费</p>
      
      <div style="margin-bottom:14px">
        <div style="font-size:13px;color:#333;margin-bottom:6px">第 1 步：获取 Token</div>
        <a href="https://github.com/settings/tokens/new?description=efficiency-hub-sync&scopes=gist" target="_blank"
           style="display:inline-block;padding:8px 14px;background:#24292e;color:white;border-radius:6px;text-decoration:none;font-size:14px">
          点击生成 GitHub Token
        </a>
        <div style="font-size:12px;color:#888;margin-top:6px">勾选「gist」权限，点击最底部「Generate token」</div>
      </div>

      <div style="margin-bottom:16px">
        <div style="font-size:13px;color:#333;margin-bottom:6px">第 2 步：粘贴 Token</div>
        <input type="text" id="ghToken" placeholder="ghp_xxxxxxxxxxxx" 
               style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:14px">
      </div>

      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button onclick="this.closest('div[style*=\\'position:fixed\\']').remove()" 
                style="padding:8px 16px;border:1px solid #ddd;border-radius:6px;background:white;cursor:pointer">取消</button>
        <button id="ghSaveBtn" 
                style="padding:8px 16px;border:none;border-radius:6px;background:#08bd74;color:white;cursor:pointer">保存并连接</button>
      </div>
    `;
    mask.appendChild(modal);
    document.body.appendChild(mask);
    mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });

    const saveBtn = modal.querySelector('#ghSaveBtn');
    saveBtn.onclick = async () => {
      const token = modal.querySelector('#ghToken').value.trim();
      if (!token) { alert('请先粘贴 Token'); return; }
      localStorage.setItem('github_token', token);
      GITHUB_TOKEN = token;
      saveBtn.textContent = '连接中...';
      saveBtn.disabled = true;
      try {
        mask.remove();
        await initSync();
      } catch (e) {
        alert('连接失败：' + e.message);
        saveBtn.textContent = '保存并连接';
        saveBtn.disabled = false;
      }
    };
  }

  // ============ 同步逻辑 ============

  function getAuthHeaders() {
    return {
      'Authorization': 'Bearer ' + GITHUB_TOKEN,
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github.v3+json'
    };
  }

  async function apiCall(method, path, body) {
    const opts = { method, headers: getAuthHeaders() };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(GITHUB_API + path, opts);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.message || ('HTTP ' + resp.status));
    }
    return resp.json();
  }

  // 读取 Gist 内容
  async function readGist() {
    if (!GIST_ID) return null;
    try {
      const data = await apiCall('GET', '/gists/' + GIST_ID);
      const file = data.files && data.files[GIST_FILENAME];
      if (!file || !file.content) return null;
      return JSON.parse(file.content);
    } catch (e) {
      console.warn('[GitHub] 读取失败:', e.message);
      return null;
    }
  }

  // 写入 Gist 内容
  async function writeGist(content) {
    if (!GIST_ID) {
      // 首次创建
      const data = await apiCall('POST', '/gists', {
        description: '个人效率中心 - 云端同步数据',
        public: false,
        files: { [GIST_FILENAME]: { content: JSON.stringify(content, null, 2) } }
      });
      GIST_ID = data.id;
      localStorage.setItem('github_gist_id', GIST_ID);
    } else {
      await apiCall('PATCH', '/gists/' + GIST_ID, {
        files: { [GIST_FILENAME]: { content: JSON.stringify(content, null, 2) } }
      });
    }
  }

  // 收集本地数据（带时间戳）
  function collectLocalData() {
    const data = {};
    const timestamps = JSON.parse(localStorage.getItem('sync_timestamps') || '{}');
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (EXCLUDE_KEYS.has(key)) continue;
      const value = localStorage.getItem(key);
      if (value === null) continue;
      let ts = timestamps[key] || 0;
      if (ts === 0) ts = Date.now();
      data[key] = { value, timestamp: ts };
    }
    localStorage.setItem('sync_timestamps', JSON.stringify(timestamps));
    return data;
  }

  // 合并云端数据到本地（云端新则覆盖）
  function mergeServerData(serverData) {
    if (!serverData || !serverData.data) return 0;
    let changed = 0;
    const timestamps = JSON.parse(localStorage.getItem('sync_timestamps') || '{}');
    const sdata = serverData.data;
    for (const key in sdata) {
      if (EXCLUDE_KEYS.has(key)) continue;
      const entry = sdata[key];
      if (!entry || typeof entry.timestamp !== 'number') continue;
      const localTs = timestamps[key] || 0;
      if (entry.timestamp > localTs) {
        const old = localStorage.getItem(key);
        if (old !== entry.value) {
          localStorage.setItem(key, entry.value);
          changed++;
        }
        timestamps[key] = entry.timestamp;
      }
    }
    localStorage.setItem('sync_timestamps', JSON.stringify(timestamps));
    return changed;
  }

  // 推送本地到云端（合并后写回）
  async function pushToCloud() {
    if (!isConnected || isPushing) return;
    isPushing = true;
    try {
      const localData = collectLocalData();
      // 读取云端，合并（本地优先，本地的覆盖云端）
      const remote = await readGist();
      const remoteData = (remote && remote.data) ? remote.data : {};
      // 本地数据覆盖云端同键（LWW）
      const merged = Object.assign({}, remoteData, localData);
      await writeGist({ version: 1, data: merged, updatedAt: Date.now() });
      updateStatus('已上传 ' + new Date().toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit'}), '✅');
    } catch (e) {
      console.warn('[GitHub] 上传失败:', e.message);
      updateStatus('上传失败', '⚠️');
    } finally {
      isPushing = false;
    }
  }

  // 从云端拉取
  async function pullFromCloud() {
    if (!isConnected || isPulling) return;
    isPulling = true;
    try {
      const remote = await readGist();
      if (remote && remote.data) {
        const changed = mergeServerData(remote);
        if (changed > 0) {
          console.log('[GitHub] 同步了 ' + changed + ' 项');
          reloadActiveIframe();
          if (typeof buildCards === 'function') buildCards();
        }
      }
      updateStatus('已同步 ' + new Date().toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit'}), '✅');
    } catch (e) {
      console.warn('[GitHub] 拉取失败:', e.message);
      updateStatus('同步失败', '⚠️');
    } finally {
      isPulling = false;
    }
  }

  async function manualSync() {
    if (!isConnected) { showConfigModal(); return; }
    updateStatus('同步中...', '🔄');
    await pullFromCloud();
    await pushToCloud();
  }

  function getSnapshot() {
    const snap = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (EXCLUDE_KEYS.has(key)) continue;
      snap[key] = localStorage.getItem(key);
    }
    return snap;
  }

  function snapshotChanged(oldSnap, newSnap) {
    if (!oldSnap) return true;
    for (const key in newSnap) {
      if (oldSnap[key] !== newSnap[key]) return true;
    }
    for (const key in oldSnap) {
      if (!(key in newSnap)) return true;
    }
    return false;
  }

  function reloadActiveIframe() {
    const activeContainer = document.querySelector('#toolContainer .tool-container.active');
    if (activeContainer) {
      const iframe = activeContainer.querySelector('iframe');
      if (iframe && iframe.src) iframe.src = iframe.src;
    }
  }

  function startPolling() {
    stopPolling();
    lastSnapshot = getSnapshot();
    pollTimer = setInterval(async () => {
      if (!isConnected) return;
      const current = getSnapshot();
      if (snapshotChanged(lastSnapshot, current)) {
        console.log('[GitHub] 检测到本地变化');
        lastSnapshot = current;
        pushToCloud();
      }
    }, POLL_INTERVAL);
    setInterval(async () => {
      if (!isConnected) return;
      pullFromCloud();
    }, SYNC_INTERVAL);
    console.log('[GitHub] 定期同步已启动');
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  async function initSync() {
    if (!GITHUB_TOKEN) {
      showConfigModal();
      return;
    }
    // 检测 Token 有效性并初始化 Gist
    try {
      if (!GIST_ID) {
        // 尝试列出 gist 验证 token，并自动创建同步 gist
        await writeGist({ version: 1, data: {}, updatedAt: Date.now() });
      } else {
        const test = await readGist();
        if (!test) {
          // Gist 不存在，重建
          GIST_ID = '';
          localStorage.removeItem('github_gist_id');
          await writeGist({ version: 1, data: {}, updatedAt: Date.now() });
        }
      }
      isConnected = true;
      updateStatus('已连接', '✅');
      startPolling();
      // 首次拉取
      await pullFromCloud();
    } catch (e) {
      console.error('[GitHub] 初始化失败:', e);
      isConnected = false;
      updateStatus('连接失败', '❌');
      showConfigModal();
    }
  }

  // ============ 初始化 ============
  async function init() {
    const currentVersion = localStorage.getItem(SYNC_VERSION_KEY);
    if (currentVersion !== '4') {
      syncEnabled = true;
      localStorage.setItem('sync_enabled', 'true');
      localStorage.setItem(SYNC_VERSION_KEY, '4');
    }

    createSyncUI();

    if (!GITHUB_TOKEN || !syncEnabled) {
      updateStatus('未配置', '⚙️');
      return;
    }

    await initSync();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.CloudSync = {
    sync: manualSync,
    isConnected: () => isConnected
  };

})();
