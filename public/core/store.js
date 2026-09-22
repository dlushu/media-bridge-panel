'use strict';
/**
 * 面板级共享数据层：**唯一**需要拼后端路径的地方（各页模块只用它，不自己拼 URL）。
 *
 * 放在 `core/` 而不是某个模块里，是因为这些数据是跨模块的 ——
 * 比如「猫源地址」页要看站点、「聚合设置」四个页都要看源与站点。
 * 分层规则：`modules/<id>/` 只许 import `core/*`，模块之间不许互相 import；
 * 谁要动别人的数据，就调这里，而不是去 import 那个模块。
 */
import { api } from './api.js';
import { toast } from './dom.js';
import { S } from './state.js';

/** `(源, 站点)` 的复合键 —— 多源下站点 key 只在各自源内唯一，比较必须带上源 */
export const sid = (source, key) => `${source}\u0001${key}`;

/** 源集合的指纹：只有"源清单变了"才需要重拉站点（拉一次 = 每个源打一次 /config）。
 *  ⚠️ `url` 必须进指纹 —— 本地部署的源**端口是启动时定的**，重启后换了端口就是另一个源了，
 *  指纹不变的话会拿着旧探测结果当新的。 */
export function aggSourcesKey(sources) {
  return (sources || []).map((s) => `${s.id}:${s.url}:${s.enabled === false ? 0 : 1}`).join('|');
}

/** 正在飞的那次探测。页面改成「先渲染、后台探测」之后，几次渲染可能同时触发它 —— 别重复探测 */
let aggInflight = null;

/**
 * 聚合源 + 站点懒加载（多源）：`GET /api/agg/sites` 一次拿全。
 * 每个源的 `/config` 是后端并发拉的，单源失败只体现在它自己的 `ok/error` 上。
 * 慢就慢在探测上（源连不上要等超时），所以调用方**不要**拿它挡着页面渲染。
 */
export async function ensureAggSites({ force = false } = {}) {
  const key = aggSourcesKey(S.aggSources);
  if (!force && S.aggLoadedFor && S.aggLoadedFor === key && S.aggSites.length) return;
  if (aggInflight) return aggInflight;
  aggInflight = (async () => {
    const d = await api('/api/agg/sites');
    S.aggSources = d.sources || [];
    S.aggSites = d.sites || [];
    /* **合并**而不是整份替换：这个响应的 agg 只有 enabled/order/参数，没有 sources
       （源清单它在顶层单独给，还带探测结果）。整份替换会把 sources 抹掉，
       于是「以设置清单为准」的地方就会以为一个源都没有。 */
    S.settings = Object.assign(S.settings || {}, { agg: Object.assign({}, (S.settings || {}).agg, d.agg) });
    S.aggLoadedFor = aggSourcesKey(S.aggSources);
  })();
  try {
    await aggInflight;
  } finally {
    aggInflight = null;
  }
}

/**
 * 源清单（`GET /api/agg/sources`）—— **不含探测**，也不含 `agg` 设置，只读本机状态，几毫秒就回来。
 * 是「先渲染、后台探测」的第一遍：部署源的在不在跑、在哪个端口，这一趟就能拿到。
 *
 * ⚠️ **每次都真发请求**（不再"拿过就返回"）：部署源的端口会随重启变，缓存一份就会显示成旧端口。
 * 代价只有一次本地往返，换的是"页面上写的地址就是真在用的地址"。
 */
export async function ensureAggSources() {
  const d = await api('/api/agg/sources');
  /* **接住上一次的探测结果**（同 id 的那几个字段）：源没变时 `ensureAggSites()` 会命中缓存不重探
     （见 `aggLoadedFor` 那个指纹），这份结果就得在这儿续上 —— 否则每翻一次页，状态列都会退回
     「探测中…」然后就一直停在那一行。源变了（id/url 变）指纹就变，那边会正常重探。 */
  const prev = new Map((S.aggSources || []).map((x) => [x.id, x]));
  S.aggSources = (d.sources || []).map((s) => {
    const p = prev.get(s.id);
    return p ? Object.assign({}, s, { ok: p.ok, ms: p.ms, siteCount: p.siteCount, error: p.error }) : s;
  });
  return S.aggSources;
}

/**
 * 要显示的源清单 = 最近一次拿到的源清单（部署源 + 自定义源），探测结果已在其中。
 * 探测字段（`ok/ms/siteCount/error`）由 `/api/agg/sites` 那一趟补上 ——
 * 第一遍（只有 `/api/agg/sources`）画的时候还没有，状态列就写「探测中…」。
 */
export function sourcesForDisplay() {
  return S.aggSources || [];
}

/**
 * **自定义源**（面板够不到、得手填地址的那些）—— 存回设置时只带这些。
 * 部署源是每次由后端算出来的（名字取源名、地址取当前端口），**不落盘**：
 * 落盘会随重启过期，这正是要消除的问题。
 */
export function customSources() {
  return (S.aggSources || [])
    .filter((s) => !s.deployed)
    .map((s) => ({ id: s.id, url: s.url, name: s.name || '', enabled: s.enabled !== false }));
}

/**
 * 写回聚合设置（多源：sources / enabled / order 一起走模块设置端点）。
 * `reload` = 源清单变了 → 清缓存重拉站点（拉一次 = 每个源打一次 /config，勾选变化不必重拉）。
 */
export async function saveAggSettings(patch, { reload = false, msg = '' } = {}) {
  await api('/api/modules/agg/settings', { method: 'PUT', body: { settings: patch } });
  S.settings = Object.assign(S.settings || {}, { agg: Object.assign({}, (S.settings || {}).agg, patch) });
  /* 设置里那份 `sources` 只是"自定义那一半" —— **别拿它整份盖 `S.aggSources`**（会把部署源抹掉）。
   * 这里只换掉自定义项，部署项原样留着；调用方随后 `renderPage()` 会再拉一次拿最新端口。 */
  if (Array.isArray(patch.sources)) {
    const deployed = (S.aggSources || []).filter((s) => s.deployed);
    S.aggSources = deployed.concat(patch.sources.map((s) => Object.assign({ deployed: false }, s)));
  }
  if (reload) S.aggLoadedFor = null;
  if (msg) toast(msg);
}
