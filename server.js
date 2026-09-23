'use strict';
/**
 * 媒体桥面板 · 入口（薄壳）
 *
 * 这里只做四件事：注册模块 → 搬迁旧设置 → 起 HTTP 服务 → 优雅关闭。
 * 所有业务端点都在 server/modules/<模块>/ 里，加模块只需往 MODULES 里加一行。
 */
const http = require('http');

const { serveStatic, sendError, notFound } = require('./server/core/http');
const router = require('./server/core/router');
const settings = require('./server/core/settings');
const registry = require('./server/core/registry');
const { DATA_DIR } = require('./server/core/paths');
const logbus = require('./server/core/logbus');
const auth = require('./server/core/auth');
const BRAND = require('./server/core/branding');

/* ⚠️ **必须在加载模块之前装**（就在这一行）：模块顶层、路由注册、启动横幅都会打日志，
 * 装晚了那批就进不了「面板设置 → 日志」页。`logbus` 自己不碰 console，不会递归。
 * 条数上限先给默认值，等设置读完（下面 `settings.read('panel')`）再按 `logMax` 调一次。 */
logbus.install();

// ————————————————— 模块清单（加模块只改这里）—————————————————
const MODULES = [
  require('./server/modules/source'), // 数据源层：本地托管源 / 运行中的源 / 托管源代理
  require('./server/modules/agg'), // 聚合层：多站并发聚合
  require('./server/modules/emby'), // 消费层：待开发（基于聚合）
  require('./server/modules/panel'), // 宿主层：面板自身与模块总览
];

for (const m of MODULES) {
  if (m.settings) settings.define(m.id, m.settings);
  registry.register(m);
  if (typeof m.routes === 'function') m.routes(router);
}

// 旧版单文件 data/settings.json → data/settings/<模块>.json
const migrated = settings.migrateLegacy();

/* Emby 的「线路过滤」已搬到聚合层（`agg.json` 的 `lineFilter`，理由见 agg/api.js 的 lineFilter）。
 * 已有部署的 `emby.json` 的 `play.filter` 可能填过值 —— **搬一次，避免旧配置悄然失效**。
 * 只在 agg 侧为空、且 emby 侧有值时搬；搬完把老键清掉（避免两处都有值、分不清哪个生效）。 */
try {
  const aggCfg = settings.read('agg');
  const embyCfg = settings.read('emby');
  const oldFilter = String(((embyCfg.play || {}).filter) || '').trim();
  if (!String(aggCfg.lineFilter || '').trim() && oldFilter) {
    settings.patch('agg', { lineFilter: oldFilter });
    settings.patch('emby', { play: { filter: '' } });
    console.log(`  ↻ 线路过滤已搬到聚合设置（原 emby.json 的 play.filter：${oldFilter}）`);
  }
} catch (e) {
  console.log('  ✘ 线路过滤搬迁失败（不影响启动）：' + ((e && e.message) || e));
}

const panel = settings.read('panel');
const WEB_PORT = Number(process.env.WEB_PORT || panel.port || 8099);
const WEB_HOST = process.env.WEB_HOST || panel.host || '0.0.0.0';

/* 设置读完了，按 `panel.logMax` 落实日志缓冲条数（默认 500）。
 * `resize` 会清空缓冲但不重置序号 —— 这里紧跟着启动，丢掉的那几条本来就还没产生。 */
logbus.resize(panel.logMax);

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, 'http://127.0.0.1');
  let pathname = decodeURIComponent(parsed.pathname);

  /* Emby 兼容端点的**前缀归一化** —— 让"只填主机"和"填完整路径"两种配法都能用。
   *
   * 真机 Emby 把 API 挂在 `/emby/` 下，而本面板挂在 `/api/emby`。客户端的行为是
   * **给的主机没带 `/emby` 就自己补一层**（文档里那条真机样例：给的是裸域名，它打的是 `/emby/Shows/…`），
   * 所以只填 `http://<面板地址>:8099` 时它来的是 `/emby/...` —— 以前这里没路由，直接 404。
   * 这里统一成规范形态（`/api/emby/...`），三种填法于是都通：
   *
   *   `/emby/xxx`            → `/api/emby/xxx`    （只填主机，或填了 `…/emby`）
   *   `/api/emby/emby/xxx`   → `/api/emby/xxx`    （填了 `…/api/emby` 的客户端又多补了一层）
   *
   * 只动这两个前缀；`/api/agg`、静态文件、`/website` 等一律原样。写法放在最前面是为了
   * "进门禁与路由时路径已经是规范形态"，免得后面按前缀判断的地方各判一套。 */
  if (pathname === '/emby' || pathname.startsWith('/emby/')) {
    pathname = '/api/emby' + pathname.slice('/emby'.length);
  } else if (pathname === '/api/emby/emby' || pathname.startsWith('/api/emby/emby/')) {
    pathname = '/api/emby' + pathname.slice('/api/emby/emby'.length);
  }

  try {
    // 面板接口（各模块注册的路由）+ 配置中心同源代理
    if (pathname.startsWith('/api/') || pathname.startsWith('/website')) {
      /* 面板门禁（单密码，见 core/auth.js）：**只拦面板自己的接口与被代理的源配置页**。
       * `/api/auth/*` 与 `/api/emby/*` 由 auth.needsAuth 直接放行 —— 前者不然登录不了；
       * 后者是 Emby 客户端打的（它们有自己的 AccessToken 校验，拦了等于把所有客户端断掉，
       * docker 的健康检查也走那条路）。 */
      const deny = auth.guard(req, pathname);
      if (deny) {
        res.setHeader('Set-Cookie', auth.cookieHeader('', req)); // 顺手清掉过期/无效的那个 cookie
        return sendError(res, 401, deny);
      }
      return await router.handle(req, res, { pathname, searchParams: parsed.searchParams });
    }
    // 其余一律当作 public/ 下的静态文件（含 core/ modules/ docs/ styles/ 子目录）
    if (serveStatic(req, res, pathname)) return;

    /* 静态里也没有 → **再问一次猫源层**：源的配置中心前端写死了根路径（`/full-config` 那类），
     * 请求会直接落到面板的根路径上。只有猫源层知道"当前配置中心是哪个源"，所以由它兜底转发；
     * 没人认领（没人看配置中心）就照旧 404 —— 行为与以前完全一致。理由见 config-proxy.js 顶部。 */
    if (await sourceModule.proxyConfigCenter(req, res, { pathname, searchParams: parsed.searchParams })) return;
    return notFound(res);
  } catch (e) {
    const code = e.code === 404 ? 404 : e.code === 400 ? 400 : 500;
    return sendError(res, code, e.message || '服务器内部错误');
  }
});

const sourceModule = registry.get('source');
const embyModule = registry.get('emby');
const panelModule = registry.get('panel');

server.listen(WEB_PORT, WEB_HOST, async () => {
  /* 名字读 core/branding.js（改名只改那一处 + 前端那份 + package.json + index.html 兜底）；
   * 依既定决策**不摆图标**，所以这里与顶栏都只有文字。 */
  console.log(`\n  ${BRAND.panelName}已启动`);
  console.log(`     面板地址: http://127.0.0.1:${WEB_PORT}`);
  console.log(`     数据目录: ${DATA_DIR}`);
  console.log(`     模块: ${registry.list().map((m) => m.id).join(' · ')}`);
  if (migrated) console.log(`     ↻ 设置已拆分: settings.json → ${migrated.to}（旧文件留档 ${migrated.backup}）`);
  console.log('');
  if (sourceModule) await sourceModule.autostartAll();
  /* 猫源自动更新（可选，默认关）：勾选与间隔在「源托管 · 猫源地址」页，见 source/auto-update.js。
   * 放这儿 = 面板起来之后才开始计时（不是模块 require 的时候就跑）。 */
  if (sourceModule && typeof sourceModule.startAutoUpdate === 'function') sourceModule.startAutoUpdate();
  /* emby 层同理：把随包的内置首页示例同步进插件列表（md5 一致就跳过，见 emby/index.js autostart） */
  if (embyModule && typeof embyModule.autostart === 'function') await embyModule.autostart();
  /* 更新即完整替换：**每次启动成功后**清掉当前版本之外的版本目录（旧版本不留档，也不作本地回退，
   * 决策见 docs/adr/0021-update-replaces-app-dir.md）。它自己会延迟几秒再动手，
   * 也会在非受管运行方式下跳过（直接跑源码时数据目录里的 app/ 不该被动）。 */
  if (panelModule && typeof panelModule.pruneOnBoot === 'function') panelModule.pruneOnBoot();
});

/* 进程级兜底：**一个请求出问题不该把整个面板带走**。曾出现过整进程退出 ——
 * 代理拉流被 `AbortSignal.timeout` 掐断，body 流上的 'error' 无人监听，进程随之退出。
 * 这里只记录 + 继续跑：不静默吞掉（日志里有完整堆栈），也不自杀。 */
process.on('uncaughtException', (e) => {
  console.error('  ✘ 未捕获异常（已拦截，服务继续）：' + ((e && e.stack) || e));
});
process.on('unhandledRejection', (e) => {
  console.error('  ✘ 未处理的 Promise 拒绝（已拦截，服务继续）：' + ((e && e.stack) || e));
});

async function shutdown() {
  console.log('\n  正在停止所有源服务…');
  if (sourceModule) {
    try {
      await sourceModule.stopAll();
    } catch (e) {
      console.error('  ✗ 停止源失败：' + e.message);
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
