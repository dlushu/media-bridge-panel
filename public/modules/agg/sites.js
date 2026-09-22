'use strict';
/**
 * 聚合模块 · 「站点与参数」页：**只干一件事** —— 站点清单（勾选参与聚合、排序）。
 * 站点表是局部重绘的（renderSiteTable），勾选一下不必整页重刷。
 * 聚合参数（超时/并发/init）与打分设置**放在「聚合参数」页**（那是"偶尔调一次"
 * 的旋钮，跟每天勾的站点表混在一页里又长又容易点错）。
 */
import { $, el, toast } from '../../core/dom.js';
import { S } from '../../core/state.js';
import { sid, ensureAggSites, ensureAggSources, saveAggSettings, sourcesForDisplay } from '../../core/store.js';
import { switchPage, renderPage, renderNav } from '../../core/shell.js';

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
      const inp = el('input', { type: 'text', placeholder: '过滤站点名/key', value: S.siteFilter });
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
    el('button', { class: 'btn mini', text: '聚合参数 / 打分设置', onclick: () => switchPage('agg-params') }),
    el('button', { class: 'btn', title: '按源申报的"可搜索"批量勾选（源可能漏报 → 勾完可手动调）', text: '全选可搜索', onclick: () => bulkSelect(true) }),
    el('button', { class: 'btn', text: '清空聚合', onclick: () => bulkSelect(false) }),
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

function renderSiteTable() {
  const host = $('#siteTableHost');
  if (!host) return;
  const agg = (S.settings && S.settings.agg) || { enabled: [], order: [] };
  const pairOf = (x) => ({ source: x.source, key: x.key });
  const enabled = (agg.enabled || []).map(pairOf);
  const order = (agg.order || []).map(pairOf);
  const enabledSet = new Set(enabled.map((x) => sid(x.source, x.key)));
  const at = (arr, s) => arr.findIndex((x) => x.source === s.source && x.key === s.key);
  const list = S.aggSites.filter((s) => siteVisible(s, enabledSet));
  const srcN = new Set(S.aggSites.map((s) => s.source)).size;
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
        el('th', { text: '排序' }),
        el('th', { text: '来源' }),
        el('th', { text: '名称' }),
        el('th', { class: 'mono', text: 'key' }),
        el('th', { class: 'mono', text: 'api' }),
        el('th', { title: '源自己申报的字段，仅供参考（常漏报：实测 TG搜 没写 searchable 但 /search 完全能用）。详见表格下的脚注', text: '能力' })
      )
    )
  );
  const tb = el('tbody');
  list.forEach((s) => {
    const idx = at(order, s);
    const move = (dir) => {
      const cur = at(order, s);
      const next = order.slice();
      if (cur < 0) next.push(pairOf(s));
      else {
        const to = cur + dir;
        if (to < 0 || to >= next.length) return;
        [next[cur], next[to]] = [next[to], next[cur]];
      }
      saveAgg({ order: next });
    };
    const cb = el('input', { type: 'checkbox', checked: enabledSet.has(sid(s.source, s.key)), class: 'switch' });
    cb.addEventListener('change', () => {
      /* 站点身份 = (源, 站点key) 这一对：多源下同名 key 是两条不同的站点 */
      const next = enabled.filter((x) => !(x.source === s.source && x.key === s.key));
      if (cb.checked) next.push(pairOf(s));
      const ord = at(order, s) >= 0 ? order : order.concat([pairOf(s)]);
      saveAgg({ enabled: next, order: ord });
    });
    tb.append(
      el(
        'tr',
        {},
        el('td', {}, cb),
        el(
          'td',
          {},
          el('button', { class: 'btn mini', text: '↑', disabled: idx <= 0, onclick: () => move(-1) }),
          el('button', { class: 'btn mini', text: '↓', disabled: idx < 0, onclick: () => move(1) })
        ),
        el('td', { class: 'note', text: s.sourceName || s.source }),
        el('td', { text: s.name || '-' }),
        el('td', { class: 'mono', text: s.key || '-' }),
        el('td', { class: 'mono', text: s.api || '-' }),
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
  /* 脚注：把"能力只是参考"这件事写在页面上（不再有「只看可搜索」那个筛选了，这里要交代清楚） */
  host.append(
    el('div', {
      class: 'note',
      text:
        '注：「能力」列是源自己申报的，仅供参考 —— 源常漏报（实测 TG搜 没写 searchable，但 /search 完全能用），' +
        '所以没标「搜索」不代表不能搜。真正能不能搜/能不能筛，以实测（「聚合搜索」或「这条的版本」）为准。',
    })
  );
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

async function bulkSelect(all) {
  const list = S.aggSites.filter((s) => s.searchable);
  const picked = all ? list.map((s) => ({ source: s.source, key: s.key })) : [];
  await saveAgg({ enabled: picked, order: all ? S.aggSites.map((s) => ({ source: s.source, key: s.key })) : [] });
  toast(all ? `已选中 ${picked.length} 个"源申报可搜索"的站点（漏报的请手动勾）` : '已清空聚合选择');
}

