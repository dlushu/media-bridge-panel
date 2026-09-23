'use strict';
/**
 * 聚合层模块
 *
 *   对外：/api/agg/*
 *   依赖：source（读它解析出的猫源地址；地址由本模块设置里的 upstream.source 决定，可外部）
 *
 * 另外它还养着一个**后台任务**：站点测速（`./site-test.js`，每 6 小时自动一轮、
 * 手动可开、源起来后自动测一轮）。开机与设置变更各有一个钩子给 `server.js` 与 `core/settings` 调。
 */
const routes = require('./routes');
const settingsSpec = require('./settings');
const siteTest = require('./site-test');

module.exports = {
  id: 'agg',
  label: '聚合设置',
  apiPrefix: ['/api/agg'],
  upstream: 'source',

  settings: settingsSpec,
  routes,

  /** 设置保存后按新配置重排测速定时器（见 site-test.js 的 apply） */
  onSettingsChange: () => siteTest.apply(),

  /** 开机启动自动测速的计时（server.js 在面板起来后调一次；默认就是开） */
  startSiteTest: () => siteTest.boot(),

  /**
   * 某个源起来了 → 立刻测一轮它的站点（server.js 把 source 层的 `onSourceReady` 接到这里）。
   * ⚠️ **连线放在 server.js**：source 是最底层（`upstream: null`），不能反过来 require agg。
   */
  siteTestSourceUp: (id) => siteTest.sourceUp(id),
};
