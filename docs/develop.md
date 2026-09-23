# 开发文档

本文面向修改本项目的开发者，说明对外 API 契约、面板鉴权、数据目录布局、模块扩展方式与实现要点。
安装与使用见 [README.md](../README.md)（用户向，随镜像发布的那一份）。

相关文档：

- 分层、依赖方向与数据流：[ARCHITECTURE.md](../ARCHITECTURE.md)
- Emby 协议对齐：[emby-compat.md](emby-compat.md)
- 首页插件开发：[emby-home-plugin.md](emby-home-plugin.md)
- 设计决策记录：[adr/](adr/)

## 目录

- [API](#api) —— 面板层 / 数据源层 / 聚合层 / 汇总规则与错误语义 / 兼容层
- [面板鉴权](#面板鉴权)
- [数据目录](#数据目录)
- [开发：新增一个模块](#开发新增一个模块)
- [实现要点](#实现要点)
- [注意](#注意)

---

## API

按模块归类。路径中的 `<id>` 是模块 id（`source` / `agg` / `emby` / `panel`）。

### 面板层（panel）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/meta` | 服务自述：`{service:"catpaw-panel", version, node, modules}`；外部可据此确认一个地址是否为本面板 |
| GET | `/api/modules` | 模块总览：每个模块的 `apiPrefix`、`upstream` 与当前 `upstreamUrl` |
| GET/PUT/DELETE | `/api/modules/:id/settings` | 读写/重置某模块的设置（新增模块不需要改动此端点） |
| GET | `/api/panel/info` | 版本、Node、数据目录、模块列表，以及**仓库地址**（`repo` / `repoUrl` —— 面板「设置 → 关于」与 Release 链接用它，唯一来源是 `panel/update.js` 的 `REPO`，`APP_REPO` 可覆盖） |
| GET | `/api/panel/backup` | 导出配置（`settings/*.json` + 源清单；**不含**带 cookie/token 的 `runtime/`） |
| POST | `/api/panel/restore` | 恢复配置（只写模块设置，不改动本机源清单） |
| POST | `/api/panel/tmdb/test` | 测试 TMDB 设置（面板「TMDB 设置 → 测试」）。原先位于 `/api/emby/tmdb/test`，已随配置迁到面板层 |
| GET | `/api/panel/update` | 版本与更新状态：`{managed, current, latest, hasUpdate, repo, source, appRoot, runningDir, installed[], previous, error}`。查最新 Release 有 60 秒缓存，失败把原因写进 `error` 而不抛 |
| POST | `/api/panel/update` | 安装某个版本并请求重启：`{version?}`（省略则装最新）。装完写 `<DATA_DIR>/app/.restart` 并向自身发 `SIGTERM` 走正常关闭流程，由容器引导脚本拉起新版本。`managed:false`（非引导脚本托管）时返回 400 |

### 数据源层（source）

| 方法 | 路径 | 说明 |
|---|---|---|
| — | `/api/sources*` | 本地托管源：列表/新增/详情/改参数/删除/更新/启动/停止/重启/状态（不提供日志） |
| GET | `/api/sources/auto-update` | 自动更新状态：`{enabled, hours, bootDelayMs, running, lastRunAt, lastReason, nextRunAt, results[]}`。⚠️ 该路由注册在 `/api/sources/:id` **之前**，否则 `auto-update` 会被当成源 id |
| POST | `/api/sources/auto-update/run` | **立即检查**一次（不等定时）：逐个源探 md5 → 有新版就下载 + 校验 +（在运行则）重启；返回状态同上并带 `results`。上一次尚未跑完 → **409** |
| GET | `/api/run` | **运行中的源**（本地运行中的源优先，否则退回托管源；`?probe=1` 附带探测） |
| ANY | `/api/run/upstream?p=/spider/xxx/3/search` | 转发到**运行中的源**（配置中心使用）；手工测源端点也用它 |
| POST | `/api/base/probe` | 探测某地址是否为可用的猫爪源（`{url}`，为空则用当前源） |
| GET | `/api/base/sites` | 代理**当前托管源**的 `/config`，摊平成站点数组 + 返回聚合设置（多源聚合请用 `/api/agg/sites`） |
| ANY | `/api/base/upstream?p=…` | 原样转发到托管源（支持 POST body 与二进制） |
| ANY | `/website*` | 源配置中心的**同源代理**（含 `/website/api/**`、二维码 PNG） |
| ANY | 其它任意路径（**兜底**） | 面板路由与 `public/` 中都没有该路径时，转发给**当前配置中心的那个源**（认源靠 cookie `cp_wsrc`，需登录）；没有人在用配置中心 → 404 |

自动更新的默认关闭、间隔与失败处理见 [ADR-0016](adr/0016-source-auto-update-default-off.md)。

### 聚合层（agg）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/agg/sources` | **源清单（不探测）**：本地部署的源（自动，带 `deployed`/`port`/`running`）+ 自定义源，几毫秒返回。「源列表」页先渲染即依赖它 |
| GET | `/api/agg/sites` | **源清单 + 站点清单**：并发拉取每个聚合源的 `/config`，摊平成 `sites[]`（每项带 `source`/`sourceName`）；单源失败只回它自己的 `ok`/`error`。每项的 `stat` 是这个站的统计：`{ probe, call:{search,detail} }`（`probe` = 最近一次测速结果，`call.*` = 最近一次真实业务，见「站点测速」一节） |
| GET | `/api/agg/site-test` | **站点测速状态**（服务端后台任务）：`{enabled, hours, concurrency, timeoutMs, running, done, total, okCount, emptyCount, badCount, stopped, lastRunAt, lastElapsedMs, nextRunAt, pending}` —— 前端据此画"测速中 x/y"与"上次 / 下次"（计数刻意不叫裸名 `ok`/`bad`：响应里那个 `ok` 是"这次调用成功了吗"） |
| POST | `/api/agg/site-test/start` | **开一轮测速**：body 可带 `keys`（`[{source,key}, …]` = 只测这些站；省略 = **全部站点**）；上一次没跑完 → **409** `{busy:true}` |
| POST | `/api/agg/site-test/stop` | **停止当前这一轮**（已测完的那些站的结果照常保留） |
| POST | `/api/agg/site-test/one` | **单站测速**（站点表每行的「测速」按钮）：`{source, key, api?}` → **同步**返回这一发的结果（`search` + `attempts` + `stat`）；不改后台任务的状态、不重排自动测速，只写同一个统计槽 |
| POST | `/api/agg/search` | **聚合搜索（带打分）**：`{wd, page?, year?, season?, episode?, minScore?, maxItems?, timeoutMs?, concurrency?, keys?}` → `{wd, page, elapsedMs, sites, matched, unmatched, match, stats}`；`keys` 是**站点白名单** `[{source,key}, …]`（省略则用 `agg.enabled`）；每条结果带 `score`/`matched`/`matchReason` |
| POST | `/api/agg/detail` | 取详情（内部含搜索）：`{name, year?, season?, episode?, minScore?, maxItems?, extraK?, extraAll?, timeoutMs?, detailTimeoutMs?, keys?, source?+site?+vodId?}` → `{ok:true, sites, picked, stats, sources, elapsedMs}`（每站一条 `detail`：线路 → 选集）；调用方输入有误（未给 name / 未配源 / 未勾站点）→ 400 `{error}` |
| POST | `/api/agg/play` | 取播放地址：`{source, site, flag, episodeId}` → 归一化后的 `urls[]` / `header` / `parse` |

`detail` / `play` 的编排位于 **`agg/api.js`**：路由层（上表两条端点）与 **emby 层**共用同一套实现，
emby 层直接 `require` 该模块而**不经过 HTTP**（原因见 [ARCHITECTURE.md](../ARCHITECTURE.md) 的
「例外：emby 层进程内直调聚合层」与 [ADR-0002](adr/0002-in-process-emby-to-agg.md)）。两处返回形状完全一致，
区别只在失败时：路由层把它翻成 HTTP 状态码，emby 层读 `error.code` / `error.message` 并写进日志。

**挑片判据：本地打分**（见 [ADR-0003](adr/0003-local-title-scoring.md)）

- 搜索阶段即给每条结果打分（实现见 `server/modules/agg/match.js`）。权重为
  **名字 0.7 · 季集 0.2 · 年份 0.1**，缺失项不计入分母。
- 两道闸门：
  - **名字硬拒** —— 清洗后无公共主干，或相似度 < 0.5，直接出局（用于拦掉 `斗破苍穹4：逃亡` 这类同系列不同作品）；
  - **分数线** —— `minScore`，**填 0 = 不做分数线筛选**，此时只按分数排名取前 `maxItems` 条。
- 早期实现为「名字完全相等，否则将候选名交给 TMDB 反查 tmdbId」，失败点在输入侧：站源标题常含更新话术与
  画质标注（如 `斗破苍穹年番4更211[2025][动漫]`），直接检索无法命中 ⇒ 版本列表为空
  （在 Emby 中表现为「条目在、点开没有版本」）。本地打分不需要外部依赖，且能说明「为什么是这一条」。
- 阈值与条数存在 `agg.json`（`matchMinScore` 默认 0.85 / `matchMaxItems` 默认 3，可在「聚合设置」页修改），
  请求里可覆盖（web「聚合搜索」页的那三个输入框即对应它们）。
- **条数为什么要限制**：每多保留一条命中，后续就要多打一次站源 `/detail` 取链。实测 3 条 ≈ 2s，
  全部保留要到十几秒。
- **两个超时分开、单位是秒**（见 [ADR-0026](adr/0026-seconds-and-detail-timeout.md)）：
  「单站超时」`agg.timeoutSec`（秒，默认 5）= 搜索 / 播放 / 首次 `/init`；
  「取详情超时」`agg.detailTimeoutSec`（秒，默认 10）= 取详情 `POST /detail` 的单站上限。
  详情独自一档是因为**剧集目录动辄几十上百集**（响应体大、上游拼装慢），与搜索共用一个超时会
  大量"定位不到"。请求里可分别用 `timeoutMs` / `detailTimeoutMs`（**毫秒**）单次覆盖；
  详情超时**进详情快照的 key**（改了要重算一次）。
- **web 上可直接查看版本**：每条搜索结果上的「**这条的版本**」走 `source+site+vodId` 快路径（跳过搜索），
  以**弹窗**列出客户端会看到的内容 —— 每站「定位到这一集 N 条线路」+ 逐条线路的定位情况。
  核对「客户端点开到底会看到什么」看这里（同一套 `agg/api.js`，与 Emby 进程内直调是同一条链）。
- **接续补打 = 最多试 N+K 条，凑够 N 条即停**（见 [ADR-0005](adr/0005-continuation-fetch.md)）：
  命中 ≠ 能播 —— 前 `matchMaxItems`（N）条取详情后**未凑够 N 条可用**（没有线路 / 未定位到这一集）时，
  按分数继续往下打，**最多再多试 `matchExtraK`（K）条**，**凑够 N 条立刻停止**；K 填 0 = 不补打。
  `matchExtraAll`（开关）= **匹配到底**：不看 K，一直往下打到凑够或名单打完（可能很慢）。
  诊断字段：`stats.targetN / matchUsable / extraTried / usableExtra`、`picked.matchedBy='score+extra'`；
  日志一行示例：
  `↻ agg 接续补打：前 3 条里能用 1/3 条 → 往下打了 2 条（上限 8），凑够 3/3 条（阶段一 1 + 补打 2）`。
- **定位只认集号**：`detail` 传了 `episode` 就定位（`season` 可选）—— 源里的集名常常只有集号
  （如 `[842.5MB]211 4K.mp4`），只填集号而不给季号时，早期实现**一条都不定位**
  （看起来像源里没有这一集）。
- **失败可见**：`unmatched[]`（带 `score` + 原因：低分 / 超上限 / 名字不过闸）与
  `match{scanned,matched,belowLine,overCap,rejected,sameNameSameSite,minScore,maxItems}`；日志里也有一行摘要。

`POST /api/agg/search` 返回结构（`sites` 是**数组**，站点身份 = `source` + `key`）：

```jsonc
{
  "wd": "斗破苍穹", "page": "1", "elapsedMs": 1812,
  "sites": [                       // 每项：站点身份 + 该站原样输出
    { "source": "s1", "key": "nodejs_muou",
      "name": "木偶|4K", "api": "/spider/muou/3", "ok": true, "ms": 803,
      "data": { "page": 1, "pagecount": 1, "list": [ /* 站源原样条目 */ ] } },
    { "source": "s2", "key": "nodejs_muou",   // 另一个源里的同名站点，互不影响
      "name": "木偶|4K", "api": "/spider/muou/3", "ok": true, "ms": 399, "data": { } },
    { "source": "s1", "key": "nodejs_slow",
      "name": "示例|慢", "api": "/spider/slow/3", "ok": false, "ms": 15000, "error": "超时(15000ms)" }
  ],
  "stats": { "requested": 3, "ok": 2, "failed": 1, "empty": 0,
             "totalItems": 2, "duplicatedItems": 0, "timeoutMs": 18000, "concurrency": 2, "sources": 2 }
}
```

**多源**

- 聚合用的源 = **本地部署的源（自动，不需要配置）+ 自定义源**（`agg.sources`，指向外部地址；
  每个自定义源有一个「参与聚合」开关）。详见 [ADR-0012](adr/0012-deployed-sources-auto-aggregate.md)。
- 部署源的名字取**源自身的名字**、地址取它**当前端口**（每次现算 —— 端口随重启变化，存下来会指向旧端口）。
- 站点 key **只在各自源内唯一**，因此 `enabled` / `order` / 请求参数 / 响应里都带 `{source, key}` 两个字段，
  **绝不用裸 key 对齐**。

### 汇总规则与错误语义（聚合层）

- **只拼接、不去重**：每个站点的条目留在它自己的 `data.list` 里，不复制到顶层、不合并同名。
- **并发池**：按 `concurrency` 分批并发；单站失败/超时**只影响它自己**（该站 `ok:false` + `error`），
  整体仍返回 **200**。
- **首次 init**：每个站源请求前先 POST 一次 `/init`（**恒开** —— 原来那个 `initFirst` 开关已删：
  有的源不 init 就搜不出来，这是源的性质、不是选项），按「源地址 + 站点 key」缓存，不是每次请求都打。
  服务端测速任务每轮也走这一处，所以**一轮测速跑完 = 全站都已 init**；源重启换了端口时缓存键跟着变，
  业务侧会自动重新 init 一次。
- **同名统计**：`stats.totalItems` / `duplicatedItems` 与界面上的「同名 ×N」都用 `normName()`
  （去除空格与标点引号括号破折号后转小写比较）。
- **不做「同站同名去重」**（见 [ADR-0004](adr/0004-no-same-site-dedup.md)）：同名的几条各有自己的
  `vod_id`，哪条能播要取过 `/detail` 才知道 —— 按分数猜一条保留、把其余丢掉，正是
  「**同名反而匹配错**」的来源。因此**源给了几条就算几条**，只在 `match.sameNameSameSite` 里计数展示。
- **错误语义**：`wd` 为空 → 400；未配聚合源 → 400；勾选的站点一个都取不到 → 400
  （并指明是哪个源取不到站点）；单站 HTTP 非 200 → 该站 `ok:false`；详情按「命中才算数」统计
  `stats.detailOk / detailFailed`。
- **线路过滤参与"这条详情对客户端有没有用"的判据**（[ADR-0025](adr/0025-line-filter-in-usable-judgement.md)）：
  规则的实现只此一处（`agg/service.js` 的 `lineFilter()`，`agg/api.js` 与 emby 层都转发）。
  聚合层判断一条条目值不值得留着，用的是**过滤后**的可用条数（`stats.usable`，与客户端真能列出的
  版本一致；`stats.usableBeforeFilter` 是过滤前的，只作诊断），于是"过滤后一条都列不出来"的条目
  不算数 —— 接续补打会继续往下找，**详情快照也不存它**。日志里会写
  `· agg 线路过滤 /…/：过滤前能用 X 条 → 过滤后能用 Y 条`。
- **手工测某个源的端点**：`ANY /api/base/upstream?p=<路径>&source=<聚合源id>`（不传 `source`
  = 打聚合源列表第一条）。

### 站点测速（agg）

「站点与参数」页那一列「延迟」的来源 —— **服务端后台任务**（`agg/site-test.js`），
不是前端循环（原先前端逐站调，一关页面就断；而"每 6 小时自动一轮""源起来后自动测一轮"
这两件事本来就不可能由前端做）。

- **测什么**：每站一发 `POST {api}/search`，**关键词从常见影视名数组里随机取**
  （`agg/api.js` 的 `PROBE_WORDS`）；**非 200 就换一个词再测一发**，两发都非 200 才算真失败。
  随机取是为了避开"固定词恰好这站没有"：站里没那个词时会回 404 或空列表（实测 duoduo / huban）。
- **口径**：`HTTP 200 = 成功`（**列表为空也算** —— 它已经尽了搜索的义务）；非 200 记失败并记下状态码
  （404 / 500 / 403 …）；超时与网络错记失败。⚠️ 这与业务侧**刻意不同**：`searchSite` 把 404 记成
  "无结果、不算失败"，所以两笔**分开存**（`speed` 槽 / `call` 槽），别互相覆盖。
- **"聚合搜索要不要跳过这个站"用的就是 `speed.search`**：失败即跳过、成功即恢复，**没有时间窗口** ——
  这样"表里标红的站"与"被跳过的站"是同一个集合；恢复时机由测速周期（定时或手动）决定。
  `call.*` 只用于单元格 `title` 的诊断显示。
- **单点测速**：`POST /api/agg/site-test/one`（`{source, key, api?}`）只测一个站、**同步**返回，
  并且**不碰后台任务**（不改进度、不重排自动测速），只写同一个统计槽 ——
  站点表每行那个「测速」按钮就是它。
- **固定 15 秒超时**（`SPEED_TEST_TIMEOUT_MS`），**不读 `agg.timeoutSec`** —— 拿 5 秒去测会把慢站
  一律记成超时，量到的是设置而不是站。
- **并发 3**、**全部站点**（启用源下的所有站）；**跑完才排下一轮**，不会因为一轮慢而堆起来。
- **触发**：① 每 `speedTestHours` 小时（默认 6；`speedTestAuto` 默认开）；
  ② 手动 `POST /api/agg/site-test/start`（可带 `keys` 只测一批站）；
  ③ **某个源起来/重启后** —— source 层的 `runner.onReady` 只广播 id，`server.js` 接到
  `agg.siteTestSourceUp`（source 是最底层，不反向依赖 agg），只测那个源的站点；
  撞上正在跑的一轮就排队，等这轮结束补测。
- **只留最近一次**：`sitestat.db` 里每站每类一个槽，**直接覆盖**（没有样本数组、没有次数累计），
  所以那一列只有"最近一次测出来多少"；TTL 30 天。
- **真实业务那一份不占列**：`searchSite` / `fetchDetail` 的顺手记账（`call.search` / `call.detail`）
  只出现在单元格的 `title` 里 —— "点开要等多久"只有站点被真的用过才有值，如实留空。

### 兼容层（临时）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/PUT | `/api/settings` | 旧版形状：`{ baseUrl, agg:{...} }` ↔ `settings/agg.json`。**前端迁移到 `/api/modules/agg/settings` 后删除** |

## 面板鉴权

面板自身有一道**单密码门禁**：浏览器打开面板需要先登录，登录后 30 天内免登录。
取向见 [ADR-0017](adr/0017-panel-auth-single-password.md)。

- **默认密码 `123456`**（首次启动时写进 `data/auth.json` 的是它的 scrypt 哈希，不是明文）——
  **打开面板后应立即到「面板设置」修改**（仍在使用默认密码时，该页会持续显示警告）。
- **改密码 = 旧会话立刻全部失效**（签名中带密码指纹）；「面板设置」里也有「退出登录」。
- **保护范围**：面板自身的接口（`/api/sources*` / `/api/agg*` / `/api/modules*` / `/api/panel*` /
  `/api/logs` …），以及**被代理的源配置页**（`/website*`）。
- **不拦截两类**：
  - `/api/auth/*` —— 登录本身（否则无法登录）；
  - `/api/emby/*` —— Emby 客户端使用的兼容端点，它们有自己的 AccessToken 校验。
    **面板门禁拦截它们 = 所有客户端立刻断开**（Docker 健康检查也走那条路），因此必须放行。
- 静态文件（首页 / JS / CSS）不拦截：那只是外壳、没有数据，登录框本身也依赖它。
- 试错节流：同一 IP 连续失败 5 次 → 锁定 60 秒（面板日志里能看到失败与锁定）。

**这不是一套用户体系。** 一句话：**一个密码、一个共享会话，用于挡住局域网内随手打开面板的人**。
面板默认是 **http 明文**（密码在链路上是明文，除非在前方套了 https 反向代理），没有多用户、没有权限分级 ——
**不要把面板直接暴露到公网**。

凭证落在 `data/auth.json`（**不在 `settings/` 下**：该目录会被「配置备份」原样导出，密码哈希与会话密钥
不应走那条路）。删除该文件即回到默认密码 `123456`。

## 数据目录

```
data/
  app/<版本>/              **应用代码**（容器启动时从 GitHub Release 取得；面板可手动更新，见 [ADR-0019](adr/0019-self-update-from-release.md)）
    server.js  server/  public/  package.json  README.md
  app/current.json         当前运行版本（`{version, installedAt, source}`）
  app/.restart             更新时的重启标记：引导脚本读到即拉起新版本（正常运行时不存在）
  settings/<模块>.json     模块设置（见上文）
  settings.json.migrated   旧版单文件设置（升级留档，可删）
  sources.json             本地托管源清单
  sources/<源id>/
    index.js               源的打包产物（下载所得）
    index.config.js        随包声明（本地运行不读它）
    *.md5                  版本比对
    runtime/               源进程的 NODE_PATH：profile 库、缓存 db（可能含网盘 cookie/token）
  auth.json                面板门禁：密码的 scrypt 哈希 + 会话签名密钥（**不要外传**；删除即回到默认密码）
  emby/emby.db             Emby 客户端登录账号（内置 sqlite；密码只有 scrypt 哈希）
  emby/homepage/           首页插件（**不进配置备份**）
    registry.json          插件清单（元数据 + 参数值，不含源码）
    <插件id>/index.js       上传的插件原文（文件权限 600）
    <插件id>/storage.json   插件私有存储 Catpaw.storage（文件权限 600）
```

- `data/app/` 不进入配置备份（可以从 Release 重新取得）；其余部分（设置、源清单、账号）才是备份对象。
- `data/` 已在 `.gitignore` 里（**含凭证**，不要提交）。
- 想完全清空：停掉面板后 `rm -rf data`。
- 想只清某个源的运行数据：删除 `data/sources/<源id>/runtime/`。

## 开发：新增一个模块

1. `server/modules/<id>/index.js` 声明清单：

```js
module.exports = {
  id: 'foo',
  label: 'Foo',
  apiPrefix: ['/api/foo'],          // 对外暴露的前缀（文档与总览使用）
  upstream: 'agg',                  // 所消费的上游模块（读它的地址）；null = 不依赖其它模块
  settings: { defaults: () => ({}), validate: (o) => null, fields: [] },
  routes: (r) => { r.add('GET', '/api/foo/ping', (req, res) => sendJson(res, 200, { ok: true })); },
};
```

2. `server.js` 的 `MODULES` 数组加一行 `require('./server/modules/foo')`。
3. 前端加一个模块文件调用 `registerModule({...})`（前端拆分完成后），文档放 `public/docs/foo.js`。

模块设置会自动多出 `data/settings/foo.json` 与 `/api/modules/foo/settings`，无需改动 `core`。

## 实现要点

- **「当前托管源」解析**（`source/service.resolve()`，供 `/api/base*` 使用）：**自定义源列表的第一条**优先
  （`agg.sources[0].url`），否则取第一个正在运行的本地托管源（`origin: manual | local | none`）。
  聚合本身不经过它 —— 聚合按「部署源 + 自定义源」的合并清单**逐个源**打（`agg/api.js` 的 `loadSites`）。
  填写的地址会自动去除 `index.js`、`index.config.js`、`/website` 与结尾斜杠。
- **响应即「站点 key → 原样输出」**：`sites[key].data` 就是该站 `/search` 的原样响应体，不复制、不裁剪、
  不去重；前端按站点 key 分组渲染，同名条目显示「同名 ×N」角标（前端本地按相同归一化规则统计，仅作提示）。
- **可回溯**：聚合搜索页可直接查看响应 JSON；「分站诊断」逐站展示请求（`POST {托管源}{api}/search` + body）
  与**站源原样响应体**，便于逐层对照排查。
- **并发池**：默认 8 并发、单站 12s 超时（可改，下限 1000ms / 并发 1~32）；单站失败不影响整体，
  结果里带每站 `ok`/`ms`/`error`。
- **首次搜索先 `/init`**：按「地址 + 站点 key」缓存，避免每次搜索都多一次请求。
- **代理不解析协议**：请求原样转发，`/play` 返回的源内代理地址、`header`、`push://` 等语义完全保留。
- **配置中心同源代理**：把源地址的 `/website*`（含 `/website/api/**`、二维码 PNG）挂到自己域下，
  iframe 用相对路径加载 —— 无论通过 `127.0.0.1`、局域网 IP 还是 Tailscale IP 打开面板，内嵌页都能显示。

## 注意

- 站源接口全部是 **POST + JSON body**（`/init` `/home` `/category` `/detail` `/play` `/search`），
  只有 `/config`、`/check` 是 GET。
- `/website` 是源自身提供的配置中心，面板只是内嵌它；配置与凭证都由它管理。
- `index.config.js` 会被一并下载（外壳需要），但**不影响本地运行**：源 bundle 内部已内联自己的默认配置。
- 本地托管源的**两道 md5 校验**（见 [ADR-0015](adr/0015-source-bundle-integrity.md)）：
  - **下载/更新后**（`fetcher.download`）：拿到的 `index.js` 必须与官方 `index.js.md5` 一致；
    **不一致或该地址未提供 md5 → 删除本次下载的残留**并如实回报失败（**不再**用实际值覆写 md5 冒充成功）。
    `新增源` 会连源记录一起删除（400 报错），`更新` 则清空源文件、不重启 —— 该源在两种情况下都不可用，
    可点「更新」重试。
  - **运行前**（`fetcher.verifyBundle`）：`index.js` **必须**与 `index.js.md5` 一致 —— 缺 md5 或对不上就
    **拒绝启动**，并提示先点「更新」；`index.config.js` 那一对**存在则校验、缺失不拦截**（它本地不被运行，
    且部分源远端本就不提供）。理由是：它运行起来是 6MB 的 bundle，且能读 `runtime/` 中可能含 cookie/token
    的内容，下载到一半或被改过都不应静默运行。
- 关闭面板时会一并停止它托管的源子进程；被代理的外部源不受影响。
- 配置备份**不含** `sources/<id>/runtime/`（那是源自身的凭证缓存，按设计不导出）。
- Emby 兼容开发：
  - 端点的补齐顺序按实际客户端需求确定，规则与流程见 [emby-compat.md](emby-compat.md)；
    最新端点清单以 `server/modules/emby/routes.js` 为准。
  - 总口径：**列表数据由首页模块决定，emby 层做中介（端点映射 + DTO 转换）；点进条目后详情走
    TMDB 反查 + 聚合资源**。DTO 形状按真机对齐的取舍见 [ADR-0007](adr/0007-emby-dto-shape.md)。
  - 已实现端点：
    - `GET /api/emby/System/Info/Public` —— 握手
    - `POST /api/emby/Users/AuthenticateByName` —— 登录（账号在「Emby → 账号管理」，多账号）
    - `GET /api/emby/Users/{id}` —— 用户资料
    - `GET /api/emby/Users/{id}/Views` —— 每个启用的首页插件行 = 一个媒体库
    - `GET /api/emby/Users/{id}/Items?ParentId=<库Id>` —— 库内容 = 运行对应插件行
    - `GET /api/emby/Users/{id}/Items/Resume` —— 继续观看（**如实回空**，没有观看记录）
    - `GET /api/emby/Users/{id}/Items/{ItemId}` —— 详情：TMDB 反查 + 聚合绑定 +
      分级/时长/标语/演职/公司/关键词/预告/外链/艺术字/多图
    - `GET /api/emby/Items/{id}/Similar` —— 相似推荐，按坐标反查
    - `GET /api/emby/Items/{id}/Images/{type}[/{index}]` —— 图片，签名 tag，**豁免 token**
    - `GET /api/emby/Shows/{id}/Seasons` / `Episodes` —— TMDB 占位
    - `POST /api/emby/Items/{id}/PlaybackInfo` —— 播放信息（复用详情的线路解析）
    - `GET /api/emby/Items/{id}/Stream[/{token}[/{file}]]`、`GET /api/emby/videos/{id}/{file}` ——
      拉流入口，一律 `302` 跳转到源提供的直链（见 [ADR-0006](adr/0006-redirect-for-playback.md)）
  - 其余未实现的 `/api/emby/**` 请求只记日志并返回 501（例外：面板自用的 `/api/emby/home/**`）。
- Emby + TMDB 失败语义：**如实返回失败码，不编造占位数据、不返回空的假成功**
  （见 [ADR-0008](adr/0008-no-fabricated-data.md)）。
  - 上游给出状态码就照搬（401/403/404/429/5xx）。
  - 网络层归类为：连不上 `502` / 超时 `504` / 面板未配 token `500` / id 不合法 `400`
    （见 `tmdb.httpStatusOf()`）。
  - 「如实回空」的端点不校验账号，见 [ADR-0009](adr/0009-unauthenticated-empty-responses.md)。
- Emby 条目 `Id` 由 tmdb 坐标派生（`tmdb_{id}_tv` / `tmdb_{id}_movie`，季为 `tmdb_{id}_tv_s{n}`），
  **不含源信息** —— 客户端拿它当主键缓存，掺入「哪个站点」会因源变动而改变 Id、丢失「已看」。
  - `tmdb id → 站点 vod_id` 的绑定留给后续实现（播放时才需要）。
  - 派生与解析是一对（`tmdb.itemId` / `tmdb.parseItemId`），代码中相邻放置。
- TMDB：设置存 `settings/panel.json` 的 `tmdb.*`（**已从 emby 层上移到面板层**，
  见 [ADR-0010](adr/0010-tmdb-config-in-panel.md)）。
  - 该配置此前被 emby 层（取元数据）与聚合层（同名失败时按名字反查 tmdb id）同时需要，而依赖方向是单向的
    `emby → agg`（见 [ARCHITECTURE.md](../ARCHITECTURE.md)），聚合层读不到 emby 的配置，因此归面板层；
    旧配置在启动时**自动搬移，token 不丢**。
  - 凭证只支持 **v4 API Read Access Token**（`Authorization: Bearer`，明文落盘）；
    `apiBase` / `imageBase` 留空即官方地址，可换成反向代理。
  - 面板「面板设置 → 设置 → TMDB 设置 → 测试」（`POST /api/panel/tmdb/test`）会用**当前未保存**的输入值
    实查一个 tmdb id 并回显。
- Emby 账号（**多个**客户端登录账号）：存 `data/emby/emby.db`（Node 内置 sqlite，文件权限 600），
  密码只存 **scrypt 哈希**，遗忘后只能删除重建。
  - 旧版单账号（`settings/emby.json` 中的明文）在首次用到该库时自动迁移，并清除明文。
  - `UserId` 仍由「serverId + 用户名」派生，因此**改用户名或删账号 = 该账号的客户端需要重新登录**。
  - 「配置备份/还原」目前只覆盖 `settings/`，不含该库。
- Emby **拉流（302 之前）**：构建版本列表时会把"这一集在这一线路里的播放 id"记进服务端备忘
  （`(条目 Id, 源, 站点, 线路, vod) → 集 id`，TTL 30 分钟），拉流时先查它 —— 命中就直接调 `/play`，
  省掉一次源详情（实测那一次约 2 秒，命中后整跳 0.1 秒上下）；未命中（重启/过期/换源）照旧取详情。
  **备忘只影响快慢，不影响对错。**
- Emby **AccessToken 校验**：登录签发的 token 存 `sessions` 表，**11 个端点**校验它。
  - 三种携带方式都识别：`X-Emby-Token` / `Authorization`·`X-Emby-Authorization` 中的 `Token="…"` /
    query `api_key=`。
  - **无效或未携带 → 401**。
  - 豁免：握手、登录、账号管理、501 通配，以及**图片端点**（见
    [ADR-0013](adr/0013-image-endpoint-signing.md)）。图片请求的凭证携带方式不统一，实测 3/8 完全未携带，
    若强制要求会让这部分客户端的图片加载失败。
  - 改密码/删账号会作废该账号的所有 token。
  - 校验上线前签发的旧 token 不在表中 —— 客户端**退出重登一次**即可。
- Emby **首页插件**：面板「Emby → 首页插件」上传**单文件 JS** 插件。
  - 插件顶层声明 `HomePlugin = { id, name, version, rows:[…] }`，每行的 `functionName` 指向一个顶层
    async 函数，返回条目数组。
  - 插件在**独立子进程 + Node 权限模型**中运行
    （`node --permission --allow-fs-read=<sandbox.js>,<manifest.js>`，**每次执行新起一个、跑完即终止**）：
    只允许读它自己的那两份代码，**没有 fs、没有 net**，因此读不到 `data/` 中的凭证（TMDB token）；
    `Catpaw.http / tmdb / storage / log` 全部由面板代做。
  - 超时**两层**（子进程内干净超时 + 面板 2 秒后 `SIGKILL`），**同步死循环也能结束**。
  - 结果按 `cacheDuration` 缓存，并发走单飞；失败如实返回 `{ok:false}` 且不缓存。
  - 端点 `/api/emby/home/**`（8 个，面板自用、豁免 token，**注册在 501 通配之前**），
    存储 `data/emby/homepage/`（源码与 storage 权限 600，**不进配置备份**）。
  - 已接客户端端点：`Views`（每个启用的行 = 一个库）/ `Items?ParentId=<库Id>` /
    `Items/Latest?ParentId=<库Id>`（VidHub 首页依赖它）/ 库封面 / **「推荐」查询**
    （没有 `ParentId` 的 `SortBy=IsFavoriteOrLiked,…` → 路由到**声明了 `feed` 的行**，
    用于客户端首页轮播图）。
  - 规范见 [emby-home-plugin.md](emby-home-plugin.md)。

## 未实现

已知的缺口，按需要补齐；补哪个由实际客户端需求决定。

**端点**

- `GenreItems` 的列表端点（客户端点击类型之后会请求到它，当前落到 501）。
- 用户级变体 `Users/{uid}/Items/{id}/Similar`（条目级的 `Items/{id}/Similar` 已实现）。
- `POST /Sessions/Logout` —— 客户端"退出登录"会落到 501，**已签发的 token 不会被吊销**。
- `/Users/Public` —— 登录界面取用户列表用的那条。

**性能与稳定性**

- **条目详情是秒级**：`getItem` 每次都调用 `agg.detail({ name, year })`，即**按名字重新搜索**，
  从未走聚合层提供的 `source + site + vodId` 快路径 —— 聚合层为"已知绑定"预留了该路径，emby 层尚未接上。
  前置条件是先实现 `tmdb id → 站点 vod_id` 的懒绑定与落盘。
- **取图偶发 `502`**：到图床的链路抖动，同一 URL 重试即可成功；是否增加一次重试尚未决定。

**前端**

- `GET /api/settings`（旧的 `{ baseUrl, agg: { … } }` 形状）仍被启动流程用于读取 `base`。
  聚合设置其余部分已经走 `/api/modules/<id>/settings`，该兼容端点可随之移除。
