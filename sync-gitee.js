/**
 * 个人效率中心 - Gitee 云端同步模块（分片增量版）
 *
 * 为什么有这个东西：
 * GitHub Gist 单文件内联只给 1MB，超了必须走 raw_url（海外 CDN，实测 2MB 要 55 秒且断流），
 * 这是「下载失败」的头号原因。Gitee 是国内站点，同样支持「私有仓库 + Access Token」，
 * 速度与稳定性都更可控，因此作为可选后端接入。
 *
 * 与 sync-github.js 的关系：
 * - 压缩 / 合并 / 分片 / 脏片判定等「容易出错的部分」全部复用 window.CloudSyncCore，
 *   本文件只实现「怎么跟 Gitee 的 HTTP 接口打交道」（io 层）。
 * - 分片格式与 Gist 完全一致（efficiency-hub-*.json + meta），因此两边可以互相看数据；
 *   meta 里记了 origin 字段，换后端首次上传会强制全量重写，避免脏片判定串台导致丢数据。
 *
 * 使用：
 * 1. 生成 Gitee 私人令牌：https://gitee.com/profile/personal_access_tokens
 *    勾选 projects（仓库读写）即可，只需要这一个。
 * 2. 在「云端同步」面板切到 Gitee，粘贴令牌；仓库不存在会自动建一个私有仓库。
 *
 * ⚠️ 与 Gist 的接口差异（诚实说明）：
 * - Gitee contents 接口一次只能写一个文件，没有 Gist 那种「一次 PATCH 多文件」的批量能力，
 *   所以多片是并发 PUT 出去的（片数通常 1~5，并发完全够用）。
 * - 每次 PUT 必须带上次读到的 sha（乐观锁）；不带 sha 且文件已存在会 400。
 *   本模块每次提交前重新取一遍 sha，避免并发写冲突。
 */
(function () {
  'use strict';

  const Core = window.CloudSyncCore;
  if (!Core) {
    console.warn('[Gitee] 同步内核未加载（sync-github.js 应先加载），Gitee 后端已跳过');
    return;
  }

  // ============ 配置 ============
  const API = 'https://gitee.com/api/v5';
  const DEFAULT_REPO = 'efficiency-hub-sync';
  const BRANCH = 'master';

  let TOKEN = localStorage.getItem('gitee_token') || '';
  let OWNER = localStorage.getItem('gitee_owner') || '';     // 登录名（用 /user 拿到后缓存）
  let REPO = localStorage.getItem('gitee_repo') || DEFAULT_REPO;
  let isConnected = false;

  // ============ HTTP 小工具 ============
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // Gitee 出错时返回 { message, ... } 或纯文本；尽量翻译成人话
  function humanError(status, payload, what) {
    const msg = (payload && (payload.message || payload.error)) || '';
    if (status === 401) return '令牌无效或已过期（' + what + '）：请重新生成 Gitee 私人令牌并粘贴。';
    if (status === 403) return '没有权限访问该仓库（' + what + '）。\n请确认令牌勾选了 projects 权限。';
    if (status === 404) return '仓库或文件不存在（' + what + '）。';
    if (status === 400 && /sha/i.test(msg)) return '文件已被其它设备改动（' + what + '），本次写入跳过，请重新同步一次。';
    if (status === 429) return '请求过于频繁（' + what + '），请稍后重试。';
    return 'Gitee 接口报错 ' + status + (msg ? '：' + msg : '') + '（' + what + '）';
  }

  // 带重试的请求（国内到 gitee.com 偶发抖动，重试 3 次）
  // ⚠️ 400/401/403/404/409/422 这类「语义错误」不重试：重试不会变好，却会把
  //    「文件不存在」拖成 1.2 秒的等待，还会把原始语义丢掉（导致上层无法判断该不该建仓库）。
  //    靠 err.status 判断，而不是靠文案匹配 —— 文案一改就失效。
  function isRetryable(e) {
    const st = e && e.status;
    if (!st) return true;                       // 网络层错误（fetch reject）：值得重试
    return st === 408 || st === 429 || st >= 500;
  }

  async function req(method, path, opts) {
    const o = opts || {};
    let lastErr = null;
    for (let i = 0; i < 3; i++) {
      try {
        const headers = { 'Authorization': 'Bearer ' + TOKEN };
        let url = path;
        let body;
        if (o.query) {
          const qs = Object.keys(o.query).map(k =>
            encodeURIComponent(k) + '=' + encodeURIComponent(o.query[k])).join('&');
          url = url + (url.indexOf('?') >= 0 ? '&' : '?') + qs;
        }
        if (o.json !== undefined) {
          headers['Content-Type'] = 'application/json;charset=UTF-8';
          body = JSON.stringify(o.json);
        }
        const r = await fetch(API + url, { method: method, headers: headers, body: body, cache: 'no-store' });
        if (r.ok) {
          const txt = await r.text();
          if (!txt) return null;
          try { return JSON.parse(txt); } catch (e) { return txt; }
        }
        let payload = null;
        try { payload = JSON.parse(await r.text()); } catch (e) {}
        const err = new Error(humanError(r.status, payload, o.what || path));
        err.status = r.status;
        err.gitee = true;
        throw err;
      } catch (e) {
        lastErr = e;
        if (!isRetryable(e)) throw e;
      }
      if (i < 2) await sleep(600 * (i + 1));
    }
    throw lastErr || new Error('Gitee 请求失败：' + path);
  }

  // ============ base64（Gitee contents 要求 base64 内容）============
  // 必须支持中文：btoa 只吃 latin1，先走 UTF-8 编码
  function textToB64(s) {
    const u8 = new TextEncoder().encode(s);
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(bin);
  }
  function b64ToText(b64) {
    const bin = atob(String(b64).replace(/\s/g, ''));
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(u8);
  }

  // ============ 仓库：确保存在 ============
  async function getLogin() {
    if (OWNER) return OWNER;
    const me = await req('GET', '/user', { what: '读取账号信息' });
    if (me && me.login) {
      OWNER = me.login;
      localStorage.setItem('gitee_owner', OWNER);
    }
    return OWNER;
  }

  // 仓库不存在则建一个私有仓库（把令牌权限暴露面控制到最小）
  async function ensureRepo() {
    if (!TOKEN) throw new Error('还没有配置 Gitee 令牌');
    const login = await getLogin();
    if (!login) throw new Error('无法读取 Gitee 账号信息，请检查令牌');
    try {
      await req('GET', '/repos/' + login + '/' + REPO, { what: '检查仓库' });
      return { owner: login, repo: REPO };
    } catch (e) {
      if (!/不存在/.test(e.message || '')) throw e;   // 权限问题等，别硬建
    }
    try {
      await req('POST', '/user/repos', {
        what: '创建仓库',
        json: {
          name: REPO,
          description: '个人效率中心 - 云端同步数据（请勿公开）',
          private: true,
          auto_init: true,
          has_issues: false,
          has_wiki: false
        }
      });
    } catch (e) {
      throw new Error('创建私有仓库失败：' + (e.message || e) +
        '\n如果提示权限不足，请到令牌页面确认勾选了「projects」。');
    }
    await sleep(400);   // 新建仓库有极短的可见性延迟，等一下再读
    return { owner: login, repo: REPO };
  }

  // ============ io 层：Gitee contents 接口 ============
  // 路径约定：分片文件放在仓库根目录，与 Gist 里的文件名完全一致（方便互相搬迁）
  function contentsPath(name) { return '/repos/' + OWNER + '/' + REPO + '/contents/' + encodeURIComponent(name); }

  // 读一个文件；不存在返回 null
  async function readContents(name, quiet) {
    try {
      const j = await req('GET', contentsPath(name), { query: { ref: BRANCH }, what: '读取 ' + name });
      if (!j) return null;
      if (j.content && typeof j.content === 'string') return b64ToText(j.content);
      if (typeof j === 'string') return j;
      return null;
    } catch (e) {
      if (/不存在/.test(e.message || '')) return null;
      if (quiet) { console.warn('[Gitee] 读 ' + name + ' 失败:', e.message); return null; }
      throw e;
    }
  }

  // 读 sha（写之前必须拿；文件不存在返回 null）
  async function getSha(name) {
    try {
      const j = await req('GET', contentsPath(name), { query: { ref: BRANCH }, what: '读取 ' + name });
      return (j && j.sha) || null;
    } catch (e) {
      if (/不存在/.test(e.message || '')) return null;
      throw e;
    }
  }

  // 写一个文件（有 sha 走 PUT 更新，无 sha 走 POST 新建）
  async function writeContents(name, text, sha, message) {
    const payload = {
      content: textToB64(text),
      message: message || ('sync ' + new Date().toISOString().slice(0, 19)),
      branch: BRANCH
    };
    if (sha) payload.sha = sha;
    if (sha) {
      await req('PUT', contentsPath(name), { json: payload, what: '更新 ' + name });
    } else {
      await req('POST', contentsPath(name), { json: payload, what: '新建 ' + name });
    }
  }

  async function deleteContents(name, sha, message) {
    await req('DELETE', contentsPath(name), {
      json: { sha: sha, message: message || ('cleanup ' + name), branch: BRANCH },
      what: '删除 ' + name
    });
  }

  const giteeIO = {
    origin: 'gitee',
    label: 'Gitee',
    ensureTarget: async function () {
      const r = await ensureRepo();
      return r.owner + '/' + r.repo;
    },
    getMeta: async function () {
      const headless = await readContents(Core.META_FILENAME, true);
      return headless || null;              // 这里返回的是 meta 的 JSON 对象，见下方 wrapper
    },
    getFile: function (name) { return readContents(name); },
    // ⚠️ 与 Gist 最大的差异：没有批量写。并发 PUT，逐个取 sha。
    //    分片数通常只有 1~5 片，并发不会有压力。
    putFiles: async function (map) {
      const names = Object.keys(map);
      const tasks = names.map(async function (name) {
        // 重试一次：并发 PUT 时可能撞上 sha 变化（另一台设备刚写过）
        for (let attempt = 0; attempt < 2; attempt++) {
          const sha = await getSha(name);
          try {
            await writeContents(name, map[name], sha);
            return name;
          } catch (e) {
            if (attempt === 0 && /已被其它设备改动/.test(e.message || '')) { await sleep(400); continue; }
            throw e;
          }
        }
        return null;
      });
      const done = await Promise.all(tasks);
      return done.filter(Boolean);
    },
    deleteFiles: async function (names) {
      await Promise.all(names.map(async function (name) {
        const sha = await getSha(name);
        if (sha) await deleteContents(name, sha);
      }));
    }
  };

  // Gitee 的 contents 接口把 meta 当普通文件存，读回来的就是文本；
  // 内核约定 io.getMeta() 返回「解析后的对象或 null」，这里补一层解析。
  const rawGetMeta = giteeIO.getMeta;
  giteeIO.getMeta = async function () {
    const txt = await rawGetMeta();
    if (!txt) return null;
    try { return JSON.parse(txt); } catch (e) { return null; }
  };

  // ============ 上传 / 下载 ============
  const TARGET_LABEL = 'Gitee 云盘';

  async function giteeUpload() {
    if (!TOKEN) { showConfigModal(); return; }
    try {
      await ensureRepo();
      const cloudMeta = await readShardedMetaSafe();
      let cloudHas = false;
      if (cloudMeta && cloudMeta.shards) {
        cloudHas = !!(cloudMeta.shards && Object.keys(cloudMeta.shards).length);
      }
      let mode = 'overwrite';
      if (cloudHas) {
        const choice = await Core.showChoice('上传到云端',
          '云端已经存有数据。\n「合并」保留两边较新的数据，不会丢任何一边；\n「覆盖云端」用【本机数据】整体替换云端。',
          '合并到云端', '覆盖云端');
        if (choice === 'cancel') return;
        mode = choice;
      }
      let localData;
      if (mode === 'merge') {
        const remote = await giteeRead();
        localData = Core.buildMergedUpload(remote || { data: {} });
      } else {
        localData = Core.collectLocalData();
      }
      let info;
      try {
        info = await Core.writeShardedWith(giteeIO, localData);
      } catch (e) {
        if (!/不存在/.test(e.message || '')) throw e;
        await ensureRepo();
        info = await Core.writeShardedWith(giteeIO, localData, true);
      }
      markSynced('up', Object.keys(localData));
      const kb = Math.round(info.wroteBytes / 1024);
      Core.notifyOK(mode === 'merge' ? '已合并上传到 Gitee' : '已上传到 Gitee',
        (mode === 'merge'
          ? '两边数据已按「较新保留」合并，共 ' + Object.keys(localData).length + ' 项。'
          : '本机的 ' + Object.keys(localData).length + ' 项数据已存到 Gitee。') +
        '\n本次只更新了 ' + info.wroteShards + ' / ' + info.totalShards + ' 个数据片' +
        (info.skippedShards > 0 ? '（跳过 ' + info.skippedShards + ' 个未变化的片，省流量）' : '') +
        (info.deletedShards ? '，清理 ' + info.deletedShards + ' 个旧片' : '') +
        '。\n本次写入约 ' + kb + 'KB（已压缩）。');
    } catch (e) {
      console.warn('[Gitee] 上传失败:', e.message);
      Core.notifyFail('上传 Gitee 失败', (e.message || String(e)) + '\n本机数据未改动。');
    }
  }

  async function giteeRead() {
    await ensureRepo();
    const meta = await readShardedMetaSafe();
    if (meta && meta.shards && Object.keys(meta.shards).length) {
      return await Core.readShardedWith(giteeIO, meta);
    }
    // 回落：仓库里可能有从 Gist 搬过来的旧单文件
    const legacy = await readContents(Core.LEGACY_FILENAME, true);
    if (!legacy) return { data: {}, updatedAt: 0, legacy: true };
    try {
      const payload = await Core.unpackCloud(JSON.parse(legacy));
      return Object.assign({ legacy: true }, payload || { data: {}, updatedAt: 0 });
    } catch (e) { return { data: {}, updatedAt: 0, legacy: true }; }
  }

  async function readShardedMetaSafe() {
    try { return await Core.readShardedMetaWith(giteeIO); }
    catch (e) { return null; }
  }

  async function giteeDownload() {
    if (!TOKEN) { showConfigModal(); return; }
    try {
      const remote = await giteeRead();
      const cloudHas = remote && remote.data && Object.keys(remote.data).length > 0;
      if (!cloudHas) {
        await Core.showAlert('Gitee 上还没有数据。\n请先在一部设备上点「上传到云端」，再来这里下载。');
        return;
      }
      const localHas = Core.getLocalKeys().length > 0;
      let mode = 'overwrite';
      if (localHas) {
        const choice = await Core.showChoice('下载到本机',
          '本机已经存有数据。\n「合并」保留两边较新的数据，不会丢任何一边；\n「覆盖本机」用【云端数据】整体替换本机。',
          '合并到本机', '覆盖本机');
        if (choice === 'cancel') return;
        mode = choice;
      }
      let stats = null;
      if (mode === 'merge') stats = Core.mergeCloudToLocal(remote);
      else Core.applyCloudToLocal(remote);
      Core.reloadActiveIframe();
      if (typeof buildCards === 'function') buildCards();
      markSynced('down', Object.keys(remote.data));
      Core.notifyOK(mode === 'merge' ? '已合并 Gitee 数据到本机' : '已从 Gitee 同步到本机',
        mode === 'merge'
          ? '合并完成：新增 ' + stats.added + ' 项，更新 ' + stats.updated + ' 项（云端较新），保留本机 ' + stats.kept + ' 项。'
          : '云端的 ' + Object.keys(remote.data).length + ' 项数据已写入本机。');
    } catch (e) {
      console.warn('[Gitee] 下载失败:', e.message);
      Core.notifyFail('从 Gitee 下载失败', (e.message || String(e)) + '\n本机数据未改动。');
    }
  }

  function markSynced(dir, keys) {
    const t = String(Date.now());
    localStorage.setItem('sync_last_sync', t);
    localStorage.setItem('gitee_last_sync', t);
    if (window.BackupHub && window.BackupHub.markSync) {
      try { window.BackupHub.markSync(dir, keys); } catch (e) {}
    }
  }

  // ============ 配置弹窗 ============
  function showConfigModal() {
    const mask = document.createElement('div');
    mask.className = 'sync-mask';
    mask.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:2147483000;display:flex;align-items:center;justify-content:center;';
    const modal = document.createElement('div');
    modal.style.cssText = 'background:white;border-radius:12px;padding:24px;max-width:470px;width:92%;box-shadow:0 8px 32px rgba(0,0,0,.2);';
    modal.innerHTML =
      '<h2 style="margin:0 0 8px;font-size:20px">🪶 配置 Gitee 同步</h2>' +
      '<p style="margin:0 0 14px;color:#666;font-size:13px;line-height:1.6">' +
        '用 Gitee 私有仓库存数据（国内站点，速度比 Gist 更稳）。<b>只需要一个令牌</b>，仓库会自动创建。' +
      '</p>' +
      '<div style="margin-bottom:12px">' +
        '<div style="font-size:13px;color:#333;margin-bottom:6px">第 1 步：生成私人令牌</div>' +
        '<a href="https://gitee.com/profile/personal_access_tokens" target="_blank" ' +
          'style="display:inline-block;padding:8px 14px;background:#c71d23;color:white;border-radius:6px;text-decoration:none;font-size:14px">打开 Gitee 令牌页面</a>' +
        '<div style="font-size:12px;color:#888;margin-top:6px">勾选 <b>projects</b>（仓库读写）就够了，其它可不勾</div>' +
      '</div>' +
      '<div style="margin-bottom:12px">' +
        '<div style="font-size:13px;color:#333;margin-bottom:6px">第 2 步：粘贴令牌</div>' +
        '<input type="text" id="gtToken" placeholder="粘贴访问令牌" value="' + (TOKEN || '') + '" ' +
          'style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:14px;box-sizing:border-box">' +
      '</div>' +
      '<div style="margin-bottom:16px">' +
        '<div style="font-size:13px;color:#333;margin-bottom:6px">仓库名（不存在会自动创建为私有仓库）</div>' +
        '<input type="text" id="gtRepo" value="' + REPO + '" ' +
          'style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:14px;box-sizing:border-box">' +
      '</div>' +
      '<div id="gtMsg" style="font-size:13px;color:#c71d23;min-height:18px;margin-bottom:10px;white-space:pre-wrap"></div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end">' +
        '<button id="gtCancel" style="padding:8px 16px;border:1px solid #ddd;border-radius:6px;background:white;cursor:pointer">取消</button>' +
        '<button id="gtSaveBtn" style="padding:8px 16px;border:none;border-radius:6px;background:#c71d23;color:white;cursor:pointer">保存并连接</button>' +
      '</div>';
    mask.appendChild(modal);
    document.body.appendChild(mask);
    mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove(); });

    modal.querySelector('#gtCancel').onclick = function () { mask.remove(); };
    modal.querySelector('#gtSaveBtn').onclick = async function () {
      const tk = modal.querySelector('#gtToken').value.trim();
      const rp = modal.querySelector('#gtRepo').value.trim() || DEFAULT_REPO;
      const msg = modal.querySelector('#gtMsg');
      const btn = modal.querySelector('#gtSaveBtn');
      if (!tk) { msg.textContent = '请先粘贴令牌'; return; }
      TOKEN = tk; REPO = rp; OWNER = '';
      btn.textContent = '连接中...'; btn.disabled = true; msg.textContent = '';
      try {
        await ensureRepo();
        localStorage.setItem('gitee_token', TOKEN);
        localStorage.setItem('gitee_repo', REPO);
        localStorage.setItem('gitee_owner', OWNER);
        localStorage.setItem('cloud_backend', 'gitee');
        isConnected = true;
        mask.remove();
        Core.notifyOK('Gitee 已连接', '仓库 ' + OWNER + '/' + REPO + ' 就绪。点「上传到云端」即可把本机数据存过去。');
        if (typeof window.refreshBackendUI === 'function') window.refreshBackendUI();
      } catch (e) {
        msg.textContent = e.message || String(e);
        btn.textContent = '保存并连接'; btn.disabled = false;
      }
    };
  }

  // ============ 注册后端 ============
  window.CloudSyncBackends = window.CloudSyncBackends || {};
  window.CloudSyncBackends.gitee = {
    id: 'gitee',
    name: 'Gitee 私有仓库',
    hint: '国内站点，速度稳定，需 Gitee 私人令牌',
    isReady: function () { return !!TOKEN; },
    isConnected: function () { return isConnected; },
    reconfigure: showConfigModal,
    upload: giteeUpload,
    download: giteeDownload
  };

  // 静默探活：有令牌就标已连接（启动路径不发请求，避免拖慢首屏）
  if (TOKEN) { isConnected = true; }

  // 调试 / 测试入口：允许免 UI 直接注入配置
  window.CloudSyncGitee = {
    configure: function (token, repo, owner) {
      TOKEN = token || TOKEN;
      REPO = repo || REPO;
      OWNER = owner || OWNER;
      isConnected = !!TOKEN;
      try {
        localStorage.setItem('gitee_token', TOKEN);
        localStorage.setItem('gitee_repo', REPO);
        if (OWNER) localStorage.setItem('gitee_owner', OWNER);
      } catch (e) {}
    },
    io: giteeIO,
    read: giteeRead,
    upload: giteeUpload,
    download: giteeDownload,
    ensureRepo: ensureRepo
  };
})();
