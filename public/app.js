'use strict';
/* 媒体桥面板（前端入口）
 *
 * 核心模型：
 *   1) 全局只有一个「猫爪源地址」（baseUrl）作为运行基础 —— 可以是任意已在运行的猫爪源服务
 *   2) 面板把所有请求代理到该地址（/config、/check、/spider/**）
 *   3) 站点可逐个勾选「参与聚合」，之后一个请求就能并发搜索多个站点并把结果拼接汇总（不去重）
 *   4) 聚合源**可多个**（见 core/state.js 的 aggSources / aggSites）
 *
 * 结构（详细见 README「目录」）：
 *   core/      通用件与外壳
 *     dom       选择器 · 建节点 · 提示 · 复制 · 代码块
 *     api       请求封装（非 2xx 抛错）
 *     state     全局状态 S（页面间唯一共享出口）
 *     store     面板级共享数据：站点 / 聚合源 / 聚合设置
 *     registry  导航结构与页渲染器登记表
 *     shell     顶栏 · 子标签 · 页面分发 · 地址栏同步（#/模块/页，刷新不掉页）
 *     boot      启动 · 全局数据加载 · 轮询
 *     docs      结构化接口文档渲染器
 *   modules/<id>/  各模块的页（agg / source / emby / export）
 *
 * 分层规则：`modules/<id>/` 只许 import `core/*`，**模块之间不许互相 import**
 * —— 谁要动别人的数据就调 core/store，正好对上后端 source → agg → emby 的单向分层。
 *
 * 本文件只剩引导：把各页登记进注册表，然后启动。
 */
import { registerPages } from './core/registry.js';
import { paintBrand } from './core/branding.js';
import { init } from './core/boot.js';

import { renderSourceBundle } from './modules/source/host.js';
import { renderWebsite } from './modules/source/config.js';
import { renderAggHost } from './modules/agg/host.js';
import { renderSites } from './modules/agg/sites.js';
import { renderAggParams } from './modules/agg/params.js';
import { renderAgg } from './modules/agg/search.js';
import { renderEmbySetup } from './modules/emby/setup.js';
import { renderEmbyHome } from './modules/emby/home.js';
import { renderPanelOverview } from './modules/panel/overview.js';
import { renderPanelSettings } from './modules/panel/settings.js';
import { renderPanelLogs } from './modules/panel/logs.js';

/* 页渲染函数登记（必须在 init() 之前跑完） */
registerPages({
  'source-bundle': renderSourceBundle,
  website: { render: renderWebsite, nopad: true },
  'agg-host': renderAggHost,
  'agg-sites': renderSites,
  'agg-params': renderAggParams,
  'agg-search': renderAgg,
  'emby-setup': renderEmbySetup,
  'emby-home': renderEmbyHome,
  panel: renderPanelOverview,
  'panel-settings': renderPanelSettings,
  'panel-logs': renderPanelLogs,
});

/* 顶栏品牌与网页标题（读 core/branding.js —— 改名只改那一处；index.html 里那份只是首屏兜底） */
paintBrand();

init();
