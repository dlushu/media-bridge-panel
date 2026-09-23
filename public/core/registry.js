'use strict';
/**
 * 导航与页面的**声明**（只有结构，不含任何渲染实现）。
 *
 *   MODULES        一个 tab = 一个模块，模块内若干页（数组顺序 = 子标签顺序）
 *   registerPages  各页的渲染函数由页面自己登记进来（见 app.js 顶部）
 *
 * 这样 shell 只管"画外壳 + 分发"，不必认识任何具体的页；反过来页也不必认识外壳。
 */
import { S } from './state.js';

/** 本地托管中正在运行的源 */
export function localRunningSource() {
  return S.sources.find((x) => x.run && x.run.status === 'running' && x.run.port) || null;
}

/** 运行页是否可用：本地有运行中的源，或已配置可用的托管源 */
export function runReady() {
  return !!(localRunningSource() || (S.run && S.run.url));
}

/** 运行中的本地源（可以有多个）—— 每个都能有自己的「配置中心」 */
export function runningSources() {
  return (S.sources || []).filter((x) => x.run && x.run.status === 'running' && x.run.port);
}

/** 「配置中心」页 id = `website-<本地源id>`；从页 id 反解源 id（不是这类页就回空） */
export const WEBSITE_PAGE_PREFIX = 'website-';
export function websiteSourceOfPage(page) {
  return String(page || '').startsWith(WEBSITE_PAGE_PREFIX) ? String(page).slice(WEBSITE_PAGE_PREFIX.length) : '';
}

/** 页签上显示的源名（太长就截断 —— 源名可能是整条地址） */
export function shortSourceName(s) {
  const raw = String((s && (s.name || s.url)) || '').trim();
  return raw.length > 16 ? raw.slice(0, 15) + '…' : raw || '(未命名)';
}

/** `pages()` 动态算 —— 源没跑起来就没有它的「配置中心」；跑起来几个就有几个 */
export const MODULES = [
  {
    id: 'source',
    label: '源托管',
    pages: () => {
      const pages = [['source-bundle', '猫源地址']];
      /* **每个运行中的源一个「配置中心」**（多源时以前只有一个，只能看第一个源的那份） */
      for (const s of runningSources()) pages.push([WEBSITE_PAGE_PREFIX + s.id, '配置中心 · ' + shortSourceName(s)]);
      /* 本地一个都没跑、但填了外部托管源：给一个「配置中心」入口（代理那台） */
      if (pages.length === 1 && runReady()) pages.push(['website', '配置中心']);
      return pages;
    },
  },
  {
    id: 'agg',
    label: '聚合设置',
    pages: () => [['agg-host', '源列表'], ['agg-sites', '站点与参数'], ['agg-params', '聚合参数'], ['agg-search', '聚合搜索']],
  },
  { id: 'emby', label: 'Emby', pages: () => [['emby-setup', '连接设置'], ['emby-home', '首页插件']] },
  {
    id: 'panel',
    label: '面板设置',
    pages: () => [['panel', '概览'], ['panel-settings', '设置'], ['panel-about', '关于'], ['panel-logs', '日志']],
  },
];

export function moduleOf(page) {
  for (const m of MODULES) {
    if (m.pages().some((x) => x[0] === page)) return m;
  }
  return MODULES[0];
}

export function moduleById(id) {
  return MODULES.find((m) => m.id === id) || MODULES[0];
}

/* ------------------------------------------------------------ 页渲染器登记表 */

const RENDERERS = new Map();

/**
 * 登记页渲染函数。值可以是函数，也可以带 `nopad`（该页自己管留白）：
 *   registerPages({ 'agg-search': renderAgg, website: { render: renderWebsite, nopad: true } })
 */
export function registerPages(map) {
  for (const [id, spec] of Object.entries(map)) {
    RENDERERS.set(id, typeof spec === 'function' ? { render: spec } : spec);
  }
}

export function rendererOf(page) {
  const exact = RENDERERS.get(page);
  if (exact) return exact;
  /* 动态页：每个源一个「配置中心」（`website-<源id>`）复用 `website` 的渲染器 */
  if (websiteSourceOfPage(page)) return RENDERERS.get('website') || null;
  return null;
}
