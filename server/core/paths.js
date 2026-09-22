'use strict';
/**
 * 项目路径集中定义
 *
 * 各层不再用「相对自己几层」推算目录，避免文件搬家后路径错位。
 * 可用 DATA_DIR 环境变量把运行时数据放到别处（备份/多实例）。
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');

module.exports = {
  ROOT,
  PUBLIC_DIR: path.join(ROOT, 'public'),
  DATA_DIR,
  SETTINGS_DIR: path.join(DATA_DIR, 'settings'),
  SOURCES_DIR: path.join(DATA_DIR, 'sources'),
  SOURCES_FILE: path.join(DATA_DIR, 'sources.json'),
  /** **共享缓存目录**（可随时删掉重建的数据）：TMDB 元数据 + 名字索引（见 core/tmdb.js + core/cachedb.js）。
   * 缓存按"谁用"分家 —— 共用的（TMDB 元数据 / 名字索引）在 core 这边，
   * 只有 emby 用的（图片索引）仍在 `data/emby/cache.db`。 */
  CACHE_DIR: path.join(DATA_DIR, 'cache'),
  /** TMDB 缓存库：`tmdb_cache`（元数据响应）+ `name_index`（名字 → 搜索结果，agg 与 emby 共用） */
  TMDB_CACHE_DB: path.join(DATA_DIR, 'cache', 'tmdb.db'),
  /** 聚合详情缓存库：`detail_cache`（影视名 + 季集 → 线路与定位结果，见 agg/cache.js）。
   * 也放共享缓存目录：读它的有聚合层（web 取详情）与 emby 层（条目详情 / 播放信息）。 */
  DETAIL_CACHE_DB: path.join(DATA_DIR, 'cache', 'detail.db'),
  /** emby 模块自己的库（客户端登录账号等；含密码哈希，不要提交/外发） */
  EMBY_DIR: path.join(DATA_DIR, 'emby'),
  EMBY_DB: path.join(DATA_DIR, 'emby', 'emby.db'),
  /** 旧版单文件设置（会被自动搬迁到 settings/ 目录） */
  LEGACY_SETTINGS: path.join(DATA_DIR, 'settings.json'),
};
