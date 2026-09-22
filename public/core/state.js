'use strict';
/**
 * 全局状态：一个对象装下所有页面共享的东西。
 *
 * 项目规模还小，就没上"状态库"：各页面直接读写 `S.xxx`，改完调 `renderPage()` 重渲染。
 * 拆模块之后这里仍是**唯一**的共享状态出口 —— 页面之间不许用全局变量偷偷传值。
 */
export const S = {
  settings: null,
  base: null,
  run: null,
  probe: null,
  aggSources: null,     // 聚合源清单（多源：本地部署源 + 自定义源；探测结果也补在这一份里）
  aggSites: [],         // 聚合源们的站点（每项带 source/sourceName）
  aggLoadedFor: null,   // 上面两个的缓存指纹（源集合变了才重拉）
  siteFilter: '',
  sources: [],          // 本地托管的源（可选便利项）
  page: 'source-bundle', // 当前页；启动时若地址栏有 #/模块/页 会被它覆盖（见 shell.applyHash）

  lastPage: {},
  aggKeyword: '',
  aggPage: '1',
  aggUseAll: false,
  aggResult: null,
  aggView: 'merged',
  aggBusy: false,
  apiError: null,
  busy: false,
  emby: { settings: null, accounts: null, homePlugins: null, homeRun: {} },
  panel: { settings: null, tmdbTest: null },
};
