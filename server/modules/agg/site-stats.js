'use strict';
/**
 * 站点测速统计（**可丢弃**数据）—— 「站点与参数」页那一列「延迟」就是它。
 *
 * 两个来源，**分成两组槽**。混在一起会互相污染，因为两件事的口径不一样：
 *
 *   ① `speed.search` —— **服务端测速任务**写（`agg/site-test.js`）：每站一发
 *      `POST {api}/search`，**固定 15 秒超时**（不用 `agg.timeoutSec` / `agg.detailTimeoutSec`
 *      —— 那两个是给播放/搜索/取详情链路用的，拿 5 秒去测会把慢站一律记成超时，
 *      量到的是"设置"而不是"站"）。
 *
 *      **为什么是 `/search` 而不是 `/home`**：聚合真正走的就是 `/search`，只有它的数字
 *      对得上"用户会等多久"。`/home` 实测（52 个站）虽然也普遍可用（44/52 回 200），
 *      但它返回的是**首页分类树**（huban/duoduo 各 62KB / 208 个分类，盘搜类是空壳 10ms），
 *      与搜索耗时严重背离（实测 duoduo 首页 2.0s / 搜索 0.4s、huban 1.4s / 0.1s）——
 *      当"延迟"列会误导，所以放弃。
 *
 *      **关键词从常见影视名数组里随机取，失败换一个再测**（见 `api.js` 的 PROBE_WORDS）。
 *      两个理由：
 *        · 源侧对搜索结果有**内存缓存**（`SEARCH_CACHE_MINUTES` 默认 **3 分钟**、上限 500 条、
 *          键取自搜索词，命中会打 `[cache] Using search cache for "…"`）—— 固定用一个词，
 *          同一份结果会被缓存反复命中（实测 huban 同词 212→93ms），量到的是缓存不是站；
 *        · 站里**没有那个词**时会回 404 或空列表（实测 duoduo/huban：有词 200、无词 404），
 *          固定词等于给每个站预设了"有没有结果"这个变量。
 *        所以：随机取一个片名测一发，**非 200 就换一个再测一发**，两发都失败才算真失败。
 *
 *      **口径与业务刻意不同**：**HTTP 200 = 成功**（列表为空也算 —— 它已经尽了搜索的义务）；
 *      **非 200 一律记失败并记下状态码**（404 / 500 / 403 …）；超时与网络错记失败。
 *      ⚠️ 业务侧（`service.searchSite`）把 404 记成"无结果、不算失败"，所以这两笔
 *      **绝不能共用一槽** —— 否则 `shouldSkip` 会把"站里没这个片名"当成"站坏了"。
 *
 *   ② `call.search` / `call.detail` —— **顺手记账**（`service.js` 的 `searchSite` / `fetchDetail`）：
 *      把业务调用**本来就已经量好的**耗时（结果里的 `ms`）顺手写一笔，**不额外打任何请求**。
 *      **只用于界面诊断**（单元格 title 里那句"最近一次真实搜索 / 取详情"）—— 它跟的是业务口径
 *      （**404 = 无结果，不算失败**），与 ① 不是一回事，所以分开存。
 *      "要不要跳过这个站"看的是 ①（见 `shouldSkip`）：表里标红的站与搜索被跳过的站是同一个集合。
 *
 * 存哪儿：共享缓存目录下的 `sitestat.db`（由 `core/cachedb.js` 托管）。它是**可丢弃**的
 * （删了重新测），所以「面板设置 → 缓存设置 → 清空缓存」会一并清掉它。
 * 每个站每类**只留最近一次**（单槽覆盖）—— 不留样本数组、不累计次数，所以界面上不再有"（N 次）"。
 */
const { CACHE_DIR } = require('../../core/paths');
const cachedb = require('../../core/cachedb');

const store = cachedb.createStore({ label: 'sitestat', dir: CACHE_DIR, file: 'sitestat.db', tables: ['site_stat'] });

/** 存活期：统计是"最近的站况"，一个月足够，过期自动消失（免得删掉的站永远留着） */
const TTL_MS = 30 * 86400000;
/** 上限：一条两三百字节 × 几百个站点，512KB 富余得很 */
const MAX_BYTES = 512 * 1024;

/** 顺手记账只认这两类（测速那一笔走 `recordSpeed`，不在这个集合里） */
const CALL_KIND = new Set(['search', 'detail']);
/** 站点身份 = (源 id, 站点 key)：多源下同名 key 是两条不同的站点，绝不能用裸 key 存 */
const keyOf = (source, site) => `${source}\u0001${site}`;
/** 超时的错误文案（`searchSite`/`fetchDetail` 里就是 `超时(<ms>ms)`）—— 超时**不算"请求失败"** */
const isTimeout = (err) => /^超时/.test(String(err || ''));

function read(source, site) {
  let raw = null;
  try {
    raw = store.get('site_stat', keyOf(source, site));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/** 整条记录写回去（两个写入方共用）。写失败**绝不影响业务**（统计只是参考） */
function write(source, site, v) {
  try {
    store.put('site_stat', keyOf(source, site), JSON.stringify(v), TTL_MS, MAX_BYTES);
    return v;
  } catch {
    return null; // 统计坏了不该让搜索/播放跟着坏
  }
}

/**
 * 记一笔**测速结果**（`/search`）—— 直接覆盖上一次，不留历史。
 *
 * `one`：`{ ms, status, ok, error, wd, tries, count, routeMissing, timeout }`（`at` 由这里补）。
 * `wd` = 最终那一发用的关键词、`tries` = 实际发了几发（1 或 2，见 `api.js` 的 probeSearch）——
 * 一起记下来，界面上才能说清"这个数是拿哪个词、第几发测出来的"。
 */
function recordSpeed(source, site, one) {
  if (!source || !site || !one) return null;
  const v = Object.assign({}, read(source, site) || {});
  v.speed = Object.assign({}, v.speed, {
    search: {
      ms: Math.max(0, Math.round(Number(one.ms) || 0)),
      status: Number(one.status) || 0,
      ok: !!one.ok,
      error: one.ok ? '' : String(one.error || '失败').slice(0, 160),
      wd: String(one.wd || '').slice(0, 60),
      tries: Math.max(1, Number(one.tries) || 1),
      /* 200 但一条结果都没有（这站确实没这个词）—— 仍是**成功样本**，只在界面上标注 */
      count: Math.max(0, Number(one.count) || 0),
      /* 路由级 404（源里这个站没实现 /search）—— 与"上游 404"要分开说，判据见 api.js 的 probeSearch */
      routeMissing: !!one.routeMissing,
      timeout: !!one.timeout,
      at: Date.now(),
    },
  });
  return write(source, site, v);
}

/**
 * 顺手记账：`kind` = `search` | `detail`，覆盖同一类上一次的值。
 * `error` 一起记（界面 title 里会显示"最近一次失败：…"）。返回写入后的原始记录（供接口回显）。
 */
function recordCall(source, site, kind, ms, ok, error) {
  if (!source || !site || !CALL_KIND.has(kind)) return null;
  const v = Object.assign({}, read(source, site) || {});
  const one = {
    ms: Math.max(0, Math.round(Number(ms) || 0)),
    ok: !!ok,
    error: ok ? '' : String(error || '失败').slice(0, 160),
    timeout: ok ? false : isTimeout(error),
    at: Date.now(),
  };
  v.call = Object.assign({}, v.call, { [kind]: one });
  return write(source, site, v);
}

/**
 * 这次聚合搜索要不要**跳过**这个站。
 *
 * 判据只有一条：**最近一次测速结果是失败**（`speed.search.ok === false`）——
 * 即"最近一次实测这站搜不动"，那么这几轮别打它（打它就得等它到超时，纯白等）。
 *
 * ⚠️ **没有时间窗口**（原先那个"十分钟后自动再试"已删）：时效由**测速周期**决定 ——
 * 默认每 6 小时一轮，也可以点该站的「测速」立刻复测、或用「立即测速」整轮刷新。
 * 测出成功就自动恢复，全程**不动勾选**（站还在清单里、勾选也还在）。
 *
 * 判据取自测速那一槽（而不是顺手记账的 `call.search`）是刻意的：测速的口径就是
 * "这站现在能不能搜出东西"（`404` / `5xx` / 超时 / 两发都失败 = 失败，见文件顶部），
 * 拿它当跳过判据与界面上那一列红字**是同一个结论**，不会出现"表里标红、搜索却还在打它"。
 *
 * 没有测速数据的站**不跳过**：没数据 ≠ 坏站（见 ADR-0008）。
 */
function shouldSkip(source, site) {
  const one = ((read(source, site) || {}).speed || {}).search;
  if (!one || one.ok !== false) return null;
  return { error: one.error || '测速失败', at: Number(one.at) || 0, wd: String(one.wd || '') };
}

/**
 * 给接口/前端看的形状：`{ probe, call: { search, detail } }`。
 *   · `probe`      = 最近一次**测速**（`/search` + 随机片名，那一列「延迟」）；
 *   · `call.*`     = 最近一次**真实业务**（顺手记账）—— 放在 title 里当诊断信息。
 * 什么都没记过时返回 null（界面显示 `—`，如实，不编）。
 */
function view(source, site) {
  const v = read(source, site);
  if (!v) return null;
  const probe = (v.speed || {}).search || null;
  const call = v.call || {};
  const search = call.search || null;
  const detail = call.detail || null;
  if (!probe && !search && !detail) return null;
  return { probe, call: { search, detail } };
}

/** 站点被删/停用时清掉它的统计（不是必须 —— TTL 也会收，但那要等一个月） */
function forget(source, site) {
  try {
    /* cachedb 的 store 没暴露 delete，直接借用它的连接（表名与本文件声明的一致） */
    store.open().prepare('DELETE FROM site_stat WHERE key = ?').run(keyOf(source, site));
  } catch {
    /* 清不掉就算了 */
  }
}

module.exports = { recordSpeed, recordCall, view, forget, read, shouldSkip };
