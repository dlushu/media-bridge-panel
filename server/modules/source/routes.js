'use strict';
/**
 * 猫源层路由
 *   /api/sources*   本地托管源：列表 / 新增 / 详情 / 改参 / 删除 / 更新 / 启停
 *                   /api/sources/auto-update（状态）与 .../run（立即检查）—— 见 auto-update.js
 *   /api/run*       运行中的源：信息、任意转发
 *   /api/base*      托管源（聚合消费的源）：探测、站点列表、任意转发
 *   /website*       配置中心同源代理（iframe 用相对路径加载）—— 实现见 config-proxy.js
 */
const store = require('./store');
const runner = require('./runner');
const fetcher = require('./fetcher');
const autoUpdate = require('./auto-update');
const service = require('./service');
const configProxy = require('./config-proxy');
const settings = require('../../core/settings');
const catpaw = require('../../core/catpaw');
const { sendJson, sendError, readBody } = require('../../core/http');
const { forward } = require('../../core/upstream');

function sourcePaths(src) {
  return Object.assign({}, src, {
    dir: store.sourceDir(src.id),
    runtimeDir: store.runtimeDir(src.id),
  });
}

function requireSource(id) {
  const src = store.get(id);
  if (!src) {
    const err = new Error('源不存在');
    err.code = 404;
    throw err;
  }
  return sourcePaths(src);
}

/** 组装给前端的源对象（含本地文件信息与进程状态） */
function decorate(src, { withStatus = true } = {}) {
  const dir = store.sourceDir(src.id);
  const files = {};
  for (const name of fetcher.ALL_FILES) {
    const info = fetcher.localFileInfo(dir, name);
    if (info) files[name] = info;
  }
  const st = runner.publicState(src.id);
  return Object.assign({}, src, {
    files,
    run: withStatus
      ? st
      : { status: st.status, pid: st.pid, port: st.port, startedAt: st.startedAt, error: st.error },
  });
}

module.exports = function routes(r) {
  /* ---------------------------------------------------------- 本地托管源 */

  r.add('GET', '/api/sources', (req, res) => sendJson(res, 200, { sources: store.list().map((s) => decorate(s)) }));

  r.add('POST', '/api/sources', async (req, res) => {
    const body = await readBody(req);
    const url = fetcher.normalizeBaseUrl(body.url);
    const existing = store.list().find((s) => s.url === url);
    if (existing && !body.force) {
      return sendError(res, 409, `该源已存在：${existing.name || existing.url}（可勾选"强制重新下载"或先删除）`);
    }
    const defs = settings.read('source');
    const src = store.create({
      url,
      name: String(body.name || '').trim() || url.replace(/^https?:\/\//, ''),
      autostart: body.autostart === undefined ? !!defs.autostart : !!body.autostart,
      port: Number(body.port) || Number(defs.port) || 0,
      host: body.host || defs.host || '0.0.0.0',
    });
    try {
      const dl = await fetcher.download(url, store.sourceDir(src.id), { force: true });
      /* 下载后校验不过（缓存残留已被 download 删掉）→ 这个源根本留不下来 */
      if (!dl.ok) {
        store.remove(src.id);
        return sendError(res, 400, dl.error);
      }
      if (!src.name || src.name === url.replace(/^https?:\/\//, '')) store.update(src.id, { name: src.name });
      return sendJson(res, 200, {
        source: decorate(store.get(src.id)),
        download: { changed: dl.changed, md5Mismatch: dl.md5Mismatch },
      });
    } catch (e) {
      store.remove(src.id);
      return sendError(res, 400, e.message);
    }
  });

  /* ---------------- 自动更新 ----------------
   * ⚠️ 这两条**必须注册在 `/api/sources/:id` 之前** —— 路由按注册顺序匹配，
   * 排在后面的话 "auto-update" 会被当成源 id 先被那条吃掉（返回 404 源不存在）。 */
  r.add('GET', '/api/sources/auto-update', (req, res) => sendJson(res, 200, Object.assign({ ok: true }, autoUpdate.state())));

  r.add('POST', '/api/sources/auto-update/run', async (req, res) => {
    const out = await autoUpdate.runNow({ reason: 'manual' });
    /* 撞上定时那一次（还没跑完）→ 409，别让前端以为"检查过了" */
    return sendJson(res, out.busy ? 409 : 200, Object.assign({ ok: out.ok !== false, busy: !!out.busy, error: out.error || null }, autoUpdate.state()));
  });

  r.add('GET', '/api/sources/:id', async (req, res, { params }) => {
    const raw = store.get(params.id);
    if (!raw) return sendError(res, 404, '源不存在');
    const st = await runner.status(params.id);
    return sendJson(res, 200, { source: Object.assign(decorate(raw), { run: st }) });
  });

  r.add('PATCH', '/api/sources/:id', async (req, res, { params }) => {
    if (!store.get(params.id)) return sendError(res, 404, '源不存在');
    const body = await readBody(req);
    const patch = {};
    if (body.name !== undefined) patch.name = String(body.name).trim();
    if (body.port !== undefined) patch.port = Number(body.port) || 0;
    if (body.host !== undefined) patch.host = String(body.host);
    if (body.autostart !== undefined) patch.autostart = !!body.autostart;
    return sendJson(res, 200, { source: decorate(store.update(params.id, patch)) });
  });

  r.add('DELETE', '/api/sources/:id', async (req, res, { params }) => {
    if (!store.get(params.id)) return sendError(res, 404, '源不存在');
    const st = runner.publicState(params.id);
    if (st.status === 'running' || st.status === 'starting') await runner.stop(params.id);
    store.remove(params.id);
    return sendJson(res, 200, { ok: true });
  });

  /* ------------------------------------------------- 单个源的动作 */

  r.add('POST', '/api/sources/:id/update', async (req, res, { params }) => {
    const src = requireSource(params.id);
    const body = await readBody(req);
    const localMd5 = fetcher.readLocalMd5(src.dir, 'index.js.md5');
    const dl = await fetcher.download(src.url, src.dir, { force: !!body.force });

    /* 校验不过：残留已删（源文件没了 → 起不来），**不重启**，把原因如实回给前端显示 */
    if (!dl.ok) {
      return sendJson(res, 200, {
        ok: false,
        changed: false,
        md5Mismatch: true,
        error: dl.error,
        removed: dl.removed,
        localMd5,
        source: decorate(store.get(params.id)),
        restarted: false,
      });
    }

    store.update(params.id, {});
    const restarted = runner.publicState(params.id).status === 'running';
    if (restarted) await runner.restart(src, src);
    return sendJson(res, 200, {
      ok: true,
      changed: dl.changed,
      md5Mismatch: false,
      localMd5,
      source: decorate(store.get(params.id)),
      restarted,
    });
  });

  r.add('POST', '/api/sources/:id/start', async (req, res, { params }) => {
    const src = requireSource(params.id);
    const body = await readBody(req);
    const st = await runner.start(src, { port: Number(body.port) || src.port, host: body.host || src.host });
    return sendJson(res, 200, { run: st });
  });

  r.add('POST', '/api/sources/:id/stop', async (req, res, { params }) => {
    requireSource(params.id);
    return sendJson(res, 200, { run: await runner.stop(params.id) });
  });

  r.add('POST', '/api/sources/:id/restart', async (req, res, { params }) => {
    const src = requireSource(params.id);
    const body = await readBody(req);
    const st = await runner.restart(src, { port: Number(body.port) || src.port, host: body.host || src.host });
    return sendJson(res, 200, { run: st });
  });

  r.add('GET', '/api/sources/:id/status', async (req, res, { params }) => {
    requireSource(params.id);
    return sendJson(res, 200, { run: await runner.status(params.id) });
  });

  /* ---------------------------------------------------- 运行中的源 */

  r.add('GET', '/api/run', async (req, res, { query }) => {
    const run = service.resolveRun();
    const out = { run, local: service.resolveLocal() };
    if (query.get('probe') === '1' && run.url) out.probe = await catpaw.probe(run.url);
    return sendJson(res, 200, out);
  });

  r.add('ANY', '/api/run/upstream', async (req, res, { query }) => {
    const run = service.resolveRun();
    if (!run.url) return sendError(res, 400, '还没有运行中的源');
    try {
      await forward(req, res, run.url, String(query.get('p') || '/config'));
    } catch (e) {
      return sendError(res, 502, '转发失败：' + String(e.message || e));
    }
  });

  /* --------------------------------------------- 聚合托管源的代理层 */

  r.add('POST', '/api/base/probe', async (req, res) => {
    const cur = service.resolve();
    const body = await readBody(req);
    const url = catpaw.normSourceUrl(body.url) || cur.url;
    if (!url) return sendError(res, 400, '请先填写猫爪源地址');
    const p = await catpaw.probe(url);
    return sendJson(res, p.ok ? 200 : 400, { probe: p });
  });

  r.add('GET', '/api/base/sites', async (req, res) => {
    const cur = service.resolve();
    if (!cur.url) return sendError(res, 400, '尚未设置猫爪源地址');
    const { config, sites } = await catpaw.fetchSites(cur.url);
    return sendJson(res, 200, { base: cur, config, sites, agg: settings.read('agg') });
  });

  /**
   * 托管源代理 —— **默认打「托管源」**（= 聚合源列表第一条）；带 `?source=<聚合源id>` 就打那一条。
   *
   * 为什么要能指定：站点 key 只在各自源内唯一。多源时"第二个源才有的站"（实测：`nodejs_huban`
   * 只存在于 9280 那台，Lmentor 没有）如果不指定源，就会打到第一条源上 → 源自己回
   * `404 Route POST:/spider/huban/3/detail not found`，看着像面板坏了，实际是打错了机器。
   * 指定了不存在的 id → **404 如实说**（不静默退回托管源 —— 那正是要避免的"打错源"）。
   */
  r.add('ANY', '/api/base/upstream', async (req, res, { query }) => {
    const want = String(query.get('source') || '').trim();
    let target = service.resolve();
    if (want) {
      const picked = service.byId(want);
      if (!picked) return sendError(res, 404, `聚合源列表里没有 id=${want} 的源（可在「聚合设置 → 源列表」核对）`);
      target = picked;
    }
    if (!target.url) return sendError(res, 400, '尚未设置猫爪源地址');
    try {
      await forward(req, res, target.url, String(query.get('p') || '/config'));
    } catch (e) {
      return sendError(res, 502, '转发失败：' + String(e.message || e));
    }
  });

  /* --------------------------------- 配置中心（同源代理 + 兜底） */

  /* ① 约定前缀 `/website*` 走这里；② 面板没人认领的根路径（`/full-config` 那类）走
   * `config-proxy.js` 的 `fallback()`，由 server.js 在静态文件之后调。
   * 两块都用同一份"当前配置中心是哪个源"的判定（存在 cookie 里），细节与理由见那个文件顶部。 */
  r.add('ANY', '/website/*rest', (req, res, ctx) => configProxy.handleWebsite(req, res, ctx));
};
