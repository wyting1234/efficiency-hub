/* ==========================================================================
   人际交往与沟通 · 沟通复盘体系 v3.0（分页版）共享数据层
   由 tools/人积极交往.html 的主脚本块原样抽取，8 个子页面 + 总览页共用一份。

   与旧单页版的差异（①②③④ 都是「按页守卫」，不改业务逻辑）：
     ① updateStats()      —— 统计条只存在于 record 页，改为逐元素守卫
     ② init()             —— 拆成 initActionModule() + boot()，按元素存在性初始化
     ③ 弹窗遮罩/筛选绑定  —— 元素不在就跳过（原写法会抛 TypeError 废掉整块 script）
     ④ 末尾追加           —— window.SocialData 只读入口、侧栏当前项高亮、boot()
     ⑤ v20260918e 新增    —— 「如果就」场景应对方案模块（见「如果就」小节）

   数据零迁移：原 9 个 localStorage 键沿用原键名，同源（wyting1234.github.io）共享，
   旧单页版本里已录的数据直接可见，不需要导入导出；「如果就」另用 2 个新键
   （if_then_plans / if_then_categories），与既有数据互不影响。
   ========================================================================== */

        (function() {
            'use strict';

            // ===== 存储键 =====
            const STORAGE_DAILY = 'comm_daily';
            const STORAGE_WEEK = 'comm_week';
            const STORAGE_MONTH = 'comm_month';
            const STORAGE_ACTIONS = 'action_plan_data';
            const STORAGE_CATEGORIES = 'action_categories';
            const STORAGE_WISDOM = 'wisdom_data';

            // 「如果就」场景应对方案（v20260918e 新增）
            const STORAGE_IF_PLANS = 'if_then_plans';
            const STORAGE_IF_CATS = 'if_then_categories';
            const IF_DEFAULT_CATS = ['工作', '生活', '购物', '交通'];

            // 工具库存储键
            const STORAGE_DIALOG = 'tool_dialog';
            const STORAGE_RELATION = 'tool_relation';
            const STORAGE_SCRIPT = 'tool_script';

            // ===== 工具 =====
            function getStore(key) {
                try { return JSON.parse(localStorage.getItem(key)) || null; } catch { return null; }
            }

            function setStore(key, data) {
                localStorage.setItem(key, JSON.stringify(data));
            }

            function generateId() { return Date.now() + '_' + Math.random().toString(36).substr(2, 6); }

            function escHtml(str) {
                if (!str) return '';
                const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
                return str.replace(/[&<>"']/g, m => map[m]);
            }

            // ===== 台账部分（完整保留） =====
            // ---- 日复盘 ----
            function getDaily() { return getStore(STORAGE_DAILY) || []; }

            function setDaily(arr) { setStore(STORAGE_DAILY, arr);
                updateStats();
                renderDaily(); }

            window.saveDaily = function() {
                const data = {
                    id: Date.now(),
                    create: new Date().toLocaleString(),
                    event: document.getElementById('d_event').value.trim(),
                    target: document.getElementById('d_target').value.trim(),
                    actual: document.getElementById('d_actual').value.trim(),
                    dim: document.getElementById('d_dim').value,
                    emotion: document.getElementById('d_emotion').value.trim(),
                    check: document.getElementById('d_check').value.trim(),
                    improve: document.getElementById('d_improve').value.trim(),
                    execute: document.getElementById('d_execute').value.trim(),
                    done: false
                };
                if (!data.event) { alert('请填写【事件】描述'); return; }
                const list = getDaily();
                list.unshift(data);
                setDaily(list);
                alert('✅ 事件卡已保存！');
                clearDailyForm();
            };

            window.clearDailyForm = function() {
                document.querySelectorAll('#tabDaily input, #tabDaily textarea').forEach(el => {
                    if (el.id !== 'd_dim') el.value = '';
                });
                document.getElementById('d_dim').selectedIndex = 0;
            };

            function renderDaily() {
                const list = getDaily();
                const wrap = document.getElementById('dailyListWrap');
                if (!list.length) {
                    wrap.innerHTML =
                    `<div class="empty-state"><div class="icon">📭</div><p>还没有日复盘记录，开始添加第一条吧！</p></div>`;
                    return;
                }
                let html = '';
                list.forEach((item, idx) => {
                    const dimLabel = item.dim || 'D?';
                    html += `
                    <div class="record-item ${item.done ? 'done' : ''}">
                        <div class="record-header">
                            <span class="tag">${dimLabel}</span>
                            <span class="time">${item.create}</span>
                            <label class="record-check" style="margin-left:auto;">
                                <input type="checkbox" ${item.done ? 'checked' : ''} onchange="toggleDailyDone(${idx})">
                                已执行
                            </label>
                        </div>
                        <div class="record-body">
                            <p><strong>事件：</strong>${escHtml(item.event)}</p>
                            ${item.target ? `<p><strong>目标：</strong>${escHtml(item.target)}</p>` : ''}
                            ${item.improve ? `<p><strong>改进方案：</strong>${escHtml(item.improve)}</p>` : ''}
                            ${item.execute ? `<p><strong>执行反馈：</strong>${escHtml(item.execute)}</p>` : '<p style="color:var(--text-muted);font-size:13px;">⏳ 执行反馈待填写</p>'}
                        </div>
                        <div class="record-actions">
                            <button class="btn btn-danger btn-sm" onclick="delDaily(${idx})">🗑️ 删除</button>
                        </div>
                    </div>`;
                });
                wrap.innerHTML = html;
                updateStats();
            }

            window.toggleDailyDone = function(idx) {
                const list = getDaily();
                if (!list[idx]) return;
                list[idx].done = !list[idx].done;
                setDaily(list);
                renderDaily();
            };

            window.delDaily = function(idx) {
                if (!confirm('确定删除这条复盘记录？')) return;
                const list = getDaily();
                list.splice(idx, 1);
                setDaily(list);
                renderDaily();
            };

            window.clearAllDaily = function() {
                if (!confirm('⚠️ 确认清空全部日复盘记录，无法恢复！')) return;
                setDaily([]);
                renderDaily();
            };

            window.exportDaily = function() {
                const data = getDaily();
                if (!data.length) { alert('暂无数据可导出'); return; }
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = '复盘日记录备份.json';
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 3000);
            };

            /* =============================================================
               「如果就」场景应对方案（v20260918e 新增）
               -------------------------------------------------------------
               定位：把日复盘、周复盘里反复出现的场景，沉淀成「如果…就…」的
               自动化应对方案（implementation intention）—— 复习时能重读，
               临场时能直接调用，落成一句下次真做得出来的动作。

               数据结构（只存字段，不存拼好的句子 —— 改措辞不会与历史脱节）：
                 if_then_plans = [{
                   id, create, updated, date, place, category, who,
                   rounds: [{ meDo, meSay, meMind, meFeel,
                              taDo, taSay, taMind, taFace }],
                   then, used, lastUsed
                 }]
                 if_then_categories = ['工作','生活','购物','交通', …]

               写入纪律：只取一次对象图，「改哪张存哪张」。
               getStore 每次都 JSON.parse 出新对象 → 先 mutate 一张图、再去另一张
               图上保存，改动会被静默丢弃（本文件 action 模块的既有缺陷即此因）。
               ============================================================= */
            let ifFilter = '__all__';   // 当前筛选的场景分类
            let ifReview = false;       // 复习模式：只显示主句，点卡片翻面看细节

            function getIfPlans() { return getStore(STORAGE_IF_PLANS) || []; }

            function getIfCats() {
                const c = getStore(STORAGE_IF_CATS);
                return (Array.isArray(c) && c.length) ? c : IF_DEFAULT_CATS.slice();
            }

            function setIfCats(arr) { setStore(STORAGE_IF_CATS, arr); }

            function findIfPlan(id) {
                const all = getIfPlans();
                for (let i = 0; i < all.length; i++) {
                    if (String(all[i].id) === String(id)) return all[i];
                }
                return null;
            }

            function todayStr() {
                const d = new Date();
                return d.getFullYear() + '-' +
                    String(d.getMonth() + 1).padStart(2, '0') + '-' +
                    String(d.getDate()).padStart(2, '0');
            }

            /* 由结构化字段拼出「如果…就…」主句。
               目标句式：如果在【工作】场景下，客户说「太贵了」，同时皱眉、身体后仰，我就先复述他的顾虑。 */
            function buildIfSentence(it) {
                const cat = (it.category || '').trim();
                const who = (it.who || '').trim() || '对方';
                const r = (it.rounds && it.rounds[0]) || {};
                let s = cat ? ('如果在【' + cat + '】场景下，') : '如果';
                const parts = [];
                if (r.taDo) parts.push('正在' + r.taDo);
                if (r.taSay) parts.push('说「' + r.taSay + '」');
                if (r.taFace) parts.push((parts.length ? '同时' : '') + r.taFace);
                if (parts.length) s += who + parts.join('，') + '，';
                s += '我就' + ((it.then || '').trim() || '…');
                return s;
            }

            // ---- 轻提示（比 alert 打断感低；连续触发时后一条覆盖前一条）----
            function toastIf(msg) {
                const el = document.getElementById('ifToast');
                if (!el) return;
                el.textContent = msg;
                el.classList.add('show');
                if (toastIf._t) clearTimeout(toastIf._t);
                toastIf._t = setTimeout(function() { el.classList.remove('show'); }, 1800);
            }

            function fallbackCopyIf(t) {
                try {
                    const ta = document.createElement('textarea');
                    ta.value = t;
                    ta.style.position = 'fixed';
                    ta.style.opacity = '0';
                    document.body.appendChild(ta);
                    ta.select();
                    const ok = document.execCommand('copy');
                    document.body.removeChild(ta);
                    return !!ok;
                } catch (e) { return false; }
            }

            window.copyIfSentence = function(id) {
                const it = findIfPlan(id);
                if (!it) return;
                const txt = buildIfSentence(it);
                let ok = false;
                try {
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(txt).then(
                            function() { toastIf('📋 已复制主句'); },
                            function() { toastIf(fallbackCopyIf(txt) ? '📋 已复制主句' : '⚠️ 复制失败，请手动选中'); });
                        return;
                    }
                } catch (e) { /* 落到下面的兜底 */ }
                ok = fallbackCopyIf(txt);
                toastIf(ok ? '📋 已复制主句' : '⚠️ 复制失败，请手动选中');
            };

            // ---- 轮次编辑（弹窗内，可重复添加）----
            function ifRoundHtml(n) {
                const f = function(cls, label, hint, ph) {
                    return '<div class="form-group"><label>' + label +
                        (hint ? ' <span class="hint">' + hint + '</span>' : '') +
                        '</label><input class="' + cls + '" placeholder="' + (ph || '') + '"></div>';
                };
                return '<div class="it-round-edit">' +
                    '<div class="it-round-edit-head"><span>第 ' + n + ' 轮</span>' +
                    '<button type="button" class="it-round-del" onclick="removeIfRound(this)">🗑️ 删除本轮</button></div>' +
                    '<div class="it-side-label">🙋 我</div>' +
                    '<div class="it-grid">' +
                        f('ir-me-do', '我在做', '当时的动作', '例：正在翻报价单') +
                        f('ir-me-say', '我说了', '', '例：这已经是最优惠的价了') +
                        f('ir-me-mind', '我的心理是', '', '例：有点心虚，怕丢单') +
                        f('ir-me-feel', '我感觉', '情绪', '例：着急、紧张') +
                    '</div>' +
                    '<div class="it-side-label">👤 对方</div>' +
                    '<div class="it-grid">' +
                        f('ir-ta-do', '对方在做', '当时的动作', '例：把报价单推回来') +
                        f('ir-ta-say', '对方说了', '', '例：太贵了，别家更便宜') +
                        f('ir-ta-mind', '对方的心理是', '', '例：在试探底线') +
                        f('ir-ta-face', '对方的微表情', '', '例：皱眉、身体后仰') +
                    '</div></div>';
            }

            function renumberIfRounds() {
                const box = document.getElementById('ifRounds');
                if (!box) return;
                for (let i = 0; i < box.children.length; i++) {
                    const s = box.children[i].querySelector('.it-round-edit-head span');
                    if (s) s.textContent = '第 ' + (i + 1) + ' 轮';
                }
            }

            window.addIfRound = function() {
                const box = document.getElementById('ifRounds');
                if (!box) return;
                box.insertAdjacentHTML('beforeend', ifRoundHtml(box.children.length + 1));
                updateIfPreview();
                const last = box.lastElementChild;
                if (last) {
                    const first = last.querySelector('.ir-me-do');
                    if (first) first.focus();
                }
            };

            window.removeIfRound = function(btn) {
                const box = document.getElementById('ifRounds');
                if (!box) return;
                const row = btn && btn.closest ? btn.closest('.it-round-edit') : null;
                if (!row) return;
                if (box.children.length <= 1) { toastIf('至少保留一轮'); return; }
                box.removeChild(row);
                renumberIfRounds();
                updateIfPreview();
            };

            function collectIfRounds() {
                const box = document.getElementById('ifRounds');
                if (!box) return [];
                const out = [];
                for (let i = 0; i < box.children.length; i++) {
                    const row = box.children[i];
                    const g = function(c) {
                        const el = row.querySelector('.' + c);
                        return el ? el.value.trim() : '';
                    };
                    const r = {
                        meDo: g('ir-me-do'), meSay: g('ir-me-say'),
                        meMind: g('ir-me-mind'), meFeel: g('ir-me-feel'),
                        taDo: g('ir-ta-do'), taSay: g('ir-ta-say'),
                        taMind: g('ir-ta-mind'), taFace: g('ir-ta-face')
                    };
                    // 整轮全空 → 不落盘，避免留下空壳轮次
                    if (Object.keys(r).some(function(k) { return r[k]; })) out.push(r);
                }
                return out;
            }

            function updateIfPreview() {
                const box = document.getElementById('itPreview');
                if (!box) return;
                const rounds = collectIfRounds();
                const catEl = document.getElementById('it_cat');
                const whoEl = document.getElementById('it_who');
                const thenEl = document.getElementById('it_then');
                const draft = {
                    category: catEl ? catEl.value : '',
                    who: whoEl ? whoEl.value : '',
                    rounds: [rounds[0] || {}],
                    then: thenEl ? thenEl.value : ''
                };
                let h = '<span class="it-preview-label">保存后这条会显示为</span>场景：' + escHtml(buildIfSentence(draft));
                if (rounds.length > 1) {
                    h += '<div class="it-preview-more">另外 ' + (rounds.length - 1) + ' 轮对话还原会存进卡片详情，点「展开」查看。</div>';
                }
                box.innerHTML = h;
            }

            function bindIfPreview() {
                const m = document.getElementById('ifThenModal');
                if (!m || m.getAttribute('data-preview-bound') === '1') return;
                m.setAttribute('data-preview-bound', '1');
                // 委托到弹窗层：后加的轮次也能实时进预览
                m.addEventListener('input', updateIfPreview);
                m.addEventListener('change', updateIfPreview);
            }

            function fillIfCatSelect(sel) {
                if (!sel) return;
                const cats = getIfCats();
                const cur = sel.value;
                sel.innerHTML = cats.map(function(c) {
                    return '<option value="' + escHtml(c) + '">' + escHtml(c) + '</option>';
                }).join('');
                if (cur && cats.indexOf(cur) >= 0) sel.value = cur;
            }

            window.openIfModal = function(id) {
                const modal = document.getElementById('ifThenModal');
                if (!modal) return;
                const it = id ? findIfPlan(id) : null;
                if (id && !it) { toastIf('这条方案已不存在'); return; }

                fillIfCatSelect(document.getElementById('it_cat'));
                document.getElementById('ifModalTitle').textContent =
                    it ? '✏️ 编辑「如果…就…」方案' : '🎯 新增「如果…就…」方案';
                document.getElementById('it_editId').value = it ? it.id : '';
                document.getElementById('it_date').value = it ? (it.date || '') : todayStr();
                document.getElementById('it_place').value = it ? (it.place || '') : '';
                document.getElementById('it_who').value = it ? (it.who || '') : '';

                if (it && it.category) {
                    // 原分类若已被删除，先补进下拉，免得静默改成第一项
                    const sel = document.getElementById('it_cat');
                    let has = false;
                    for (let i = 0; i < sel.options.length; i++) {
                        if (sel.options[i].value === it.category) { has = true; break; }
                    }
                    if (!has) {
                        sel.insertAdjacentHTML('beforeend',
                            '<option value="' + escHtml(it.category) + '">' + escHtml(it.category) + '</option>');
                    }
                    sel.value = it.category;
                }

                const box = document.getElementById('ifRounds');
                box.innerHTML = '';
                const rounds = (it && it.rounds && it.rounds.length) ? it.rounds : [{}];
                for (let i = 0; i < rounds.length; i++) {
                    box.insertAdjacentHTML('beforeend', ifRoundHtml(i + 1));
                    const row = box.lastElementChild;
                    const r = rounds[i] || {};
                    const set = function(c, v) {
                        const el = row.querySelector('.' + c);
                        if (el) el.value = v || '';
                    };
                    set('ir-me-do', r.meDo); set('ir-me-say', r.meSay);
                    set('ir-me-mind', r.meMind); set('ir-me-feel', r.meFeel);
                    set('ir-ta-do', r.taDo); set('ir-ta-say', r.taSay);
                    set('ir-ta-mind', r.taMind); set('ir-ta-face', r.taFace);
                }

                document.getElementById('it_then').value = it ? (it.then || '') : '';
                updateIfPreview();
                modal.classList.add('active');
            };

            window.closeIfModal = function() {
                const m = document.getElementById('ifThenModal');
                if (m) m.classList.remove('active');
            };

            window.editIfPlan = function(id) { openIfModal(id); };

            window.saveIfPlan = function() {
                const thenEl = document.getElementById('it_then');
                const then = thenEl.value.trim();
                if (!then) {
                    alert('请填写【我就…】—— 这条方案的关键就是那一句可执行的应对');
                    thenEl.focus();
                    return;
                }
                const rounds = collectIfRounds();
                if (!rounds.length) {
                    alert('请至少填写一轮对话还原（对方说了什么 / 做了什么）');
                    return;
                }
                const editId = document.getElementById('it_editId').value;
                const payload = {
                    date: document.getElementById('it_date').value,
                    place: document.getElementById('it_place').value.trim(),
                    category: document.getElementById('it_cat').value,
                    who: document.getElementById('it_who').value.trim(),
                    rounds: rounds,
                    then: then
                };

                const list = getIfPlans();          // ← 只取一次对象图，改哪张存哪张
                let hit = false;
                if (editId) {
                    list.forEach(function(p) {
                        if (String(p.id) === String(editId)) {
                            Object.keys(payload).forEach(function(k) { p[k] = payload[k]; });
                            p.updated = new Date().toLocaleString();
                            hit = true;
                        }
                    });
                }
                if (!hit) {
                    payload.id = generateId();
                    payload.create = new Date().toLocaleString();
                    payload.used = 0;
                    payload.lastUsed = '';
                    list.unshift(payload);
                }

                setStore(STORAGE_IF_PLANS, list);   // 存的就是上面那张图
                renderIfThen();
                closeIfModal();
                toastIf(!editId ? '✅ 方案已保存'
                                : (hit ? '✅ 方案已更新' : '✅ 原记录已不存在，已另存为新方案'));
            };

            window.delIfPlan = function(id) {
                const it = findIfPlan(id);
                if (!it) return;
                if (!confirm('删除这条应对方案？\n\n' + buildIfSentence(it))) return;
                const list = getIfPlans().filter(function(p) {
                    return String(p.id) !== String(id);
                });
                setStore(STORAGE_IF_PLANS, list);
                renderIfThen();
                toastIf('🗑️ 已删除');
            };

            window.markIfUsed = function(id) {
                const list = getIfPlans();
                let used = 0, hit = false;
                list.forEach(function(p) {
                    if (String(p.id) === String(id)) {
                        p.used = (p.used || 0) + 1;
                        p.lastUsed = new Date().toLocaleString();
                        used = p.used;
                        hit = true;
                    }
                });
                if (!hit) return;
                setStore(STORAGE_IF_PLANS, list);
                renderIfThen();
                toastIf('✅ 记一次实战调用（累计 ' + used + ' 次）');
            };

            window.setIfFilter = function(c) { ifFilter = c; renderIfThen(); };

            window.toggleIfReview = function() {
                ifReview = !ifReview;
                renderIfThen();
                toastIf(ifReview ? '🎯 复习模式：只看主句，点卡片看细节' : '已退出复习模式');
            };

            window.flipIfCard = function(el) {
                if (el && el.classList) el.classList.toggle('flipped');
            };

            /* 复习模式下整张卡可点（翻面）；普通模式只有「展开」那一行响应，
               免得点空白处也在展开/收起。按钮与「展开」各自处理，不在这里重复翻转。 */
            window.ifCardClick = function(e, el) {
                if (!ifReview) return;
                const t = e && e.target;
                if (t && t.closest && (t.closest('.it-op') || t.closest('.it-fold'))) return;
                flipIfCard(el);
            };

            // ---- 场景分类管理 ----
            function renderIfCatManager() {
                const box = document.getElementById('ifCatList');
                if (!box) return;
                const cats = getIfCats();
                const counts = {};
                getIfPlans().forEach(function(p) {
                    const c = p.category || '未分类';
                    counts[c] = (counts[c] || 0) + 1;
                });
                box.innerHTML = cats.map(function(c, i) {
                    return '<div class="ifcat-row">' +
                        '<input class="ifcat-name" data-i="' + i + '" value="' + escHtml(c) + '">' +
                        '<span class="ifcat-n">' + (counts[c] || 0) + ' 条</span>' +
                        '<button class="it-op" onclick="delIfCat(' + i + ')" title="删除分类">🗑️</button>' +
                        '</div>';
                }).join('') || '<p class="it-no-round">还没有分类，在下面添加一个。</p>';

                box.onchange = function(e) {
                    const el = e.target;
                    if (!el || !el.classList.contains('ifcat-name')) return;
                    const idx = parseInt(el.getAttribute('data-i'), 10);
                    const v = el.value.trim();
                    const arr = getIfCats();
                    if (!v) { toastIf('分类名不能为空'); renderIfCatManager(); return; }
                    if (arr[idx] === v) return;
                    if (arr.indexOf(v) >= 0) { toastIf('已存在同名分类'); renderIfCatManager(); return; }
                    const old = arr[idx];
                    arr[idx] = v;
                    setIfCats(arr);
                    // 同步已保存方案上的分类名（改名字不该让旧方案掉出来）
                    const plans = getIfPlans();
                    let touched = false;
                    plans.forEach(function(p) {
                        if (p.category === old) { p.category = v; touched = true; }
                    });
                    if (touched) setStore(STORAGE_IF_PLANS, plans);
                    if (ifFilter === old) ifFilter = v;
                    renderIfCatManager();
                    renderIfThen();
                    const sel = document.getElementById('it_cat');
                    if (sel) fillIfCatSelect(sel);
                    toastIf('已重命名为「' + v + '」');
                };
            }

            window.openIfCatManager = function() {
                const m = document.getElementById('ifCatModal');
                if (!m) return;
                renderIfCatManager();
                m.classList.add('active');
            };

            window.closeIfCatManager = function() {
                const m = document.getElementById('ifCatModal');
                if (m) m.classList.remove('active');
                const sel = document.getElementById('it_cat');
                if (sel) fillIfCatSelect(sel);
                updateIfPreview();
                renderIfThen();
            };

            window.addIfCat = function() {
                const el = document.getElementById('ifNewCat');
                if (!el) return;
                const v = el.value.trim();
                if (!v) { toastIf('先填一个分类名称'); el.focus(); return; }
                const arr = getIfCats();
                if (arr.indexOf(v) >= 0) { toastIf('已存在同名分类'); return; }
                arr.push(v);
                setIfCats(arr);
                el.value = '';
                renderIfCatManager();
                renderIfThen();
                const sel = document.getElementById('it_cat');
                if (sel) { fillIfCatSelect(sel); sel.value = v; }
                updateIfPreview();
                toastIf('已添加分类「' + v + '」');
            };

            window.delIfCat = function(i) {
                const arr = getIfCats();
                const name = arr[i];
                if (name === undefined) return;
                const n = getIfPlans().filter(function(p) { return p.category === name; }).length;
                if (!confirm('删除分类「' + name + '」？' +
                    (n ? '\n\n已有 ' + n + ' 条方案属于该分类，它们会变成「未分类」，方案本身不会被删除。' : ''))) return;
                arr.splice(i, 1);
                setIfCats(arr);
                // 兑现确认框里的承诺：属于该分类的方案变成「未分类」，
                // 而不是留下一个已不存在的分类名（那样方案只能从「全部」里翻到）。
                const plans = getIfPlans();
                let touched = false;
                plans.forEach(function(p) {
                    if (p.category === name) { p.category = ''; touched = true; }
                });
                if (touched) setStore(STORAGE_IF_PLANS, plans);
                if (ifFilter === name) ifFilter = '__all__';
                renderIfCatManager();
                renderIfThen();
                const sel = document.getElementById('it_cat');
                if (sel) fillIfCatSelect(sel);
                toastIf('已删除分类「' + name + '」');
            };

            window.resetIfCats = function() {
                if (!confirm('把场景分类重置为默认（工作 / 生活 / 购物 / 交通）？\n\n已保存的方案不会被删除。')) return;
                setIfCats(IF_DEFAULT_CATS.slice());
                ifFilter = '__all__';
                renderIfCatManager();
                renderIfThen();
                const sel = document.getElementById('it_cat');
                if (sel) fillIfCatSelect(sel);
                toastIf('已重置为默认分类');
            };

            // ---- 列表渲染 ----
            function ifCardHtml(it) {
                const cat = it.category || '未分类';
                const who = (it.who || '').trim() || '对方';
                const when = [it.date, it.place].filter(Boolean).join(' · ');
                const used = it.used || 0;
                const rounds = it.rounds || [];
                let detail;
                if (rounds.length) {
                    detail = rounds.map(function(r, i) {
                        const li = function(label, v) {
                            return v ? '<li><b>' + label + '</b>' + escHtml(v) + '</li>' : '';
                        };
                        const meLi = li('在做：', r.meDo) + li('说了：', r.meSay) +
                                     li('心理：', r.meMind) + li('感觉：', r.meFeel);
                        const taLi = li('在做：', r.taDo) + li('说了：', r.taSay) +
                                     li('心理：', r.taMind) + li('微表情：', r.taFace);
                        return '<div class="it-round">' +
                            '<div class="it-round-no">第 ' + (i + 1) + ' 轮</div>' +
                            '<div class="it-round-cols">' +
                                '<div class="it-side it-me"><div class="it-side-title">🙋 我</div><ul>' +
                                    (meLi || '<li>（未记录）</li>') + '</ul></div>' +
                                '<div class="it-side it-ta"><div class="it-side-title">👤 ' + escHtml(who) + '</div><ul>' +
                                    (taLi || '<li>（未记录）</li>') + '</ul></div>' +
                            '</div></div>';
                    }).join('');
                } else {
                    detail = '<p class="it-no-round">（这条方案没填对话还原）</p>';
                }
                return '<div class="it-card" data-cat="' + escHtml(cat) + '" onclick="ifCardClick(event, this)">' +
                    '<div class="it-card-head">' +
                        '<span class="it-cat">' + escHtml(cat) + '</span>' +
                        (when ? '<span class="it-when">' + escHtml(when) + '</span>' : '') +
                        (used ? '<span class="it-used">实战 ' + used + ' 次</span>' : '') +
                        '<div class="it-ops">' +
                            '<button class="it-op" onclick="markIfUsed(\'' + it.id + '\')" title="这次真的用上了，计数 +1">✅ 用到了</button>' +
                            '<button class="it-op" onclick="copyIfSentence(\'' + it.id + '\')" title="复制这句话">📋 复制</button>' +
                            '<button class="it-op" onclick="editIfPlan(\'' + it.id + '\')" title="编辑">✏️</button>' +
                            '<button class="it-op" onclick="delIfPlan(\'' + it.id + '\')" title="删除">🗑️</button>' +
                        '</div>' +
                    '</div>' +
                    '<p class="it-sentence"><span class="it-lead">场景：</span>' + escHtml(buildIfSentence(it)) + '</p>' +
                    (rounds.length
                        ? '<div class="it-fold" onclick="flipIfCard(this.closest(\'.it-card\'))">' +
                          '<span class="it-fold-txt">' + (rounds.length > 1 ? '展开 ' + rounds.length + ' 轮对话还原' : '对话还原与双方心理') +
                          '</span></div>'
                        : '') +
                    '<div class="it-detail">' + detail + '</div>' +
                '</div>';
            }

            function renderIfThen() {
                const wrap = document.getElementById('ifThenList');
                if (!wrap) return;
                const all = getIfPlans();
                const cats = getIfCats();

                const meta = document.getElementById('ifMeta');
                if (meta) {
                    let used = 0;
                    const cover = {};
                    all.forEach(function(p) {
                        used += (p.used || 0);
                        // 与筛选 chips 同口径：没填分类的算「未分类」，否则两处数字对不上
                        cover[p.category || '未分类'] = 1;
                    });
                    meta.textContent = '共 ' + all.length + ' 条方案 · 覆盖 ' +
                        Object.keys(cover).length + ' 类场景 · 实战调用 ' + used + ' 次';
                }

                const chips = document.getElementById('ifChips');
                if (chips) {
                    const counts = {};
                    all.forEach(function(p) {
                        const c = p.category || '未分类';
                        counts[c] = (counts[c] || 0) + 1;
                    });
                    // 兜底：分类名已从清单里删掉、但方案还挂着它的历史数据，也要给个入口，
                    // 否则这些方案只能从「全部」里翻到。
                    const orphans = Object.keys(counts).filter(function(c) {
                        return c !== '未分类' && cats.indexOf(c) < 0;
                    });
                    let h = '<button class="it-chip' + (ifFilter === '__all__' ? ' on' : '') +
                        '" data-cat="__all__">全部 <b>' + all.length + '</b></button>';
                    cats.concat(orphans).forEach(function(c) {
                        const orphan = cats.indexOf(c) < 0;
                        h += '<button class="it-chip' + (ifFilter === c ? ' on' : '') +
                            '" data-cat="' + escHtml(c) + '"' +
                            (orphan ? ' title="该分类已从分类清单移除，方案仍保留"' : '') + '>' +
                            escHtml(c) + ' <b>' + (counts[c] || 0) + '</b></button>';
                    });
                    if (counts['未分类']) {
                        h += '<button class="it-chip' + (ifFilter === '未分类' ? ' on' : '') +
                            '" data-cat="未分类">未分类 <b>' + counts['未分类'] + '</b></button>';
                    }
                    chips.innerHTML = h;
                    chips.onclick = function(e) {
                        const b = e.target && e.target.closest ? e.target.closest('.it-chip') : null;
                        if (!b) return;
                        ifFilter = b.getAttribute('data-cat') || '__all__';
                        renderIfThen();
                    };
                }

                const rb = document.getElementById('ifReviewBtn');
                if (rb) {
                    rb.textContent = ifReview ? '📖 退出复习' : '🎯 复习模式';
                    rb.classList.toggle('btn-primary', ifReview);
                    rb.classList.toggle('btn-outline', !ifReview);
                }

                wrap.classList.toggle('review', !!ifReview);

                const list = (ifFilter === '__all__') ? all : all.filter(function(p) {
                    return (p.category || '未分类') === ifFilter;
                });
                if (!list.length) {
                    wrap.innerHTML = '<div class="empty-state"><div class="icon">🎯</div><p>' +
                        (all.length ? '这个场景下还没有方案，换个分类看看。'
                                    : '还没有「如果…就…」方案，点右上角「➕ 新增方案」写第一条。') +
                        '</p></div>';
                    return;
                }
                wrap.innerHTML = list.map(ifCardHtml).join('');
            }

            function initIfThen() {
                bindIfPreview();
                renderIfThen();
            }

            // 日复盘底部的引导条 → 切到「如果就」标签页并回到页首
            function gotoIfThenTab() {
                const btn = document.querySelector('#recordTabs .tab-btn[data-tab="tabIfThen"]');
                if (btn) btn.click();
                try { window.scrollTo({ top: 0, behavior: 'smooth' }); }
                catch (e) { window.scrollTo(0, 0); }
            }
            window.gotoIfThenTab = gotoIfThenTab;

            // ---- 周练习 ----
            function getWeek() { return getStore(STORAGE_WEEK) || []; }

            function setWeek(arr) { setStore(STORAGE_WEEK, arr);
                updateStats();
                renderWeek(); }

            window.saveWeekTask = function() {
                const data = {
                    id: Date.now(),
                    week: document.getElementById('w_week').value.trim(),
                    dim: document.getElementById('w_dim').value,
                    action: document.getElementById('w_action').value.trim(),
                    result: document.getElementById('w_result').value.trim()
                };
                if (!data.week) { alert('请填写周次'); return; }
                const list = getWeek();
                list.unshift(data);
                setWeek(list);
                alert('✅ 周任务已保存！');
                document.getElementById('w_week').value = '';
                document.getElementById('w_action').value = '';
                document.getElementById('w_result').value = '';
            };

            function renderWeek() {
                const list = getWeek();
                const wrap = document.getElementById('weekListWrap');
                if (!list.length) {
                    wrap.innerHTML = `<div class="empty-state"><div class="icon">📆</div><p>暂无周练习任务</p></div>`;
                    return;
                }
                let html = '';
                list.forEach(item => {
                    html += `
                    <div class="record-item">
                        <div class="record-header">
                            <span class="tag">${item.dim || 'D?'}</span>
                            <span class="time">${escHtml(item.week)}</span>
                        </div>
                        <div class="record-body">
                            <p><strong>练习动作：</strong>${escHtml(item.action) || '未填写'}</p>
                            <p><strong>执行复盘：</strong>${escHtml(item.result) || '⏳ 待填写'}</p>
                        </div>
                    </div>`;
                });
                wrap.innerHTML = html;
                updateStats();
            }

            // ---- 月度评分 ----
            function getMonth() { return getStore(STORAGE_MONTH) || []; }

            function setMonth(arr) { setStore(STORAGE_MONTH, arr);
                updateStats();
                renderMonth(); }

            window.saveMonthScore = function() {
                const data = {
                    id: Date.now(),
                    month: document.getElementById('m_month').value.trim(),
                    d1: parseInt(document.getElementById('m_d1').value) || 0,
                    d2: parseInt(document.getElementById('m_d2').value) || 0,
                    d3: parseInt(document.getElementById('m_d3').value) || 0,
                    d4: parseInt(document.getElementById('m_d4').value) || 0,
                    d5: parseInt(document.getElementById('m_d5').value) || 0,
                    note: document.getElementById('m_note').value.trim()
                };
                if (!data.month) { alert('请填写年月'); return; }
                const list = getMonth();
                list.unshift(data);
                setMonth(list);
                alert('✅ 月度评估已存档！');
                document.getElementById('m_month').value = '';
                document.getElementById('m_note').value = '';
            };

            function renderMonth() {
                const list = getMonth();
                const wrap = document.getElementById('monthListWrap');
                if (!list.length) {
                    wrap.innerHTML = `<div class="empty-state"><div class="icon">📊</div><p>暂无月度评分记录</p></div>`;
                    return;
                }
                let html = '';
                list.forEach(item => {
                    const avg = ((item.d1 || 0) + (item.d2 || 0) + (item.d3 || 0) + (item.d4 || 0) + (item.d5 || 0)) / 5;
                    html += `
                    <div class="record-item">
                        <div class="record-header">
                            <span class="tag">${escHtml(item.month)}</span>
                            <span class="time">均分 ${avg.toFixed(1)}</span>
                        </div>
                        <div class="record-body">
                            <p>D1: ${item.d1 || 0} ｜ D2: ${item.d2 || 0} ｜ D3: ${item.d3 || 0} ｜ D4: ${item.d4 || 0} ｜ D5: ${item.d5 || 0}</p>
                            ${item.note ? `<p><strong>小结：</strong>${escHtml(item.note)}</p>` : ''}
                        </div>
                    </div>`;
                });
                wrap.innerHTML = html;
                updateStats();
            }

            function updateStats() {
                /* 分页版：统计条只存在于 record 页，侧栏徽标每页都有 → 逐个守卫 */
                const setTxt = function(id, v) {
                    const el = document.getElementById(id);
                    if (el) el.textContent = v;
                };
                const daily = getDaily();
                const week = getWeek();
                const month = getMonth();
                const done = daily.filter(d => d.done).length;
                setTxt('statDaily', daily.length);
                setTxt('statDone', done);
                setTxt('statWeek', week.length);
                setTxt('statMonth', month.length);
                setTxt('dailyCountBadge', daily.length);
            }

            document.querySelectorAll('#recordTabs .tab-btn').forEach(btn => {
                btn.addEventListener('click', function() {
                    document.querySelectorAll('#recordTabs .tab-btn').forEach(b => b.classList.remove('active'));
                    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
                    this.classList.add('active');
                    document.getElementById(this.dataset.tab).classList.add('active');
                });
            });

            // =============================================================
            // 工具库：关键对话准备表
            // =============================================================
            function getDialogs() { return getStore(STORAGE_DIALOG) || []; }

            function setDialogs(arr) { setStore(STORAGE_DIALOG, arr);
                renderDialogs(); }

            function renderDialogs() {
                const list = getDialogs();
                const wrap = document.getElementById('dialogListWrap');
                document.getElementById('dialogCount').textContent = list.length;
                if (!list.length) {
                    wrap.innerHTML = `<div class="tool-table-empty">暂无记录，点击“新增准备”添加第一条</div>`;
                    return;
                }
                let html = `<table>
                    <thead><tr><th>对话目标</th><th>对方目标</th><th>共同利益</th><th>风险点</th><th>开场设计</th><th>底线与备选</th><th style="width:120px;">操作</th></tr></thead><tbody>`;
                list.forEach((item, idx) => {
                    html += `<tr>
                        <td>${escHtml(item.target || '-')}</td>
                        <td>${escHtml(item.other || '-')}</td>
                        <td>${escHtml(item.common || '-')}</td>
                        <td>${escHtml(item.risk || '-')}</td>
                        <td>${escHtml(item.open || '-')}</td>
                        <td>${escHtml(item.backup || '-')}</td>
                        <td><div class="row-actions">
                            <button class="btn-edit-tool" onclick="editDialog('${item.id}')">✏️</button>
                            <button class="btn-del-tool" onclick="deleteDialog('${item.id}')">🗑️</button>
                        </div></td>
                    </tr>`;
                });
                html += `</tbody></table>`;
                wrap.innerHTML = html;
            }

            window.openDialogModal = function(data) {
                const modal = document.getElementById('dialogModal');
                const title = document.getElementById('dialogModalTitle');
                if (data) {
                    title.textContent = '✏️ 编辑关键对话准备';
                    document.getElementById('dialog_target').value = data.target || '';
                    document.getElementById('dialog_other').value = data.other || '';
                    document.getElementById('dialog_common').value = data.common || '';
                    document.getElementById('dialog_risk').value = data.risk || '';
                    document.getElementById('dialog_open').value = data.open || '';
                    document.getElementById('dialog_backup').value = data.backup || '';
                    document.getElementById('dialogEditId').value = data.id;
                } else {
                    title.textContent = '✏️ 新增关键对话准备';
                    document.getElementById('dialog_target').value = '';
                    document.getElementById('dialog_other').value = '';
                    document.getElementById('dialog_common').value = '';
                    document.getElementById('dialog_risk').value = '';
                    document.getElementById('dialog_open').value = '';
                    document.getElementById('dialog_backup').value = '';
                    document.getElementById('dialogEditId').value = '';
                }
                modal.classList.add('active');
            };

            window.closeDialogModal = function() {
                document.getElementById('dialogModal').classList.remove('active');
            };

            window.saveDialog = function() {
                const target = document.getElementById('dialog_target').value.trim();
                if (!target) { alert('请填写对话目标'); return; }
                const data = {
                    id: document.getElementById('dialogEditId').value || generateId(),
                    target: target,
                    other: document.getElementById('dialog_other').value.trim(),
                    common: document.getElementById('dialog_common').value.trim(),
                    risk: document.getElementById('dialog_risk').value.trim(),
                    open: document.getElementById('dialog_open').value.trim(),
                    backup: document.getElementById('dialog_backup').value.trim()
                };
                let list = getDialogs();
                const editId = document.getElementById('dialogEditId').value;
                if (editId) {
                    const idx = list.findIndex(item => item.id === editId);
                    if (idx > -1) list[idx] = data;
                } else {
                    list.unshift(data);
                }
                setDialogs(list);
                closeDialogModal();
                alert('✅ 已保存！');
            };

            window.editDialog = function(id) {
                const list = getDialogs();
                const item = list.find(d => d.id === id);
                if (item) openDialogModal(item);
            };

            window.deleteDialog = function(id) {
                if (!confirm('确定删除该条记录吗？')) return;
                let list = getDialogs();
                list = list.filter(item => item.id !== id);
                setDialogs(list);
            };

            // =============================================================
            // 工具库：关系账户管理表
            // =============================================================
            function getRelations() { return getStore(STORAGE_RELATION) || []; }

            function setRelations(arr) { setStore(STORAGE_RELATION, arr);
                renderRelations(); }

            function renderRelations() {
                const list = getRelations();
                const wrap = document.getElementById('relationListWrap');
                document.getElementById('relationCount').textContent = list.length;
                if (!list.length) {
                    wrap.innerHTML = `<div class="tool-table-empty">暂无记录，点击“新增关系”添加第一条</div>`;
                    return;
                }
                let html = `<table>
                    <thead><tr><th>关系人</th><th>关系层级</th><th>上次互动</th><th>互动质量</th><th>对方关心的事</th><th>下次跟进动作</th><th style="width:100px;">操作</th></tr></thead><tbody>`;
                list.forEach(item => {
                    html += `<tr>
                        <td><strong>${escHtml(item.name)}</strong></td>
                        <td>${escHtml(item.level || '-')}</td>
                        <td>${escHtml(item.last || '-')}</td>
                        <td>${item.quality || '-'}</td>
                        <td>${escHtml(item.concern || '-')}</td>
                        <td>${escHtml(item.action || '-')}</td>
                        <td><div class="row-actions">
                            <button class="btn-edit-tool" onclick="editRelation('${item.id}')">✏️</button>
                            <button class="btn-del-tool" onclick="deleteRelation('${item.id}')">🗑️</button>
                        </div></td>
                    </tr>`;
                });
                html += `</tbody></table>`;
                wrap.innerHTML = html;
            }

            window.openRelationModal = function(data) {
                const modal = document.getElementById('relationModal');
                document.getElementById('relationModalTitle').textContent = data ? '✏️ 编辑关系账户' : '✏️ 新增关系账户';
                document.getElementById('relation_name').value = data ? data.name || '' : '';
                document.getElementById('relation_level').value = data ? data.level || '核心维护' : '核心维护';
                document.getElementById('relation_last').value = data ? data.last || '' : '';
                document.getElementById('relation_quality').value = data ? data.quality || 3 : 3;
                document.getElementById('relation_concern').value = data ? data.concern || '' : '';
                document.getElementById('relation_action').value = data ? data.action || '' : '';
                document.getElementById('relationEditId').value = data ? data.id : '';
                modal.classList.add('active');
            };

            window.closeRelationModal = function() {
                document.getElementById('relationModal').classList.remove('active');
            };

            window.saveRelation = function() {
                const name = document.getElementById('relation_name').value.trim();
                if (!name) { alert('请填写关系人'); return; }
                const data = {
                    id: document.getElementById('relationEditId').value || generateId(),
                    name: name,
                    level: document.getElementById('relation_level').value,
                    last: document.getElementById('relation_last').value.trim(),
                    quality: parseInt(document.getElementById('relation_quality').value) || 0,
                    concern: document.getElementById('relation_concern').value.trim(),
                    action: document.getElementById('relation_action').value.trim()
                };
                let list = getRelations();
                const editId = document.getElementById('relationEditId').value;
                if (editId) {
                    const idx = list.findIndex(item => item.id === editId);
                    if (idx > -1) list[idx] = data;
                } else {
                    list.unshift(data);
                }
                setRelations(list);
                closeRelationModal();
                alert('✅ 已保存！');
            };

            window.editRelation = function(id) {
                const list = getRelations();
                const item = list.find(d => d.id === id);
                if (item) openRelationModal(item);
            };

            window.deleteRelation = function(id) {
                if (!confirm('确定删除该条记录吗？')) return;
                let list = getRelations();
                list = list.filter(item => item.id !== id);
                setRelations(list);
            };

            // =============================================================
            // 工具库：个人话术武器库
            // =============================================================
            function getScripts() { return getStore(STORAGE_SCRIPT) || []; }

            function setScripts(arr) { setStore(STORAGE_SCRIPT, arr);
                renderScripts(); }

            function renderScripts() {
                const list = getScripts();
                const wrap = document.getElementById('scriptListWrap');
                document.getElementById('scriptCount').textContent = list.length;
                if (!list.length) {
                    wrap.innerHTML = `<div class="tool-table-empty">暂无记录，点击“新增话术”添加第一条</div>`;
                    return;
                }
                let html = `<table>
                    <thead><tr><th>场景</th><th>话术/策略</th><th>来源</th><th>效果验证</th><th style="width:100px;">操作</th></tr></thead><tbody>`;
                list.forEach(item => {
                    html += `<tr>
                        <td><strong>${escHtml(item.scene || '-')}</strong></td>
                        <td>${escHtml(item.content || '-')}</td>
                        <td>${escHtml(item.source || '-')}</td>
                        <td>${escHtml(item.effect || '-')}</td>
                        <td><div class="row-actions">
                            <button class="btn-edit-tool" onclick="editScript('${item.id}')">✏️</button>
                            <button class="btn-del-tool" onclick="deleteScript('${item.id}')">🗑️</button>
                        </div></td>
                    </tr>`;
                });
                html += `</tbody></table>`;
                wrap.innerHTML = html;
            }

            window.openScriptModal = function(data) {
                const modal = document.getElementById('scriptModal');
                document.getElementById('scriptModalTitle').textContent = data ? '✏️ 编辑话术' : '✏️ 新增话术';
                document.getElementById('script_scene').value = data ? data.scene || '' : '';
                document.getElementById('script_content').value = data ? data.content || '' : '';
                document.getElementById('script_source').value = data ? data.source || '' : '';
                document.getElementById('script_effect').value = data ? data.effect || '' : '';
                document.getElementById('scriptEditId').value = data ? data.id : '';
                modal.classList.add('active');
            };

            window.closeScriptModal = function() {
                document.getElementById('scriptModal').classList.remove('active');
            };

            window.saveScript = function() {
                const scene = document.getElementById('script_scene').value.trim();
                if (!scene) { alert('请填写场景'); return; }
                const content = document.getElementById('script_content').value.trim();
                if (!content) { alert('请填写话术/策略'); return; }
                const data = {
                    id: document.getElementById('scriptEditId').value || generateId(),
                    scene: scene,
                    content: content,
                    source: document.getElementById('script_source').value.trim(),
                    effect: document.getElementById('script_effect').value.trim()
                };
                let list = getScripts();
                const editId = document.getElementById('scriptEditId').value;
                if (editId) {
                    const idx = list.findIndex(item => item.id === editId);
                    if (idx > -1) list[idx] = data;
                } else {
                    list.unshift(data);
                }
                setScripts(list);
                closeScriptModal();
                alert('✅ 已保存！');
            };

            window.editScript = function(id) {
                const list = getScripts();
                const item = list.find(d => d.id === id);
                if (item) openScriptModal(item);
            };

            window.deleteScript = function(id) {
                if (!confirm('确定删除该条记录吗？')) return;
                let list = getScripts();
                list = list.filter(item => item.id !== id);
                setScripts(list);
            };

            // =============================================================
            // 落地行动相关（含类别管理）
            // =============================================================
            function getDefaultCategories() {
                return [{
                    id: generateId(),
                    name: '🧘 自我认知与情绪管理',
                    children: [
                        { id: generateId(), name: '每日情绪觉察日记', children: [] },
                        { id: generateId(), name: '压力调节（深呼吸/暂停）', children: [] },
                        { id: generateId(), name: '一致性表达（言行合一）', children: [] }
                    ]
                }, {
                    id: generateId(),
                    name: '👂 倾听与理解',
                    children: [
                        { id: generateId(), name: '积极倾听（不打断、复述）', children: [] },
                        { id: generateId(), name: '共情训练（换位思考）', children: [] },
                        { id: generateId(), name: '开放式提问挖掘需求', children: [] }
                    ]
                }, {
                    id: generateId(),
                    name: '🗣️ 表达与说服',
                    children: [
                        { id: generateId(), name: '结构化表达（结论先行）', children: [] },
                        { id: generateId(), name: '适配听众调整措辞', children: [] },
                        { id: generateId(), name: '非语言沟通（眼神/语气）', children: [] }
                    ]
                }, {
                    id: generateId(),
                    name: '⚖️ 冲突处理与谈判',
                    children: [
                        { id: generateId(), name: '分歧管理（对事不对人）', children: [] },
                        { id: generateId(), name: '利益平衡寻找共同点', children: [] },
                        { id: generateId(), name: '达成共识的技术', children: [] }
                    ]
                }, {
                    id: generateId(),
                    name: '🤝 关系经营与人脉',
                    children: [
                        { id: generateId(), name: '信任建立（持续跟进）', children: [] },
                        { id: generateId(), name: '边界管理（适度距离）', children: [] },
                        { id: generateId(), name: '长期维护（互惠共赢）', children: [] }
                    ]
                }];
            }

            function getCategories() { return getStore(STORAGE_CATEGORIES) || []; }

            function saveCategories(cats) {
                setStore(STORAGE_CATEGORIES, cats);
                renderCategoryTree();
                updateCategorySelects();
            }

            function renderCategoryTree() {
                const cats = getCategories();
                const container = document.getElementById('categoryTreeContainer');
                if (!cats.length) {
                    container.innerHTML = `<div class="empty-state"><p>暂无类别，请添加根类别或重置为默认</p></div>`;
                    return;
                }
                container.innerHTML = buildCategoryTreeHTML(cats);
            }

            function buildCategoryTreeHTML(items, depth) {
                depth = depth || 0;
                let html = '';
                items.forEach(item => {
                    html += `<div class="tree-node" style="padding-left:${depth*20}px;">`;
                    html += `<div class="node-label">
                                <span class="toggle" onclick="toggleTreeNode(this)">▶</span>
                                <span class="name">📂 ${escHtml(item.name)}</span>
                                <span class="actions">
                                    <button onclick="renameCategory('${item.id}')" title="重命名">✏️</button>
                                    <button onclick="addSubCategory('${item.id}')" title="添加子类别">➕子</button>
                                    <button onclick="deleteCategory('${item.id}')" title="删除类别">🗑️</button>
                                </span>
                            </div>`;
                    if (item.children && item.children.length) {
                        html += `<div class="children collapsed">${buildCategoryTreeHTML(item.children, depth+1)}</div>`;
                    } else {
                        html += `<div class="children collapsed" style="padding-left:20px;color:var(--text-muted);font-size:13px;">（无子类别）</div>`;
                    }
                    html += `</div>`;
                });
                return html;
            }

            window.renameCategory = function(id) {
                const cats = getCategories();
                let target = null;
                const findNode = (list) => {
                    for (let item of list) {
                        if (item.id === id) { target = item; return true; }
                        if (item.children && item.children.length) {
                            if (findNode(item.children)) return true;
                        }
                    }
                    return false;
                };
                findNode(cats);
                if (!target) { alert('未找到该类别'); return; }
                const newName = prompt('请输入新的名称：', target.name);
                if (newName === null) return;
                const trimmed = newName.trim();
                if (trimmed === '') { alert('名称不能为空'); return; }
                target.name = trimmed;
                saveCategories(cats);
            };

            window.resetDefaultCategories = function() {
                if (!confirm('⚠️ 这将覆盖当前所有类别，并替换为预设的沟通能力五维分类。确定继续吗？')) return;
                saveCategories(getDefaultCategories());
                alert('✅ 已重置为默认类别。');
            };

            window.addRootCategory = function() {
                const name = prompt('请输入根类别名称：');
                if (!name || name.trim() === '') return;
                const cats = getCategories();
                if (cats.some(c => c.name === name.trim())) { alert('类别已存在'); return; }
                cats.push({ id: generateId(), name: name.trim(), children: [] });
                saveCategories(cats);
            };

            window.addSubCategory = function(parentId) {
                const name = prompt('请输入子类别名称：');
                if (!name || name.trim() === '') return;
                const cats = getCategories();
                const findAndAdd = (list) => {
                    for (let item of list) {
                        if (item.id === parentId) {
                            if (item.children.some(c => c.name === name.trim())) { alert('子类别已存在'); return false; }
                            item.children.push({ id: generateId(), name: name.trim(), children: [] });
                            return true;
                        }
                        if (item.children && item.children.length) {
                            if (findAndAdd(item.children)) return true;
                        }
                    }
                    return false;
                };
                if (findAndAdd(cats)) {
                    saveCategories(cats);
                } else {
                    alert('未找到父类别');
                }
            };

            window.deleteCategory = function(id) {
                if (!confirm('确定删除该类别及其所有子类别吗？')) return;
                let cats = getCategories();
                const removeById = (list) => {
                    for (let i = list.length - 1; i >= 0; i--) {
                        if (list[i].id === id) { list.splice(i, 1); return true; }
                        if (list[i].children && list[i].children.length) {
                            if (removeById(list[i].children)) return true;
                        }
                    }
                    return false;
                };
                removeById(cats);
                saveCategories(cats);
                updateActionsAfterCategoryDelete(id);
            };

            function updateActionsAfterCategoryDelete(catId) {
                const data = getActionsData();
                data.years.forEach(year => {
                    year.months.forEach(month => {
                        month.weeks.forEach(week => {
                            week.actions = week.actions.filter(a => a.categoryId !== catId);
                        });
                    });
                });
                saveActionsData(data);
            }

            function flattenCategories(cats, prefix) {
                prefix = prefix || '';
                let result = [];
                cats.forEach(c => {
                    result.push({ id: c.id, name: prefix + c.name });
                    if (c.children && c.children.length) {
                        result = result.concat(flattenCategories(c.children, prefix + '  '));
                    }
                });
                return result;
            }

            function updateCategorySelects() {
                const cats = getCategories();
                const flat = flattenCategories(cats);
                const selects = ['actionCategory', 'categoryFilter'];
                selects.forEach(id => {
                    const sel = document.getElementById(id);
                    if (!sel) return;
                    const currentVal = sel.value;
                    sel.innerHTML = id === 'categoryFilter' ? '<option value="">全部类别</option>' : '<option value="">无</option>';
                    flat.forEach(c => {
                        const opt = document.createElement('option');
                        opt.value = c.id;
                        opt.textContent = c.name;
                        sel.appendChild(opt);
                    });
                    if (currentVal && flat.some(c => c.id === currentVal)) {
                        sel.value = currentVal;
                    }
                });
            }

            // ---- 行动数据 ----
            function getActionsData() { return getStore(STORAGE_ACTIONS) || { years: [] }; }

            function saveActionsData(data) {
                setStore(STORAGE_ACTIONS, data);
                renderTree();
                renderActions();
            }

            let selectedPath = { year: null, month: null, week: null };

            function renderTree() {
                const data = getActionsData();
                const container = document.getElementById('treeContainer');
                if (!data.years || data.years.length === 0) {
                    container.innerHTML = `<div class="empty-state"><p>暂无年份，请点击“添加年份”创建</p></div>`;
                    return;
                }
                let html = '';
                data.years.forEach((yearObj) => {
                    const yearName = yearObj.name;
                    html += `<div class="tree-node">`;
                    html += `<div class="node-label">
                                <span class="toggle" onclick="toggleTreeNode(this)">▶</span>
                                <span class="name">📅 ${escHtml(yearName)}</span>
                                <span class="actions">
                                    <button onclick="addMonth('${escHtml(yearName)}')" title="添加月份">➕月</button>
                                    <button onclick="deleteYear('${escHtml(yearName)}')" title="删除年份">🗑️</button>
                                </span>
                            </div>`;
                    html += `<div class="children collapsed">`;
                    if (yearObj.months && yearObj.months.length) {
                        yearObj.months.forEach((monthObj) => {
                            const monthName = monthObj.name;
                            html += `<div class="tree-node">
                                        <div class="node-label">
                                            <span class="toggle" onclick="toggleTreeNode(this)">▶</span>
                                            <span class="name">📆 ${escHtml(monthName)}月</span>
                                            <span class="actions">
                                                <button onclick="addWeek('${escHtml(yearName)}','${escHtml(monthName)}')" title="添加周次">➕周</button>
                                                <button onclick="deleteMonth('${escHtml(yearName)}','${escHtml(monthName)}')" title="删除月份">🗑️</button>
                                            </span>
                                        </div>
                                        <div class="children collapsed">`;
                            if (monthObj.weeks && monthObj.weeks.length) {
                                monthObj.weeks.forEach((weekObj) => {
                                    const weekName = weekObj.name;
                                    const isSelected = (selectedPath.year === yearName && selectedPath.month ===
                                        monthName && selectedPath.week === weekName);
                                    html += `<div class="tree-node">
                                                <div class="node-label" style="cursor:pointer;" onclick="selectWeek('${escHtml(yearName)}','${escHtml(monthName)}','${escHtml(weekName)}')">
                                                    <span class="toggle" style="visibility:hidden;">▶</span>
                                                    <span class="name" style="${isSelected ? 'font-weight:700;color:var(--primary);' : ''}">🗓️ ${escHtml(weekName)}</span>
                                                    <span class="actions">
                                                        <button onclick="deleteWeek('${escHtml(yearName)}','${escHtml(monthName)}','${escHtml(weekName)}')" title="删除周次">🗑️</button>
                                                    </span>
                                                </div>
                                            </div>`;
                                });
                            } else {
                                html +=
                                `<div class="tree-node" style="color:var(--text-muted);font-size:13px;padding-left:20px;">暂无周次</div>`;
                            }
                            html += `</div></div>`;
                        });
                    } else {
                        html += `<div class="tree-node" style="color:var(--text-muted);font-size:13px;padding-left:20px;">暂无月份</div>`;
                    }
                    html += `</div></div>`;
                });
                container.innerHTML = html;
                if (selectedPath.year) {
                    document.querySelectorAll('.tree-node').forEach(node => {
                        const label = node.querySelector('.node-label .name');
                        if (label && label.textContent.includes(selectedPath.year)) {
                            let children = node.querySelector('.children');
                            if (children) children.classList.remove('collapsed');
                            node.querySelectorAll('.tree-node').forEach(sub => {
                                const subLabel = sub.querySelector('.node-label .name');
                                if (subLabel && subLabel.textContent.includes(selectedPath.month + '月')) {
                                    let subChild = sub.querySelector('.children');
                                    if (subChild) subChild.classList.remove('collapsed');
                                }
                            });
                        }
                    });
                }
                document.querySelectorAll('.toggle').forEach(t => {
                    const parent = t.closest('.tree-node');
                    if (parent) {
                        const children = parent.querySelector('.children');
                        if (children && !children.classList.contains('collapsed')) {
                            t.textContent = '▼';
                            t.classList.add('expanded');
                        } else {
                            t.textContent = '▶';
                            t.classList.remove('expanded');
                        }
                    }
                });
            }

            window.toggleTreeNode = function(el) {
                const node = el.closest('.tree-node');
                if (!node) return;
                const children = node.querySelector('.children');
                if (!children) return;
                children.classList.toggle('collapsed');
                if (children.classList.contains('collapsed')) {
                    el.textContent = '▶';
                    el.classList.remove('expanded');
                } else {
                    el.textContent = '▼';
                    el.classList.add('expanded');
                }
            };

            window.addYear = function() {
                const name = prompt('请输入年份（如 2026）：');
                if (!name || name.trim() === '') return;
                const data = getActionsData();
                if (data.years.some(y => y.name === name.trim())) { alert('已存在'); return; }
                data.years.push({ name: name.trim(), months: [] });
                saveActionsData(data);
            };

            window.deleteYear = function(year) {
                if (!confirm(`确定删除 ${year} 及所有子项？`)) return;
                const data = getActionsData();
                data.years = data.years.filter(y => y.name !== year);
                if (selectedPath.year === year) selectedPath = { year: null, month: null, week: null };
                saveActionsData(data);
                renderActions();
            };

            window.addMonth = function(year) {
                const name = prompt('请输入月份（数字）：');
                if (!name || name.trim() === '') return;
                const data = getActionsData();
                const yearObj = data.years.find(y => y.name === year);
                if (!yearObj) return alert('年份不存在');
                if (yearObj.months.some(m => m.name === name.trim())) { alert('月份已存在'); return; }
                yearObj.months.push({ name: name.trim(), weeks: [] });
                saveActionsData(data);
            };

            window.deleteMonth = function(year, month) {
                if (!confirm(`确定删除 ${year}年${month}月？`)) return;
                const data = getActionsData();
                const yearObj = data.years.find(y => y.name === year);
                if (!yearObj) return;
                yearObj.months = yearObj.months.filter(m => m.name !== month);
                if (selectedPath.year === year && selectedPath.month === month) selectedPath = { year: null, month: null,
                        week: null };
                saveActionsData(data);
                renderActions();
            };

            window.addWeek = function(year, month) {
                const name = prompt('请输入周次（如 W33）：');
                if (!name || name.trim() === '') return;
                const data = getActionsData();
                const yearObj = data.years.find(y => y.name === year);
                if (!yearObj) return alert('年份不存在');
                const monthObj = yearObj.months.find(m => m.name === month);
                if (!monthObj) return alert('月份不存在');
                if (monthObj.weeks.some(w => w.name === name.trim())) { alert('周次已存在'); return; }
                monthObj.weeks.push({ name: name.trim(), actions: [] });
                saveActionsData(data);
            };

            window.deleteWeek = function(year, month, week) {
                if (!confirm(`确定删除 ${year}年${month}月 ${week}？`)) return;
                const data = getActionsData();
                const yearObj = data.years.find(y => y.name === year);
                if (!yearObj) return;
                const monthObj = yearObj.months.find(m => m.name === month);
                if (!monthObj) return;
                monthObj.weeks = monthObj.weeks.filter(w => w.name !== week);
                if (selectedPath.year === year && selectedPath.month === month && selectedPath.week === week)
                    selectedPath = { year: null, month: null, week: null };
                saveActionsData(data);
                renderActions();
            };

            window.selectWeek = function(year, month, week) {
                selectedPath = { year, month, week };
                renderTree();
                renderActions();
            };

            function renderActions() {
                const container = document.getElementById('actionListContainer');
                const label = document.getElementById('selectedPathLabel');
                const { year, month, week } = selectedPath;
                if (!year || !month || !week) {
                    label.textContent = '📌 请选择周次';
                    container.innerHTML =
                    `<div class="empty-state"><div class="icon">📋</div><p>请点击树中的周次节点查看行动清单</p></div>`;
                    return;
                }
                label.textContent = `📌 ${year}年${month}月 · ${week}`;

                const data = getActionsData();
                const yearObj = data.years.find(y => y.name === year);
                if (!yearObj) { container.innerHTML =
                    `<div class="empty-state"><p>年份不存在</p></div>`; return; }
                const monthObj = yearObj.months.find(m => m.name === month);
                if (!monthObj) { container.innerHTML =
                    `<div class="empty-state"><p>月份不存在</p></div>`; return; }
                const weekObj = monthObj.weeks.find(w => w.name === week);
                if (!weekObj) { container.innerHTML =
                    `<div class="empty-state"><p>周次不存在</p></div>`; return; }

                let actions = weekObj.actions || [];
                const filterCat = document.getElementById('categoryFilter').value;
                if (filterCat) {
                    actions = actions.filter(a => a.categoryId === filterCat);
                }

                if (actions.length === 0) {
                    container.innerHTML =
                        `<div class="empty-state"><div class="icon">📭</div><p>该周次暂无行动项，点击“新增行动”添加</p></div>`;
                    return;
                }
                const cats = getCategories();
                const flatCats = flattenCategories(cats);
                const catMap = {};
                flatCats.forEach(c => catMap[c.id] = c.name);

                let html = '';
                actions.forEach((act) => {
                    const catName = act.categoryId ? (catMap[act.categoryId] || '未分类') : '';
                    html += `
                        <div class="action-item ${act.done ? 'done' : ''}">
                            <div class="action-content">
                                <div class="title">
                                    ${catName ? `<span class="category-tag">${escHtml(catName)}</span>` : ''}
                                    ${escHtml(act.title)}
                                </div>
                                ${act.desc ? `<div class="desc">${escHtml(act.desc)}</div>` : ''}
                            </div>
                            <div class="action-actions">
                                <button class="btn-done" onclick="toggleActionDone('${act.id}')">${act.done ? '✅ 已完成' : '☑️ 标记完成'}</button>
                                <button class="btn-edit" onclick="editAction('${act.id}')">✏️ 编辑</button>
                                <button class="btn-del" onclick="deleteAction('${act.id}')">🗑️ 删除</button>
                            </div>
                        </div>
                    `;
                });
                container.innerHTML = html;
            }

            /* data 可由调用方传入。写入类调用必须传入「自己即将保存的那张图」：
               getStore 每次 JSON.parse 都产出新对象，不传 data 时本函数返回的是另一张图，
               mutation 会落在它身上，而 save 出去的却是不含改动的原图 —— 静默丢失。 */
            function getCurrentWeekObj(data) {
                const { year, month, week } = selectedPath;
                if (!year || !month || !week) return null;
                data = data || getActionsData();
                const yearObj = data.years.find(y => y.name === year);
                if (!yearObj) return null;
                const monthObj = yearObj.months.find(m => m.name === month);
                if (!monthObj) return null;
                return monthObj.weeks.find(w => w.name === week) || null;
            }

            window.showAddAction = function() {
                const weekObj = getCurrentWeekObj();
                if (!weekObj) { alert('请先在时间树中选择一个周次'); return; }
                document.getElementById('actionModalTitle').textContent = '✏️ 新增行动项';
                document.getElementById('actionTitle').value = '';
                document.getElementById('actionDesc').value = '';
                document.getElementById('actionCategory').value = '';
                document.getElementById('actionEditId').value = '';
                document.getElementById('actionModal').classList.add('active');
            };

            window.closeActionModal = function() {
                document.getElementById('actionModal').classList.remove('active');
            };

            window.saveAction = function() {
                const title = document.getElementById('actionTitle').value.trim();
                if (!title) { alert('请填写标题'); return; }
                const desc = document.getElementById('actionDesc').value.trim();
                const categoryId = document.getElementById('actionCategory').value;
                const editId = document.getElementById('actionEditId').value;

                const data = getActionsData();
                const weekObj = getCurrentWeekObj(data);
                if (!weekObj) { alert('请先选择周次'); return; }
                if (!weekObj.actions) weekObj.actions = [];

                if (editId) {
                    const act = weekObj.actions.find(a => a.id === editId);
                    if (act) {
                        act.title = title;
                        act.desc = desc;
                        act.categoryId = categoryId;
                    }
                } else {
                    weekObj.actions.push({
                        id: generateId(),
                        title: title,
                        desc: desc,
                        categoryId: categoryId,
                        done: false
                    });
                }
                saveActionsData(data);   /* 存的就是上面 mutate 过的那张图 */
                closeActionModal();
                renderActions();
            };

            window.editAction = function(id) {
                const weekObj = getCurrentWeekObj();
                if (!weekObj) return;
                const act = weekObj.actions.find(a => a.id === id);
                if (!act) return;
                document.getElementById('actionModalTitle').textContent = '✏️ 编辑行动项';
                document.getElementById('actionTitle').value = act.title;
                document.getElementById('actionDesc').value = act.desc || '';
                document.getElementById('actionCategory').value = act.categoryId || '';
                document.getElementById('actionEditId').value = id;
                document.getElementById('actionModal').classList.add('active');
            };

            window.deleteAction = function(id) {
                if (!confirm('确定删除该行动项吗？')) return;
                const data = getActionsData();
                const weekObj = getCurrentWeekObj(data);
                if (!weekObj) return;
                weekObj.actions = (weekObj.actions || []).filter(a => a.id !== id);
                saveActionsData(data);
            };

            window.toggleActionDone = function(id) {
                const data = getActionsData();
                const weekObj = getCurrentWeekObj(data);
                if (!weekObj) return;
                const act = (weekObj.actions || []).find(a => a.id === id);
                if (!act) return;
                act.done = !act.done;
                saveActionsData(data);
            };

            window.openCategoryManager = function() {
                document.getElementById('categoryModal').classList.add('active');
                renderCategoryTree();
                updateCategorySelects();
            };

            window.closeCategoryManager = function() {
                document.getElementById('categoryModal').classList.remove('active');
            };

            // =============================================================
            // 他山之玉
            // =============================================================
            function getWisdom() { return getStore(STORAGE_WISDOM) || []; }

            function saveWisdomData(arr) {
                setStore(STORAGE_WISDOM, arr);
                renderWisdom();
            }

            window.saveWisdom = function() {
                const source = document.getElementById('w_source').value.trim();
                const date = document.getElementById('w_date').value;
                const content = document.getElementById('w_content').value.trim();
                const evalText = document.getElementById('w_eval').value.trim();
                const breakdown = document.getElementById('w_breakdown').value.trim();
                if (!source) { alert('请填写信息来源'); return; }
                if (!content) { alert('请填写主要内容'); return; }
                const data = {
                    id: generateId(),
                    source: source,
                    date: date || new Date().toISOString().slice(0, 10),
                    content: content,
                    eval: evalText,
                    breakdown: breakdown
                };
                const list = getWisdom();
                list.unshift(data);
                saveWisdomData(list);
                document.getElementById('w_source').value = '';
                document.getElementById('w_date').value = '';
                document.getElementById('w_content').value = '';
                document.getElementById('w_eval').value = '';
                document.getElementById('w_breakdown').value = '';
                alert('✅ 已收录！');
            };

            function renderWisdom() {
                const list = getWisdom();
                const container = document.getElementById('wisdomListContainer');
                if (!list.length) {
                    container.innerHTML = `<div class="empty-state"><div class="icon">📚</div><p>暂无收录，开始添加第一条吧</p></div>`;
                    return;
                }
                let html = '';
                list.forEach(item => {
                    html += `
                        <div class="wisdom-item">
                            <div class="wisdom-header">
                                <span class="source">📖 ${escHtml(item.source)}</span>
                                <span>📅 ${escHtml(item.date)}</span>
                            </div>
                            <div class="wisdom-body">
                                <div class="content">${escHtml(item.content)}</div>
                                ${item.eval ? `<div class="eval">💬 评价：${escHtml(item.eval)}</div>` : ''}
                                ${item.breakdown ? `<div class="breakdown">🔧 行为拆解：${escHtml(item.breakdown)}</div>` : ''}
                            </div>
                            <div class="wisdom-actions">
                                <button onclick="deleteWisdom('${item.id}')">🗑️ 删除</button>
                            </div>
                        </div>
                    `;
                });
                container.innerHTML = html;
            }

            window.deleteWisdom = function(id) {
                if (!confirm('确定删除该条记录吗？')) return;
                let list = getWisdom();
                list = list.filter(item => item.id !== id);
                saveWisdomData(list);
            };

            // =============================================================
            // 初始化
            // =============================================================
            /* ===== 落地行动（action.html）的数据准备与首渲染 =====
               原 init() 的后半段：只在本页 DOM 存在时执行。 */
            function initActionModule() {
                // 行动数据（首次访问播种一棵 2026 / 8月 / W33-W34 的空树）
                let actionsData = getActionsData();
                if (!actionsData.years || actionsData.years.length === 0) {
                    actionsData.years = [{
                        name: '2026',
                        months: [{
                            name: '8',
                            weeks: [
                                { name: 'W33', actions: [] },
                                { name: 'W34', actions: [] }
                            ]
                        }]
                    }];
                    saveActionsData(actionsData);
                }

                // 类别数据（首次访问播种默认类别；旧的通用示例类别一并替换）
                let cats = getCategories();
                if (cats.length > 0) {
                    const first = cats[0];
                    if (first.name && (first.name.includes('日常工作') || first.name.includes('KPI') || first.name.includes(
                            '周例会'))) {
                        cats = getDefaultCategories();
                        saveCategories(cats);
                    }
                } else {
                    cats = getDefaultCategories();
                    saveCategories(cats);
                }

                const firstYear = actionsData.years[0];
                if (firstYear && firstYear.months && firstYear.months.length) {
                    const firstMonth = firstYear.months[0];
                    if (firstMonth && firstMonth.weeks && firstMonth.weeks.length) {
                        selectedPath = {
                            year: firstYear.name,
                            month: firstMonth.name,
                            week: firstMonth.weeks[0].name
                        };
                    }
                }
                renderTree();
                renderActions();
                updateCategorySelects();
            }

            /* =============================================================
               分页版启动：每个页面只初始化「本页 DOM 里真的存在」的模块。
               靠元素存在性判定，不靠 URL 猜 —— 子页面被 iframe 加载、
               被直接打开、被重定向到任意路径，行为都一致。
               ============================================================= */
            function boot() {
                const has = function(id) { return !!document.getElementById(id); };

                // —— 复盘台账（record.html）：3 个记录页签 ——
                if (has('dailyListWrap')) renderDaily();
                if (has('weekListWrap')) renderWeek();
                if (has('monthListWrap')) renderMonth();
                if (has('statsGrid')) updateStats();

                // —— 复盘台账 · 日复盘页里的「如果就」应对方案 ——
                if (has('ifThenList')) initIfThen();

                // —— 工具与模板（toolkit.html）：对话准备 / 关系账户 / 话术库 ——
                if (has('dialogListWrap')) renderDialogs();
                if (has('relationListWrap')) renderRelations();
                if (has('scriptListWrap')) renderScripts();

                // —— 落地行动（action.html）——
                if (has('actionListContainer') || has('treeContainer')) initActionModule();

                // —— 他山之玉（wisdom.html）——
                if (has('wisdomListContainer')) renderWisdom();

                // —— 台账页的日期占位符（例：2026-09 / 2026-W38）——
                const now = new Date();
                const year = now.getFullYear();
                const month = String(now.getMonth() + 1).padStart(2, '0');
                const mMonth = document.getElementById('m_month');
                if (mMonth) mMonth.placeholder = `${year}-${month}`;
                const wWeek = document.getElementById('w_week');
                if (wWeek) wWeek.placeholder = `${year}-W${String(Math.ceil((now - new Date(year,0,1))/86400000/7)).padStart(2,'0')}`;

                // —— 侧栏「复盘台账」条数徽标：任何一页都能看到 ——
                if (!has('statsGrid')) {
                    const badge = document.getElementById('dailyCountBadge');
                    if (badge) badge.textContent = getDaily().length;
                }
            }

            // ===== 移动端菜单 =====
            const sidebar = document.getElementById('sidebar');
            const overlay = document.getElementById('sidebarOverlay');
            const toggleBtn = document.getElementById('menuToggle');

            function toggleMenu(open) {
                if (!sidebar || !overlay) return;
                const isOpen = open !== undefined ? open : sidebar.classList.toggle('open');
                sidebar.classList.toggle('open', isOpen);
                overlay.classList.toggle('active', isOpen);
                document.body.style.overflow = isOpen ? 'hidden' : '';
            }
            if (toggleBtn) toggleBtn.addEventListener('click', (e) => { e.stopPropagation();
                toggleMenu(); });
            if (overlay) overlay.addEventListener('click', () => toggleMenu(false));
            document.querySelectorAll('.sidebar-nav a').forEach(link => {
                link.addEventListener('click', () => { if (window.innerWidth <= 768) toggleMenu(false); });
            });

            /* 分页后每个页面只保留自己那几个弹窗：元素不存在就整段跳过。
               （原写法是 document.getElementById('x').addEventListener(...) ——
                 元素不在时抛 TypeError，会把该 script 块剩下的语句全部废掉。） */
            function bindOverlayClose(id, fn) {
                const el = document.getElementById(id);
                if (!el) return;
                el.addEventListener('click', function(e) { if (e.target === this) fn(); });
            }
            bindOverlayClose('actionModal', closeActionModal);
            bindOverlayClose('categoryModal', closeCategoryManager);
            bindOverlayClose('dialogModal', closeDialogModal);
            bindOverlayClose('relationModal', closeRelationModal);
            bindOverlayClose('scriptModal', closeScriptModal);
            bindOverlayClose('ifThenModal', closeIfModal);
            bindOverlayClose('ifCatModal', closeIfCatManager);

            const catFilterEl = document.getElementById('categoryFilter');
            if (catFilterEl) catFilterEl.addEventListener('change', renderActions);

            // 暴露全局
            window.renderDialogs = renderDialogs;
            window.renderRelations = renderRelations;
            window.renderScripts = renderScripts;

            /* 分页版新增：把「只读」数据入口暴露给总览页做统计用（不暴露任何写入口） */
            window.SocialData = {
                getDaily: getDaily, getWeek: getWeek, getMonth: getMonth,
                getDialogs: getDialogs, getRelations: getRelations, getScripts: getScripts,
                getCategories: getCategories, getActionsData: getActionsData, getWisdom: getWisdom,
                getIfPlans: getIfPlans, getIfCats: getIfCats,
                STORAGE: {
                    daily: STORAGE_DAILY, week: STORAGE_WEEK, month: STORAGE_MONTH,
                    dialog: STORAGE_DIALOG, relation: STORAGE_RELATION, script: STORAGE_SCRIPT,
                    categories: STORAGE_CATEGORIES, actions: STORAGE_ACTIONS, wisdom: STORAGE_WISDOM,
                    ifPlans: STORAGE_IF_PLANS, ifCats: STORAGE_IF_CATS
                }
            };

            /* 侧栏当前项高亮：靠 body[data-page] 认自己，逐页各自高亮一项 */
            (function markCurrentNav() {
                const cur = document.body.getAttribute('data-page');
                if (!cur) return;
                const a = document.querySelector('.sidebar-nav a[data-nav="' + cur + '"]');
                if (a) a.classList.add('nav-current');
            })();

            boot();

        })();
