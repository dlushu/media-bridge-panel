'use strict';
/**
 * 猫源层服务：「当前猫源地址」的解析 + **本地部署源清单**（给聚合层用）
 *
 * 地址来源（优先级）：
 *   1. **自定义聚合源列表的第一条**（`settings/agg.json` 的 `sources[0].url`）—— 多源之后，
 *      "托管源"就是"聚合里配着的那个外部地址"；以前那个单值 `agg.upstream.source` 已随多源改造去掉
 *   2. 否则自动使用第一个「本地托管中且正在运行」的源
 *
 * 用途：面板的「接口测试」目标与 `/api/base*` 那套代理端点（它们仍是**单源**语义，
 * 作用对象就是这里解析出来的"托管源"）。聚合本身**不走这里** —— 它按合并后的源清单逐个源打
 * （本地部署的源见下面的 `deployed()`）。
 */
const settings = require('../../core/settings');
const store = require('./store');
const runner = require('./runner');

/** 自定义聚合源列表里的第一条（可用的）——「当前托管源」。
 *  ⚠️ 本地部署的源**不在这份清单里**（它们自动进聚合，见 `deployed()`），所以这里是"外部地址"那一半。 */
function configuredSource() {
  const list = (settings.read('agg') || {}).sources || [];
  const hit = list.find((s) => s && s.url && s.enabled !== false) || list.find((s) => s && s.url);
  return hit ? { url: String(hit.url), name: hit.name || '', sourceId: hit.id } : null;
}

/** 本地托管中正在运行的源 */
function resolveLocal() {
  for (const src of store.list()) {
    const st = runner.publicState(src.id);
    if (st.status === 'running' && st.port) {
      return {
        url: `http://127.0.0.1:${st.port}`,
        origin: 'local',
        label: '本地运行中',
        sourceId: src.id,
        name: src.name,
      };
    }
  }
  return null;
}

/**
 * **本地部署的源**（面板里 `data/sources.json` 那些）—— 逐个问 runner 它现在在哪个端口。
 *
 * 为什么要有这个函数：部署的源**自动就是聚合源**，
 * 不必再去「聚合 · 源列表」里手填一遍地址 —— 以前靠前端下拉"选一个本地部署的"把地址填进编辑框，
 * 于是同一个源在两边各存一份，名字还各叫各的（列表里显示的是随手填的名字，不是源名）。
 * 现在名字一律取**部署源自己的名字**（`src.name`），地址**每次现算**（端口是启动时定的、会变，
 * 存下来必然过期 —— 那正是"重启后聚合指向旧端口"这类问题的来源）。
 *
 * `url` 只在**运行中**才有值：没跑起来的源没有端口可打，如实留空，让上层报"没在运行"。
 * `port` 一并给出 —— emby 层 302 时要用它（源回的地址是回环地址，得换成客户端那个域名 + 这个端口）。
 */
function deployed() {
  return store.list().map((src) => {
    const st = runner.publicState(src.id);
    const running = st.status === 'running' && !!st.port;
    return {
      id: src.id,
      url: running ? `http://127.0.0.1:${st.port}` : '',
      port: st.port || null,
      name: src.name || src.url || src.id,
      status: st.status,
      running,
      enabled: true,
      deployed: true,
    };
  });
}

/** 当前托管源地址 */
function resolve() {
  const cfg = configuredSource();
  if (cfg) return { url: cfg.url, origin: 'manual', label: '聚合源列表第一条', name: cfg.name, sourceId: cfg.sourceId };
  const local = resolveLocal();
  if (local) return Object.assign({}, local, { label: '本地托管源' });
  return { url: '', origin: 'none', label: '未设置' };
}

/**
 * 运行页（配置中心 / 接口测试）作用的对象：本地运行中的源优先，否则退回托管源
 */
function resolveRun() {
  const local = resolveLocal();
  if (local) return local;
  const b = resolve();
  if (!b.url) return { url: '', origin: 'none', label: '未设置' };
  return Object.assign({}, b, { fallback: true });
}

/**
 * 按**源 id** 取一条源 —— 「接口测试」的「指定源」用。
 *
 * 为什么需要它：`/api/base/*` 是单源语义，默认只打「托管源」（= 自定义聚合源列表第一条）。
 * 多源之后，站点 key 只在各自源内唯一（同一个 key 可能只存在于第二个源），
 * 于是"想测某个站的接口"必须先能指定是哪个源 —— 否则会打到别的源上，轻则 404
 * （那个源里没这个站），重则**撞上同名站返回一份与该站无关的数据**。
 * 先查本地部署的源（id 就是部署源的 id），再查自定义清单；认不出/没填 url → null，上层如实报错，不猜。
 */
function byId(id) {
  const want = String(id || '').trim();
  if (!want) return null;
  /* 没在跑的部署源 url 是空的 → 当成"认不出"（`/api/base/*` 没法打它），与下面自定义源那条一致 */
  const dep = deployed().find((s) => s.id === want && s.url);
  if (dep) return Object.assign({}, dep, { origin: 'local', label: '本地部署源' });
  const list = (settings.read('agg') || {}).sources || [];
  const hit = list.find((s) => s && String(s.id) === want && s.url);
  if (!hit) return null;
  return {
    url: String(hit.url),
    origin: 'manual',
    label: '指定源',
    name: hit.name || hit.url,
    sourceId: hit.id,
    enabled: hit.enabled !== false,
    deployed: false,
  };
}

module.exports = { resolve, resolveLocal, resolveRun, byId, deployed };
