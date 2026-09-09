/**
 * 个人效率中心 - GitHub Gist 云端同步模块（手动上传/下载版，国内可用）
 *
 * 设计说明：
 * - 修复多设备不同步：两端通过「查找同名 Gist」自动复用同一个云端文件，
 *   不再各自新建（旧版把 Gist ID 存在本机，导致手机电脑各连各的）。
 * - 改为手动「上传 / 下载」+ 覆盖确认弹窗，用户对同步有完全掌控，
 *   不会在不知情的情况下覆盖掉一端的数据。
 *
 * 使用：
 * 1. 生成 GitHub Token（只需一次）：https://github.com/settings/tokens/new?description=efficiency-hub-sync&scopes=gist
 * 2. 在应用里粘贴 Token 连接
 * 3. 想让哪边覆盖哪边，就手动点「上传」或「下载」，每次覆盖前都会弹窗确认
 */
(function () {
  'use strict';

  // ============ 配置 ============
  let GITHUB_TOKEN = localStorage.getItem('github_token') || '';
  let GIST_ID = localStorage.getItem('github_gist_id') || '';
  const GITHUB_API = 'https://api.github.com';
  const GIST_FILENAME = 'efficiency-hub-sync.json';
  const GIST_DESC = '个人效率中心-云端同步';

  // ============ 状态 ============
  let isConnected = false;
  let statusEl = null;
  let syncBtn = null;
  let lastSyncTime = localStorage.getItem('sync_last_sync') || '';

  // 不纳入同步的键（只排除同步相关的技术键，用户设置类全部同步）
  const EXCLUDE_KEYS = new Set([
    'github_token', 'github_gist_id', 'sync_last_sync', 'github_cloud_state',
    'hub_lastModule'   // 上次打开的工具，不强制同步
  ]);

  // ============ 背景图片不同步 ============
  // 背景图是 base64 大图（动辄几百 KB～几 MB），同步又慢又容易撑爆 Gist（1MB 截断）。
  // 两类排除：① 已知背景键名前缀；② 值本身就是 data:image 的键（通用兜底）。
  const EXCLUDE_PREFIXES = [
    'chaomuji_web_v27_bg',        // 朝暮计·页面背景（含 data:image 大图）
    'chaomuji_web_v27_cardbg',    // 朝暮计·卡片背景
    'chaomuji_web_v27_hcardbg',   // 朝暮计·习惯卡背景
    'zmv_bg_'                     // 朝暮计·背景质量等设置
  ];
  const BIG_IMAGE_MIN = 30 * 1024;   // 超过 30KB 的内嵌图片才视为背景资源

  function isExcludedKey(key, value) {
    if (EXCLUDE_KEYS.has(key)) return true;
    for (let i = 0; i < EXCLUDE_PREFIXES.length; i++) {
      if (key.indexOf(EXCLUDE_PREFIXES[i]) === 0) return true;
    }
    if (value && value.length > BIG_IMAGE_MIN && value.slice(0, 11) === 'data:image/') return true;
    return false;
  }

  // ============ 工具：弹窗 ============
  function closeTopModal() {
    const m = document.querySelector('.sync-mask');
    if (m) m.remove();
  }

  // 通用确认弹窗：返回 Promise<boolean>
  function showConfirm(title, message) {
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'sync-mask';
      mask.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:2147483000;display:flex;align-items:center;justify-content:center;';
      const modal = document.createElement('div');
      modal.style.cssText = 'background:white;border-radius:12px;padding:22px;max-width:440px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,.2);';
      modal.innerHTML = `
        <h3 style="margin:0 0 10px;font-size:18px">${title}</h3>
        <p style="margin:0 0 18px;color:#555;font-size:14px;line-height:1.6;white-space:pre-wrap">${message}</p>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button class="sync-cancel" style="padding:9px 18px;border:1px solid #ddd;border-radius:6px;background:white;cursor:pointer;font-size:14px">取消</button>
          <button class="sync-ok" style="padding:9px 18px;border:none;border-radius:6px;background:#08bd74;color:white;cursor:pointer;font-size:14px">确定覆盖</button>
        </div>`;
      mask.appendChild(modal);
      document.body.appendChild(mask);
      mask.addEventListener('click', (e) => { if (e.target === mask) { mask.remove(); resolve(false); } });
      modal.querySelector('.sync-cancel').onclick = () => { mask.remove(); resolve(false); };
      modal.querySelector('.sync-ok').onclick = () => { mask.remove(); resolve(true); };
    });
  }

  function showAlert(message) {
    return showConfirm('提示', message).then(() => {});
  }

  // 三选一弹窗：合并 / 覆盖 / 取消（v4 新增，返回 'merge' | 'overwrite' | 'cancel'）
  function showChoice(title, message, mergeText, overwriteText) {
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'sync-mask';
      mask.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:2147483000;display:flex;align-items:center;justify-content:center;';
      const modal = document.createElement('div');
      modal.style.cssText = 'background:white;border-radius:12px;padding:22px;max-width:460px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,.2);';
      modal.innerHTML = `
        <h3 style="margin:0 0 10px;font-size:18px">${title}</h3>
        <p style="margin:0 0 18px;color:#555;font-size:14px;line-height:1.6;white-space:pre-wrap">${message}</p>
        <div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap">
          <button class="sync-cancel" style="padding:9px 18px;border:1px solid #ddd;border-radius:6px;background:white;cursor:pointer;font-size:14px">取消</button>
          <button class="sync-ok" style="padding:9px 18px;border:1px solid #ddd;border-radius:6px;background:white;cursor:pointer;font-size:14px">${overwriteText || '覆盖'}</button>
          <button class="sync-merge" style="padding:9px 18px;border:none;border-radius:6px;background:#08bd74;color:white;cursor:pointer;font-size:14px;font-weight:600">${mergeText || '合并'}</button>
        </div>`;
      mask.appendChild(modal);
      document.body.appendChild(mask);
      mask.addEventListener('click', (e) => { if (e.target === mask) { mask.remove(); resolve('cancel'); } });
      modal.querySelector('.sync-cancel').onclick = () => { mask.remove(); resolve('cancel'); };
      modal.querySelector('.sync-ok').onclick = () => { mask.remove(); resolve('overwrite'); };
      modal.querySelector('.sync-merge').onclick = () => { mask.remove(); resolve('merge'); };
    });
  }

  // ============ 合并（v4 新增）============
  // 本机每个键的最后写入时间：BackupHub 自 v1.5.0 起在全站记录 __hub_meta_v1__
  function localKeyTs() {
    try { return JSON.parse(localStorage.getItem('__hub_meta_v1__') || '{}') || {}; } catch (e) { return {}; }
  }

  // 合并下载：两边并集；同键两边都有时保留「较新」的一份（时间未知时保留本机）
  function mergeCloudToLocal(serverData) {
    const sdata = (serverData && serverData.data) || {};
    const meta = localKeyTs();
    let timestamps = {};
    try { timestamps = JSON.parse(localStorage.getItem('sync_timestamps') || '{}') || {}; } catch (e) {}
    let added = 0, updated = 0, kept = 0;
    for (const key in sdata) {
      const entry = sdata[key];
      if (!entry || typeof entry.value !== 'string') continue;
      if (isExcludedKey(key, entry.value)) continue;
      const cur = localStorage.getItem(key);
      if (cur === null) {                                    // 本机没有 → 云端补进来
        localStorage.setItem(key, entry.value);
        if (entry.timestamp) timestamps[key] = entry.timestamp;
        added++;
        continue;
      }
      const lts = meta[key] || 0, cts = entry.timestamp || 0;
      if (cts > lts) {                                       // 云端较新 → 覆盖这一键
        localStorage.setItem(key, entry.value);
        if (entry.timestamp) timestamps[key] = entry.timestamp;
        updated++;
      } else kept++;                                         // 本机较新 / 时间未知 → 保留本机
    }
    localStorage.setItem('sync_timestamps', JSON.stringify(timestamps));
    return { added, updated, kept };
  }

  // 合并上传：以云端数据为本底，逐键与本机「较新」者合并，返回合并后的云端数据集
  function buildMergedUpload(serverData) {
    const sdata = (serverData && serverData.data) || {};
    const meta = localKeyTs();
    const merged = {};
    for (const key in sdata) {
      const entry = sdata[key];
      if (!entry || typeof entry.value !== 'string') continue;
      if (isExcludedKey(key, entry.value)) continue;
      merged[key] = { value: entry.value, timestamp: entry.timestamp || 0 };
    }
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const value = localStorage.getItem(key);
      if (value === null || isExcludedKey(key, value)) continue;
      const lts = meta[key] || Date.now();                   // 无写入记录的键视为刚写过（本机为准）
      const cts = (merged[key] && merged[key].timestamp) || 0;
      if (!merged[key] || lts >= cts) merged[key] = { value: value, timestamp: lts };
    }
    return merged;
  }

  // 成功 / 失败提醒：优先用备份中心的提醒卡（更醒目、带数据量和下一步指引），
  // 没有备份中心时退回站点 toast / alert。
  function notifyOK(title, detail) {
    if (window.BackupHub && typeof window.BackupHub.notify === 'function') {
      try { window.BackupHub.notify({ icon: '☁️', title: title, detail: detail }); return; } catch (e) {}
    }
    if (typeof toast === 'function') toast('✅ ' + title);
  }
  function notifyFail(title, detail) {
    if (window.BackupHub && typeof window.BackupHub.notify === 'function') {
      try { window.BackupHub.notify({ type: 'warn', icon: '⚠️', title: title, detail: detail, ms: 6500 }); return; } catch (e) {}
    }
    alert(title + '\n' + detail);
  }

  // ============ 侧边栏入口 ============
  function createSyncUI() {
    const sideFoot = document.querySelector('.side-foot');
    if (!sideFoot) { setTimeout(createSyncUI, 500); return; }
    if (document.getElementById('syncStatusBtn')) return;

    const row = document.createElement('div');
    row.className = 'side-btn';
    row.id = 'syncStatusBtn';
    row.style.cssText = 'cursor:pointer;';
    row.innerHTML = `
      <span id="syncIcon" style="font-size:16px">🔄</span>
      <span style="flex:1">
        <div style="font-size:13px" id="syncLabel">云端同步</div>
        <div style="font-size:11px;color:#7c8aa5" id="syncStatus">配置中...</div>
      </span>`;
    sideFoot.insertBefore(row, sideFoot.firstChild);

    statusEl = document.getElementById('syncStatus');
    syncBtn = document.getElementById('syncStatusBtn');
    if (syncBtn) {
      syncBtn.addEventListener('click', openSyncPanel);
    } else {
      row.addEventListener('click', openSyncPanel);
    }
  }

  function updateStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(Number(ts));
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  // ============ 同步主面板 ============
  // 备份状态与操作已合并进来：侧边栏只保留「云端同步」一个入口
  function backupStateHTML() {
    if (window.BackupHub && typeof window.BackupHub.activityHTML === 'function') {
      try { return window.BackupHub.activityHTML(); } catch (e) {}
    }
    return '<div style="font-size:13px;color:#888">备份模块未加载</div>';
  }

  function openSyncPanel() {
    closeTopModal();
    const mask = document.createElement('div');
    mask.className = 'sync-mask';
    mask.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:2147483000;display:flex;align-items:center;justify-content:center;';
    const modal = document.createElement('div');
    modal.style.cssText = 'background:white;border-radius:12px;padding:24px;max-width:460px;width:92%;box-shadow:0 8px 32px rgba(0,0,0,.2);';
    const connState = isConnected ? '✅ 已连接' : '⚙️ 未配置';
    const lastTxt = lastSyncTime ? ('上次操作：' + fmtTime(lastSyncTime)) : '还没有同步过';
    modal.innerHTML = `
      <h2 style="margin:0 0 6px;font-size:20px">🔄 云端同步</h2>
      <p style="margin:0 0 14px;color:#666;font-size:13px">${connState} ｜ ${lastTxt}</p>

      <div style="background:#f6f8fa;border-radius:8px;padding:12px;font-size:13px;color:#444;line-height:1.7;margin-bottom:16px">
        <b>怎么用：</b><br>
        • <b>上传</b>：把这部设备的数据存到云端（覆盖云端）<br>
        • <b>下载</b>：把云端的数据拉到这部设备（覆盖本机）<br>
        想让手机和电脑一致，就先在「源头」那端点<b>上传</b>，再到另一端点<b>下载</b>。
      </div>

      <div style="display:flex;gap:10px;margin-bottom:14px">
        <button id="syncUpload" style="flex:1;padding:12px;border:none;border-radius:8px;background:#08bd74;color:white;font-size:15px;cursor:pointer">⬆️ 上传到云端</button>
        <button id="syncDownload" style="flex:1;padding:12px;border:none;border-radius:8px;background:#3b82f6;color:white;font-size:15px;cursor:pointer">⬇️ 从云端下载</button>
      </div>

      <div id="syncBackupBox" style="border-top:1px solid #eee;padding-top:12px;margin-bottom:14px">
        <div style="font-size:14px;font-weight:600;margin-bottom:8px">💾 数据备份</div>
        <div id="syncBackupState" style="background:#f6f8fa;border-radius:8px;padding:10px 12px;margin-bottom:10px">${backupStateHTML()}</div>
        <div style="display:flex;gap:8px">
          <button id="syncBkExport" style="flex:1;padding:9px;border:1px solid #ddd;border-radius:6px;background:white;cursor:pointer;font-size:13px">导出备份到本机</button>
          <button id="syncBkCenter" style="flex:1;padding:9px;border:1px solid #ddd;border-radius:6px;background:white;cursor:pointer;font-size:13px">备份中心</button>
        </div>
      </div>

      <div style="display:flex;justify-content:space-between;align-items:center">
        <button id="syncReconfig" style="background:none;border:none;color:#888;font-size:13px;cursor:pointer;text-decoration:underline">重新配置 Token</button>
        <button id="syncClose" style="padding:8px 16px;border:1px solid #ddd;border-radius:6px;background:white;cursor:pointer;font-size:14px">关闭</button>
      </div>`;
    mask.appendChild(modal);
    document.body.appendChild(mask);
    mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });

    modal.querySelector('#syncClose').onclick = () => mask.remove();
    modal.querySelector('#syncReconfig').onclick = () => { mask.remove(); showConfigModal(); };
    modal.querySelector('#syncUpload').onclick = () => { mask.remove(); doUpload(); };
    modal.querySelector('#syncDownload').onclick = () => { mask.remove(); doDownload(); };
    // 备份动作：导出走 BackupHub（导出后会询问是否顺带上传云端），备份中心是完整功能面板
    modal.querySelector('#syncBkExport').onclick = () => {
      mask.remove();
      if (window.BackupHub && window.BackupHub.exportThenAskCloud) {
        try { window.BackupHub.exportThenAskCloud(); return; } catch (e) {}
      }
      if (window.BackupHub) { try { window.BackupHub.exportNow(null); } catch (e) {} }
    };
    modal.querySelector('#syncBkCenter').onclick = () => {
      mask.remove();
      if (window.BackupHub && window.BackupHub.open) { try { window.BackupHub.open(); } catch (e) {} }
    };
  }

  // ============ 配置弹窗 ============
  function showConfigModal() {
    closeTopModal();
    const mask = document.createElement('div');
    mask.className = 'sync-mask';
    mask.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:2147483000;display:flex;align-items:center;justify-content:center;';
    const modal = document.createElement('div');
    modal.style.cssText = 'background:white;border-radius:12px;padding:24px;max-width:460px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,.2);';
    modal.innerHTML = `
      <h2 style="margin:0 0 8px;font-size:20px">🔄 配置云端同步</h2>
      <p style="margin:0 0 16px;color:#666;font-size:14px">用 GitHub Gist 存储数据，国内可访问，免费</p>
      <div style="margin-bottom:14px">
        <div style="font-size:13px;color:#333;margin-bottom:6px">第 1 步：获取 Token</div>
        <a href="https://github.com/settings/tokens/new?description=efficiency-hub-sync&scopes=gist" target="_blank"
           style="display:inline-block;padding:8px 14px;background:#24292e;color:white;border-radius:6px;text-decoration:none;font-size:14px">点击生成 GitHub Token</a>
        <div style="font-size:12px;color:#888;margin-top:6px">勾选「gist」权限，点最底部「Generate token」</div>
      </div>
      <div style="margin-bottom:16px">
        <div style="font-size:13px;color:#333;margin-bottom:6px">第 2 步：粘贴 Token</div>
        <input type="text" id="ghToken" placeholder="ghp_xxxxxxxxxxxx" value="${GITHUB_TOKEN}"
               style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:14px">
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="ghCancel" style="padding:8px 16px;border:1px solid #ddd;border-radius:6px;background:white;cursor:pointer">取消</button>
        <button id="ghSaveBtn" style="padding:8px 16px;border:none;border-radius:6px;background:#08bd74;color:white;cursor:pointer">保存并连接</button>
      </div>`;
    mask.appendChild(modal);
    document.body.appendChild(mask);
    mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });

    modal.querySelector('#ghCancel').onclick = () => mask.remove();
    modal.querySelector('#ghSaveBtn').onclick = async () => {
      const token = modal.querySelector('#ghToken').value.trim();
      if (!token) { alert('请先粘贴 Token'); return; }
      localStorage.setItem('github_token', token);
      GITHUB_TOKEN = token;
      const btn = modal.querySelector('#ghSaveBtn');
      btn.textContent = '连接中...'; btn.disabled = true;
      try {
        mask.remove();
        await initSync();
      } catch (e) {
        alert('连接失败：' + e.message);
        btn.textContent = '保存并连接'; btn.disabled = false;
      }
    };
  }

  // ============ GitHub API ============
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

  // Gist 对超过 1MB 的文件会返回 truncated:true 且 content 被截断，
  // 此时必须改拉 raw_url 才能拿到完整内容（否则会误判成"云端没数据"）。
  async function readGist() {
    if (!cachedGistId()) await findOrCreateGist();
    try {
      const data = await apiCall('GET', '/gists/' + GIST_ID);
      const file = data.files && data.files[GIST_FILENAME];
      if (!file) return null;
      let content = file.content || '';
      if (file.truncated && file.raw_url) {
        const raw = await fetch(file.raw_url, { cache: 'no-store' });
        if (raw.ok) content = await raw.text();
      }
      if (!content) return null;
      const parsed = JSON.parse(content);
      // 记下云端是否有数据：上传前可免一次全量读取
      setCachedCloudHasData(!!(parsed && parsed.data && Object.keys(parsed.data).length > 0));
      return parsed;
    } catch (e) {
      if (isNotFound(e)) clearGistCache();   // 缓存的 Gist 已被删，下次重新搜索
      console.warn('[GitHub] 读取失败:', e.message);
      return null;
    }
  }

  async function writeGist(content) {
    const body = JSON.stringify(content);   // 紧凑 JSON：体积比格式化小 ~25%，上传更快
    if (!GIST_ID) {
      const data = await apiCall('POST', '/gists', {
        description: GIST_DESC, public: false,
        files: { [GIST_FILENAME]: { content: body } }
      });
      GIST_ID = data.id;
      localStorage.setItem('github_gist_id', GIST_ID);
    } else {
      await apiCall('PATCH', '/gists/' + GIST_ID, {
        files: { [GIST_FILENAME]: { content: body } }
      });
    }
  }

  // ============ 速度优化：Gist 直连缓存 ============
  // 旧流程每次同步都要「列出全部 Gists → 读 Gist → 写 Gist」三个串行请求，
  // 其中列出全部 Gists（含每份的内容预览）最慢。
  // GIST_ID 本来就存在 localStorage，直接复用：只有没缓存或请求 404 时才搜索一次。
  function cachedGistId() {
    if (GIST_ID) return GIST_ID;
    try { GIST_ID = localStorage.getItem('github_gist_id') || ''; } catch (e) {}
    return GIST_ID || '';
  }

  function clearGistCache() {
    GIST_ID = '';
    try { localStorage.removeItem('github_gist_id'); } catch (e) {}
  }

  function isNotFound(e) {
    return /404|Not Found/i.test(e && e.message ? e.message : String(e));
  }

  // 云端是否有数据的本地缓存（10 分钟有效）：上传前免一次全量读取
  function getCachedCloudHasData() {
    try {
      const raw = JSON.parse(localStorage.getItem('github_cloud_state') || 'null');
      if (raw && typeof raw.has === 'boolean' && Date.now() - raw.ts < 10 * 60 * 1000) return raw.has;
    } catch (e) {}
    return null;   // 不知道 → 需要联网确认
  }

  function setCachedCloudHasData(has) {
    try { localStorage.setItem('github_cloud_state', JSON.stringify({ has: !!has, ts: Date.now() })); } catch (e) {}
  }

  // 判断 gist 里是否真有数据。
  // 列表接口的 content 可能被截断（truncated），所以同时用 size 兜底：
  // 空骨架 {"version":1,"data":{},"updatedAt":...} 只有 60~80 字节。
  function gistHasData(file) {
    if (!file) return false;
    const size = typeof file.size === 'number' ? file.size : 0;
    const content = file.content || '';
    if (file.truncated) return size > 200;   // 截断时只能靠体积判断
    if (!content) return false;
    try {
      const j = JSON.parse(content);
      return !!(j && j.data && Object.keys(j.data).length > 0);
    } catch (e) {
      return size > 200;
    }
  }

  // 只查找，不创建（无副作用，供状态展示用）
  async function findGist() {
    const list = await apiCall('GET', '/gists?per_page=100');
    let best = null;         // 最近更新的
    let bestWithData = null; // 有数据的里最近更新的
    for (const g of list) {
      if (!g.files || !g.files[GIST_FILENAME]) continue;
      const hasData = gistHasData(g.files[GIST_FILENAME]);
      if (!best || new Date(g.updated_at) > new Date(best.updated_at)) best = g;
      if (hasData && (!bestWithData || new Date(g.updated_at) > new Date(bestWithData.updated_at))) bestWithData = g;
    }
    return bestWithData || best;
  }

  // 关键修复：每次都重新搜索账号下我们用的那个 Gist（同名文件），
  // 优先选「有数据」的那份，让手机和电脑一定连到同一份数据。
  // v3 提速：有缓存 ID 时直接直连，不再每次都拉全列表；缓存失效由 404 兜底恢复。
  async function findOrCreateGist() {
    if (cachedGistId()) return GIST_ID;
    try {
      const chosen = await findGist();
      if (chosen) {
        GIST_ID = chosen.id;
        localStorage.setItem('github_gist_id', GIST_ID);
        return GIST_ID;
      }
    } catch (e) {
      console.warn('[GitHub] 查找 Gist 失败：', e.message);
      if (GIST_ID) return GIST_ID; // 网络异常处理：用已记录的
    }
    // 没找到，新建
    const data = await apiCall('POST', '/gists', {
      description: GIST_DESC, public: false,
      files: { [GIST_FILENAME]: { content: JSON.stringify({ version: 1, data: {}, updatedAt: Date.now() }, null, 2) } }
    });
    GIST_ID = data.id;
    localStorage.setItem('github_gist_id', GIST_ID);
    return GIST_ID;
  }

  // 供备份中心展示云端状态：只读探测，不创建、不修改云端
  // 提速：有缓存 Gist ID 时直连读取，跳过「拉全列表」
  async function peekCloud() {
    if (!GITHUB_TOKEN) return { connected: false, reason: '未配置 Token' };
    try {
      if (cachedGistId()) {
        const remote = await readGist();
        const data = (remote && remote.data) || {};
        return {
          connected: true,
          cloudCount: Object.keys(data).length,
          updatedAt: (remote && remote.updatedAt) || 0,
          gistId: GIST_ID
        };
      }
      const g = await findGist();
      if (!g) return { connected: true, cloudCount: 0, updatedAt: 0, gistId: '' };
      GIST_ID = g.id;
      localStorage.setItem('github_gist_id', GIST_ID);
      const remote = await readGist();
      const data = (remote && remote.data) || {};
      return {
        connected: true,
        cloudCount: Object.keys(data).length,
        updatedAt: (remote && remote.updatedAt) || 0,
        gistId: g.id
      };
    } catch (e) {
      return { connected: false, reason: e.message || '读取失败' };
    }
  }

  // ============ 数据收集 / 应用 ============
  function collectLocalData() {
    const data = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const value = localStorage.getItem(key);
      if (value === null) continue;
      if (isExcludedKey(key, value)) continue;   // 背景图 / 内部键不同步
      data[key] = { value, timestamp: Date.now() };
    }
    return data;
  }

  function getLocalKeys() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!isExcludedKey(key, localStorage.getItem(key))) keys.push(key);
    }
    return keys;
  }

  // 用云端数据整体覆盖本机（真正的"下载覆盖"）
  function applyCloudToLocal(serverData) {
    const sdata = serverData.data || {};
    // 先清掉本机所有可同步键
    for (const key of getLocalKeys()) localStorage.removeItem(key);
    // 再写入云端数据
    const timestamps = {};
    for (const key in sdata) {
      const entry = sdata[key];
      if (isExcludedKey(key, entry && entry.value)) continue;
      if (!entry || typeof entry.value !== 'string') continue;
      localStorage.setItem(key, entry.value);
      if (entry.timestamp) timestamps[key] = entry.timestamp;
    }
    localStorage.setItem('sync_timestamps', JSON.stringify(timestamps));
  }

  function reloadActiveIframe() {
    // v2：下载覆盖后必须刷新【全部】工具 iframe —— 所有 iframe 在 buildIframes 时
    // 已带 src 常驻，只刷当前激活的话，其余 iframe 内存里仍是旧数据，
    // 用户切回去一旦编辑保存，旧数据会覆盖刚下载的新数据
    document.querySelectorAll('#toolContainer iframe').forEach(function (f) {
      if (f.src) f.src = f.src;
    });
  }

  // ============ 动作：上传 / 下载 ============
  async function doUpload() {
    if (!isConnected) { showConfigModal(); return; }
    try {
      // 提速：Gist ID 有缓存就直连；云端是否有数据优先用本地缓存，
      // 都没有才联网读一次（旧版是「拉全列表 + 读全文」两个慢请求）
      if (!cachedGistId()) await findOrCreateGist();
      let cloudHas = getCachedCloudHasData();
      if (cloudHas === null) {
        const remote = await readGist();
        cloudHas = !!(remote && remote.data && Object.keys(remote.data).length > 0);
      }
      let mode = 'overwrite';
      if (cloudHas) {
        const choice = await showChoice('上传到云端',
          '云端已经存有数据。\n「合并」保留两边较新的数据，不会丢任何一边；\n「覆盖云端」用【本机数据】整体替换云端。',
          '合并到云端', '覆盖云端');
        if (choice === 'cancel') { updateStatus('已取消上传'); return; }
        mode = choice;
      }
      let localData;
      if (mode === 'merge') {
        // 合并：以云端为本底，逐键取较新（需要读到云端内容；缓存里没有就联网读一次）
        let remote = await readGist();
        if (!remote || !remote.data) remote = { data: {} };
        localData = buildMergedUpload(remote);
      } else {
        localData = collectLocalData();
      }
      try {
        await writeGist({ version: 1, data: localData, updatedAt: Date.now() });
      } catch (e) {
        if (!isNotFound(e)) throw e;
        clearGistCache();                 // 缓存的 Gist 已被删：重建后重试一次
        await findOrCreateGist();
        await writeGist({ version: 1, data: localData, updatedAt: Date.now() });
      }
      setCachedCloudHasData(true);
      lastSyncTime = String(Date.now());
      localStorage.setItem('sync_last_sync', lastSyncTime);
      // 记到侧边栏：最近同步时间 + 这次同步了哪些项目
      if (window.BackupHub && window.BackupHub.markSync) {
        try { window.BackupHub.markSync('up', Object.keys(localData)); } catch (e) {}
      }
      updateStatus('已上传 ' + fmtTime(lastSyncTime));
      closeTopModal();
      notifyOK(mode === 'merge' ? '已合并上传到云端' : '已上传到云端',
        mode === 'merge'
          ? `两边数据已按「较新保留」合并，共 ${Object.keys(localData).length} 项存到云端，没有丢失任何一边的内容。`
          : `本机的 ${Object.keys(localData).length} 项数据已存到云端。\n` +
            '在手机 / 其他电脑点「云端 → 本机」就能同步过去。');
    } catch (e) {
      console.warn('[GitHub] 上传失败:', e.message);
      notifyFail('上传云端失败',
        (e && e.message ? e.message : String(e)) + '\n请检查网络或 Token 是否有效（可点「重新配置 Token」）。');
      updateStatus('上传失败');
    }
  }

  async function doDownload() {
    if (!isConnected) { showConfigModal(); return; }
    try {
      // 提速：Gist ID 有缓存就直连读，不再先拉一遍全列表
      if (!cachedGistId()) await findOrCreateGist();
      const remote = await readGist();
      const cloudHas = remote && remote.data && Object.keys(remote.data).length > 0;
      if (!cloudHas) {
        await showAlert('云端还没有数据。\n请先在一部设备上点「上传到云端」，再来这里下载。');
        return;
      }
      const localHas = getLocalKeys().length > 0;
      let mode = 'overwrite';
      if (localHas) {
        const choice = await showChoice('下载到本机',
          '本机已经存有数据。\n「合并」保留两边较新的数据，不会丢任何一边；\n「覆盖本机」用【云端数据】整体替换本机。',
          '合并到本机', '覆盖本机');
        if (choice === 'cancel') { updateStatus('已取消下载'); return; }
        mode = choice;
      }
      let mergeStats = null;
      if (mode === 'merge') {
        mergeStats = mergeCloudToLocal(remote);
      } else {
        applyCloudToLocal(remote);
      }
      reloadActiveIframe();
      if (typeof buildCards === 'function') buildCards();
      lastSyncTime = String(Date.now());
      localStorage.setItem('sync_last_sync', lastSyncTime);
      // 记到侧边栏：最近同步时间 + 这次同步了哪些项目
      if (window.BackupHub && window.BackupHub.markSync) {
        try { window.BackupHub.markSync('down', Object.keys(remote.data)); } catch (e) {}
      }
      updateStatus('已下载 ' + fmtTime(lastSyncTime));
      closeTopModal();
      notifyOK(mode === 'merge' ? '已合并云端数据到本机' : '已从云端同步到本机',
        mode === 'merge'
          ? `合并完成：新增 ${mergeStats.added} 项，更新 ${mergeStats.updated} 项（云端较新），保留本机 ${mergeStats.kept} 项。\n` +
            '当前打开的工具页已自动刷新，看到的是合并后的最新数据。'
          : `云端的 ${Object.keys(remote.data).length} 项数据已写入本机。\n` +
            '当前打开的工具页已自动刷新，看到的是最新数据。');
    } catch (e) {
      console.warn('[GitHub] 下载失败:', e.message);
      notifyFail('从云端下载失败',
        (e && e.message ? e.message : String(e)) + '\n请检查网络或 Token 是否有效。本机数据未改动。');
      updateStatus('下载失败');
    }
  }

  // ============ 初始化 ============
  async function initSync() {
    if (!GITHUB_TOKEN) { showConfigModal(); return; }
    // 提速：有缓存的 Gist ID 就立即显示「已连接」，启动不再发网络请求。
    // 首次真正同步时才会联网；若 Gist 已被删，404 兜底会自动重建，不影响使用。
    if (cachedGistId()) {
      isConnected = true;
      updateStatus('已连接');
      return;
    }
    try {
      await findOrCreateGist();   // 关键：两端复用同一 Gist
      isConnected = true;
      updateStatus('已连接');
    } catch (e) {
      console.error('[GitHub] 初始化失败:', e);
      isConnected = false;
      updateStatus('连接失败');
      showConfigModal();
    }
  }

  async function init() {
    createSyncUI();
    if (!GITHUB_TOKEN) { updateStatus('未配置'); return; }
    await initSync();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.CloudSync = {
    upload: doUpload,
    download: doDownload,
    openPanel: openSyncPanel,
    reconnect: initSync,                                // 配置 / 换 Token 后重新连接
    isConnected: () => isConnected,
    peek: peekCloud,                                   // 只读探测云端数据量
    getStatus: () => ({ connected: isConnected, lastSync: lastSyncTime })
  };
})();
