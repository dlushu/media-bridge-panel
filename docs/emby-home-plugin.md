# Emby 首页插件开发指南

在面板上传**单文件 JS 插件**，插件按「行（rows）」产出首页条目；面板负责执行、缓存、预览。
本文档是插件契约的**唯一来源** —— 代码里不放本文没写的字段或 API。

配套：端点兼容规矩见 [emby-compat.md](emby-compat.md)，本文只管「首页数据怎么来」。

---

## 一、定位与边界（先读这条）

| 角色 | 是谁 |
|---|---|
| 插件 | 数据**生产者**：一个文件声明若干行，每行一个 async 函数，返回条目数组 |
| 面板 | **宿主**：上传校验、**子进程内执行**、缓存、面板内预览 |
| Emby 客户端 | **已接线**：每个启用的行 = 一个媒体库，客户端点进库就来要这一行的内容 |

> 「子进程内执行」= 每次执行**新起一个子进程**跑 `sandbox.js`，插件代码在那个进程里的 **vm 上下文**
> 中执行。**`vm` 不是安全边界，进程权限才是** —— 完整说明见「八」。

> **接线状态见「十」** —— `Views` / `Items?ParentId=` / `Items/Latest` / 图片都已接上，
> 其余候选（库详情）按 [emby-compat.md](emby-compat.md) 的铁律：
> **等客户端日志暴露请求 → 再决定接线**。

本阶段因此**没有**以下东西：行排序、跨插件合并、用户维度（收藏/已看）、离线打包、插件市场。

---

## 二、铁律（与项目一致，不可绕过）

1. **不编假数据**：插件失败就照实失败。handler 抛错 → 该行 `{ok:false, error}`，**不写缓存**、不返回假的空条目。
2. **归一化是严格的**：规范外的字段**一律丢弃**（不是忽略，是丢掉），缺 `id` / `title` / 合法 `type` 的条目**直接丢**并计数。
3. **未发布的兼容不留**：插件格式、字段名、API 形状该改就改，不为「已上传的旧插件」留双读分支。
4. **面板不猜**：插件文件怎么执行、能拿到什么 API，全部写在本文；本文没有的，面板也不提供。

---

## 三、插件文件格式

**一个文件 = 一个插件**。纯文本 JS（UTF-8，上限 **1MB**），首条语句是**裸赋值**：

```js
HomePlugin = {
  id: 'example.tmdb',        // 全局唯一，见下表
  name: '示例 · TMDB 榜单',   // 面板显示名
  version: '1.0.0',
  author: 'catpaw-panel',    // 可选
  description: '……',         // 可选
  rows: [ /* 至少 1 行，最多 32 行 */ ],
};

async function loadTrending(ctx) { /* 返回 HomeItem[] */ }
```

| 字段 | 必填 | 规则 |
|---|---|---|
| `id` | 是 | `/^[a-z0-9][a-z0-9._-]{2,63}$/i`（反向域名风格，**同一面板内唯一**） |
| `name` | 是 | 非空；写 `title` 也认（二选一） |
| `version` | 是 | 非空字符串 |
| `author` / `description` | — | 字符串 |
| `rows` | 是 | 数组，1~32 个 |

- **不要包 IIFE、不要用 `export`**：handler 必须是**顶层函数声明**，面板按名字在全局查找（`functionName` 解析不到 → 上传被拒）。
- 写 `'use strict'` 也可以（面板已预声明 `HomePlugin`）。
- 顶层**不要读 `Catpaw.storage`**：上传校验时面板还不知道插件 id，读到的是空对象。要读就放 handler 里。

### 行（row）

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 行内唯一；参数与缓存按它归档 |
| `title` | 是 | 行标题（将来做 Emby 媒体库名） |
| `functionName` | 是 | 顶层 async 函数名 |
| `cacheDuration` | — | 结果缓存**秒数**；`0` 或缺省 = 不缓存 |
| `timeoutMs` | — | 单次执行超时，默认 `15000`，上限 `60000` |
| `collectionType` | — | 这一行做出来的**库是哪种库**：`movies` / `tvshows` / `mixed`（其它值上传被拒）。见下 |
| `feed` | — | 这一行**接客户端哪一类"推荐查询"**：目前只有 `random`（其它值上传被拒）。见下 |
| `params` | — | 用户可配参数，最多 16 个 |

#### `collectionType`（这个库是什么库）

对应 Emby 协议里每个媒体库都有的 `CollectionType` —— 真机 25 个库**无一例外**都带它
（`movies` / `tvshows` / `playlists` / `boxsets`），客户端据此决定进库之后的布局。

宿主取值顺序：**行声明** → 按该行当前的 `type` 参数推（`movie`→`movies` / `tv`→`tvshows`）
→ `mixed`。所以：

- 有 `type` 参数的行**故意不写** —— 用户把参数切到"剧集"，库就该跟着变成剧库，写死反而错；
- 没有 `type` 参数、但内容类型确定的**必须写**（例：`with_networks` 筛的是剧 ⇒ `tvshows`）；
- 天生混装的写 `mixed`（例：TMDB 片单影剧混装）。

不写也没有对错，只是那个库在客户端眼里是"混合库"（官方定义：混合按通用方式展示）。

#### `feed`（这一行接客户端的哪一类"推荐查询"）

有些客户端**要推荐不用库 Id**，而是直接发一条 `SortBy` 描述。已知 Rex 首页**第一发**就是

```
GET /Users/{id}/Items?SortBy=IsFavoriteOrLiked,Random&Recursive=true&Limit=30&...   ← 注意：没有 ParentId
```

它喂的是**客户端首页顶部的轮播图**（比 `Views` 还早 42ms —— 在还不知道有哪些库的时候就要结果）。

**声明 `feed: 'random'` 后，宿主就把那条查询路由到这一行**（`home.rowByFeed()` 找第一个声明的启用行）；
**没有插件声明 → 那条查询继续回空 → 轮播图没素材**。宿主**不会**"随便挑一行顶上"。

- 这一行**同时也是普通的库行**（会在客户端的媒体库列表里多一个库），不需要为它做别的适配；
- 认它的判据是「没有 `ParentId` + 没有 `Filters` + `SortBy` 含 `IsFavoriteOrLiked`」，写在宿主里
  （`service.feedOfQuery`），插件不用管；
- 它接上之后就变成**受保护端点**（无 token → 401）—— 以前回空所以不校验，现在真出数据了。
- 示例里那行 `random_picks` 就是接这个的（TMDB 没有随机接口，它靠"随机取一页"实现，
  细节与实现注意点都写在示例文件里）。

### 参数（params）

| `type` | 面板控件 | 说明 |
|---|---|---|
| `input` | 文本框 | `value` 为默认值 |
| `enumeration` | 下拉框 | 必须给 `enumOptions: [{title, value}]` |
| `count` | 数字框 | `value` 为默认值 |
| `constant` | 不显示 | 隐藏常量（写死的能力开关） |

> 已移除 `page` 类型（宿主曾将其转成数字塞进 `ctx.page`）：客户端翻页改为把
> `StartIndex`/`Limit` 原样透传进 `ctx`（见「四」），该类型就只剩"数字参数"一个含义，与 `count` 重复。

参数值存进面板的插件清单，按「行 id + 参数名」覆盖声明默认值；handler 里从 `ctx.params` 读。
**改参数不用重新上传插件**，也不影响别的行。

---

## 四、handler 契约

```js
async function loadTrending(ctx) -> HomeItem[] | { items: HomeItem[], total: number }
```

`ctx`：

| 字段 | 说明 |
|---|---|
| `ctx.params` | **面板里配的参数**（声明默认值 ← 已保存值 ← 本次预览的临时覆盖）。唯一的参数来源 |
| `ctx.startIndex` | **客户端要的起点**（`Items?ParentId=…&StartIndex=`，原样透传；缺省 `0`） |
| `ctx.limit` | **客户端要的条数**（`Limit=`，原样透传；`0` = 客户端没指定，由插件自行决定） |
| `ctx.signal` | `AbortSignal`：超时会 abort 它，**善意约定**（用来收尾/取消自己发起的上游请求）。但真卡在同步代码里时来不及响应 —— 那种情况由面板杀进程，见「七」 |
| `ctx.log(...)` | 打日志到**面板日志**（自动带 `[home:<插件id>]` 前缀）—— 面板「面板设置 → 日志」页与 `docker logs` 都能看到 |

**返回值**两种都行：

- **数组** —— `total` 就等于本页条数（客户端据此认为翻不动，适合"就一屏"的行）
- **`{ items, total }`** —— `total` 会成为 `TotalRecordCount`，**客户端靠它决定还能不能往下翻**（见「四·分页」）

失败就 `throw`。

### 分页

**分页参数由客户端给出、原样透传给插件；emby 层不切片。** 取哪一页、是否按页请求上游，**由插件决定**：

```js
async function loadTopRated(ctx) {
  const PER_PAGE = 20;                          // 上游一页 20 条（上游的粒度）
  const start = ctx.startIndex || 0;
  const page = Math.floor(start / PER_PAGE) + 1;
  const offset = start % PER_PAGE;              // 客户端窗口可能落在上游这一页中间
  const limit = ctx.limit > 0 ? ctx.limit : PER_PAGE;

  const body = await Catpaw.tmdb.get('movie/top_rated', { params: { page } });
  const items = body.results.map(toItem).slice(offset, offset + limit);   // ← 自己按窗口裁
  return { items, total: body.total_results };
}
```

要点：

- **`ctx.limit` 需由插件自行处理** —— emby 层不裁，客户端要 2 条就应只给 2 条；
- **要给 `total`**，否则客户端只看到"本页 n 条"，翻不到第二页；
- `ctx.startIndex`/`ctx.limit` 是"客户端要的窗口"，**不要假设它和上游的分页粒度一致**（上面就是自行换算 + 页内偏移的）；
- 结果按 `(插件, 行, 参数, startIndex, limit)` 分开缓存 —— 第 1 页和第 2 页不会串。

---

## 五、HomeItem 模型

**只保留下列字段，其余丢弃。**

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 稳定唯一键；行内去重按它。**建议**（非强制）用 `tmdb_{id}_{movie\|tv}` —— 客户端点这一条时会去打 `/Users/{id}/Items/{这个Id}`，**那条由 emby 层按 tmdb 坐标反查详情 + 聚合资源**（见「十」）。自己编的 Id 照样显示，但点进去没有资源 —— **那是这个模块自己的事，emby 层不兜底** |
| `type` | 是 | `movie` \| `tv`（其它值整条丢弃） |
| `title` | 是 | |
| `originalTitle` | — | 原名 |
| `year` | — | 数字；`0`/非法丢弃 |
| `overview` | — | 简介 |
| `rating` | — | 数字；`0`/非法丢弃 |
| `poster` | — | **完整 http(s) URL**（面板不拼图床，插件自己拼；用了 TMDB 图床见 `Catpaw.tmdb.imageUrlOf`） |
| `backdrop` | — | 同上，横图 |
| `genres` | — | 字符串数组（最多 20 个） |
| `providerIds` | — | 对象，如 `{ Tmdb: "550" }` |
| `catpaw` | — | `{ site, vodId }`，**预留**：把条目绑到猫源，将来播放链路要用 |

- 每行**最多 200 条**，超出的按丢弃计数。
- 单行内 `id` 重复 → 只留第一条，计入 `dup`。

### 怎么映射到 Emby（已接线，见「十」）

| HomeItem | Emby `BaseItemDto` | 备注 |
|---|---|---|
| `id` | `Id` | **建议**用 `tmdb_{id}_{tv\|movie}` —— 点进去要靠它 TMDB 反查；不给就没有资源 |
| `type` | `Movie` / `Series`（同时 `IsFolder`：剧 true、影 false） | |
| `title` / `year` / `overview` / `rating` | `Name` / `ProductionYear` / `Overview` / `CommunityRating` | |
| `originalTitle` / `genres` | `OriginalTitle` / `Genres` | |
| `poster` / `backdrop` | `ImageTags.Primary` / `BackdropImageTags` | 完整 http(s) URL，会被编成**签名 tag** 交给客户端（图片端点已实现）。插件没给 → 不给 `ImageTags`（不承诺）。面板预览也直接用这个 URL |
| `providerIds` | `ProviderIds` | |
| `catpaw` + 行站点 | `CatpawSource` / `MediaSources` | 播放要用，格式见 emby 兼容指南 |

---

## 六、宿主 API（全局 `Catpaw`）

| API | 返回 | 说明 |
|---|---|---|
| `Catpaw.http.get(url, opts)` | `{status, headers, data}` | `opts`: `{headers, params, timeoutMs}`。**非 2xx 抛错**（`err.status` / `err.data`） |
| `Catpaw.http.post(url, body, opts)` | 同上 | `body` 为对象时自动 JSON 序列化并按需加 `Content-Type` |
| `Catpaw.tmdb.get(api, opts)` | TMDB 响应体**本体** | **异步**（要 `await`）。`api` **无前导斜杠**（`trending/movie/week`）；`opts`: `{params}`，`language` 默认取面板设置 |
| `Catpaw.tmdb.imageUrlOf(size, path)` | 图片 URL 字符串 | **同步**（不用 `await`）：纯拼串，基地址取面板设置（含自定义镜像）。如 `imageUrlOf('w500', m.poster_path)` |
| `Catpaw.storage.get(key)` | 值 | 插件私有 JSON（落 `data/emby/homepage/<id>/storage.json`）。**同步** |
| `Catpaw.storage.set(key, value)` | value | 立即原子写盘；`value` 为 `undefined` 即删除该键。**同步** |
| `Catpaw.log(...args)` | — | 同 `ctx.log`。**同步**（尽力而为，不回执） |

**`Catpaw.tmdb.get` 返回的是响应体本体**（`res.results`），**没有** `.data` 包装；只有 `Catpaw.http.*` 才包 `{status, headers, data}`。

⚠️ **同步 / 异步不要弄反**：`http.get` / `http.post` / `tmdb.get` 是**异步**（要 `await`）；`tmdb.imageUrlOf` / `storage.get` / `storage.set` / `log` 是**同步**（不要 `await`）。
忘了 `await` 的字段会被 JSON 序列化成 `{}`，**返回值里出现 Promise 会直接报错**（面板会指出是哪个字段没 await），不会再静默丢字段。

这四样（`http` / `tmdb` / `storage` / `log`）**能力**全部由面板提供：插件所在的子进程既没有网络也没有磁盘（见「八」）。
其中 `http` / `tmdb.get` / `storage.set` 要过一次 IPC（通常几毫秒），**不要在循环里成千上万次地调用**；`imageUrlOf` 是本地拼串，调用开销可忽略。

**不提供**：`require` / `process` / `fs` / `global` / `fetch` / `Buffer` / `XMLHttpRequest` / `eval` / `new Function`。

**环境自带的**：`console`（接到 `Catpaw.log`）、`setTimeout` / `clearTimeout`、`URL` / `URLSearchParams`、`TextEncoder` / `TextDecoder`、`AbortController`，以及 JS 内建（`Math` / `JSON` / `Date` / `Promise` / `Array`…）。

---

## 七、执行语义

| 环节 | 规则 |
|---|---|
| 执行位置 | **独立子进程**（`node --permission … sandbox.js`），**每次执行新起一个，跑完即杀** —— 插件代码永远不在面板进程里跑。子进程启动约 40ms，可忽略 |
| 加载 | 每次执行都重新读盘 + 重新加载（缓存的是结果不是代码）；顶层代码有 `3000ms` 上限，超时/语法错/清单非法 → 上传被拒 |
| 上传校验顺序 | **先让沙箱加载校验，再决定写不写盘** —— 非法插件不留半份文件；子进程回报的清单面板**再验一遍** |
| 缓存 | key = `插件id:行id:参数JSON`，`cacheDuration` 秒；**成功才写**，失败不缓存 |
| 单飞 | 同 key 并发请求共享一次执行（返回里 `shared: true`），避免击穿上游 |
| 超时 | **两层**：① 子进程内部到 `timeoutMs` 放弃结果并回报干净的 `TIMEOUT`；② 面板再等 2 秒硬 `SIGKILL` —— **同步死循环也能收场**（面板内 vm 方案无法做到） |
| storage | job 下发时带一份**快照**（`get` 同步读它）；`set` 改快照并通知面板**立即落盘**。并发跑同一插件的不同行时各持一份快照、后写者覆盖 —— 只当缓存用，不宜存放关键状态 |
| 预览并发 | 面板一次最多跑 4 行 |
| 失败 | 一律 HTTP 200 + `{ok:false, error:{code,message}}`（前端才能看到细节）；缓存不写 |

上限一览：源码 1MB、行 32、每行参数 16、每行条目 200、storage 单键 512KB / 总量 2MB。
预览里报的 `ms` 是**端到端墙钟**（含起子进程约 40ms 与 IPC），不是 handler 自己的耗时 —— 那才是「点一下运行要等多久」。

---

## 八、安全边界

插件的执行环境是**独立子进程 + Node 权限模型**：

```
node --permission --allow-fs-read=<sandbox.js> --allow-fs-read=<manifest.js> sandbox.js
```

**只允许读它自己那两份代码文件**；fs 写、net、`child_process`、`worker` 一律没有。
插件拿不到盘和网，于是 `Catpaw.http` / `Catpaw.tmdb` / `Catpaw.storage` / `Catpaw.log`
只能由面板代做（见「六」）。

在 Node v25.8.1 下的验证结果：

| 试探 | 结果 |
|---|---|
| `typeof require` / `process` / `fetch` / `Buffer` | 全是 `undefined`（没注入） |
| `eval('1+1')` | 抛错 `Code generation from strings disallowed for this context`（`codeGeneration` 已关） |
| `this.constructor.constructor('return process')().pid` | **拿得到** —— 仍然是**子进程**的 pid，逃逸确实存在 |
| 逃逸后 `process.getBuiltinModule('fs').readFileSync('…/settings/emby.json')` | **`ERR_ACCESS_DENIED`** —— **读不到 TMDB token** |
| 逃逸后 `fetch(...)` | `ERR_ACCESS_DENIED` —— 发不出请求 |
| handler 里 `while (true) {}` | 约 `timeoutMs + 2s` 后子进程被 `SIGKILL`，面板照常服务 |

一句话概括：

- **vm 不是边界**（逃逸仍能摸到子进程的 `process`）；
- **进程权限才是边界**：那个进程什么也没被允许，所以逃逸出去也无事可做 —— 这正是把执行搬进子进程的目的；
- **卡死/崩溃不再拖累面板**：硬杀的是子进程。

**仍然存在的残留边界**（不可理解为"装上任意插件即安全"）：

- 同 OS 用户、无 seccomp / namespace —— Node 官方声明权限模型**不是**抗定向攻击的硬沙箱；真边界得靠容器或独立用户；
- 面板代做的那几样能力是**真实的**：插件可以用面板的网络与 TMDB 凭证（只是读不走 token，也不能改目标地址）；
- 权限模型需要 Node 20+；本机 Node 若不认 `--permission`，会换 `--experimental-permission` 再试，**两个都不认就直接报错拒绝执行**（不会静默降级成"没有沙箱也照跑"）。

另：插件里塞超长同步循环会让整个面板卡住（`server.js` 的进程级兜底只能接住抛错，接不住死循环）。

---

## 九、面板操作与自用端点

面板路径：**Emby → 首页插件**。

| 操作 | 说明 |
|---|---|
| 上传 | 选 `.js` 文件 → 上传；同 `id` 且内容不同 → 默认拒绝，勾「覆盖同 id 插件」才更新（**保留启用状态与已保存参数**）；同 `id` 同内容 → 直接跳过 |
| 下载示例 | 拿 `server/modules/emby/home/example.plugin.js`，可直接改 |
| 下载开发文档 | 拿 `server/modules/emby/home/plugin-dev.skill.md` —— **面向用户**那份（SKILL.md 格式，可直接放进 agents 的 skills 目录让 AI 照着写插件）。本文是**开发者契约**，那份是**用户手册**，两份各有各的用处 |
| 启用 / 停用 | 记录用；本阶段不影响预览（预览随时可跑） |
| 保存参数 | 按行保存声明过的参数；**只改这一行，不碰其它行** |
| 运行 | 逐行预览：条目数 / 丢弃 / 去重 / 缓存命中 / 耗时 + 原始 JSON |
| 删除 | 连插件代码与它的 `storage.json` 一起删。**内置示例不给删除入口**（见下） |

### 内置示例（`example.tmdb`）—— **不能删除**

面板启动时会把**随包发行**的那份 `example.plugin.js` **自动同步**进插件列表，
所以列表里**永远有一个 `example.tmdb`**（面板上标着「内置」，没有删除按钮）。

- **同步规则（按 md5 比）**：没装过 → 装上；装过但内容与随包那份不同（面板升级带来了新示例）→
  **覆盖更新**，但**保留已启用的状态与已保存的参数**；内容一致 → 跳过（不写盘、不清缓存）。
- **`example.tmdb` 是保留 id**：不能拿它当上传目标（会回 409 `RESERVED`）——
  否则"默认那份"就被顶掉了，而它本该永远在。要改就在面板里**改参数**，或**复制一份改成别的 id** 再传。
- **删除会被拒**（`403 BUILTIN`）：删除后重启仍会重新同步回列表，因此直接拒绝删除。
  要它不出现在客户端里，就关掉「启用」开关（或停用它的某几行）。
- 数据落在 `data/emby/homepage/example.tmdb/`（与普通插件同一套落盘方式），
  **每次开机都与随包文件对齐**，不会悄悄过期。

**面板自用端点**（不是 Emby 客户端协议；豁免 AccessToken，与 `/api/emby/accounts` 同类）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/emby/home/plugins` | 插件列表 |
| GET | `/api/emby/home/plugins/:id` | 单插件详情 |
| POST | `/api/emby/home/plugins?filename=&overwrite=1` | 上传：body = 纯文本 JS（`Content-Type: text/javascript`），非 multipart |
| PUT | `/api/emby/home/plugins/:id` | 改 `{enabled, name, params}` |
| DELETE | `/api/emby/home/plugins/:id` | 删除 |
| POST | `/api/emby/home/plugins/:id/rows/:rowId/run` | 执行一行，body 可 `{params}` 临时覆盖 |
| GET | `/api/emby/home/example` | 参考插件源码（text/plain） |
| GET | `/api/emby/home/skill` | 插件开发文档（text/markdown，带 `Content-Disposition` 直接下载） |

状态码：清单非法/语法错/空/加载超时 `400`、超 1MB `413`、id 已存在需覆盖 `409`、插件或行不存在 `404`。
**执行失败是 `200` + `{ok:false}`**，不是 4xx/5xx。

⚠️ 这些端点**必须注册在 `ANY /api/emby/*rest` 通配之前**，否则会被 501 吞掉（实现见 `emby/routes.js` 通配上方那行）。

### 落盘

```
data/emby/homepage/
  registry.json          清单：{ id, name, version, author, fileName, size, md5,
                            enabled, params:{行id:{参数名:值}}, rows:[…快照],
                            uploadedAt, updatedAt }        ← 不含源码
  <插件id>/index.js       上传的原文（600）
  <插件id>/storage.json   Catpaw.storage（600，可能含插件自己放的 token）
```

- `registry.json` 里的 `rows` 是**上传时的清单快照**（面板用它渲染，不必逐个加载插件代码）；**文件才是权威**。
  手动改盘上的 `index.js` 面板不会感知 —— 需**通过重新上传**更新。
- 插件代码与存储**不进** `panel/backup.js` 的配置备份（备份只打包 `settings/`）。

---

## 十、与 Emby 端点接线

**总口径**：**列表数据由首页模块决定，emby 层做中介 —— 只负责端点映射与 DTO 转换**；
客户端点进某一条后，**详情走 TMDB 反查 + 聚合资源**（那条链路不归模块管）。

```
插件模块 ──HomeItem[]──▶ emby 层（只转形状） ──BaseItemDto──▶ 客户端
                              │
              客户端点条目 ──▶ /Items/{id} ──▶ TMDB 反查 + 聚合资源 ──▶ 详情/播放
```

**已接端点**：

| 端点 | 模块侧入口 | 说明 |
|---|---|---|
| `GET /api/emby/Users/{UserId}/Views` | `enabledRows()` | 每个**启用**的插件行 = 一个媒体库，`Id = catpawhome_<base64url(插件id\|行id)>`、`Type = CollectionFolder` |
| `GET /api/emby/Users/{UserId}/Items?ParentId=<库Id>` | `listByQuery()` | 跑那一行 → `HomeItem → BaseItemDto`；`Limit`/`StartIndex` **原样透传**给插件（进 `ctx`，**emby 层不切片**）、插件回的 `total` 直接当 `TotalRecordCount`；`SortBy`/`Recursive`/`IncludeItemTypes` 忽略；失败**照实回失败码** |
| `GET /api/emby/Users/{UserId}/Items/Latest?ParentId=<库Id>` | `listByQuery()` | 同上跑那一行，但**回裸数组**（协议如此），`Limit` 缺省 **20**；**顺序由模块决定** —— emby 层不排序、不筛"入库时间"（模块没有那个数据）。**VidHub 的整个首页都靠它（逐库各一次）** |
| `GET /api/emby/Users/{UserId}/Items?SortBy=IsFavoriteOrLiked,…`（**无 ParentId**） | `rowByFeed('random')` → `listByQuery()` | 客户端首页轮播图的取数（Rex 首页第一发）。跑**声明了 `feed: 'random'` 的那一行**；**没有行声明就回空**（不挑一行顶上） |

条目给的 `poster` / `backdrop`（完整 URL）**客户端如何取不由模块操心** —— emby 层会把它们
编成**签名 tag** 发出去，同时**记入本地图片索引**（`cache.db` 的 `image_index`）：
有的客户端不回传 tag（已知：iPhone 上的 Lumenic 从不回传 `Primary` 的 tag），那就走索引。
两条路都是 **0 上游调用**，跟模块无关。

⇒ **条目 `id` 用什么都行**：索引是**按条目给出的 id** 记的，不要求 `tmdb_{id}_{tv|movie}`。
（只有"点进去看详情"那一环需要 tmdb 坐标，见上。）
`CollectionType` 由**行清单的 `collectionType`**（或该行当前的 `type` 参数）决定，见「三、行（row）」。
启用/停用即时生效（Views 每次现读 registry），但客户端可能要重启或清缓存才刷新。

**不归模块管（emby 层自己做）**：条目详情（TMDB 反查 + 聚合绑定）、季集、播放（`PlaybackInfo`/`Stream`）、账号与握手。
所以**建议**条目 `id` 用 tmdb 坐标 —— 否则"点进去反查"这一环断掉，**那是模块自己的事，emby 层不兜底**。

**接线记录**（每条均依据客户端日志暴露的请求）：

| 客户端要的 | 依据 | 状态 |
|---|---|---|
| 图片 → `Items/{Id}/Images/{type}` | 详情已回 `ImageTags`，点开就会来要 | **已实现**（tag 或本地索引两条路，都是 0 上游） |
| `Items/Latest?ParentId=<库Id>` | 官方另一条「每库最新」路径（回裸数组） | **已实现**（**VidHub 的整个首页都靠它**；顺序由模块决定） |
| 无 `ParentId` 的「推荐」查询 | 客户端首页**轮播图**的取数（Rex 首页第一发） | **已实现**（路由到声明了 `feed` 的行，见「三」的 `feed`） |
| 库详情 → `Users/{UserId}/Items/{库Id}` | 客户端可能问「这个库是什么」 | **未指定**（客户端尚未请求） |

---

## 十一、参考实现

`server/modules/emby/home/example.plugin.js`（面板「下载示例」拿到的就是它）——**11 行**。
行的取法照另一个项目 **Rex 的 TMDB 模块**（正在热映 / 趋势 / 备受欢迎 / 高分 / 分类 / 平台 /
公司 / 片单 / 近一月地区剧集·综艺），每行再各自演示一件工程上的事：

| 行 id | 库名 | 演示什么 | TMDB 接口 |
|---|---|---|---|
| `now_playing` | 正在热映 | 一个枚举参数切两条官方接口 | `movie/now_playing` / `tv/on_the_air` |
| `trending` | 趋势 | **影剧混合**：`all` 档的条目自带 `media_type`，要按条判类型 | `trending/{movie\|tv\|all}/{day\|week}` |
| `popular` | 备受欢迎 | 常规翻页行 | `{movie\|tv}/popular` |
| `top_rated` | 高分内容 | 常规翻页行 | `{movie\|tv}/top_rated` |
| `categories` | 分类 | **参数联动**：影/剧的 genre id 不是同一套；对不上就**照实抛** | `discover/{movie\|tv}?with_genres=` |
| `networks` | 播出平台 | 枚举参数（平台 id） | `discover/tv?with_networks=` |
| `companies` | 出品公司 | 枚举参数（公司 id），只有电影 | `discover/movie?with_companies=` |
| `list` | 片单 | **`input` 参数**（整条地址或纯 id）+ **只回数组**（接口不分页） | `list/{id}` |
| `regional_series` | 近一月地区剧集 | **语言 + 国家**双条件（台/港/英剧光看语言分不开） | `discover/tv?with_original_language=&with_origin_country=&first_air_date.gte=` |
| `regional_variety` | 近一月地区综艺 | 同上 + `with_genres=10764`（综艺在 TMDB 没有独立类型，只能近似） | 同上 |
| `random_picks` | 随机推荐 | **`feed: 'random'`**（接客户端首页轮播图那条查询）+ **真随机**（TMDB 没有随机接口，靠"随机取一页"） | `discover/{movie\|tv}?page=<随机>&vote_count.gte=&vote_average.gte=` |

可复用的小工具：`toItem`（剧/影两套字段名 → HomeItem，文件头附"谁填哪个真机字段"的对照表）、
`paged` + `pageOf`（**窗口换算只写一处**）、`genreNameMap`（genre id → 本地化名字，
**用 `Catpaw.storage` 存一天**，所有行共用）。

**与 Rex 的三处不同**（文件头也有说明，属有意差异）：

- Rex 有 `page` / `language` 两种**参数类型**，本模块没有 —— 翻页靠 `ctx.startIndex`/`limit` 自行换算；
  需要客户端语言时须自行声明一个 `enumeration`（因此"跟随语言"一档无法实现）。
- Rex 的「片单」**抓 TMDB 网页 + 解析 HTML**（它的平台只有 `http`+`html` 两个能力）；
  本模块直接调 `Catpaw.tmdb.get('list/{id}')` —— **走官方接口更稳**，不用解析 HTML，也就没有它那种"拿到 id 还要逐条取详情"的开销。
- Rex 的"地区"数据来自它自己的 CDN（预先算好的近一月片单）；本模块**用 TMDB 的 discover 现算**
  （`first_air_date.gte=30 天前`），是近似、不是同一份数据。

> **行的内容照 Rex，不照真机**：真机首页那是**输出内容**（它有「华语影 / 邵氏电影 / 长春电影制片厂」
> 这类按来源分的库），照抄没意义。真机给的是**输出格式**的参照 ——
> HomeItem 字段 ↔ 真机 `BaseItemDto` 字段的对照见示例文件头那张表。

---

## 十二、相关文件

| 文件 | 作用 |
|---|---|
| `server/modules/emby/home/store.js` | 落盘：`registry.json`、插件源码、`storage.json`；原子写 + 600 权限。**面板是唯一的写盘方**（storage 也从这里走，子进程碰不到盘） |
| `server/modules/emby/home/manifest.js` | **两端共用**的规范：常量、`fail()`、清单/参数的校验与归一化（面板侧用它复验子进程回报的清单） |
| `server/modules/emby/home/sandbox.js` | **被 spawn 的子进程**：vm 上下文、`Catpaw` shim（经 IPC 回面板）、加载与执行、超时放弃结果 |
| `server/modules/emby/home/spawn.js` | 面板侧：按权限模型起子进程、代做 `http`/`tmdb`/`storage`/`log`、超时硬杀、错误归一 |
| `server/modules/emby/home/index.js` | 宿主：安装/更新/删除、按行调度、HomeItem 归一化、缓存 + 单飞；**媒体库 Id 派生/解析**（`viewId` / `parseViewId`，挨着放）、`enabledRows()`（`Views` 用，含 `collectionType` 解析 `resolveCollectionType()`）、**`rowByFeed()`**（找声明了某个 `feed` 的行 —— 客户端"只要推荐"的查询靠它路由，见 §10）、**`peekRowItems()`**（只读缓存窥视 —— 给库封面用，**绝不触发上游**）、**`listByQuery()`**（库内容用 —— 把一条 Emby 列表查询路由到某个插件行） |
| `server/modules/emby/home/routes.js` | 上表 8 个面板自用端点（挂载在 501 通配之前） |
| `server/modules/emby/home/example.plugin.js` | 参考插件 |
| `server/modules/emby/home/plugin-dev.skill.md` | **面向用户**的插件开发文档（面板「下载开发文档」发出去的那份；本文是开发者契约，两份分工见「九」） |
| `server/core/tmdb.js` + `server/modules/emby/tmdb.js` | 前者是**协议层**（`get()` / `search()` / 图片拼串 / `test()`，配置读 `panel.json`），后者是 emby 专有层；`get()`（任意 TMDB 路径，`spawn.js` 代插件调用，带元数据缓存）、`imageBase()`（图床基地址，随 job 下发给沙箱）、`imageUrlOf()`（详情/季集拼图地址用） |
| `public/modules/emby/home.js` | 面板「首页插件」页：上传 / 启用 / 参数 / 预览 / 删除 |
| `data/emby/homepage/` | 运行时数据（插件代码、清单、私有存储） |
