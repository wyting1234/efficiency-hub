/**
 * 个人效率中心 - GitHub Gist 云端同步模块（手动上传/下载版，国内可用）
 *
 * 设计说明：
 * - 手动「上传 / 下载」+ 覆盖确认弹窗：让哪边覆盖哪边，用户说了算，
 *   每次覆盖前都会弹窗并显示数据摘要，不会在不知情的情况下覆盖掉一端的数据。
 * - 修复多设备不同步：
 *   1) 列表接口不返回 Gist 文件内容，旧版「有数据优先」判断必然失效；
 *      新版对候选 Gist 逐个拉取完整内容，真正选「有数据且最新」的那份，
 *      手机和电脑一定连到同一份云端数据（即使旧版留下了多个同名 Gist）。
 *   2) 分页遍历账号下所有 Gist，账号 Gist 超过 100 个也不会漏掉。
 *   3) 显示当前连接账号（GitHub 用户名），两端必须使用【同一个账号】的 Token，
 *      不同账号永远连不上同一份数据——界面直接告诉你。
 *   4) 上传前检查数据大小：Gist 单文件超过 1MB 会被 API 截断，自动预警阻止。
 *
 * 使用：
 * 1. 生成 GitHub Token（只需一次）：https://github.com/settings/tokens/new?description=efficiency-hub-sync&scopes=gist
 * 2. 手机和电脑都粘贴【同一个账号】的 Token
 * 3. 想让哪边覆盖哪边，就手动点「上传」或「下载」，每次覆盖前都会弹窗确认
 */
(function () {
  'use strict';

  // ============ 配置 ============
  let GITHUB_TOKEN = localStorage.getItem('github_token') || '';
  let GIST_ID = localStorage.getItem('github_gist_id') || '';
  let GITHUB_LOGIN = localStorage.getItem('github_login') || '';
  const GITHUB_API = 'https://api.github.com';
  const GIST_FILENAME = 'efficiency-hub-sync.json';
  const GIST_DESC = '个人效率中心-云端同步';
  const MAX_UPLOAD_BYTES = 900 * 1024;   // 超过此值警告（Gist 单文件 1MB 截断，留余量）
  const BLOCK_UPLOAD_BYTES = 990 * 1024; // 超过此值阻止上传

  // ============ 状态 ============
  let isConnected = false;
  let statusEl = null;
  let syncBtn = null;
  let lastSyncTime = localStorage.getItem('sync_last_sync') || '';
  let cloudSummary = null; // 打开面板时异步拉取的云端概览 {keys, updatedAt, login}

  // 不纳入同步的键（本机偏好 / 同步配置）
  const EXCLUDE_KEYS = new Set([
    'github_token', 'github_gist_id', 'github_login', 'sync_last_sync', 'sync_timestamps',
    'hub_lastModule', 'hub_theme', 'hub_sidebar', 'hub_custom_modules', 'hub_module_hidden'
  ]);

  // ============ 工具：弹窗 ============
  function closeTopModal() {
    const m = document.querySelector('.sync-mask');
    if (m) m.remove();
  }

  // 通用确认弹窗：返回 Promise<boolean>，okText 可自定义
  function showConfirm(title, message, okText) {
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'sync-mask';
      mask.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:center;justify-content:center;';
      const modal = document.createElement('div');
      modal.style.cssText = 'background:white;border-radius:12px;padding:22px;max-width:460px;width:90%;max-height:86vh;overflow:auto;box-shadow:0 8px 32px rgba(0,0,0,.2);';
      modal.innerHTML = `
        <h3 style="margin:0 0 10px;font-size:18px">${title}</h3>
        <div style="margin:0 0 18px;color:#444;font-size:14px;line-height:1.7;white-space:pre-wrap">${message}</div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button class="sync-cancel" style="padding:9px 18px;border:1px solid #ddd;border-radius:6px;background:white;cursor:pointer;font-size:14px">取消</button>
          <button class="sync-ok" style="padding:9px 18px;border:none;border-radius:6px;background:#08bd74;color:white;cursor:pointer;font-size:14px">${okText || '确定覆盖'}</button>
        </div>`;
      mask.appendChild(modal);
      document.body.appendChild(mask);
      mask.addEventListener('click', (e) => { if (e.target === mask) { mask.remove(); resolve(false); } });
      modal.querySelector('.sync-cancel').onclick = () => { mask.remove(); resolve(false); };
      modal.querySelector('.sync-ok').onclick = () => { mask.remove(); resolve(true); };
    });
  }

  function showAlert(message) {
    return showConfirm('提示', message, '知道了').then(() => {});
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
    syncBtn.addEventListener('click', openSyncPanel);
  }

  function updateStatus(text) {
    if (statusEl) statusEl.textContent = text;
    const bar = document.getElementById('syncBarStatus');
    if (bar) bar.textContent = text;
  }

  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(Number(ts));
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  // ============ 数据摘要（确认覆盖前给用户看） ============
  // dataObj: {key: {value, timestamp}} → 按模块归类统计
  function summarizeData(dataObj) {
    const modules = (typeof MODULES !== 'undefined' && Array.isArray(MODULES)) ? MODULES : [];
    const counts = [];
    let other = 0;
    for (const key in dataObj) {
      if (EXCLUDE_KEYS.has(key)) continue;
      const m = modules.find(x => (x.keys || []).includes(key));
      if (m) {
        const item = counts.find(c => c.name === m.name);
        if (item) item.n++; else counts.push({ name: m.name, icon: m.icon, n: 1 });
      } else {
        other++;
      }
    }
    let text = counts.map(c => `${c.icon}${c.name}(${c.n})`).join(' ');
    if (other > 0) text += (text ? ' ' : '') + `其他数据(${other})`;
    return text || '（空）';
  }

  function countDataKeys(dataObj) {
    let n = 0;
    for (const key in dataObj) if (!EXCLUDE_KEYS.has(key)) n++;
    return n;
  }

  // ============ 同步主面板 ============
  function openSyncPanel() {
    closeTopModal();
    const mask = document.createElement('div');
    mask.className = 'sync-mask';
    mask.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:center;justify-content:center;';
    const modal = document.createElement('div');
    modal.style.cssText = 'background:white;border-radius:12px;padding:24px;max-width:480px;width:92%;max-height:90vh;overflow:auto;box-shadow:0 8px 32px rgba(0,0,0,.2);';
    const connState = isConnected ? `✅ 已连接${GITHUB_LOGIN ? ' @' + GITHUB_LOGIN : ''}` : '⚙️ 未配置';
    const lastTxt = lastSyncTime ? ('上次操作：' + fmtTime(lastSyncTime)) : '还没有同步过';
    modal.innerHTML = `
      <h2 style="margin:0 0 6px;font-size:20px">🔄 云端同步</h2>
      <p style="margin:0 0 14px;color:#666;font-size:13px">${connState} ｜ ${lastTxt}</p>

      <div style="background:#f6f8fa;border-radius:8px;padding:12px;font-size:13px;color:#444;line-height:1.7;margin-bottom:14px">
        <b>怎么用：</b><br>
        • <b>上传</b>：把这部设备的数据存到云端（覆盖云端）<br>
        • <b>下载</b>：把云端的数据拉到这部设备（覆盖本机）<br>
        想让手机和电脑一致，就先在「源头」那端点<b>上传</b>，再到另一端点<b>下载</b>。
        <div style="margin-top:6px;color:#d97706">⚠️ 手机和电脑必须用<b>同一个 GitHub 账号</b>的 Token。</div>
      </div>

      <div style="display:flex;gap:10px;margin-bottom:12px">
        <button id="syncUpload" style="flex:1;padding:12px;border:none;border-radius:8px;background:#08bd74;color:white;font-size:15px;cursor:pointer">⬆️ 上传到云端</button>
        <button id="syncDownload" style="flex:1;padding:12px;border:none;border-radius:8px;background:#3b82f6;color:white;font-size:15px;cursor:pointer">⬇️ 从云端下载</button>
      </div>

      <div id="cloudInfo" style="background:#eef6ff;border:1px solid #d6e6ff;border-radius:8px;padding:10px 12px;font-size:12.5px;color:#1d4ed8;line-height:1.7;margin-bottom:14px">云端数据：读取中...</div>

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

    // 异步加载云端概览（不阻塞面板）
    if (isConnected) {
      fetchCloudSummary().then(s => {
        const el = modal.querySelector('#cloudInfo');
        if (!el) return;
        if (s) {
          el.innerHTML = `<b>云端数据：</b>${s.keys} 项数据键 ｜ 更新于 ${fmtTime(s.updatedAt)}${s.login ? ' ｜ 账号 @' + s.login : ''}<br><span style="color:#475569">${s.brief}</span>`;
        } else {
          el.innerHTML = '<b>云端数据：</b>暂无（先点「上传到云端」）';
        }
      });
    } else {
      const el = modal.querySelector('#cloudInfo');
      if (el) el.innerHTML = '云端数据：配置 Token 并连接后才能读取。';
    }
  }

  async function fetchCloudSummary() {
    try {
      await findOrCreateGist();
      const remote = await readGist();
      if (!remote || !remote.data || Object.keys(remote.data).length === 0) return null;
      const keys = countDataKeys(remote.data);
      return {
        keys,
        updatedAt: remote.updatedAt || Date.now(),
        login: GITHUB_LOGIN,
        brief: summarizeData(remote.data).slice(0, 80)
      };
    } catch (e) {
      return null;
    }
  }

  // ============ 配置弹窗 ============
  function showConfigModal() {
    closeTopModal();
    const mask = document.createElement('div');
    mask.className = 'sync-mask';
    mask.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:center;justify-content:center;';
    const modal = document.createElement('div');
    modal.style.cssText = 'background:white;border-radius:12px;padding:24px;max-width:460px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,.2);';
    modal.innerHTML = `
      <h2 style="margin:0 0 8px;font-size:20px">🔄 配置云端同步</h2>
      <p style="margin:0 0 12px;color:#666;font-size:14px">用 GitHub Gist 存储数据，国内可访问，免费</p>
      <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:10px 12px;font-size:12.5px;color:#b45309;line-height:1.7;margin-bottom:14px">
        ⚠️ <b>手机和电脑必须使用同一个 GitHub 账号的 Token</b>，否则两边永远连不上同一份云端数据。
      </div>
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
        await initSync(true);
        mask.remove();
      } catch (e) {
        alert('连接失败：' + friendlyError(e));
        btn.textContent = '保存并连接'; btn.disabled = false;
      }
    };
  }

  // ============ GitHub API ============
  function getAuthHeaders() {
    return {
      'Authorization': 'Bearer ' + GITHUB_TOKEN,
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }

  function friendlyError(e) {
    const msg = (e && e.message) || String(e);
    if (/401|Bad credentials/i.test(msg)) return 'Token 无效或已过期，请重新生成';
    if (/403/.test(msg) || /API rate limit/i.test(msg)) return 'GitHub 接口限流或权限不足（需勾选 gist 权限），请稍后再试或重新生成 Token';
    if (/404/.test(msg)) return '云端数据不存在（可能已被删除）';
    if (/too large|content/i.test(msg)) return '数据过大，GitHub 拒绝保存（请先导出备份，减少照片等大文件）';
    return msg;
  }

  async function apiCall(method, path, body) {
    const opts = { method, headers: getAuthHeaders() };
    if (body) opts.body = JSON.stringify(body);
    let resp;
    try {
      resp = await fetch(GITHUB_API + path, opts);
    } catch (e) {
      throw new Error('网络错误，无法连接 GitHub（请检查网络，国内访问可稍后重试）');
    }
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      const m = err.message || ('HTTP ' + resp.status);
      if (resp.status === 403) throw new Error(m + ' (API rate limit)');
      if (resp.status === 404) throw new Error(m + ' (not found)');
      throw new Error(m);
    }
    return resp.json();
  }

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

  async function writeGist(content) {
    if (!GIST_ID) {
      const data = await apiCall('POST', '/gists', {
        description: GIST_DESC, public: false,
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

  // 关键修复：找到账号下我们用的那份 Gist，手机和电脑一定连到同一份。
  // - 分页遍历全部 Gist（列表接口不返回文件内容，必须逐个拉取才能判断有没有数据）
  // - 候选按最近更新排序，逐个 GET 完整内容，优先选「有数据且最新」的
  // - 旧版若留下多个同名 Gist，这里会收敛到同一份
  async function findOrCreateGist() {
    try {
      const candidates = [];
      for (let page = 1; page <= 10; page++) {
        const list = await apiCall('GET', '/gists?per_page=100&page=' + page);
        if (!Array.isArray(list) || list.length === 0) break;
        for (const g of list) {
          if (g.files && g.files[GIST_FILENAME]) candidates.push(g);
        }
        if (list.length < 100) break;
      }
      candidates.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

      // 逐个拉取内容（最多检查 8 个最新候选），找出「有数据且最新」的
      let best = null;
      let bestWithData = null;
      for (let i = 0; i < Math.min(candidates.length, 8); i++) {
        const g = candidates[i];
        if (!best) best = g;
        try {
          const full = await apiCall('GET', '/gists/' + g.id);
          const file = full.files && full.files[GIST_FILENAME];
          const j = file && file.content ? JSON.parse(file.content) : null;
          if (j && j.data && Object.keys(j.data).length > 0 && !bestWithData) bestWithData = g;
        } catch (e) { /* 单个读取失败跳过 */ }
      }
      const chosen = bestWithData || best;
      if (chosen) {
        GIST_ID = chosen.id;
        localStorage.setItem('github_gist_id', GIST_ID);
        return GIST_ID;
      }
    } catch (e) {
      console.warn('[GitHub] 查找 Gist 失败：', e.message);
      if (GIST_ID) return GIST_ID; // 网络异常回退：继续用已记录的
      throw e;
    }
    // 没找到：新建
    const data = await apiCall('POST', '/gists', {
      description: GIST_DESC, public: false,
      files: { [GIST_FILENAME]: { content: JSON.stringify({ version: 1, data: {}, updatedAt: Date.now() }, null, 2) } }
    });
    GIST_ID = data.id;
    localStorage.setItem('github_gist_id', GIST_ID);
    return GIST_ID;
  }

  // 获取当前账号用户名（诊断：两端必须同一账号）
  async function fetchAccount() {
    try {
      const me = await apiCall('GET', '/user');
      GITHUB_LOGIN = me.login || '';
      localStorage.setItem('github_login', GITHUB_LOGIN);
    } catch (e) {
      GITHUB_LOGIN = '';
    }
    return GITHUB_LOGIN;
  }

  // ============ 数据收集 / 应用 ============
  function collectLocalData() {
    const data = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (EXCLUDE_KEYS.has(key)) continue;
      const value = localStorage.getItem(key);
      if (value === null) continue;
      data[key] = { value, timestamp: Date.now() };
    }
    return data;
  }

  function getLocalKeys() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!EXCLUDE_KEYS.has(key)) keys.push(key);
    }
    return keys;
  }

  // 用云端数据整体覆盖本机（真正的"下载覆盖"）
  function applyCloudToLocal(serverData) {
    const sdata = serverData.data || {};
    for (const key of getLocalKeys()) localStorage.removeItem(key);
    for (const key in sdata) {
      if (EXCLUDE_KEYS.has(key)) continue;
      const entry = sdata[key];
      if (!entry || typeof entry.value !== 'string') continue;
      localStorage.setItem(key, entry.value);
    }
  }

  function reloadActiveIframe() {
    const active = document.querySelector('#toolContainer .tool-container.active') ||
                   document.querySelector('#toolContainer iframe');
    if (active) {
      const iframe = active.tagName === 'IFRAME' ? active : active.querySelector('iframe');
      if (iframe && iframe.src) iframe.src = iframe.src;
    }
  }

  // ============ 动作：上传 / 下载 ============
  async function doUpload() {
    if (!isConnected) { showConfigModal(); return; }
    try {
      updateStatus('上传中...');
      await findOrCreateGist();   // 始终对准同一份 Gist
      const remote = await readGist();
      const cloudHas = remote && remote.data && Object.keys(remote.data).length > 0;

      const localData = collectLocalData();
      const localSummary = summarizeData(localData);
      const localCount = countDataKeys(localData);
      const payload = JSON.stringify({ version: 1, data: localData, updatedAt: Date.now() });
      const size = new Blob([payload]).size;

      // 大小保护：Gist 单文件超过 1MB 会被截断
      if (size > BLOCK_UPLOAD_BYTES) {
        await showAlert('本机数据约 ' + fmtSize(size) + '，超过 GitHub 云端单文件上限（1MB）。\n\n请先「导出备份」保存到手机/电脑，再删掉部分照片类大文件后重试。');
        updateStatus('数据过大，未上传');
        return;
      }
      if (size > MAX_UPLOAD_BYTES) {
        const okBig = await showConfirm('数据较大（' + fmtSize(size) + '）',
          '本机数据约 ' + fmtSize(size) + '，接近 GitHub 云端 1MB 上限，可能上传失败或被截断。\n\n建议先「导出备份」；仍要上传吗？', '仍要上传');
        if (!okBig) { updateStatus('已取消上传'); return; }
      }

      let msg = '将把【本机数据】上传到云端并覆盖云端。\n\n本机：' + localCount + ' 项\n' + localSummary;
      if (cloudHas) {
        const cloudCount = countDataKeys(remote.data);
        msg += '\n\n⚠️ 云端现有 ' + cloudCount + ' 项数据，将被本机数据【整体替换】。\n想保留云端就点「取消」，改去点「下载」。';
      } else {
        msg += '\n\n云端当前为空，上传后即为首次备份。';
      }
      const ok = await showConfirm('上传将覆盖云端', msg, '确定上传');
      if (!ok) { updateStatus('已取消上传'); return; }

      await writeGist({ version: 1, data: localData, updatedAt: Date.now() });
      lastSyncTime = String(Date.now());
      localStorage.setItem('sync_last_sync', lastSyncTime);
      updateStatus('已上传 ' + fmtTime(lastSyncTime));
      openSyncPanel();
    } catch (e) {
      console.warn('[GitHub] 上传失败:', e.message);
      alert('上传失败：' + friendlyError(e));
      updateStatus('上传失败');
    }
  }

  async function doDownload() {
    if (!isConnected) { showConfigModal(); return; }
    try {
      updateStatus('下载中...');
      await findOrCreateGist();   // 始终对准同一份 Gist
      const remote = await readGist();
      const cloudHas = remote && remote.data && Object.keys(remote.data).length > 0;
      if (!cloudHas) {
        await showAlert('云端还没有数据。\n请先在另一部设备上点「上传到云端」，再来这里下载。');
        updateStatus('云端暂无数据');
        return;
      }
      const cloudCount = countDataKeys(remote.data);
      const cloudSummaryTxt = summarizeData(remote.data);
      const localKeys = getLocalKeys();
      const localHas = localKeys.length > 0;
      const localSummary = localHas ? summarizeData(collectLocalData()) : '';

      let msg = '将用【云端数据】覆盖本机。\n\n云端：' + cloudCount + ' 项\n' + cloudSummaryTxt;
      if (localHas) {
        msg += '\n\n⚠️ 本机现有 ' + localKeys.length + ' 项数据，将被云端数据【整体替换】。\n想保留本机就点「取消」，改去点「上传」。';
      } else {
        msg += '\n\n本机为空，下载即为恢复。';
      }
      const ok = await showConfirm('下载将覆盖本机', msg, '确定下载');
      if (!ok) { updateStatus('已取消下载'); return; }

      applyCloudToLocal(remote);
      reloadActiveIframe();
      if (typeof buildCards === 'function') buildCards();
      lastSyncTime = String(Date.now());
      localStorage.setItem('sync_last_sync', lastSyncTime);
      updateStatus('已下载 ' + fmtTime(lastSyncTime));
      openSyncPanel();
    } catch (e) {
      console.warn('[GitHub] 下载失败:', e.message);
      alert('下载失败：' + friendlyError(e));
      updateStatus('下载失败');
    }
  }

  function fmtSize(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + 'MB';
    return Math.ceil(bytes / 1024) + 'KB';
  }

  // ============ 初始化 ============
  async function initSync(silent) {
    if (!GITHUB_TOKEN) { showConfigModal(); return; }
    try {
      await findOrCreateGist();   // 关键：两端复用同一 Gist
      const login = await fetchAccount();
      isConnected = true;
      updateStatus(login ? '已连接 @' + login : '已连接');
    } catch (e) {
      console.error('[GitHub] 初始化失败:', e);
      isConnected = false;
      updateStatus('连接失败');
      if (!silent) showConfigModal();
    }
  }

  async function init() {
    createSyncUI();
    if (!GITHUB_TOKEN) { updateStatus('未配置'); return; }
    await initSync(false);
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
    isConnected: () => isConnected,
    getLogin: () => GITHUB_LOGIN,
    getStatusText: () => (statusEl ? statusEl.textContent : '')
  };
})();
