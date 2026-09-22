'use strict';
/**
 * Emby 层模块（消费层）
 *
 * 基于「聚合层」工作：**进程内直调** `../agg/api`（`detail()` / `play()`）——
 * 两层在同一个进程里，走 HTTP 打自己的 `/api/agg/*` 只会撞面板门禁（不带 cookie → 401）。
 * 见 `agg/api.js` 顶部那段说明。
 *
 * 当前阶段只做「端点监控」：捕获 Emby 客户端打过来的全部请求，
 * 具体补哪些端点由部署者指定，见 docs/emby-compat.md。
 *
 * TMDB 设置**不在本模块**（已搬到面板层，见 `core/tmdb.js`）；
 * 本模块只留 emby 专有的那层反查与 DTO（`tmdb.js`）。
 */
const BRAND = require('../../core/branding');
const routes = require('./routes');
const home = require('./home');

/**
 * 拉流方式（`play.mode`）**已删** —— 现在一律 302，见 service.js 的 `redirectUrl()`。
 * 这里不再有"放行老值"的兼容：校验里没有它，盘上留着的 `play.mode` 既不读也不校验，
 * 任何一张卡片保存都不会被它挡住（这正是早期保留 `auto` 的理由，该理由现已不成立）。
 */

module.exports = {
  id: 'emby',
  label: 'Emby',
  apiPrefix: ['/api/emby'],
  upstream: 'agg',

  settings: {
    defaults: () => ({
      /* 握手时对外自称的服务器名（`System/Info/Public` 的 `ServerName`）—— 客户端「服务器列表」里显示的就是它。
       * 面板「Emby → 连接设置」可改；留空/全空白回落到 `BRAND.name`（见 service.serverName）。
       * 默认名不带"面板"二字，因为它显示在客户端「服务器列表」里，位置小；
       * 默认值取 `BRAND.embyServerName`（「媒体桥 Emby」）。 */
      serverName: BRAND.embyServerName,
      /* 老的单账号（明文）—— 只为兼容老备份/老前端而留的空壳：
       * 真正的账号在 data/emby/emby.db（多账号，见 db.js），首次用到库时这个空壳会被清空。 */
      account: { username: '', password: '' },
      /* ⚠️ TMDB 设置**不在这里**了（已搬到面板层 `panel.json` 的 `tmdb.*`）：
       * emby 层（元数据）与聚合层（同名失败时按名字反查 tmdb id）都要用它，
       * 而依赖是单向的 `emby → agg → source`。见 core/tmdb.js。 */
      /* 拉流方式是**一律 302**：面板不扛流量，客户端直连源。
       * 本地部署的源回的地址是回环地址，302 前会换成客户端访问用的那个域名 + 源端口
       * （见 service.redirectUrl）；自定义源按源给的真实地址。所以这里没有可选项。 */
      /* ⚠️ **线路过滤搬走了**（→ `agg.json` 的 `lineFilter`，UI 在「聚合设置 → 聚合参数」）：
       * 线路是聚合层产出的东西，规则与它放在一起，所以归聚合设置而不在本模块。
       * 盘上老的 `play.filter` 由 `server.js` 启动时搬一次到 `agg.json`（搬完这里就不认它）。 */
      servers: [],
      defaultIndex: 0,
      serverId: '', // 首次握手时生成并落盘，保证客户端缓存的服务器身份稳定
      /* 图片签名密钥：首次用到时随机生成（见 service.imageKey）。只在本机校验 tag 用，
       * **不随任何 DTO 外发** —— 它把"面板代为取图"这个豁免 token 的端点钉死成不是开放代理。 */
      imageKey: '',
      /* ⚠️ 缓存设置**不在这里**了（已搬到面板层 `panel.json` 的 `cache.*`）：
       * 缓存已跨两个库（core 的 `data/cache/tmdb.db` 与这里的 `data/emby/cache.db`），
       * 而「清空缓存」与「用量显示」要一把抓两个 —— 设置跟着面板走才不会出现
       * "面板上管一半、模块里管一半"。UI 在「面板设置 → 缓存设置」。 */
    }),
    fields: [
      { key: 'serverName', label: '服务器名', type: 'text', placeholder: `默认 ${BRAND.embyServerName} —— 客户端「服务器列表」里显示的就是它` },
    ],
    /** 只校验服务器名与线路过滤，其余一律放过（validate 收到的是全量对象） */
    validate: (o) => {
      /* 服务器名：**禁止超长**（客户端列表里显示不下，而且这是要写进握手响应的东西）；
       * 空 / 全空白**不算错** —— 那是"用默认名"，service.serverName 会兜住 */
      const sn = String((o && o.serverName) || '').trim();
      if (sn.length > 40) return `serverName 最长 40 个字符（当前 ${sn.length} 个）`;
      /* ⚠️ `play.mode` **不再校验**（"面板代理"已去掉，该键已无意义）——
       * 老配置盘上留着这个键照样能保存任意一张卡片。 */
      /* ⚠️ 线路过滤的校验**搬走了**（→ `agg/settings.js` 的 `lineFilter`）：设置跟着它的新位置走。
       * 盘上老键 `play.filter` 既不读也不校验（启动时已搬到 agg.json）。 */
      /* 缓存数值的校验**不在这里**了 —— 那是面板层的设置（见 panel/index.js）。
       * 注意两个 0 的语义**不一样**：天数 0 = 不缓存（写完即过期）；上限 0 = **不限**（不淘汰）。 */
      return null;
    },
  },

  /**
   * 面板启动时调（见 `server.js`，与 `sourceModule.autostartAll()` 同一个位置）。
   *
   * 把**随包发行的内置首页示例**同步进插件列表 —— 按 md5 比，一致就跳过、不一致就覆盖更新
   * （面板升级带来的新示例靠这条生效，且会保留已启用状态与已保存参数）。见 `home.ensureBuiltin()`。
   * ⚠️ 失败**不挡面板启动**：它只是个示例插件，坏了不该连累整个面板。
   */
  autostart: async () => {
    try {
      const out = await home.ensureBuiltin();
      const p = out.plugin;
      console.log(
        `  ${out.unchanged ? '✔' : '↻'} emby 内置首页示例：${out.unchanged ? '已在位（md5 一致，跳过）' : '已同步进插件列表'}` +
          `（${p.id} v${p.version}，${(p.rows || []).length} 行）`
      );
    } catch (e) {
      console.log('  ✘ emby 内置首页示例同步失败（面板继续）：' + ((e && e.message) || e));
    }
  },

  routes,
};
