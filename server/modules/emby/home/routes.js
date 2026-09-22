'use strict';
/**
 * 首页插件 · 面板自用端点
 *
 *   GET    /api/emby/home/plugins                     插件列表
 *   GET    /api/emby/home/plugins/:id                 单插件详情
 *   POST   /api/emby/home/plugins?filename=&overwrite=1   上传（body = 纯文本 JS）
 *   PUT    /api/emby/home/plugins/:id                 改 enabled / name / params
 *   DELETE /api/emby/home/plugins/:id                 删除（含目录）
 *   POST   /api/emby/home/plugins/:id/rows/:rowId/run 执行一行（面板预览）
 *   GET    /api/emby/home/example                     参考插件源码（text/plain）
 *   GET    /api/emby/home/skill                       插件开发文档（text/markdown，带下载文件名）
 *
 * ⚠️ 与 /api/emby/accounts 一样，这些**不是 Emby 客户端协议**：豁免 AccessToken，
 *    但**必须注册在 `ANY /api/emby/*rest` 通配之前**，否则会被 501 吞掉。
 *    （挂载点在 emby/routes.js 的面板自用段，见那里的 require('./home/routes')(r)。）
 *
 * 上传走**裸 body**（`Content-Type: text/javascript`）而不是 multipart：
 * 项目零依赖、core/http 没有 multipart 解析，前端用 FileReader 读文本 + fetch 直发最省事。
 *
 * 执行失败一律 **HTTP 200 + `{ok:false,error}`**（与 /api/panel/tmdb/test 同取向，前端才能看到细节）；
 * 只有「调用方搞错了」（插件/行不存在、清单非法）才用 4xx/5xx。
 */
const { sendJson, sendError, readBody, readRawBody } = require('../../../core/http');
const home = require('./index');
const store = require('./store');

/** 明确的 400（其余未知错误按 500 —— 不把服务端故障伪装成"参数错误"） */
const CODE_400 = new Set(['BAD_MANIFEST', 'SYNTAX', 'EMPTY', 'BAD_INPUT', 'BAD_RESULT', 'LOAD_TIMEOUT', 'BAD_URL']);

function statusOf(e) {
  const c = e && e.code;
  if (c === 'EXISTS' || c === 'RESERVED') return 409;
  if (c === 'TOO_LARGE') return 413;
  if (c === 'NOT_FOUND') return 404;
  if (c === 'BUILTIN') return 403; // 存在、但这类操作不允许（内置示例不可删）
  if (CODE_400.has(c)) return 400;
  return 500;
}

function fail(res, req, what, e) {
  const status = statusOf(e);
  const body = { error: (e && e.message) || String(e), code: e && e.code };
  if (e && e.existing) body.existing = e.existing;
  console.log(`  ✘ emby 首页插件 ${what} → HTTP ${status} ${body.error}`);
  return sendJson(res, status, body);
}

module.exports = function routes(r) {
  r.add('GET', '/api/emby/home/plugins', (req, res) => {
    const plugins = home.listPlugins();
    console.log(`  ✔ emby 首页插件 列表 → HTTP 200 ${plugins.length} 个`);
    return sendJson(res, 200, { plugins });
  });

  /* 注意：这条必须能匹配 `/api/emby/home/plugins`（4 段）之外的 5 段路径；
   * `example` 是 4 段，与它不冲突 */
  r.add('GET', '/api/emby/home/example', (req, res) => {
    let code;
    try {
      code = home.exampleCode();
    } catch (e) {
      return fail(res, req, '示例读取', e);
    }
    console.log('  ✔ emby 首页插件 示例源码 → HTTP 200');
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(code);
  });

  /**
   * GET /api/emby/home/skill —— 插件开发文档（面板「下载开发文档」）
   *
   * 与 `/example` 同一形态：**随包文件直接发出去**，不做加工。给它 `Content-Disposition`
   * 是因为这份是给人**下载收藏**的（丢进 skills 目录），而示例那份要在浏览器里直接看。
   */
  r.add('GET', '/api/emby/home/skill', (req, res) => {
    let doc;
    try {
      doc = home.skillDoc();
    } catch (e) {
      return fail(res, req, '开发文档读取', e);
    }
    console.log('  ✔ emby 首页插件 开发文档 → HTTP 200');
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': 'attachment; filename="catpaw-home-plugin.skill.md"',
      'Cache-Control': 'no-store',
    });
    return res.end(doc);
  });

  r.add('POST', '/api/emby/home/plugins', async (req, res, { query }) => {
    const limit = store.MAX_CODE_BYTES;
    if (Number(req.headers['content-length'] || 0) > limit) {
      return sendError(res, 413, `插件源码超过上限 ${limit} 字节（1MB）`);
    }
    let code;
    try {
      code = (await readRawBody(req, limit)).toString('utf8');
    } catch (e) {
      const tooBig = /过大/.test(String((e && e.message) || ''));
      return sendError(res, tooBig ? 413 : 400, tooBig ? `插件源码超过上限 ${limit} 字节（1MB）` : String((e && e.message) || e));
    }

    let out;
    try {
      /* install 会把代码交给沙箱子进程校验，所以是 async */
      out = await home.install({
        code,
        fileName: query.get('filename'),
        overwrite: query.get('overwrite') === '1',
      });
    } catch (e) {
      return fail(res, req, `上传 ${query.get('filename') || ''}`.trim(), e);
    }

    const how = out.unchanged ? '内容未变，跳过' : out.created ? '新增' : '覆盖更新';
    console.log(`  ✔ emby 首页插件 上传 ${out.plugin.id} v${out.plugin.version} → HTTP 200（${how}，${out.plugin.rows.length} 行）`);
    return sendJson(res, 200, out);
  });

  r.add('GET', '/api/emby/home/plugins/:id', (req, res, { params }) => {
    const p = home.getPlugin(params.id);
    if (!p) return sendJson(res, 404, { error: '插件不存在：' + params.id });
    console.log(`  ✔ emby 首页插件 详情 ${params.id} → HTTP 200`);
    return sendJson(res, 200, { plugin: p });
  });

  r.add('PUT', '/api/emby/home/plugins/:id', async (req, res, { params }) => {
    const body = (await readBody(req)) || {};
    let p;
    try {
      p = home.updatePlugin(params.id, {
        enabled: body.enabled,
        name: body.name,
        params: body.params,
      });
    } catch (e) {
      return fail(res, req, `更新 ${params.id}`, e);
    }
    const changed = [
      body.enabled !== undefined ? `enabled=${p.enabled}` : '',
      body.name !== undefined ? `name=${p.name}` : '',
      body.params !== undefined ? 'params' : '',
    ]
      .filter(Boolean)
      .join(' ');
    console.log(`  ✔ emby 首页插件 更新 ${params.id} → HTTP 200 ${changed}`);
    return sendJson(res, 200, { plugin: p });
  });

  r.add('DELETE', '/api/emby/home/plugins/:id', (req, res, { params }) => {
    /* 内置示例会**抛**（BUILTIN → 403），不走"删不到就是 404"那条路 —— 两者含义不同：
     * 404 = 这插件不存在；403 = 存在，但它是随面板发行的内置示例，不能删。 */
    let removed;
    try {
      removed = home.removePlugin(params.id);
    } catch (e) {
      return fail(res, req, `删除 ${params.id}`, e);
    }
    if (!removed) {
      console.log(`  ✘ emby 首页插件 删除 ${params.id} → HTTP 404`);
      return sendJson(res, 404, { error: '插件不存在：' + params.id });
    }
    console.log(`  ✔ emby 首页插件 删除 ${params.id} → HTTP 200，剩余 ${home.listPlugins().length} 个`);
    return sendJson(res, 200, { ok: true, remaining: home.listPlugins().length });
  });

  r.add('POST', '/api/emby/home/plugins/:id/rows/:rowId/run', async (req, res, { params }) => {
    const body = (await readBody(req).catch(() => ({}))) || {};
    let out;
    try {
      out = await home.runRow(params.id, params.rowId, body.params);
    } catch (e) {
      return fail(res, req, `执行 ${params.id}/${params.rowId}`, e);
    }
    const mark = out.ok ? '✔' : '✘';
    const detail = out.ok
      ? `条目=${out.items.length}${out.dropped ? ` 丢弃=${out.dropped}` : ''}${out.dup ? ` 重复=${out.dup}` : ''}`
      : `${out.error.code} ${out.error.message}`;
    console.log(
      `  ${mark} emby 首页插件 执行 ${params.id}/${params.rowId} → HTTP 200 ` +
        `${detail} cached=${out.cached}${out.shared ? ' shared' : ''} ${out.ms}ms`
    );
    return sendJson(res, 200, out);
  });
};
