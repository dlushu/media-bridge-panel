'use strict';
/**
 * Emby 层的本地缓存 —— **只剩图片索引**（Node 内置 `node:sqlite`，零依赖）
 *
 *   image_index  条目 Id → 图片位置（客户端不带 tag 来要图时用）
 *
 * —— 缓存按「谁使用」切分，而不是按数据来源切分 ——
 *   · `tmdb_cache`（TMDB 元数据）→ 搬到 **core** 的 `data/cache/tmdb.db`：它是 TMDB 数据，
 *     与名字索引同类；
 *   · `name_index`（名字 → 搜索结果）→ core，**emby 的搜索端点用**（聚合层改用本地打分后
 *     就不再碰它），放 core 是为了不把 TMDB 协议层留在 emby 里；
 *   · `image_index` 留下：写入点在 emby（`baseItem()` 出 tag 那一刻）、读在 emby 的图片端点，
 *     agg 从不碰它。⚠️ 并且它里头的图**不全是 TMDB 的** —— 插件/首页模块给的自定义图地址
 *     会原样存绝对 URL（TMDB 图床的那些才剥成无头相对路径，见 `tmdb.splitImageUrl`），
 *     所以"按是不是 TMDB 数据切库"对它本来就不成立；
 *   · `view_seen`（库「首次出现时刻」）→ **已删**：库条目的 `DateCreated` 改成占位值
 *     （`service.js` 的 ZERO_STAMP），这张不可再生的表随之失去唯一用途。
 *
 * 通用能力（开库 / TTL / 按字节 LRU / 统计 / 清空）都在 `core/cachedb.js`；
 * 本文件只声明"这一张表、这一套策略"。
 *
 * —— 为什么是**独立文件** `emby/cache.db`，不并进 `emby.db` ——
 * `emby.db` 存账号（scrypt 密码哈希），它的 PRAGMA 与备份策略由两条约束决定：
 *   ① 本库**写入量极小**，不需要 WAL 的并发收益（用 DELETE journal，不产生 -wal/-shm，
 *      文件级拷贝/备份不会漏数据）
 *   ② `chmod 0600`（含密码哈希）
 * 而缓存正好相反：**高写入、可随时删掉重建**。混在一起会让「备份时把可丢的缓存
 * 混进不可丢的账号」，还会在缓存写盘时用 DELETE journal 锁住整个库、挡住登录。
 * 分开之后，运维上就一句话：**缓存出问题就删掉 cache.db，账号不受影响**。
 */
const { EMBY_DIR } = require('../../core/paths');
const cachedb = require('../../core/cachedb');

const store = cachedb.createStore({ label: 'image', dir: EMBY_DIR, file: 'cache.db', tables: ['image_index'] });

/** 库文件路径（日志/文档引用它） */
const CACHE_DB = store.path;

/** 当前缓存策略（毫秒/字节）—— 读**面板设置**的 `cache.*`（策略只有一处，见 core/cachedb.js） */
function cfg() {
  return cachedb.cfg();
}

/* ------------------------------------------------------------ 对外：图片索引 */

function getImage(key) {
  return store.get('image_index', key);
}

function putImage(key, value, ttlMs, maxBytes) {
  store.put('image_index', key, value, ttlMs, maxBytes);
}

/* ------------------------------------------------------------ 对外：观察/运维
 * ⚠️ 统计、清空、设置变更后的扫一遍**统一在面板层**做（`core/cachedb.js` 的
 * statsAll / clearAll / sweepAll）—— 缓存现在跨两个库，"清空"必须只有一个入口，
 * 不能散在各模块里靠自觉。这里只留按本表上限扫一遍，供需要时单独调用。 */

/** 按当前设置把图片索引扫到上限以内 */
function sweepFromSettings() {
  const c = cfg();
  store.enforce('image_index', c.imageMaxBytes);
}

module.exports = {
  CACHE_DB,
  cfg,
  getImage,
  putImage,
  sweepFromSettings,
};
