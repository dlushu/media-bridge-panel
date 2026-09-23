'use strict';
/**
 * 聚合模块 · 「站点与参数」页：**只干一件事** —— 站点清单（勾选参与聚合）。
 * 站点表是局部重绘的（renderSiteTable），勾选一下不必整页重刷。
 * 聚合参数（超时/并发/自动测速）与打分设置**放在「聚合参数」页**（那是"偶尔调一次"
 * 的旋钮，跟每天勾的站点表混在一页里又长又容易点错）。
 *
 * 表里那一列「延迟」来自**服务端测速任务**（`server/modules/agg/site-test.js`）：
 * 每 6 小时自动一轮、可手动、某个源起来后自动测一轮；每站打一发 `POST /search`，
 * 关键词从常见影视名里随机取、非 200 就换一个再测一发。本页只负责"开/停 + 看进度 + 看结果"——
 * 测速跑在服务端，关掉页面也照跑（原先是前端逐站循环，一关页面就断）。
 *
 * 「按速度排序」是**纯显示**开关（三态：默认 → 延迟快→慢 → 延迟慢→快），**不写 `agg.order`**
 * （那是聚合取站优先级，另一件事）。
 *
 * ⚠️ 原「全选可搜索」按钮已删：源的 `searchable` 常漏报，照它批量勾选会漏掉能用的站。
 */
import { $, el, toast } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { S } from '../../core/state.js';
import { sid, ensureAggSites, ensureAggSources, saveAggSettings, sourcesForDisplay } from '../../core/store.js';
import { renderPage, renderNav } from '../../core/shell.js';

export async function renderSites(v) {
  const toolbar = el(
    'div',
    { class: 'toolbar' },
    el('button', {
      class: 'btn',
      text: '刷新站点',
      onclick: async () => {
        S.aggLoadedFor = null;
        renderPage();
      },
    }),
    (() => {
      const inp = el('input', { type: 'text', placeholder: '过滤站点名', value: S.siteFilter });
      inp.addEventListener('input', () => {
        S.siteFilter = inp.value;
        renderSiteTable();
      });
      return inp;
    })(),
    (() => {
      /* 视图：**去掉「只看可搜索」之后列表太挤**（126 个站一屏看不完），给一个"事实型"的筛选 ——
       * 它只依据"是否勾选过"，不依赖源申报的 `searchable`（那个常漏报，见下面的脚注）。 */
      const sel = el('select', { title: '按"你自己的勾选"筛，不看源申报的能力' });
      for (const [val, label] of [['all', '全部站点'], ['on', '只看已勾选'], ['off', '只看未勾选']]) {
        const o = el('option', { value: val, text: label });
        if ((S.siteView || 'all') === val) o.selected = true;
        sel.append(o);
      }
      sel.addEventListener('change', () => {
        S.siteView = sel.value;
        renderSiteTable();
      });
      return el('label', { class: 'chk' }, sel, '');
    })(),
    el('span', { class: 'spacer' }),
    /* 测速：**开 / 停 + 进度**。一轮跑在服务端（见 server/modules/agg/site-test.js），
     * 点「立即测速」只测**当前列出来的**站点（筛选 + 视图算出来的那批）。 */
    el('button', {
      class: 'btn',
      id: 'siteTestBtn',
      title: '对当前列出来的站点跑一轮测速（服务端执行：每站一发 /search，片名随机取、非 200 换一个再测一发）',
      text: '立即测速',
      onclick: () => startSpeedTest(),
    }),
    el('button', {
      class: 'btn mini hidden',
      id: 'siteTestStop',
      text: '停止测速',
      onclick: () => stopSpeedTest(),
    }),
    el('span', { class: 'muted', id: 'siteTestMsg' }),
    (() => {
      /* 「按速度排序」按钮：三态循环，**只影响这张表的显示顺序**，不写 `agg.order` */
      let btn = null;
      btn = el('button', {
        class: 'btn',
        title: '只影响这张表的显示顺序（不改聚合取站优先级）；失败与没测过的排在最后',
        text: sortLabel(),
        onclick: () => {
          S.siteSort = S.siteSort === 'fast' ? 'slow' : S.siteSort === 'slow' ? '' : 'fast';
          btn.textContent = sortLabel();
          renderSiteTable();
        },
      });
      return btn;
    })(),
    el('button', { class: 'btn', text: '清空聚合', onclick: () => clearSelection() }),
    el('span', { class: 'muted', id: 'aggCount' })
  );

  /* 先把源清单拿到手（读文件，几毫秒），参数卡/工具栏就能立刻画；
     「有哪些站点」要等各源 /config 探测完（连不上的源要等超时），那部分放后台。 */
  try {
    await ensureAggSources();
  } catch {
    /* 拿不到就先按空清单画，下面探测会再试 */
  }

  /* 尾部区域单独放一个容器：参数卡和工具栏不依赖探测，可以先画出来；
     「有哪些站点」要等各源 /config 探测完（连不上的源要等超时），探测回来再补这一块。 */
  const tail = el('div', {});
  v.append(tail);

  const paint = () => {
    tail.textContent = '';
    if (!sourcesForDisplay().length) {
      tail.append(
        el('div', { class: 'hint warn' }, '还没有源 —— 到「源托管 · 猫源地址」部署一个（会自动进聚合），或到「聚合 · 源列表」填一个外部地址。')
      );
      return;
    }
    if (!S.aggSites.length) {
      const bad = (S.aggSources || []).filter((s) => s.enabled !== false && !s.ok);
      tail.append(
        toolbar,
        el('div', { class: 'hint warn', text: '这些源都取不到站点：' + (bad.map((s) => `${s.id} ${s.error || '未知错误'}`).join('；') || '未知原因') })
      );
      return;
    }
    tail.append(toolbar, el('div', { id: 'siteTableHost' }));
    renderSiteTable();
    /* 工具栏画好了才有 `#siteTestMsg` —— 这时再去问一次测速状态（正在跑就接着显示进度） */
    void initSpeedTestUi();
  };

  if (S.aggLoadedFor) {
    paint(); // 已有探测结果，直接画完
    return;
  }

  tail.append(el('div', { class: 'hint', text: '正在探测各源…（连不上的要等超时，参数可以先改）' }));
  try {
    await ensureAggSites();
  } catch (e) {
    if (!tail.isConnected) return;
    tail.textContent = '';
    tail.append(el('div', { class: 'hint warn', text: '读取站点失败：' + e.message }));
    return;
  }
  if (!tail.isConnected) return; // 已经翻到别的页了
  paint();
}

/**
 * 这一行要不要显示：名称/key 过滤 + 「视图」三选一。
 * ⚠️ 去掉了原来的「只看可搜索」—— 源的 `searchable` 是**它自己申报**的，经常漏报
 * （实测 TG搜 没写但 `/search` 完全能用），照它筛会把能用的站过滤掉。
 * 现在这个"视图"只依据**已勾选**这一事实（`enabledSet`）。
 */
function siteVisible(s, enabledSet) {
  if (S.siteView === 'on' && !enabledSet.has(sid(s.source, s.key))) return false;
  if (S.siteView === 'off' && enabledSet.has(sid(s.source, s.key))) return false;
  const f = S.siteFilter.trim().toLowerCase();
  if (f && !(String(s.name || '').toLowerCase().includes(f) || String(s.key || '').toLowerCase().includes(f))) return false;
  return true;
}

/** 毫秒 → 人看的一小串（≥1s 用秒，带一位小数） */
const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms');

/** 时间戳 → `09-24 15:30`（页面上"上次测速 / 下次自动"用） */
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 「按速度排序」按钮的三态文案 */
function sortLabel() {
  if (S.siteSort === 'fast') return '延迟 · 快→慢';
  if (S.siteSort === 'slow') return '延迟 · 慢→快';
  return '按延迟排序';
}

/**
 * 排序用的键：**只有测速成功的站才有数值**。
 * 失败（HTTP 404 / 超时…）与没测过的一律 `Infinity` —— 无论快慢都排在最后，
 * "没数据"不该混进名次里。
 */
function sortKey(s) {
  const one = (s.stat || {}).probe || null;
  return one && one.ok ? one.ms : Infinity;
}

/** 按 `S.siteSort` 排序（不改动传进来的数组） */
function sortSites(list) {
  if (!S.siteSort) return list;
  const dir = S.siteSort === 'slow' ? -1 : 1;
  return list.slice().sort((a, b) => dir * (sortKey(a) - sortKey(b)));
}

/** 当前**列出来**的站点（与表格同口径：过滤器 + 视图）—— 「立即测速」测的就是这些 */
function visibleSites() {
  const agg = (S.settings && S.settings.agg) || {};
  const enabledSet = new Set((agg.enabled || []).map((x) => sid(x.source, x.key)));
  return (S.aggSites || []).filter((s) => siteVisible(s, enabledSet));
}

/**
 * 「延迟」列的单元格 —— 数据来自**服务端测速**（`stat.probe`：每站一发 `POST /search`，
 * 片名从常见影视名里随机取、非 200 换一个再测一发，见 `server/modules/agg/api.js` 的 probeSearch）。
 *
 * 单元格右边那个小按钮 = **单点测速**：只测这一个站，结果直接写进这一列。
 * 因为"聚合搜索要不要跳过这个站"用的就是这一列（最近一次测速失败即跳过，
 * 见 `server/modules/agg/site-stats.js` 的 shouldSkip），所以点一下就能把被判失败的站立刻复测、恢复。
 *
 * 显示口径：
 *   · 成功 → 数值（`120ms` / `1.2s`）；
 *   · 失败 → 红字（`HTTP 404` / `超时` / `失败`），`title` 里写明用的哪个片名、第几发；
 *   · 没测过 → `—`。
 *
 * `title` 里另外带上**真实业务**的最近一次搜索/取详情耗时（顺手记账那一份）—— 那才是
 * "点开要等多久"，但它只在站点被真的用过时才有值，所以不占列。
 */
function delayCell(s, timeoutMs) {
  const stat = s.stat || {};
  const one = stat.probe || null;
  const call = stat.call || {};
  const callNote = [
    call.search
      ? `真实搜索：最近一次 ${fmtMs(call.search.ms)}${call.search.ok ? '' : '（失败：' + call.search.error + '）'}`
      : '真实搜索：还没搜过',
    call.detail
      ? `真实取详情：最近一次 ${fmtMs(call.detail.ms)}${call.detail.ok ? '' : '（失败：' + call.detail.error + '）'}`
      : '真实取详情：还没点开过',
  ].join('\n');

  /* 单点测速：同步打一发；统计已经在服务端写好了，用返回的 `stat` 就地重画这一格 */
  const btn = el('button', {
    class: 'btn mini ml-sm',
    text: '测速',
    title: '只测这一个站：服务端打一发 /search（片名随机取、非 200 换一个再测），结果直接写进这一列',
    onclick: async (e) => {
      const b = e.target;
      b.disabled = true;
      b.textContent = '…';
      try {
        const r = await api('/api/agg/site-test/one', {
          method: 'POST',
          body: { source: s.source, key: s.key, api: s.api },
        });
        if (td.isConnected) td.replaceWith(delayCell(Object.assign({}, s, { stat: r.stat }), timeoutMs));
        toast(`${s.name || s.key}：${r.search.ok ? fmtMs(r.search.ms) + ` · ${r.search.count} 条` : r.search.error || '失败'}`);
      } catch (err) {
        toast((err && err.message) || '单站测速失败', true);
        b.disabled = false;
        b.textContent = '测速';
      }
    },
  });

  let td;
  if (!one) {
    td = el(
      'td',
      { class: 'note', title: `还没测过 —— 点右边的「测速」，或用上面的「立即测速」整轮刷新。\n${callNote}` },
      '—',
      btn
    );
  } else if (!one.ok) {
    const why = one.routeMissing
      ? '这个源里该站没有 /search 端点（文案是 Route POST:… not found，不是站坏了）'
      : one.timeout
        ? `超过测速超时（${fmtMs(one.ms)}）`
        : one.error || '请求失败';
    td = el(
      'td',
      {
        class: 'note err-note',
        title:
          `测速失败：${why}\n用的片名「${one.wd}」${one.tries > 1 ? `（第 ${one.tries} 发，首发失败后换过词）` : ''}\n` +
          '这一列失败的站，聚合搜索会**先跳过**它 —— 点「测速」复测成功即恢复。\n' +
          callNote,
      },
      one.status ? 'HTTP ' + one.status : '失败',
      btn
    );
  } else {
    const slow = timeoutMs > 0 && one.ms >= timeoutMs;
    td = el(
      'td',
      {
        class: slow ? 'note err-note' : 'mono',
        title:
          `测速：${fmtMs(one.ms)}（单发 /search，片名「${one.wd}」` +
          `${one.tries > 1 ? `，第 ${one.tries} 发（首发失败换过词）` : ''}）\n` +
          `返回 ${one.count} 条${one.count === 0 ? '（这个词这站没有 —— 仍是有效样本）' : ''}\n` +
          `测速时间：${fmtTime(one.at)}\n` +
          (slow ? `⚠️ 比聚合的单站超时（${fmtMs(timeoutMs)}）还慢 —— 聚合里会被判超时\n` : '') +
          callNote,
      },
      fmtMs(one.ms),
      btn
    );
  }
  return td;
}

function renderSiteTable() {
  const host = $('#siteTableHost');
  if (!host) return;
  const agg = (S.settings && S.settings.agg) || { enabled: [], order: [] };
  const pairOf = (x) => ({ source: x.source, key: x.key });
  const enabled = (agg.enabled || []).map(pairOf);
  const order = (agg.order || []).map(pairOf);
  const enabledSet = new Set(enabled.map((x) => sid(x.source, x.key)));
  const at = (arr, s) => arr.findIndex((x) => x.source === s.source && x.key === s.key);
  const list = sortSites(visibleSites());
  const srcN = new Set(S.aggSites.map((s) => s.source)).size;
  const timeoutMs = Number(agg.timeoutMs) || 0;
  const cnt = $('#aggCount');
  if (cnt) cnt.textContent = `已选 ${enabledSet.size} / ${S.aggSites.length} 站点 · ${srcN} 个源`;

  host.textContent = '';
  /* `sites-table` 只给 CSS 用（表头与"能力"列不折行，见 style.css） */
  const table = el('table', { class: 'sites-table' });
  table.append(
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', { text: '聚合' }),
        el('th', { text: '来源' }),
        el('th', { text: '名称' }),
        el('th', {
          title: '测速结果：一发 POST /search 的往返耗时（片名从常见影视名里随机取、非 200 换一个再测；失败标红）。悬停可看用的片名与真实业务的耗时',
          text: '延迟',
        }),
        el('th', { title: '源自己申报的字段，仅供参考（常漏报：实测 TG搜 没写 searchable 但 /search 完全能用）。详见表格下的脚注', text: '能力' })
      )
    )
  );
  const tb = el('tbody');
  list.forEach((s) => {
    const cb = el('input', { type: 'checkbox', checked: enabledSet.has(sid(s.source, s.key)), class: 'switch' });
    cb.addEventListener('change', () => {
      /* 站点身份 = (源, 站点key) 这一对：多源下同名 key 是两条不同的站点 */
      const next = enabled.filter((x) => !(x.source === s.source && x.key === s.key));
      if (cb.checked) next.push(pairOf(s));
      const ord = at(order, s) >= 0 ? order : order.concat([pairOf(s)]);
      saveAgg({ enabled: next, order: ord });
    });
    const dc = delayCell(s, timeoutMs);
    tb.append(
      el(
        'tr',
        {},
        el('td', {}, cb),
        el('td', { class: 'note', text: s.sourceName || s.source }),
        el('td', { text: s.name || '-' }),
        dc,
        el(
          'td',
          {},
          /* 都只是"源申报的"（仅供参考）：没标 ≠ 不能；标了也不一定准。来源见 title。 */
          s.searchable ? el('span', { class: 'badge ok', title: '源申报它能搜（没标的也可能能搜）', text: '搜索' }) : null,
          s.filterable ? el('span', { class: 'badge', title: '源申报它支持二级筛选', text: '筛选' }) : null,
          s.indexs ? el('span', { class: 'badge', title: '源申报它是"点进条目后转去搜索"那种（豆瓣类）', text: '跳搜索' }) : null,
          el('span', { class: 'badge', title: '这条站点属于哪个大类（源申报）', text: s.groupLabel || s.group })
        )
      )
    );
  });
  table.append(tb);
  host.append(el('div', { class: 'table-wrap' }, table));
  /* 脚注：把三件事交代清楚 —— 「能力」只是源申报；「延迟」是服务端测速；真实业务耗时在悬停里 */
  host.append(
    el('div', {
      class: 'note',
      text:
        '注：「能力」列是源自己申报的，仅供参考 —— 源常漏报（实测 TG搜 没写 searchable，但 /search 完全能用），' +
        '所以没标「搜索」不代表不能搜。真正能不能搜/能不能筛，以实测（「聚合搜索」或「这条的版本」）为准。' +
        '「延迟」= 服务端测速：每站一发 `POST /search`，片名从常见影视名里**随机取**、非 200 就**换一个再测一发**' +
        '（两发都失败才算真失败），单站 15 秒超时；每 6 小时自动测一轮，某个源起来后也会自动测它的站点。' +
        '悬停能看到用的哪个片名、第几发，以及**真实业务**的最近一次搜索 / 取详情耗时（那份只在站点被真的用过时才有值）。' +
        '标红 = 测速失败，或比聚合的单站超时还慢（那种站在聚合里必被判超时）。',
    })
  );
}

/* ------------------------------------------------------------------ 测速（服务端任务） */

/**
 * 轮询句柄 —— **只在这一页活着**：页面一重绘，`#siteTestMsg` 就不在 DOM 里了，
 * 下一拍自动停（否则翻到别的页还在空转）。
 */
let pollTimer = null;
/** 上一次看到的 running：用来认出"这一轮什么时候结束"（结束了才重拉站点清单） */
let wasRunning = false;

/** 画"测速中… x/y"或"上次测速 / 下次自动" */
function paintTestMsg(st) {
  const msg = $('#siteTestMsg');
  if (!msg || !st) return;
  if (st.running) {
    msg.textContent = `测速中… ${st.done}/${st.total}` + (st.badCount ? `（${st.badCount} 个失败）` : '');
    return;
  }
  const parts = st.lastRunAt
    ? [
        `上次测速 ${fmtTime(st.lastRunAt)}：${st.done}/${st.total} 个站 · ${Math.round((st.lastElapsedMs || 0) / 1000)}s` +
          (st.lastBad ? ` · ${st.lastBad} 个失败` : ''),
      ]
    : ['还没测过'];
  parts.push(st.enabled ? `下次自动 ${fmtTime(st.nextRunAt)}（每 ${st.hours} 小时）` : '自动测速已关（「聚合参数」页可开）');
  msg.textContent = parts.join(' · ');
}

/** 拉一次状态并画；拿不到就返回 null（不打扰页面） */
async function refreshTestState() {
  try {
    const st = await api('/api/agg/site-test');
    paintTestMsg(st);
    return st;
  } catch {
    return null;
  }
}

/** 「立即测速 / 测速中…」与「停止测速」的可用态 */
function setTestBtns(running) {
  const btn = $('#siteTestBtn');
  const stopBtn = $('#siteTestStop');
  if (btn) {
    btn.disabled = !!running;
    btn.textContent = running ? '测速中…' : '立即测速';
  }
  if (stopBtn) stopBtn.classList.toggle('hidden', !running);
}

/**
 * 每 1.5 秒看一眼进度。**只有"这一轮刚结束"那一下才重拉站点清单**：
 * 统计是服务端刚写下的，内存里那份还是测速前的，直接重绘会把新数字盖回去
 * （重拉 = 每个源问一次 /config，本地几十毫秒）。
 */
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    if (!$('#siteTestMsg')) {
      clearInterval(pollTimer);
      pollTimer = null;
      return;
    }
    const st = await refreshTestState();
    if (!st) return;
    setTestBtns(st.running);
    if (st.running) {
      wasRunning = true;
      return;
    }
    if (!wasRunning) return;
    wasRunning = false;
    try {
      await ensureAggSites({ force: true });
    } catch {
      /* 拉不到就按内存里那份画，下面照样重绘 */
    }
    renderSiteTable();
    toast('测速完成');
    clearInterval(pollTimer);
    pollTimer = null;
  }, 1500);
}

/** 进页面时对一次状态：正在跑就接着显示进度，空闲就显示"上次 / 下次" */
async function initSpeedTestUi() {
  const st = await refreshTestState();
  if (!st || !$('#siteTestMsg')) return;
  setTestBtns(st.running);
  wasRunning = st.running;
  if (st.running) startPolling();
}

/**
 * 开一轮测速：**只测当前列出来的站点**（把它们的 keys 传给服务端；不带 keys 就是全部站点）。
 * 测速在服务端跑、关掉页面也继续 —— 所以这里不做任何"本地进度自增"，一律以服务端状态为准。
 */
async function startSpeedTest() {
  const list = visibleSites();
  if (!list.length) return toast('没有可测的站点（先调好筛选或视图）', true);
  if (
    !confirm(
      `对当前列出来的 ${list.length} 个站点跑一轮测速？\n\n` +
        '测速在**服务端**跑（关掉页面也会继续）：每站一发 /search，片名从常见影视名里随机取、' +
        '非 200 换一个再测一发，单站最多 15 秒。随时可以点「停止测速」。'
    )
  ) {
    return;
  }
  try {
    const r = await api('/api/agg/site-test/start', {
      method: 'POST',
      body: { keys: list.map((s) => ({ source: s.source, key: s.key })) },
    });
    paintTestMsg(r);
    setTestBtns(!!r.running);
    wasRunning = !!r.running;
    startPolling();
  } catch (e) {
    /* 409 = 上一次还没跑完（服务端会给出说明，直接透出） */
    toast(e.message || '启动测速失败', true);
    refreshTestState();
  }
}

/** 停止：服务端把 worker 停掉（已经测完的那些站的结果照常保留） */
async function stopSpeedTest() {
  try {
    paintTestMsg(await api('/api/agg/site-test/stop', { method: 'POST' }));
  } catch (e) {
    toast(e.message || '停止测速失败', true);
  }
}

async function saveAgg(patch) {
  try {
    await saveAggSettings(patch); // 勾选/参数变化不影响站点清单 → 不必重拉
    renderSiteTable();
    renderNav();
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 清空聚合选择。
 * 原「全选可搜索」按钮已删：源的 `searchable` 常漏报，照它批量勾选会**漏掉能用的站**
 *（实测 TG搜 没写但 /search 完全能用）。要批量选，就按「延迟」列排序后手动勾，
 * 或去「聚合搜索」页拿真实片名实测一遍。
 */
async function clearSelection() {
  await saveAgg({ enabled: [], order: [] });
  toast('已清空聚合选择');
}

