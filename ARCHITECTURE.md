# 架构

本项目把多个数据源（当前为猫爪 / CatPawOpen 源）聚合成一份可直接交给播放客户端的媒体源。
本文说明分层、依赖方向、目录结构与模块边界；设计取舍的理由记录在
[docs/adr/](docs/adr/)。

## 分层与依赖方向

```
source（数据源层）  ←  agg（聚合层）  ←  emby（消费层）
        ▲
   panel（宿主层）：不参与数据链，只负责面板自身与模块注册
```

三条规则：

1. **依赖单向**：只允许 `emby → agg → source` 方向，不得反向。详见 [ADR-0001](docs/adr/0001-module-layering.md)。
2. **跨模块数据流走地址 + HTTP**：模块之间不互相 `require` 业务逻辑。每个模块在自己的设置中记录
   所消费的上游地址 `upstream.<模块id>`，该地址可以指向外部实现（例如把 `agg.json` 的 `sources[]`
   指向另一台机器上的源）。
3. **唯一的向下 `require`**：解析上游地址时读本地进程状态（本地运行中源的端口），
   即 `agg/routes.js → ../source/service.resolve()`。其余跨模块调用一律走 `/api/**`。

### 例外：emby 层进程内直调聚合层

`emby` 层的聚合地址固定为本面板自身（两层同进程），且**不通过 HTTP 自调用**，而是
`require('../agg/api')` 直接调用。原因是面板门禁对 `/api/` 前缀一律要求登录，而进程内自调用不带
cookie，会得到 `401`。`/api/agg/detail` 与 `/api/agg/play` 两个端点保留给前端与外部使用，
与 emby 层共用同一套编排（`agg/api.js`），两条路径不会分叉。详见
[ADR-0002](docs/adr/0002-in-process-emby-to-agg.md)。

其余跨模块调用（`agg → source`、面板 → 外部聚合源）仍走地址 + HTTP，那些地址可以位于其他机器。

## 目录结构

```
server.js                 入口：注册模块 → 搬迁旧设置 → 起服务 → 优雅关闭
server/core/              基础设施，不认识任何业务
  paths.js                路径集中定义（DATA_DIR 可由环境变量覆盖）
  branding.js             产品名的唯一来源（name / panelName / embyServerName / slug / ua）
  http.js                 sendJson / sendError / readBody / readRawBody / serveStatic
  router.js               注册式路由表：add(method, pattern, handler)，支持 :param 与 * 通配
  settings.js             模块设置：defaults 合并 → validate → 原子写；旧格式搬迁
  upstream.js             上游客户端与转发；configuredUrl(消费方, 提供方)
  registry.js             模块注册表与总览自述
  logbus.js               日志总线：包装 console，透传 stdout 的同时在内存里留一份环形缓冲（面板「日志」页）
  auth.js                 面板门禁：单密码 + 会话签名
  catpaw.js               猫爪源协议层：地址归一化 / config 摊平 / 探测 / 片名归一化
  tmdb.js                 TMDB 协议层与响应缓存（emby 层取元数据、面板层做连通性测试共用）
  cachedb.js              缓存通用设施：createStore（一库一句柄）+ TTL + 按字节 LRU + 统计/清空
server/modules/
  source/                 9 文件   /api/sources* /api/run* /api/base* /website*
    index.js              模块清单（含开机自启、停止全部、自动更新计时）
    routes.js             全部路由
    auto-update.js        按间隔检查源的新版本：探 md5 → 下载 → 校验 → 必要时重启
    service.js            「当前托管源」解析（自定义源 → 本地运行中的源）
    runner.js             源子进程托管（启动/停止/重启/状态）
    fetcher.js            源包下载与校验（两道 md5）
    store.js              本地源清单
    config-proxy.js       源配置中心的同源代理
    host-boot.js          启动时恢复本地源
  agg/                    8 文件   /api/agg/*
    index.js              模块清单（含测速任务的开机 / 设置变更两个钩子）
    routes.js             路由
    settings.js           聚合设置（源清单、站点勾选与顺序、超时/并发、测速开关、打分参数、线路过滤）
    service.js            搜索 / 详情 / 播放的编排（站源协议解析都在这一层）
    match.js              片名清洗与打分（挑片判据的唯一实现）
    site-stats.js         站点统计：测速结果（speed）+ 顺手记账（call），**每站每类只留最近一次**
    site-test.js          站点测速任务：每 6 小时自动一轮 / 手动 / 源起来后测它的站点
    api.js                进程内调用面：loadSites / detail / play / probeSearch
  emby/                   7 文件   /api/emby/**
    index.js              模块清单
    routes.js             端点注册（已实现端点与面板自用端点必须注册在 501 通配之前）
    service.js            各端点业务与公共函数；详情/播放走 agg/api.js
    tmdb.js               emby 专有的 TMDB 层：反查、条目 Id 派生与解析、图片基地址拼装
    cache.js              图片索引缓存（独立 SQLite）
    db.js                 Emby 客户端账号库（内置 sqlite）
    log.js                请求日志（每请求一行，带 query 摘要与客户端标记）
    home/                 首页插件宿主（面板自用，不属于 Emby 客户端协议）
      manifest.js         规范：常量与清单/参数校验（宿主与沙箱共用）
      sandbox.js          被 spawn 的沙箱子进程（vm 上下文 + Catpaw shim，无盘无网）
      spawn.js            宿主侧：按权限模型起子进程、代做 http/tmdb/storage/log、超时终止
      store.js            插件落盘：registry.json / 插件源码 / storage.json
      index.js            安装、更新、删除、按行调度、缓存与单飞
      routes.js           /api/emby/home/** 端点
      example.plugin.js   参考插件（面板可下载）
      plugin-dev.skill.md 插件开发说明（面板可下载）
  panel/                  3 文件   /api/meta /api/modules /api/modules/:id/settings /api/panel/*
    index.js  routes.js  backup.js
public/                   前端（原生 ES module，无构建步骤）
  index.html  app.js  style.css
  app.js                  仅引导：登记各页渲染函数后启动
  core/                   dom / api / auth / state / store / registry / shell / boot / branding
  modules/agg/            host（源列表）· sites（站点与参数）· params（聚合参数）· search（聚合搜索）
  modules/source/         host（猫源地址）· config（配置中心）
  modules/emby/           setup（连接设置）· home（首页插件）
  modules/panel/          overview（概览）· settings（设置）· logs（日志）
docs/                     开发者文档（见 docs/index.md）
  adr/                    设计决策记录
tools/                    check-syntax.js（语法检查）· check-style.js（文档与注释文风检查）
data/                     运行时数据（已 .gitignore，含凭证与密码哈希）
```

## 模块清单

| id | 层 | 对外前缀 | 消费的上游 | 状态 |
|---|---|---|---|---|
| `source` | 数据源层 | `/api/sources`、`/api/run`、`/api/base`、`/website*` | — | 可用 |
| `agg` | 聚合层 | `/api/agg` | `upstream.source` | 可用 |
| `emby` | 消费层 | `/api/emby` | 聚合层，进程内直调（见上文） | 握手、登录（多账号，存内置 sqlite）、媒体库、条目列表与详情、搜索、图片、相似推荐、播放跳转已实现；未实现的端点按 [emby-compat.md](docs/emby-compat.md) 逐个补齐；另有首页插件宿主（[emby-home-plugin.md](docs/emby-home-plugin.md)） |
| `panel` | 宿主层 | `/api/panel`、`/api/modules`、`/api/meta` | — | 可用（含配置备份与恢复） |

## 模块设置：一个模块一份文件

```
data/settings/source.json   { port, host, autostart }            新建托管源时的默认值
                            { autoUpdate, autoUpdateHours }      源自动更新
data/settings/agg.json      { sources: [{ id, url, name, enabled }]   自定义源（外部地址）
                              enabled: [{ source, key }]              站点勾选
                              order:   [{ source, key }]              站点顺序
                              timeoutSec, detailTimeoutSec, concurrency     单站超时 / 取详情超时（秒）
                              speedTestAuto, speedTestHours          站点测速（默认开 · 6 小时）
                              matchMinScore, matchMaxItems, matchExtraK, matchExtraAll
                              lineFilter }
data/settings/emby.json     { serverName, imageKey, serverId,
                              upstream: { agg: "" } }
                            account 字段已废弃（账号在 sqlite 中）
data/settings/panel.json    { host, port, modules, tmdb: { token, apiBase, imageBase, language },
                              cache: { … } }
data/emby/emby.db           Emby 客户端账号（内置 sqlite，密码只存 scrypt 哈希）
```

- 默认值、校验与表单字段由**模块自己声明**（`server/modules/<id>/settings.js` 的
  `defaults` / `validate` / `fields`），`core` 不认识任何具体键。
- 通用端点读写：`GET/PUT/DELETE /api/modules/<id>/settings`。`PUT` 为局部深合并，校验不通过返回 `400`。
- 旧格式自动搬迁：早期的单文件 `data/settings.json`（`{ baseUrl, agg: {...} }`）会拆分为
  `settings/agg.json`（`baseUrl → upstream.source`），原文件改名为 `settings.json.migrated` 留档。

## 数据流

**客户端播放链路**

```
Emby 客户端 → /api/emby/**（emby 层，token 校验）
           → agg/api.js（进程内）→ 聚合层搜索与打分 → 源 HTTP → 源
```

**面板搜索链路**

```
浏览器 → /api/agg/search（聚合层，面板门禁）→ 源 HTTP → 源
```

两条链路共用 `agg/service.js` 与 `agg/match.js`，因此「面板里看到的」与「客户端拿到的」是同一套判据。
