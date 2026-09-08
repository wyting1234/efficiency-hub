/* =============================================================
 *  efficiency-hub · 统一数据备份中心  (BackupHub v1.0)
 *  -------------------------------------------------------------
 *  集中管理本站点全部工具的数据备份 / 恢复 / 快照 / 体检。
 *  - 工具页：BackupHub.mount({id,name,icon})  注入悬浮入口
 *  - 导航页：自动在侧边栏挂载「数据备份」常驻入口
 *  所有工具同域（localStorage 共享），因此可跨工具全量备份。
 * ============================================================= */
(function () {
    'use strict';

    var VERSION = '1.6.2';
    var META_KEY = '__hub_meta_v1__';          // 记录每个 key 的最后写入时间
    var LAST_SNAP_KEY = '__hub_last_snap_v1__'; // 每日自动快照标记
    var ACT_KEY = '__hub_activity_v1__';        // 最近一次备份 / 同步的时间与项目
    var IDB_NAME = 'efficiency_hub_backup';
    var IDB_STORE = 'snapshots';
    var MAX_SNAPSHOTS = 5;
    var QUOTA = 5 * 1024 * 1024;               // localStorage 常规上限 5MB
    var FORMAT = 'efficiency-hub-backup';

    /* ============ 模块清单：keys=精确键，prefixes=前缀键 ============ */
    var MANIFEST = [
        { id: 'hub', name: '工作台设置', icon: '⚙️', keys: [], prefixes: ['hub_'], internal: true },
        { id: 'cpa', name: '考证学习进度', icon: '📚',
          keys: ['cpa_learning_data_v3', 'cpa_study_projects_v1', 'cpa_study_current_project_v1',
                 'cpa_appearance_v1', 'accCheck_v3_migrated'],
          prefixes: ['cpa_learning_data_v3_', 'cpa_study_', 'cpa_'] },
        { id: 'studybk', name: '备考学习工作台', icon: '📐',
          keys: ['cpaMasteryTree_v1', 'cpaMasteryScore_v1', 'cpaMasterySub_v1',
                 'cpaTreeEditMode_v1', 'cpaTreeLv_v1', 'cpaScoreCols_v1'],
          prefixes: ['wb_bk_', 'cpaMastery', 'cpaTree', 'cpaScore'] },
        { id: 'work', name: '工作管理系统', icon: '🗂️',
          keys: ['workLogs', 'workTodos', 'workWeekly', 'workStaff', 'workCategories'] },
        { id: 'diary', name: '日记', icon: '📝',
          keys: ['diary_app_data', 'diary_app_draft', 'diary_editor_font'] },
        { id: 'time', name: '时间统计', icon: '⏱️',
          keys: ['timeRecords', 'timeTodos', 'timeCategoriesV2', 'timeTimerState',
                 'timeTimerHistory', 'timeDoneFolded'] },
        { id: 'dream', name: '梦想成真', icon: '🌟',
          keys: ['dreamGoals', 'dreamDiaries', 'dreamHabits', 'dreamHabitRecords'] },
        { id: 'info', name: '信息研判', icon: '📡',
          keys: ['multi_info_records', 'info_categories'] },
        { id: 'box', name: '收纳盒', icon: '🧺',
          keys: ['organizer_items_v2', 'organizer_theme', 'storage_categories'] },
        { id: 'reading', name: '阅读·思享', icon: '📖',
          keys: ['reading_think_system_v1'], prefixes: ['reading_think_'] },
        { id: 'life', name: '生活工作台', icon: '🏠',
          keys: ['wb_life_v1'], prefixes: ['wb_life_'] },
        { id: 'star', name: '恒星时间管理法', icon: '🪐',
          keys: ['stellar_tag_system_v2', 'stellar_time_records'], prefixes: ['stellar_'] },
        { id: 'idle', name: '琐碎时间记录', icon: '🧩',
          keys: ['idleManagerData_v15'], prefixes: ['idleManagerData_'] },
        { id: 'idol', name: '偶像学习', icon: '🎯',
          keys: ['imitation_targets', 'good_habits', 'daily_checklist', 'bad_habits'] },
        { id: 'health', name: '健康管理', icon: '💪',
          keys: ['mySleepData', 'mySportData', 'myWeightData', 'myBpData',
                 'myWaterData', 'myDietData', 'healthFoodDB'] },
        { id: 'social', name: '人际交往与沟通', icon: '🤝',
          keys: ['comm_daily', 'comm_week', 'comm_month'], prefixes: ['comm_'] },
        { id: 'learning', name: '学习目标管理', icon: '🎯',
          keys: ['wb_goal_seeded', 'wb_ex_seeded'],
          prefixes: ['wb_goal_db_', 'wb_goal_draft_', 'wb_goal_', 'wb_ex_'] },
        { id: 'previewer', name: '代码预览器', icon: '💻',
          keys: ['previewer_html', 'previewer_css', 'previewer_js'] },
        { id: 'travel', name: '旅行助手', icon: '🧭',
          keys: ['roam_last_tab'], prefixes: ['roam_assistant_', 'roam_'] },
        { id: 'msgsrc', name: '消息源工作台', icon: '📡', keys: ['msgSourceBoard_v1'] },
        { id: 'chaomu', name: '朝暮计', icon: '🌅',
          keys: [], prefixes: ['chaomuji_'],
          exclude: ['chaomuji_backups_v1'] },   // 旧版自带备份仓，避免体积翻倍
        { id: 'team', name: '成员管理', icon: '👥', keys: ['teamMembers_v1'] }
    ];

    /* ============ 工具函数 ============ */
    function bytesOf(s) {
        try { return new Blob([s]).size; } catch (e) { return (s || '').length; }
    }
    function fmtBytes(b) {
        if (b < 1024) return b + ' B';
        if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
        return (b / 1024 / 1024).toFixed(2) + ' MB';
    }
    function fmtTime(ts) {
        if (!ts) return '—';
        var d = new Date(ts), p = function (n) { return String(n).padStart(2, '0'); };
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
               ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
    function pad2(n) { return String(n).padStart(2, '0'); }
    function stamp() {
        var d = new Date();
        return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' +
               pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
    }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function isInternalKey(k) {
        return k === META_KEY || k === LAST_SNAP_KEY || k.indexOf('__hub_') === 0;
    }
    // 第三方统计/监控 SDK 的键：与用户数据无关，不备份也不计入体检
    var IGNORE_PREFIXES = ['__BEACON_', 'beacon_', '__hmt', '_hmt', 'sentry', 'gtm_', '__tdid'];
    function isIgnoredKey(k) {
        for (var i = 0; i < IGNORE_PREFIXES.length; i++) {
            if (k.indexOf(IGNORE_PREFIXES[i]) === 0) return true;
        }
        return false;
    }

    /* ============ 写入时间埋点（节流写 meta） ============ */
    var meta = {}, metaDirty = false, metaTimer = null;
    try { meta = JSON.parse(localStorage.getItem(META_KEY) || '{}') || {}; } catch (e) { meta = {}; }

    function flushMeta() {
        metaTimer = null;
        if (!metaDirty) return;
        metaDirty = false;
        try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch (e) {}
    }
    // 关页 / 切后台前把时间埋点落盘，否则"备份后又有改动"会漏判
    try {
        window.addEventListener('beforeunload', flushMeta);
        window.addEventListener('pagehide', flushMeta);
    } catch (e) {}

    // 数据一改动就顺带刷新侧边栏（节流，避免频繁 scan）
    var sideTimer = null;
    function scheduleSideRefresh() {
        if (sideTimer) return;
        sideTimer = setTimeout(function () {
            sideTimer = null;
            if (!document.getElementById('bhSideStat')) return;
            try { renderSideStat(); updateBadge(); } catch (e) {}
        }, 2500);
    }

    var _setItem = null;
    try {
        _setItem = localStorage.setItem;
        localStorage.setItem = function (k, v) {
            var r = _setItem.apply(localStorage, arguments);
            try {
                if (!isInternalKey(k)) { meta[k] = Date.now(); metaDirty = true; }
                if (!metaTimer) metaTimer = setTimeout(flushMeta, 2000);
                scheduleSideRefresh();
            } catch (e) {}
            return r;
        };
    } catch (e) {}

    /* ============ 扫描：把 localStorage 按模块归类 ============ */
    function allKeys() {
        var out = [];
        try {
            for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                if (k && !isInternalKey(k) && !isIgnoredKey(k)) out.push(k);
            }
        } catch (e) {}
        return out;
    }

    function scan() {
        var keys = allKeys();
        var groups = {}, used = {};
        MANIFEST.forEach(function (m) {
            groups[m.id] = { def: m, keys: [], bytes: 0 };
        });
        var other = { def: { id: '_other', name: '未归类数据', icon: '🗃️' }, keys: [], bytes: 0 };

        keys.forEach(function (k) {
            var size = 0;
            try { size = bytesOf(localStorage.getItem(k) || ''); } catch (e) {}
            var hit = null;
            for (var i = 0; i < MANIFEST.length; i++) {
                var m = MANIFEST[i];
                if (m.exclude && m.exclude.indexOf(k) >= 0) continue;
                if (used[k]) break;
                var ok = (m.keys && m.keys.indexOf(k) >= 0);
                if (!ok && m.prefixes) {
                    for (var p = 0; p < m.prefixes.length; p++) {
                        if (k.indexOf(m.prefixes[p]) === 0) { ok = true; break; }
                    }
                }
                if (ok) { hit = m; break; }
            }
            var g = hit ? groups[hit.id] : other;
            if (hit) used[k] = hit.id;
            g.keys.push({ key: k, bytes: size, ts: meta[k] || 0 });
            g.bytes += size;
        });

        var list = MANIFEST.map(function (m) { return groups[m.id]; });
        list.push(other);
        var total = 0;
        list.forEach(function (g) { total += g.bytes; });
        return { groups: list, total: total, keyCount: keys.length };
    }

    /* ============ 最近备份 / 同步记录（供侧边栏展示） ============ */
    // 只记录"什么时候做了什么、涉及哪些模块"，不存数据本身，因此体积可忽略。
    function getAct() {
        try { return JSON.parse(localStorage.getItem(ACT_KEY) || '{}') || {}; } catch (e) { return {}; }
    }
    // 单个键归属到哪个模块（与 scan() 的归类规则保持一致）
    function moduleOfKey(k) {
        for (var i = 0; i < MANIFEST.length; i++) {
            var m = MANIFEST[i];
            if (m.exclude && m.exclude.indexOf(k) >= 0) continue;
            if (m.keys && m.keys.indexOf(k) >= 0) return m;
            if (m.prefixes) {
                for (var p = 0; p < m.prefixes.length; p++) {
                    if (k.indexOf(m.prefixes[p]) === 0) return m;
                }
            }
        }
        return { id: '_other', name: '未归类', icon: '🗃️' };
    }
    // 把一组键汇总成「模块 → 项数」，按项数降序，取前 4
    function summarizeKeys(keys) {
        var map = {}, order = [];
        (keys || []).forEach(function (k) {
            if (!k || isInternalKey(k) || isIgnoredKey(k)) return;
            var m = moduleOfKey(k);
            if (!map[m.id]) { map[m.id] = { id: m.id, name: m.name, icon: m.icon, n: 0 }; order.push(m.id); }
            map[m.id].n++;
        });
        var arr = order.map(function (id) { return map[id]; });
        arr.sort(function (a, b) { return b.n - a.n; });
        return arr.slice(0, 4);
    }
    function summarizePayload(payload) {
        var items = [];
        (payload && payload.modules ? payload.modules : []).forEach(function (m) {
            if (!m) return;
            var n = Object.keys(m.data || {}).length;
            if (n > 0) items.push({ id: m.id, name: m.name, icon: m.icon || '🗂️', n: n });
        });
        var un = Object.keys((payload && payload.unmatched) || {}).length;
        if (un) items.push({ id: '_other', name: '未归类', icon: '🗃️', n: un });
        items.sort(function (a, b) { return b.n - a.n; });
        return items.slice(0, 4);
    }
    // type: 'backup'（本地导出 / 快照 / 恢复） | 'sync'（云端上传 / 下载）
    function recordAct(type, info) {
        try {
            var act = getAct();
            act[type] = {
                ts: Date.now(),
                kind: info.kind || '',
                count: info.count || 0,
                items: (info.items || []).slice(0, 4)
            };
            localStorage.setItem(ACT_KEY, JSON.stringify(act));
        } catch (e) {}
        try { renderSideStat(); } catch (e) {}
    }
    // 其它标签页 / iframe 写入的时间埋点在内存里看不到，展示前先合并一次
    function refreshMeta() {
        try {
            var disk = JSON.parse(localStorage.getItem(META_KEY) || '{}') || {};
            for (var k in disk) {
                if (!Object.prototype.hasOwnProperty.call(disk, k)) continue;
                if ((disk[k] || 0) > (meta[k] || 0)) meta[k] = disk[k];
            }
        } catch (e) {}
    }
    // 自上次本地备份之后又发生过改动的键（按模块汇总）
    function pendingChanges() {
        var act = getAct();
        var since = (act.backup && act.backup.ts) || 0;
        var keys = [];
        try {
            for (var k in meta) {
                if (!Object.prototype.hasOwnProperty.call(meta, k)) continue;
                if (isInternalKey(k) || isIgnoredKey(k)) continue;
                if ((meta[k] || 0) > since) keys.push(k);
            }
        } catch (e) {}
        return { n: keys.length, items: summarizeKeys(keys), since: since };
    }

    /* ============ 快照存储（IndexedDB，降级 localStorage） ============ */
    var idbOk = true;
    function idbOpen() {
        return new Promise(function (res, rej) {
            if (!window.indexedDB) { idbOk = false; return rej('no-idb'); }
            var r;
            try { r = indexedDB.open(IDB_NAME, 1); } catch (e) { idbOk = false; return rej(e); }
            r.onupgradeneeded = function () {
                var db = r.result;
                if (!db.objectStoreNames.contains(IDB_STORE)) {
                    db.createObjectStore(IDB_STORE, { keyPath: 'id' });
                }
            };
            r.onsuccess = function () { res(r.result); };
            r.onerror = function () { idbOk = false; rej(r.error); };
        });
    }
    function idbTx(mode, fn) {
        return idbOpen().then(function (db) {
            return new Promise(function (res, rej) {
                var tx = db.transaction(IDB_STORE, mode);
                var out = fn(tx.objectStore(IDB_STORE));
                tx.oncomplete = function () { res(out); };
                tx.onerror = function () { rej(tx.error); };
            });
        });
    }
    function snapLocalGet() {
        try { return JSON.parse(localStorage.getItem('__hub_snapshots_v1__') || '[]') || []; }
        catch (e) { return []; }
    }
    function snapLocalSet(arr) {
        try { localStorage.setItem('__hub_snapshots_v1__', JSON.stringify(arr.slice(0, 2))); }
        catch (e) {}
    }

    function listSnapshots() {
        if (idbOk) {
            return idbTx('readonly', function (st) {
                return new Promise(function (res) {
                    var req = st.getAll();
                    req.onsuccess = function () {
                        var arr = req.result || [];
                        arr.sort(function (a, b) { return b.ts - a.ts; });
                        res(arr);
                    };
                    req.onerror = function () { res(snapLocalGet()); };
                });
            }).catch(function () { return snapLocalGet(); });
        }
        return Promise.resolve(snapLocalGet());
    }

    function createSnapshot(note) {
        var payload = collect(null);
        var snap = {
            id: 'snap_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
            ts: Date.now(),
            note: note || '手动快照',
            bytes: bytesOf(JSON.stringify(payload)),
            payload: payload
        };
        try {
            recordAct('backup', {
                kind: /自动/.test(note || '') ? '每日自动快照' : '本地快照',
                count: countPayload(payload),
                items: summarizePayload(payload)
            });
        } catch (e) {}
        function trim(arr) {
            arr.sort(function (a, b) { return b.ts - a.ts; });
            return arr.slice(0, MAX_SNAPSHOTS);
        }
        if (idbOk) {
            return idbTx('readwrite', function (st) { st.put(snap); })
                .then(function () {
                    return idbTx('readwrite', function (st) {
                        return new Promise(function (res) {
                            var req = st.getAll();
                            req.onsuccess = function () {
                                var arr = trim(req.result || []);
                                var keep = {};
                                arr.forEach(function (s) { keep[s.id] = 1; });
                                var cur = st.openCursor();
                                cur.onsuccess = function (e) {
                                    var c = e.target.result;
                                    if (!c) return res(arr);
                                    if (!keep[c.value.id]) c.delete();
                                    c.continue();
                                };
                                if ((req.result || []).length <= MAX_SNAPSHOTS) res(arr);
                            };
                            req.onerror = function () { res([]); };
                        });
                    });
                })
                .then(function () { return snap; })
                .catch(function () {
                    var arr = trim(snapLocalGet().concat([snap]));
                    snapLocalSet(arr); return snap;
                });
        }
        var arr = trim(snapLocalGet().concat([snap]));
        snapLocalSet(arr);
        return Promise.resolve(snap);
    }

    function deleteSnapshot(id) {
        if (idbOk) {
            return idbTx('readwrite', function (st) { st.delete(id); })
                .catch(function () {
                    snapLocalSet(snapLocalGet().filter(function (s) { return s.id !== id; }));
                });
        }
        snapLocalSet(snapLocalGet().filter(function (s) { return s.id !== id; }));
        return Promise.resolve();
    }

    /* ============ 收集 / 应用数据 ============ */
    // moduleIds 为 null 或空 → 全部
    function collect(moduleIds) {
        var s = scan();
        var want = {};
        if (moduleIds && moduleIds.length) {
            moduleIds.forEach(function (id) { want[id] = 1; });
        }
        var modules = [], unmatched = {};
        s.groups.forEach(function (g) {
            var id = g.def.id;
            if (id === '_other') {
                g.keys.forEach(function (it) {
                    if (!moduleIds || moduleIds.length === 0) {
                        try { unmatched[it.key] = localStorage.getItem(it.key); } catch (e) {}
                    }
                });
                return;
            }
            if (moduleIds && moduleIds.length && !want[id]) return;
            if (g.keys.length === 0) return;
            var data = {};
            g.keys.forEach(function (it) {
                try { data[it.key] = localStorage.getItem(it.key); } catch (e) {}
            });
            modules.push({ id: id, name: g.def.name, icon: g.def.icon, bytes: g.bytes, data: data });
        });
        return {
            format: FORMAT,
            version: 1,
            exportedAt: new Date().toISOString(),
            origin: location.origin,
            generator: 'BackupHub v' + VERSION,
            scope: (moduleIds && moduleIds.length) ? moduleIds : 'all',
            modules: modules,
            unmatched: unmatched
        };
    }

    function applyBackup(obj, mode) {
        // mode: 'replace' 覆盖 | 'merge' 合并（仅补空缺）
        if (!obj || (obj.format !== FORMAT && !obj.modules && !obj._data)) {
            throw new Error('不是有效的备份文件');
        }
        var pairs = {};
        function put(k, v) { if (k && v != null) pairs[k] = v; }
        if (obj.modules) {
            obj.modules.forEach(function (m) {
                Object.keys(m.data || {}).forEach(function (k) { put(k, m.data[k]); });
            });
        }
        if (obj.unmatched) {
            Object.keys(obj.unmatched).forEach(function (k) { put(k, obj.unmatched[k]); });
        }
        if (obj._data) {           // 兼容旧版导航页导出的裸数据
            Object.keys(obj._data).forEach(function (k) { put(k, obj._data[k]); });
        }
        var written = 0, skipped = 0;
        Object.keys(pairs).forEach(function (k) {
            if (isInternalKey(k)) return;
            if (mode === 'merge') {
                var cur = null;
                try { cur = localStorage.getItem(k); } catch (e) {}
                if (cur !== null && cur !== '' && cur !== '[]' && cur !== '{}') { skipped++; return; }
            }
            try { localStorage.setItem(k, pairs[k]); written++; } catch (e) {}
        });
        try {
            recordAct('backup', {
                kind: mode === 'merge' ? '合并恢复数据' : '恢复数据',
                count: written,
                items: summarizeKeys(Object.keys(pairs))
            });
        } catch (e) {}
        return { written: written, skipped: skipped, total: Object.keys(pairs).length };
    }

    function clearModules(ids) {
        var s = scan();
        var n = 0;
        s.groups.forEach(function (g) {
            if (ids.indexOf(g.def.id) < 0) return;
            g.keys.forEach(function (it) {
                try { localStorage.removeItem(it.key); n++; } catch (e) {}
            });
        });
        return n;
    }

    function download(name, text) {
        var url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        var a = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    function countPayload(payload) {
        var n = 0;
        (payload && payload.modules ? payload.modules : []).forEach(function (m) {
            n += Object.keys((m && m.data) || {}).length;
        });
        return n + Object.keys((payload && payload.unmatched) || {}).length;
    }

    function exportNow(ids) {
        var payload = collect(ids && ids.length ? ids : null);
        var tag = (ids && ids.length) ? ('部分-' + ids.length + '个模块') : '全部';
        download('效率中心备份-' + tag + '-' + stamp() + '.json', JSON.stringify(payload, null, 2));
        try {
            recordAct('backup', {
                kind: (ids && ids.length) ? '导出部分模块' : '导出全部备份',
                count: countPayload(payload),
                items: summarizePayload(payload)
            });
        } catch (e) {}
        return payload;
    }

    /* ============ UI ============ */
    var STYLE_ID = 'bh-style', ROOT_ID = 'bh-root';
    var CSS = [
        // 关键：关闭时必须置 pointer-events:none，否则这层透明遮罩(z-index 999997)会持续拦截整页点击，
        // 导致云端同步的「确定覆盖」确认框等低层级弹窗全部点不动。
        '.bh-mask{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:999997;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .2s,visibility .2s}',
        '.bh-mask.show{opacity:1;visibility:visible;pointer-events:auto}',
        '.bh-panel{position:fixed;top:0;right:0;height:100%;width:min(560px,100%);background:#fff;color:#1e2533;',
        'z-index:999998;box-shadow:-8px 0 32px rgba(15,23,42,.18);transform:translateX(100%);transition:transform .25s cubic-bezier(.4,0,.2,1);',
        'display:flex;flex-direction:column;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}',
        '.bh-panel.show{transform:translateX(0);pointer-events:auto}',
        '.bh-head{display:flex;align-items:center;gap:10px;padding:16px 18px;border-bottom:1px solid #e6e8ef;flex:0 0 auto}',
        '.bh-head h3{margin:0;font-size:16px;font-weight:700;flex:1}',
        '.bh-head .bh-ver{font-size:11px;color:#94a3b8;font-weight:500;margin-left:6px}',
        '.bh-x{border:none;background:#f1f5f9;color:#475569;width:30px;height:30px;border-radius:8px;cursor:pointer;font-size:18px;line-height:1}',
        '.bh-x:hover{background:#e2e8f0}',
        '.bh-body{flex:1;overflow-y:auto;padding:14px 18px 30px}',
        '.bh-sec{margin-bottom:18px}',
        '.bh-cloud{background:#f8fafc;border:1px solid #e6e8ef;border-radius:12px;padding:12px 13px}',
        '.bh-cloud .bh-cs{font-size:13px;line-height:1.6;color:#334155;margin-bottom:10px}',
        '.bh-cloud .bh-cs b{color:#0f172a}',
        '.bh-cloud .bh-cw{background:#fffbeb;border:1px solid #fde68a;color:#92400e;border-radius:9px;',
        'padding:9px 11px;font-size:12px;line-height:1.65;margin-bottom:10px}',
        '.bh-cloud .bh-ca{display:flex;gap:8px}',
        '.bh-cloud .bh-ca button{flex:1;padding:10px;border:none;border-radius:9px;cursor:pointer;font-size:13px;font-weight:600}',
        '.bh-cloud .bh-up{background:#08bd74;color:#fff}',
        '.bh-cloud .bh-dl{background:#3b82f6;color:#fff}',
        '.bh-cloud .bh-cfg{background:#f1f5f9;color:#475569;border:1px solid #e2e8f0}',
        'html[data-theme="dark"] .bh-cloud{background:#0f172a;border-color:#1f2c47}',
        'html[data-theme="dark"] .bh-cloud .bh-cs{color:#cbd5e1}',
        'html[data-theme="dark"] .bh-cloud .bh-cs b{color:#f1f5f9}',
        '.bh-sec-t{font-size:12px;font-weight:700;color:#64748b;letter-spacing:.5px;margin:0 0 8px;display:flex;align-items:center;gap:6px}',
        '.bh-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px}',
        '.bh-stat{background:#f8fafc;border:1px solid #e6e8ef;border-radius:10px;padding:9px 10px}',
        '.bh-stat b{display:block;font-size:16px;line-height:1.3}',
        '.bh-stat span{font-size:11px;color:#64748b}',
        '.bh-bar{height:8px;background:#eef2f7;border-radius:999px;overflow:hidden}',
        '.bh-bar i{display:block;height:100%;background:#6366f1;transition:width .3s}',
        '.bh-bar.warn i{background:#f59e0b}.bh-bar.danger i{background:#ef4444}',
        '.bh-note{font-size:12px;color:#64748b;margin-top:6px}',
        '.bh-note.danger{color:#dc2626;font-weight:600}',
        '.bh-acts{display:flex;flex-wrap:wrap;gap:8px}',
        '.bh-btn{border:1px solid #e2e8f0;background:#fff;color:#334155;border-radius:9px;padding:8px 13px;font-size:13px;cursor:pointer;transition:.15s}',
        '.bh-btn:hover{border-color:#c7d2fe;background:#f5f7ff}',
        '.bh-btn.pri{background:#6366f1;border-color:#6366f1;color:#fff}',
        '.bh-btn.pri:hover{background:#4f46e5}',
        '.bh-btn.dgr{background:#fff;border-color:#fecaca;color:#dc2626}',
        '.bh-btn.dgr:hover{background:#fef2f2}',
        '.bh-btn.sm{padding:5px 9px;font-size:12px}',
        '.bh-opts{display:flex;align-items:center;gap:12px;font-size:12px;color:#475569;margin-top:8px}',
        '.bh-mod{display:flex;align-items:center;gap:9px;padding:8px 10px;border:1px solid #e6e8ef;border-radius:10px;margin-bottom:6px;background:#fff}',
        '.bh-mod:hover{border-color:#c7d2fe;background:#fbfcff}',
        '.bh-mod .bh-mi{font-size:16px;width:20px;text-align:center;flex:0 0 20px}',
        '.bh-mod .bh-mn{font-size:13px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.bh-mod .bh-mm{font-size:11px;color:#94a3b8;flex:0 0 auto}',
        '.bh-mod.empty{opacity:.55}',
        '.bh-snap{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid #e6e8ef;border-radius:10px;margin-bottom:6px}',
        '.bh-snap .bh-si{flex:1;min-width:0}',
        '.bh-snap .bh-st{font-size:12px;font-weight:600}',
        '.bh-snap .bh-ss{font-size:11px;color:#94a3b8}',
        '.bh-empty{font-size:12px;color:#94a3b8;padding:10px;text-align:center;background:#f8fafc;border-radius:10px}',
        '.bh-nav-exp{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;',
        'margin-left:6px;border:none;border-radius:6px;background:#eef2ff;color:#4f46e5;cursor:pointer;',
        'font-size:12px;line-height:1;flex:0 0 auto;padding:0}',
        '.bh-nav-exp:hover{background:#4f46e5;color:#fff}',
        'html[data-theme="dark"] .bh-nav-exp{background:#1e293b;color:#818cf8}',
        // v1.6.2：侧边栏状态条已移除（备份/同步状态只在云端同步面板内展示）
        '.bh-float{position:fixed;right:16px;bottom:16px;z-index:999996;display:flex;align-items:center;gap:6px;',
        'background:#fff;color:#334155;border:1px solid #e2e8f0;border-radius:999px;padding:8px 14px;font-size:13px;',
        'cursor:pointer;box-shadow:0 4px 14px rgba(15,23,42,.12);font-family:inherit;transition:.15s}',
        '.bh-float:hover{transform:translateY(-1px);box-shadow:0 6px 18px rgba(15,23,42,.18);border-color:#c7d2fe}',
        '.bh-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:34px;background:#0f172a;color:#fff;',
        'padding:9px 18px;border-radius:999px;font-size:13px;z-index:999999;opacity:0;transition:opacity .2s,transform .2s;pointer-events:none}',
        '.bh-toast.show{opacity:1;transform:translateX(-50%) translateY(-6px)}',
        // 成功提醒卡：备份 / 同步成功后的明确反馈，带详情与自动消失进度条
        '.bh-notify{position:fixed;top:16px;right:16px;z-index:2147483000;width:min(340px,calc(100vw - 32px));',
        'background:#fff;border:1px solid #e2e8f0;border-left:4px solid #10b981;border-radius:12px;',
        'box-shadow:0 10px 30px rgba(15,23,42,.16);padding:12px 13px;display:flex;gap:10px;align-items:flex-start;',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;',
        'opacity:0;transform:translateX(20px);transition:opacity .22s,transform .22s;pointer-events:none}',
        '.bh-notify.show{opacity:1;transform:translateX(0);pointer-events:auto}',
        '.bh-notify.warn{border-left-color:#f59e0b}',
        '.bh-notify .bh-ni{font-size:20px;line-height:1.25;flex:0 0 auto}',
        '.bh-notify .bh-nb{flex:1;min-width:0}',
        '.bh-notify .bh-nt{font-size:14px;font-weight:700;color:#0f172a}',
        '.bh-notify .bh-nd{font-size:12.5px;color:#64748b;margin-top:3px;line-height:1.55;word-break:break-word;white-space:pre-line}',
        '.bh-notify .bh-nx{border:none;background:none;color:#94a3b8;cursor:pointer;font-size:17px;line-height:1;padding:0 2px;flex:0 0 auto}',
        '.bh-notify .bh-nx:hover{color:#475569}',
        '.bh-notify .bh-np{position:absolute;left:0;bottom:0;height:2px;background:#10b981;opacity:.5;border-radius:0 0 0 10px}',
        '.bh-notify.warn .bh-np{background:#f59e0b}',
        // 备份面板打开时（右侧 560px 抽屉），提醒卡要避让，否则会盖住面板右上角的关闭按钮
        '.bh-notify.atbot{top:auto;bottom:16px;left:50%;right:auto;width:min(340px,calc(100vw - 32px));transform:translateX(-50%) translateY(12px)}',
        '.bh-notify.atbot.show{transform:translateX(-50%) translateY(0)}',
        '@media(max-width:520px){.bh-notify{top:10px;right:10px;left:10px;width:auto}}',
        'html[data-theme="dark"] .bh-panel{background:#111a2e;color:#e5e9f2;border-left:1px solid #1f2c47}',
        'html[data-theme="dark"] .bh-head{border-color:#1f2c47}',
        'html[data-theme="dark"] .bh-stat,html[data-theme="dark"] .bh-empty{background:#0f1a30;border-color:#1f2c47}',
        'html[data-theme="dark"] .bh-mod,html[data-theme="dark"] .bh-snap{background:#0f1a30;border-color:#1f2c47;color:#e5e9f2}',
        'html[data-theme="dark"] .bh-btn{background:#16223c;border-color:#24334f;color:#cbd5e1}',
        'html[data-theme="dark"] .bh-btn:hover{border-color:#4f46e5;background:#1b2947}',
        'html[data-theme="dark"] .bh-x{background:#1b2947;color:#cbd5e1}',
        'html[data-theme="dark"] .bh-float{background:#16223c;border-color:#24334f;color:#e5e9f2}',
        '@media(max-width:520px){.bh-stats{grid-template-columns:repeat(2,1fr)}}'
    ].join('\n');

    var el = {}, selected = {}, curScope = null, panelBuilt = false;

    function ensureStyle() {
        if (document.getElementById(STYLE_ID)) return;
        var s = document.createElement('style');
        s.id = STYLE_ID; s.textContent = CSS;
        document.head.appendChild(s);
    }

    function toast(msg) {
        var t = document.getElementById('bh-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'bh-toast'; t.className = 'bh-toast';
            document.body.appendChild(t);
        }
        t.textContent = msg;
        requestAnimationFrame(function () { t.classList.add('show'); });
        clearTimeout(t._tm);
        t._tm = setTimeout(function () { t.classList.remove('show'); }, 2200);
    }

    /* ============ 成功提醒卡（备份 / 同步等重点操作） ============ */
    // toast 一闪而过、且不带数据量，用户常常不确定到底成没成功。
    // 重点操作统一走这里：图标 + 标题 + 详情 + 自动消失进度条。
    function notify(o) {
        o = o || {};
        var box = document.getElementById('bh-notify');
        if (!box) {
            box = document.createElement('div');
            box.id = 'bh-notify';
            box.className = 'bh-notify';
            document.body.appendChild(box);
        }
        var ms = o.ms || 4200;
        // 面板打开时避让：宽屏挪到抽屉左侧，窄屏改到底部居中
        var panelOpen = panelBuilt && el.panel && el.panel.classList.contains('show');
        if (panelOpen && window.innerWidth > 620) {
            box.className = 'bh-notify' + (o.type === 'warn' ? ' warn' : '');
            box.style.right = (Math.min(560, window.innerWidth) + 24) + 'px';
        } else {
            box.className = 'bh-notify' + (o.type === 'warn' ? ' warn' : '') + (panelOpen ? ' atbot' : '');
            box.style.right = '';
        }
        box.innerHTML =
            '<span class="bh-ni">' + esc(o.icon || '✅') + '</span>' +
            '<div class="bh-nb">' +
              '<div class="bh-nt">' + esc(o.title || '操作成功') + '</div>' +
              (o.detail ? '<div class="bh-nd">' + esc(o.detail) + '</div>' : '') +
            '</div>' +
            '<button class="bh-nx" title="关闭">×</button>' +
            '<div class="bh-np"></div>';
        var bar = box.querySelector('.bh-np');
        box.querySelector('.bh-nx').onclick = function () { hide(); };
        box.onclick = function (e) { if (e.target === box) hide(); };

        function hide() {
            box.classList.remove('show');
            clearTimeout(box._tm);
        }
        box._hide = hide;
        requestAnimationFrame(function () {
            box.classList.add('show');
            if (bar) { bar.style.transition = 'none'; bar.style.width = '100%'; }
            requestAnimationFrame(function () {
                if (bar) { bar.style.transition = 'width ' + ms + 'ms linear'; bar.style.width = '0%'; }
            });
        });
        clearTimeout(box._tm);
        box._tm = setTimeout(hide, ms);
    }

    // 便于其它模块（云端同步）复用同一套提醒
    function bhNotify(icon, title, detail) { notify({ icon: icon, title: title, detail: detail }); }

    function buildPanel() {
        if (panelBuilt) return;
        ensureStyle();
        var root = document.createElement('div');
        root.id = ROOT_ID;
        root.innerHTML =
            '<div class="bh-mask" id="bhMask"></div>' +
            '<div class="bh-panel" id="bhPanel">' +
              '<div class="bh-head">' +
                '<h3>💾 数据备份中心<span class="bh-ver">v' + VERSION + '</span></h3>' +
                '<button class="bh-x" id="bhClose" title="关闭">×</button>' +
              '</div>' +
              '<div class="bh-body">' +
                '<div class="bh-sec"><p class="bh-sec-t">📊 数据体检</p>' +
                  '<div class="bh-stats" id="bhStats"></div>' +
                  '<div class="bh-bar" id="bhBar"><i></i></div>' +
                  '<div class="bh-note" id="bhNote"></div>' +
                '</div>' +
                '<div class="bh-sec"><p class="bh-sec-t">⚡ 一键操作</p>' +
                  '<div class="bh-acts">' +
                    '<button class="bh-btn pri" id="bhExpAll">导出全部备份</button>' +
                    '<button class="bh-btn" id="bhImp">导入备份文件</button>' +
                    '<button class="bh-btn" id="bhSnap">创建快照</button>' +
                  '</div>' +
                  '<div class="bh-opts"><label><input type="radio" name="bhMode" value="merge" checked> 合并（保留现有）</label>' +
                  '<label><input type="radio" name="bhMode" value="replace"> 覆盖（以备份为准）</label></div>' +
                  '<input type="file" id="bhFile" accept="application/json,.json" style="display:none">' +
                  '<div class="bh-note" style="margin-top:9px">⚠️ 导出的备份文件<b>只存在这台设备</b>。点导出后会问你要不要<b>顺带上传云端</b>，跨设备同步请用下方「跨设备同步」。</div>' +
                '</div>' +
                '<div class="bh-sec"><p class="bh-sec-t">☁️ 跨设备同步（手机 ⇄ 电脑）</p>' +
                  '<div class="bh-cloud" id="bhCloud"></div>' +
                '</div>' +
                '<div class="bh-sec"><p class="bh-sec-t">🧩 按模块备份</p>' +
                  '<div class="bh-acts" style="margin-bottom:8px">' +
                    '<button class="bh-btn sm" id="bhSelAll">全选</button>' +
                    '<button class="bh-btn sm" id="bhSelNone">清空选择</button>' +
                    '<button class="bh-btn sm" id="bhExpSel">导出所选</button>' +
                    '<button class="bh-btn sm dgr" id="bhClrSel">清除所选</button>' +
                  '</div>' +
                  '<div id="bhMods"></div>' +
                '</div>' +
                '<div class="bh-sec"><p class="bh-sec-t">🕓 自动快照（最近 ' + MAX_SNAPSHOTS + ' 份）</p>' +
                  '<div id="bhSnaps"></div>' +
                '</div>' +
              '</div>' +
            '</div>';
        document.body.appendChild(root);

        el.mask = root.querySelector('#bhMask');
        el.panel = root.querySelector('#bhPanel');
        el.stats = root.querySelector('#bhStats');
        el.bar = root.querySelector('#bhBar');
        el.note = root.querySelector('#bhNote');
        el.mods = root.querySelector('#bhMods');
        el.snaps = root.querySelector('#bhSnaps');
        el.file = root.querySelector('#bhFile');
        el.cloud = root.querySelector('#bhCloud');

        el.mask.addEventListener('click', close);
        root.querySelector('#bhClose').addEventListener('click', close);
        root.querySelector('#bhExpAll').addEventListener('click', exportThenAskCloud);
        root.querySelector('#bhImp').addEventListener('click', function () { el.file.click(); });
        el.file.addEventListener('change', function (e) {
            var f = e.target.files && e.target.files[0];
            e.target.value = '';
            if (f) doImport(f);
        });
        root.querySelector('#bhSnap').addEventListener('click', function () {
            createSnapshot('手动快照').then(function () {
                renderSnaps();
                var s = scan();
                notify({ icon: '📌', title: '快照已保存', detail: '已保存 ' + s.keyCount + ' 个数据键（' + fmtBytes(s.total) + '），需要时可一键回滚。' });
            });
        });
        root.querySelector('#bhSelAll').addEventListener('click', function () {
            scan().groups.forEach(function (g) { selected[g.def.id] = true; });
            renderMods();
        });
        root.querySelector('#bhSelNone').addEventListener('click', function () {
            selected = {}; renderMods();
        });
        root.querySelector('#bhExpSel').addEventListener('click', function () {
            var ids = selIds();
            if (!ids.length) return toast('请先选择模块');
            exportNow(ids);
            notify({ icon: '📦', title: '已导出 ' + ids.length + ' 个模块',
                     detail: '备份文件已存到本机，不会自动同步到手机 / 其他电脑。' });
        });
        root.querySelector('#bhClrSel').addEventListener('click', function () {
            var ids = selIds();
            if (!ids.length) return toast('请先选择模块');
            if (!confirm('确定清除所选 ' + ids.length + ' 个模块的数据？此操作不可恢复，建议先创建快照。')) return;
            createSnapshot('清除前自动快照').then(function () {
                var n = clearModules(ids);
                refresh();
                notify({ icon: '🧹', title: '已清除 ' + n + ' 项数据', detail: '清除前已自动存了一份快照，误删可在下方「本地快照」里回滚。' });
            });
        });
        panelBuilt = true;
    }

    function selIds() {
        return Object.keys(selected).filter(function (k) { return selected[k]; });
    }

    function doImport(file) {
        var mode = (document.querySelector('input[name="bhMode"]:checked') || {}).value || 'merge';
        var reader = new FileReader();
        reader.onload = function (e) {
            var obj;
            try { obj = JSON.parse(e.target.result); }
            catch (err) { return toast('文件解析失败：不是合法 JSON'); }
            createSnapshot('导入前自动快照').then(function () {
                var r;
                try { r = applyBackup(obj, mode); }
                catch (err2) { return toast('导入失败：' + err2.message); }
                refresh();
                notify({ icon: '📥', title: (mode === 'replace' ? '已覆盖恢复 ' : '已合并恢复 ') + r.written + ' 项数据',
                         detail: (r.skipped ? '跳过 ' + r.skipped + ' 项。' : '') +
                                 (mode === 'replace' ? '已用备份文件覆盖原有数据。' : '已合并到现有数据，原有内容保留。') +
                                 '导入前已自动存了一份快照。' });
            });
        };
        reader.readAsText(file);
    }

    function renderStats() {
        var s = scan();
        var pct = Math.min(100, (s.total / QUOTA) * 100);
        var usedModules = s.groups.filter(function (g) { return g.keys.length > 0; }).length;
        el.stats.innerHTML =
            '<div class="bh-stat"><b>' + fmtBytes(s.total) + '</b><span>已用空间</span></div>' +
            '<div class="bh-stat"><b>' + s.keyCount + '</b><span>数据键数</span></div>' +
            '<div class="bh-stat"><b>' + usedModules + '</b><span>有数据模块</span></div>';
        el.bar.className = 'bh-bar' + (pct > 92 ? ' danger' : (pct > 80 ? ' warn' : ''));
        el.bar.querySelector('i').style.width = Math.max(1.5, pct) + '%';
        var note = '占用上限约 5MB 的 ' + pct.toFixed(1) + '%';
        if (pct > 92) note = '⚠️ 存储空间即将写满（' + pct.toFixed(1) + '%），请立即导出备份并清理旧数据';
        else if (pct > 80) note = '⚠️ 存储空间已用 ' + pct.toFixed(1) + '%，建议导出备份';
        el.note.className = 'bh-note' + (pct > 80 ? ' danger' : '');
        el.note.textContent = note;
    }

    function renderMods() {
        var s = scan();
        var html = '';
        s.groups.forEach(function (g) {
            var last = 0;
            g.keys.forEach(function (it) { if (it.ts > last) last = it.ts; });
            var chk = selected[g.def.id] ? 'checked' : '';
            html += '<label class="bh-mod' + (g.keys.length ? '' : ' empty') + '">' +
                '<input type="checkbox" data-id="' + esc(g.def.id) + '" ' + chk + '>' +
                '<span class="bh-mi">' + (g.def.icon || '📦') + '</span>' +
                '<span class="bh-mn">' + esc(g.def.name) + '</span>' +
                '<span class="bh-mm">' + (g.keys.length ? (g.keys.length + ' 键 · ' + fmtBytes(g.bytes) +
                    (last ? ' · ' + fmtTime(last) : '')) : '无数据') + '</span>' +
                '</label>';
        });
        el.mods.innerHTML = html;
        Array.prototype.forEach.call(el.mods.querySelectorAll('input[type=checkbox]'), function (cb) {
            cb.addEventListener('change', function () {
                selected[cb.dataset.id] = cb.checked;
            });
        });
    }

    /* ============ 跨设备同步（复用 sync-github.js 的 CloudSync） ============ */
    // 云端模块只在导航页加载；工具页在 iframe 里时需透过 parent 访问
    function cloudApi() {
        try {
            if (window.CloudSync) return window.CloudSync;
            if (window.parent && window.parent !== window && window.parent.CloudSync) return window.parent.CloudSync;
        } catch (e) {}
        return null;
    }

    function renderCloud() {
        var box = el.cloud;
        if (!box) return;
        var cs = cloudApi();
        if (!cs) {
            box.innerHTML = '<div class="bh-cs">跨设备同步由<b>导航页</b>提供。请回到效率中心首页再打开这里，' +
                '即可把数据上传到云端、并在另一台设备下载下来。</div>';
            return;
        }
        var last = '';
        try { last = localStorage.getItem('sync_last_sync') || ''; } catch (e) {}

        box.innerHTML =
            '<div class="bh-cs" id="bhCloudState">正在读取云端状态…</div>' +
            '<div class="bh-ca" style="margin-top:10px">' +
              '<button class="bh-up" id="bhCloudUp">⬆️ 本机 → 云端</button>' +
              '<button class="bh-dl" id="bhCloudDown">⬇️ 云端 → 本机</button>' +
            '</div>';
        var state = box.querySelector('#bhCloudState');
        var setTxt = function (t) { if (state) state.innerHTML = t; };

        var hint = '想让手机和电脑一致：<b>先在有数据的那台点「本机 → 云端」</b>，' +
                   '再到另一台点「云端 → 本机」。';

        if (typeof cs.peek === 'function') {
            Promise.resolve(cs.peek()).then(function (r) {
                if (!r || !r.connected) {
                    setTxt('尚未连接云端（' + esc((r && r.reason) || '未配置 Token') + '）。<br>' + hint);
                    return;
                }
                var cnt = r.cloudCount || 0;
                if (cnt) {
                    setTxt('☁️ 云端已有 <b>' + cnt + '</b> 项数据' +
                        (r.updatedAt ? '，更新于 <b>' + fmtTime(r.updatedAt) + '</b>' : '') + '。<br>' +
                        '本机 <b>' + scan().keyCount + '</b> 个数据键' +
                        (last ? '，上次同步 ' + fmtTime(last) : '') + '。<br>' + hint);
                } else {
                    setTxt('☁️ 云端<b>还没有数据</b>。<br>请先点「本机 → 云端」把这台设备的数据传上去，' +
                        '再到另一台设备点「云端 → 本机」。');
                }
            }).catch(function (e) {
                setTxt('云端状态读取失败：' + esc((e && e.message) || e) + '。请检查网络或 Token 是否有效。');
            });
        } else {
            setTxt('云端同步模块版本较旧，请在导航页使用完整功能。');
        }

        var up = box.querySelector('#bhCloudUp');
        var down = box.querySelector('#bhCloudDown');
        // 先关掉备份面板：云端弹窗 z-index 较低，否则会被本面板盖住
        if (up) up.addEventListener('click', function () {
            close();
            Promise.resolve(cs.upload()).catch(function () {}).then(function () { refresh(); });
        });
        if (down) down.addEventListener('click', function () {
            close();
            Promise.resolve(cs.download()).catch(function () {}).then(function () { refresh(); });
        });
    }

    function renderSnaps() {
        el.snaps.innerHTML = '<div class="bh-empty">加载中…</div>';
        listSnapshots().then(function (arr) {
            if (!arr.length) {
                el.snaps.innerHTML = '<div class="bh-empty">暂无快照。点上方「创建快照」保存当前状态，最多保留 ' + MAX_SNAPSHOTS + ' 份。</div>';
                return;
            }
            el.snaps.innerHTML = arr.map(function (sn) {
                return '<div class="bh-snap"><div class="bh-si">' +
                    '<div class="bh-st">' + fmtTime(sn.ts) + '</div>' +
                    '<div class="bh-ss">' + esc(sn.note) + ' · ' + fmtBytes(sn.bytes || 0) + '</div>' +
                    '</div>' +
                    '<button class="bh-btn sm" data-act="restore" data-id="' + sn.id + '">恢复</button>' +
                    '<button class="bh-btn sm" data-act="down" data-id="' + sn.id + '">下载</button>' +
                    '<button class="bh-btn sm dgr" data-act="del" data-id="' + sn.id + '">删除</button>' +
                    '</div>';
            }).join('');
            Array.prototype.forEach.call(el.snaps.querySelectorAll('button'), function (b) {
                b.addEventListener('click', function () {
                    var id = b.dataset.id, act = b.dataset.act;
                    listSnapshots().then(function (arr2) {
                        var sn = arr2.filter(function (x) { return x.id === id; })[0];
                        if (!sn) return toast('快照不存在');
                        if (act === 'restore') {
                            if (!confirm('恢复到 ' + fmtTime(sn.ts) + ' 的快照？当前数据将被覆盖（会先自动快照当前状态）。')) return;
                            createSnapshot('恢复前自动快照').then(function () {
                                applyBackup(sn.payload, 'replace');
                                refresh();
                                notify({ icon: '⏪', title: '已恢复到该快照', detail: '数据已回滚到 ' + fmtTime(sn.ts) + ' 的状态。' });
                            });
                        } else if (act === 'down') {
                            download('效率中心快照-' + stamp() + '.json', JSON.stringify(sn.payload, null, 2));
                        } else {
                            deleteSnapshot(id).then(function () { renderSnaps(); toast('快照已删除'); });
                        }
                    });
                });
            });
        });
    }

    function refresh() {
        if (!panelBuilt) return;
        renderStats(); renderMods(); renderSnaps(); renderCloud();
        renderSideStat(); updateBadge();
    }

    function open(scopeModuleId) {
        buildPanel();
        curScope = scopeModuleId || null;
        if (scopeModuleId) {
            selected = {}; selected[scopeModuleId] = true;
        }
        refresh();
        requestAnimationFrame(function () {
            el.mask.classList.add('show');
            el.panel.classList.add('show');
        });
        if (scopeModuleId) {
            setTimeout(function () {
                var t = el.mods.querySelector('input[data-id="' + scopeModuleId + '"]');
                if (t && t.closest('.bh-mod')) {
                    t.closest('.bh-mod').scrollIntoView({ block: 'center', behavior: 'smooth' });
                }
            }, 320);
        }
    }
    function close() {
        if (!panelBuilt) return;
        el.mask.classList.remove('show');
        el.panel.classList.remove('show');
    }

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && panelBuilt && el.panel.classList.contains('show')) close();
    });

    /* ============ 每日自动快照（仅导航页执行） ============ */
    function maybeAutoSnapshot() {
        try {
            var today = new Date().toDateString();
            if (localStorage.getItem(LAST_SNAP_KEY) === today) return;
            localStorage.setItem(LAST_SNAP_KEY, today);
            createSnapshot('每日自动快照');
        } catch (e) {}
    }

    /* ============ 侧边栏入口（导航页） ============ */
    var SIDEBAR_ID = 'bh-nav-item';
    /* ============ 导出备份 → 询问是否同时上传云端 ============ */
    // 只导出文件到本机是不够的：很多人误以为"备份成功"就等于手机/别的电脑能看到了。
    // 所以导出后主动问一次要不要顺带上传云端，把两件事串成一条路径。
    function cloudReady() {
        var cs = cloudApi();
        if (!cs) return null;
        var connected = false;
        try { connected = !!(cs.isConnected && cs.isConnected()); } catch (e) {}
        if (!connected) {
            // 已配过 Token 就算可用（initSync 是异步的，状态可能还没回来）
            var token = '';
            try { token = localStorage.getItem('github_token') || ''; } catch (e) {}
            if (token) connected = true;
        }
        return connected ? cs : null;
    }

    function exportThenAskCloud() {
        var payload = exportNow(null);
        var n = 0;
        if (payload) {
            (payload.modules || []).forEach(function (m) { n += Object.keys(m.data || {}).length; });
            n += Object.keys(payload.unmatched || {}).length;
        }
        if (!n) n = scan().keyCount;
        var saved = function (extra) {
            notify({ icon: '💾', title: '备份已保存（' + n + ' 项数据）',
                     detail: '文件已下载到本机' + (extra ? '。' + extra : '。') });
        };
        var cs = cloudApi();
        if (!cs) {
            saved('跨设备同步请回到效率中心首页操作');
            return;
        }
        if (!cloudReady()) {
            var goCfg = window.confirm(
                '备份文件已保存到本机（' + n + ' 项数据）。\n\n' +
                '但当前还没连接云端，所以手机 / 其他电脑看不到这份备份。\n\n' +
                '点「确定」去连接云端并上传；\n点「取消」就只留在这台设备。');
            if (goCfg) {
                close();
                Promise.resolve(cs.upload()).catch(function () {}).then(function () { refresh(); });
            } else {
                notify({ type: 'warn', icon: '💾', title: '备份已存本机（' + n + ' 项数据）',
                         detail: n + ' 项数据已保存到本机，但未上传云端，手机 / 其他电脑看不到。' });
            }
            return;
        }
        var go = window.confirm(
            '备份文件已保存到本机（' + n + ' 项数据）。\n\n' +
            '要同时把这份数据上传到云端吗？\n' +
            '上传后，在手机 / 其他电脑点「云端 → 本机」就能同步过去。');
        if (go) {
            close();
            Promise.resolve(cs.upload()).catch(function () {}).then(function () { refresh(); });
        } else {
            notify({ type: 'warn', icon: '💾', title: '备份已存本机（' + n + ' 项数据）',
                     detail: n + ' 项数据已保存到本机，未上传云端。' });
        }
    }

    // 侧边栏只保留「云端同步」一个入口，备份状态挂在这个入口下面，
    // 不再单独占一条「数据备份」导航项。
    function openCloudOrHub() {
        var cs = cloudApi();
        if (cs && typeof cs.openPanel === 'function') { try { cs.openPanel(); return; } catch (e) {} }
        var btn = document.getElementById('syncStatusBtn');
        if (btn) { try { btn.click(); return; } catch (e) {} }
        open();   // 兜底：直接开备份中心
    }

    function sidebarEntry() {
        // v1.6.2：侧边栏只保留「云端同步」一个入口，备份状态不再常驻侧边栏，
        // 只在点开云端同步面板时展示（activityHTML）。这里只负责清掉历史残留节点。
        var legacy = document.getElementById(SIDEBAR_ID);
        if (legacy) legacy.remove();
        var legacyStat = document.getElementById('bhSideStat');
        if (legacyStat) legacyStat.remove();
    }

    // 侧边栏常驻容量图表
    function renderSideStat() {
        var box = document.getElementById('bhSideStat');
        if (!box) return;
        refreshMeta();
        var s = scan();
        var used = s.groups.filter(function (g) { return g.keys.length > 0; }).length;
        var pct = Math.min(100, s.total / QUOTA * 100);
        var setTxt = function (id, v) { var n = document.getElementById(id); if (n) n.textContent = v; };
        setTxt('bhSsSize', fmtBytes(s.total));
        setTxt('bhSsKeys', s.keyCount);
        setTxt('bhSsMods', used);
        var bar = document.getElementById('bhSsBar');
        if (bar) {
            bar.className = 'bh-ss-bar' + (pct > 92 ? ' danger' : (pct > 80 ? ' warn' : ''));
            var i = bar.querySelector('i');
            if (i) i.style.width = Math.max(2, pct) + '%';
            bar.title = '已用 ' + fmtBytes(s.total) + ' / 约 5MB（' + pct.toFixed(1) + '%）';
        }
        box.title = '已用 ' + fmtBytes(s.total) + '，' + s.keyCount + ' 个数据键，' +
            used + ' 个模块有数据。点此打开云端同步（含备份 / 恢复 / 快照）';
        renderActLines();
    }

    // 相对时间：今天 / 昨天 / 具体日期，越近越好读
    function relTime(ts) {
        if (!ts) return '';
        var d = new Date(ts), now = new Date();
        var diff = now - ts;
        if (diff < 60000) return '刚刚';
        if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
        var sameDay = d.toDateString() === now.toDateString();
        var y = new Date(now.getTime() - 86400000);
        var hh = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
        if (sameDay) return '今天 ' + hh;
        if (d.toDateString() === y.toDateString()) return '昨天 ' + hh;
        return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hh;
    }
    function itemsText(rec) {
        if (!rec) return '';
        var parts = (rec.items || []).map(function (it) {
            return (it.icon || '🗂️') + ' ' + it.name + ' ' + it.n;
        });
        var sum = 0;
        (rec.items || []).forEach(function (it) { sum += it.n; });
        var rest = (rec.count || 0) - sum;
        if (rest > 0) parts.push('等 ' + (rec.count || 0) + ' 项');
        return parts.join(' · ');
    }

    // 备份 / 同步状态模型：侧边栏与云端同步面板共用
    function actModel() {
        refreshMeta();
        var s = scan();
        var act = getAct();
        var bk = act.backup, sy = act.sync;
        // 兼容旧记录：之前同步过但没留明细，用时间戳 + 当前数据补一条
        if (!sy || !sy.ts) {
            var lastTs = 0;
            try { lastTs = parseInt(localStorage.getItem('sync_last_sync') || '0', 10); } catch (e) {}
            if (lastTs) {
                sy = {
                    ts: lastTs, kind: '云端同步', count: s.keyCount,
                    items: s.groups.filter(function (g) { return g.keys.length > 0; })
                        .map(function (g) { return { id: g.def.id, name: g.def.name, icon: g.def.icon, n: g.keys.length }; })
                        .sort(function (a, b) { return b.n - a.n; }).slice(0, 4)
                };
            }
        }
        return {
            backup: bk, sync: sy, pending: pendingChanges(),
            size: s.total, keys: s.keyCount,
            mods: s.groups.filter(function (g) { return g.keys.length > 0; }).length
        };
    }

    // 侧边栏：最近一次备份 / 同步的时间与更新项目
    function renderActLines() {
        var m = actModel();
        var bk = m.backup, sy = m.sync;
        var setLine = function (id, rec, icon, label, emptyTxt, extra) {
            var n = document.getElementById(id);
            if (!n) return;
            if (!rec || !rec.ts) {
                n.innerHTML = '<span class="lb">' + icon + ' ' + label + '</span>' +
                              '<span class="lt none">' + emptyTxt + '</span>';
                n.title = emptyTxt;
                return;
            }
            var txt = itemsText(rec);
            n.innerHTML = '<span class="lb">' + icon + ' ' + label + '</span>' +
                          '<span class="lt">' + relTime(rec.ts) + (rec.kind ? ' · ' + esc(rec.kind) : '') + '</span>' +
                          ((txt || extra) ? '<span class="li">' + esc(txt) + (extra ? (txt ? ' · ' : '') + esc(extra) : '') + '</span>' : '');
            n.title = label + '：' + fmtTime(rec.ts) +
                      (rec.count ? '，共 ' + rec.count + ' 项数据' : '') +
                      (txt ? '\n' + txt : '');
        };
        setLine('bhSsBk', bk, '💾', '备份', '尚未备份 · 点此立即备份',
                m.keys + ' 项 / ' + fmtBytes(m.size));
        setLine('bhSsSy', sy, '☁️', '同步', '尚未同步 · 点此上传云端');
        // 备份后又改了什么 —— 这是最容易漏掉的一环
        var pd = document.getElementById('bhSsPd');
        if (pd) {
            var p = m.pending;
            if (!p.n) { pd.style.display = 'none'; return; }
            pd.style.display = '';
            var t = p.items.map(function (it) { return (it.icon || '🗂️') + ' ' + it.name + ' ' + it.n; }).join(' · ');
            pd.innerHTML = '<span class="lb">⚠️ ' + (p.since ? '备份后有改动' : '尚未备份') + '</span>' +
                           '<span class="lt">' + p.n + ' 项</span>' +
                           (t ? '<span class="li">' + esc(t) + '</span>' : '');
            pd.title = p.since
                ? (fmtTime(p.since) + ' 备份之后，有 ' + p.n + ' 项数据又改动过' + (t ? '：' + t : '') + '。点此立即备份')
                : ('本机已有 ' + p.n + ' 项数据，但还没备份过。点此立即备份');
        }
    }
    function updateBadge() {
        var b = document.getElementById('bhNavBadge');
        if (!b) return;
        var s = scan();
        b.textContent = fmtBytes(s.total);
        b.className = 'badge' + (s.total > QUOTA * 0.8 ? '' : ' empty');
        b.title = '已用 ' + fmtBytes(s.total) + ' / 约 5MB';
    }
    function watchSidebar() {
        // v1.6.2：侧边栏不再注入任何备份节点，只清理历史残留，无需监听重建
        sidebarEntry();
    }

    /* ============ 工具页入口 ============ */
    function parentHub() {
        try {
            if (window.parent && window.parent !== window && window.parent.BackupHub) return window.parent.BackupHub;
        } catch (e) {}
        return null;
    }

    // 把页面里"备份类"按钮统一指向备份中心（业务性 CSV/模板导出保留不动）
    var BUSINESS = /CSV|csv|Excel|excel|xlsx|XLSX|模板|打印|图片|PDF|pdf|截图|报告|大纲|知识点|课程|章节|行程|清单|卡片|背景|主题/;
    function absorbBackupButtons(opener) {
        var nodes = document.querySelectorAll('button, a.btn, [role="button"], input[type="button"]');
        var n = 0;
        Array.prototype.forEach.call(nodes, function (b) {
            if (b.id === 'bhFloat' || b.closest('#' + ROOT_ID)) return;
            if (b.dataset && b.dataset.bhAbsorbed) return;
            var txt = (b.innerText || b.textContent || b.value || '').trim();
            if (!txt || txt.length > 20) return;
            if (txt.indexOf('备份') < 0) return;
            if (BUSINESS.test(txt)) return;
            var style = window.getComputedStyle(b);
            if (style && style.display === 'none') return;
            b.dataset.bhAbsorbed = '1';
            b.title = '已统一到侧边栏「数据备份」中心';
            b.addEventListener('click', function (e) {
                e.preventDefault(); e.stopPropagation();
                opener();
            }, true);
            n++;
        });
        return n;
    }

    function addFloat(moduleId, label) {
        if (document.getElementById('bhFloat')) return;
        ensureStyle();
        var b = document.createElement('button');
        b.id = 'bhFloat';
        b.className = 'bh-float';
        b.type = 'button';
        b.innerHTML = '💾 <span>' + esc(label || '数据备份') + '</span>';
        b.title = '打开统一数据备份中心';
        b.addEventListener('click', function () { open(moduleId); });
        document.body.appendChild(b);
    }

    /* ============ 对外 API ============ */
    var API = {
        version: VERSION,
        manifest: MANIFEST,
        scan: scan,
        collect: collect,
        applyBackup: applyBackup,
        exportNow: exportNow,
        exportThenAskCloud: exportThenAskCloud,
        createSnapshot: createSnapshot,
        listSnapshots: listSnapshots,
        deleteSnapshot: deleteSnapshot,
        open: open,
        close: close,
        toast: toast,
        notify: notify,
        // 供 sync-github.js 调用：记录一次云端同步的时间与项目
        markSync: function (dir, keys) {
            var ks = keys || [];
            recordAct('sync', {
                kind: dir === 'down' ? '云端 → 本机' : '本机 → 云端',
                count: ks.length,
                items: summarizeKeys(ks)
            });
        },
        getActivity: function () { return { act: getAct(), pending: pendingChanges() }; },
        // 供云端同步面板内嵌：备份 / 同步的时间与更新项目
        activityHTML: function () {
            var m = actModel();
            var row = function (icon, label, rec, emptyTxt) {
                if (!rec || !rec.ts) {
                    return '<div style="margin-bottom:6px;font-size:13px;color:#444">' +
                           icon + ' <b>' + label + '</b> <span style="color:#b45309">' + emptyTxt + '</span></div>';
                }
                var txt = itemsText(rec);
                return '<div style="margin-bottom:6px;font-size:13px;color:#444">' + icon +
                       ' <b>' + label + '</b> <span style="color:#666">' + relTime(rec.ts) +
                       (rec.kind ? ' · ' + esc(rec.kind) : '') + '</span>' +
                       (txt ? '<div style="font-size:12px;color:#888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' +
                              esc(txt) + '</div>' : '') + '</div>';
            };
            var html = row('💾', '本机备份', m.backup, '尚未备份') +
                       row('☁️', '云端同步', m.sync, '尚未同步');
            if (m.pending.n) {
                var t = m.pending.items.map(function (it) {
                    return (it.icon || '') + ' ' + it.name + ' ' + it.n;
                }).join(' · ');
                html += '<div style="font-size:13px;color:#b45309">⚠️ ' +
                        (m.pending.since ? '备份后有改动' : '尚未备份') + ' <b>' + m.pending.n + '</b> 项' +
                        (t ? '<div style="font-size:12px;color:#888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' +
                             esc(t) + '</div>' : '') + '</div>';
            }
            html += '<div style="margin-top:6px;font-size:12px;color:#888">已用 ' + fmtBytes(m.size) +
                    ' · ' + m.keys + ' 个数据键 · ' + m.mods + ' 个模块有数据</div>';
            return html;
        },
        // 导航页调用
        initHub: function (opts) {
            opts = opts || {};
            var boot = function () {
                watchSidebar();
                maybeAutoSnapshot();
                // v1.6.2：侧边栏无常驻状态条，备份/同步状态只在云端同步面板内展示
                window.addEventListener('storage', function () { updateBadge(); });
                // 导航页不再加右下角悬浮按钮：侧边栏已有常驻入口 + 容量卡，悬浮按钮重复碍事
                // （工具页独立打开时没有侧边栏，仍由 mount() 提供悬浮入口）
                var legacy = document.getElementById('bhFloat');
                if (legacy) legacy.remove();
            };
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', boot);
            } else { boot(); }
            // 现有「数据管理」入口也统一指向备份中心
            var dataBtn = document.getElementById('dataBtn');
            if (dataBtn && !dataBtn.dataset.bhAbsorbed) {
                dataBtn.dataset.bhAbsorbed = '1';
                dataBtn.addEventListener('click', function (e) {
                    e.preventDefault(); e.stopPropagation();
                    open();
                }, true);
            }
            setInterval(updateBadge, 20000);
        },
        // 工具页调用
        mount: function (opts) {
            opts = opts || {};
            var id = opts.id || '';
            var run = function () {
                var ph = parentHub();
                var opener = function () {
                    if (ph) { try { ph.open(id || null); return; } catch (e) {} }
                    open(id || null);
                };
                window.__bhOpen = opener;
                // iframe 内：入口已集中在父级侧边栏/悬浮按钮，此处不再重复渲染
                if (!ph) {
                    addFloat(id, opts.label || '数据备份');
                    var fb = document.getElementById('bhFloat');
                    if (fb) fb.onclick = opener;
                }
                if (opts.absorb !== false) {
                    absorbBackupButtons(opener);
                    setTimeout(function () { absorbBackupButtons(opener); }, 1500);
                }
            };
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', run);
            } else { run(); }
        }
    };

    window.BackupHub = API;

    // 导航页自动初始化（存在 #navList 即为工作台）
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            if (document.getElementById('navList')) API.initHub();
        });
    } else if (document.getElementById('navList')) {
        API.initHub();
    }
})();
