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
 * 3. v8（2026-09-16）：新增「双向同步」—— 一次点击让两端都变成合并结果，永不覆盖。
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

  let TOKEN = localStorage.getItem('gitee_token') || '';
  let OWNER = localStorage.getItem('gitee_owner') || '';     // 登录名（用 /user 拿到后缓存）
  let REPO = localStorage.getItem('gitee_repo') || DEFAULT_REPO;
  let isConnected = false;

  // ⚠️ 默认分支绝不能写死。Gitee 的新建仓库既有 master 也有 main（取决于账号/建仓时间），
  //    写错分支的后果非常隐蔽：contents 接口在 ref 指向不存在的分支时**不返回 404**，
  //    而是返回 HTTP 200 + 空数组 []。旧代码把 200 当成功 → 判定「文件不存在」→
  //    走 POST 新建 → Gitee 报「文件已存在」或造出重复文件。表现出来就是
  //    「反复操作也传不上去」。所以这里在拿到仓库后探测一次真实默认分支并缓存。
  let BRANCH = localStorage.getItem('gitee_branch') || '';

  function setBranch(b) {
    if (!b || b === BRANCH) return;
    BRANCH = b;
    try { localStorage.setItem('gitee_branch', b); } catch (e) {}
  }

  // 把 contents 接口的响应归一化。
  // Gitee 的几种「看起来像成功其实不是」的返回，必须在这里一次性挡掉：
  //   • []                → 分支不存在（HTTP 200！）
  //   • [{...}]           → 目录列表
  //   • "..."             → 纯文本
  //   • {content: "..."}  → 正常文件
  function normContents(j) {
    if (!j) return { kind: 'missing' };
    if (Array.isArray(j)) {
      if (j.length === 0) return { kind: 'bad-branch' };   // 关键：分支/路径不存在
      return { kind: 'dir', list: j };
    }
    if (typeof j === 'string') return { kind: 'text', text: j };
    if (typeof j.content === 'string') {
      return { kind: 'file', text: b64ToText(j.content), sha: j.sha, raw: j };
    }
    // ⚠️ 大文件（约 >1MB）时 Gitee 的 contents 响应**不含 content 字段**，
    //    只给 sha + download_url。早先这里直接落到 missing，后果连锁反应非常隐蔽：
    //      missing → getSha 返回 null → putFiles 判定「文件不存在」→ 走 POST 新建 →
    //      对已存在的文件必然失败 → 用户看到「文件新建失败」（400）。
    //    文件越大越容易触发，所以「数据一多就传不上去」。
    //    只要响应里有 sha，就说明文件确实存在 —— 按存在处理，只是内容需要另拉。
    if (j.sha) {
      return { kind: 'file', text: null, sha: j.sha, raw: j, needsDownload: !j.content };
    }
    return { kind: 'missing', raw: j };
  }

  // ============ HTTP 小工具 ============
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // Gitee 出错时返回 { message, ... } 或纯文本；尽量翻译成人话
  // ⚠️ 原则：翻译成人话的同时，**必须保留原始报错**。只给「令牌无效」而不给
  //    Gitee 的原文，遇到非典型故障（比如账号被封、IP 被限）就没法排查了。
  function humanError(status, payload, what) {
    const msg = (payload && (payload.message || payload.error)) || '';
    const raw = msg ? '（Gitee 原文：' + msg + '）' : '';
    if (status === 401) {
      return '令牌无效或已过期（' + what + '）：请重新生成 Gitee 私人令牌并粘贴。' + raw;
    }
    if (status === 403) {
      return '令牌权限不足（' + what + '）：请确认勾选了「projects」。' + raw;
    }
    if (status === 404) {
      // Gitee 对「私有库但无权限」也回 404，故意不区分存在性（防探测）。
      // 所以这里不能武断说「仓库不存在」——那会让人反复去建一个其实已经存在的库。
      // ⚠️ 文案里必须保留「不存在」二字：其他分支靠 /不存在/ 判断是否属于
      //    「正常未找到」（该继续走新建流程），丢了这两个字会把正常流程打断。
      return '仓库或文件不存在（' + what + '）。' +
        '若仓库已建好，多半是令牌没有该仓库权限（私有库无权限时 Gitee 也回 404），' +
        '请确认勾选了「projects」。' + raw;
    }
    if (status === 400 && /sha/i.test(msg)) {
      return '文件已被其它设备改动（' + what + '），本次写入跳过，请重试一次同步。' + raw;
    }
    if (status === 422) {
      return '提交被拒绝（' + what + '）：可能是分支不存在或内容为空。' + raw;
    }
    if (status === 429) {
      return '请求过于频繁（' + what + '），请稍后重试。' + raw;
    }
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

  // ---- 配额状态（Gitee 限流的核心）----
  // Gitee 的 API 配额是按「请求次数/分钟」计的（未认证 60，认证 100 量级），
  // 超了会回 429 + Retry-After。旧实现遇到 429 仍是「隔 600ms 快速重试 3 次」，
  // 配额没恢复就再撞 429，3 次瞬间用完 → 整次同步报失败，用户看到「全片没读到」。
  // 这里做两件事：
  //   ① 记住服务端要求的冷却截止时间（remaining/retryAfter），冷却期内不再发请求；
  //   ② 遇到 429 时按 Retry-After 等待，而不是固定 600ms。
  let rateLimitUntil = 0;     // 冷却截止时间戳；> now 表示处于冷却期
  let rateLimitedAt = 0;      // 最近一次 429 的时间，用于给出友好提示
  function quotaCoolingMs() { return Math.max(0, rateLimitUntil - Date.now()); }

  // 等待配额冷却。返回实际等待毫秒数。
  async function waitForQuota() {
    const ms = quotaCoolingMs();
    if (ms > 0) { await sleep(Math.min(ms, 65000)); return ms; }
    return 0;
  }

  async function req(method, path, opts) {
    const o = opts || {};
    let lastErr = null;
    // 发请求前先看配额：冷却期内先等，避免明知会 429 还硬打。
    await waitForQuota();
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

        // 读配额响应头：Gitee 会给出剩余额度与重置时间。
        // 只要剩余为 0，就把「冷却截止」记下来，后续请求自动等待，
        // 不必等到撞 429 才发现没配额了。
        try {
          const rem = parseInt(r.headers.get('X-RateLimit-Remaining') || r.headers.get('RateLimit-Remaining') || '', 10);
          const resetHdr = r.headers.get('X-RateLimit-Reset') || r.headers.get('RateLimit-Reset');
          if (rem === 0 && resetHdr) {
            const reset = parseInt(resetHdr, 10);
            // reset 可能是秒级时间戳，也可能是「距现在多少秒」
            const ms = reset > 1e9 ? (reset * 1000 - Date.now()) : (reset * 1000);
            if (ms > 0) rateLimitUntil = Date.now() + Math.min(ms, 65000);
            else rateLimitUntil = Date.now() + 60000;
          } else if (rem === 0) {
            rateLimitUntil = Date.now() + 60000;
          }
        } catch (e) { /* 头读不到就算了，不影响主流程 */ }

        if (r.ok) {
          const txt = await r.text();
          if (!txt) return null;
          try { return JSON.parse(txt); } catch (e) { return txt; }
        }
        let payload = null;
        try { payload = JSON.parse(await r.text()); } catch (e) {}

        // 429：配额用尽。按 Retry-After 冷却，而不是固定 600ms 硬撞。
        if (r.status === 429) {
          rateLimitedAt = Date.now();
          const ra = parseInt(r.headers.get('Retry-After') || '', 10);
          const waitMs = (!isNaN(ra) && ra > 0)
            ? Math.min(ra * 1000, 65000)
            : 30000;   // 没给就等 30 秒
          rateLimitUntil = Date.now() + waitMs;
          const e429 = new Error('Gitee 接口调用配额已用尽（' + (o.what || path) + '）。' +
            '已自动等待 ' + Math.round(waitMs / 1000) + ' 秒后重试；若仍失败，请等 1 分钟后再点同步。');
          e429.status = 429; e429.gitee = true; e429.retryAfterMs = waitMs;
          throw e429;
        }

        const err = new Error(humanError(r.status, payload, o.what || path));
        err.status = r.status;
        err.gitee = true;
        throw err;
      } catch (e) {
        lastErr = e;
        if (!isRetryable(e)) throw e;
      }
      // 重试前的等待：429 用配额冷却时间，其它错误用递增退避。
      if (i < 2) {
        if (lastErr && lastErr.status === 429) {
          await waitForQuota();                     // 等配额恢复，再重试
        } else {
          await sleep(600 * (i + 1));
        }
      }
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
  //
  // ⚠️ 性能要点：这个函数会被多个入口调用（上传前的 ensureRepo、io.ensureTarget、
  //    readShardedMetaWith…），一次同步里可能被调 5~6 次。
  //    如果每次都发「读仓库信息」的请求，一次上传就会多出好几个网络往返。
  //    实测在 300ms 延迟下，一次上传 13 个请求里有 6 个是重复的仓库探测，
  //    白白多花近 2 秒 —— 这就是用户感觉「卡顿」的主因。
  //    因此这里做「同一轮同步内只探一次」的会话级缓存，跨轮自动失效（见 resetRepoProbe）。
  let repoProbed = null;        // { owner, repo, branch } —— 本轮已确认过的结果
  function resetRepoProbe() { repoProbed = null; }

  async function ensureRepo() {
    if (!TOKEN) throw new Error('还没有配置 Gitee 令牌');
    // 命中缓存：同一轮里已经确认过仓库和分支，直接复用，不再发请求
    if (repoProbed && repoProbed.repo === REPO && repoProbed.branch) {
      setBranch(repoProbed.branch);
      return repoProbed;
    }
    const login = await getLogin();
    if (!login) throw new Error('无法读取 Gitee 账号信息，请检查令牌');

    // 一次请求同时回答两个问题：仓库在不在？默认分支叫什么？
    // 原来这里拆成两次 GET（先探存在性、再读 default_branch），
    // 每次同步都白花一个网络往返。Gitee 的 /repos/:o/:r 一次就把两者都给了。
    //
    // ⚠️ 注意 Gitee 对「私有库无权限」也回 404，所以拿到 404 时不能直接认定
    //    「不存在」，要结合建库是否成功来判断。
    let exists = false;
    let realBranch = '';
    try {
      const info = await req('GET', '/repos/' + login + '/' + REPO, { what: '检查仓库' });
      exists = true;
      realBranch = (info && info.default_branch) || '';
    } catch (e) {
      if (!/不存在/.test(e.message || '')) {
        // 403 之类：令牌本身有问题，直接说清楚，不要硬去建库
        throw new Error(e.message || String(e));
      }
    }

    if (!exists) {
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
          '\n请确认令牌勾选了「projects」权限。');
      }
      // 新建仓库后要等它初始化出第一个提交（auto_init 是异步的），
      // 否则紧接着写 contents 会 404。旧代码只等 400ms，经常不够。
      realBranch = await waitRepoReady(login, REPO);
    }

    // 关键：核对真实默认分支，否则 ref 写错会让所有读写都静默失败。
    //
    // 必须核对而不能只在 BRANCH 为空时才探测：缓存里的分支名可能来自上一次的
    // 错误推断（比如旧版本硬编码的 master），一旦被污染就是「每次同步都失败、
    // 但报错信息毫无线索」。上面的 GET 已经顺手把 default_branch 带回来了，
    // 所以这个核对是零额外成本的。
    if (realBranch) {
      if (realBranch !== BRANCH) {
        if (BRANCH) console.warn('[Gitee] 缓存的默认分支 "' + BRANCH + '" 与远端 "' + realBranch + '" 不一致，已纠正');
        setBranch(realBranch);
      }
    } else if (!BRANCH) {
      // 兜底：连仓库信息都读不到时，也不能让 BRANCH 为空 —— ref='' 会被
      // Gitee 当作「分支不存在」而静默返回 []，那是最难排查的失败方式。
      try {
        const info = await req('GET', '/repos/' + login + '/' + REPO, { what: '读取仓库信息' });
        setBranch((info && info.default_branch) || 'master');
      } catch (e) {
        setBranch('master');
      }
    }
    repoProbed = { owner: login, repo: REPO, branch: BRANCH };
    return { owner: login, repo: REPO, branch: BRANCH };
  }

  // 等仓库初始化完成：反复探仓库信息 + 探祖先提交，最多约 6 秒
  //
  // ⚠️ 这里有两处极易踩的坑，都是线上「新建仓库后传不上去」的真凶：
  //   ① 【空目录 ≠ 未就绪】Gitee 的 contents 接口对「分支存在但目录为空」返回的是
  //      合法空数组 []，和「分支不存在」返回的 [] **在响应上完全一样**。
  //      早期代码把 [] 一律当成 bad-branch，于是永远等不到「就绪」，
  //      白等满 16 轮 ≈ 19 秒，最后 BRANCH 仍是空串 → 后面所有请求的 ref='' → 全部静默失败。
  //      正确做法：repo 信息能读到 default_branch，就已经说明仓库和分支都建好了，
  //      可以立刻采用；目录里有没有文件根本不影响写第一个文件。
  //   ② 【必须有兜底分支】万一探测循环一次都没成功，也绝对不能把 BRANCH 留空，
  //      否则 ref='' 会被 Gitee 当作「分支不存在」而静默返回 []。
  async function waitRepoReady(owner, repo) {
    let lastBranch = '';
    let lastProbeErr = '';
    for (let i = 0; i < 12; i++) {
      await sleep(400);
      try {
        const info = await req('GET', '/repos/' + owner + '/' + repo, { what: '等待仓库就绪' });
        const br = (info && info.default_branch) || '';
        if (!br) continue;                 // 仓库信息还没出来，继续等
        lastBranch = br;
        // 分支名已知即可认为可用 —— 目录为空（Gitee 回 []）也算可用，
        // 写第一个文件完全不需要目录里先有东西。
        // 这里只做一次「轻探」确认分支可读，探测失败不阻塞（分支名本身已可信）。
        try {
          const raw = await req('GET', '/repos/' + owner + '/' + repo + '/contents/',
            { query: { ref: br }, what: '等待仓库就绪' });
          const probe = normContents(raw);
          if (probe.kind === 'missing') { lastProbeErr = 'contents 返回无法识别的内容'; continue; }
        } catch (e) {
          // 探测出错（网络抖动、接口差异）不改变「分支名已知」这个事实，直接采用
          lastProbeErr = e.message || String(e);
        }
        setBranch(br);
        return br;
      } catch (e) {
        lastProbeErr = e.message || String(e);
      }
    }
    // 兜底：探测循环全失败时，也必须给一个非空分支名，否则 ref='' 会让
    // 后续所有请求静默返回 []。把探测到过的/预期的错误暴露到控制台便于排查。
    const fallback = lastBranch || 'master';
    console.warn('[Gitee] 未能确认仓库默认分支，暂用 "' + fallback + '" 继续。最后一次探测：' + lastProbeErr);
    setBranch(fallback);
    return BRANCH;
  }

  // ============ io 层：Gitee contents 接口 ============
  // 路径约定：分片文件放在仓库根目录，与 Gist 里的文件名完全一致（方便互相搬迁）
  function contentsPath(name) { return '/repos/' + OWNER + '/' + REPO + '/contents/' + encodeURIComponent(name); }

  // 读一个文件；不存在返回 null
  // retried 用于「分支失效 → 自愈 → 再读一次」的内部重试，最多一次。
  //
  // 会话级缓存：一次同步里 meta 常被读 2~3 次（上传前判云端有没有数据、
  // readShardedMetaWith、giteeRead…），每次都是独立网络请求。
  // 缓存一下能把一次上传的请求数从 9 降到 6 左右。
  // 只在「同一轮同步」内有效：giteeUpload/giteeDownload 入口会清掉（见 clearFileCache）。
  const fileCache = new Map();
  const shaCache = new Map();
  // 进行中的读请求：同一文件被并发读时复用同一个 Promise。
  // 为什么必须要有：readShardedWith 会并发拉所有分片，而 meta 又可能同时被
  // 上传流程和 io 层各读一次 —— 没有这个去重，缓存还没写进去，第二个请求就
  // 已经发出去了，等于白读一遍（实测一次上传里 meta 被读两次）。
  const inflight = new Map();
  function clearFileCache() { fileCache.clear(); shaCache.clear(); inflight.clear(); }

  async function readContents(name, quiet, retried) {
    if (!retried && fileCache.has(name)) return fileCache.get(name);
    if (!retried && inflight.has(name)) return inflight.get(name);
    const p = readContentsRaw(name, quiet, retried);
    if (!retried) {
      inflight.set(name, p);
      // ⚠️ 必须用 then(clear, clear)，不能写 p.finally(clear)：
      //    finally 会派生一个**新的 promise**，它同样以 p 的失败原因 reject，
      //    而这里没人接住它 —— 浏览器就会报「Uncaught (in promise)」。
      //    分片读失败时这会在控制台留下一条吓人的红字（实测一次抖动留下 2 条
      //    「分支名不正确，且自动修正失败…」），把"已经处理好的错误"伪装成"页面崩了"。
      //    then 的双参数形式两个分支都有处理函数，不派生 rejected promise。
      const clear = function () { if (inflight.get(name) === p) inflight.delete(name); };
      p.then(clear, clear);
    }
    return p;
  }

  async function readContentsRaw(name, quiet, retried) {
    try {
      const raw = await req('GET', contentsPath(name), { query: { ref: BRANCH }, what: '读取 ' + name });
      const n = normContents(raw);
      if (n.kind === 'text') {
        fileCache.set(name, n.text);
        return n.text;
      }
      if (n.kind === 'file') {
        // 同一次响应里 sha 也一起带回来了，顺手存下 —— 否则后面要写这个文件时
        // getSha 还得为 sha 再发一次一模一样的 GET（一次上传能省 1~2 个来回）。
        if (n.sha) shaCache.set(name, n.sha);
        if (n.text !== null && n.text !== undefined) {
          fileCache.set(name, n.text);
          return n.text;
        }
        // 大文件：响应里没有 content，得另拉一次原文。
        // 缓存里先放 null 占位是不行的（会被误判成「文件不存在」），所以这里
        // 只在真正拿到内容后才写缓存，拿不到就返回 null 让上层跳过这个片。
        const txt = await fetchRaw(n.raw);
        fileCache.set(name, txt);
        return txt;
      }
      // bad-branch：Gitee 在两种完全不同的情况下都回 HTTP 200 + []：
      //   ① ref 指向的分支不存在（即真的分支名错了）
      //   ② 服务端瞬时异常，把内容读取降级成了空结果
      // 分片是并发读的，所以一次抖动会**同时**打中多片；而单片读不到就会让整片
      // 被上层静默丢弃 —— 再往下就是用不完整的数据写回云端，代价是全量数据丢失。
      // 因此这里要**多给几次机会**：自愈 + 最多两次重读（每次都是新请求，不走缓存）。
      if (n.kind === 'bad-branch') {
        if (!retried) {
          await healBranch();                    // 已含重试与并发去重，自身不抛错
          for (let k = 0; BRANCH && k < 2; k++) {
            if (k) await sleep(400);
            const again = await readContents(name, quiet, true);
            if (again !== null && again !== undefined) return again;
          }
        }
        if (!quiet) throw new Error(badBranchMsg(name));
        return null;
      }
      // 「文件不存在」也要缓存：同一轮里对同一个不存在的文件的多次查询
      // 都会走 404，缓存成 null 能省掉重复请求。
      fileCache.set(name, null);
      return null;
    } catch (e) {
      if (/不存在/.test(e.message || '')) { fileCache.set(name, null); return null; }
      if (quiet) { console.warn('[Gitee] 读 ' + name + ' 失败:', e.message); return null; }
      throw e;
    }
  }

  // 拉大文件原文。Gitee 对 >1MB 的文件不返回 content，只给 download_url。
  // 注意 download_url 走的是 gitee.com 的原始文件通道，同样受 CORS 限制，
  // 所以失败时要能优雅降级（宁可这个片读不到，也不能把「存在」误判成「不存在」）。
  async function fetchRaw(info) {
    const url = info && (info.raw && (info.raw.download_url || info.raw.raw_url));
    if (!url) return null;
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) { console.warn('[Gitee] 拉取大文件失败 ' + r.status + '：' + url); return null; }
      return await r.text();
    } catch (e) {
      console.warn('[Gitee] 拉取大文件异常:', e && e.message);
      return null;
    }
  }

  // 读 sha（写之前必须拿；文件不存在返回 null）
  // ⚠️ 要点：不能用 200 判断成功。分支写错时 Gitee 回 200 + []，
  //    旧代码会拿到 undefined 的 sha → 走 POST 新建 → 对已存在文件必然失败。
  async function getSha(name, retried) {
    // 复用缓存：如果这一轮刚读过这个文件，直接把 sha 记下来，不再发请求。
    // 注意缓存存的是「文本内容」，sha 单独用一张表记，避免又读一遍。
    //
    // ⚠️ 这里只能复用「非 null」的缓存值。缓存的 null 含义是「我们**曾经**认为它
    //    不存在」，但那个判断可能是错的（大文件响应缺 content、临时网络抖动、
    //    分支当时不对…）。把 null 当命中直接返回，就等于把这个错误判断永久固化，
    //    后面 putFiles 一律走 POST 新建 → 对已存在的文件必然 400「文件新建失败」。
    //    所以拿到 null 时必须真的去问一次 Gitee，让结论来自这一次请求。
    if (!retried && shaCache.get(name)) return shaCache.get(name);
    try {
      const raw = await req('GET', contentsPath(name), { query: { ref: BRANCH }, what: '读取 ' + name });
      const n = normContents(raw);
      if (n.kind === 'file') { shaCache.set(name, n.sha || null); return n.sha || null; }
      if (n.kind === 'text') {
        // 纯文本形态拿不到 sha，再取一次元数据（sha 在响应头/结构里）
        return null;
      }
      if (n.kind === 'bad-branch') {
        // 同 readContentsRaw：先自愈，再给两次重读机会，不要一撞上就抛错 ——
        // 抛出去的后果是「上传失败」，而真实原因可能只值一次抖动。
        if (!retried) {
          await healBranch();
          for (let k = 0; BRANCH && k < 2; k++) {
            if (k) await sleep(400);
            try {
              const raw2 = await req('GET', contentsPath(name), { query: { ref: BRANCH }, what: '读取 ' + name });
              const n2 = normContents(raw2);
              if (n2.kind === 'file') { shaCache.set(name, n2.sha || null); return n2.sha || null; }
              if (n2.kind === 'text' || n2.kind === 'dir') return null;
            } catch (e) { /* 这次也不行，继续下一次 */ }
          }
        }
        throw new Error(badBranchMsg(name));
      }
      // 走到这里说明响应里既没有 content 也没有 sha —— 确实不存在。
      // 不写缓存：这类「不存在」判断可能是由响应异常造成的，缓存下来会误导后续调用
      //（getShaViaRead 会跳过真的探测）。少省一次请求，换正确性。
      return null;
    } catch (e) {
      if (/不存在/.test(e.message || '')) return null;
      throw e;
    }
  }

  // 取 sha 的另一种入口：先保证「内容已读过」。
  // 这样 sha 和内容共用同一次 GET —— 上传流程往往是「先读 meta 判断云端有没有数据，
  // 再取 meta 的 sha 去写」，两次操作其实只需要一个请求。
  async function getShaViaRead(name) {
    // ⚠️ 不能用 shaCache.has() 判断「有结果」：文件不存在时我们**故意**缓存 null，
    //    用它当命中条件会把 null 当成有效 sha 直接返回 → 上层误判文件不存在 →
    //    POST 新建 → 对已存在文件报 400「文件新建失败」。
    //    所以这里取到 null 时必须继续走真正的 getSha，而不是提前返回。
    if (shaCache.get(name)) return shaCache.get(name);
    await readContents(name, true);
    if (shaCache.get(name)) return shaCache.get(name);
    return getSha(name);
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
    // 写成功后本机缓存就过期了：留着会让后续读到旧内容、拿到旧 sha
    fileCache.delete(name);
    shaCache.delete(name);
  }

  async function deleteContents(name, sha, message) {
    await req('DELETE', contentsPath(name), {
      json: { sha: sha, message: message || ('cleanup ' + name), branch: BRANCH },
      what: '删除 ' + name
    });
    fileCache.set(name, null);      // 已删除：记成「不存在」，避免再发一次注定 404 的请求
    shaCache.set(name, null);
  }

  // 分支名失效（Gitee 对不存在的分支返回 200 + [] 而不是 404）时，
  // 在这里**就地重新探测一次**，而不是把错误抛给上层。
  // 为什么必须就地自愈：BRANCH 一旦是错的，读会得到 []、写会走 POST 撞「文件已存在」，
  // 上层只看到「传不上去」这种毫无线索的现象。就地重探能让绝大多数情况自动恢复。
  //
  // ⚠️ 三条硬约束，都是线上踩出来的（2026-09-16 自动同步日志里的
  //    「分支名不正确，且自动修正失败（请检查令牌是否有该仓库权限）」）：
  //   ① 自愈**绝不能先销毁**手里已有的分支名。
  //      旧实现一进来就 BRANCH='' + removeItem('gitee_branch')，一旦紧接着的探测
  //      也失败（Gitee 瞬时 5xx 时很容易），就把一个「本来正确、只是撞上一次抖动」
  //      的状态变成了空分支 —— 偶发故障由此升级成持续故障：之后每次 contents 请求
  //      的 ref 都是空串，Gitee 一律回 200 + []，看起来像"仓库里什么都没有"。
  //      正确顺序是【先探到新值，再替换；探不到就原样留着】。
  //   ② 一次同步里多个分片会**同时**撞上 bad-branch（Promise.all 并发读），
  //      不去重就各探一次（实测 3 个分片放大了 13 次仓库探测请求）。
  //   ③ 探测本身要重试：Gitee 侧瞬时异常是常态，一次就下结论太急。
  let healErr = null;          // 最近一次自愈的失败原因（不能丢，报错文案要用它）
  let healInFlight = null;     // 并发去重：同一时刻只跑一次自愈
  // ④ 自愈预算（本轮同步内最多自愈 1 次）。
  //    为什么需要它：healBranch 本身要发「读仓库/建库」请求，而它会消耗配额；
  //    若失败根因是 429 限流，则「限流 → 返回空数组 → 触发自愈 → 自愈发请求 →
  //    限流更严重」会形成正反馈，把一次瞬时抖动放大成整轮失败。
  //    实测 3 片并发读时，bad-branch 分支逻辑会放大出十几次仓库探测请求。
  //    有了一次性预算，配额紧张时不会自己把自己打死。
  let healBudget = 1;
  function resetHealBudget() { healBudget = 1; healErr = null; healInFlight = null; }

  async function healBranch() {
    if (healInFlight) return healInFlight;
    // 预算耗尽：不再重探分支（那只会更耗配额），直接沿用当前值让上层走重试。
    if (healBudget <= 0) {
      return BRANCH;
    }
    healBudget--;
    healInFlight = (async function () {
      const saved = BRANCH;                 // ★ 备份：失败要能原样还回去
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt) await sleep(700 * attempt);
        resetRepoProbe();                   // 分支要重探，缓存必须先失效
        try {
          // getLogin 会用缓存 OWNER；ensureRepo 会建库（若不存在）+ 探测真实分支
          if (!OWNER) { try { await getLogin(); } catch (e) { /* 下面 ensureRepo 再报错 */ } }
          const r = await ensureRepo();
          if (r && r.branch) {
            if (r.branch !== saved) {
              console.warn('[Gitee] 分支名从 "' + (saved || '空') + '" 修正为 "' + r.branch + '"');
            }
            healErr = null;
            return r.branch;
          }
          lastErr = new Error('Gitee 未返回默认分支名');
        } catch (e) {
          lastErr = e;
        }
      }
      // 自愈失败：回滚。
      // ensureRepo 有可能在中途把 BRANCH 改成别的值（比如把一次 404 误判成
      // 「仓库不存在」→ 走新建流程 → waitRepoReady 又探出一个分支名）——
      // 那是基于错误前提得出的结论，不能采信，一律退回自愈前的值。
      healErr = lastErr;
      if (BRANCH !== saved) {
        BRANCH = '';
        if (saved) setBranch(saved);
      }
      console.warn('[Gitee] 分支自愈失败，保留原值 "' + (BRANCH || '空') + '"。原因：' +
        ((lastErr && lastErr.message) ? lastErr.message : lastErr));
      return BRANCH;
    })();
    try { return await healInFlight; }
    finally { healInFlight = null; }
  }

  // 自愈失败的原因单独附在报错末尾。
  // 为什么不塞进正文：正文必须能独立读懂 —— 用户只读第一段就知道该干什么
  //（"已中止、两端没动、稍等重试"）；原始报错是给要刨根问底的人的第二层信息。
  // 缺了它，用户看到「分片没读到」却不知道底下是 Gitee 503 还是别的，只能来问。
  function healHint() {
    if (!healErr || !healErr.message) return '';
    return '\n（附：分支自愈最后一次核对的结果是「' + healErr.message + '」）';
  }

  // 把「读到空结果」这件事**如实描述**出来，而不是直接给结论。
  //
  // 旧文案「分支名不正确，且自动修正失败（请检查令牌是否有该仓库权限）」把两个
  // **猜测**写成了结论：既不知道分支名是否真的错了（刚刚才重探过），也不知道是不是
  // 权限问题（真正的权限问题连分支名都读不到，报的会是别的错）。
  // 用户拿着这句话去改令牌，而真实原因只是一次服务端瞬时异常 —— 白折腾。
  function badBranchMsg(name) {
    const cause = (healErr && healErr.message) ? healErr.message : '';
    return '读取 Gitee 上的 ' + name + ' 时，接口返回了空结果（HTTP 200，但内容为空）。\n' +
      '这通常是两种原因之一：\n' +
      '  ① Gitee 侧瞬时异常 —— 正常内容被降级成了空结果；\n' +
      '  ② 分支名不对（当前用的分支是 "' + (BRANCH || '空') + '"）。\n' +
      '已自动重新核对 Gitee 上的默认分支并重试过，仍未读到。\n' +
      (cause ? '最后一次核对的结果：' + cause + '\n' : '') +
      '本机数据未改动。稍等几秒再点一次同步通常就能恢复；' +
      '只有在反复出现时，才需要检查令牌是否勾选了「projects」权限。';
  }

  // ⚠️ Gitee 对「同一时刻大量并发读」非常敏感：实测 43 个分片全并发打出去，
  // 会被成片拒绝（只读回 ~14 片），触发安全闸「29/43 个分片没读到」。
  // 内核 readShardedWith 已把并发降到 4，这里在 getFile 这一层再压一道闸门，
  // 把同一时刻在飞的读请求限到 3 —— 这是针对 Gitee 的双保险，
  // 且不碰共享内核、不会影响 GitHub 后端。
  const GITEE_READ_CONCURRENCY = 5;
  let _giteeSlots = GITEE_READ_CONCURRENCY;
  const _giteeWaiters = [];
  function _giteeAcquireSlot() {
    return new Promise(function (resolve) {
      if (_giteeSlots > 0) { _giteeSlots--; resolve(); }
      else _giteeWaiters.push(resolve);
    });
  }
  function _giteeReleaseSlot() {
    if (_giteeWaiters.length) _giteeWaiters.shift()();
    else _giteeSlots++;
  }
  async function _giteeReadSlot(name) {
    await _giteeAcquireSlot();
    try { return await readContents(name); }
    finally { _giteeReleaseSlot(); }
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
    getFile: function (name) { return _giteeReadSlot(name); },
    // ⚠️ 与 Gist 最大的差异：没有批量写。并发 PUT，逐个取 sha。
    //    分片数通常只有 1~5 片，并发不会有压力。
    putFiles: async function (map) {
      const names = Object.keys(map);
      // meta 是必写的（内核每次都会把它放进 map），它决定了「每片的归属与时间戳」。
      // 先单独把 meta 的 sha 取到手，能把它从下面的 getShaViaRead 里摘出去 ——
      // 否则 putFiles 内部又会为 meta 发一次 GET，而它刚刚在 writeShardedWith 里
      // 才被读过一次，纯属重复往返（实测这一下就多花一个 RTT）。
      // ★★ 两阶段提交（2026-09-16 孤儿 meta 事故的根修）★★
      // 旧实现：片 + meta 一起 Promise.all 并发写。Gitee 的 contents 每个文件是
      // 独立 commit，无法原子批量 —— 任何一片失败会让 Promise.all reject，
      // 但「已经在飞的 meta PUT 无法取消」，它仍会写成功。云端于是留下：
      //   「新 meta（引用 N 片）+ 部分或全部片不存在」的孤儿状态。
      // 之后每次读取都因「meta 引用的片缺失」被安全闸拦下，永远 N/N 读不到，
      // 且普通重试永远修不好（meta 已是新的，脏片判定认为没东西可写）。
      // 两阶段后：先写片、全部成功才写 meta —— 片失败则 meta 不动，
      // 云端保持旧的一致状态，重试即可自愈。
      const metaInMap = map[Core.META_FILENAME] !== undefined;
      const dataNames = metaInMap
        ? names.filter(function (n) { return n !== Core.META_FILENAME; })
        : names;

      // ---- 第一阶段：写数据片 ----
      const tasks = dataNames.map(async function (name) {
        // 最多 3 次：① 正常一次；② 重新取 sha 重试（远端被别的设备改过）；③ 兜底
        for (let attempt = 0; attempt < 3; attempt++) {
          let sha = null;
          try {
            sha = await getShaViaRead(name);
          } catch (e) {
            // 分支名错误会被 getSha 重置掉；重来一次会用新探测到的分支
            if (attempt < 2) { await sleep(600); continue; }
            throw e;
          }
          try {
            await writeContents(name, map[name], sha);
            return name;
          } catch (e) {
            const m = e.message || '';
            // 区分两类失败，重试姿势完全不同：
            //  A.「已被其它设备改动 / 已存在」——绕过缓存重新取 sha。
            //  B. 分支名不正确 —— 下一轮 ensureRepo/healBranch 会自愈，同样先清缓存。
            if (attempt < 2 && (/已被其它设备改动/.test(m) || /已存在/.test(m) || /分支名不正确/.test(m))) {
              fileCache.delete(name);
              shaCache.delete(name);
              resetRepoProbe();
              await sleep(700 * (attempt + 1));
              continue;
            }
            throw e;
          }
        }
        return null;
      });
      const done = await Promise.all(tasks);
      const okData = done.filter(Boolean);
      if (okData.length !== dataNames.length) {
        throw new Error('分片写入未全部完成（成功 ' + okData.length + ' / ' + dataNames.length +
          '）。已中止且云端索引未改动 —— 云端仍是旧的一致状态，直接重试即可。');
      }

      // ---- 第二阶段：片全部成功后，单独写 meta ----
      if (metaInMap) {
        let mSha = null;
        try { mSha = await getShaViaRead(Core.META_FILENAME); } catch (e) { mSha = null; }
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await writeContents(Core.META_FILENAME, map[Core.META_FILENAME], mSha);
            break;
          } catch (e) {
            const m = e.message || '';
            if (attempt < 2 && (/已被其它设备改动/.test(m) || /已存在/.test(m))) {
              fileCache.delete(Core.META_FILENAME);
              shaCache.delete(Core.META_FILENAME);
              try { mSha = await getShaViaRead(Core.META_FILENAME); } catch (e2) { mSha = null; }
              await sleep(700 * (attempt + 1));
              continue;
            }
            throw e;
          }
        }
      }
      return names;
    },
    // ★ 串行删除（2026-09-16 晚「4 个旧文件未删除」的根修）：
    //   Gitee contents API 的每次删除 = 同分支上的一次提交；一批 4 个并行打过去
    //   （Promise.all 8 个并发请求）会互相踩 —— 分支头快进冲突/触发限流，
    //   实测整批一起失败，且错误被逐文件吞掉，最终复核只剩「N 个未删除」。
    //   改为逐个删：单文件失败退避 600ms 重试一次，文件间留 300ms 间隔。
    deleteFiles: async function (names) {
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const sha = await getSha(name);
            if (!sha) break;                  // 文件本来就不在，视为已删
            await deleteContents(name, sha);
            break;                            // 删成功，进入下一个文件
          } catch (e) {
            // 单个文件删不掉不该让整次同步失败（旧片残留只影响体积，不影响正确性）
            console.warn('[Gitee] 删除 ' + name + ' 失败' + (attempt ? '（重试后仍失败）' : '') + ':', e && e.message);
            if (attempt === 0) await sleep(600);
          }
        }
        if (i < names.length - 1) await sleep(300);   // 文件间留间隔，别贴着配额上限跑
      }
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
    // 立刻反馈「开始了」：上传要跑几秒到几十秒，没有这个提示用户会以为点了没反应
    Core.progShow && Core.progShow('running', '正在上传到 Gitee…', '正在检查仓库、比对远端分片，稍等片刻。');
    Core.progBusy && Core.progBusy(true);
    resetRepoProbe();                      // 新一轮同步：仓库/分支探测缓存作废
    clearFileCache();
    resetHealBudget();                     // 新一轮同步：自愈预算恢复
    try {
      await ensureRepo();
      let cloudMeta = await readShardedMetaSafe();
      let cloudHas = false;
      if (cloudMeta && cloudMeta.shards) {
        cloudHas = !!(cloudMeta.shards && Object.keys(cloudMeta.shards).length);
      }
      // ★ 「只剩空壳 meta」自动识别（2026-09-16 晚线上：用户在 Gitee 手动清空仓库后，
      //   meta 残留、分片全已删除，于是每次上传都被判为「云端有数据」→ 弹窗 → 选合并
      //   → 去读早已不存在的分片 → 报「接口返回空结果」，用户怎么点都出不来）。
      //   这里用 1 个列目录请求判断：meta 引用的分片若一个都不存在，就认定云端实际为空，
      //   不弹窗、不走合并，直接按全新仓库全量重建 —— 这正是用户想要的「清空后重建」。
      if (cloudHas) {
        try {
          const filesNow = await listCloudFiles();
          const refSids = Object.keys(cloudMeta.shards || {});
          if (filesNow) {
            const present = refSids.filter(function (sid) {
              return filesNow.indexOf(Core.shardFile(sid)) >= 0;
            });
            if (present.length === 0) {
              console.warn('[Gitee] meta 引用的 ' + refSids.length +
                ' 个分片在云端全部不存在 —— 判定为「残留空壳索引」，按全新仓库全量重建');
              cloudMeta = null;
              cloudHas = false;
            }
          }
        } catch (e) { /* 列目录失败不改判：保守当云端仍有数据 */ }
      }
      let mode = 'overwrite';
      if (cloudHas) {
        const choice = await Core.showChoice('上传到云端',
          '云端已经存有数据。\n「合并」保留两边较新的数据，不会丢任何一边；\n「覆盖云端」用【本机数据】整体替换云端。',
          '合并到云端', '覆盖云端');
        if (choice === 'cancel') {
          Core.progShow && Core.progShow('running', '已取消上传', '云端数据未改动。');
          Core.progBusy && Core.progBusy(false);
          return;
        }
        mode = choice;
      }
      let localData;
      if (mode === 'merge') {
        // 合并要读全量远端数据（每片各一个请求）。
        // 若刚刚为「云端有没有数据」读过 meta，这里直接复用它 ——
        // 否则 giteeRead 会再把 meta 读一遍（虽然命中缓存不发请求，但代码路径上
        // 埋了个「缓存一旦失效就多一个 RTT」的隐患）。
        const remote = await giteeRead(cloudMeta);
        localData = Core.buildMergedUpload(remote || { data: {} });
      } else {
        localData = Core.collectLocalData();
        // ★ 覆盖前核对孤儿索引：meta 引用的片是否真实存在于云端目录。
        //   存在孤儿时给用户两条路：清空重建（最干净）或直接覆盖（最快）。
        try {
          const filesNow = await listCloudFiles();
          const refSids = Object.keys((cloudMeta && cloudMeta.shards) || {});
          if (filesNow && refSids.length) {
            const missing = refSids.filter(function (sid) {
              return filesNow.indexOf(Core.shardFile(sid)) < 0;
            });
            if (missing.length) {
              const how = await Core.showChoice('检测到云端索引损坏',
                '云端索引引用了 ' + missing.length + ' 个实际不存在的分片文件' +
                '（' + missing.slice(0, 3).join('、') + (missing.length > 3 ? ' 等' : '') + '）。\n' +
                '这是之前某次写入中途失败留下的孤儿索引，普通重试无法修复。\n\n' +
                '【清空云端并重建】先删除云端全部同步数据，再用本机完整数据重建 —— 最干净，约 1~2 分钟；\n' +
                '【直接覆盖】只重写有效分片，几秒完成，但会残留旧的垃圾文件（不影响使用）。',
                '清空云端并重建', '直接覆盖');
              if (how === 'cancel') {
                Core.progShow && Core.progShow('running', '已取消', '云端数据未改动。');
                Core.progBusy && Core.progBusy(false);
                return;
              }
              if (how === 'merge') {   // 主按钮（绿色）= 清空重建
                const wipeN = filesNow.filter(function (n) { return /^efficiency-hub-/.test(n); }).length;
                Core.progShow && Core.progShow('running', '正在清空云端…',
                  '逐个删除云端旧文件（共 ' + wipeN + ' 个），每个删除都是一次提交，需要一点时间，请稍候。');
                const w = await wipeCloudFiles();
                if (w.remain.length) {
                  throw new Error('有 ' + w.remain.length + ' 个旧文件未能删除（' +
                    w.remain.slice(0, 2).join('、') + ' 等）。可能是配额限制，请等 1 分钟后重新执行覆盖。');
                }
                cloudMeta = null;   // 云端已清空：后续按「全新仓库」处理
              }
            }
          }
        } catch (e) {
          if (/未能删除/.test(e.message || '')) throw e;
          /* 列目录失败不阻断覆盖：覆盖本身会全量重写有效片 */
        }
      }
      let info;
      try {
        Core.progShow && Core.progShow('running', '正在写入分片…', '只重传改动过的数据片。');
        // 「覆盖云端」必须 force 全量重写：脏片判定按「本机键时间戳 vs meta 记录的
        // 片时间戳」——如果云端 meta 是最近写入的（哪怕它引用的片已丢失，即孤儿
        // meta），本机键的 ts 必然更旧，所有片都会被判「不脏」而跳过，覆盖就形同
        // 虚设。force=true 让每一片都真实重写，这才是「覆盖」的语义。
        info = await Core.writeShardedWith(giteeIO, localData, mode === 'overwrite');
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
      Core.notifyFail('上传 Gitee 失败', (e.message || String(e)) + healHint() + '\n本机数据未改动。');
    }
  }

  // 读全量远端数据。
  // metaHint：调用方已经拿到 meta 时传进来，避免再读一次（Gitee 每读一个文件
  // 就是一个 HTTP 请求，一次上传总共也就这几个来回，能省的都要省）。
  // 列出云端根目录的文件名清单（1 个请求）。
  // 用途：读取分片失败时，核对「meta 引用的片」是否真的存在于云端 ——
  // 这能把「分支名错 / 瞬时空结果」（目录也列不出来）与「孤儿 meta」
  //（目录列得出来、但 meta 引用的片不在）区分开，给出准确的恢复指引。
  async function listCloudFiles() {
    try {
      const raw = await req('GET', '/repos/' + OWNER + '/' + REPO + '/contents/',
        { query: { ref: BRANCH }, what: '列出云端文件清单' });
      if (!Array.isArray(raw)) return null;
      return raw.map(function (f) { return f.name || ''; }).filter(Boolean);
    } catch (e) {
      return null;
    }
  }

  // 清空云端全部「本应用的同步文件」（efficiency-hub- 前缀），仓库里其他文件一律不碰。
  // 用途：孤儿索引 / 彻底重置。删除后由调用方用本机数据全量重建。
  // 限速：逐个串行删（见 deleteFiles），文件间 300ms —— 几十个文件就是近百个请求，
  // 必须给 Gitee 的分钟配额留喘息。复核发现残留自动补删（最多两轮）。
  async function wipeCloudFiles() {
    const files = await listCloudFiles();
    if (!files) throw new Error('无法列出云端文件清单，已取消删除（云端未改动）。');
    const mine = files.filter(function (n) { return /^efficiency-hub-/.test(n); });
    if (!mine.length) return { total: 0, deleted: 0, remain: [] };
    await giteeIO.deleteFiles(mine);
    // 复核：再列一次目录，确认删干净；仍有残留（多为配额原因）→ 等 2 秒补一轮，最多补两轮
    let left = await listCloudFiles();
    let remain = (left || []).filter(function (n) { return /^efficiency-hub-/.test(n); });
    for (let pass = 0; pass < 2 && remain.length; pass++) {
      await sleep(2000);
      await giteeIO.deleteFiles(remain);
      left = await listCloudFiles();
      remain = (left || []).filter(function (n) { return /^efficiency-hub-/.test(n); });
    }
    return { total: mine.length, deleted: mine.length - remain.length, remain: remain };
  }

  async function giteeRead(metaHint) {
    await ensureRepo();
    const meta = metaHint || await readShardedMetaSafe();
    if (meta && meta.shards && Object.keys(meta.shards).length) {
      // ★ 空壳索引自愈（与 giteeUpload 同理）：仓库被手动清空后 meta 仍残留时，
      //   引用的分片全部不存在，直接当作「云端没有数据」返回，而不是抛一堆
      //   「接口返回空结果」让用户以为是自己网络/令牌的问题。
      try {
        const filesNow = await listCloudFiles();
        if (filesNow) {
          const refSids = Object.keys(meta.shards || {});
          const present = refSids.filter(function (sid) {
            return filesNow.indexOf(Core.shardFile(sid)) >= 0;
          });
          if (!present.length && filesNow.indexOf(Core.META_FILENAME) >= 0) {
            console.warn('[Gitee] 云端只剩空壳索引（' + refSids.length +
              ' 个被引用的分片全部不存在）—— 视为云端无数据');
            return { data: {}, updatedAt: 0, emptyShell: true };
          }
        }
      } catch (e) { /* 列目录失败则按原逻辑继续读，让下面的错误处理兜底 */ }
      const r = await Core.readShardedWith(giteeIO, meta);
      // ★ 孤儿 meta 检测：有片读不到时，花 1 个请求列目录核对。
      //   若 meta 引用的片在目录里根本不存在 → 云端元数据已损坏（上次写入
      //   中途失败的遗迹），重试永远修不好，必须用本机数据覆盖重建。
      //   这里直接把结论和恢复动作写进错误信息，用户不用再来回猜。
      if (r && r.shardFail > 0) {
        const files = await listCloudFiles();
        if (files && files.length >= 0) {
          const missing = (r.shardFailIds || []).filter(function (sid) {
            return files.indexOf(Core.shardFile(sid)) < 0;
          });
          if (missing.length) {
            r.shardErrors = (r.shardErrors || []);
            r.shardErrors.unshift({
              sid: missing[0],
              msg: '【云端元数据已损坏】meta 引用了 ' + missing.length + ' 个实际不存在的分片（' +
                missing.slice(0, 3).join('、') + (missing.length > 3 ? ' 等' : '') +
                '）—— 这是之前某次写入中途失败留下的「孤儿索引」。普通重试无法修复。' +
                '解决方法：点「上传到云端」→ 选「覆盖云端」，用本机完整数据一次性重建。',
              status: null
            });
            r.orphanShards = missing;
          }
        }
      }
      return r;
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
    Core.progShow && Core.progShow('running', '正在检查 Gitee 上的数据…', '先读一份很小的索引文件。');
    Core.progBusy && Core.progBusy(true);
    resetRepoProbe();
    clearFileCache();
    resetHealBudget();                     // 新一轮同步：自愈预算恢复
    try {
      await ensureRepo();
      // ★ 顺序是本函数的核心：读索引 → 弹窗定模式 → 再读数据。
      //   绝不能把弹窗放在「读完全部分片」之后 —— 分片里是本机全部业务数据
      //   （实测 118 项、压缩后数百 KB），国内读 Gitee 要好几秒。旧的进度文案是
      //   「正在读取远端分片并合并」，「正在合并」四个字让人以为模式早定好了、
      //   根本不会弹，于是用户判定「下载没有弹窗」（而上传只读 1 个索引文件就弹，
      //   这就是「上传有、下载没有」的全部原因）。
      //   改到这里还有两个附带好处：① 弹窗耗时与数据量彻底无关；
      //   ② 选「取消」时一个分片都不读，省流量。
      const meta = await readShardedMetaSafe();
      let hasShards = !!(meta && meta.shards && Object.keys(meta.shards).length);
      // ★ 空壳索引（仓库被手动清空后 meta 残留）在这里也要先干掉：
      //   否则 hasShards 为真 → 直接判定「云端有数据」→ 弹窗 → 读分片全失败。
      if (hasShards) {
        try {
          const filesNow = await listCloudFiles();
          if (filesNow) {
            const refSids = Object.keys(meta.shards || {});
            const present = refSids.filter(function (sid) {
              return filesNow.indexOf(Core.shardFile(sid)) >= 0;
            });
            if (!present.length) {
              console.warn('[Gitee] 云端只剩空壳索引 —— 视为云端无数据');
              hasShards = false;
            }
          }
        } catch (e) { /* 列目录失败不改判 */ }
      }
      let pre = null;
      if (!hasShards) {
        // 没有分片索引：可能是从 Gist 搬过来的旧单文件，也可能真的空。
        // 这时没有更省的办法，才读一次全量。
        pre = await giteeRead(hasShards ? meta : null);
      }
      const cloudHas = hasShards
        || !!(pre && pre.data && Object.keys(pre.data).length > 0);
      if (!cloudHas) {
        Core.progShow && Core.progShow('fail', 'Gitee 上还没有数据',
          '请先在一部设备上点「上传到云端」，再来这里下载。');
        Core.progBusy && Core.progBusy(false);
        return;
      }
      // 一律问，不再看「本机有没有数据」决定要不要问 —— 面板帮助文案承诺的
      // 就是「下载点完会让你选」，承诺了就该每次都问，否则「这次怎么没弹」
      // 又会变成新的困惑来源。本机确实没有可同步数据时两种选项结果相同，
      // 在文案里说明，把判断权留给用户。
      const localHas = Core.getLocalKeys().length > 0;
      const choice = await Core.showChoice('下载到本机',
        (localHas
          ? '本机已经存有数据。\n'
          : '本机暂时没有可同步的数据，下面两种方式结果相同。\n') +
        '「合并」保留两边较新的数据，不会丢任何一边；\n「覆盖本机」用【云端数据】整体替换本机。',
        '合并到本机', '覆盖本机');
      let mode = 'overwrite';
      if (choice === 'cancel') {
        Core.progShow && Core.progShow('running', '已取消下载', '本机数据未改动。');
        Core.progBusy && Core.progBusy(false);
        return;
      }
      mode = choice;
      // 模式定了才去读数据：进度文案也如实反映「现在在读」而不是"正在合并"。
      Core.progShow && Core.progShow('running', '正在读取 Gitee 上的数据…',
        mode === 'merge' ? '按「合并到本机」处理：两边逐项取较新的。'
                         : '按「覆盖本机」处理：用云端数据整体替换本机。');
      const remote = hasShards ? await giteeRead(meta) : pre;
      // ⚠️ 顺序调整后必须补的安全闸：索引里记着有分片、实际读不回来时，
      //    若不拦就轮到下面执行「覆盖本机」——而 applyCloudToLocal 会先清光本机
      //    可同步键，等于把本机数据清空。这里一律中止，本机数据保持不动。
      //    ⚠️ 判据不能只看「一片都没读到」：**少读了一片**同样危险 —— 合并/覆盖之后
      //    那一片的键在本机就消失了，用户不会收到任何提示。索引列了几片就必须读回几片。
      if (!remote || !remote.data || !Object.keys(remote.data).length || remote.shardFail > 0) {
        Core.progShow && Core.progShow('fail', '云端数据读取失败',
          Core.shardIncompleteMsg(remote) + '\n已中止，本机数据未改动。');
        Core.progBusy && Core.progBusy(false);
        return;
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
      Core.notifyFail('从 Gitee 下载失败', (e.message || String(e)) + healHint() + '\n本机数据未改动。');
    }
  }

  // 双向同步（Gitee）：与 GitHub 侧同语义 —— 读远端 → 合并进本机 → 合并结果写回远端。
  // 只做合并、永不覆盖，所以不需要弹窗让用户选模式。
  // opts.silent：自动同步走这条通道（不弹通知卡），与 GitHub 侧保持一致。
  // 返回的摘要字段也与 doSyncBoth 完全一致 —— 否则换后端之后，同一条「自动同步记录」
  // 会显示成两种样子，用户会以为换个后端就改变了同步行为。
  async function giteeSyncBoth(opts) {
    const silent = !!(opts && opts.silent);
    if (!TOKEN) { if (!silent) showConfigModal(); return { error: '尚未配置 Gitee 令牌' }; }
    const t0 = Date.now();
    Core.progShow && Core.progShow('running', '正在双向同步（Gitee）…',
      '先读 Gitee 上的数据，与两端合并后同时更新本机与云端。两端都只会变全，不会丢数据。');
    Core.progBusy && Core.progBusy(true);
    resetRepoProbe();
    clearFileCache();
    resetHealBudget();                   // 新一轮同步：自愈预算恢复
    rateLimitUntil = 0;                  // 新一轮同步：清掉上一轮的配额冷却状态
    try {
      await ensureRepo();
      const readFn = function () { return giteeRead(); };
      const writeFn = function (data) { return Core.writeShardedWith(giteeIO, data); };
      let r;
      try {
        r = await Core.runBothIO(readFn, writeFn);
      } catch (e) {
        // 与上传同款兜底：仓库 / 分支刚建好时首次写入可能报「不存在」，重建后重试一次
        if (!/不存在/.test(e.message || '')) throw e;
        await ensureRepo();
        r = await Core.runBothIO(readFn, writeFn);
      }
      Core.reloadActiveIframe();
      if (typeof buildCards === 'function') buildCards();
      markSynced('both', Core.getLocalKeys());
      const st = r.localStats;
      if (!silent) {
        Core.notifyOK('已完成双向同步（Gitee）',
        (r.hasRemote
          ? '云端 → 本机：新增 ' + st.added + ' 项，更新 ' + st.updated + ' 项，保留本机 ' + st.kept + ' 项' +
            (st.merged ? '，另有 ' + st.merged + ' 项按内容合并' : '') + '。\n'
          : 'Gitee 上原本没有数据，本次已把本机的数据存过去。\n') +
        '本机 → 云端：已写入 ' + r.nItem + ' 项，约 ' + Math.round(r.info.wroteBytes / 1024) + 'KB（已压缩）。\n' +
        '两端现在一致，谁都没有被覆盖。');
      }
      return {
        mode: 'both', at: Date.now(), ms: Date.now() - t0, hasRemote: r.hasRemote,
        local: st
          ? { added: st.added, updated: st.updated, merged: st.merged, kept: st.kept, keys: st.keys || [] }
          : { added: 0, updated: 0, merged: 0, kept: 0, keys: [] },
        cloud: {
          added: r.cloudAddedKeys || [], wrote: r.nItem,
          bytes: (r.info && r.info.wroteBytes) || 0,
          shards: r.info ? r.info.wroteShards : 0,
          totalShards: r.info ? r.info.totalShards : 0
        }
      };
    } catch (e) {
      console.warn('[Gitee] 双向同步失败:', e.message);
      if (!silent) {
        // 配额用尽导致的失败，给一条更明确、可执行的提示。
        // 否则用户只会看到「N 个分片没读到」，误以为是数据损坏。
        const quotaHit = (e && e.status === 429) || quotaCoolingMs() > 0;
        const tip = quotaHit
          ? '\n\n【原因】Gitee 接口调用次数达到本分钟上限（限流）。' +
            '这是临时性的，等约 1 分钟后重试即可，与数据本身无关。' +
            '\n【已优化】新版会把数据打包成少数几个分片（而非按模块切成几十片），' +
            '使每次同步的请求数下降一个数量级，正常不会再触发限流。'
          : '';
        Core.notifyFail('双向同步（Gitee）失败',
          (e.message || String(e)) + tip + healHint() + '\n本机与 Gitee 上的数据都未曾被覆盖。');
      }
      return { error: (e.message || String(e)) + healHint() };
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
    mask.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:2147483000;display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:16px 0;box-sizing:border-box;';
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
      resetRepoProbe();                    // 配置变了，旧探测结果必须作废
      clearFileCache();
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
    download: giteeDownload,
    both: giteeSyncBoth
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
      resetRepoProbe();
      clearFileCache();
      try {
        localStorage.setItem('gitee_token', TOKEN);
        localStorage.setItem('gitee_repo', REPO);
        if (OWNER) localStorage.setItem('gitee_owner', OWNER);
      } catch (e) {}
    },
    build: '2026-09-16-heal',
    io: giteeIO,
    read: giteeRead,
    upload: giteeUpload,
    download: giteeDownload,
    both: giteeSyncBoth,
    ensureRepo: ensureRepo
  };
})();
