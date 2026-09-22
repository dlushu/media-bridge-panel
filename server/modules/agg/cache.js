'use strict';
/**
 * 聚合层的本地缓存 —— 只有一张表
 *
 *   detail_cache  影视名 + 季集 → 聚合结果（命中哪些站 / 各站线路 / 定位到源里哪一条）
 *
 * —— 为什么需要它 ——
 * 客户端点一次「播放」会连着问三遍同一件事：条目详情 → 播放信息① → 播放信息②。
 * 而这条链每一步都要重跑「搜源 → 逐站取详情 → 定位到这一集」，实测每次 4~7 秒 ——
 * 三次串行 ≈ 20 秒，其中两遍是白重算的。缓存的就是这三遍共同的那一步。
 *
 * ⚠️ **只缓存到「集 id」为止，绝不缓存播放地址**：地址有时效（见 api.js 的 `play()`，
 * 那里明写"每次播放都现取"）。快照里的 `target.id`（源那边的集 ID）本身也是时效 token，
 * 所以这张表是**分钟级短缓存**，不是天级。
 *
 * —— 为什么是独立库文件 `detail.db` ——
 * 照 `emby/cache.js` 的分家口径：缓存**按"谁使用"切，不按数据来源切** ——
 * 这张表由聚合层自己写、自己读（emby 层只是在 agg 里面间接用到），所以由 agg 声明；
 * 但文件落在共享缓存目录 `data/cache/`，与 `tmdb.db` 并列，运维口径仍是
 * 「缓存坏了就删 cache 目录里的库，账号不受影响」（账号在 emby.db）。
 *
 * 淘汰策略（TTL / 字节上限 / LRU）与"清空"入口都在 `core/cachedb.js`，这里只声明这一张表的用法。
 */
const { CACHE_DIR } = require('../../core/paths');
const cachedb = require('../../core/cachedb');

const store = cachedb.createStore({ label: 'detail', dir: CACHE_DIR, file: 'detail.db', tables: ['detail_cache'] });

/** 库文件路径（日志/文档引用它） */
const CACHE_DB = store.path;

/** 取一条快照；没有/过期/内容坏了都回 null（坏的那条当没有，下次重写） */
function getDetail(key) {
  const text = store.get('detail_cache', key);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 写一条快照。
 *
 * **谁该写、谁不该写由调用方判断**（见 `api.js` 里那段：有站失败不写、负结果不写）——
 * 这里只管"按当前设置写进去"。
 *
 * TTL 与字节上限都读面板设置（「缓存设置 → 聚合详情」，见 `core/cachedb.js` 的 `cfg`）：
 * `detailTtlMs <= 0` = 不缓存（设置里填 0），勾了「长期有效」则是一个很远的过期时刻。
 */
function putDetail(key, value) {
  const c = cachedb.cfg();
  if (!(c.detailTtlMs > 0)) return false;
  store.put('detail_cache', key, JSON.stringify(value), c.detailTtlMs, c.detailMaxBytes);
  return true;
}

module.exports = {
  CACHE_DB,
  getDetail,
  putDetail,
};
