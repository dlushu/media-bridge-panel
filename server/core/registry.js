'use strict';
/**
 * 模块注册表：core 与 server.js 只认识这张表，不认识任何模块实现
 *
 * 每个模块导出：
 *   { id, label, apiPrefix, upstream, settings, routes }
 *    - apiPrefix  自己对外暴露的路径前缀（文档/总览用）
 *    - upstream   本模块基于哪个模块（消费它的地址），null = 不依赖别人
 *    - settings   { defaults, validate }，由 core/settings 托管
 *    - routes(r)  登记自己的路由
 */
const modules = new Map();

function register(mod) {
  if (!mod || !mod.id) throw new Error('模块缺少 id');
  if (modules.has(mod.id)) throw new Error('模块重复注册：' + mod.id);
  modules.set(mod.id, mod);
  return mod;
}

function get(id) {
  return modules.get(id) || null;
}

function list() {
  return Array.from(modules.values());
}

/** 面板层「模块与 URL 总览」：每个模块自述 + 它当前配置的上游地址 */
function describe(readSettings) {
  return list().map((m) => {
    const s = readSettings ? readSettings(m.id) : {};
    return {
      id: m.id,
      label: m.label || m.id,
      apiPrefix: m.apiPrefix || '',
      upstream: m.upstream || null,
      upstreamUrl: (m.upstream && s.upstream && s.upstream[m.upstream]) || '',
    };
  });
}

module.exports = { register, get, list, describe };
