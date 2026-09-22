'use strict';
/**
 * 导航外壳：侧边栏（导航 + 折叠）+ 模块/子标签高亮 + 页面分发 + 地址栏同步。
 * 只认 `registry` 里的结构，不认任何具体的页。
 */
import { $, el } from './dom.js';
import { S } from './state.js';
import { moduleOf, moduleById, rendererOf } from './registry.js';

/* ------------------------------------------------------------ 侧边栏折叠 */

const NAV_KEY = 'catpaw-panel.nav-collapsed';
const NAV_NARROW = 860; // 与 style.css 里的断点一致

function readSaved() {
  try {
    return localStorage.getItem(NAV_KEY) === '1';
  } catch {
    return false; // 隐私模式等读不了 localStorage：当没存过
  }
}

function setNavCollapsed(collapsed) {
  const app = $('.app');
  if (!app) return;
  app.classList.toggle('nav-collapsed', collapsed);
  const btn = $('#navToggle');
  if (btn) btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

/**
 * 进页面时恢复侧栏状态。
 * 宽屏：用记住的偏好（默认展开，侧栏常驻）。
 * 窄屏：一律先收起 —— 这时侧栏是盖在内容上的抽屉，一进来就挡着内容不合理。
 */
export function applyNavState() {
  setNavCollapsed(window.innerWidth <= NAV_NARROW ? true : readSaved());
}

/** 顶栏 ☰：展开/收起。只有宽屏记偏好 —— 免得在手机上开一次抽屉，桌面端下次打开发现侧栏不见了 */
export function toggleNav() {
  const app = $('.app');
  if (!app) return;
  const collapsed = !app.classList.contains('nav-collapsed');
  setNavCollapsed(collapsed);
  if (window.innerWidth > NAV_NARROW) {
    try {
      localStorage.setItem(NAV_KEY, collapsed ? '1' : '0');
    } catch {
      /* 写不了就算了，下次按默认来 */
    }
  }
}

/** 收起侧栏（窄屏点遮罩用） */
export function collapseNav() {
  setNavCollapsed(true);
}

/** 窄屏下点完模块就把抽屉收起来；宽屏不动它 */
export function closeNavIfNarrow() {
  if (window.innerWidth > NAV_NARROW) return;
  const app = $('.app');
  if (app && !app.classList.contains('nav-collapsed')) setNavCollapsed(true);
}

export function switchPage(page) {
  S.page = page;
  S.lastPage[moduleOf(page).id] = page;
  renderPage();
}

export function switchModule(id) {
  const m = moduleById(id);
  switchPage(S.lastPage[id] || m.pages()[0][0]);
  window.scrollTo(0, 0);
}

/* ------------------------------------------------------------ 地址栏同步 */

/* 当前页写进地址栏（#/模块id/页id，如 #/agg/agg-search）：刷新、收藏、前进后退都回到同一页。
 * 写 hash 只发生在 renderPage 末尾这一个出口 —— 页面被顶掉（比如源停了、没有「配置中心」了）
 * 时地址栏也跟着纠正，不会留个指向不存在页面的 hash。 */

/* 页 id 允许字母数字下划线连字符 —— 「配置中心」是按源动态生成的，id 形如 `website-src_mu8n285wr714` */
const PAGE_HASH = /^#\/[a-z-]+\/([A-Za-z0-9_-]+)$/;

function pageInHash() {
  const m = PAGE_HASH.exec(location.hash || '');
  return m ? m[1] : '';
}

/** 进页面时按地址栏定位（在渲染之前调；页面当前不可用时 renderPage 会自己退回本类第一页） */
export function applyHash() {
  const page = pageInHash();
  if (!page) return;
  S.page = page;
  S.lastPage[moduleOf(page).id] = page;
}

/** 写回地址栏：还没有 hash（首次进入）用 replace，之后按正常导航压栈，浏览器能后退 */
function syncHash() {
  const want = '#/' + moduleOf(S.page).id + '/' + S.page;
  if (location.hash === want) return;
  if (location.hash) location.hash = want;
  else history.replaceState(null, '', want);
}

/** 浏览器前进/后退：切回地址栏里的页；和当前页相同就什么都不做（自己写 hash 也会触发本事件） */
export function onHashChange() {
  const page = pageInHash();
  if (!page || page === S.page) return;
  switchPage(page);
}

/** 大类内部的子标签 */
export function renderSubnav() {
  const host = $('#subnav');
  if (!host) return;
  const pages = moduleOf(S.page).pages();
  host.textContent = '';
  host.style.display = pages.length > 1 ? '' : 'none';
  if (pages.length <= 1) return;
  for (const [id, label] of pages) {
    host.append(el('button', { 'data-page': id, class: S.page === id ? 'active' : '', text: label }));
  }
}

/** 模块高亮 + 两个角标 */
export function renderNav() {
  const mod = moduleOf(S.page);
  document.querySelectorAll('#nav button[data-module]').forEach((b) => b.classList.toggle('active', b.dataset.module === mod.id));
  const cur = S.base || {};
  const sb = $('#navSrcBadge');
  if (sb) {
    const p = S.probe;
    sb.textContent = !cur.url ? '未设置' : p ? (p.ok ? `${p.siteCount} 站点` : '不可用') : '';
  }
  const ab = $('#navAggBadge');
  if (ab) {
    const en = (S.settings && S.settings.agg && S.settings.agg.enabled) || [];
    const srcN = (S.aggSources || []).length;
    ab.textContent = en.length ? `${en.length} 站点` : srcN ? '未选站点' : '未配源';
  }
  renderSubnav();
}

/** 分发到当前页的渲染函数 */
export function renderPage() {
  // 当前页可能因为源已停止而不在导航里，退回该大类第一页
  const pages = moduleOf(S.page).pages();
  if (!pages.some((x) => x[0] === S.page)) S.page = pages[0][0];

  /* 页渲染函数大多是 async（要先 await 数据），而这里并不 await 它们 ——
   * 连着两下导航（比如点模块 tab 又立刻点子标签）就会有两份渲染同时在往同一个
   * #view 里 append，页面叠成两份。所以每次渲染**换一个新节点**：没跑完的那次攥着的
   * 是已脱离文档的旧节点，它后面 append 什么都看不见。渲染函数因此不必自己判断有没有过期。 */
  const old = $('#view');
  const v = old.cloneNode(false);
  old.replaceWith(v);
  const spec = rendererOf(S.page);
  v.className = 'view' + (spec && spec.nopad ? ' nopad' : '');
  if (spec) spec.render(v);
  renderNav();
  syncHash();
}
