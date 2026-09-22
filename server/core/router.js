'use strict';
/**
 * 极简路由表：模块自己登记端点，server.js 不再写 if 链
 *
 *   add('GET',  '/api/settings', handler)
 *   add('ANY',  '/api/base/upstream', handler)
 *   add('GET',  '/api/sources/:id', handler)
 *   add('ANY',  '/website/*rest', handler)     // 通配剩余路径
 *
 * handler(req, res, ctx)；ctx = { params, query, pathname }
 */
const { sendError } = require('./http');

const routes = [];

function add(method, pattern, handler) {
  if (typeof handler !== 'function') throw new Error('路由缺少 handler：' + pattern);
  routes.push({
    method: String(method || 'ANY').toUpperCase(),
    segs: String(pattern).split('/').filter(Boolean),
    handler,
  });
}

/** 路径匹配：支持 :param 与末尾 *wildcard */
function match(patternSegs, reqSegs) {
  const params = {};
  for (let i = 0; i < patternSegs.length; i++) {
    const p = patternSegs[i];
    if (p.startsWith('*')) {
      params[p.slice(1) || 'rest'] = reqSegs.slice(i).map(decodeURIComponent).join('/');
      return params;
    }
    if (i >= reqSegs.length) return null;
    if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(reqSegs[i]);
    else if (p !== reqSegs[i]) return null;
  }
  return patternSegs.length === reqSegs.length ? params : null;
}

async function handle(req, res, { pathname, searchParams }) {
  const reqSegs = pathname.split('/').filter(Boolean);
  let pathMatched = false;
  for (const r of routes) {
    const params = match(r.segs, reqSegs);
    if (!params) continue;
    pathMatched = true;
    if (r.method !== 'ANY' && r.method !== req.method) continue;
    return r.handler(req, res, { params, query: searchParams, pathname });
  }
  if (pathMatched) return sendError(res, 405, '不支持的方法');
  return sendError(res, 404, '接口不存在');
}

function list() {
  return routes.map((r) => ({ method: r.method, path: '/' + r.segs.join('/') }));
}

module.exports = { add, handle, list };
