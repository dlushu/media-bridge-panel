'use strict';
/**
 * 面板层（宿主层，不参与数据链）
 *
 *   自己：面板监听参数、模块启用、配置备份/还原、服务自述
 *   对外：/api/panel/*、/api/modules*、/api/meta
 */
const routes = require('./routes');
const logbus = require('../../core/logbus');
const tmdb = require('../../core/tmdb');
const cachedb = require('../../core/cachedb');

module.exports = {
  id: 'panel',
  label: '面板设置',
  apiPrefix: ['/api/panel', '/api/modules', '/api/meta', '/api/logs', '/api/auth'],
  upstream: null,

  settings: {
    defaults: () => ({
      host: '0.0.0.0',
      port: 8099,
      /* 面板「日志」页的内存缓冲条数（见 core/logbus.js）。**纯内存、不落盘**，
       * 所以这个数直接决定内存占用上限（500 条 ≈ 最多 0.5MB）。 */
      logMax: 500,
      modules: { source: true, agg: true, emby: true, panel: true },
      /* TMDB（元数据反查）—— **共享配置，归面板层**（原在 emby 层）。
       * 为什么放这儿：emby 层（元数据）与聚合层（同名失败时按名字反查 tmdb id）都要用，
       * 而依赖是单向的 `emby → agg → source` —— agg 不能读 emby 的配置。放最底下的宿主层就谁都能读。
       * 说明与默认值见 `core/tmdb.js`；UI 在「面板设置 → 设置」。 */
      tmdb: tmdb.defaults(),
      /* 本地缓存策略（原在 emby 层）—— 缓存现在跨两个库：
       *   core 的 `data/cache/tmdb.db`（tmdb_cache 元数据 + name_index 名字索引）
       *   emby 的 `data/emby/cache.db`（image_index 图片索引）
       * 而「用量显示 / 清空缓存 / 设置改小后立刻淘汰」都要一把抓两个 —— 所以设置放在
       * 宿主层，UI 在「面板设置 → 缓存设置」。默认值与读法只此一处：`core/cachedb.js` 的 cfg()。
       *   tmdbTtlDays  元数据多久算过期 —— 元数据几乎不变，给长一点
       *   tmdbMaxMB    元数据缓存的总字节上限（实测 rich 响应 60~120KB，200MB ≈ 2000~3000 部片）
       *   imageTtlDays 图片索引的存活期 —— URL 几乎不变，但换图床基地址后靠它自愈
       *   imageMaxMB   图片索引上限（无头路径，一条约几十字节，5MB 已经远超实际用量）
       * **上限一律按字节不按条数**：lean 1.9KB vs rich 119KB 差 60 倍，按条数算不准。 */
      cache: Object.assign({}, cachedb.DEFAULTS),
    }),
    fields: [
      { key: 'port', label: '面板端口', type: 'number', min: 1, max: 65535 },
      { key: 'host', label: '监听地址', type: 'text', placeholder: '0.0.0.0（局域网可访问）或 127.0.0.1' },
      { key: 'logMax', label: '日志缓冲条数', type: 'number', min: 50, max: 5000, hint: '「日志」页只留最近这么多条（纯内存，不落盘；长期留档看 docker logs）' },
      { key: 'tmdb.token', label: 'TMDB Token', type: 'password', placeholder: 'v4 API Read Access Token' },
      { key: 'tmdb.apiBase', label: 'TMDB API 基地址', type: 'url', placeholder: '留空 = https://api.themoviedb.org/3' },
      { key: 'tmdb.imageBase', label: 'TMDB 图片基地址', type: 'url', placeholder: '留空 = https://image.tmdb.org/t/p' },
      { key: 'tmdb.language', label: 'TMDB 语言', type: 'text', placeholder: 'zh-CN' },
      { key: 'cache.tmdbTtlDays', label: '元数据缓存天数', type: 'text', placeholder: '30' },
      { key: 'cache.tmdbMaxMB', label: '元数据缓存上限 MB', type: 'text', placeholder: '200' },
      { key: 'cache.imageTtlDays', label: '图片索引天数', type: 'text', placeholder: '90' },
      { key: 'cache.imageMaxMB', label: '图片索引上限 MB', type: 'text', placeholder: '5' },
    ],
    validate: (o) => {
      if (!(Number(o.port) >= 1 && Number(o.port) <= 65535)) return 'port 取值 1~65535';
      /* TMDB 两个基地址：**留空/缺省 = 用官方**，填了就必须是 http(s)（照 emby 原来那条校验搬过来） */
      const t = (o && o.tmdb) || {};
      for (const key of ['apiBase', 'imageBase']) {
        const v = t[key];
        if (v === undefined || v === null || v === '') continue;
        if (typeof v !== 'string' || !/^https?:\/\//i.test(v.trim())) {
          return `tmdb.${key} 必须是 http(s) 地址，或留空用官方地址`;
        }
      }
      /* 缓存数值必须是「非负数字」（原为 emby 的设置校验，已迁到此处）。
       * ⚠️ 两个 0 的语义**不一样**（见 core/cachedb.js 的 cfg）：
       *   天数 0 = 不缓存（写完即过期）；上限 0 = **不限**（不淘汰）。二者不可当作同一语义处理。 */
      const c = (o && o.cache) || {};
      for (const key of ['tmdbTtlDays', 'tmdbMaxMB', 'imageTtlDays', 'imageMaxMB']) {
        const v = c[key];
        if (v === undefined || v === null || v === '') continue;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) return `cache.${key} 必须是不小于 0 的数字（当前：${v}）`;
      }
      return null;
    },
  },

  /**
   * 设置改动后立刻落实（由面板的通用设置端点调用，见 panel/routes.js）。
   *
   * 两件事各管各的：
   *   ① `logMax` 改了马上生效（`resize` 会清空现有缓冲，`seq` 不动）—— 但这一页不止它一个设置，
   *      别的键改了不该顺手把日志清掉，所以要比一下；
   *   ② **缓存上限调小后立刻淘汰**（原在 emby 层，现在是跨两个库的 `sweepAll()`）——
   *      否则面板上会显示「已用 60MB / 上限 10MB」，看着像坏了，实际要等下次写入才收拾。
   */
  onSettingsChange(next) {
    const old = Number(logbus.stats().max);
    const v = Number(next && next.logMax);
    if (Number.isFinite(v) && v > 0 && v !== old) logbus.resize(v);
    try {
      cachedb.sweepAll();
    } catch {
      /* 清理失败不该让"保存设置"这件事失败 */
    }
  },

  routes,
};
