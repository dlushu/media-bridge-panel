'use strict';
/**
 * 聚合层模块
 *
 *   对外：/api/agg/*
 *   依赖：source（读它解析出的猫源地址；地址由本模块设置里的 upstream.source 决定，可外部）
 */
const routes = require('./routes');
const settingsSpec = require('./settings');

module.exports = {
  id: 'agg',
  label: '聚合设置',
  apiPrefix: ['/api/agg'],
  upstream: 'source',

  settings: settingsSpec,
  routes,
};
