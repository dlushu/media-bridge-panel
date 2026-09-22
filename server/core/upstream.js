'use strict';
/**
 * 上游客户端与转发：源服务、外部模块、配置中心代理都走这里
 *
 * 模块之间不互相 require，只通过「地址 + HTTP」连接：
 *   地址来自消费方模块自己的设置  upstream.<providerId>（可填外部自定义地址）
 *
 * ⚠️ **一处例外**：`emby → agg` 是进程内直调（`require('../agg/api')`），不过这里 ——
 * 聚合地址固定是本面板自己（两层同进程），而走 HTTP 那条自调用不带面板 cookie，
 * 会被门禁（`core/auth.js` 的 needsAuth）挡成 401。理由写在 `agg/api.js` 顶部。
 */
const { readBody, readRawBody, sendBuffer } = require('./http');
const settings = require('./settings');

/**
 * 对外出网时的**自称**（`User-Agent`）—— **模拟 Emby 服务端**。
 *
 * 与本项目**对客户端的自称保持一致**：`System/Info/Public` 回的就是
 * `ProductName: "Emby Server"` + `Version: "4.8.0.0"`（见 `modules/emby/service.js` 的 `EMBY_VERSION`）。
 * 对外（TMDB / 聚合层）用同一副面孔，避免一边自称 Emby、一边以 `node` 裸奔。
 *
 * ⚠️ **如实说明**：这个串是**按惯例取的**，不是从真机 Emby 抓来的 ——
 * 真实 Emby 服务端是 .NET `HttpClient`，默认**不带** `User-Agent`，无从抓取它调 TMDB 时发的是什么。
 * 所以不要把它当成"和真机一模一样"。要改就改这一处（调用方自己传了 UA 则以调用方为准）。
 *
 * 为什么要设：不设的话 Node 内置 fetch 会发 `user-agent: node` —— 那是**零信息量**的默认值，
 * 一旦被限流或需要排查，对面无法识别调用方。客户端那侧同理，需靠客户端标记
 * （现 `emby/log.js` 的 `clientTag`）才能分清谁是谁。
 */
const UA = 'Emby/4.8.0.0';

/** headers 里是否已经有 User-Agent（大小写不敏感）—— 有就不覆盖调用方的 */
function hasUA(headers) {
  return Object.keys(headers || {}).some((k) => k.toLowerCase() === 'user-agent');
}

/** 通用 HTTP 客户端：string/Buffer 原样透传，对象 JSON 序列化 */
async function request(baseUrl, p, { method = 'GET', body = null, timeout = 30000, headers = {} } = {}) {
  if (!baseUrl) throw new Error('尚未设置上游地址');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const sendBody = body !== null && body !== undefined && method !== 'GET' && method !== 'HEAD';
    const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    /* 先铺自称，再盖调用方的头 —— 调用方**显式**给了 `User-Agent` 就尊重它。
     * ⚠️ 必须用 `hasUA` 判断：headers 是普通对象，调用方写 `user-agent`（小写）时
     * `Object.assign({'User-Agent':…}, headers)` 会留下**两个键**，HTTP 头就重复发了。 */
    const h = hasUA(headers) ? Object.assign({}, headers) : Object.assign({ 'User-Agent': UA }, headers);
    const res = await fetch(baseUrl + p, {
      method,
      headers: sendBody ? Object.assign({ 'Content-Type': 'application/json' }, h) : h,
      body: sendBody ? payload : undefined,
      signal: ctrl.signal,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* 非 JSON（图片/视频流/HTML） */
    }
    return { status: res.status, ok: res.ok, text, json, buf, contentType: res.headers.get('content-type') || '' };
  } finally {
    clearTimeout(timer);
  }
}

/** 把进来的请求原样转发到上游并回写响应（二进制安全） */
async function forward(req, res, baseUrl, target, { timeout = 120000, raw = false } = {}) {
  let body = null;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      body = raw ? await readRawBody(req) : await readBody(req);
    } catch {
      body = null; // 非 JSON body：按无 body 转发（与原行为一致）
    }
  }
  const r = await request(baseUrl, target, {
    method: req.method,
    body,
    timeout,
    headers: raw ? { 'Content-Type': req.headers['content-type'] || 'application/json' } : {},
  });
  sendBuffer(res, r.status, r.buf, r.contentType);
  return r;
}

/** 消费方模块配置的「本模块基于谁」的地址（空 = 用本地实现/自动解析） */
function configuredUrl(consumerId, providerId) {
  const s = settings.read(consumerId) || {};
  return (s.upstream && s.upstream[providerId]) || '';
}

module.exports = { request, forward, configuredUrl, UA };
