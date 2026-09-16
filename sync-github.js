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
 * v8（2026-09-16）新增「双向同步」：
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
    'ehub_autosync_v1'
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
      mask.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:2147483000;display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:16px 0;box-sizing:border-box;';
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
  function localKeyTs() {
    try { return JSON.parse(localStorage.getItem('__hub_meta_v1__') || '{}') || {}; } catch (e) { return {}; }
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
  function mergeCloudToLocal(serverData) {
    const sdata = (serverData && serverData.data) || {};
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
      const lts = meta[key] || 0, cts = entry.timestamp || 0;
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
    const hasRemote = !!(remote && remote.data && Object.keys(remote.data).length > 0);
    const beforeCount = getLocalKeys().length;
    // 云端原有的键集合（用来算「本次往云端新增了哪些键」）
    const cloudHad = {};
    if (hasRemote) {
      for (const k in remote.data) {
        if (Object.prototype.hasOwnProperty.call(remote.data, k)) cloudHad[k] = 1;
      }
    }
    const localStats = hasRemote ? mergeCloudToLocal(remote) : null;      // ① 云端 → 本机
    const merged = buildMergedUpload(hasRemote ? remote : { data: {} });  // ② 本机 → 云端
    const cloudAddedKeys = Object.keys(merged).filter(function (k) { return !cloudHad[k]; });
    const info = await writeFn(merged);
    return {
      hasRemote: hasRemote,
      localStats: localStats,     // null = 云端原本就没有数据
      beforeCount: beforeCount,
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
        <div style="font-size:11px;color:#0d8a5f;display:none" id="syncAutoLine"></div>
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
    if (!id || !reg[id]) id = reg.gitee ? 'gitee' : (reg.github ? 'github' : '');
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
    if (btn && b) btn.textContent = b.isReady() ? '已连接' : '待配置';
  }
  window.refreshBackendUI = function () {
    const b = activeBackend();
    const el = document.getElementById('syncStatus');
    if (el && b) el.textContent = b.isReady() ? '已连接' : '待配置';
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

      <div id="bdBox" style="background:#f6f8fa;border-radius:8px;padding:10px 12px;margin-bottom:14px">
        <div style="font-size:12px;color:#666;margin-bottom:8px">存到哪儿（可随时切换，数据格式通用）：</div>
        <div id="bdRow" style="display:flex;gap:8px;flex-wrap:wrap"></div>
        <div id="bdHint" style="font-size:12px;color:#7c8aa5;margin-top:8px"></div>
      </div>

      <div style="background:#f6f8fa;border-radius:8px;padding:12px;font-size:13px;color:#444;line-height:1.7;margin-bottom:16px">
        <b>怎么用：</b><br>
        • <b>双向同步</b>：先把两边合并，再<b>同时</b>更新本机与云端 —— 两个设备都不会被覆盖。平时点这个就够。<br>
        • <b>上传</b>：点完会让你选「合并到云端」还是「覆盖云端」。<br>
        • <b>下载</b>：点完会让你选「合并到本机」还是「覆盖本机」。<br>
        <span style="color:#7c8aa5">双向同步永远只做合并，不会丢任何一边；「覆盖」是唯一会整端替换的操作，所以它从不默认、每次都要单独确认。数据上传前会自动 gzip 压缩，并按模块分片，只重传改动过的片。</span>
      </div>

      <button id="syncBoth" style="display:block;width:100%;box-sizing:border-box;padding:13px;border:none;border-radius:8px;background:#08bd74;color:white;font-size:15px;font-weight:600;cursor:pointer;margin-bottom:10px">🔁 双向同步（合并两端）</button>

      <div style="display:flex;gap:10px;margin-bottom:10px">
        <button id="syncUpload" style="flex:1;padding:11px;border:1px solid #d8e0ea;border-radius:8px;background:#f7f9fc;color:#33415c;font-size:14px;cursor:pointer">⬆️ 上传到云端</button>
        <button id="syncDownload" style="flex:1;padding:11px;border:1px solid #d8e0ea;border-radius:8px;background:#f7f9fc;color:#33415c;font-size:14px;cursor:pointer">⬇️ 从云端下载</button>
      </div>

      <!-- 同步状态区：常驻显示「进行中 / 成功 / 失败」。
           为什么必须有它：上传是异步的，之前一点按钮面板就关掉了，
           界面上再无任何痕迹，用户既不知道在跑、也不知道跑完没有。
           这里原地反馈，面板不再自动关闭（完成后面板内出现「关闭」）。 -->
      <div id="syncProgress" style="display:none;margin-bottom:14px;border-radius:8px;padding:12px;font-size:13px;line-height:1.7"></div>

      <!-- 自动双向同步（v8）：默认开启，数据变动后自动合并两端。
           与上面那颗手动按钮走的是同一段逻辑（后端 both），区别只有两点：
           ① 静默 —— 不弹通知卡；② 受三层节流约束（停顿 / 最小间隔 / 定时）。 -->
      <div id="autoBox" style="background:#f2fbf7;border:1px solid #cdeee0;border-radius:8px;padding:12px;margin-bottom:14px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <label style="display:flex;align-items:center;gap:7px;cursor:pointer;font-size:13.5px;font-weight:600;color:#0a6b45">
            <input type="checkbox" id="autoSwitch" style="width:15px;height:15px;cursor:pointer">
            数据变动后自动双向同步
          </label>
          <span id="autoStateTxt" style="font-size:12px;color:#0a6b45"></span>
        </div>
        <div id="autoHintTxt" style="font-size:11.5px;color:#5b7a6c;margin-top:7px;line-height:1.7"></div>
        <select id="autoPresetSel" style="width:100%;margin-top:9px;padding:7px 9px;border:1px solid #cdeee0;border-radius:6px;background:white;font-size:12.5px;color:#33415c;cursor:pointer"></select>
        <div id="autoLast" style="margin-top:10px;padding:9px 11px;border-radius:8px;background:#fff;border:1px dashed #cdeee0;font-size:11.5px;line-height:1.85;color:#4a6357">尚未发生自动同步</div>
        <div id="autoLogList" style="margin-top:9px"></div>
      </div>

      <div style="display:flex;gap:8px;margin-bottom:14px">
        <button id="syncHealth" style="flex:1;padding:9px;border:1px solid #ddd;border-radius:6px;background:white;cursor:pointer;font-size:13px">🩺 云端体检（下载失败先点这里）</button>
        <button id="syncDataMgr" style="flex:1;padding:9px;border:1px solid #ddd;border-radius:6px;background:white;cursor:pointer;font-size:13px">🗂️ 数据管理（导入 / 导出 / 清空）</button>
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

    // ---- 后端切换按钮（GitHub Gist / Gitee），来自 window.CloudSyncBackends ----
    const bdRow = modal.querySelector('#bdRow');
    const bdHint = modal.querySelector('#bdHint');
    const reg = window.CloudSyncBackends || {};
    const order = ['github', 'gitee'];
    if (bdRow) {
      order.forEach(function (id) {
        const b = reg[id];
        if (!b) return;
        const on = backend && backend.id === id;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.disabled = false;
        btn.textContent = (on ? '● ' : '○ ') + b.name;
        btn.style.cssText = 'padding:7px 12px;border-radius:999px;font-size:13px;cursor:pointer;' +
          (on ? 'border:1px solid #08bd74;background:#eafaf3;color:#067a4d;font-weight:600;'
              : 'border:1px solid #ddd;background:white;color:#555;');
        btn.onclick = function () {
          setBackend(id);
          mask.remove();
          openSyncPanel();
        };
        bdRow.appendChild(btn);
      });
      bdHint.textContent = backend
        ? (backend.isReady() ? backend.name + ' 已配置完成' : backend.hint)
        : '请选择一个存储位置';
    }

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
    q('#syncBoth').onclick = () => {
      if (!backend) { showConfigModal(); return; }
      if (!backend.isReady()) { mask.remove(); backend.reconfigure(); return; }
      if (typeof backend.both !== 'function') {
        Core_showToastCompat((backend.name || '当前后端') + ' 未提供双向同步');
        return;
      }
      backend.both();
    };
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

    // ---- 自动同步控件（v8）----
    const autoSw = modal.querySelector('#autoSwitch');
    const autoSel = modal.querySelector('#autoPresetSel');
    if (autoSw) {
      autoSw.checked = !!autoCfg.on;
      autoSw.onchange = function () { autoSetOn(autoSw.checked); };
    }
    if (autoSel) {
      autoSel.innerHTML = '';
      Object.keys(AUTO_PRESETS).forEach(function (k) {
        const o = document.createElement('option');
        o.value = k;
        o.textContent = AUTO_PRESETS[k].label + '（' + AUTO_PRESETS[k].hint + '）';
        if (k === autoCfg.preset) o.selected = true;
        autoSel.appendChild(o);
      });
      autoSel.onchange = function () { autoSetPreset(autoSel.value); };
    }
    renderAutoState();
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

  // 把本机数据打包成 { shardId: {key: {value, timestamp}} }
  function buildShards(dataObj) {
    const shards = {};
    for (const key in dataObj) {
      const sid = shardOfKey(key);
      if (!shards[sid]) shards[sid] = {};
      shards[sid][key] = dataObj[key];
    }
    // 单片过大时再按体积切分成多个（xxx__2 这种后缀）
    const out = {};
    for (const sid in shards) {
      const entries = Object.entries(shards[sid]);
      let idx = 0, cur = {}, curBytes = 0;
      const flush = () => {
        if (Object.keys(cur).length) {
          out[sid + (idx === 0 ? '' : '__' + idx)] = cur;
          idx++; cur = {}; curBytes = 0;
        }
      };
      for (const [k, v] of entries) {
        const sz = (v && typeof v.value === 'string') ? v.value.length + k.length : 0;
        if (curBytes + sz > MAX_SHARD_BYTES && Object.keys(cur).length) flush();
        cur[k] = v; curBytes += sz;
      }
      flush();
    }
    return out;
  }

  function shardFile(sid) { return 'efficiency-hub-' + sid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json'; }

  // 本机每个键的最后写入时间（BackupHub 全站维护），用来判定「脏键」
  function localMeta() {
    try { return JSON.parse(localStorage.getItem('__hub_meta_v1__') || '{}') || {}; } catch (e) { return {}; }
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
    return { version: 5, origin: origin || '', updatedAt: Date.now(), shards: {}, keys: {} };
  }

  // 写：只更新「脏片」。meta 记录每片包含哪些键、以及整体 updatedAt。
  // 返回 { wroteBytes, wroteShards, skippedShards, totalShards, deletedShards }
  async function writeShardedWith(io, allData, forceShards) {
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

    for (const sid in shards) {
      totalShards++;
      const raw = shards[sid];
      const keys = Object.keys(raw);
      // 该片里最大的写入时间 vs 上次同步记录的时间 → 判定脏不脏
      let maxTs = 0;
      keys.forEach(k => {
        const t = meta[k] || 0;
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

  // 读分片：并发拉取所有片后合并成 {key:{value,timestamp}}
  async function readShardedWith(io, cloudMeta) {
    const shardIds = Object.keys(cloudMeta.shards || {});
    const merged = { data: {}, updatedAt: cloudMeta.updatedAt || 0 };

    const tasks = shardIds.map(async sid => {
      const fname = shardFile(sid);
      let content = null;
      try { content = await io.getFile(fname); } catch (e) { content = null; }
      if (!content) return null;
      try {
        const payload = await unpackCloud(JSON.parse(content));
        return (payload && payload.data) || {};
      } catch (e) {
        console.warn('[' + (io.label || 'sync') + '] 分片解析失败 ' + sid + ':', e.message);
        return null;   // 单片失败不影响其它片
      }
    });
    const results = await Promise.all(tasks);
    let okCount = 0;
    results.forEach(d => { if (d) { okCount++; Object.assign(merged.data, d); } });
    merged.shardCount = shardIds.length;
    merged.shardOk = okCount;
    return merged;
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
  function writeSharded(allData, forceShards) { return writeShardedWith(gistIO, allData, forceShards); }
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
        localData = buildMergedUpload(remote);
      } else {
        localData = collectLocalData();
      }
      let bodyLen = 0;
      let shardInfo = null;
      const payloadData = localData;
      try {
        shardInfo = await writeSharded(payloadData);
        bodyLen = shardInfo.wroteBytes;
      } catch (e) {
        if (!isNotFound(e)) throw e;
        clearGistCache();                 // 缓存的 Gist 已被删：重建后重试一次
        await findOrCreateGist();
        shardInfo = await writeSharded(payloadData, true);
        bodyLen = shardInfo.wroteBytes;
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
      notifyOK(mode === 'merge' ? '已合并上传到云端' : '已上传到云端',
        (mode === 'merge'
          ? `两边数据已按「较新保留」合并，共 ${nItem} 项。`
          : `本机的 ${nItem} 项数据已存到云端。`) +
        shardTip + `\n本次写入约 ${kb}KB（已压缩）。` + sizeTip +
        '\n在手机 / 其他电脑点「云端 → 本机」就能同步过去。');
    } catch (e) {
      console.warn('[GitHub] 上传失败:', e.message);
      notifyFail('上传云端失败',
        (e && e.message ? e.message : String(e)) + '\n请检查网络或 Token 是否有效（可点「重新配置 Token」）。');
      updateStatus('上传失败');
    }
  }

  async function doDownload() {
    if (!isConnected) { showConfigModal(); return; }
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
      // ⚠️ 顺序调整后必须补的安全闸：索引里记着有分片、实际一个都读不到时，
      //    若不拦就轮到下面执行「覆盖本机」——而 applyCloudToLocal 会先清光本机
      //    可同步键，等于把本机数据清空。这里一律中止，本机数据保持不动。
      if (!remote || !remote.data || !Object.keys(remote.data).length) {
        progShow('fail', '云端数据读取失败',
          '索引显示云端有数据，但一个分片都没读回来，已中止（本机数据未改动）。请检查网络后重试。');
        progBusy(false);
        return;
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
      // 同上传：不关面板，让结果留在原地可见
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
    if (!isConnected) { if (!silent) showConfigModal(); return { error: '尚未连接云端' }; }
    const t0 = Date.now();
    progShow('running', '正在双向同步…', '先读云端，与两端合并后同时更新本机与云端。两端都只会变全，不会丢数据。');
    progBusy(true);
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
      reloadActiveIframe();
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
          (r.hasRemote
            ? '云端 → 本机：新增 ' + st.added + ' 项，更新 ' + st.updated + ' 项，保留本机 ' + st.kept + ' 项' +
              (st.merged ? '，另有 ' + st.merged + ' 项按内容合并' : '') + '。\n'
            : '云端原本没有数据，本次已把本机的数据存过去。\n') +
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
      console.warn('[GitHub] 双向同步失败:', e.message);
      if (!silent) {
        notifyFail('双向同步失败',
          (e && e.message ? e.message : String(e)) + '\n请检查网络或 Token 是否有效。本机与云端的数据都未曾被覆盖。');
        updateStatus('双向同步失败');
      }
      return { error: (e && e.message ? e.message : String(e)) };
    }
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
  const AUTO_LOG_MAX = 20;
  const AUTO_PRESETS = {
    low:    { id: 'low',    label: '省流量', debounce: 60000, minGap: 300000, pull: 900000,
              hint: '停顿 1 分钟推 · 两次推送最少隔 5 分钟 · 每 15 分钟查看一次云端' },
    normal: { id: 'normal', label: '推荐',   debounce: 30000, minGap: 180000, pull: 600000,
              hint: '停顿 30 秒推 · 两次推送最少隔 3 分钟 · 每 10 分钟查看一次云端' },
    high:   { id: 'high',   label: '实时',   debounce: 10000, minGap: 60000,  pull: 180000,
              hint: '停顿 10 秒推 · 两次推送最少隔 1 分钟 · 每 3 分钟查看一次云端' }
  };
  // 这些键的写入不触发自动同步 —— 注意「触发」与「同步」是两件事：
  // 不触发 ≠ 不同步，数据本身仍会在下次同步时一起带上去。
  // hub_*：导航页自己的界面状态（主题 / 侧栏折叠 / 拖拽排序 / 上次打开的工具…）。
  //        用户切个主题就触发一次同步毫无必要。
  const AUTO_IGNORE_PREFIXES = ['hub_', '__hub_', 'ehub_autosync'];

  let autoCfg = { on: true, preset: 'normal', lastAt: 0, lastDesc: '', lastOk: true, failStreak: 0, log: [] };
  let autoTimer = null;        // debounce：本机数据变动后的「停顿计时」
  let autoTickTimer = null;    // 定时：即使没有变动也定期看一眼云端（换设备后能拉到新数据）
  let autoDirtyAt = 0;         // 最近一次「本机数据变动」的时刻
  let autoBusy = false;        // 自动同步进行中（防重入）
  let autoLastAtMem = 0;       // 上次同步时刻的内存镜像（minGap 判定，避免每次读盘）
  let autoHooksOn = false;
  let autoHookOk = false;      // 导航页 setItem hook 是否真的装上了（见 installAutoHooks 注释）

  function autoLoadCfg() {
    try {
      const raw = JSON.parse(localStorage.getItem(AUTO_KEY) || 'null');
      if (raw && typeof raw === 'object') {
        if (typeof raw.on === 'boolean') autoCfg.on = raw.on;
        if (raw.preset && AUTO_PRESETS[raw.preset]) autoCfg.preset = raw.preset;
        if (typeof raw.lastAt === 'number') autoCfg.lastAt = raw.lastAt;
        if (typeof raw.lastDesc === 'string') autoCfg.lastDesc = raw.lastDesc;
        if (typeof raw.lastOk === 'boolean') autoCfg.lastOk = raw.lastOk;
        if (typeof raw.failStreak === 'number') autoCfg.failStreak = raw.failStreak;
        if (Array.isArray(raw.log)) autoCfg.log = raw.log.slice(0, AUTO_LOG_MAX);
      }
    } catch (e) {}
    autoLastAtMem = autoCfg.lastAt || 0;
  }
  function autoSaveCfg() {
    try { localStorage.setItem(AUTO_KEY, JSON.stringify(autoCfg)); } catch (e) {}
  }
  function autoPreset() { return AUTO_PRESETS[autoCfg.preset] || AUTO_PRESETS.normal; }

  function autoClock(ts) {
    if (!ts) return '';
    const d = new Date(Number(ts));
    const p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function autoRelTime(ts) {
    if (!ts) return '';
    const d = Date.now() - ts;
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    return Math.floor(d / 86400000) + ' 天前';
  }

  // 把同步摘要翻成一句人话。这是用户真正要看的东西：
  // 「什么时候」由 autoClock/autoRelTime 给，「同步了什么」由这里给。
  function autoFormat(sum) {
    const head = '双向合并';
    if (!sum) return head + ' · 未取得结果（可能被中断）';
    if (sum.error) return '自动同步未成功：' + sum.error;
    const sec = ((sum.ms || 0) / 1000).toFixed(1);
    const l = sum.local || {}, c = sum.cloud || {};
    const lN = (l.added || 0) + (l.updated || 0) + (l.merged || 0);
    const cAdd = c.added || [];
    if (!lN && !cAdd.length) {
      return head + ' · 用时 ' + sec + ' 秒 · 两端已一致，无内容变动';
    }
    // 涉及的键名：最多列 3 个，其余归并成「等 N 项」——全列出来会把弹窗撑爆
    const names = [];
    (l.keys || []).slice(0, 3).forEach(function (k) { if (names.indexOf(k) < 0) names.push(k); });
    cAdd.slice(0, 3).forEach(function (k) { if (names.indexOf(k) < 0) names.push(k); });
    names.length = Math.min(names.length, 3);
    const total = (l.keys || []).length + cAdd.length;
    const more = total - names.length;
    const parts = [];
    if (lN) parts.push('云端补进本机 ' + lN + ' 项');
    if (cAdd.length) parts.push('本机补上云端 ' + cAdd.length + ' 项');
    // 体积文案：< 1KB 时报字节数。四舍五入成「0KB」看着像没写进去东西，
    // 而小改动（改一条待办）恰恰是自动同步最常见的场景。
    const bytes = c.bytes || 0;
    const sizeTxt = bytes < 1024 ? (bytes + 'B') : (Math.round(bytes / 1024) + 'KB');
    return head + ' · 用时 ' + sec + ' 秒 · ' + parts.join('、') +
      ' · 云端共 ' + (c.wrote || 0) + ' 项 / ' + sizeTxt + ' · 涉及：' +
      names.join('、') + (more > 0 ? ' 等 ' + more + ' 项' : '');
  }

  function autoRecord(desc, ok) {
    autoCfg.lastAt = Date.now();
    autoCfg.lastDesc = desc;
    autoCfg.lastOk = !!ok;
    autoCfg.failStreak = ok ? 0 : (autoCfg.failStreak || 0) + 1;
    autoCfg.log.unshift({ at: autoCfg.lastAt, desc: desc, ok: !!ok });
    if (autoCfg.log.length > AUTO_LOG_MAX) autoCfg.log.length = AUTO_LOG_MAX;
    autoLastAtMem = autoCfg.lastAt;
    autoSaveCfg();
    renderAutoState();
    autoEscalate();
  }

  // 连续失败第 3 次时提醒一次。
  // 为什么需要：自动同步是「无感」的，一次失败用户多半不知道；但默默一直失败
  // 就是最危险的一类静默失效（用户以为在同步，其实早就断了）。
  // 为什么只在第 3 次：网络抖动是常态，每次失败都弹卡就成了骚扰。3 次是「确实有问题」的门槛。
  function autoEscalate() {
    if (autoCfg.lastOk) return;
    if (autoCfg.failStreak !== 3) return;
    if (document.getElementById('autoLast')) return;   // 面板开着，用户已经能直接看到
    if (window.BackupHub && typeof window.BackupHub.notify === 'function') {
      try {
        window.BackupHub.notify({ type: 'warn', icon: '⚠️', title: '自动同步连续失败 3 次',
          detail: (autoCfg.lastDesc || '') + '\n打开侧边栏「云端同步」可查看详情与手动重试。', ms: 9000 });
      } catch (e) {}
    }
  }

  // 本机数据变动 → 排一次同步。
  // key 来自两条路径（导航页 hook / iframe 的 storage 事件），在这里统一过滤。
  function noteLocalChange(key) {
    if (!autoCfg.on) return;
    if (!key) return;
    const k = String(key);
    for (let i = 0; i < AUTO_IGNORE_PREFIXES.length; i++) {
      if (k.indexOf(AUTO_IGNORE_PREFIXES[i]) === 0) return;
    }
    let v = null;
    try { v = localStorage.getItem(k); } catch (e) {}
    if (isExcludedKey(k, v)) return;   // 背景大图 / 内部键 / 同步自身的技术键
    autoDirtyAt = Date.now();
    scheduleAutoSync();
  }

  function scheduleAutoSync() {
    if (!autoCfg.on) return;
    if (autoTimer) clearTimeout(autoTimer);
    const p = autoPreset();
    // 最小间隔：刚同步完不久再推一次没意义（也伤配额）。
    // 把这次等待顺延到「距上次同步满 minGap」之后，而不是直接丢弃这次改动 ——
    // 丢弃会让刚写的数据一直等不到下一次触发。
    const sinceLast = Date.now() - (autoLastAtMem || 0);
    let wait = p.debounce;
    if (sinceLast < p.minGap) wait = Math.max(wait, p.minGap - sinceLast);
    autoTimer = setTimeout(function () { autoTimer = null; runAutoSync('change'); }, wait);
  }

  function autoScheduleTick() {
    if (autoTickTimer) clearInterval(autoTickTimer);
    autoTickTimer = setInterval(function () {
      if (!autoCfg.on || autoBusy) return;
      // 本机还有没推上去的改动 → 交给 debounce 那条路径，定时器不抢跑，
      // 否则刚改完就被定时器用「云端旧版本」抢先去合并，白跑一趟
      if (autoDirtyAt) return;
      runAutoSync('timer');
    }, autoPreset().pull);
  }

  async function runAutoSync(reason) {
    if (!autoCfg.on || autoBusy) return null;
    const b = activeBackend();
    if (!b || !b.isReady() || !b.isConnected()) return null;
    if (typeof b.both !== 'function') return null;
    const p = autoPreset();
    const sinceLast = Date.now() - (autoLastAtMem || 0);
    if (reason !== 'manual' && sinceLast < p.minGap) return null;
    autoBusy = true;
    try {
      const sum = await b.both({ silent: true });
      if (sum && sum.error) { autoRecord('自动同步未成功：' + sum.error, false); return sum; }
      autoDirtyAt = 0;
      autoRecord(autoFormat(sum), true);
      return sum;
    } catch (e) {
      const msg = (e && e.message ? e.message : String(e));
      autoRecord('自动同步未成功：' + msg, false);
      return { error: msg };
    } finally {
      autoBusy = false;
    }
  }

  function autoSetOn(on) {
    autoCfg.on = !!on;
    autoSaveCfg();
    if (autoCfg.on) {
      if (autoDirtyAt) scheduleAutoSync();
      autoScheduleTick();
    } else if (autoTimer) {
      clearTimeout(autoTimer); autoTimer = null;
    }
    renderAutoState();
  }

  function autoSetPreset(id) {
    if (!AUTO_PRESETS[id]) return;
    autoCfg.preset = id;
    autoSaveCfg();
    autoScheduleTick();
    if (autoTimer) {
      clearTimeout(autoTimer); autoTimer = null;
      if (autoDirtyAt) scheduleAutoSync();
    }
    renderAutoState();
  }

  // 留痕三处：侧边栏第二行 / 面板明细块 / 面板内记录列表。
  // 面板没开时后两处的 DOM 不存在，直接跳过（不是错误）。
  function renderAutoState() {
    const line = document.getElementById('syncAutoLine');
    if (line) {
      if (autoCfg.on && autoCfg.lastAt) {
        line.style.display = 'block';
        line.style.color = autoCfg.lastOk ? '#0d8a5f' : '#c0392b';
        line.textContent = '自动 ' + autoClock(autoCfg.lastAt).slice(0, 5) +
          '（' + autoRelTime(autoCfg.lastAt) + '）';
      } else if (autoCfg.on) {
        line.style.display = 'block';
        line.style.color = '#7c8aa5';
        line.textContent = '自动同步已开启 · 等待首次同步';
      } else {
        line.style.display = 'none';
      }
    }

    const sw = document.getElementById('autoSwitch');
    if (sw) sw.checked = !!autoCfg.on;
    const sel = document.getElementById('autoPresetSel');
    if (sel && sel.value !== autoCfg.preset) sel.value = autoCfg.preset;
    const st = document.getElementById('autoStateTxt');
    if (st) st.textContent = autoCfg.on ? ('已开启 · ' + autoPreset().label) : '已关闭';
    const hint = document.getElementById('autoHintTxt');
    if (hint) {
      hint.textContent = autoCfg.on
        ? ('每次只做合并，永远不会覆盖任何一端（覆盖类操作仍需手动点击）。当前节奏：' + autoPreset().hint + '。')
        : '已关闭：数据变动后不会自动同步，需要手动点上面的按钮。';
      // 降级要看得见：hook 没装成时不装作在实时监听，直接告诉用户实际节奏会变慢
      if (autoCfg.on && !autoHookOk) {
        hint.textContent += ' ⚠️ 本页面的写入监听未生效（浏览器限制），只会按上面的定时节奏同步。';
      }
    }
    const last = document.getElementById('autoLast');
    if (last) {
      if (!autoCfg.lastAt) {
        last.textContent = '尚未发生自动同步';
      } else {
        last.innerHTML = '最近一次自动同步 <b>' + autoClock(autoCfg.lastAt) + '</b>（' +
          autoRelTime(autoCfg.lastAt) + '）<br>' + escText(autoCfg.lastDesc || '') +
          '<br><span style="color:#93a3ba">完整记录见下方列表。</span>';
      }
    }
    const list = document.getElementById('autoLogList');
    if (list) {
      if (!autoCfg.log.length) {
        list.innerHTML = '';
      } else {
        list.innerHTML = '<div style="font-size:11.5px;color:#5b7a6c;margin-bottom:5px">最近自动同步记录</div>' +
          autoCfg.log.map(function (r) {
            return '<div style="font-size:11px;line-height:1.75;color:' +
              (r.ok ? '#4a6357' : '#a3341f') + '">' +
              '<span style="color:#0d8a5f;font-weight:600">' + autoClock(r.at) + '</span> ' +
              escText(r.desc || '') + '</div>';
          }).join('');
      }
    }
  }

  function installAutoHooks() {
    if (autoHooksOn) return;
    autoHooksOn = true;
    // ① 导航页自身的写入。
    //
    // ⚠️ 赋值之后【必须回读确认】。浏览器有可能让这次赋值静默失效 ——
    //    把 Storage 包成 Proxy、实例不可扩展、隐私模式下 Storage 被冻结，
    //    都会让 `localStorage.setItem = fn` 悄悄不生效。若不确认，代码会以为
    //    「实时监听已生效」，而实际一个写入都抓不到 —— 这是最危险的一类静默失效：
    //    不是少报，是永远不报，用户还以为自己在实时同步。
    //    （实测：JSDOM 环境下就是装不上的那种。）
    try {
      const origSet = localStorage.setItem;
      localStorage.setItem = function (k, v) {
        const r = origSet.apply(localStorage, arguments);
        try { noteLocalChange(k); } catch (e) {}
        return r;
      };
      autoHookOk = (localStorage.setItem !== origSet);
    } catch (e) { autoHookOk = false; }
    // ② iframe（工具页）内的写入。
    //    storage 事件只会在【其它】文档触发，所以这里收到的一定不是导航页自己的写入，
    //    与 ① 不会重复计数（同一次写入最多被记一次）。
    try {
      window.addEventListener('storage', function (ev) {
        try { if (ev && ev.key) noteLocalChange(ev.key); } catch (e) {}
      });
    } catch (e) {}
    // ③ 移动端切走 App / 关页面时立刻推一次：等不到 debounce 计时器（页面可能直接被冻结）
    try {
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState !== 'hidden') return;
        if (!autoCfg.on || !autoDirtyAt || autoBusy) return;
        if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
        runAutoSync('change');
      });
      window.addEventListener('pagehide', function () {
        if (!autoCfg.on || !autoDirtyAt || autoBusy) return;
        if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
        runAutoSync('change');
      });
    } catch (e) {}
  }

  function autoStart() {
    autoLoadCfg();
    installAutoHooks();
    autoScheduleTick();
    renderAutoState();
  }

  // ============ 初始化 ============
  async function initSync() {
    const b = activeBackend();
    // 选中的是 Gitee：连接流程归 Gitee 模块自己管（它没有「查找已有载体」这一步）
    if (b && b.id !== 'github') {
      isConnected = !!b.isConnected();
      updateStatus(isConnected ? '已连接' : '待配置');
      if (!isConnected) b.reconfigure();
      return;
    }
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
    // 自动同步的钩子与定时器要尽早装上：即使此刻还没配置云端，
    // 用户后续配置好之后「数据变动触发同步」也能立刻生效（不必刷新页面）。
    autoStart();
    const b = activeBackend();
    if (!b || !b.isReady()) { updateStatus(b ? '待配置' : '未配置'); return; }
    if (b.id !== 'github') { updateStatus('已连接'); return; }   // 非 GitHub 后端不在这里联网
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
      // UI
      showChoice, showConfirm, showAlert, notifyOK, notifyFail, fmtTime,
      // 进度反馈（多后端共用：面板内常驻状态区）
      progShow, progBusy, progHide,
      // 刷新
      reloadActiveIframe,
      // 常量
      EXCLUDE_KEYS, EXCLUDE_PREFIXES
    };
    _exportedNotifyOK = notifyOK; _exportedNotifyFail = notifyFail; _exportedShowChoice = showChoice;
  }
  exportCore();

  // 后端注册表：各后端（GitHub / Gitee）注册自己，主面板据此渲染切换项
  window.CloudSyncBackends = window.CloudSyncBackends || {};
  window.CloudSyncBackends.github = {
    id: 'github',
    name: 'GitHub Gist',
    hint: '国内可直连，免费，需 GitHub Token',
    // 主面板调用这几个口子，具体实现留在本文件（闭包内有状态）
    isReady: function () { return !!GITHUB_TOKEN; },
    isConnected: function () { return isConnected; },
    reconfigure: function () { showConfigModal(); },
    upload: function () { return doUpload(); },
    download: function () { return doDownload(); },
    both: function (o) { return doSyncBoth(o); },
    health: function () { return doHealth(); }
  };

  window.CloudSync = {
    build: '2026-09-16-dlask',                 // 回归测试用：确认页面跑的是这一版
    upload: doUpload,
    download: doDownload,
    both: doSyncBoth,
    openPanel: openSyncPanel,
    health: doHealth,                                   // 云端体检
    reconnect: initSync,                                // 配置 / 换 Token 后重新连接
    isConnected: () => isConnected,
    peek: peekCloud,                                   // 只读探测云端数据量
    getStatus: () => ({ connected: isConnected, lastSync: lastSyncTime }),
    // 自动同步（v8）：给测试与「数据管理」面板留的口子
    auto: {
      KEY: AUTO_KEY,
      PRESETS: AUTO_PRESETS,
      state: () => JSON.parse(JSON.stringify(autoCfg)),
      preset: autoPreset,
      setOn: autoSetOn,
      setPreset: autoSetPreset,
      note: noteLocalChange,
      format: autoFormat,
      render: renderAutoState,
      runNow: () => runAutoSync('manual'),
      isBusy: () => autoBusy,
      dirty: () => autoDirtyAt,
      hookOk: () => autoHookOk
    }
  };
})();
