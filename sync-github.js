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
 *
 * v9（2026-10-13）按需求精简：
 * - 移除 GitHub 后端（仅保留 Gitee；本文件仍是核心 CloudSyncCore，文件名保留）。
 * - 移除「双向同步」按钮与整套自动同步（变动触发 / 定时检查 / 保存快车道 / hide 兜底）。
 *   同步改为纯手动：上传（合并/覆盖）+ 下载（合并/覆盖）。
 * - 新增 SYNC_TRANSIENT_KEYS：计时器 / 界面瞬时键写入不参与「该刷哪些工具页」判定与留痕。
 *
 * v8（2026-09-16）新增「双向同步」（已于 v9 移除）：
 * - 一次点击 = 先读云端、把云端合并进本机，再把合并结果写回云端。
 *   两端最终都等于「本机 ∪ 云端，逐键取较新」，谁都不会被覆盖。
 * - 「上传 / 下载」两个按钮保留原样：点开仍会让你选「合并 / 覆盖」。
 *   因为「覆盖」是唯一会整端替换的操作，不适合做成默认值。
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
    // Gitee 后端：令牌与仓库坐标绝不能上传 —— 令牌上传等于把仓库钥匙一起公开了，
    // 而且换设备时旧令牌会覆盖新令牌，直接把人锁在门外。
    'gitee_token', 'gitee_owner', 'gitee_repo', 'gitee_last_sync', 'gitee_branch',
    'cloud_backend',              // 本机选的后端，不必同步
    'hub_lastModule',             // 上次打开的工具，不强制同步
    // ⚠️ 本地「备份/快照仓」不是业务数据：体积巨大（朝暮计这一项单独就 600KB+），
    //    把它传上云会让 Gist 直接翻倍，是下载超时/失败的头号元凶。
    'chaomuji_backups_v1',        // 朝暮计 v27 内置快照仓
    // 备份中心与同步模块自产的元数据：属于「本机记录」，跨设备没有意义，传上去还会互相覆盖。
    '__hub_meta_v1__',            // 各键最后写入时间（合并判新旧用，必须本机各自维护）
    '__hub_last_snap_v1__',       // 每日自动快照标记
    '__hub_activity_v1__',        // 最近一次备份/同步记录
    'sync_timestamps',            // 上次同步时云端各键的时间戳
    // 自动同步的「记录」属于各设备自己的状态：同步过去会让两端互相覆盖对方的
    // 上次同步时间与日志（谁最后同步谁覆盖），必须排除。
    'ehub_autosync_v1',
    // 工具页（iframe）写入的键 → 时间戳，由本模块的 storage 钩子维护（见 localKeyTs 上方注释）。
    // 同样是「本机记录」，跨设备没有意义，传上去会让两端的判新旧时间互相污染。
    'sync_key_ts_v1',
    // ★ 覆盖世代号（2026-10-12）：本机已知的最近一次「覆盖云端」世代 + 本机标识 + 世代冲突快照。
    //   同属「本机记录」——同步过去会让两端互相覆盖对方的世代认知，必须排除。
    'sync_epoch_seen_v1',
    'sync_device_tag_v1',
    '__epoch_conflict_backup_v1__',
    /* ---- 2026-09-23 补排：朝暮计与导航页的「本机记录」----------------------
       判据只有一条 —— **这个键同步到另一台设备之后，语义还成立吗？**
       不成立就必须排除：它不是数据，是「这台机器刚才做了什么」的记录。 */
    // 提醒去重日志：「已响过的实例，避免重复弹」。同步过去会让另一台设备认为
    // 这条提醒已经弹过 ⇒ **跨设备吞提醒**（表现为「手机上根本没提醒」）。
    'chaomuji_web_v27_remindlog',
    // 每日例行提醒：「今天已经提醒过了」（7 天滚动）。同上，会吞掉当天的提醒。
    'chaomuji_web_v27_dailylog',
    // 本机实测出的 localStorage 总配额（7 天内有效）。桌面实测可能是 10MB，
    // 传到手机上（实际 5MB）会让「背景图可用额度」按错误的天花板计算 ⇒ 写到一半写不进去。
    'chaomuji_web_v27_lsquota',
    // 农历派生缓存：完全可由日期算出来，同步只是白占空间、白占一次网络往返。
    'chaomuji_web_v27_lunarcache',
    // 导航页：版本号拉取缓存 + 前端补丁标记（「这版补丁跑过了没」，必须各机器各自判定，
    // 否则新设备会以为自己已经迁移过而跳过补丁）。
    'hub_versions_cache_v1',
    'hub_patch',
    /* ★ 2026-10-13 实测补排（直读 Gitee 云端）：同源下**其它应用**共用一个 localStorage，
       它们把自己的同步配置（内含**明文令牌**）存在这些键里，被判据「全量 localStorage 减排除
       清单」原样收上了云 —— 云端实测躺着三把：cloud_sync_config_v1（ghp_…）、
       gesp_sync_config_v1（ghp_…）、invs_sync_cfg_v1（Gitee 令牌）。
       点名之外，isExcludedKey 里还有一条「按值凭据兜底」防以后再犯。 */
    'cloud_sync_config_v1', 'cloud_sync_time_v1',
    'gesp_sync_config_v1', 'gesp_sync_device_v1',
    'invs_sync_cfg_v1',
    // 纯技术/垃圾键（实测都已在云端）：同步脏标记、上次页签、SDK 埋点残留
    'sync_dirty', 'lastTab', 'ARGUS_XSS_V3'
  ]);

  // ============ 背景图片不同步 ============
  // 背景图是 base64 大图（动辄几百 KB～几 MB），同步又慢又容易撑爆 Gist（1MB 截断）。
  // 两类排除：① 已知背景键名前缀；② 值本身就是 data:image 的键（通用兜底）。
  const EXCLUDE_PREFIXES = [
    'chaomuji_web_v27_bg',        // 朝暮计·页面背景（含 data:image 大图）
    'chaomuji_web_v27_cardbg',    // 朝暮计·卡片背景
    'chaomuji_web_v27_hcardbg',   // 朝暮计·习惯卡背景
    'zmv_bg_',                    // 朝暮计·背景质量等设置
    '__hub_',                     // 备份中心全部内部键
    '__tea_sdk_',                 // 页面埋点 SDK 留下的垃圾键
    '__BEACON_'                   // 腾讯埋点 SDK 的 __BEACON_* 日志/会话键（实测 11 个被误同步）
  ];
  const BIG_IMAGE_MIN = 30 * 1024;   // 超过 30KB 的内嵌图片才视为背景资源

  // ============ 按值兜底：值里出现凭据形态 ⇒ 一律不上云 ============
  // 为什么必须有：判据是「全量 localStorage 减排除清单」，而同源下**任何**应用（含以后新加的）
  // 都可能把令牌写进自己的配置键 —— 点名排除永远追不上新键。实测就漏过三把明文令牌。
  // 宁可少同步一个键，也不上云一把钥匙。（只认明确的凭据形态，不认裸 32 位 hex ——
  // 后者会在 URL/id 里大面积误伤，实测 diary_app_data / investResBoard_v1 就是这种误报。）
  const SECRET_VALUE_RE = /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|Bearer\s+[A-Za-z0-9_\-\.]{20,}|["']?(?:access_)?token["']?\s*[:=]\s*["'][^"']{16,}["']/i;
  const SECRET_SCAN_MAX = 64 * 1024;   // 只扫这个长度以内的值（足够覆盖配置类键，避免大 JSON 拖慢）
  function looksSecret(v) {
    if (typeof v !== 'string' || !v.length || v.length > SECRET_SCAN_MAX) return false;
    return SECRET_VALUE_RE.test(v);
  }

  function isExcludedKey(key, value) {
    if (EXCLUDE_KEYS.has(key)) return true;
    for (let i = 0; i < EXCLUDE_PREFIXES.length; i++) {
      if (key.indexOf(EXCLUDE_PREFIXES[i]) === 0) return true;
    }
    if (value && value.length > BIG_IMAGE_MIN && value.slice(0, 11) === 'data:image/') return true;
    if (looksSecret(value)) return true;      // ★ 含凭据的值一律不上云
    return false;
  }

  // ============ 工具：弹窗 ============
  function closeTopModal() {
    const m = document.querySelector('.sync-mask');
    if (m) m.remove();
  }

  // 通用确认弹窗：返回 Promise<boolean>
  function showConfirm(title, message, okText) {
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'sync-mask';
      mask.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:2147483000;display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:16px 0;box-sizing:border-box;';
      const modal = document.createElement('div');
      modal.style.cssText = 'background:white;border-radius:12px;padding:22px;max-width:440px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,.2);';
      modal.innerHTML = `
        <h3 style="margin:0 0 10px;font-size:18px">${title}</h3>
        <p style="margin:0 0 18px;color:#555;font-size:14px;line-height:1.6;white-space:pre-wrap">${message}</p>
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
    return showConfirm('提示', message).then(() => {});
  }

  // 三选一弹窗：合并 / 覆盖 / 取消（v4 新增，返回 'merge' | 'overwrite' | 'cancel'）
  function showChoice(title, message, mergeText, overwriteText) {
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'sync-mask';
      mask.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:2147483000;display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:16px 0;box-sizing:border-box;';
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
  //
  // ⚠️ 但 __hub_meta_v1__ 有一个结构性盲区，必须在这里补齐，否则「工具页的数据」
  //    会静默地既同步不出去、又被云端旧值覆盖：
  //
  //      来源                        setItem 覆写   storage 事件
  //      -------------------------- -------------- --------------
  //      导航页自身写入              能             不能（规范如此）
  //      iframe 内写入（工具页）     不能           能
  //
  //    backup-hub.js 覆写的是【导航页自己】的 localStorage.setItem，而所有工具页都跑在
  //    #toolContainer 的 iframe 里 —— 同源 iframe 是另一个 realm，那层覆写抓不到它的写入。
  //    于是 cpa_*、life-* 这类「由工具页写入」的键在 __hub_meta_v1__ 里没有记录，
  //    localKeyTs()[key] 取到 0，两处判定同时失效（两者都是静默的）：
  //      ① mergeCloudToLocal：lts=0 而 cts>0 →「云端较新」恒成立 → 用云端旧值覆盖本机新数据；
  //      ② writeShardedWith：maxTs=0，而首次写片时片级 ts 也记成 0 → maxTs > cloudTs 恒假
  //         → 该片永久跳过，数据永远上不了云端 —— 两端却都显示「同步成功」。
  //    实测（mock io）：数据已变仍返回 wroteShards=0 / skippedShards=1，
  //    双向同步第二轮云端与本机都停在旧值，而提示是「两端现在一致」。
  //
  //  storage 事件是唯一能感知「其它文档（含同源 iframe）写入」的通道，且只会在【其它】
  //  文档触发，所以这里不会与导航页自身的记录重复计数。记在独立的 sync_key_ts_v1 里，
  //  不去改 backup-hub 的键（那份是它的领地），读取时再与 __hub_meta_v1__ 取较新者。
  const KEY_TS_STORE = 'sync_key_ts_v1';
  let iframeKeyTsOn = false;

  function iframeKeyTs() {
    try { return JSON.parse(localStorage.getItem(KEY_TS_STORE) || '{}') || {}; } catch (e) { return {}; }
  }

  // 把「工具页写入的键」的时间并进一份已有的时间表（__hub_meta_v1__ 的副本）。
  // 取较新者：两边都记过同一键时，谁晚谁说了算 —— 这正是「最后写入时间」的语义。
  function mergeIframeKeyTs(m) {
    const t = iframeKeyTs();
    for (const k in t) {
      if (!Object.prototype.hasOwnProperty.call(t, k)) continue;
      if (!m[k] || t[k] > m[k]) m[k] = t[k];
    }
    return m;
  }

  function installIframeKeyTs() {
    if (iframeKeyTsOn) return;
    iframeKeyTsOn = true;
    try {
      window.addEventListener('storage', function (ev) {
        try {
          if (!ev || !ev.key) return;
          if (ev.storageArea && ev.storageArea !== localStorage) return;
          // 删除不记时间：合并是并集语义，删除本来就不会传播，记了反而把旧值标成"刚写过"。
          if (ev.newValue === null) return;
          if (isExcludedKey(ev.key, ev.newValue)) return;   // 令牌 / 大图等不参与同步
          const t = iframeKeyTs();
          t[ev.key] = Date.now();
          localStorage.setItem(KEY_TS_STORE, JSON.stringify(t));
        } catch (e) {}
      });
    } catch (e) {}
  }

  function localKeyTs() {
    let m = {};
    try { m = JSON.parse(localStorage.getItem('__hub_meta_v1__') || '{}') || {}; } catch (e) { return {}; }
    return mergeIframeKeyTs(m);
  }

  /* ============ 覆盖世代号（2026-10-12）============
     ★ 要解决什么（这是「跨平台同步还是数据丢失」的最后一个成因，已真机复现）：
       同步是**并集语义**（逐键/逐域取较新）。于是多设备下「覆盖」天然不成立 ——
         A 端点「上传 → 覆盖云端」⇒ 云端 = A 的完整快照；
         B 端下一次同步（双向 / 自动）读云端 → 合并 → 再把「合并结果」写回云端，
         B 独有的那份旧数据被**原样并了回来** ⇒ A 的覆盖被静默撤销。
     ★ 世代号怎么破这个局：
       ① 只有「覆盖」会推进它（writeShardedWith 的 opts.overwrite）；
       ② 云端 meta 里记 epoch = { n, at, by }，随每次同步一起读回本机；
       ③ 本机记住「已知的最近一次覆盖时刻」at（sync_epoch_seen_v1）；
       ④ 一旦发现更新的世代：先把「旧世代的本机键」快照一份，再按云端对齐
          （云端有的用云端值、云端没有的从本机移除），并保证它们**不再上传**。
       于是 B 端的旧数据再也上不去云端（覆盖生效），而 B 端**在覆盖之后**的新改动
       照常同步（那些键的写入时间 > at，不受闸门约束）。
     ★ 不做什么（有意为之，别顺手加）：
       · 闸门前不加「无世代号也照做」的分支：at=0 ⇒ 一切关闭 ⇒ 行为与本版之前完全一致。
       · 不把闸门加在「读云端 → 本机」那一侧的唯一判据上：判断必须落在
         buildMergedUpload（往云端写）这一侧，对端才不会被污染。
     ★ 两个「新/旧世代」判定的差异（有意，不是笔误）：
       · buildMergedUpload / mergeCloudToLocal 的时间戳比较：**无记录 ⇒ 视为本机较新**（保留本机，
         宁可多传不可静默少传）；
       · 世代闸门：**看云端有没有同名键** ——
         云端有 ⇒ 本机记录缺失或早于覆盖时按旧世代（不上传 / 对齐时用云端那份）；
         云端没有 ⇒ 本机独有，放行（上传）/ 保留（对齐时不删），与本机时间戳无关。
       ★ 2026-10-13 修正（Tom：「上传之后再下载，案例又没了」）：
         闸门原先写的是「无记录 ⇒ 一律按旧世代（不上传）」。这条在全量 localStorage 同步
         架构里是有害的 —— **工具页（iframe）写入的键天然没有时间戳记录**
         （__hub_meta_v1__ 被导航页覆写 setItem 记录，跨 realm 抓不到；sync_key_ts_v1 靠
         storage 事件补记，也需要导航页在场）。于是 cpa_* / life-* / accCase_v3_<项目>
         这类键在做过一次「覆盖云端」之后**永远上不了云**，且上传回执仍报「已合并上传」；
         更糟的是 alignToGeneration 会把它们当旧世代、在云端没有同名键时直接从本机删掉。
         判据改成「看云端有没有」之后：覆盖语义照样成立（防的是「旧数据把云端那次覆盖
         并回来」，而这只有在云端存在同名键时才谈得上），工具页写入的活数据不再被误伤。
       两处判定的方向仍不同，但都退到了「不丢用户数据」这一侧。 */

  const EPOCH_SEEN_KEY = 'sync_epoch_seen_v1';
  const DEVICE_TAG_KEY = 'sync_device_tag_v1';
  const EPOCH_SNAP_KEY = '__epoch_conflict_backup_v1__';
  const EPOCH_SNAP_MAX = 400 * 1024;   // 单次快照保存的内容上限（超出只留键名清单）

  // 本机标识：只为提示文案里说得清「是哪台设备覆盖的」，不参与任何判定。
  function deviceTag() {
    try {
      let t = localStorage.getItem(DEVICE_TAG_KEY);
      if (!t) {
        t = '设备' + Math.random().toString(36).slice(2, 6).toUpperCase();
        localStorage.setItem(DEVICE_TAG_KEY, t);
      }
      return t;
    } catch (e) { return '本机'; }
  }

  // 本机已知的最近一次「覆盖云端」世代 → { n, at }
  function epochSeen() {
    try {
      const o = JSON.parse(localStorage.getItem(EPOCH_SEEN_KEY) || 'null');
      if (o && typeof o === 'object') {
        return { n: parseInt(o.n, 10) || 0, at: parseInt(o.at, 10) || 0 };
      }
    } catch (e) {}
    return { n: 0, at: 0 };
  }

  // 只增不减：n 与 at 各自取较大者（两端时钟可能有偏差，谁大信谁）
  function setEpochSeen(n, at) {
    const cur = epochSeen();
    const nn = Math.max(cur.n || 0, parseInt(n, 10) || 0);
    const na = Math.max(cur.at || 0, parseInt(at, 10) || 0);
    if (nn === (cur.n || 0) && na === (cur.at || 0)) return false;
    try { localStorage.setItem(EPOCH_SEEN_KEY, JSON.stringify({ n: nn, at: na })); } catch (e) {}
    return true;
  }

  // 每次从云端读到世代号都调一次：并进本机已知值，返回「本次是否发现了更新的世代」。
  // ★ 调用顺序有意义 —— 必须在 mergeCloudToLocal / alignToGeneration 之前调，
  //   才拿得到 true（它们内部也会调，幂等，只会拿到 false）。
  function noteCloudEpoch(epoch) {
    if (!epoch || typeof epoch !== 'object') return false;
    const n = parseInt(epoch.n, 10) || 0;
    const at = parseInt(epoch.at, 10) || 0;
    if (!at) return false;
    const cur = epochSeen();
    const newer = n > (cur.n || 0) || at > (cur.at || 0);
    setEpochSeen(n, at);
    return newer;
  }

  // 只读判断：云端世代是否比本机已承认的更新（**不写**本机记录）。
  // 用途 —— 「上传·合并」这类会被拒绝的动作必须在**不记账**的前提下判断：
  //   一旦记了账，后续的「双向同步」就会以为世代已经承认过，不再对齐 ⇒
  //   本机旧数据又会被并回云端，本轮的修复等于没做。
  function epochNewerThanSeen(epoch) {
    if (!epoch || typeof epoch !== 'object') return false;
    const at = parseInt(epoch.at, 10) || 0;
    if (!at) return false;
    const cur = epochSeen();
    return (parseInt(epoch.n, 10) || 0) > (cur.n || 0) || at > (cur.at || 0);
  }

  // 世代闸门时刻：早于它的本机数据属于被覆盖掉的旧世代，不再上传。
  function overwriteGateAt() { return epochSeen().at || 0; }

  // 算出「旧世代的本机键」→ { key: 本机值 }；没有则返回 null。
  // ★ 必须在「把云端写回本机」之前调用 —— 那一写会刷新这些键的时间戳，
  //   之后再算就分不清「云端的内容」与「本机新改的」。
  // cloudKeys（可选）：本次云端读回来的键集。传了它，才能区分「无时间戳记录」的两种情形。
  // ★ 2026-10-13 修：旧实现把「无记录」一律当旧世代，于是 alignToGeneration 会把
  //   **本机独有的活数据**（工具页写入、时间戳抓不到的键）从本机删掉 —— 实测复现过。
  //   新口径：无记录 + 云端没有该键 ⇒ 不算旧世代（保留本机，不删）。
  function staleGenKeys(at, cloudKeys) {
    at = parseInt(at, 10) || 0;
    if (!at) return null;
    const meta = localKeyTs();
    const out = Object.create(null);
    let n = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      let v = null;
      try { v = localStorage.getItem(k); } catch (e) { continue; }
      if (v === null || isExcludedKey(k, v)) continue;
      // ★ 2026-10-13 修订：判据与 buildMergedUpload 的闸门保持一致 —— 只看「云端有没有同名键」。
      //   · 云端没有 ⇒ 本机独有 ⇒ 既不算旧世代、也不会被 alignToGeneration 删掉
      //     （旧口径会在这里把工具页写入的活数据从本机删除，实测复现过）。
      //   · 云端有 ⇒ 本机记录缺失或早于覆盖时算旧世代，对齐时用云端那份替换。
      if (!cloudKeys || !cloudKeys[k]) continue;
      const t = meta[k];
      if (!t || t <= at) { out[k] = v; n++; }
    }
    return n ? out : null;
  }

  // 云端键集 → {key:1}。给 staleGenKeys 判断「无时间戳记录的键，云端到底有没有」。
  function cloudKeySet(serverData) {
    const d = (serverData && serverData.data) || {};
    const s = Object.create(null);
    for (const k in d) {
      if (Object.prototype.hasOwnProperty.call(d, k)) s[k] = 1;
    }
    return s;
  }

  // 世代冲突快照：把「即将被云端取代的本机数据」留一份（不参与同步，最多留最近 3 次）。
  // 存在的意义：「以云端为准」会丢掉本机独有的旧数据 —— 快照让它是**可找回的**，而不是真丢。
  function snapshotStaleKeys(staleMap, at, epoch) {
    try {
      if (!staleMap) return false;
      const keys = Object.keys(staleMap);
      if (!keys.length) return false;
      let arr = [];
      try { arr = JSON.parse(localStorage.getItem(EPOCH_SNAP_KEY) || '[]') || []; } catch (e) { arr = []; }
      if (!Array.isArray(arr)) arr = [];
      const kept = {};
      let bytes = 0;
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const v = String(staleMap[k] == null ? '' : staleMap[k]);
        bytes += v.length + k.length;
        if (bytes > EPOCH_SNAP_MAX) continue;      // 体积护栏：超出的只记键名，不存内容
        kept[k] = v;
      }
      arr.unshift({
        at: Date.now(),
        epochAt: parseInt(at, 10) || 0,
        by: (epoch && epoch.by) || '',
        keys: keys,
        bytes: bytes,
        truncated: Object.keys(kept).length < keys.length,
        data: kept
      });
      if (arr.length > 3) arr = arr.slice(0, 3);
      localStorage.setItem(EPOCH_SNAP_KEY, JSON.stringify(arr));
      return true;
    } catch (e) { return false; }
  }

  /* 世代对齐：把「旧世代的本机键」以云端为准处理掉（先留快照）。
     云端有的键 → 用云端那份；云端没有的键 → 从本机移除。
     返回 { stale:[键名], applied, removed, snapshotted }；没有旧世代键时返回 null。
     ★ 本机在覆盖之后新写/新改的键不属于旧世代，不受影响，照常同步。 */
  function alignToGeneration(serverData, epoch, staleMap) {
    const at = parseInt((epoch && epoch.at) || 0, 10) || 0;
    if (!at) return null;
    const stale = staleMap || staleGenKeys(at, cloudKeySet(serverData));
    if (!stale) return null;
    const snapshotted = snapshotStaleKeys(stale, at, epoch);
    const sdata = (serverData && serverData.data) || {};
    let applied = 0, removed = 0;
    const names = Object.keys(stale);
    for (let i = 0; i < names.length; i++) {
      const k = names[i];
      const e = sdata[k];
      try {
        if (e && typeof e.value === 'string') { localStorage.setItem(k, e.value); applied++; }
        else { localStorage.removeItem(k); removed++; }
      } catch (err) {}
    }
    return { stale: names, applied: applied, removed: removed, snapshotted: snapshotted };
  }

  // 给用户看的世代提示（面板回执 / 自动同步日志共用）
  function epochNoticeText(epoch) {
    let when = '';
    try {
      when = new Date(Number((epoch && epoch.at) || 0)).toLocaleString('zh-CN',
        { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch (e) {}
    return '检测到另一台设备' + (epoch && epoch.by ? '（' + epoch.by + '）' : '') +
      '在 ' + (when || '不久前') + ' 执行了「覆盖云端」。\n' +
      '本机已按该世代处理：早于此时刻、且云端存有同名的本机数据不再上传并改用云端那份；' +
      '云端没有的本机独有数据一律保留（不会被删），此后新的改动照常同步。';
  }

  /* ============ 领域级合并（v5 新增）============
     只做「整键取较新」是不够的：两台设备各加一条记录、各写一个番茄钟，
     后同步的那台会把先同步的那台的改动整键覆盖掉。列表丢条目、计数被冲小，
     而且不会有任何报错 —— 这才是最伤的一类数据事故。

     按数据的「形状」分四类处理：
       ① 列表型 [ {id,...}, ... ]  → 按 id 并集；同一条两边都有时按字段取「信息更全的」
       ② 集合型 [ "a", "b" ]       → 取并集
       ③ 累计型 "5"（纯数字计数）  → 取较大值（计数只增不减，取 max 不会丢）
       ④ 其它                      → 整键取较新
     合并只在「两边都有且都合法」时介入；形状对不上就退回整键取较新，绝不猜。 */

  // 元素主键：优先 id，其次 key / name / date，最后用内容指纹兜底（保证同一元素两次计算得到同一个键）
  function itemIdOf(el) {
    if (el == null) return null;
    if (typeof el !== 'object') return String(el);
    const cand = el.id != null ? 'id:' + el.id
      : el.key != null ? 'key:' + el.key
      : el.name != null ? 'name:' + el.name
      : el.date != null ? 'date:' + el.date
      : null;
    if (cand) return cand;
    try { return 'fp:' + JSON.stringify(el); } catch (e) { return null; }
  }

  // 元素「信息量」：字段数 + 非空字段数。用于同一条记录两边都改过时判断谁更完整。
  function richnessOf(el) {
    if (el == null || typeof el !== 'object') return 0;
    let n = 0;
    for (const k in el) {
      n++;
      const v = el[k];
      if (v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)) n++;
    }
    return n;
  }

  // 列表合并：按 id 并集。同一条两边都有 → 以「本机」为底（本机是用户此刻正在看的），
  // 把本机没有的字段从云端补回来。冲突字段保留本机，非冲突字段两边都不丢。
  // 注意别用「字段数多的那份」当底：云端可能多了个备注字段，就把它过期的标题顶掉。
  function mergeList(localArr, cloudArr) {
    const out = [], idx = new Map();
    // 第一遍：本机全部进场，建立 id → 下标
    for (const el of localArr) {
      const id = itemIdOf(el);
      if (id == null) continue;
      if (!idx.has(id)) { idx.set(id, out.length); out.push(el); }
    }
    // 第二遍：云端条目逐个融合进来
    for (const el of cloudArr) {
      const id = itemIdOf(el);
      if (id == null) continue;
      const at = idx.get(id);
      if (at === undefined) {                       // 云端独有 → 直接补进来
        idx.set(id, out.length);
        out.push(el);
        continue;
      }
      const prev = out[at];                         // 本机版
      if (prev && typeof prev === 'object' && el && typeof el === 'object') {
        // 本机为底；本机缺失的字段用云端补。冲突字段保留本机（本机是用户此刻在改的）。
        const fused = Object.assign({}, prev);
        for (const k in el) {
          const v = fused[k];
          if (v === undefined || v === null || v === '') fused[k] = el[k];
        }
        out[at] = fused;
      }
      // 非对象元素：保留本机（同 id 视为同一条，本机为准）
    }
    return out;
  }

  // 集合并集：保持原顺序，去掉重复
  function mergeSet(localArr, cloudArr) {
    const out = [], seen = new Set();
    for (const el of localArr.concat(cloudArr)) {
      const k = JSON.stringify(el);
      if (seen.has(k)) continue;
      seen.add(k); out.push(el);
    }
    return out;
  }

  // 累计型：纯数字计数取 max。返回 null 表示「不是纯数字，别按累计处理」。
  function asCount(text) {
    if (text == null) return null;
    const t = String(text).trim();
    if (t === '' || !/^-?\d+(\.\d+)?$/.test(t)) return null;
    const n = Number(t);
    return isFinite(n) ? n : null;
  }

  /* ---- 统计表：对象内逐字段取 max（借自 toll2 第 3 层）----
     形如 { "2026-09-14": { seconds: 1200, questions: 30 }, ... } 的「日期 → 统计」表。
     两台设备各记各的，整键取较新会把先记的那台的时长冲小；
     逐字段取 max 才对 —— 时长、题量这类计数只增不减。 */
  function isPlainObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  function maxFields(a, b) {
    const out = Object.assign({}, a);
    for (const k in b) {
      const av = out[k], bv = b[k];
      const an = typeof av === 'number' ? av : asCount(av);
      const bn = typeof bv === 'number' ? bv : asCount(bv);
      if (an != null && bn != null) out[k] = bn > an ? bn : an;
      else if (av === undefined || av === null || av === '') out[k] = bv;
    }
    return out;
  }

  function looksLikeStatTable(obj) {
    if (!isPlainObj(obj)) return false;
    const keys = Object.keys(obj);
    if (!keys.length) return false;
    let checked = 0;
    for (const k of keys) {
      if (checked >= 3) break;
      const v = obj[k];
      if (!isPlainObj(v)) return false;
      const inner = Object.keys(v);
      if (!inner.length) return false;
      let hasNum = false;
      for (const ik of inner) {
        if (typeof v[ik] === 'number' || asCount(v[ik]) != null) { hasNum = true; break; }
      }
      if (!hasNum) return false;
      checked++;
    }
    return checked > 0;
  }

  function mergeStatTable(a, b) {
    if (!looksLikeStatTable(a) || !looksLikeStatTable(b)) return null;
    const out = {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const d of keys) {
      const av = a[d], bv = b[d];
      if (av === undefined) { out[d] = bv; continue; }
      if (bv === undefined) { out[d] = av; continue; }
      out[d] = isPlainObj(av) && isPlainObj(bv) ? maxFields(av, bv) : av;
    }
    return out;
  }

  // 统计表型键（值是「日期 → 统计对象」）
  const STAT_TABLE_KEYS = new Set([
    'cpaStudyLog', 'cpa_study_log', 'cpaStat', 'cpa_stat',
    'studyLog', 'studyStat', 'timeStat', 'time_stat'
  ]);

  // 列表型数据键（值本身是数组）
  const LIST_KEYS = new Set([
    'timeRecords', 'timeTodos', 'timeTimerHistory', 'timeCategoriesV2',
    'organizer_items_v2', 'organizer_categories_v2', 'organizer_locations_v2',
    'cpaStudyLog', 'cpaReviewQueue', 'cpaMistakes',
    'studyRecords', 'studyPaths', 'studySources',
    'chaomuji_todos', 'chaomuji_records', 'chaomuji_custom_cats'
  ]);
  // 集合型数据键（字符串数组，取并集）
  const SET_KEYS = new Set([
    'chaomuji_habit_list', 'chaomuji_cats', 'studyTags'
  ]);
  // 累计型数据键（纯数字，取较大值）。前缀匹配，故存基础名。
  const ACC_PREFIXES = [
    'pomo_count',            // 番茄钟计数
    'chaomuji_pomo_count',
    'study_minutes',         // 学习时长（分钟累计）
    'chaomuji_focus_min'     // 专注分钟累计
  ];

  function baseNameOf(key) {
    // 去掉日期后缀，便于前缀匹配：pomo_count_2026-09-14 → pomo_count
    const m = String(key).match(/^(.*?)_(\d{4}-\d{2}-\d{2})$/);
    return m ? m[1] : key;
  }
  function isAccKey(key) {
    const b = baseNameOf(key);
    for (const p of ACC_PREFIXES) {
      if (b === p || b.indexOf(p + '_') === 0) return true;
    }
    return false;
  }

  // 单键合并：返回 { value, how }。how 仅用于日志统计。
  function mergeKeyValue(key, localText, cloudText) {
    if (localText == null) return { value: cloudText, how: 'fill' };
    if (cloudText == null) return { value: localText, how: 'keep' };
    if (localText === cloudText) return { value: localText, how: 'same' };

    // ③ 累计型：取较大值（放在最前，避免纯数字被下面当普通键处理）
    if (isAccKey(key)) {
      const ln = asCount(localText), cn = asCount(cloudText);
      if (ln != null && cn != null) {
        if (cn > ln) return { value: String(cn), how: 'acc-cloud' };
        if (ln > cn) return { value: String(ln), how: 'acc-local' };
        return { value: String(ln), how: 'same' };
      }
    }

    // ③ 统计表：值形如 { "日期": { 数字字段... } } → 逐字段取 max
    if (STAT_TABLE_KEYS.has(key) || STAT_TABLE_KEYS.has(baseNameOf(key))) {
      let ta = null, tb = null;
      try { ta = JSON.parse(localText); } catch (e) { ta = null; }
      try { tb = JSON.parse(cloudText); } catch (e) { tb = null; }
      const table = mergeStatTable(ta, tb);
      if (table) {
        const tv = JSON.stringify(table);
        return { value: tv === localText ? localText : tv, how: tv === localText ? 'same' : 'merge-stat' };
      }
    }

    // ①② 列表型 / 集合型：先试解析成数组
    let la = null, ca = null;
    try { la = JSON.parse(localText); } catch (e) { la = null; }
    try { ca = JSON.parse(cloudText); } catch (e) { ca = null; }
    if (Array.isArray(la) && Array.isArray(ca)) {
      const wantSet = SET_KEYS.has(key) || SET_KEYS.has(baseNameOf(key));
      const wantList = LIST_KEYS.has(key) || LIST_KEYS.has(baseNameOf(key));
      // 列表型：元素是对象且有主键 → 按 id 并集
      const looksList = wantList || (wantSet === false && la.length && ca.length && typeof la[0] === 'object');
      if (looksList) {
        const merged = mergeList(la, ca);
        if (merged.length > Math.max(la.length, ca.length) || JSON.stringify(merged) !== JSON.stringify(la)) {
          return { value: JSON.stringify(merged), how: 'merge-list' };
        }
        return { value: localText, how: 'keep' };
      }
      if (wantSet) {
        const merged = mergeSet(la, ca);
        if (JSON.stringify(merged) === JSON.stringify(la)) return { value: localText, how: 'keep' };
        return { value: JSON.stringify(merged), how: 'merge-set' };
      }
    }
    return null;   // 交给调用方按「整键取较新」处理
  }

  // mergeKeyValue 给出的结果里，哪些可以直接采用。
  //
  // 关键在 'keep' 与 'same'：它们的值就是「本机那一份」，含义是云端的信息本机已经全有。
  // 若把它们排除在外，调用方就会退回「按时间戳整键取较新」—— 而云端那份的时间戳通常是
  // 「上次上传那一刻」，比本机内容的编辑时间更新，于是本机独有的条目会被整键冲掉。
  // 这正是「点下载选合并，本机独有数据却没了」的成因，双向同步同样踩得到。
  //
  // 'acc-cloud' / 'acc-local'（累计型取 max）刻意不在列：启用它会让「把计数改小」
  // 永远同步不出去，属于产品策略，需要单独决策，不混在这次改动里。
  function isUsableMerge(m) {
    return !!m && (m.how === 'merge-list' || m.how === 'merge-set' ||
                   m.how === 'merge-stat' || m.how === 'keep' || m.how === 'same');
  }

  // 合并下载：两边并集；同键两边都有时保留「较新」的一份（时间未知时保留本机）
  //
  // ⚠️ v50：「时间未知」的判据两处必须同义。
  //    本函数（下载方向）原先用 `meta[key] || 0` —— 本机无写入记录 → lts=0 →
  //    「云端较新」恒成立 → 拿云端覆盖本机；
  //    而 buildMergedUpload（上传方向）用 `meta[key] || Date.now()` —— 同一情形
  //    却判定「本机刚写过，本机为准」。同一对数据，两个方向给出相反答案，
  //    结果就是两端来回覆盖、谁也无法收敛。
  //    现统一为**写入侧语义**：本机没有该键的时间戳记录 → 视为本机为准。
  //    理由：本机存在该键，说明本机写过它（时间戳理应存在，缺失只可能是记录陈旧）；
  //    在「无从判断」时保留本机，是不丢用户本机数据的保守方向。
  //    云端独有的键仍会在下面 cur === null 的分支补进来，不受影响。
  function mergeCloudToLocal(serverData) {
    const sdata = (serverData && serverData.data) || {};
    // 世代号并进本机已知值。★ 这里**不**加闸门、也不删键：本机独有的旧世代键的处置
    //   统一交给 alignToGeneration（它会先留快照再动手），免得两处各删一半。
    noteCloudEpoch(serverData && serverData.metaEpoch);
    const meta = localKeyTs();
    let timestamps = {};
    try { timestamps = JSON.parse(localStorage.getItem('sync_timestamps') || '{}') || {}; } catch (e) {}
    let added = 0, updated = 0, kept = 0, mergedCount = 0;
    // 本次「云端 → 本机」真正写入过的键。给自动同步报「同步了什么内容」用 ——
    // 只报计数的话，用户仍然不知道到底动了哪一块。
    const changedKeys = [];
    for (const key in sdata) {
      const entry = sdata[key];
      if (!entry || typeof entry.value !== 'string') continue;
      if (isExcludedKey(key, entry.value)) continue;
      const cur = localStorage.getItem(key);
      if (cur === null) {                                    // 本机没有 → 云端补进来
        localStorage.setItem(key, entry.value);
        if (entry.timestamp) timestamps[key] = entry.timestamp;
        added++;
        changedKeys.push(key);
        continue;
      }
      // 先试领域级合并：两边都有、形状可合并时，合并结果无论新旧都比「整键取一份」更全。
      // 列表要合并成并集，所以不能因为「云端时间更新」就把本机独有的条目丢掉。
      const m = mergeKeyValue(key, cur, entry.value);
      if (isUsableMerge(m)) {
        if (m.value !== cur) {
          localStorage.setItem(key, m.value);
          if (entry.timestamp) timestamps[key] = entry.timestamp;
          mergedCount++;
          changedKeys.push(key);
        } else kept++;
        continue;
      }
      // 时间未知 → 视为本机刚写过（与 buildMergedUpload 同义，见函数头注释 v50）
      const lts = meta[key] || Date.now(), cts = entry.timestamp || 0;
      if (cts > lts) {                                       // 云端较新 → 覆盖这一键
        localStorage.setItem(key, entry.value);
        if (entry.timestamp) timestamps[key] = entry.timestamp;
        updated++;
        changedKeys.push(key);
      } else kept++;                                         // 本机较新 / 时间未知 → 保留本机
    }
    localStorage.setItem('sync_timestamps', JSON.stringify(timestamps));
    return { added, updated, kept, merged: mergedCount, keys: changedKeys };
  }

  // 合并上传：以云端数据为本底，逐键与本机「较新」者合并，返回合并后的云端数据集
  // 最近一次 buildMergedUpload 里「因世代闸门而未上传」的键名。
  // 用途：① 上传回执如实告知（把「静默少传」变成用户可见）；
  //      ② 排查时能直接看到是哪些键被闸门拦下、以及为什么（见下面的分支注释）。
  let lastGateSkipped = [];

  function buildMergedUpload(serverData, gateKeys) {
    const sdata = (serverData && serverData.data) || {};
    noteCloudEpoch(serverData && serverData.metaEpoch);   // 世代闸门依赖它，必须走在这之前
    const meta = localKeyTs();
    const merged = {};
    lastGateSkipped = [];
    for (const key in sdata) {
      const entry = sdata[key];
      if (!entry || typeof entry.value !== 'string') continue;
      if (isExcludedKey(key, entry.value)) continue;
      merged[key] = { value: entry.value, timestamp: entry.timestamp || 0 };
    }
    // ★ 世代闸门（2026-10-12）：早于最近一次「覆盖云端」的本机数据属于被替换掉的旧世代，
    //   一律不上传 —— 否则它会把别的设备刚做的「覆盖」重新并回来（这就是「覆盖在多设备下
    //   天然不成立」的堵点）。
    //   gateKeys 由调用方在「把云端合并进本机之前」算好；没传时退化为按时间戳现算
    //   （doUpload 的合并分支没有中间那一步本机写入，现算是准确的）。
    //   ⚠️ 无时间戳记录 ⇒ 按旧世代处理（与 OLD-GATE 注释里的取舍一致）。
    const gateAt = gateKeys ? 0 : overwriteGateAt();
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const value = localStorage.getItem(key);
      if (value === null || isExcludedKey(key, value)) continue;
      if (gateKeys) {
        // 旧世代键：不上传（gateKeys 由 staleGenKeys 算出，那边已按「云端有没有」判过）
        if (gateKeys[key] !== undefined) { lastGateSkipped.push(key); continue; }
      } else if (gateAt) {
        // ★ 2026-10-13 修订：判据统一为「云端有没有同名键」，不再看本机时间戳是否早于覆盖。
        //   · 云端没有该键（本机独有）⇒ 放行。往云端加一个新键不会改动任何已有键，
        //     谈不上「撤销覆盖」；而拦住它的代价是这份数据**永远上不了云** ——
        //     工具页写入的键（cpa_* / life-* / accCase_v3_<项目>）时间戳常常缺失或陈旧，
        //     旧口径把它们一律拦下，才有「上传成功、另一端却看不到」这种静默失败。
        //   · 云端已有该键 ⇒ 本机这份不得覆盖云端，只有「覆盖之后的新改动」
        //     （记录晚于 gateAt）才放行；否则会把那次覆盖并回来。这才是闸门本来要防的事。
        const ltsG = meta[key];
        if (Object.prototype.hasOwnProperty.call(merged, key)) {
          if (!ltsG || ltsG <= gateAt) { lastGateSkipped.push(key); continue; }
        }
      }
      const lts = meta[key] || Date.now();                   // 无写入记录的键视为刚写过（本机为准）
      const cts = (merged[key] && merged[key].timestamp) || 0;
      // 领域级合并优先：本机与云端都有这一键时，先试合并，只有合并不了才比时间。
      // 否则「本机后改」的列表会把云端独有的条目整键抹掉。
      if (merged[key]) {
        const m = mergeKeyValue(key, value, merged[key].value);
        if (isUsableMerge(m)) {
          merged[key] = { value: m.value, timestamp: Math.max(lts, cts) };
          continue;
        }
      }
      if (!merged[key] || lts >= cts) merged[key] = { value: value, timestamp: lts };
    }
    return merged;
  }

  // ============ 双向同步编排（与后端无关）============
  // 读云端 → 把云端合并进本机 → 再把合并结果写回云端。
  // 语义：两端最终都等于「本机 ∪ 云端，逐键取较新」，两端一致，且不丢任何一边。
  //
  // ⚠️ 「写回本机」那一步绝不能改用 applyCloudToLocal：
  //    它是「先清空本机所有可同步键、再写入云端那一批」—— 云端没有的本机独有键会被删掉。
  //    那是「下载并覆盖」的语义。双向必须走 mergeCloudToLocal（逐键合并，本机较新则保留本机）。
  //
  // 顺序：先 mergeCloudToLocal，后 buildMergedUpload。
  //   前者让本机拿到云端较新的键；后者以云端为底本、遍历本机逐键取新，
  //   于是写回云端的那一份必然就是本机此刻的全集 —— 两端自然收敛。
  async function runBothIO(readFn, writeFn) {
    const remote = await readFn();
    // ★ 安全闸 —— 必须在动任何数据之前。
    //   少读一片，后面的 writeFn 就会拿「本机 + 残缺云端」重写全部分片，
    //   把没读到的那些片的键从云端删掉：不可逆，而且旧代码会报"成功"。
    //   双向同步语义下这条尤其要紧：它是唯一一个既写云端又写本机的入口。
    if (remote && remote.shardFail > 0) {
      throw new Error(shardIncompleteMsg(remote) +
        '\n本机与云端都没有改动，稍等几秒重试即可。');
    }
    const hasRemote = !!(remote && remote.data && Object.keys(remote.data).length > 0);
    // ★ 世代检测 + 对齐（必须最先做）：noteCloudEpoch 只把「云端世代」并进本机已知值，
    //   并返回「本次是否发现了更新的世代」。gateKeys 的算法必须排在 mergeCloudToLocal
    //   之前 —— 那一步会把云端内容写回本机、顺带刷新这些键的时间戳，之后再算就算错了，
    //   并集结果会被当成本机新数据重新传上去（= 覆盖被撤销）。
    const epochNewer = noteCloudEpoch(remote && remote.metaEpoch);
    let gateKeys = null, alignStats = null;
    if (epochNewer && hasRemote) {
      const _at = (remote.metaEpoch && remote.metaEpoch.at) || 0;
      gateKeys = staleGenKeys(_at, cloudKeySet(remote));
      alignStats = alignToGeneration(remote, remote.metaEpoch, gateKeys);
    }
    const beforeCount = getLocalKeys().length;
    const beforeBytes = syncPayloadBytes();   // 同步前「参与同步的数据量」
    // 云端原有的键集合（用来算「本次往云端新增了哪些键」）
    const cloudHad = {};
    if (hasRemote) {
      for (const k in remote.data) {
        if (Object.prototype.hasOwnProperty.call(remote.data, k)) cloudHad[k] = 1;
      }
    }
    const localStats = hasRemote ? mergeCloudToLocal(remote) : null;      // ① 云端 → 本机
    const merged = buildMergedUpload(hasRemote ? remote : { data: {} }, gateKeys);  // ② 本机 → 云端
    const cloudAddedKeys = Object.keys(merged).filter(function (k) { return !cloudHad[k]; });
    const info = await writeFn(merged);
    return {
      hasRemote: hasRemote,
      epochNewer: epochNewer,                          // 本次是否发现「别的设备刚做过覆盖」
      metaEpoch: (remote && remote.metaEpoch) || null,
      alignStats: alignStats,                          // 世代对齐的战果（null = 未发生对齐）
      localStats: localStats,     // null = 云端原本就没有数据
      beforeCount: beforeCount,
      beforeBytes: beforeBytes,
      nItem: Object.keys(merged).length,
      cloudAddedKeys: cloudAddedKeys,   // 云端原本没有、本次写上去的键
      info: info
    };
  }

  // 秒表状态：把「已经跑了多久」显示出来，让人能区分「慢」和「卡死」
  let progTimer = null, progStart = 0;
  const PROG_STYLE = {
    running: 'background:#eef4ff;border:1px solid #cfe0ff;color:#1f4fa8',
    ok: 'background:#eafaf3;border:1px solid #b7ebd4;color:#0a6b45',
    fail: 'background:#fdf0ee;border:1px solid #f7ccc4;color:#a3341f'
  };

  // 成功 / 失败提醒。
  // v7 起优先写进同步面板里的常驻状态区：面板是用户点同步时正看着的地方，
  // 结果就展示在原地 —— 不用去侧边栏找那个几秒就消失的 toast。
  // 面板没开时（自动同步等）再退回 BackupHub 提醒卡 / toast / alert。
  //
  // ⚠️ 注意：这两个函数在导出的那一刻会被 _exportedNotifyOK 记下来。
  //    CloudSyncCore.notifyOK 是「对象属性」，其它后端（如 Gitee）通过
  //    Core.notifyOK(...) 调用 —— 那是一次属性读取。所以测试里可以直接
  //    `Core.notifyOK = stub` 覆盖掉，不会走进真实弹窗 / 站内 toast。
  //    千万别把这里改成「内部直接调 notifyOK」的写法，否则后端一失败就
  //    会弹永不 resolve 的对话框，测试直接卡死。
  function notifyOK(title, detail) {
    if (document.getElementById('syncProgress')) { progShow('ok', title, detail); progBusy(false); return; }
    if (window.BackupHub && typeof window.BackupHub.notify === 'function') {
      try { window.BackupHub.notify({ icon: '☁️', title: title, detail: detail }); return; } catch (e) {}
    }
    if (typeof toast === 'function') toast('✅ ' + title);
  }
  function notifyFail(title, detail) {
    if (document.getElementById('syncProgress')) { progShow('fail', title, detail); progBusy(false); return; }
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

  // ============ 后端选择（v6 新增：Gitee / GitHub 可切）============
  // 存在 localStorage 里的只是一个 id；具体能力由各后端模块自己注册到 window.CloudSyncBackends。
  // 这样 Gitee 模块可以完全独立加载，互不牵连。
  function activeBackendId() {
    let id = '';
    try { id = localStorage.getItem('cloud_backend') || ''; } catch (e) {}
    const reg = window.CloudSyncBackends || {};
    // 默认：优先 Gitee（国内更稳），没配就回落到 GitHub
    if (!id || !reg[id]) id = reg.gitee ? 'gitee' : '';   // 2026-10-13：GitHub 后端已移除
    return id;
  }

  function activeBackend() {
    const reg = window.CloudSyncBackends || {};
    return reg[activeBackendId()] || null;
  }

  function setBackend(id) {
    try { localStorage.setItem('cloud_backend', id); } catch (e) {}
    const b = activeBackend();
    const btn = document.getElementById('syncStatus');
    if (btn && b) btn.textContent = !b.isReady() ? '待配置'
      : ((typeof b.isConnected === 'function' && b.isConnected()) ? '已连接' : '未连接');
  }
  window.refreshBackendUI = function () {
    const b = activeBackend();
    const el = document.getElementById('syncStatus');
    if (el && b) el.textContent = !b.isReady() ? '待配置'
      : ((typeof b.isConnected === 'function' && b.isConnected()) ? '已连接' : '未连接');
  };

  // 后端没有体检面板时的临时提示（Gitee 侧暂未实现完整体检）
  function Core_showToastCompat(msg) {
    if (typeof toast === 'function') { try { toast(msg); return; } catch (e) {} }
    notifyOK('云端同步', msg);
  }

  // ============ 同步主面板 ============
  // 备份状态与操作已合并进来：侧边栏只保留「云端同步」一个入口
  function backupStateHTML() {
    if (window.BackupHub && typeof window.BackupHub.activityHTML === 'function') {
      try { return window.BackupHub.activityHTML(); } catch (e) {}
    }
    return '<div style="font-size:13px;color:#888">备份模块未加载</div>';
  }

  // ============ 同步进度 / 结果反馈（v7）============
  // 背景：上传下载是异步的，之前点完按钮面板立刻关闭，界面上什么都不剩。
  // 用户既不知道任务在跑、也不知道结果 —— 反馈还经常被侧边栏角落里几秒就消失的
  // toast 吞掉。这里在面板内做一块常驻状态区，把「进行中 → 成功/失败」全程显示出来。
  function progShow(kind, title, detail) {
    // 每次更新状态都停掉旧计时器：否则多次同步会叠加出好几个 ticking 的定时器
    if (progTimer) { clearInterval(progTimer); progTimer = null; }
    const el = document.getElementById('syncProgress');
    if (!el) return;
    el.style.display = 'block';
    el.style.cssText = 'display:block;margin-bottom:14px;border-radius:8px;padding:12px;font-size:13px;line-height:1.7;' +
      (PROG_STYLE[kind] || PROG_STYLE.running);
    const spin = kind === 'running' ? '⏳ ' : (kind === 'ok' ? '✅ ' : '⚠️ ');
    // 标题与正文之间必须有换行/间距：之前只用 div 相邻，浏览器渲染出来
    // 是「上传 Gitee 失败令牌无效或已过期…」粘成一坨，很难读。
    el.innerHTML = '<div style="font-weight:600">' + spin + escText(title) +
      '<span id="syncElapsed" style="font-weight:400;opacity:.7;font-size:12px;margin-left:6px"></span></div>' +
      (detail ? '<div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(0,0,0,.08);white-space:pre-wrap">' + escText(detail) + '</div>' : '');
    // 进行中时显示秒表。
    // 为什么需要：Gitee 首次同步要建仓库、逐文件取 sha，慢的时候十几秒没动静，
    // 界面看起来就像死机了。有个跳动的秒数，用户才知道程序还在跑。
    if (kind === 'running') {
      progStart = Date.now();
      const tick = function () {
        const t = document.getElementById('syncElapsed');
        if (!t) return;
        t.textContent = '（已用 ' + Math.round((Date.now() - progStart) / 1000) + ' 秒）';
      };
      tick();
      progTimer = setInterval(tick, 500);
    } else if (progStart) {
      // 结束时在正文末尾补一句总耗时，便于判断「这是网络慢还是真卡了」
      const sec = ((Date.now() - progStart) / 1000).toFixed(1);
      const d2 = el.querySelector('div:nth-child(2)');
      if (d2) d2.textContent = d2.textContent + '\n耗时 ' + sec + ' 秒。';
      progStart = 0;
    }
  }
  function progHide() {
    const el = document.getElementById('syncProgress');
    if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  }
  function escText(s) {
    return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }
  // ============ 全局同步互斥锁（2026-10-12）============
  // ★★ 为什么需要它（这是一个已真机复现的真实缺陷，不是理论风险）：
  //   修复前全模块只有两个「忙」标志 ——
  //     · progBusy：仅仅把 #syncUpload / #syncDownload 两颗按钮置灰，而且**漏了 #syncBoth**；
  //     · autoBusy：只防「自动同步自己」重入。两者都不构成互斥。
  //   于是「手动上传还在跑」时，后台的自动双向同步可以**立刻并发启动**，两条链同时
  //   「读云端 → 写云端」；而 writeShardedWith 的「读索引 → 判脏片 → 写片 → 删残留片」
  //   **不是原子的**，并发写会互相覆盖 / 互相删片，留下「索引说某片是新的、实际内容却是
  //   另一份」的静默损坏 —— 之后增量同步会一直跳过该片。
  //   又因为 doSyncBoth / giteeSyncBoth **无论是否静默都会写进度文案**，后台自动同步一开跑
  //   就把用户正看着的「正在上传到云端…」原地刷成「正在双向同步…」——
  //   这就是「我点的是上传覆盖，界面却显示双向同步」的全部原因。
  // 现在：**手动上传 / 下载 / 双向 与后台自动同步共用这一把锁**，同一时刻只允许一个任务。
  //   手动操作抢不到锁时**排队等待**（最多 syncWaitMs）；后台自动同步抢不到就直接让路，
  //   并在返回前重新排一次队（见 runAutoSync —— 直接丢弃会让这次改动永远推不上去）。
  let syncBusy = false;          // 是否有同步任务在跑
  let syncBusyWhat = '';         // 占用者文案（上传 / 下载 / 双向同步 / 自动同步）
  let syncHoldUntil = 0;         // 「覆盖」成功后的静默窗口：此刻之前自动同步一律让路
  let syncWaitMs = 30000;        // 手动操作最多排队多少毫秒
  const SYNC_HOLD_MS = 90000;    // 覆盖后静默窗口长度

  function syncTryLock(what) {
    if (syncBusy) return false;
    syncBusy = true; syncBusyWhat = what || '同步';
    return true;
  }
  function syncUnlock() { syncBusy = false; syncBusyWhat = ''; }
  function syncHoldRemaining() { return Math.max(0, syncHoldUntil - Date.now()); }
  // 「后台自动同步该不该让路」：有人正在同步，或刚做完覆盖（静默窗口内）。
  function syncAutoBlocked() { return syncBusy || syncHoldRemaining() > 0; }
  function syncHoldNow(ms) { syncHoldUntil = Date.now() + (ms || SYNC_HOLD_MS); }
  function syncClearHold() { syncHoldUntil = 0; }
  function syncWaitLock(what, timeoutMs) {
    if (syncTryLock(what)) return Promise.resolve(true);
    const deadline = Date.now() + (timeoutMs || syncWaitMs);
    return new Promise(function (resolve) {
      const t = setInterval(function () {
        if (syncTryLock(what)) { clearInterval(t); resolve(true); return; }
        if (Date.now() > deadline) { clearInterval(t); resolve(false); }
      }, 200);
    });
  }
  // 手动操作入口：抢锁；被别人占着时先给出「排队中」提示，再等它结束。
  async function syncBeginManual(what) {
    what = what || '同步';
    if (syncTryLock(what)) return true;
    if (document.getElementById('syncProgress')) {
      progShow('running', '已有同步正在进行…',
        '「' + (syncBusyWhat || '同步') + '」还没结束。已为你排队，它一结束就自动开始「' + what +
        '」（最多等 ' + Math.round(syncWaitMs / 1000) + ' 秒）。');
    }
    return await syncWaitLock(what, syncWaitMs);
  }
  function syncBusyNotice() {
    if (document.getElementById('syncProgress')) {
      progShow('fail', '同步繁忙，本次未执行',
        '另一项同步（' + (syncBusyWhat || '同步') + '）仍在进行中，请等它结束后再点一次。数据未被改动。');
      progBusy(false);
    } else if (typeof toast === 'function') {
      toast('⚠️ 另一项同步正在进行中，请稍后再试');
    }
  }
  // 给 Gitee 后端与回归测试共用的一份门面。
  const syncLockAPI = {
    beginManual: syncBeginManual,
    tryLock: syncTryLock,
    end: syncUnlock,
    blocked: syncAutoBlocked,
    hold: syncHoldNow,
    clearHold: syncClearHold,
    holdRemaining: syncHoldRemaining,
    notice: syncBusyNotice,
    holder: function () { return syncBusyWhat; },
    busy: function () { return syncBusy; },
    setWaitMs: function (n) { syncWaitMs = Math.max(0, parseInt(n, 10) || 0); },
    HOLD_MS: SYNC_HOLD_MS
  };

  // 任务期间锁住按钮，防止连点造成并发上传互相干扰
  function progBusy(busy) {
    ['#syncUpload', '#syncDownload'].forEach(function (sel) {
      const b = document.querySelector(sel);
      if (!b) return;
      b.disabled = !!busy;
      b.style.opacity = busy ? '0.55' : '1';
      b.style.cursor = busy ? 'not-allowed' : 'pointer';
    });
  }

  function openSyncPanel() {
    closeTopModal();
    const backend = activeBackend();
    const mask = document.createElement('div');
    mask.className = 'sync-mask';
    // ⚠️ 关键：align-items 用 flex-start 而不是 center，并给 mask 加 overflowY:auto。
    //
    // 为什么必须这样：
    // 面板内容会随状态增长（进度区、失败详情、备份状态都能撑高它）。一旦总高
    // 超过视口，`align-items:center` 会让面板**上下同时溢出**，而 flex 居中溢出
    // 的那部分是**无法滚动到**的（scrollHeight === clientHeight，滚动条不出现）。
    // 实测：内容 1056px / 视口 800px 时，面板 top = -128px，底部的「关闭」按钮
    // 被推到 866~904px，用户既看不到也点不到 —— 表现就是「同步完没有关闭按钮」。
    // 改用 flex-start + overflowY:auto 后，内容超高时从顶部开始排列，整体可滚动。
    mask.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:2147483000;display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:16px 0;box-sizing:border-box;';
    const modal = document.createElement('div');
    modal.style.cssText = 'background:white;border-radius:12px;padding:0 24px 24px;max-width:460px;width:92%;box-shadow:0 8px 32px rgba(0,0,0,.2);margin:auto 0;flex:0 0 auto;box-sizing:border-box;position:relative;';
    const connState = backend && backend.isConnected() ? '✅ 已连接' : '⚙️ 未配置';
    const lastTxt = lastSyncTime ? ('上次操作：' + fmtTime(lastSyncTime)) : '还没有同步过';
    // 顶部固定标题栏（含右上角关闭）：
    // 面板内容会随进度区 / 失败详情 / 备份状态不断变高，在 800px 高的屏幕上很容易
    // 超过视口。底部那个「关闭」按钮就会被推到屏幕外，用户找不到退出方式（实测
    // 内容 1056px 时关闭按钮落在 1010px 处，完全不可见）。
    // 把关闭放到 sticky 顶栏，无论面板多高都能点到；同时给底部保留一个关闭按钮，
    // 面板不高时用起来更顺手。
    modal.innerHTML = `
      <div style="position:sticky;top:0;z-index:2;background:white;padding:20px 0 10px;margin:0 -4px;border-bottom:1px solid #f0f0f0">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
          <div>
            <h2 style="margin:0 0 4px;font-size:20px">🔄 云端同步</h2>
            <p style="margin:0;color:#666;font-size:13px"><span id="bdLabel">${backend ? backend.name : '未选择'}</span> ｜ ${connState} ｜ ${lastTxt}</p>
          </div>
          <button id="syncCloseTop" type="button" aria-label="关闭"
                  style="flex:0 0 auto;width:32px;height:32px;border:1px solid #e5e7eb;border-radius:8px;background:white;cursor:pointer;font-size:18px;line-height:1;color:#666">×</button>
        </div>
      </div>
      <div style="padding-top:14px">

      <div style="background:#f6f8fa;border-radius:8px;padding:12px;font-size:13px;color:#444;line-height:1.7;margin-bottom:16px">
        <b>怎么用：</b><br>
        • <b>上传</b>：点完会让你选「合并到云端」还是「覆盖云端」。<br>
        • <b>下载</b>：点完会让你选「合并到本机」还是「覆盖本机」。<br>
        <span style="color:#7c8aa5">「覆盖」是唯一会整端替换的操作，所以它从不默认、每次都要单独确认。数据上传前会自动 gzip 压缩，并按模块分片，只重传改动过的片。<br>「覆盖」会给云端写入一个<b>世代号</b>：其他设备检测到该世代后，早于覆盖时刻的本机数据不再上传（以云端为准，并可留一份本机快照），此后新的改动照常同步 —— 这样「覆盖」在多设备下才真正生效。</span><br>
        <span style="color:#7c8aa5">同一时刻只允许一个同步任务：手动点的时候若正好有别的同步在跑，会自动排队（最多 30 秒）。</span>
      </div>

      <div style="display:flex;gap:10px;margin-bottom:10px">
        <button id="syncUpload" style="flex:1;padding:11px;border:1px solid #d8e0ea;border-radius:8px;background:#f7f9fc;color:#33415c;font-size:14px;cursor:pointer">⬆️ 上传到云端</button>
        <button id="syncDownload" style="flex:1;padding:11px;border:1px solid #d8e0ea;border-radius:8px;background:#f7f9fc;color:#33415c;font-size:14px;cursor:pointer">⬇️ 从云端下载</button>
      </div>

      <!-- 同步状态区：常驻显示「进行中 / 成功 / 失败」。
           为什么必须有它：上传是异步的，之前一点按钮面板就关掉了，
           界面上再无任何痕迹，用户既不知道在跑、也不知道跑完没有。
           这里原地反馈，面板不再自动关闭（完成后面板内出现「关闭」）。 -->
      <div id="syncProgress" style="display:none;margin-bottom:14px;border-radius:8px;padding:12px;font-size:13px;line-height:1.7"></div>

      <div style="display:flex;gap:8px;margin-bottom:14px">
        <button id="syncHealth" style="flex:1;padding:9px;border:1px solid #ddd;border-radius:6px;background:white;cursor:pointer;font-size:13px">🩺 云端体检（下载失败先点这里）</button>
        <button id="syncDataMgr" style="flex:1;padding:9px;border:1px solid #ddd;border-radius:6px;background:white;cursor:pointer;font-size:13px">🗂️ 数据管理（导入 / 导出 / 清空）</button>
      </div>
      ${latestSnapshot() ? '<div style="margin:-6px 0 14px"><button id="syncRestoreSnap" style="width:100%;padding:9px;border:1px solid #f0c36d;border-radius:6px;background:#fffbf0;color:#8a5a00;cursor:pointer;font-size:13px">↩️ 找回覆盖前的数据（有快照）</button></div>' : ''}

      <div id="syncBackupBox" style="border-top:1px solid #eee;padding-top:12px;margin-bottom:14px">
        <div style="font-size:14px;font-weight:600;margin-bottom:8px">💾 数据备份</div>
        <div id="syncBackupState" style="background:#f6f8fa;border-radius:8px;padding:10px 12px;margin-bottom:10px">${backupStateHTML()}</div>
        <div style="display:flex;gap:8px">
          <button id="syncBkExport" style="flex:1;padding:9px;border:1px solid #ddd;border-radius:6px;background:white;cursor:pointer;font-size:13px">导出备份到本机</button>
          <button id="syncBkCenter" style="flex:1;padding:9px;border:1px solid #ddd;border-radius:6px;background:white;cursor:pointer;font-size:13px">备份中心</button>
        </div>
      </div>

      <div style="display:flex;justify-content:space-between;align-items:center">
        <button id="syncReconfig" style="background:none;border:none;color:#888;font-size:13px;cursor:pointer;text-decoration:underline">配置 / 更换账号</button>
        <button id="syncClose" style="padding:8px 16px;border:1px solid #ddd;border-radius:6px;background:white;cursor:pointer;font-size:14px">关闭</button>
      </div>
      </div>`;
    mask.appendChild(modal);
    document.body.appendChild(mask);
    mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
    // Esc 关闭：面板很高时用户未必想找按钮，键盘退出是最省事的路径
    const onEsc = (e) => { if (e.key === 'Escape') { mask.remove(); document.removeEventListener('keydown', onEsc); } };
    document.addEventListener('keydown', onEsc);
    // 面板被移除后（无论何种方式）清掉监听，避免残留
    const origRemove = mask.remove.bind(mask);
    mask.remove = function () { document.removeEventListener('keydown', onEsc); origRemove(); };

    // 统一取面板内控件：任何一个按钮缺失都不该让整个面板崩掉
    // （曾因漏写 #syncDataMgr 的按钮 HTML，querySelector 返回 null 直接抛 TypeError）
    const noopEl = { set onclick(v) {} };
    const q = (sel) => modal.querySelector(sel) || noopEl;

    q('#syncClose').onclick = () => mask.remove();
    // 顶栏那个关闭按钮：面板内容再高也始终可见，这是主要的退出路径
    const closeTop = modal.querySelector('#syncCloseTop');
    if (closeTop) closeTop.onclick = () => mask.remove();
    q('#syncReconfig').onclick = () => {
      mask.remove();
      if (backend) backend.reconfigure(); else showConfigModal();
    };
    // ⚠️ 这里刻意不关面板：后端会异步跑几秒到几十秒，
    //    关掉面板就只剩侧边栏，用户会以为「跳到侧边栏了」而且看不到任何结果。
    //    改为原地显示进度，状态由 progShow/progBusy 驱动（后端内部调用）。
    q('#syncUpload').onclick = () => {
      if (!backend) { showConfigModal(); return; }
      if (!backend.isReady()) { mask.remove(); backend.reconfigure(); return; }
      backend.upload();
    };
    q('#syncDownload').onclick = () => {
      if (!backend) { showConfigModal(); return; }
      if (!backend.isReady()) { mask.remove(); backend.reconfigure(); return; }
      backend.download();
    };
    q('#syncHealth').onclick = () => {
      mask.remove();
      if (backend && backend.health) { backend.health(); return; }
      if (backend) Core_showToastCompat(backend.name + ' 暂未提供体检面板');
      else showConfigModal();
    };
    // 备份动作：导出走 BackupHub（导出后会询问是否顺带上传云端），备份中心是完整功能面板
    q('#syncBkExport').onclick = () => {
      mask.remove();
      if (window.BackupHub && window.BackupHub.exportThenAskCloud) {
        try { window.BackupHub.exportThenAskCloud(); return; } catch (e) {}
      }
      if (window.BackupHub) { try { window.BackupHub.exportNow(null); } catch (e) {} }
    };
    q('#syncBkCenter').onclick = () => {
      mask.remove();
      if (window.BackupHub && window.BackupHub.open) { try { window.BackupHub.open(); } catch (e) {} }
    };
    // 数据管理（导出 / 导入 / 清空）——顶栏那颗重复按钮已撤掉，入口收在这里
    q('#syncDataMgr').onclick = () => {
      mask.remove();
      if (typeof window.openDataModal === 'function') { try { window.openDataModal(); return; } catch (e) {} }
      if (window.BackupHub && window.BackupHub.open) { try { window.BackupHub.open(); } catch (e) {} }
    };
    const rsBtn = modal.querySelector('#syncRestoreSnap');
    if (rsBtn) rsBtn.onclick = () => { restoreSnapshot(); };

  }

  // ============ 配置弹窗 ============
  function showConfigModal() {
    closeTopModal();
    const mask = document.createElement('div');
    mask.className = 'sync-mask';
    mask.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:2147483000;display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:16px 0;box-sizing:border-box;';
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

  // ============ 体积压缩：gzip + base64 ============
  // 为什么必须压缩：Gist API 每个文件只内联返回 1MB，超过就必须改拉 raw_url（海外 CDN）。
  // 实测 2MB 数据走 raw_url 要 55 秒，且中途会断流 —— 这就是「下载失败」的主因。
  // 业务数据是 JSON 文本，gzip 后通常只剩 1/4；即便 base64 再膨胀 33%，仍远小于原体积。
  const PACK_ENC = 'gzip';
  function canCompress() {
    return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
  }
  function bufToB64(buf) {
    const u8 = new Uint8Array(buf);
    let s = '';
    const CH = 0x8000;   // 分块，避免 apply 参数过多导致栈溢出
    for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  }
  function b64ToBuf(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  async function packCloud(obj) {
    const json = JSON.stringify(obj);
    if (!canCompress()) return { version: 2, enc: 'none', data: json, updatedAt: Date.now() };
    try {
      const cs = new CompressionStream(PACK_ENC);
      const buf = await new Response(new Blob([json]).stream().pipeThrough(cs)).arrayBuffer();
      return { version: 2, enc: PACK_ENC, data: bufToB64(buf), updatedAt: Date.now() };
    } catch (e) {
      return { version: 2, enc: 'none', data: json, updatedAt: Date.now() };
    }
  }
  // 兼容三种形态：v1 明文 {data:{...}}、v2 enc:'none'、v2 enc:'gzip'
  async function unpackCloud(parsed) {
    if (!parsed) return null;
    if (parsed.enc === PACK_ENC) {
      if (!canCompress()) throw new Error('本浏览器不支持解压，请改用较新的 Chrome / Edge 打开');
      const ds = new DecompressionStream(PACK_ENC);
      const txt = await new Response(new Blob([b64ToBuf(parsed.data)]).stream().pipeThrough(ds)).text();
      return JSON.parse(txt);
    }
    if (parsed.enc === 'none' && typeof parsed.data === 'string') return JSON.parse(parsed.data);
    return parsed;   // v1：本身就是数据对象
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // 有并发上限的 map：同时最多跑 limit 个任务，完成一个补一个。
  // 分片可能多达几十片（实测已有 43 片），一次性 Promise.all 全并发时，
  // Gitee 这类对突发请求敏感的后端会成片拒绝（实测 43 并发只读回 14 片），
  // 所以读分片必须限流。
  async function poolMap(items, limit, fn) {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = [];
    const n = Math.max(1, Math.min(limit, items.length));
    for (let w = 0; w < n; w++) {
      workers.push((async function () {
        while (cursor < items.length) {
          const i = cursor++;
          results[i] = await fn(items[i], i);
        }
      })());
    }
    await Promise.all(workers);
    return results;
  }

  // 带重试的请求：国内访问 api.github.com / gist.githubusercontent.com 偶发断流，
  // 不重试就会整次同步失败。
  async function fetchRetry(url, opts, tries, label) {
    let lastErr = null;
    const n = tries || 3;
    for (let i = 0; i < n; i++) {
      try {
        const r = await fetch(url, opts);
        if (r.ok) return r;
        lastErr = new Error('HTTP ' + r.status);
        if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) throw lastErr;
      } catch (e) { lastErr = e; }
      if (i < n - 1) await sleep(500 * (i + 1));
    }
    throw lastErr || new Error((label || '请求') + '失败');
  }

  // 读取云端数据。
  // ⚠️ 语义约定（本轮修复的核心）：真失败必须抛异常，不要静默返回 null。
  //    旧版把「网络断流」「JSON 解析失败」都吞成 null，界面于是弹出
  //    「云端还没有数据」—— 把故障说成没数据，非常误导。
  //    现在：返回 {data:{}} = 云端确实为空；throw = 真失败（带原因）。
  // 读云端数据。
  // 语义约定：真失败必须抛异常，不要静默返回 null（否则会把故障说成「云端没数据」）。
  //   返回 {data:{}} = 云端确实为空；throw = 真失败（带原因）。
  // v5：先看有没有分片 meta；有则走分片，没有则回落旧的单文件格式（下次上传自动升级）。
  async function readGist() {
    if (!cachedGistId()) await findOrCreateGist();

    // ---- 优先尝试分片格式 ----
    let cloudMeta = null;
    try {
      cloudMeta = await readShardedMeta();
    } catch (e) {
      throw new Error('读取云端失败：' + (e && e.message ? e.message : e) + '，请检查网络后重试');
    }
    if (cloudMeta && cloudMeta.shards) {
      const merged = await readSharded(cloudMeta);
      setCachedCloudHasData(Object.keys(merged.data).length > 0);
      return merged;
    }

    // ---- 回落：旧的单文件格式 ----
    let data;
    try {
      data = await apiCall('GET', '/gists/' + GIST_ID);
    } catch (e) {
      if (isNotFound(e)) { clearGistCache(); throw new Error('云端同步文件不存在（可能已被删除），请重新上传一次'); }
      throw new Error('读取云端失败：' + (e && e.message ? e.message : e) + '，请检查网络后重试');
    }
    const file = data.files && data.files[GIST_FILENAME];
    if (!file) return { version: 1, data: {}, updatedAt: 0, legacy: true };
    let content = file.content || '';
    if (file.truncated) {
      // 超过 1MB：API 只给片段，必须改拉 raw_url（海外 CDN，失败高发点，故重试 3 次）
      content = '';
      try {
        const raw = await fetchRetry(file.raw_url, { cache: 'no-store' }, 3, '完整数据下载');
        content = await raw.text();
      } catch (e) {
        throw new Error('云端数据较大（约 ' + Math.round((file.size || 0) / 1024) + 'KB），完整下载失败：' +
          (e && e.message ? e.message : e) + '。请重试，或换网络较好的时机操作。');
      }
    }
    if (!content) return { version: 1, data: {}, updatedAt: 0, legacy: true };
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      throw new Error('云端数据解析失败（下载可能不完整），请重试');
    }
    const payload = await unpackCloud(parsed);
    setCachedCloudHasData(!!(payload && payload.data && Object.keys(payload.data).length > 0));
    return Object.assign({ legacy: true }, payload || { version: 1, data: {}, updatedAt: 0 });
  }

  // 注意：v5 起写入统一走 writeSharded()（分片 + 只推脏片）。
  // 旧的全量 writeGist() 已移除 —— 保留它容易被误调用，退回「每次全量重传」的老问题。

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
      if (j && j.enc) return size > 200;     // v2 压缩格式：有数据才会带 enc 字段
      return !!(j && j.data && Object.keys(j.data).length > 0);
    } catch (e) {
      return size > 200;
    }
  }

  // 只查找，不创建（无副作用，供状态展示用）
  // 账号下可能同时存在多份同名文件（历次误建/换设备留下的），这时必须挑「有数据且最新」的那份，
  // 否则两端会各自连到不同副本，表现为「下载不到别人的数据」。
  let lastCandidates = [];   // 供体检面板展示
  async function findGist() {
    const list = await apiCall('GET', '/gists?per_page=100');
    let best = null;         // 最近更新的
    let bestWithData = null; // 有数据的里最近更新的
    lastCandidates = [];
    for (const g of list) {
      if (!g.files || !g.files[GIST_FILENAME]) continue;
      const f = g.files[GIST_FILENAME];
      const hasData = gistHasData(f);
      lastCandidates.push({ id: g.id, size: f.size || 0, hasData: hasData, updated: g.updated_at });
      if (!best || new Date(g.updated_at) > new Date(best.updated_at)) best = g;
      if (hasData && (!bestWithData || new Date(g.updated_at) > new Date(bestWithData.updated_at))) bestWithData = g;
    }
    lastCandidates.sort((a, b) => new Date(b.updated) - new Date(a.updated));
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

  // ============ 云端体检 ============
  // 直接回答「为什么下载失败」：把体积、项目数、同名副本数一次摊开。
  // 不下载正文就能看的部分（副本列表）先出，正文明细按需读取、失败不影响前面结果。
  function fmtKB(n) { return Math.round((n || 0) / 1024) + 'KB'; }
  async function doHealth() {
    if (!GITHUB_TOKEN) { showConfigModal(); return; }
    closeTopModal();
    const mask = document.createElement('div');
    mask.className = 'sync-mask';
    mask.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:2147483000;display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:16px 0;box-sizing:border-box;';
    const modal = document.createElement('div');
    modal.style.cssText = 'background:white;border-radius:12px;padding:22px;max-width:520px;width:92%;max-height:82vh;overflow:auto;box-shadow:0 8px 32px rgba(0,0,0,.2);';
    modal.innerHTML = '<h2 style="margin:0 0 10px;font-size:19px">🩺 云端体检</h2>' +
      '<div id="hcBody" style="font-size:13px;line-height:1.85;color:#333">正在检查…</div>' +
      '<div style="display:flex;justify-content:flex-end;margin-top:16px">' +
      '<button id="hcClose" style="padding:8px 16px;border:1px solid #ddd;border-radius:6px;background:white;cursor:pointer;font-size:14px">关闭</button></div>';
    mask.appendChild(modal);
    document.body.appendChild(mask);
    mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
    modal.querySelector('#hcClose').onclick = () => mask.remove();
    const body = modal.querySelector('#hcBody');
    const L = [];
    try {
      if (!cachedGistId()) await findOrCreateGist();
      const list = await apiCall('GET', '/gists?per_page=100');
      const mine = (list || []).filter(function (g) { return g.files && g.files[GIST_FILENAME]; });
      mine.sort(function (a, b) { return new Date(b.updated_at) - new Date(a.updated_at); });
      L.push('<b>账号下的同名云端文件：' + mine.length + ' 份</b>');
      mine.forEach(function (g) {
        const f = g.files[GIST_FILENAME];
        L.push('&nbsp;&nbsp;· <code>' + g.id.slice(0, 10) + '</code> ' + fmtKB(f.size) + ' · ' + String(g.updated_at).slice(0, 10) +
          (g.id === GIST_ID ? ' <span style="color:#08bd74">← 当前连接</span>' : ''));
      });
      if (mine.length > 1) {
        L.push('<span style="color:#e67e22">⚠️ 存在 ' + mine.length + ' 份副本。如果两台设备显示的数据对不上，' +
          '多半是各自连到了不同副本 —— 建议在「有最新数据的那台」点一次上传，其余副本可到 gist.github.com 删除。</span>');
      }
      let remote = null;
      try { remote = await readGist(); } catch (e) {
        L.push('<span style="color:#d33">读取当前副本失败：' + (e && e.message ? e.message : e) + '</span>');
      }
      if (remote && remote.data) {
        const keys = Object.keys(remote.data);
        let tot = 0;
        const rows = [];
        keys.forEach(function (k) {
          const v = remote.data[k];
          const sz = (v && typeof v.value === 'string') ? v.value.length : 0;
          tot += sz; rows.push([sz, k]);
        });
        rows.sort(function (a, b) { return b[0] - a[0]; });
        L.push('');
        L.push('<b>当前副本内容</b>：' + keys.length + ' 项，原始值合计约 ' + fmtKB(tot));
        if (rows.length) {
          L.push('最占空间的 6 项：');
          rows.slice(0, 6).forEach(function (r) {
            L.push('&nbsp;&nbsp;· <code>' + r[1] + '</code> ' + fmtKB(r[0]));
          });
        }
        if (tot > 800 * 1024) {
          L.push('<span style="color:#e67e22">⚠️ 数据偏大。下载慢、容易失败多由此引起 —— 面板里「上传」会先自动压缩再传。</span>');
        } else {
          L.push('<span style="color:#08bd74">✓ 体积正常，下载应当顺畅。</span>');
        }
        // ★ 2026-10-13：把「本机有、这份云端没有」的键直接列出来。
        //   这是「某个 tab 的数据在另一台设备上看不到」的第一诊断口：合并只会补云端**已有**的键，
        //   本机独有的键永远不会自己跑到别的设备上；也说明两台设备可能连的是不同的云/副本。
        const onlyK = Object.keys(localOnlyKeys(remote));
        L.push('');
        if (onlyK.length) {
          L.push('<b style="color:#e67e22">本机有、这份云端没有：' + onlyK.length + ' 项</b>');
          L.push('<span style="color:#888">这些数据不会因为同步而出现在别的设备上（合并只补云端已有的键）。' +
            '要让它们上云：在本机点「上传到云端」→ 选「覆盖云端」。</span>');
          onlyK.slice(0, 10).forEach(function (k) {
            let lb = k;
            try { lb = (typeof labelOfKey === 'function' ? labelOfKey(k) : k) || k; } catch (e) { }
            L.push('&nbsp;&nbsp;· ' + lb + ' <code>' + k + '</code>');
          });
          if (onlyK.length > 10) L.push('&nbsp;&nbsp;· …等共 ' + onlyK.length + ' 项');
        } else {
          L.push('<span style="color:#08bd74">✓ 本机可同步的键在这份云端上都有。</span>');
        }
      }
    } catch (e) {
      L.push('<span style="color:#d33">检查失败：' + (e && e.message ? e.message : e) + '</span>');
    }
    body.innerHTML = L.join('<br>');
  }

  // ============ 分片（v5）============
  // 为什么分片：Gist 单文件内联只返回 1MB，超了就得走 raw_url（海外 CDN，实测 2MB 要 55 秒且断流）。
  // 把整包拆成若干独立压缩的小片后，① 单片压在 1MB 以下的概率大增，避开慢通道；
  // ② 改一条记录只需要重传它所在的那一片，而不是整个数据集。
  const SHARD_RE = /^efficiency-hub-(\d{3})\.json$/;
  const META_FILENAME = 'efficiency-hub-meta.json';
  const LEGACY_FILENAME = 'efficiency-hub-sync.json';
  const MAX_SHARD_BYTES = 700 * 1024;   // 单片原始数据上限（压缩前），留足余量
  // ⚠️ 分片粒度（性能关键）：早期按「模块」切片，模块一多就切出几十片（实测 43 片），
  //    而每片独立一次网络往返 —— 43 片 × 数百 ms RTT 直接就是几十秒。
  //    这里改为「按体积打包」：优先把数据塞满少数几片，片数由体积决定而非模块数。
  //    好处：① 往返次数从 O(模块数) 降到 O(数据量/片容量)，通常 3~5 片；
  //    ② 脏片判定仍按模块归属，改动一个模块只重传它落到的那些片。
  //    目标容量取 400KB 而非更大：Gitee 对 >1MB 的文件不返回 inline content、
  //    强制走 download_url 慢通道，压缩后留足余量才不会踩到那条路。
  const TARGET_SHARD_BYTES = 400 * 1024;

  // 把 key 归到某个模块片：按 index.html 的 MODULES[].keys 前缀匹配。
  // 拿不到 MODULES（比如在工具页里打开）时退化为按键名前缀粗分。
  function shardOfKey(key) {
    try {
      if (typeof MODULES !== 'undefined' && Array.isArray(MODULES)) {
        for (const m of MODULES) {
          if (!m || !m.keys) continue;
          for (const k of m.keys) {
            if (key === k || key.indexOf(k + '_') === 0) return m.id;
          }
        }
      }
    } catch (e) {}
    // 兜底：按键名前缀粗分，保证同名业务的数据尽量落在同一片
    const seg = key.split('_')[0];
    return seg || 'misc';
  }

  // 估一条记录占多少字节（用于打包计量）
  function entryBytes(k, v) {
    if (v && typeof v.value === 'string') return v.value.length + k.length;
    return k.length + 16;
  }

  // 把本机数据打包成 { shardId: {key: {value, timestamp}} }
  //
  // 策略：按体积打包，而不是按模块切片。
  //   ① 先按体积把 key 顺序装进若干片，每片尽量装到 TARGET_SHARD_BYTES；
  //   ② 片名用 shardOfKey(key) 里的模块名打头，便于排查「某个模块的数据在哪片」；
  //      同模块的 key 会被连续遍历到，通常落在相邻片，不会被打散到很远。
  //   ③ 片数与模块数解耦 —— 数据少时就是 1 片，不再出现「43 个模块 = 43 片」。
  // 排序理由：把同模块的 key 排在一起，能让「同模块基本同片」的概率最大化，
  //           这样改动一个模块时被牵动的片数最少（增量上传仍然省）。
  function buildShards(dataObj) {
    const entries = [];
    for (const key in dataObj) entries.push([key, dataObj[key]]);
    // 稳定排序：先按模块名，再按 key 原序，保证同模块相邻
    const modOf = {};
    entries.forEach(function (e) { if (modOf[e[0]] === undefined) modOf[e[0]] = shardOfKey(e[0]); });
    entries.sort(function (a, b) {
      const ma = modOf[a[0]], mb = modOf[b[0]];
      if (ma === mb) return 0;
      return ma < mb ? -1 : 1;
    });

    const out = {};
    let cur = {}, curBytes = 0, idx = 0, curMod = '';
    const flush = function () {
      if (!Object.keys(cur).length) return;
      // 片名 = 「该片第一个模块名」+ 序号，只作标识不作归属声明。
      // 加序号是为了排序稳定、且避免同名冲突；用模块名打头纯粹为了人肉排查时
      // 能一眼看出「这片大概装的是哪个模块区间的数据」。
      var head = curMod || 'misc';
      var name = idx === 0 ? head : head + '__' + idx;
      while (out[name]) { idx++; name = head + '__' + idx; }
      out[name] = cur;
      cur = {}; curBytes = 0; idx++; curMod = '';
    };
    for (var i = 0; i < entries.length; i++) {
      var k = entries[i][0], v = entries[i][1];
      var sz = entryBytes(k, v);
      if (curBytes + sz > TARGET_SHARD_BYTES && Object.keys(cur).length) flush();
      if (!Object.keys(cur).length) curMod = modOf[k] || 'misc';
      cur[k] = v; curBytes += sz;
    }
    flush();
    // 极端情况：没有任何 key
    if (!Object.keys(out).length) out['misc'] = {};
    return out;
  }

  function shardFile(sid) { return 'efficiency-hub-' + sid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json'; }

  // 本机每个键的最后写入时间（BackupHub 全站维护 + 工具页写入的补记，见 localKeyTs 上方注释），
  // 用来判定「脏键」。
  // ⚠️ 必须与 localKeyTs 走同一套合并：读云端的一侧用 localKeyTs、写云端的一侧用 localMeta，
  //    两处若得出不同结论，就会出现「本机认为该键是新的、写片时又认为它是旧的」这种撕裂。
  function localMeta() {
    let m = {};
    try { m = JSON.parse(localStorage.getItem('__hub_meta_v1__') || '{}') || {}; } catch (e) { return {}; }
    return mergeIframeKeyTs(m);
  }
  // ============ 分片读写（v5）============
  // ⚠️ 这一层是「与后端无关」的：只看 io 接口，不认 Gist 还是 Gitee。
  //    抽出来的原因：Gitee 没有 Gist 的批量 PATCH，若各写一套分片逻辑，
  //    早晚会漂移（改了 GitHub 忘了 Gitee）。所以脏片判定、meta 结构、
  //    并发拉片这些「容易出错的部分」只在这里写一次。
  //
  // io 接口（由各后端实现，全部返回 Promise）：
  //   io.ensureTarget()          确保远端载体存在（Gist / 仓库+目录），返回载体标识
  //   io.getMeta()               读远端 meta 原文对象；读不到 / 不存在返回 null
  //   io.getFile(name)           读单个文件文本；不存在返回 null
  //   io.putFiles(map)           map = { 文件名: 文本内容 }，批量写（各自实现并发/单请求）
  //   io.deleteFiles(names)      删除文件（可选；分片减小时清理残留片）
  //   io.label                   后端名，仅用于日志
  const META_ORIGIN = '__hub_sync_origin__';   // meta 里记后端，避免两种后端的数据互相踩

  function newMeta(origin) {
    // epoch：覆盖世代号（见上方 EPOCH 区块）。只在「覆盖」时推进，其它写入原样带过去。
    return { version: 5, origin: origin || '', updatedAt: Date.now(), shards: {}, keys: {}, epoch: null };
  }

  // 写：只更新「脏片」。meta 记录每片包含哪些键、以及整体 updatedAt。
  // 返回 { wroteBytes, wroteShards, skippedShards, totalShards, deletedShards }
  async function writeShardedWith(io, allData, forceShards, opts) {
    const origin = io.origin || '';
    await io.ensureTarget();

    // 1) 读取远端现有 meta（拿不到就当成全新的）
    let cloudMeta = null;
    try { cloudMeta = await io.getMeta(); } catch (e) { cloudMeta = null; }

    // 换后端写时不能拿旧后端的 meta 做「脏片判定」——两边的分片时间戳没有可比性，
    // 沿用会导致「以为没变，其实远端一片都没有」→ 数据静默丢失。此时强制全量写。
    if (cloudMeta && cloudMeta.origin && origin && cloudMeta.origin !== origin) {
      console.warn('[' + (io.label || 'sync') + '] 检测到远端 meta 属于其它后端（' +
        cloudMeta.origin + '），本次强制全量写片');
      cloudMeta = null;
      forceShards = true;
    }

    // 2) 本机打成片
    const shards = buildShards(allData);
    const meta = localMeta();
    const prevTs = cloudMeta && cloudMeta.keys ? cloudMeta.keys : {};
    const files = {};
    let wroteBytes = 0, wroteShards = 0, skippedShards = 0, totalShards = 0;

    const next = newMeta(origin);

    // ★ 覆盖世代号（2026-10-12）：只有「覆盖」推进它，合并 / 自动同步只原样带过去 ——
    //   否则世代号会在每一次普通同步里被改小或抹掉，「覆盖」立刻失去意义。
    if (opts && opts.overwrite) {
      const prevSeen = epochSeen();
      const cloudN = (cloudMeta && cloudMeta.epoch && cloudMeta.epoch.n) || 0;
      // n 取「云端 n+1」「本机已承认 n+1」「当前时刻」三者最大：
      //   前两者保证在两端都严格递增；带上当前时刻是为了兜住「读 meta 失败 ⇒ cloudN=0」
      //   的情况 —— 否则这台设备会写回一个更小的世代号，别的设备就检测不到这次覆盖。
      next.epoch = {
        n: Math.max(cloudN + 1, (prevSeen.n || 0) + 1, Date.now()),
        at: Date.now(),
        by: deviceTag()
      };
    } else if (cloudMeta && cloudMeta.epoch) {
      next.epoch = cloudMeta.epoch;
    }

    for (const sid in shards) {
      totalShards++;
      const raw = shards[sid];
      const keys = Object.keys(raw);
      // 该片里最大的写入时间 vs 上次同步记录的时间 → 判定脏不脏
      let maxTs = 0;
      keys.forEach(k => {
        // ★ 时间戳必须同时看两处，只看 meta 会让「工具页写入的键」永远上不了云端。
        //   成因：meta 来自 __hub_meta_v1__，它由导航页覆写「本页」的 localStorage.setItem
        //         来记录；工具页跑在同源 iframe 里，那是另一个 realm，覆写抓不到它的写入
        //         （sync-github.js 里 doSyncBoth 附近有实测结论）。于是业务键（cpa_*、
        //         life-* 等由工具页写入的键）在 meta 里根本没有记录。
        //   而 buildMergedUpload 对「无写入记录」的键给的是 Date.now()（视为刚写过、本机为准），
        //   放在 allData[k].timestamp 里。只看 meta 就把它丢了：t=0 → maxTs=0；
        //   首次写片时片级 ts 也记成 0 → 之后 maxTs > cloudTs（0 > 0）恒假 → 该片永久跳过。
        //   实测（mock io 两轮 writeShardedWith）：数据已变仍返回 wroteShards=0 /
        //         skippedShards=1 / wroteBytes=0，云端停在首次同步的内容，
        //         而两端都显示「同步成功、两端一致」。
        //   取 max 是安全的：buildMergedUpload 对「云端较新」的键给的是云端时间戳，
        //   于是 maxTs 就是云端值，maxTs > cloudTs 为假 → 跳过，增量优化照样保留。
        const tData = (allData[k] && allData[k].timestamp) || 0;
        const tMeta = meta[k] || 0;
        const t = tData > tMeta ? tData : tMeta;
        if (t > maxTs) maxTs = t;
        next.keys[k] = { shard: sid, ts: t || (prevTs[k] && prevTs[k].ts) || 0 };
      });
      next.shards[sid] = { keys: keys, ts: maxTs };

      const cloudTs = cloudMeta && cloudMeta.shards && cloudMeta.shards[sid]
        ? (cloudMeta.shards[sid].ts || 0) : 0;
      const dirty = forceShards || !cloudMeta || maxTs > cloudTs ||
        !(cloudMeta.shards && cloudMeta.shards[sid]);

      if (!dirty) { skippedShards++; continue; }

      const body = JSON.stringify(await packCloud({ version: 2, data: raw, updatedAt: Date.now() }));
      files[shardFile(sid)] = body;
      wroteBytes += body.length;
      wroteShards++;
    }

    // 3) 写 meta（很小，几乎零成本）
    files[META_FILENAME] = JSON.stringify(next);

    // 4) 提交。真正「增量」的两个前提：
    //    ① 只把这些文件推给远端（Gist 的 PATCH 天然按文件合并；Gitee 逐文件 PUT）；
    //    ② 远端没被列出的片保持原样。
    await io.putFiles(files);

    // 5) 清理残留片：本机重新切片后片名可能变少（比如某片被拆过又合回来），
    //    远端旧片不清掉的话，下次下载会把陈旧数据一起合并进来 —— 数据污染。
    let deletedShards = 0;
    if (cloudMeta && cloudMeta.shards && io.deleteFiles) {
      const stale = [];
      for (const oldSid in cloudMeta.shards) {
        if (!next.shards[oldSid]) stale.push(shardFile(oldSid));
      }
      if (stale.length) {
        try { await io.deleteFiles(stale); deletedShards = stale.length; }
        catch (e) { console.warn('[' + (io.label || 'sync') + '] 清理旧分片失败（不影响本次同步）:', e.message); }
      }
    }

    return { wroteBytes, wroteShards, skippedShards, totalShards, deletedShards, meta: next };
  }

  // 读 meta：返回 null 表示远端还是旧的单文件格式
  async function readShardedMetaWith(io) {
    await io.ensureTarget();
    return io.getMeta();
  }

  // 读一个分片；成功返回它包含的 data，失败返回 null
  //
  // ⚠️ 失败时不仅要返回 null，还要把「为什么失败」记进 io.lastShardErrors。
  //    旧实现用 catch(e){content=null} 把所有原因吞掉，上层只能笼统报
  //    「N 个分片没读到」，用户和排查者都拿不到线索（限流？权限？网络？）
  //    —— 这是排查效率的最大杀手。原因集中收集后由 shardIncompleteMsg 展示。
  function readShardOnce(io, sid) {
    return (async function () {
      const fname = shardFile(sid);
      if (!io.lastShardErrors) io.lastShardErrors = [];
      let content = null;
      try {
        content = await io.getFile(fname);
      } catch (e) {
        io.lastShardErrors.push({ sid: sid, msg: (e && e.message) || String(e), status: e && e.status });
        return null;
      }
      if (!content) {
        // 拿到 null 分两种情况，值得区分：文件确实不存在 vs 读取被降级。
        // 这里只能保守记为「未取到内容」，并带上 io 侧最近一次的错误（若有）。
        io.lastShardErrors.push({ sid: sid, msg: '未取到内容（文件不存在或读取被降级）', status: null });
        return null;
      }
      try {
        const payload = await unpackCloud(JSON.parse(content));
        return (payload && payload.data) || {};
      } catch (e) {
        io.lastShardErrors.push({ sid: sid, msg: '分片解析失败：' + ((e && e.message) || e), status: null });
        console.warn('[' + (io.label || 'sync') + '] 分片解析失败 ' + sid + ':', e.message);
        return null;
      }
    })();
  }

  // 读分片：并发拉取所有片后合并成 {key:{value,timestamp}}
  //
  // ⚠️ 必须同时回报「有几片没读回来」（shardFail），这是安全闸的判据。
  //    旧实现虽然算了 shardOk/shardCount，但**没有任何调用方读它们** ——
  //    于是单片读失败被静默跳过，上层只看到 remote.data 少了几个键、或干脆为空。
  //    而 data 变空会让调用方判定「云端没有数据」，接着做「本机 → 云端」的写入，
  //    用不含云端内容的合并结果重写全部分片 —— 等于**把云端数据删了**，
  //    整个过程还报"成功"（实测：3 片全丢，同步返回 ok=true）。
  async function readShardedWith(io, cloudMeta) {
    const shardIds = Object.keys(cloudMeta.shards || {});
    const merged = { data: {}, updatedAt: cloudMeta.updatedAt || 0 };
    io.lastShardErrors = [];        // 采集本轮的失败原因，供错误提示展示

    // 并发读分片。片数已由「按体积打包」压到个位数（见 buildShards），
    // 所以这里给到 6 并发既安全又能压满带宽：3 片一轮就走完。
    // 若仍是历史遗留的几十片老 meta，6 并发可能在 Gitee 侧被拒 ——
    // 下面的重试轮会兜住，且下一次上传就会自动重切成少量大片的格式。
    let results = await poolMap(shardIds, 6, function (sid) { return readShardOnce(io, sid); });

    // 有片没读回来 → 只把失败的片分轮重试，最多 3 轮、退避递增（0.6s / 1.2s / 1.8s）。
    // 并发读时一次抖动会同时打中多片，而「部分失败」会让整次同步被安全闸拒绝，
    // 所以这里值得多给几次机会（已读到的片不重复请求）。
    for (let round = 1; round <= 3; round++) {
      const failed = [];
      results.forEach(function (d, i) { if (!d) failed.push(i); });
      if (!failed.length) break;
      await sleep(600 * round);
      const again = await poolMap(failed, 6, function (i) { return readShardOnce(io, shardIds[i]); });
      failed.forEach(function (i, k) { results[i] = again[k]; });
    }

    let okCount = 0;
    const failIds = [];
    results.forEach(function (d, i) {
      if (d) { okCount++; Object.assign(merged.data, d); }
      else failIds.push(shardIds[i]);
    });
    merged.shardCount = shardIds.length;
    merged.shardOk = okCount;
    merged.shardFail = failIds.length;
    merged.shardFailIds = failIds;
    merged.shardErrors = io.lastShardErrors || [];
    // 世代号随 meta 一起返回：上层据此判断「云端是否被别的设备覆盖过」。
    merged.metaEpoch = (cloudMeta && cloudMeta.epoch) || null;
    return merged;
  }

  // 「索引列了 N 片、实际只读回 M 片」时统一用这句话中止。
  // 要点：① 已中止，两端都没动；② 这是可重试的瞬时问题，不是权限/配置问题。
  function shardIncompleteMsg(remote) {
    const ids = (remote && remote.shardFailIds) || [];
    const shown = ids.slice(0, 3).join('、') + (ids.length > 3 ? ' 等 ' + ids.length + ' 片' : '');
    const n = (remote && remote.shardFail) || 0;
    const total = (remote && remote.shardCount) || 0;
    // 附上真实失败原因（去重后最多列 3 条），否则用户只知道「没读到」却不知为何，
    // 排查只能靠猜。典型可辨识原因：429 配额、403 权限、分支名、网络断流。
    let why = '';
    const errs = (remote && remote.shardErrors) || [];
    if (errs.length) {
      // 按「错误类别」去重再展示：同一次限流会让每片都报一条几乎相同的消息，
      // 全列出来只是噪音。这里剥掉「读取 xxx.json」这类文件名片段后归类。
      const norm = function (s) {
        return String(s)
          .replace(/（[^）]*\.json[^）]*）/g, '')
          .replace(/读取\s*[^\s，。]+\.json/g, '读取分片')
          .trim();
      };
      const byKind = {};
      errs.forEach(function (e) {
        const raw = (e && e.msg) || '';
        if (!raw) return;
        const kind = norm(raw);
        if (!byKind[kind]) byKind[kind] = { kind: kind, ids: [], status: (e && e.status) || null };
        if (byKind[kind].ids.length < 4) byKind[kind].ids.push((e && e.sid) || '?');
      });
      const kinds = Object.keys(byKind);
      if (kinds.length) {
        why = '\n\n失败原因（来自 Gitee 返回）：';
        kinds.slice(0, 3).forEach(function (k) {
          const v = byKind[k];
          // 按「分片」去重计数：同片在重试中会留下多条，计数要去重才准确。
          const sidSet = {};
          errs.forEach(function (e) {
            if (norm((e && e.msg) || '') === k) sidSet[(e && e.sid) || '?'] = 1;
          });
          const n = Object.keys(sidSet).length;
          why += '\n  · ' + k + '（影响 ' + n + ' 片：' + v.ids.join('、') +
            (n > v.ids.length ? ' 等' : '') + '）';
          if (v.status === 429) {
            why += '\n    → 这是 Gitee 的调用次数限流，等约 1 分钟后重试即可，与数据本身无关。';
          }
        });
      }
    }
    return '云端有 ' + n + ' / ' + total + ' 个数据分片这次没读到（' + shown + '）。\n' +
      '为避免用不完整的数据覆盖云端（那会把没读到的那些片从云端删掉），本次同步已中止。' + why;
  }

  // ============ GitHub（Gist）侧的 io 实现 ============
  // Gist 的特别之处：一次 PATCH 可以把多个文件一起提交（天然批量），
  // 且未列出的文件保持不变 —— 这也是最早用 Gist 的原因。
  const gistIO = {
    origin: 'github',
    label: 'GitHub',
    ensureTarget: async function () {
      if (!cachedGistId()) await findOrCreateGist();
      return GIST_ID;
    },
    getMeta: async function () {
      let g;
      try {
        g = await apiCall('GET', '/gists/' + GIST_ID);
      } catch (e) {
        if (isNotFound(e)) { clearGistCache(); throw new Error('云端同步文件不存在（可能已被删除），请重新上传一次'); }
        throw e;
      }
      const mf = g.files && g.files[META_FILENAME];
      if (!mf || !mf.content) return null;
      try { return JSON.parse(mf.content); } catch (e) { return null; }
    },
    // Gist 单文件超 1MB 时 content 是截断的，必须改走 raw_url
    getFile: async function (name) {
      const g = await apiCall('GET', '/gists/' + GIST_ID);
      const f = g.files && g.files[name];
      if (!f) return null;
      if (f.truncated || !f.content) {
        const raw = await fetchRetry(f.raw_url, { cache: 'no-store' }, 3, name + ' 下载');
        return await raw.text();
      }
      return f.content;
    },
    putFiles: async function (map) {
      const files = {};
      for (const name in map) files[name] = { content: map[name] };
      await apiCall('PATCH', '/gists/' + GIST_ID, { files: files });
    },
    deleteFiles: async function (names) {
      const files = {};
      names.forEach(function (n) { files[n] = null; });   // Gist 里置 null 即删除
      await apiCall('PATCH', '/gists/' + GIST_ID, { files: files });
    }
  };

  // 兼容旧调用点：GitHub 路径继续走这两个名字
  function writeSharded(allData, forceShards, opts) { return writeShardedWith(gistIO, allData, forceShards, opts); }
  function readShardedMeta() { return readShardedMetaWith(gistIO); }
  function readSharded(cloudMeta) { return readShardedWith(gistIO, cloudMeta); }

  // 数据收集 / 应用
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

  // 本次同步「真正参与同步的数据量」= 所有非排除键的 (value.length + key.length) 之和。
  // 口径与 buildMergedUpload / entryBytes 一致（都是按字符串长度估），
  // 且**排除 EXCLUDE_***，否则「总量」里会混进几个 600KB 的背景图与埋点垃圾，
  // 用户会看到「同步了 1.2MB」其实业务数据只有 300KB。
  function syncPayloadBytes() {
    let total = 0;
    let keys = [];
    try { keys = getLocalKeys(); } catch (e) { return 0; }
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      let v = null;
      try { v = localStorage.getItem(key); } catch (e) { continue; }
      if (v == null) continue;
      if (isExcludedKey(key, v)) continue;
      total += v.length + key.length;
    }
    return total;
  }

  // 同步总量的「人话」描述：`73 键 / 348KB → 74 键 / 349KB（+1 键 +1.2KB）`
  function describeTotal(beforeCount, beforeBytes, afterCount, afterBytes) {
    const dk = afterCount - beforeCount;
    const db = afterBytes - beforeBytes;
    const head = beforeCount + ' 键 / ' + humanBytes(beforeBytes) +
      ' → ' + afterCount + ' 键 / ' + humanBytes(afterBytes);
    if (!dk && !db) return head + '（无变化）';
    const parts = [];
    if (dk) parts.push(signed(dk) + ' 键');
    if (db) parts.push((db > 0 ? '+' : '-') + humanBytes(Math.abs(db)));
    return head + '（' + parts.join(' ') + '）';
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

  // ============ 覆盖前把关（2026-10-13 新增）============
  // applyCloudToLocal 会先清光本机可同步键、再写云端那份 ⇒ **云端没有的本机键会被删除**。
  // 过去覆盖路径既不告知也不留快照（只有 merge + 世代更新才走 alignToGeneration 留档），
  // 于是「某朵云缺某个键」时，一次覆盖就能把本机那份悄悄抹掉 —— 实测踩过（案例展示）。
  // 这里给出：① 会被删的键清单（给确认框）② 快照（可找回）③ 回执里报数。
  function localOnlyKeys(serverData) {
    const sdata = (serverData && serverData.data) || {};
    const out = {};
    const keys = getLocalKeys();
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (Object.prototype.hasOwnProperty.call(sdata, k)) continue;
      try { out[k] = localStorage.getItem(k) || ''; } catch (e) { out[k] = ''; }
    }
    return out;
  }

  function describeKeyList(names, max) {
    const n = Math.max(1, max || 8);
    const head = names.slice(0, n).map(function (k) {
      let lb = k;
      try { lb = (typeof labelOfKey === 'function' ? labelOfKey(k) : k) || k; } catch (e) { }
      return '· ' + lb + '（' + k + '）';
    }).join('\n');
    return names.length > n ? head + '\n· …等共 ' + names.length + ' 项' : head;
  }

  function latestSnapshot() {
    try {
      const arr = JSON.parse(localStorage.getItem(EPOCH_SNAP_KEY) || '[]') || [];
      return (Array.isArray(arr) && arr.length) ? arr[0] : null;
    } catch (e) { return null; }
  }

  async function restoreSnapshot() {
    const sn = latestSnapshot();
    if (!sn) { notifyFail('没有可找回的快照', '本机还没有留下「覆盖前」的快照。'); return; }
    const names = sn.keys || [];
    const withData = Object.keys(sn.data || {});
    let when = '';
    try { when = new Date(Number(sn.at) || 0).toLocaleString('zh-CN'); } catch (e) { }
    const ok = await showConfirm('找回覆盖前的数据',
      '快照时间：' + (when || '未知') + '\n共 ' + names.length + ' 项' +
      (sn.truncated ? '（其中 ' + withData.length + ' 项带内容，其余因体积超限只留了键名）' : '') + '：\n' +
      describeKeyList(names, 8) +
      '\n\n确定把这些数据写回本机吗？（会覆盖本机同名的当前值）', '确定找回');
    if (!ok) return;
    let n = 0;
    for (let i = 0; i < withData.length; i++) {
      const k = withData[i];
      try { localStorage.setItem(k, sn.data[k]); n++; } catch (e) { }
    }
    try { refreshToolData({ all: true }); } catch (e) { }
    notifyOK('已找回 ' + n + ' 项覆盖前的数据',
      '共 ' + names.length + ' 项在快照里，' + n + ' 项带内容已写回；其余只有键名（体积超限）。');
  }

  function reloadActiveIframe() {
    // v2：下载覆盖后必须刷新【全部】工具 iframe —— 所有 iframe 在 buildIframes 时
    // 已带 src 常驻，只刷当前激活的话，其余 iframe 内存里仍是旧数据，
    // 用户切回去一旦编辑保存，旧数据会覆盖刚下载的新数据
    document.querySelectorAll('#toolContainer iframe').forEach(function (f) {
      if (f.src) f.src = f.src;
    });
  }

  // ============ 后台同步不打断正在编辑的工具（v9）============
  // 背景：doDownload / doSyncBoth 过去每次成功都调 reloadActiveIframe() —— 给【所有】
  //   iframe 换 src。那是为了防「iframe 内存里是旧数据，用户一保存就把刚合并进来的
  //   新数据覆盖掉」。代价是：自动同步在后台跑一次，用户正在填的表就被清空、界面自己跳。
  // 所以拆成三步，任何一步都能独立降级：
  //   ① 没变就不刷 —— 只有本次真的往本机写了键才考虑重载。自动同步绝大多数是
  //      「两端已一致」，于是「什么都没变也把工具页刷一遍」的打扰直接消失。
  //   ② 只刷相关的 —— 按 shardOfKey 把变化键归到模块，只重载「数据真被改过」的那些工具。
  //   ③ 不刷正在用的 —— 后台（silent）同步时，当前打开的那个工具登记为「待重载」，
  //      等用户切走 / 页面隐藏 / 点「立即刷新」时才真正执行。用户看到的界面永不自己跳。
  //   已知残留窗口（不掩盖）：待重载期间若用户刚好在该工具里保存，保存的是旧内存态。
  //   窗口由 ③ 的三个触发点压到最小 —— 它们都发生在用户离开该工具的瞬间。
  const pendingReload = Object.create(null);   // moduleId -> 1
  let reloadHintEl = null;

  function moduleIds() {
    try {
      if (typeof MODULES !== 'undefined' && Array.isArray(MODULES)) {
        return MODULES.map(function (m) { return m.id; });
      }
    } catch (e) {}
    return [];
  }

  // 当前真正显示在屏幕上的工具，以 DOM 为准而不是靠 localStorage 推断 ——
  // 用户可能打开工具后又切回仪表盘，此时那个 iframe 是隐藏的，刷它无害。
  function activeFrameId() {
    const b = document.querySelector('#toolContainer .tool-container.active');
    return b && b.id && b.id.indexOf('frame-') === 0 ? b.id.slice(6) : '';
  }

  // 只统计「真的加载过」的帧：没 src 的是懒加载还没触发，切过去自然会新加载。
  function loadedFrameIds() {
    const out = [];
    document.querySelectorAll('#toolContainer .tool-container').forEach(function (b) {
      if (!b.id || b.id.indexOf('frame-') !== 0) return;
      const f = b.querySelector('iframe');
      if (f && f.getAttribute('src')) out.push(b.id.slice(6));
    });
    return out;
  }

  function reloadModule(id) {
    const b = document.getElementById('frame-' + id);
    const f = b && b.querySelector('iframe');
    if (!f || !f.getAttribute('src')) return false;
    if (typeof window.reloadFrame === 'function') {
      try { window.reloadFrame(id); return true; } catch (e) {}
    }
    f.src = f.src;                       // 兜底：reloadFrame 不在时直接换 src
    return true;
  }

  // 变化键 → 该刷哪些模块。返回 null 表示「认不出来，全刷」（保守）。
  function modulesOfKeys(keys) {
    const ids = moduleIds();
    if (!ids.length) return null;
    const hit = Object.create(null);
    const miss = [];
    for (let i = 0; i < keys.length; i++) {
      // ★ 导航页自己的状态键（AUTO_IGNORE_PREFIXES：hub_* / __hub_* / ehub_autosync）不属于任何工具页：
      //   「本机这条写入不必触发同步」与「没有工具页需要为它重载」是同一个事实的两面。
      //   若不跳过，它们会走 shardOfKey 的兜底 → 例如 hub_lastModule → 'hub' → 不是模块 id
      //   → 整个函数退化成「全刷」。而 hub_lastModule **每次切换工具都会变**、
      //   hub_versions_cache_v1 每次查版本都会变，两端又不一致 —— 也就是说
      //   **几乎每一次同步都会带回一条 hub_* 的更新，于是每一次同步都退化成全刷**，
      //   用户切到别的工具时会发现滚动位置/展开状态全被重置。
      //   这条跳过其实比补 MODULES 名单更要紧，别删。
      if (isAutoIgnoredKey(keys[i])) continue;
      const id = shardOfKey(keys[i]);
      // 认不出来 → 保守退化成「全刷所有已加载工具页」。不会漏刷（因此不会丢数据），
      // 但它同时是「登记表有缺口」的症状：动一个没登记的键就要把所有工具页刷一遍。
      // 这里把缺口键名报出来，让问题自己暴露，不用等人去猜 —— 只 warn，不弹窗、不打扰。
      // 补法：把键登记进 index.html 的 MODULES[].keys（登记 cpa_x 即可覆盖 cpa_x_*）。
      if (ids.indexOf(id) < 0) { if (miss.indexOf(keys[i]) < 0) miss.push(keys[i]); }
      else hit[id] = 1;
    }
    if (miss.length) {
      try {
        console.warn('[sync] 这些键没有登记到任何模块，本次同步退化为「刷新全部工具页」：' +
          miss.join(', ') + '（请登记进 index.html 的 MODULES[].keys）');
      } catch (e) {}
    }
    return miss.length ? null : Object.keys(hit);
  }

  // 侧栏那行「云端有新数据 · 立即刷新」提示。只在有待重载时出现，不进弹窗、不打断。
  function ensureReloadHint() {
    if (reloadHintEl && reloadHintEl.isConnected) return reloadHintEl;
    const foot = document.querySelector('.sidebar .side-foot') || document.querySelector('.side-foot');
    if (!foot) return null;
    reloadHintEl = document.createElement('div');
    reloadHintEl.id = 'reloadHint';
    reloadHintEl.style.cssText = 'display:none;font-size:11px;line-height:1.7;color:#8ea2c0;padding:2px 8px';
    reloadHintEl.innerHTML = '☁️ 云端有新数据，切走本工具后生效 ' +
      '<a href="#" id="reloadHintBtn" style="color:#4ea1ff;text-decoration:none;white-space:nowrap">立即刷新</a>';
    const syncRow = document.getElementById('syncStatusBtn');
    if (syncRow && syncRow.nextSibling) foot.insertBefore(reloadHintEl, syncRow.nextSibling);
    else foot.appendChild(reloadHintEl);
    reloadHintEl.querySelector('#reloadHintBtn').addEventListener('click', function (e) {
      e.preventDefault();
      flushPendingReload();
    });
    return reloadHintEl;
  }

  function renderReloadHint() {
    const el = ensureReloadHint();
    if (!el) return;
    el.style.display = Object.keys(pendingReload).length ? 'block' : 'none';
  }

  // 真正执行重载。keepId = 刚切过去的那个模块，跳过它
  // （否则用户在同一个工具里点了两下导航，页面就被刷了）。
  function flushPendingReload(keepId) {
    const ids = Object.keys(pendingReload);
    let n = 0;
    ids.forEach(function (id) {
      delete pendingReload[id];
      if (id === keepId) { pendingReload[id] = 1; return; }   // 还得留着，等下次时机
      if (reloadModule(id)) n++;
    });
    renderReloadHint();
    return n;
  }

  // 统一入口：把「同步写进了本机哪些键」翻译成「该刷哪几个工具页」。
  //   opts.silent  true = 这次是后台自动同步 → 绝不刷用户当前正开着的工具
  //   opts.keys    本次真正写入本机的键（[] = 什么都没写 → 一个都不刷）
  //   opts.all     true = 覆盖式（云端整体替换本机）→ 全部刷
  function refreshToolData(opts) {
    opts = opts || {};
    const silent = !!opts.silent;
    const loaded = loadedFrameIds();
    if (!loaded.length) { renderReloadHint(); return { reloaded: [], deferred: [] }; }
    let targets;
    if (opts.all) {
      targets = loaded.slice();
    } else if (!Array.isArray(opts.keys)) {
      targets = loaded.slice();                          // 调用方没说改了啥 → 全刷
    } else if (!opts.keys.length) {
      targets = [];                                      // 一个键都没写 → 不刷
    } else {
      const mods = modulesOfKeys(opts.keys);
      targets = mods === null ? loaded.slice() : loaded.filter(function (id) {
        return mods.indexOf(id) >= 0;
      });
    }
    const active = activeFrameId();
    const reloaded = [], deferred = [];
    targets.forEach(function (id) {
      if (silent && id === active) { pendingReload[id] = 1; deferred.push(id); return; }
      if (reloadModule(id)) reloaded.push(id);
    });
    renderReloadHint();
    return { reloaded: reloaded, deferred: deferred };
  }

  // 三个「可以安全动手」的时机：切工具（切走的那个已不可见）、页面切走（用户不在看）、
  // 用户自己点「立即刷新」。除这三处，待重载就一直等着 —— 宁可晚合并，不可丢输入。
  (function installReloadFlush() {
    try {
      if (typeof window.openModule === 'function' && !window.openModule.__reloadWrapped) {
        const orig = window.openModule;
        const wrapped = function (t, i) {
          orig(t, i);
          if (Object.keys(pendingReload).length) {
            setTimeout(function () { flushPendingReload(t === 'tool' ? i : ''); }, 80);
          }
        };
        wrapped.__reloadWrapped = true;
        window.openModule = wrapped;
      }
    } catch (e) {}
    try {
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) flushPendingReload();
      });
    } catch (e) {}
  })();

  // 补上「已配置、但尚未初始化」的连接态。
  // 背景（2026-10-13 Tom 真机复现）：isConnected 只在【页面加载】时由 initSync()
  //   为【当时激活的后端】初始化。默认后端是 Gitee ⇒ 用户切到 GitHub 后 isConnected
  //   恒为 false ⇒ 上传 / 下载 / 双向同步一律先关面板再弹「配置云端同步」，
  //   哪怕 github_token 早就配好了。此函数供「切后端」与「动作入口」两处调用。
  // 返回 true = 连接可用（不发多余的请求：有 gist 缓存时零网络）。
  async function ensureGithubConnected() {
    if (isConnected) return true;
    if (!GITHUB_TOKEN) return false;          // 真没配置：交给调用方弹配置窗
    updateStatus('连接中…');
    try {
      if (!cachedGistId()) await findOrCreateGist();
      isConnected = true;
      updateStatus('已连接');
      return true;
    } catch (e) {
      console.warn('[GitHub] 自动连接失败:', e && e.message);
      isConnected = false;
      updateStatus('连接失败');
      return false;
    }
  }

  // ============ 动作：上传 / 下载 ============
  async function doUpload() {
    if (!await ensureGithubConnected()) { showConfigModal(); return; }
    // ★ 全局互斥：手动上传与后台自动同步共用一把锁，抢不到就排队等（绝不并发写云端）
    if (!await syncBeginManual('上传')) { syncBusyNotice(); return; }
    // 立刻反馈「开始了」：没有这个提示，用户点完看不到任何动静，会以为没响应
    progShow('running', '正在上传到云端…', '正在检查远端分片、只重传改动过的片，稍等片刻。');
    progBusy(true);
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
        if (choice === 'cancel') {
          // 必须复位进度区与按钮：doUpload 开头调了 progBusy(true) 禁用两颗按钮，
          // 这里直接 return 会让按钮永久变灰 —— 用户接着点「下载」毫无反应，
          // 会把「按钮是灰的」误读成「下载功能坏了 / 下载不弹窗」。
          // doDownload 的取消分支与 Gitee 侧两处取消都有这段，唯独这里漏了。
          updateStatus('已取消上传');
          progShow('running', '已取消上传', '云端数据未改动。');
          progBusy(false);
          return;
        }
        mode = choice;
      }
      let localData;
      if (mode === 'merge') {
        // 合并：以云端为本底，逐键取较新（需要读到云端内容；缓存里没有就联网读一次）
        let remote = await readGist();
        if (!remote || !remote.data) remote = { data: {} };
        // ★ 世代闸门：本机若停留在被「覆盖」掉的旧世代，这批数据上传上去就等于撤销那次覆盖
        //   ⇒ 本次直接不下发（本机数据一行不动）。对齐交由「下载 / 双向同步」完成，
        //     那时会先给本机留一份快照，用户可找回。
        //   ⚠️ 这里用只读判断、**不能**调 noteCloudEpoch：一记账，后一次「双向同步」就
        //     以为世代已承认而不去对齐，本机旧数据又会被并回云端。
        if (epochNewerThanSeen(remote.metaEpoch)) {
          updateStatus('已按世代跳过上传');
          progBusy(false);
          notifyOK('本次未上传：云端已被另一台设备覆盖',
            epochNoticeText(remote.metaEpoch) +
            '\n为避免把那次「覆盖」撤销，本次「合并上传」已跳过，本机数据未改动。' +
            '\n稍后点「下载 → 合并到本机」即可让本机对齐到云端（对齐前会自动留一份本机快照）。');
          return;
        }
        localData = buildMergedUpload(remote);
      } else {
        localData = collectLocalData();
      }
      let bodyLen = 0;
      let shardInfo = null;
      const payloadData = localData;
      // ★ 「覆盖」是唯一会推进世代号的操作（见 writeShardedWith 里的 opts.overwrite）。
      const wOpts = mode === 'overwrite' ? { overwrite: true } : null;
      try {
        shardInfo = await writeSharded(payloadData, false, wOpts);
        bodyLen = shardInfo.wroteBytes;
      } catch (e) {
        if (!isNotFound(e)) throw e;
        clearGistCache();                 // 缓存的 Gist 已被删：重建后重试一次
        await findOrCreateGist();
        shardInfo = await writeSharded(payloadData, true, wOpts);
        bodyLen = shardInfo.wroteBytes;
      }
      // 覆盖成功后立刻承认「这就是本机所在的世代」，免得本机下一次同步把自己当陈旧设备。
      if (shardInfo && shardInfo.meta && shardInfo.meta.epoch) {
        setEpochSeen(shardInfo.meta.epoch.n, shardInfo.meta.epoch.at);
      }
      const kb = Math.round(bodyLen / 1024);
      const nItem = Object.keys(localData).length;
      setCachedCloudHasData(true);
      lastSyncTime = String(Date.now());
      localStorage.setItem('sync_last_sync', lastSyncTime);
      // 记到侧边栏：最近同步时间 + 这次同步了哪些项目
      if (window.BackupHub && window.BackupHub.markSync) {
        try { window.BackupHub.markSync('up', Object.keys(localData)); } catch (e) {}
      }
      updateStatus('已上传 ' + fmtTime(lastSyncTime));
      // ★ 覆盖成功后开一个静默窗口：这段时间内后台自动同步让路 ——
      //   否则它会立刻把「刚刚覆盖上去的这份」再和另一端合并回来，「覆盖」形同虚设。
      if (mode === 'overwrite') syncHoldNow(SYNC_HOLD_MS);
      // 刻意不再 closeTopModal()：关掉面板会让回执无处可显示（只剩侧边栏），
      // 用户就看不到这次同步的具体结果了。结果由 notifyOK 写进面板内的状态区。
      // 压缩后仍偏大时给出明确预警：下载会慢，且会走 raw 通道（国内易断）
      const sizeTip = kb > 1024
        ? '\n⚠️ 本次写入 ' + kb + 'KB，超过云端单文件 1MB 的直读阈值，另一台设备下载会明显慢一些。'
        : '';
      const shardTip = shardInfo
        ? `\n本次只更新了 ${shardInfo.wroteShards} / ${shardInfo.totalShards} 个数据片` +
          (shardInfo.skippedShards > 0 ? `（跳过 ${shardInfo.skippedShards} 个未变化的片，省流量）` : '') + '。'
        : '';
      const gateTip = lastGateSkipped.length
        ? '\n\n⚠️ 另有 ' + lastGateSkipped.length + ' 项本机数据本次未上传（属于上次「覆盖云端」之前的旧数据，' +
          '云端已存有同名的一份，按「以云端为准」跳过）：\n   ' +
          lastGateSkipped.slice(0, 5).join('、') +
          (lastGateSkipped.length > 5 ? ' 等' : '') +
          '\n   若其中有你刚改过的东西，先在本机点「下载 → 覆盖本机」让两端对齐，再改一次即可传上去。'
        : '';
      notifyOK(mode === 'merge' ? '已合并上传到云端' : '已上传到云端',
        (mode === 'merge'
          ? `两边数据已按「较新保留」合并，共 ${nItem} 项。`
          : `本机的 ${nItem} 项数据已存到云端。`) +
        shardTip + `\n本次写入约 ${kb}KB（已压缩）。` + sizeTip + gateTip +
        '\n在手机 / 其他电脑点「云端 → 本机」就能同步过去。');
    } catch (e) {
      console.warn('[GitHub] 上传失败:', e.message);
      notifyFail('上传云端失败',
        (e && e.message ? e.message : String(e)) + '\n请检查网络或 Token 是否有效（可点「重新配置 Token」）。');
      updateStatus('上传失败');
    } finally { syncUnlock(); }
  }

  async function doDownload() {
    if (!await ensureGithubConnected()) { showConfigModal(); return; }
    // ★ 全局互斥（同上传）
    if (!await syncBeginManual('下载')) { syncBusyNotice(); return; }
    progShow('running', '正在检查云端数据…', '先读一份很小的索引文件。');
    progBusy(true);
    try {
      // 提速：Gist ID 有缓存就直连读，不再先拉一遍全列表
      if (!cachedGistId()) await findOrCreateGist();
      // ★ 顺序与 Gitee 侧严格一致：读索引 → 弹窗定模式 → 再读数据。
      //   原因是实测出来的：旧顺序下弹窗被压在「读完全部分片」之后
      //   （350ms/请求下，上传在 0~2 个请求后弹、下载要 6~7 个请求后才弹），
      //   数据一大弹窗就要等好几秒，用户会以为根本不会弹。
      let meta0 = null;
      try {
        meta0 = await readShardedMeta();
      } catch (e) {
        throw new Error('读取云端失败：' + (e && e.message ? e.message : e) + '，请检查网络后重试');
      }
      const hasShards = !!(meta0 && meta0.shards && Object.keys(meta0.shards).length);
      let pre = null;
      if (!hasShards) {
        // 没有分片索引：可能是旧的单文件格式，也可能真的空 —— 这时才读全量
        pre = await readGist();
      }
      const cloudHas = hasShards
        || !!(pre && pre.data && Object.keys(pre.data).length > 0);
      if (!cloudHas) {
        progShow('fail', '云端还没有数据', '请先在一部设备上点「上传到云端」，再来这里下载。');
        progBusy(false);
        return;
      }
      // 一律问，不再看「本机有没有数据」决定要不要问 —— 与 Gitee 侧同语义，
      // 面板帮助文案承诺的就是「下载点完会让你选」。
      const localHas = getLocalKeys().length > 0;
      const choice = await showChoice('下载到本机',
        (localHas
          ? '本机已经存有数据。\n'
          : '本机暂时没有可同步的数据，下面两种方式结果相同。\n') +
        '「合并」保留两边较新的数据，不会丢任何一边；\n「覆盖本机」用【云端数据】整体替换本机。',
        '合并到本机', '覆盖本机');
      let mode = 'overwrite';
      if (choice === 'cancel') {
        updateStatus('已取消下载');
        progShow('running', '已取消下载', '本机数据未改动。');
        progBusy(false);
        return;
      }
      mode = choice;
      // 模式定了才去读数据：进度文案如实反映「现在在读」而不是"正在合并"。
      progShow('running', '正在读取云端数据…',
        mode === 'merge' ? '按「合并到本机」处理：两边逐项取较新的。'
                         : '按「覆盖本机」处理：用云端数据整体替换本机。');
      const remote = pre ? pre : await readSharded(meta0);
      setCachedCloudHasData(true);
      // ★ 世代检测：云端若在别的设备上被「覆盖」过，早于那一刻的本机数据属于旧世代。
      //   合并式下先做「世代对齐」（以云端为准 + 留快照），否则本机独有数据会在下一次
      //   合并时被云端取代、却先被传上去把覆盖撤销。
      const genNewer = noteCloudEpoch(remote.metaEpoch);
      let genAlign = null;
      if (genNewer && mode === 'merge') {
        genAlign = alignToGeneration(remote, remote.metaEpoch);
      }
      const genTip = genNewer ? '\n\n' + epochNoticeText(remote.metaEpoch) : '';
      // ⚠️ 顺序调整后必须补的安全闸：索引里记着有分片、实际读不回来时，
      //    若不拦就轮到下面执行「覆盖本机」——而 applyCloudToLocal 会先清光本机
      //    可同步键，等于把本机数据清空。这里一律中止，本机数据保持不动。
      //    ⚠️ 判据不能只看「一片都没读到」：**少读了一片**同样危险 ——
      //    合并/覆盖之后那一片的键在本机就消失了，用户收不到任何提示。
      if (!remote || !remote.data || !Object.keys(remote.data).length || remote.shardFail > 0) {
        progShow('fail', '云端数据读取失败',
          shardIncompleteMsg(remote) + '\n已中止，本机数据未改动。');
        progBusy(false);
        return;
      }
      let mergeStats = null;
      let owSnap = 0;
      if (mode === 'merge') {
        mergeStats = mergeCloudToLocal(remote);
      } else {
        // ★ 覆盖前把关：云端没有的本机键会被删掉 ⇒ 先告知、再留快照，用户确认后才动。
        const only = localOnlyKeys(remote);
        const onlyNames = Object.keys(only);
        if (onlyNames.length) {
          const go = await showConfirm('覆盖将删除 ' + onlyNames.length + ' 项本机数据',
            '下面这些数据【本机有、云端没有】：\n' + describeKeyList(onlyNames, 8) +
            '\n\n「覆盖本机」会先清掉本机全部可同步数据、再写入云端那一份，' +
            '因此上面这些会被删除。\n动手前会先留一份快照，可在同步面板「↩️ 找回覆盖前的数据」恢复。');
          if (!go) {
            updateStatus('已取消下载');
            progShow('running', '已取消下载（未删除任何数据）', '本机数据未改动。');
            progBusy(false);
            return;
          }
          owSnap = snapshotStaleKeys(only, Date.now(), null) ? onlyNames.length : 0;
        }
        applyCloudToLocal(remote);
      }
      // 手动操作：用户刚点了按钮，期望马上看到结果 → 立刻刷新受影响的工具页（不延迟）。
      // 覆盖式（applyCloudToLocal）动了全部键，只能全刷；合并式只刷数据真被改过的那些。
      refreshToolData(mode === 'merge' && mergeStats
        ? { keys: mergeStats.keys || [] }
        : { all: true });
      if (typeof buildCards === 'function') buildCards();
      lastSyncTime = String(Date.now());
      localStorage.setItem('sync_last_sync', lastSyncTime);
      // 记到侧边栏：最近同步时间 + 这次同步了哪些项目
      if (window.BackupHub && window.BackupHub.markSync) {
        try { window.BackupHub.markSync('down', Object.keys(remote.data)); } catch (e) {}
      }
      updateStatus('已下载 ' + fmtTime(lastSyncTime));
      if (mode === 'overwrite') syncHoldNow(SYNC_HOLD_MS);   // 覆盖成功后：给自动同步让路（同上）
      // 同上传：不关面板，让结果留在原地可见
      notifyOK(mode === 'merge' ? '已合并云端数据到本机' : '已从云端同步到本机',
        (mode === 'merge'
          ? `合并完成：新增 ${mergeStats.added} 项，更新 ${mergeStats.updated} 项（云端较新），保留本机 ${mergeStats.kept} 项。\n` +
            '数据有变动的工具页已刷新，其余工具页保持原状（避免打断正在填写的表单）。'
          : `云端的 ${Object.keys(remote.data).length} 项数据已写入本机。\n` +
            '数据有变动的工具页已刷新，其余工具页保持原状（避免打断正在填写的表单）。') +
        genTip +
        (owSnap ? '\n（覆盖前已把 ' + owSnap + ' 项云端没有的本机数据存进快照，' +
          '可在同步面板「↩️ 找回覆盖前的数据」恢复。）' : '') +
        (genAlign ? '\n（世代对齐：' + genAlign.stale.length + ' 项旧世代的本机数据已按云端处理，' +
          '其中 ' + genAlign.removed + ' 项云端没有、已从本机移除；动手前已留快照，可找回。）' : ''));
    } catch (e) {
      console.warn('[GitHub] 下载失败:', e.message);
      notifyFail('从云端下载失败',
        (e && e.message ? e.message : String(e)) + '\n请检查网络或 Token 是否有效。本机数据未改动。');
      updateStatus('下载失败');
    } finally { syncUnlock(); }
  }

  // 双向同步：读云端 → 合并进本机 → 合并结果写回云端。
  // 与上传 / 下载的区别：不弹模式选择 —— 它永远只做合并，两端都不会被覆盖，
  // 也就没有需要用户决策的分支。这是它敢做成「一键」的前提。
  // opts.silent：自动同步走这条通道。
  //   为什么必须静默：notifyOK 在面板没开时会退化成站内通知卡（BackupHub.notify），
  //   自动同步每次成功都弹一张卡是纯噪音 —— 用户明明什么都没点。信息改由「留痕」承担
  //   （侧边栏第二行 / 面板明细块 / 面板内记录列表），随时可查但绝不打扰。
  //   无论静默与否都返回同步摘要，调用方（自动同步）靠它生成「同步了什么」。
  async function doSyncBoth(opts) {
    const silent = !!(opts && opts.silent);
    // 手动路径：先补一次连接（静默路径不动 —— 自动同步只在该连接时才会被调起）
    if (!isConnected && !silent) { await ensureGithubConnected(); }
    if (!isConnected) { if (!silent) showConfigModal(); return { error: '尚未连接云端' }; }
    // ★ 全局互斥：
    //   静默（后台自动同步）路径 —— 锁已由 runAutoSync 持有，这里不再抢，否则自己把自己锁死；
    //   手动路径 —— 自己抢锁，抢不到就排队等，绝不在别人跑的时候并发写云端。
    const _ownLock = !silent;
    if (_ownLock && !await syncBeginManual('双向同步')) { syncBusyNotice(); return { error: '同步进行中，本次已跳过' }; }
    const t0 = Date.now();
    // ★ 静默路径绝不写进度区 —— 这里是「点的是上传覆盖、界面却显示双向同步」的根因所在。
    if (!silent) {
      progShow('running', '正在双向同步…', '先读云端，与两端合并后同时更新本机与云端。两端都只会变全，不会丢数据。');
      progBusy(true);
    }
    try {
      if (!cachedGistId()) await findOrCreateGist();
      // 必须读「此刻」的云端：cloud-has-data 缓存是给上传的「要不要弹模式选择」用的，
      // 拿它跳过读云端，等于让合并建立在一个陈旧结论上。
      clearGistCache();
      const r = await runBothIO(
        function () { return readGist(); },
        function (data) { return writeSharded(data); }
      );
      setCachedCloudHasData(true);
      // 只有真的往本机写了键才重载相关工具页；silent（后台自动同步）时当前正开着的那个
      // 只登记不重载 —— 这就是「后台同步不再把已填好的内容冲掉」的落点。
      const changedKeys = (r.localStats && r.localStats.keys) || [];
      const reloadInfo = refreshToolData({ silent: silent, keys: changedKeys });
      if (typeof buildCards === 'function') buildCards();
      lastSyncTime = String(Date.now());
      localStorage.setItem('sync_last_sync', lastSyncTime);
      if (window.BackupHub && window.BackupHub.markSync) {
        try { window.BackupHub.markSync('both', getLocalKeys(), silent ? { auto: true } : null); } catch (e) {}
      }
      // 静默时不动状态条：那一行留给「已连接」+ 自动同步的独立第二行，
      // 否则自动同步一跑就把状态条刷成「已双向同步 xx」，反而看不出自动同步的节奏。
      if (!silent) updateStatus('已双向同步 ' + fmtTime(lastSyncTime));
      const st = r.localStats;
      if (!silent) {
        notifyOK('已完成双向同步',
          (r.epochNewer ? epochNoticeText(r.metaEpoch) + '\n\n' : '') +
          (r.epochNewer && r.alignStats
            ? '已做世代对齐：' + r.alignStats.stale.length + ' 项旧世代的本机数据按云端处理' +
              '（其中 ' + r.alignStats.removed + ' 项云端没有、已从本机移除；动手前已留快照）。\n\n'
            : '') +
          (r.hasRemote
            ? '云端 → 本机：新增 ' + st.added + ' 项，更新 ' + st.updated + ' 项，保留本机 ' + st.kept + ' 项' +
              (st.merged ? '，另有 ' + st.merged + ' 项按内容合并' : '') + '。\n'
            : '云端原本没有数据，本次已把本机的数据存过去。\n') +
          '本机 → 云端：本次写入 ' + ((r.info && r.info.wroteShards) || 0) + ' / ' +
            ((r.info && r.info.totalShards) || 0) + ' 个数据片' +
            ((r.info && r.info.skippedShards) ? '（跳过 ' + r.info.skippedShards + ' 个未变化的片）' : '') +
            '，共 ' + r.nItem + ' 项，约 ' + Math.round(((r.info && r.info.wroteBytes) || 0) / 1024) + 'KB（已压缩）。\n' +
          '两端现在一致，谁都没有被覆盖。');
      }
      return {
        mode: 'both', at: Date.now(), ms: Date.now() - t0, hasRemote: r.hasRemote,
        epochNewer: !!r.epochNewer, epoch: r.metaEpoch || null, align: r.alignStats || null,
        reload: reloadInfo,
        // 总量基线：同步前 / 后各算一次（after 在合并+上传都完成之后）
        total: (function () {
          const ac = getLocalKeys().length;
          const ab = syncPayloadBytes();
          return {
            beforeKeys: r.beforeCount || 0, beforeBytes: r.beforeBytes || 0,
            afterKeys: ac, afterBytes: ab,
            text: describeTotal(r.beforeCount || 0, r.beforeBytes || 0, ac, ab)
          };
        })(),
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
      console.warn('[GitHub] 双向同步失败:', e.message);
      if (!silent) {
        notifyFail('双向同步失败',
          (e && e.message ? e.message : String(e)) + '\n请检查网络或 Token 是否有效。本机与云端的数据都未曾被覆盖。');
        updateStatus('双向同步失败');
      }
      return { error: (e && e.message ? e.message : String(e)) };
    } finally { if (_ownLock) syncUnlock(); }
  }

  // ============ 自动双向同步（v8）============
  // 目标：数据一变就自动合并两端，并且「什么时候同步了 / 同步了什么」随时可查。
  //
  // ★ 本机的「数据变动」有两个来源，缺一不可 —— 下面这张表是实测结论，不是推测：
  //
  //   | 来源                          | setItem hook | storage 事件 |
  //   |-------------------------------|--------------|--------------|
  //   | 导航页自身写入                 | 能           | 不能（规范如此）|
  //   | iframe 内写入（工具页）        | 不能         | 能           |
  //
  //   所有工具页都跑在 #toolContainer 的 iframe 里，而 Storage 是 per-realm 的：
  //   覆写【导航页】的 localStorage.setItem 根本抓不到 iframe 里的写入（实测确认）。
  //   可靠途径是监听 window 的 'storage' 事件 —— 同源 iframe 写入时导航页会收到。
  //   两条路径都汇入 noteLocalChange()，去重后交给同一个节流器。
  //
  // ★ 自动同步永远只调 both（合并语义），永不覆盖。
  //   覆盖是唯一会「整端替换」的操作，必须由用户手动确认。自动覆盖是数据静默丢失的
  //   经典成因，这条底线不松。
  //
  // ★ 不做「一变就同步」：工具页一次编辑动作可能触发几十次 localStorage 写入，
  //   逐个同步会把仓库历史刷成几百条无意义 commit，也白白消耗 API 配额。
  //
  // ★ 反自激：自动同步自己写的键（AUTO_KEY）以及同步过程写的技术键
  //   （sync_last_sync / sync_timestamps / __hub_*）都被挡掉，否则「同步把结果写回本机」
  //   会被当成「用户改了数据」→ 立刻再同步 → 无限循环。
  const AUTO_KEY = 'ehub_autosync_v1';
  // ★ 2026-10-10 修复：'hide' 兜底豁免 minGap（此前「改完切走 App」的数据会被节流拦掉）。

  // ============ 同步记录：把 localStorage 键翻成人看得懂的名字 ============
  // 为什么需要：同步留痕以前只写原始键名（`chaomuji_web_v27`），
  // 用户既不知道那是哪个工具，也不知道改的是哪一块。
  // 现在翻成「模块名 · 用途」，并带上本次同步的总量变化。
  //
  // 维护约定：**新增一个会同步的键，就在这儿加一行**。
  // 加不上也不要紧 —— describeKeys 会退回「模块名 · 原始键名」，不会显示成空白。
  const KEY_LABELS = {
    // ---- 朝暮计 ----
    'chaomuji_web_v27': '主数据',
    'chaomuji_web_v27_bg': '页面背景',
    'chaomuji_web_v27_cardbg': '卡片背景',
    'chaomuji_web_v27_hcardbg': '习惯卡背景',
    'chaomuji_web_v27_drawexpand': '抽屉展开状态',
    'chaomuji_web_v27_paste_tpl': '批量粘贴模板',
    'chaomuji_web_v27_schedmonth': '月历折叠状态',
    'chaomuji_web_v27_remindlog': '提醒去重日志',
    'chaomuji_web_v27_dailylog': '每日提醒日志',
    'chaomuji_web_v27_lsquota': '本机配额实测',
    'chaomuji_web_v27_lunarcache': '农历缓存',
    'chaomuji_todos': '待办清单',
    'chaomuji_records': '打卡记录',
    'chaomuji_custom_cats': '自定义分类',
    'chaomuji_habit_list': '习惯清单',
    'chaomuji_cats': '分类',
    'chaomuji_diary_v1': '日记正文',
    'chaomuji_diary_tags_v1': '日记标签',
    'chaomuji_backups_v1': '本机快照仓',
    'chaomuji_pomo_count': '番茄钟计数',
    'chaomuji_focus_min': '专注分钟',
    'zmv_view_mode': '视图模式',
    'dreamDiaries': '梦想日记',
    'dreamGoals': '梦想目标',
    // ---- CPA 学习工具 ----
    // ★ 需求（2026-10-10）：「注明是哪个子页和哪个 tab」。
    //   下面这些键的值就是**工具页内的具体页签**（tools/cpa学习工具1.html 的 11 个 vtab：
    //   学习进度 / 学习记录 / 知识树 / 闪卡 / 记忆曲线 / 小节自检 / 整章复盘 /
    //   自检看板 / 自检热力图 / 错题本 / 目标），所以标签直接写页签名。
    'cpa_learning_data_v3': '学习进度·学习数据（全部项目）',
    'cpa_learning_data_v3_cpa': '学习进度·学习数据（CPA）',
    'cpa_study_projects_v1': '学习进度·考试项目列表',
    'cpa_study_current_project_v1': '学习进度·当前考试项目',
    'cpa_sidebar_folded_v1': '全工具·侧栏折叠',
    'cpa_appearance_v1': '全工具·外观设置',
    'cpa_font_scale': '全工具·字号',
    'cpa_user_guide_v1': '学习进度·新手引导',
    'kp_outline_no_v1': '知识树·编号模式',
    'hub_cpa_draft_v1': '学习记录·表单草稿',
    'hub_cpa_fc_backview_v1': '闪卡·背面模式',
    'hub_cpa_kp_cols_v1': '知识树·列数',
    'hub_cpa_kp_mode_v1': '知识树·编号模式',
    'hub_cpa_kp_sym_v1': '知识树·符号',
    'hub_cpa_kp_tmpl_v1': '知识树·编号模板',
    'hub_cpa_rec_kpview_v1': '学习记录·知识树视角',
    'hub_cpa_rec_show_v1': '学习记录·显示项',
    'hub_cpa_rec_tab_v1': '学习记录·当前页签',
    'accCheck_v3': '小节自检·存档',
    'accWrong_v3': '错题本·存档',
    'accMods_v3': '整章复盘·存档',
    'accPlan_v3': '目标·复习计划存档',
    'accCheck_v3_migrated': '小节自检·迁移标记',
    // ---- 工作管理 ----
    'workLogs': '工作日志',
    'workTodos': '待办',
    'workWeekly': '周报',
    'workStaff': '人员',
    'workCategories': '分类',
    // ---- 日记 ----
    'diary_app_data': '日记正文',
    'diary_app_draft': '写作草稿',
    'diary_editor_font': '编辑器字号',
    // ---- 时间统计 ----
    'timeRecords': '时间记录',
    'timeTodos': '待办',
    'timeCategoriesV2': '类别配置',
    'timeTimerState': '计时器状态',
    'timeTimerHistory': '计时历史',
    'timeDoneFolded': '已完成折叠',
    // ---- 信息研判 ----
    'multi_info_records': '研判记录',
    'info_categories': '分类',
    // ---- 阅读·思享 ----
    'reading_think_system_v1': '读书笔记与书单',
    // ---- 生活工作台 ----
    'wb_life_v1': '生活工作台数据',
    'organizer_items_v2': '收纳物品',
    'organizer_theme': '主题',
    'storage_categories': '物品分类',
    // ---- 恒星时间管理法 ----
    'stellar_tag_system_v2': '标签体系',
    'stellar_time_records': '时间记录',
    // ---- 琐碎时间 ----
    'idleManagerData_v15': '碎片时间数据',
    // ---- 偶像学习 ----
    'imitation_targets': '模仿对象',
    'good_habits': '好习惯',
    'daily_checklist': '每日清单',
    'bad_habits': '坏习惯',
    // ---- 健康管理 ----
    'mySleepData': '睡眠记录',
    'mySportData': '运动记录',
    'myWeightData': '体重记录',
    'myBpData': '血压记录',
    'myWaterData': '饮水记录',
    'myDietData': '饮食记录',
    'healthFoodDB': '自定义食物库',
    // ---- 人际交往 ----
    'comm_daily': '日复盘',
    'comm_week': '周复盘',
    'comm_month': '月复盘',
    'tool_dialog': '对话工具',
    'tool_relation': '关系工具',
    'tool_script': '话术工具',
    'action_plan_data': '行动计划',
    'action_categories': '行动分类',
    'wisdom_data': '智慧库',
    'if_then_plans': '执行意图',
    'if_then_categories': '执行意图分类',
    // ---- 学习目标管理 ----
    'wb_goal': '学习目标',
    'wb_goal_seeded': '目标播种标记',
    'wb_goal_draft': '目标草稿',
    'wb_ex': '练习记录',
    'wb_ex_seeded': '练习播种标记',
    // ---- 代码预览器 ----
    'previewer_html': 'HTML 代码',
    'previewer_css': 'CSS 代码',
    'previewer_js': 'JS 代码',
    // ---- 旅行助手 ----
    'roam_assistant': '行程数据',
    'roam_assistant_trips': '行程列表',
    'roam_assistant_active_trip': '当前行程',
    'roam_last_tab': '上次页签',
    // ---- 备考学习工作台 ----
    'wb_bk_profile': '备考档案',
    'wb_bk_subjects': '科目',
    'wb_bk_todos': '待办',
    'wb_bk_time': '学时',
    'wb_bk_checks': '验收记录',
    'wb_bk_reviews': '复习记录',
    'wb_bk_issues': '疑难',
    'wb_bk_gains': '感悟',
    'wb_bk_kps': '知识点',
    'wb_bk_kpch': '知识点章节',
    'wb_bk_heat': '掌握度热力图',
    'wb_bk_stg': '学习阶段',
    'wb_bk_hmmode': '热力图视图',
    'wb_bk_chs': '章节表',
    'cpaMasteryTree_v1': '掌握度台账·知识树',
    'cpaMasteryScore_v1': '掌握度台账·分数',
    'cpaMasterySub_v1': '掌握度台账·科目',
    'cpaTreeEditMode_v1': '知识树编辑模式',
    'cpaTreeLv_v1': '知识树层级',
    'cpaScoreCols_v1': '台账列设置',
    // ---- CPA 学习工具 · 通用外观（工具页自己实现的浮条 / 色板）----
    'hub_deco_v1': '标注装饰色',
    'hub_swatches_v1': '标注色位',
    'hub_swatch_def_v1': '标注默认色',
    'hub_text_v1': '标注文字色',
    // ---- 导航页 ----
    'hub_lastModule': '上次打开的工具',
    'hub_versions_cache_v1': '版本号缓存',
    'hub_patch': '前端补丁标记',
  };

  // 前缀兜底：登记了 `cpa_` 就能覆盖 `cpa_xxx`。
  // 只在 KEY_LABELS 精确匹配失败后才用它。
  const KEY_PREFIX_LABELS = [
    ['cpa_learning_data_v3', '学习数据'],
    ['cpa_study_', '考试项目'],
    ['cpa_', 'CPA 数据'],
    ['hub_cpa_rec_', '记录页设置'],
    ['hub_cpa_kp_', '知识树设置'],
    ['hub_cpa_', 'CPA 偏好'],
    ['accCheck_v3', '小节自检存档'],
    ['accWrong_v3', '错题本存档'],
    ['accMods_v3', '整章复盘存档'],
    ['accPlan_v3', '复习计划存档'],
    ['chaomuji_diary', '日记'],
    ['chaomuji_', '朝暮计数据'],
    ['zmv_', '朝暮计视图'],
    ['wb_bk_', '备考工作台'],
    ['wb_goal', '学习目标'],
    ['wb_ex', '练习记录'],
    ['wb_', 'WorkBuddy 数据'],
    ['work', '工作管理'],
    ['diary_', '日记'],
    ['time', '时间统计'],
    ['multi_info_', '信息研判'],
    ['info_', '信息研判'],
    ['reading_', '阅读·思享'],
    ['organizer_', '生活工作台'],
    ['storage_', '生活工作台'],
    ['stellar_', '恒星时间管理法'],
    ['idleManager', '琐碎时间'],
    ['imitation_', '偶像学习'],
    ['good_habits', '偶像学习'],
    ['bad_habits', '偶像学习'],
    ['daily_checklist', '偶像学习'],
    ['mySleepData', '健康管理'],
    ['mySportData', '健康管理'],
    ['myWeightData', '健康管理'],
    ['myBpData', '健康管理'],
    ['myWaterData', '健康管理'],
    ['myDietData', '健康管理'],
    ['healthFoodDB', '健康管理'],
    ['comm_', '人际交往'],
    ['tool_', '人际交往'],
    ['action_', '人际交往'],
    ['wisdom_', '人际交往'],
    ['if_then_', '人际交往'],
    ['previewer_', '代码预览器'],
    ['roam_', '旅行助手'],
    ['cpaMastery', '掌握度台账'],
    ['cpaTree', '掌握度知识树'],
    ['cpaScore', '掌握度台账'],
    ['hub_deco', '标注装饰色'],
    ['hub_swatch', '标注色板'],
    ['hub_text', '标注文字色'],
    ['hub_', '导航页状态'],
  ];

  // 键 → 该键所属模块的中文名。优先问 MODULES（单一真源），
  // 拿不到时才用静态表兜底（例如工具页里单独打开同步面板）。
  function moduleNameOf(key) {
    try {
      if (typeof MODULES !== 'undefined' && Array.isArray(MODULES)) {
        for (const m of MODULES) {
          if (!m || !m.keys) continue;
          for (const k of m.keys) {
            if (key === k || key.indexOf(k + '_') === 0) return m.name || m.id;
          }
        }
        // 兜底：用 shardOfKey 的 id 反查
        const sid = shardOfKey(key);
        const hit = MODULES.filter(function (m) { return m.id === sid; })[0];
        if (hit) return hit.name || hit.id;
      }
    } catch (e) {}
    return '';
  }

  // 键 → 用途短名
  function labelOfKey(key) {
    if (KEY_LABELS[key]) return KEY_LABELS[key];
    for (let i = 0; i < KEY_PREFIX_LABELS.length; i++) {
      const p = KEY_PREFIX_LABELS[i];
      if (key === p[0] || key.indexOf(p[0]) === 0) return p[1];
    }
    return key;                      // 兜底：显示原始键名，总比空白强
  }

  // 把键集合翻成「模块 · 用途」，同一模块的合并成一条
  // 例：[{mod:'朝暮计', items:['待办','专注分钟']}, ...]
  function describeKeys(keys) {
    const order = [];
    const byMod = Object.create(null);
    (keys || []).forEach(function (k) {
      const mod = moduleNameOf(k) || '其他';
      const lab = labelOfKey(k);
      if (!byMod[mod]) { byMod[mod] = []; order.push(mod); }
      if (byMod[mod].indexOf(lab) < 0) byMod[mod].push(lab);
    });
    return order.map(function (mod) {
      return { mod: mod, items: byMod[mod] };
    });
  }

  // 「涉及」那一段的文案。maxMods 控制最多列几个模块，其余归并。
  // 输出形如：`考证学习进度·学习记录·当前页签、朝暮计·待办 等 3 块`
  //   —— 模块名（=子页）+ 用途（=工具内的 tab / 区块）+ 块数。
  function describeKeysText(keys, maxMods) {
    const groups = describeKeys(keys);
    if (!groups.length) return '';
    const lim = maxMods || 3;
    const shown = groups.slice(0, lim).map(function (g) {
      return g.mod + '·' + g.items.slice(0, 3).join('/') +
        (g.items.length > 3 ? '等' + g.items.length + '项' : '');
    });
    const more = groups.length - shown.length;
    return shown.join('、') + (more > 0 ? ' 等 ' + groups.length + ' 块' : '');
  }

  // 字节数人话：<1KB 报 B，<1MB 报 KB，否则报 MB
  function humanBytes(n) {
    n = n || 0;
    if (n < 1024) return n + 'B';
    if (n < 1024 * 1024) return (Math.round(n / 1024)) + 'KB';
    return (n / 1024 / 1024).toFixed(1) + 'MB';
  }

  // 带符号的差值：+3 / -2 / 0
  function signed(n) { return (n > 0 ? '+' : '') + n; }

  // 这些键的写入不触发自动同步 —— 注意「触发」与「同步」是两件事：
  // 不触发 ≠ 不同步，数据本身仍会在下次同步时一起带上去。
  // hub_*：导航页自己的界面状态（主题 / 侧栏折叠 / 拖拽排序 / 上次打开的工具…）。
  //        用户切个主题就触发一次同步毫无必要。
  const AUTO_IGNORE_PREFIXES = ['hub_', '__hub_', 'ehub_autosync'];
  // ★ 2026-09-18 修正：上面那条 'hub_' 是按「导航页状态」设的。实测导航页 hub_ 前缀的键恰好 10 个，
  //   全是界面状态，没问题；但 tools/cpa学习工具1.html 写的 hub_cpa_* 也被它一刀切吞掉了 ——
  //   而 hub_cpa_* 是**考证工具的业务偏好**（编号模版 / 每级符号 / 列数 / 记录页签 / 展示方式 / 速记视角）。
  //   用户改完模版却不触发同步 ⇒ 换台设备看不到。这与「切个主题不必同步」是两回事。
  //   只对考证工具的偏好键开例外；导航页自己的 hub_* 仍然全部忽略。
  const AUTO_IGNORE_EXCEPT = ['hub_cpa_',
    // ★ 2026-09-23 追加：下面这四个是**用户亲手配的设置**，与「导航页界面状态」不是一回事。
    //   不放进例外的后果：改完主题 / 色板不触发自动同步 ⇒ 换台设备看不到，用户以为「设置没同步」。
    //   （数据本身一直会被同步，缺的只是「触发」这一环；但这件事没法向用户解释清楚。）
    'hub_text_v1', 'hub_deco_v1', 'hub_swatches_v1', 'hub_swatch_def_v1'];
  // 例外里再摘出去的一类：草稿。它是 setInterval(10s) 自动落盘的**本机临时态**
  // （cur.html 里的 DRAFT_MS = 10000），不是「用户改了业务偏好」。
  // 放它进来，用户在记录表单里打字就会每分钟排一次同步，纯属浪费；
  // 而且跨设备传草稿本身也可疑 —— 草稿的含义是「我正在写的这一份」。
  const AUTO_IGNORE_TRANSIENT = ['hub_cpa_draft_v1'];

  // ★ 2026-10-13：计时器 / 技术类瞬时键 —— 无条件忽略，不依赖 hub_ 前缀命中。
  //   这些键写入频繁（计时器起停、抽屉开合、页签切换、草稿自动落盘），
  //   语义是「这台机器此刻的状态」，跨设备无意义，也没资格代表「有新数据」。
  //   注意口径：忽略的是「触发 / 刷新判定」，不是同步本身 ——
  //   数据仍会随下次上传/下载一起走（沿用「不触发 ≠ 不同步」的老口径）。
  //   （自动同步已于 2026-10-13 移除；此清单现在只影响「下载后该刷哪些工具页」
  //    与留痕降噪，但清单保留 —— 以后若恢复自动同步，瞬时键照样进不来。）
  const SYNC_TRANSIENT_KEYS = [
    'timeTimerState',                 // 时间统计·计时器运行状态（起停即写）
    'timeDoneFolded',                 // 时间统计·已完成折叠
    'zmv_view_mode',                  // 朝暮计·视图模式
    'chaomuji_web_v27_drawexpand',    // 朝暮计·抽屉展开状态
    'chaomuji_web_v27_schedmonth',    // 朝暮计·月历折叠状态
    'roam_last_tab',                  // 旅行助手·上次页签
    'diary_app_draft',                // 日记·写作草稿（10s 自动落盘）
    'wb_goal_draft',                  // 学习目标·草稿
    'hub_cpa_draft_v1'                // CPA 学习记录·表单草稿
  ];

  // 这个键该不该被同步联动忽略？true = 忽略。
  // 逻辑：① 先看是不是瞬时键（无条件忽略）；
  //       ② 再看命不命中忽略前缀；命中后再看是不是「例外中的例外（临时态）」——
  //          是 → 照旧忽略；再看是不是业务偏好例外 —— 是 → 不忽略（参与联动）。
  function isAutoIgnoredKey(k) {
    for (let t = 0; t < SYNC_TRANSIENT_KEYS.length; t++) {
      if (k.indexOf(SYNC_TRANSIENT_KEYS[t]) === 0) return true;
    }
    for (let i = 0; i < AUTO_IGNORE_PREFIXES.length; i++) {
      if (k.indexOf(AUTO_IGNORE_PREFIXES[i]) !== 0) continue;
      for (let j = 0; j < AUTO_IGNORE_TRANSIENT.length; j++) {
        if (k.indexOf(AUTO_IGNORE_TRANSIENT[j]) === 0) return true;
      }
      for (let m = 0; m < AUTO_IGNORE_EXCEPT.length; m++) {
        if (k.indexOf(AUTO_IGNORE_EXCEPT[m]) === 0) return false;
      }
      return true;
    }
    return false;
  }

  // ★ 2026-10-13：自动同步（变动触发 / 定时检查 / 保存快车道 / hide 兜底推送）整体移除，
  // 同步改为纯手动上传 / 下载。上面的触发忽略清单保留，供「下载后重载判定」与留痕降噪使用。
  // window.CloudSync.auto 的测试口子一并移除；诊断口子（shardOf / modulesOf 等）迁到 CloudSync 顶层。

  // ============ 初始化 ============
  async function initSync() {
    const b = activeBackend();
    if (!b) { updateStatus('未配置'); return; }
    // Gitee 后端（2026-10-13 起唯一后端）：连接流程归 Gitee 模块自己管
    isConnected = !!b.isConnected();
    updateStatus(isConnected ? '已连接' : '待配置');
    if (!isConnected) b.reconfigure();
  }

  async function init() {
    createSyncUI();
    // 尽早装上：这是「工具页（iframe）写入的键」唯一的时间来源。
    // 晚一步，这段时间里的改动就会漏记 —— 而漏记的后果是静默的（见 localKeyTs 上方注释）。
    installIframeKeyTs();
    const b = activeBackend();
    if (!b || !b.isReady()) { updateStatus(b ? '待配置' : '未配置'); return; }
    await initSync();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 供 Gitee 等其它后端复用（避免两套实现各自漂移）
  // 导出时把 show*/notify* 的「当前值」存一份，供各后端的流内局部引用使用。
  // 各后端不用它，但保留给需要跨作用域调用的代码路径，避免为了取 UI 函数而硬编码全局名。
  let _exportedNotifyOK = notifyOK, _exportedNotifyFail = notifyFail, _exportedShowChoice = showChoice;

  function exportCore() {
    window.CloudSyncCore = {
      // 压缩
      packCloud, unpackCloud, canCompress,
      // 合并策略
      mergeCloudToLocal, buildMergedUpload,
      // 双向同步编排（后端只需提供 read / write 两个钩子）
      runBothIO,
      // 本地数据
      collectLocalData, getLocalKeys, applyCloudToLocal, localMeta,
      // 覆盖前把关（2026-10-13）：本机独有键 / 描述 / 快照，供各后端下载覆盖时复用
      localOnlyKeys, describeKeyList, snapshotStaleKeys, latestSnapshot,
      // 分片：工具函数
      buildShards, shardOfKey, shardFile, newMeta,
      // 分片：与后端无关的通用读写（传 io 进来）
      writeShardedWith, readShardedWith, readShardedMetaWith,
      // 分片：GitHub（Gist）实现，其它后端可作参考
      gistIO,
      writeSharded, readSharded, readShardedMeta,
      // 常量
      META_FILENAME, LEGACY_FILENAME, MAX_SHARD_BYTES,
      // 测试/多后端用：直接设定 gist id，绕过连接流程
      setGistId: function (id) { GIST_ID = id; try { localStorage.setItem('github_gist_id', id); } catch (e) {} },
      markConnected: function () { isConnected = true; },
      // 只读探测
      peekCloud, readGist,
      // 判定
      isExcludedKey,
      // 工具页写入时间表（供诊断页与测试使用）
      installIframeKeyTs, iframeKeyTs, KEY_TS_STORE,
      // UI
      showChoice, showConfirm, showAlert, notifyOK, notifyFail, fmtTime,
      // 进度反馈（多后端共用：面板内常驻状态区）
      progShow, progBusy, progHide,
      // 全局互斥锁（2026-10-12）：手动同步与后台自动同步共用
      syncLock: syncLockAPI,
      // 覆盖世代号（2026-10-12）：Gitee 后端与回归测试共用
      epochSeen, setEpochSeen, noteCloudEpoch, epochNewerThanSeen, overwriteGateAt, staleGenKeys,
      // 最近一次「合并上传」中因世代闸门而未上传的键名（回执提示与排查用）
      gateSkipped: () => lastGateSkipped.slice(),
      alignToGeneration, snapshotStaleKeys, epochNoticeText, deviceTag,
      EPOCH_SEEN_KEY, DEVICE_TAG_KEY, EPOCH_SNAP_KEY,
      // 刷新（v9）
      //   reloadActiveIframe = 无脑全刷（保留给测试与兜底）
      //   refreshToolData    = 按变化键挑工具；silent 时不动当前正开着的那个
      reloadActiveIframe, refreshToolData, flushPendingReload, activeFrameId,
      // 常量
      EXCLUDE_KEYS, EXCLUDE_PREFIXES
    };
    _exportedNotifyOK = notifyOK; _exportedNotifyFail = notifyFail; _exportedShowChoice = showChoice;
  }
  exportCore();

  // 后端注册表：GitHub 后端已于 2026-10-13 移除，唯一后端 Gitee 由 sync-gitee.js 自行注册。
  // 本文件保留 CloudSyncCore 与（未注册的）Gist 实现，供核心复用与历史数据兼容。

  window.CloudSync = {
    build: '2026-09-16-heal',                 // 回归测试用：确认页面跑的是这一版
    upload: doUpload,
    download: doDownload,
    openPanel: openSyncPanel,
    health: doHealth,                                   // 云端体检
    reconnect: initSync,                                // 配置 / 换 Token 后重新连接
    isConnected: () => isConnected,
    syncLock: syncLockAPI,                             // 全局互斥锁（回归测试用）
    peek: peekCloud,                                   // 只读探测云端数据量
    getStatus: () => ({ connected: isConnected, lastSync: lastSyncTime }),
    // 键归属 / 刷新诊断口子（回归测试用；2026-10-13 从 CloudSync.auto 迁出，
    // 自动同步相关口子随自动同步一起移除）
    autoIgnored: (k) => isAutoIgnoredKey(String(k)),
    transientKeys: () => SYNC_TRANSIENT_KEYS.slice(),
    shardOf: (k) => shardOfKey(k),
    moduleIds: () => moduleIds(),
    // 「变化键 → 该刷哪些模块」。返回 null = 认不出来、退化成全刷。
    modulesOf: (ks) => modulesOfKeys(ks),
    pendingReload: () => Object.keys(pendingReload),
    flushReload: () => flushPendingReload()
  };
})();
