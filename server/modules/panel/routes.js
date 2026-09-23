'use strict';
/**
 * 面板层路由（宿主层）
 *   /api/meta                     服务自述（外部可用它确认地址是不是一个面板、暴露了哪些模块）
 *   /api/modules                  模块总览（含每个模块消费的上游地址）
 *   /api/modules/:id/settings     每个模块自己的设置（通用端点，加模块不用改这里）
 *   /api/panel/tmdb/test          TMDB 设置自检（配置归面板层，自检也在同一层）
 *   /api/panel/info, /api/panel/backup|restore
 *   /api/auth/*                   面板鉴权：status / login / logout / password（见 core/auth.js）
 *   /api/logs                     面板日志（内存环形缓冲的读取/清空，见 core/logbus.js）
 *   /api/settings                 兼容层：前端迁移到 /api/modules/agg/settings 后删除
 */
const settings = require('../../core/settings');
const registry = require('../../core/registry');
const catpaw = require('../../core/catpaw');
const tmdb = require('../../core/tmdb');
const cachedb = require('../../core/cachedb');
const logbus = require('../../core/logbus');
const auth = require('../../core/auth');
const { sendJson, sendError, readBody } = require('../../core/http');
const { DATA_DIR, SETTINGS_DIR } = require('../../core/paths');
const backup = require('./backup');
const update = require('./update');
const pkg = require('../../../package.json');

/**
 * 一次性搬迁（已经有部署实例，所以要有这一步）：TMDB 设置原来归 **emby 层**
 * （`data/settings/emby.json` 的 `tmdb.*`），现已归**面板层**（`panel.json` 的 `tmdb.*`）——
 * 因为聚合层也要用它做「站源条目名 → tmdb id」的反查，而 `emby → agg` 是单向依赖，
 * agg 不能去读 emby 的配置。见 `core/tmdb.js` 顶部。
 *
 * 规则：**emby 那边配了 token、面板这边没配** → 搬过来并清掉 emby 那段（免得两处长得像真的）。
 * 面板已配就什么都不做（绝不覆盖新值）。跑在路由注册时，即启动那一下；干净了就是空操作。
 */
function migrateTmdbFromEmby() {
  const emby = settings.read('emby') || {};
  const old = emby.tmdb;
  if (!old || typeof old !== 'object') return;
  if (!String(old.token || '').trim()) return; // emby 那边本来就没配 → 没什么可搬
  if (String(((settings.read('panel') || {}).tmdb || {}).token || '').trim()) return; // 面板已配 → 不覆盖

  const next = {};
  for (const k of ['token', 'apiBase', 'imageBase', 'language']) {
    if (old[k] !== undefined && old[k] !== null && old[k] !== '') next[k] = old[k];
  }
  settings.patch('panel', { tmdb: next });

  /* 把 emby 那份删掉（`patch` 只能合并不能删，所以整份重写）——
   * `write` 写的就是这份对象，缺的键下次 `read` 会由 defaults 补回来。 */
  const embyNext = Object.assign({}, emby);
  delete embyNext.tmdb;
  settings.write('emby', embyNext);

  const keys = Object.keys(next).join(' / ') || '(空)';
  console.log(`  ↻ TMDB 设置已从 emby 层搬到面板层：${keys}（token 保留，面板「设置」页可改）`);
}

/**
 * 一次性搬迁（同款第二步）：缓存设置原来归 **emby 层**（`emby.json` 的 `cache.*`），
 * 现已归**面板层**（`panel.json` 的 `cache.*`）—— 因为缓存已跨两个库
 * （core 的 `data/cache/tmdb.db` 与 emby 的 `data/emby/cache.db`），
 * 用量/清空/淘汰要一把抓两个，设置跟着面板走才不会"面板管一半、模块管一半"。
 *
 * 规则：emby 那边**有这几个键**就搬过来（用户调过的数值不该静默丢失），随后清掉 emby 那段。
 * 面板这边已经有的值会被**覆盖成 emby 的** —— 搬迁只会在 emby 还在写这几个键时发生一次
 * （搬完就删），此后 emby 那份不再存在，是空操作。
 */
function migrateCacheFromEmby() {
  const emby = settings.read('emby') || {};
  const old = emby.cache;
  if (!old || typeof old !== 'object') return;

  const keys = ['tmdbTtlDays', 'tmdbMaxMB', 'imageTtlDays', 'imageMaxMB'];
  const next = {};
  for (const k of keys) {
    if (old[k] !== undefined && old[k] !== null && old[k] !== '') next[k] = old[k];
  }
  if (Object.keys(next).length) settings.patch('panel', { cache: next });

  const embyNext = Object.assign({}, emby);
  delete embyNext.cache;
  settings.write('emby', embyNext);

  console.log(`  ↻ 缓存设置已从 emby 层搬到面板层：${Object.keys(next).join(' / ') || '(空)'}（面板「缓存设置」可改）`);
}

/** 前端设置页当前用到的 agg 形状（兼容层用） */
function legacyAggView() {
  const a = settings.read('agg');
  return {
    baseUrl: (a.upstream && a.upstream.source) || '',
    agg: {
      enabled: a.enabled,
      order: a.order,
      timeoutMs: a.timeoutMs,
      concurrency: a.concurrency,
      initFirst: a.initFirst,
      /* ⚠️ **这里必须把 agg 的设置全带上**：前端启动时读的就是这份（`S.settings.agg`），
       * 少一个键，页面刷新后就当它不存在 —— 实测：`lineFilter` 没带 → "保存完刷新编辑框还是空的"，
       * `matchExtraK` 没带 → 打分设置那页刷新后显示默认值，一点保存就把用户设的值覆盖掉（8 → 3）。
       * 加键的时候**两边都要加**（或让设置页直接读 `/api/modules/agg/settings`，见 agg/params.js）。 */
      matchMinScore: a.matchMinScore,
      matchMaxItems: a.matchMaxItems,
      matchExtraK: a.matchExtraK,
      matchExtraAll: a.matchExtraAll,
      lineFilter: a.lineFilter,
    },
  };
}

module.exports = function routes(r) {
  migrateTmdbFromEmby();
  migrateCacheFromEmby();
  /* ---------------------------------------------------------------- 面板鉴权 */
  /* `/api/auth/*` 是**唯一不需要登录的面板接口**（见 core/auth.js 的 OPEN_PREFIXES）——
   * 登录、登出、以及当前登录状态（前端靠它决定显示登录框还是面板）。 */

  r.add('GET', '/api/auth/status', (req, res) =>
    sendJson(res, 200, {
      required: true,
      authed: auth.isAuthed(req),
      /* 还在用默认密码时前端显示一条提醒（只回布尔，不回密码/哈希） */
      isDefault: auth.isDefaultPassword(),
      minLength: auth.MIN_LEN,
    })
  );

  r.add('POST', '/api/auth/login', async (req, res) => {
    const body = await readBody(req);
    const out = auth.login(req, (body && (body.password || body.Password)) || '');
    if (out.error) return sendJson(res, out.locked ? 429 : 401, { error: out.error });
    res.setHeader('Set-Cookie', auth.cookieHeader(out.token, req));
    return sendJson(res, 200, { ok: true });
  });

  r.add('POST', '/api/auth/logout', (req, res) => {
    res.setHeader('Set-Cookie', auth.cookieHeader('', req));
    return sendJson(res, 200, { ok: true });
  });

  /** 改密码：要登录（门禁已保证），再验一次旧密码。**改完旧会话全部失效**（token 里签了密码指纹）。 */
  r.add('POST', '/api/auth/password', async (req, res) => {
    const body = await readBody(req);
    const out = auth.setPassword(String((body && body.oldPassword) || ''), String((body && body.newPassword) || ''));
    if (out.error) return sendJson(res, 400, { error: out.error });
    console.log('  🔑 面板密码已修改（旧会话已失效，请重新登录）');
    /* 顺手把当前这个 cookie 也清掉：让前端明确回到登录页，而不是"看起来还登着" */
    res.setHeader('Set-Cookie', auth.cookieHeader('', req));
    return sendJson(res, 200, { ok: true });
  });

  r.add('GET', '/api/meta', (req, res) =>
    sendJson(res, 200, {
      service: 'catpaw-panel',
      version: pkg.version,
      node: process.version,
      modules: registry.describe(settings.read),
    })
  );

  r.add('GET', '/api/modules', (req, res) => sendJson(res, 200, { modules: registry.describe(settings.read) }));

  /* 模块设置：一个模块一份文件，走同一组通用端点 */
  r.add('GET', '/api/modules/:id/settings', (req, res, { params }) => {
    if (!registry.get(params.id)) return sendError(res, 404, '模块不存在：' + params.id);
    return sendJson(res, 200, { id: params.id, settings: settings.read(params.id) });
  });

  r.add('PUT', '/api/modules/:id/settings', async (req, res, { params }) => {
    const mod = registry.get(params.id);
    if (!mod) return sendError(res, 404, '模块不存在：' + params.id);
    const body = await readBody(req);
    const next = settings.patch(params.id, body && body.settings ? body.settings : body);
    /* 设置变更钩子（可选）：让模块对"新配置"做点收尾 —— 例如 emby 按新上限立刻淘汰缓存
     * （见 emby/index.js onSettingsChange）。钩子出错不该让保存本身失败，所以吞掉。 */
    if (typeof mod.onSettingsChange === 'function') {
      try {
        mod.onSettingsChange(next, params.id);
      } catch {
        /* 收尾失败不影响保存结果 */
      }
    }
    return sendJson(res, 200, { id: params.id, settings: next });
  });

  r.add('DELETE', '/api/modules/:id/settings', (req, res, { params }) => {
    if (!registry.get(params.id)) return sendError(res, 404, '模块不存在：' + params.id);
    return sendJson(res, 200, { id: params.id, settings: settings.reset(params.id) });
  });

  /* 面板自身 */
  r.add('GET', '/api/panel/info', (req, res) =>
    sendJson(res, 200, {
      version: pkg.version,
      node: process.version,
      dataDir: DATA_DIR,
      settingsDir: SETTINGS_DIR,
      /* 仓库地址（「设置 → 关于」与「版本与更新」的 Release 链接都用它，见 update.js 的 repoInfo） */
      ...update.repoInfo(),
      modules: registry.describe(settings.read),
    })
  );

  r.add('GET', '/api/panel/backup', (req, res) => sendJson(res, 200, backup.exportAll()));

  r.add('POST', '/api/panel/restore', async (req, res) => {
    const body = await readBody(req);
    return sendJson(res, 200, backup.restore(body));
  });

  /**
   * POST /api/panel/tmdb/test —— 测 TMDB 设置（面板「TMDB 设置」的「测试」按钮）
   *
   * body 可带 token/apiBase/imageBase/language（用界面上**没保存**的当前值）与 tmdbId/type。
   * 一律回 HTTP 200，成败看 ok / error.code —— 前端才能拿到细节而不是一句 "HTTP 4xx"。
   * 日志只打基地址、探测对象、状态与耗时，**绝不打 token**。
   * 逻辑在 `core/tmdb.js`（这个自检跟着配置走）；这条原在 emby 层，已随配置迁到面板层。
   */
  r.add('POST', '/api/panel/tmdb/test', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const out = await tmdb.test(body, (settings.read('panel') || {}).tmdb || {});
    const mark = out.ok ? '✔' : '✘';
    console.log(
      `  ${mark} panel tmdb 测试 → ${out.probe.type}/${out.probe.tmdbId} auth=${(out.auth && out.auth.status) || '-'}` +
        ` api=${out.apiBase} ${out.elapsedMs}ms${out.error ? '  ' + out.error.code : ''}`
    );
    return sendJson(res, 200, out);
  });

  /**
   * GET    /api/panel/cache —— 缓存用量（面板「缓存设置」显示「已用 x / 上限 y」）
   * DELETE /api/panel/cache —— **清空所有缓存**
   *
   * 建这个端点时缓存已跨两个库（原 `/api/emby/cache` 只有 emby 那张库）——
   *   core  `data/cache/tmdb.db`  tmdb_cache（元数据）+ name_index（名字 → 搜索结果）
   *   emby  `data/emby/cache.db`  image_index（图片索引）
   * "清空"与"用量"**只能有一个入口**，否则以后加一张表就会漏清一处 —— 所以收敛到面板层，
   * 走 `core/cachedb.js` 的 `statsAll()` / `clearAll()`（各 store 自己登记，见那个文件）。
   * 清它**永远不动账号**（账号在 emby.db）—— 缓存出问题就删掉重建，这是当初分库的理由之一。
   */
  const cacheView = () => {
    const c = cachedb.cfg();
    const all = cachedb.statsAll();
    const t = ((all.tmdb || {}).tables) || {};
    const img = ((all.image || {}).tables) || {};
    const det = ((all.detail || {}).tables) || {};
    const one = (tbl, fallback) => Object.assign({ rows: 0, bytes: 0 }, tbl || fallback);
    const tmdbTbl = one(t.tmdb_cache);
    const nameTbl = one(t.name_index);
    const imgTbl = one(img.image_index);
    const detTbl = one(det.detail_cache);
    return {
      /* 四组数字一一对应 UI 上那四行；`maxBytes`/`ttl*` 是**当前策略**（面板设置里可改） */
      tmdb: {
        rows: tmdbTbl.rows,
        bytes: tmdbTbl.bytes,
        maxBytes: c.tmdbMaxBytes,
        ttlDays: c.tmdbTtlMs / 86400000,
        path: (all.tmdb || {}).path || '',
      },
      names: {
        rows: nameTbl.rows,
        bytes: nameTbl.bytes,
        maxBytes: cachedb.NAME_MAX_BYTES,
        ttlHours: cachedb.NAME_TTL_MS / 3600000,
      },
      image: {
        rows: imgTbl.rows,
        bytes: imgTbl.bytes,
        maxBytes: c.imageMaxBytes,
        ttlDays: c.imageTtlMs / 86400000,
        path: (all.image || {}).path || '',
      },
      detail: {
        rows: detTbl.rows,
        bytes: detTbl.bytes,
        maxBytes: c.detailMaxBytes,
        /* 「长期有效」时 ttlMs 是个很远的数 —— 如实报出去，由 UI 决定怎么显示 */
        ttlMs: c.detailTtlMs,
        ttlForever: !!(((settings.read('panel') || {}).cache || {}).detailNeverExpire),
        path: (all.detail || {}).path || '',
      },
    };
  };

  r.add('GET', '/api/panel/cache', (req, res) => sendJson(res, 200, cacheView()));

  r.add('DELETE', '/api/panel/cache', (req, res) => {
    cachedb.clearAll();
    console.log('  ✔ 缓存已清空（tmdb.db 元数据+名字索引、detail.db 聚合详情、cache.db 图片索引；账号不受影响）');
    return sendJson(res, 200, cacheView());
  });

  /* ---- 版本与更新（见 docs/adr/0019-self-update-from-release.md）----
   * GET  查版本（带 60 秒缓存；失败把原因放在 error 里，不抛）
   * POST 安装某个版本并请求监督者重启（`{"version":"1.1.0"}`，省略则装最新）
   * 只有受引导脚本托管时才允许安装：否则换掉代码也没人把新版本拉起来。
   */
  r.add('GET', '/api/panel/update', async (req, res, { query }) =>
    sendJson(res, 200, await update.status({ force: query.get('force') === '1' }))
  );

  r.add('POST', '/api/panel/update', async (req, res) => {
    if (!update.isManaged()) {
      return sendError(
        res,
        400,
        '当前不是由容器引导脚本托管的运行方式，面板无法自更新（直接跑源码时请自行更新并重启）'
      );
    }
    const body = await readBody(req);
    let version = String((body && body.version) || '').trim().replace(/^v/, '');
    try {
      if (!version) version = await update.resolveLatest({ force: true });
      const r0 = await update.install(version);
      update.requestRestart(version);
      console.log(`  ↻ 面板更新：已安装 ${r0.version}，即将重启到该版本`);
      return sendJson(res, 200, { ok: true, installed: r0.version, downloaded: r0.downloaded, restarting: true });
    } catch (e) {
      const msg = (e && e.message) || String(e);
      console.log(`  ✘ 面板更新失败：${msg}`);
      return sendError(res, 400, msg);
    }
  });

  /* ---------------- 面板日志（内存环形缓冲，见 core/logbus.js）----------------
   * 给「面板设置 → 日志」页看。**纯内存**：重启清空，长期留档看 `docker logs`。
   * ⚠️ 这两条**自己不打任何日志** —— 日志页每 2 秒轮询一次，打了会把日志量放大。 */
  r.add('GET', '/api/logs', (req, res, { query }) =>
    sendJson(res, 200, logbus.list({ since: query.get('since'), limit: query.get('limit') }))
  );

  r.add('DELETE', '/api/logs', (req, res) => {
    logbus.clear();
    return sendJson(res, 200, { ok: true });
  });

  /* ---------------- 兼容层（前端迁移完成后删除） ---------------- */
  r.add('GET', '/api/settings', (req, res) => {
    const view = legacyAggView();
    return sendJson(res, 200, {
      settings: view,
      base: require('../source/service').resolve(),
    });
  });

  r.add('PUT', '/api/settings', async (req, res) => {
    const body = (await readBody(req)) || {};
    const patch = {};
    if (body.baseUrl !== undefined) patch.upstream = { source: catpaw.normSourceUrl(body.baseUrl) };
    if (body.agg && typeof body.agg === 'object') Object.assign(patch, body.agg);
    const next = settings.patch('agg', patch);
    return sendJson(res, 200, {
      settings: Object.assign(legacyAggView(), {
        baseUrl: (next.upstream && next.upstream.source) || '',
      }),
      base: require('../source/service').resolve(),
    });
  });
};
