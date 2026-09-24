# Emby 兼容开发指南

本面板要能对接真实 Emby 客户端。做法是**先只看客户端要什么，再逐条补齐被指定的端点**——不猜测、不预置。

---

## 一、铁律（不可绕过）

> **补哪些端点由部署者指定。实现方不得自行扩展。**
>
> 本文档中「部署者」= 部署并配置本面板的人；「用户」= Emby 客户端那一侧的用户（如「用户数据」「用户级数据」）。

具体含义：

- 只实现**被明确指定**的端点，一次一个。
- **不预置**任何 Emby 响应，**不猜测** API 形状，**不额外**加"看起来可能要"的接口或字段。
- 需要新端点时的顺序固定：**日志里先看到它 → 由部署者指定 → 才实现 → 记入本文档「已实现端点」表**。
- 本文档是端点清单的唯一来源；代码里不放未经指定的端点。
- **「留白端点」不算违反本条**：可以明确要求「端点通、数据空」——此时只返回 Emby 的合法空响应，并在代码与本文档里标注「留白」。判断标准是**这个决定由部署者做出**，不是实现方推测「先返回个空壳应该没错」。

### 另一条：项目未发布 —— 不为「迁移 / 旧状态」妥协

> **本项目尚未发布。不要为了"平滑过渡""兼容旧数据""照顾已有客户端状态"而留分支、加开关、留旧格式。**

- 判断标准是：**这条分支是为了"现在的代码更正确"，还是为了"迁就过去的状态"？** 后者一律不做。
- 实例：AccessToken 校验一度做成 `auth.mode`（`warn` 只记日志放行 / `strict` 回 401），理由是"客户端手上是校验上线前发的旧 token"——**已拆除**。正确做法是让客户端**重登一次**，而不是让校验长期存在一条"放行"路径。
- 与「数据搬迁」区分开：**一次性的 `migrateLegacy()` 可以有**（单账号明文 → sqlite、老 `settings.json` → `settings/`），因为那是"数据真的要丢"；**运行时的兼容分支/多模式开关不要有**。
- 同理适用于：Id 编码格式、设置字段名、备份格式 —— 该改就改，不留双写与双读。

## 二、日志（怎么看、看得到什么）

**两条查看路径**：

| | 看什么 | 留多久 |
|---|---|---|
| **面板「面板设置 → 日志」** | 整个面板进程的日志（内存里最近 N 条，默认 500，面板设置里改 `logMax`） | 进程重启即清空，**不落盘**（磁盘零增长） |
| **`docker logs media-bridge-panel`** | 同一份输出的**长期留档** | docker 的 json-file 自带轮转：`max-size 10m` × `max-file 3`，更老的自删 |

两者是**同一份输出的两个出口**：`server/core/logbus.js` 在启动时把 `console.log/warn/error` 包了一层 ——
**先照原样写到 stdout**（docker 那份一字不差），**再**存一份进内存环形缓冲（面板那份）。

### 日志口径：**每个请求都记一行，不做筛选**

**每个打到 `/api/emby/**` 的请求都记一行**，不按状态码筛：

| 结果 | 记哪些 |
|---|---|
| 成功 | 2xx：握手 / 登录 / 取用户资料 / 媒体库列表 / 条目列表 / 最新条目 / 详情 / 季集 / 相似 / 播放信息 / 拉流 302 / 下载 302 / 出图 200 / 账号列表 |
| 失败 | ≥400：401 没带 token、404 认不出的 Id、502 上游挂了、504 超时、400 参数不合法 |
| 失败 | 未实现端点（501 通配），行首是 `未实现#N` |
| 成功 / 失败 | 面板自用端点的**增删改**（账号增改删、TMDB 测试、清空缓存）—— 那是动凭据 / 动缓存的动作，留审计 |

**量靠别处压，不靠"少记"**：记录**不筛选** ——
① 面板「日志」页是**固定条数的内存环形缓冲**（默认 500，`panel.logMax` 可调），满了覆盖最老的，内存有硬上限；
② 页面上的「全部 / 警告以上 / 仅错误」是**看的时候再筛**，不影响记录；
③ docker 那份有 10MB × 3 的轮转。
⇒ 所以"哪条重要"由**查看者**决定，日志层不替部署者挑。

> 最近一次调整：一度做成"只记失败"，随即改回全记 ——
> 因为有了带过滤器的日志页，"量"已经不是问题；而"看不到正常请求"反而无法判断客户端在做什么。

### 结果行的形状（成功与失败是同一个形状，只差行首标记）

```
✔ emby 条目列表 Users/…/Items → HTTP 200 ?ParentId=catpawhome_…&Limit=30 items=20  example.tmdb/popular 库内容 → 本页 20 条 / 共 20001  [Rex/0.1.0]
✔ emby 最新条目 Users/…/Items/Latest → HTTP 200 ?ParentId=catpawhome_…&Limit=20 items=20  example.tmdb/now_playing 最新 → 20 条（顺序由模块决定） [VidHub/3.0.6]
✔ emby 图片 Items/tmdb_1204680_movie/Images/Primary → HTTP 200  76748 字节（索引） 573ms [Rex/0.1.0]
✘ emby 条目列表 Users/…/Items → HTTP 502 ?ParentId=catpawhome_…&Limit=30 items=-  example.tmdb/popular 库内容 → 上游连不上 [Rex/0.1.0]
✘ emby 条目列表 Users/probe/Items → HTTP 401 ?ParentId=…&Limit=20 items=-  token 校验不过：没带 token [VidHub/3.0.6]
```

| 部分 | 说明 |
|---|---|
| 标签（`条目列表 Users/…/Items`） | 哪条端点 |
| `HTTP <状态码>` | 200 / 302 / 401 / 404 / 502 / 504 … |
| query 摘要 | 客户端带了什么参数（**哪一页、哪个 `ParentId` / `MediaSourceId`**） |
| `items=N` | 回了多少条（`countOf`）。**失败时是 `-` 而不是 0** —— 不要把"没查成"看成"查到但是空的" |
| 原因 | `service` 给的 `log`：`token 校验不过` / `上游连不上` / `取图失败：fetch failed` … |
| `[客户端/版本]` | 取自 `x-emby-authorization` 的 `Client=`，退回 UA。**没有它等于没记**：三个客户端都打同一条端点，分不清是谁 |

### 未实现端点（501）的形状

```
✘ emby 未实现#12 GET /api/emby/System/Info?api_key=…&X-Emby-Token=… [VidHub/3.0.6]
```

一行：序号 + 方法 + 完整路径 + **query**（截断 400 字符）+ 客户端。响应体：

```json
{ "error": "EMBY_ENDPOINT_NOT_IMPLEMENTED", "path": "/api/emby/xxx", "logSeq": 12,
  "hint": "该端点尚未实现，已记录到面板日志" }
```

- `logSeq` 就是那行的 `#12`，便于把"这条响应 ↔ 日志里哪一行"对上。
- **query 一定留着**（虽然长）：那是判断"客户端到底要什么"的唯一线索 ——
  `Fields=` 里往往写着它想要哪些字段，`ParentId=` 写着它在逛哪个库。
  ⚠️ **但敏感参数一律掩码**：客户端把凭据塞在 query 里是常态（`?api_key=` / `?X-Emby-Token=`），
  原样打出来就是把凭据写进日志。判据是**子串**匹配（`log.js` 的 `SENSITIVE_KEY`：
  `token / secret / password / api_key / authorization / credential`…）——
  实测曾漏掉 `?X-Emby-Token=…` 一条（旧 `monitor.js` 用的是精确匹配，同样漏）。
- **不再打印 headers / body**：那几行既是噪音，也是内存占用的大头
  （body 上限 2000 字符，进内存缓冲很占地方）。`client / device / ver / ip` 那几个头也一并省了 ——
  客户端标记已经在行尾。body 里可能的明文密码（`Pw`）因此**根本不会再进日志**。

### query 摘要的规则（`emby/log.js` 的 `queryBrief`）

敏感参数（`api_key`、`token`…）值掩码；`Fields` / `EnableImageTypes` 这类超长又没诊断价值的压成 `…`；
单值截断 60 字符、总长封顶 300；**顺序保持客户端原样**（Emby 把 `ParentId` 放前面，关键信息不会被截掉）。

> 这段的起因很具体：已实现端点原先只打一行结果、不带参数，于是
> **"`Items` 到底带没带 `ParentId=<本面板的库Id>`"完全无从判断**，排查因此受阻。

### 怎么查看

```bash
# 面板里：「面板设置 → 日志」页（带 暂停 / 清空 / 复制 / 级别过滤）
docker logs media-bridge-panel                 # 长期那份（全部）
docker logs --since 10m media-bridge-panel     # 最近 10 分钟
docker logs -t media-bridge-panel              # 带时间戳
```

> **本机部署（路由器 docker）下即上述用法**。⚠️ **`docker logs --tail N` 在文件被截断过之后会卡住**
> （docker 还按旧偏移量找行），用 `--since` 没有这个问题 —— 清空之后一律用 `--since`。

### 清空

- **面板那份**：日志页上点「清空」（等价于 `DELETE /api/logs`）—— 只清内存缓冲，docker 那份不动。
- **docker 那份**：收到清空请求时直接清空（截断 json-file，**不用重启**）：

  ```bash
  : > "$(docker inspect --format='{{.LogPath}}' media-bridge-panel)"
  ```

  清空前**不要**先读取、统计或打印里面已有的内容（其中可能带客户端登录信息）；清空后只需回报「已清空」。

## 三、工作流

1. 启动面板（`npm start`）。
2. 在 Emby 客户端里把服务器地址指向本面板：填主机即可（`http://<面板地址>:8099`）；
   客户端会自己去打 `/emby/...`，面板把它归一成 `/api/emby/...`（也可以直接填
   `http://<面板地址>:8099/api/emby`，两种都收）。
3. 在客户端里正常操作（登录、进媒体库、播放……）。
4. **看日志**，把客户端要的端点与其参数记下来。
5. 把「这次要补的端点」交给实现方 —— **一次一个**。
6. 实现后，该端点返回正常响应，并把一条记录填进下面「已实现端点」表。

> 日志里所有 `501` 的端点 = 客户端想要、但还没有的端点。按需要挑，不必全补。
> 例外：已记进「六、明确无视的请求」的，连提都不用提。

## 四、实现一个端点时的要求

- 只动 `server/modules/emby/`；**不要**改其它模块来做兼容（需要聚合能力就走聚合层的 HTTP 接口）。
- 端点必须注册在通配路由 `ANY /api/emby/*rest` **之前**，否则会被通配吞掉。
- emby 层只依赖**聚合层**的接口，且是**进程内直调**：`require('../agg/api')` 拿 `detail()` / `play()`，**不再打自己的 `/api/agg/*`** —— 那条自调用不带面板 cookie，会被面板门禁（`core/auth.js` 的 `needsAuth`，`/api/` 开头一律要登录）挡成 **401**，表现为"每条详情只回元数据、播放链路全断"，而日志里只写 `UPSTREAM_HTTP http://127.0.0.1:<端口>`，看不出是 401。`/api/agg/detail` / `/play` 两个端点仍保留给前端与外部用，与 emby 层**共用 `agg/api.js` 里同一套编排**。
- 协议细节（`vod_play_from` 的 `$$$`、`vod_play_url` 的 `#`/`$`、`push://`、`play.url` 既可能是字符串也可能是数组）**留在聚合层**，emby 层不要重复解析——需要哪种形状时，先让聚合层提供对应的对外契约。
- 响应尽量贴 Emby 客户端的期望（字段名、大小写、分页参数），以客户端实测为准。
- **回空的响应不校验账号**（既定口径）：**没有数据可保护，校验只会有坏处** ——
  客户端不带 token 时会白白收到一个 401，而它本该拿到一个空列表。所以校验只挂在**真会返回数据**的路上。
  现在还适用的有：`GET /Studios`、`GET /Items/Counts`、`Users/{UserId}/Items` 里 `Filters=IsFavorite`
  与认不出的查询（判据收敛在 `service.itemsWillReturnData()` 一处，路由层与 `service.getItems` 共用）。
  **真数据的端点永远校验**（`Views` / `Items?ParentId=<本面板的库>` / 详情 / 季集 / **观看进度那一族** ——
  无 token 一律 401）。⚠️ `Items?Filters=IsPlayed` 自 [0023](adr/0023-playback-progress.md) 起**出真数据**，
  因此它也从"不校验"挪进了"必须校验"。
- ⚠️ **DTO 要给"完整形状"—— 客户端会因为缺字段而整条失败**（由 SenPlayer 实测发现，**这条代价最大**）：
  - **症状**：客户端拿到 `200` 之后**不再发任何后续请求**（正常时点开一条会紧跟一条 `Similar`），
    界面提示「网络错误 / 当前媒体库不存在该项目」。**它不是在抱怨某个字段为空，而是整条响应解不出来。**
  - **判据（怎么确认是形状问题而不是别的问题）**：拿**真机 Emby 的响应**当模板回同一路径
    —— 立刻正常就说明是形状；还不行才是别的原因。不要被"自己造的更丰富的假数据"误导：
    自造数据只能证明"缺 `MediaSources`"，证明不了"字段形状对不对"。
  - **哪些属于"必须有"**：真机每条都带的**结构性字段**。本项目已按真机（Emby 4.9.5）逐项对齐，
    清单与实测见「五」的**结构性字段**那条。要点：
    `ParentId`、`DateCreated`/`DateModified`、`Etag`、`SortName`、`PartCount`、`CanDelete`/`CanDownload`、
    `LockData`/`LockedFields`、条目级 `Container`/`MediaStreams`/`Path`、以及 **`People[].Id` / `Studios[].Id`**。
  - **数组字段一律给 `[]`，不要整个省略** —— 客户端把数组声明成非可选时，键缺失同样会整条失败。
  - **类型必须对**：真机 `Studios[].Id` 与 `GenreItems[].Id` 是**数字**、`People[].Id` 是**字符串**。
    原实现把 `GenreItems[].Id` 给成字符串、`Studios`/`People` 则不给 Id。
  - **客户端自己会说要什么**：Emby 客户端请求上带 `Fields=`（SenPlayer 的清单里有 `BasicSyncInfo`、
    `Container`、`MediaStreams`、`DateCreated`…）。**当前实现忽略 `Fields`、一律全给**（超集不会出错），
    但**它明确要求的字段一定要有** —— 排查时先把客户端的 `Fields` 抄下来逐项对。
- **「不知道就空字段」，不要照抄真机充数**（既定口径）：
  真机有、但**本项目并不掌握**的字段一律**不填**。据此**删掉**过这几个照抄来的：
  `SupportsProbing`、流级 `Protocol`（真机是 `File` 因为文件在本地，本项目是从 http 拉的）、
  `TimeBase`（真机来自**文件解析**）、`IsAnamorphic`/`IsInterlaced`/`IsHearingImpaired`（要探测文件才知道）、
  `ExtendedVideoType`（要知道 HDR 细类）。
  同理 `VideoRange` / 色彩三元组**只在源标了 HDR 时才给**，不假设 `SDR`/`bt709`。
  **能如实推导的可以给**（如 `AspectRatio` 由源给的宽高化简）；**纯占位标识符**（`Etag`、`PresentationUniqueKey`、
  `DisplayPreferencesId`）可以给，但**必须由内容/Id 稳定派生** —— 每次请求都变会让客户端缓存反复失效。
  ⚠️ 唯一一处"近似"是 `DateCreated`/`DateModified`：真机给**文件**的创建/修改时间，本项目没有文件，
  改用 **TMDB 发行日期**（拿不到发行日期就不给这两个字段）。

## 五、已实现端点

| 方法 | 路径 | 入参 | 响应 | 依据 |
|---|---|---|---|---|
| GET | `/api/emby/System/Info/Public` | 无 | 握手信息：`ServerName`（**面板「Emby → 连接设置」可改**，留空回落 `媒体桥`（`core/branding.js` 的 `name`））/ `Version(4.8.0.0)` / `ProductName` / `Id` / `LocalAddress` / `StartupWizardCompleted` | 部署者指定（客户端需先握手） |
| POST | `/api/emby/Users/AuthenticateByName` | `{Username, Pw}`（兼容 `Password`） | 200 `{User, SessionInfo, AccessToken, ServerId}`；账号未设置或校验不过 → 401 | 部署者指定（日志 #6 抓到该端点） |
| GET | `/api/emby/Users/{UserId}` | 路径参数 `UserId` | 200 `UserDto` 本体（不包层）；Id 不匹配 → 404；未设账号 → 401 | 部署者指定（客户端登录后紧接着就会要） |
| GET | `/api/emby/Users/{UserId}/Views` | 路径参数 `UserId`；客户端另带 `?IncludeExternalContent=false`（忽略） | 200 `QueryResult<BaseItemDto>`：**每个「启用」的首页插件行 = 一个库**，每项 `Id=catpawhome_<base64url(插件id\|行id)>`、`Name=行标题`、`Type=CollectionFolder`、`IsFolder=true`，**其余字段按真机逐项补齐（含封面 + `CollectionType`，见「五」下面那条）**；没有启用的插件行 → 空 `{Items:[],TotalRecordCount:0}`（与留白时期形状一致）；Id 不匹配 → 404；未设账号 → 401 | 部署者指定（由「留白」改为插件行的媒体库；其后补齐字段与封面） |
| GET | `/api/emby/Users/{UserId}/Items` | `ParentId=<库Id>`（面板发给客户端的 `catpawhome_…`，见 Views）；**`SortBy` 含 `IsFavoriteOrLiked` 且无 `ParentId`（「推荐」查询，喂首页轮播图）**；`StartIndex`/`Limit`（**原样透传给模块**，emby 不切片）；`Filters` | 200 `QueryResult<BaseItemDto>`：`ParentId` 是本面板的库 → **跑对应插件行**、HomeItem→BaseItemDto（`TotalRecordCount` = **模块返回的 `total`**）；**「推荐」查询 → 跑插件声明了 `feed: 'random'` 的那一行**；`Filters=IsFavorite/IsPlayed` → 空（没有用户数据）；**`AnyProviderIdEquals=tmdb.{id}` → 按外部 id 搜一条**（回 1 条带本面板 Id 的条目，见「五」）；**`SearchTerm=<词>` → 按名字搜**（TMDB `search/tv`+`search/movie`，回带本面板 Id 的多条，见「五」的「搜索」那条）；其余查询 → 空；**插件行取数失败 → 照实回失败码**；**AccessToken 只挂"真会出数据"的支路上** —— 空的分支（`Filters=…`、认不出的查询）**不校验**（判据 `service.itemsWillReturnData`，路由与 service 共用；`SearchTerm` 与 `AnyProviderIdEquals` 都算"会出数据"） | 部署者指定（改为「**列表数据由首页模块决定**」，emby 层只做端点映射 + 翻译；其后接上「推荐」查询与「按名字搜」） |
| GET | `/api/emby/Users/{UserId}/Items/Latest` | 路径参数 `UserId`；`ParentId=<库Id>`；`Limit`（**缺省 20**，真机默认值）、`StartIndex`（有效）；`Fields`/`Recursive`/`MediaTypes`/`IsPlayed`/`EnableImageTypes`（忽略） | 200 **裸数组** `BaseItemDto[]`（**不是 `QueryResult`**，真机实测响应直接以 `[` 开头）：`ParentId` 是本面板的库 → **跑对应插件行**、顺序**由模块决定**（emby 层不排序、不筛"入库时间"）；`ParentId` 不是本面板的库（含不带）→ **空数组**；**插件行取数失败 → 照实回失败码**；AccessToken 同 `Items`（只挂在真会出数据的路上） | **VidHub 3.0.6 的整个首页都靠它**（实测拿到 `Views` 后逐库打，10 个库 = 10 次）；此前被详情路由吞掉 → 501 → 首页空白（其后接上） |
| GET | `/api/emby/Shows/{Id}/Seasons` | 路径参数 `Id`（形如 `tmdb_95350_tv`）；**`UserId` 在 query 里**（同样校验）；`Fields`/`EnableTotalRecordCount=false`（忽略） | 200 `QueryResult<BaseItemDto>`：每季 `Id=tmdb_{id}_tv_s{n}`、`Type=Season`、`IndexNumber`(季号)、`SeriesId`/`SeriesName`、`ChildCount`(集数)；**特别篇（`season_number=0`）不返回**；非剧 Id → 404；UserId 不匹配 → 404；未设账号 → 401；TMDB 失败 → **照实回失败码** | 部署者指定（**占位**：TMDB 的 `seasons[]`，日志 emby#3 实测该端点） |
| GET | `/api/emby/Shows/{Id}/Episodes` | 路径参数 `Id`（**剧 Id，或季 Id —— 见下条**）；**`UserId` 与 `SeasonId` 都在 query**；`EnableTotalRecordCount`/`Fields`（忽略） | 200 `QueryResult<BaseItemDto>`：每集 `Id=tmdb_{id}_tv_s{n}_e{m}`、`Type=Episode`、`IndexNumber`(集号)、`ParentIndexNumber`(季号)、`SeriesId`/`SeasonId`/`SeasonName`、`Primary` 图=剧照、`RunTimeTicks`(有 runtime 才填)；**季定不下来（没带/认不出/不属于本剧）→ 200 空**；路径 Id 非剧 → 404；UserId 不匹配 → 404；未设账号 → 401；TMDB 失败 → **照实回失败码** | 部署者指定（**占位**：TMDB season 接口，日志 emby#1 实测该端点） |
| GET | `/api/emby/Users/{UserId}/Items/Resume` | 路径参数 `UserId`；`Limit`（截断用，硬顶 100）；`MediaTypes`/`Recursive`/`Fields`/`EnableImageTypes`（忽略） | 200 `QueryResult<BaseItemDto>`：**该账号有位置、还没看完的条目**，最近看的在前（数据来自 `playback` 表，见 [ADR-0023](adr/0023-playback-progress.md)，**排除被 `HideFromResume` 隐藏的**）；取不到元数据的行**不列出**（不编）；**无 token → 401**（回的是某个账号的观看记录） | 部署者指定（先是"如实回空"，后按 0023 换成真数据） |
| POST | `/api/emby/Sessions/Playing` | body JSON：`ItemId`（**本面板发出去的 Id**）、`PositionTicks`、`RunTimeTicks`（可缺）、`PlaySessionId`/`MediaSourceId`/`PlayMethod`（忽略） | **204 空体**（真机实测同为 204）；**无 token → 401**；`ItemId` 认不出（不是本面板的 Id）→ 也回 204 但**不写库**，日志写明被忽略 | 客户端上报（实测 SenPlayer 6.2.1 开始播放时发 1 次） |
| POST | `/api/emby/Sessions/Playing/Progress` | 同上（实测**每 10 秒一次**；`RunTimeTicks` 只有部分心跳带，缺了就用库里已有的顶住） | **204 空体**；其余同上 | 客户端上报（心跳；实测被 501 拒了也照发，所以必须收下） |
| POST | `/api/emby/Sessions/Playing/Stopped` | 同上（**空 body 也接受**，当空操作） | **204 空体**；位置 ≥ 时长 90% 判为看完（`played=1`、位置归零、进「已看」） | 客户端上报（实测停止/退出时发 1 次） |
| POST | `/api/emby/Users/{UserId}/Items/{ItemId}/HideFromResume` | 路径参数 `ItemId`（**本面板发出去的 Id**）；query `Hide=true`（移除）/ `Hide=false`（恢复）—— **缺省当 `true`** | 200 **`UserItemDataDto`**（真机实测同此，`UserData` 一个字段都不动）；本层只翻 `playback.hidden`，**不动位置**（`Hide=false` 之后位置还在）；**重新开始播放会自动取消隐藏**；库里**没有这一行**时：隐藏 → 写一行**占位**（位置 0，记下来才不会「移除了还在」）、恢复 → 不动库；**无 token → 401** | 客户端写（实测 Rex/0.1.0 / SenPlayer/6.2.1：在「继续观看 / 接着看」那一行上做移除） |
| POST | `/api/emby/Users/{UserId}/PlayedItems/{ItemId}` | 路径参数 `ItemId`（**本面板发出去的 Id**） | 200 **`UserItemDataDto`**（`Played:true`、位置归零，**`PlayCount` 不动** —— 真机实测同此）；**无 token → 401**；Id 认不出 → 204 且不写库 | 客户端写（实测 SenPlayer/6.2.1：标记已看） |
| DELETE | `/api/emby/Users/{UserId}/PlayedItems/{ItemId}` | 同上 | 200 **`UserItemDataDto`**（`Played:false`、`PlayCount:0`、位置归零，真机实测同此 —— 它还会去掉 `LastPlayedDate`）—— 行**留着**（时长与季集坐标对 `NextUp` 还有用） | 客户端写（同客户端：标记未看） |
| GET | `/api/emby/Users/{UserId}/Items/{ItemId}` | 路径参数 `ItemId`（面板发出去的 tmdb Id：`tmdb_{id}_{tv\|movie}[_s{n}][_e{m}]`）；`EnableImageTypes`/`Fields`（忽略） | 200 **单个 `BaseItemDto` 本体**（不包 `QueryResult`）：TMDB 元数据 + `ProviderIds.Catpaw="<站点key>\|<vod_id>"` + `CatpawSource{Lines, Target}` + **集才有 `MediaSources`（线路=版本，`Id` = `catpaw:` + base64url(JSON `{s,t,f,v}`)，`Path` 留到 PlaybackInfo 现取）**；**聚合取数失败只降级不回失败**（元数据照常 200）；Id 认不出 → **501**（如 `Items/ResumeXyz`）；TMDB 失败 → 照实回失败码；UserId 不匹配 → 404；未设账号 → 401 | 部署者指定（**元数据 TMDB + 线路/绑定走设置里的聚合地址**） |
| GET | `/api/emby/Studios` | 无路径参数；query `UserId`/`Limit`/`StartIndex`/`SearchTerm`/`Fields`（**全忽略**） | 200 **空** `QueryResult`：`{Items:[], TotalRecordCount:0}`（**如实**：服务端没有片库可枚举，详见「五」下面那条）；**不校验账号/UserId**（回空没有数据可保护） | 部署者指定（**回空，不是 501**） |
| GET | `/api/emby/Shows/NextUp` | `UserId`（在 **query**）、`SeriesId`（可选 —— SenPlayer 实测会带，只问某一部剧）、`Limit`（截断用）；`MediaTypes`/`Recursive`/`Fields`/`EnableImageTypes`（忽略） | 200 `QueryResult<BaseItemDto>`：该剧最近观看的那一集**未看完就回它自己**，**看完则回下一集**（同一季内找得到才回，找不到再试下一季第 1 集；都不存在就跳过这部剧），且**跳过被隐藏的集**（客户端移除之后让位给下一集）；**无 token → 401** | 部署者指定（SenPlayer 实测在要；按 0023 从"如实回空"换成真数据） |
| GET | `/api/emby/Items/Counts` | 全部忽略（含 `ParentId`） | 200 **`ItemCounts` 全 0**（14 个字段：`MovieCount`/`SeriesCount`/`EpisodeCount`/`GameCount`/`ArtistCount`/`ProgramCount`/`GameSystemCount`/`TrailerCount`/`SongCount`/`AlbumCount`/`MusicVideoCount`/`BoxSetCount`/`BookCount`/`ItemCount`）；**不校验账号**。**全 0 = "数不出来"，不是"库是空的"** —— 详见「五」下面那条 | 部署者指定（SenPlayer 实测在要） |
| POST | `/api/emby/Items/{ItemId}/PlaybackInfo` | 路径参数 `ItemId`（**必须是集或电影**）；`UserId` 在 query（可缺） | 200 `{MediaSources:[…], PlaySessionId}`：每条线路一个版本，`Id` = `catpaw:` + base64url(JSON `{s,t,f,v}`)（客户端播直连时回传的 `MediaSourceId` 就是它 —— **vod 编在里面**，拉流那一格才不用回头再搜一次；**为什么必须编码**见下面「线路 + 源绑定」那条，一句话：线路名里的 `#` 会被 URL 当锚点吃掉）、**`Path` 指向本面板的 Stream 端点**（稳定坐标，不含时效 token；实测客户端**不读它**，走 `videos/{Id}/stream.{ext}`）、`RequiredHttpHeaders:{}`、**`Container`/`Size`/`RunTimeTicks`/`MediaStreams`（编码/分辨率/HDR，来自源在集名里的标注）**；Id 不是集 → 404；TMDB / 聚合失败 → 照实回 | 部署者指定（客户端点播放前必来） |
| GET | `/api/emby/Items/{ItemId}/Stream` | 两种形状：**① `Path` 用的** `/Stream/{token}[/{文件名}]`（`token` = base64url 的版本 Id，自带站点/线路/vod；末段文件名只为版本行副标题）；**② 手工调试** `?src=<版本 Id>`（新的 base64url，或旧版明文 `catpaw:<站点>:<线路>[\|<vod>]`，`parseCatpawSourceId()` 两种都拆）、`vod` 可缺（src 里自带就用自带的）。两种都可带 `UserId`（可选，**有就校验**） | **一律 302**（"面板代为转发"那条路已删，见下面「拉流」一节）；`src` 认不出 → 400、两个来源都没有 vod → 400；Id 非集 / 定位不到这一集 → 404；聚合或 play 失败 → 502（照搬上游码）；`push://` 之类非直连 → 501 | 部署者指定（拉流最后一格；**实测客户端走的是下一行那条**，这条留作备用/调试） |
| GET | `/api/emby/videos|Videos/{ItemId}/stream[.{扩展名}]` | 路径参数 `ItemId`（集/电影）；**`MediaSourceId=<版本 Id>`（必填，base64url 的 Id，vod 编在里面）**、`Static=true`/`PlaySessionId`/`api_key`/`X-Emby-Token`（**query 里忽略**，只在请求头里认）；面板自己发出去的 `DirectStreamUrl` / `Path` 带的是 query 的 **`api_key`**（真机也有 `AddApiKeyToDirectStreamUrl` 这个取向）—— 写成 `X-Emby-Token` 等于没带，客户端自己会带头所以看不出差别，但把 URL 交给外部播放器/投屏时就会 401；扩展名来自 `MediaSource.Container`（实测 `stream.mkv`） | 与上一行**同一条实现**（路由层共用 `serveStream`）：**一律 302**；`MediaSourceId` 认不出 → 400；`:file` 不是 `stream[.ext]` → **501**（记日志，`original.{ext}` 未见过不提前实现） | **实测要求**（日志 emby#39~#45：客户端播直连打的是**这条**，不是 `Path`）。**两种大小写都注册**：路由区分大小写，而 Emby 官方路径是**大写** `Videos` —— 实测 Lumenic/1.0.0 打的是大写（先白吃一个 501，随后才退回小写拿到 302） |
| GET | `/api/emby/Items/{ItemId}/Download` | 路径参数 `ItemId`（集/电影）；**`MediaSourceId=<版本 Id>`（必填，base64url 的 Id，vod 编在里面）**、`DeviceId`/`PlaySessionId`（忽略）；`UserId` 可选（**有就校验**），token 三种带法都认 | **一律 302**（与拉流**同一条实现** —— 路由层共用 `serveStream`，只是日志那行写「下载」）；`MediaSourceId` 认不出 → 400；Id 非集 / 定位不到这一集 → 404；聚合或 play 失败 → 502（照搬上游码）。⚠️ 302 之后 `Content-Disposition`（文件名）/`Content-Type`/断点续传**全由源站决定**，面板改不了 —— 要「片名.S01E01.mkv」那种名字只能代为转发全量字节，与 [ADR-0006](adr/0006-redirect-for-playback.md)「面板不扛流量」冲突，故不做 | 客户端实测（SenPlayer/6.2.1 12 小时里试 8 次、每次吃 501 → 一直重试）。同族的 `Items/{ItemId}/File` 日志里**没出现过**，按"等客户端日志暴露再接线"**先不做** |
| GET | `/api/emby/Items/{ItemId}/Images/{type}[/{index}]` | 路径参数 `ItemId`（面板发出去的条目 Id）、`type`（`Primary`/`Backdrop`/`Logo`…）、`index`（多张背景图时客户端逐张要；**忽略**）；query `tag`（**本面板签发的签名 tag —— 本侧的唯一取图凭证**）、`maxWidth`/`quality`/`ImageTypeLimit`（忽略） | **200 图片字节**（面板代为取图，`Content-Type` 照上游）；`tag` 缺失/验签不过 → **404**；取图失败 → 502。**豁免 AccessToken**；tag = `cpimg.<base64url(图片URL)>.<签名>`。官方把 `Tag` 定义为**可选**（只影响缓存强弱），但直链只存在于 tag 里，故**认不出即 404**；按 `Id` 反查 TMDB 的兜底**已拆除**（见下「图片」那条） | **实测要求**（客户端点开条目后随即请求 `Images/Primary` / `Images/Backdrop`，且**不带任何凭证**；`/index` 形状随多张背景图一并加上，**待实测**） |
| GET | `/api/emby/Items/{ItemId}/Similar` | 路径参数 `ItemId`（面板发出去的 tmdb Id）；`UserId` 在 query（同样校验）、`Limit`（切前 N 条）、`Fields`（忽略） | 200 `QueryResult<BaseItemDto>`：**TMDB 的相似推荐**（`recommendations`，与详情**同一次请求**就拿到）；Id 认不出 → 404；TMDB 失败 → 照实回失败码。**响应形状按 QueryResult 实现、待客户端实测复核**（若客户端不渲染，第一个要试的是 `RecommendationDto[]` 那种分组形状） | 部署者指定（**归 emby 层** —— 按坐标反查 TMDB，与季/集同类；不是"有什么"，所以不走首页模块） |

**实现约定**

- **账号来源（多账号）**：面板「Emby → 连接设置 → 账号管理」→ `data/emby/emby.db`（Node 内置 sqlite，见 `db.js`）。
  - **可以有多个客户端登录账号**，各自派生一个独立的 `User.Id`；账号表为空时登录一律 401，并在响应与日志里提示先去添加
  - 用户名比较：`NFKC` 归一 + 忽略大小写（**登录、查重、UserId 派生三处必须同一套规则**，否则会出现「登录成功但取资料 404」）
  - 密码存 **scrypt 哈希**（`scrypt$N$r$p$klen$salt$hash`，参数自描述便于以后换算法）；**忘了只能删掉重建**，库里没有明文
  - 老的单账号（`settings/emby.json` 的 `account.{username,password}` 明文）在首次用到库时自动迁移成第一条账号，**并把设置里的明文清空**（清空是无条件的：只靠"表为空才导入"会漏 —— 从旧备份还原出带明文的设置时会跳过导入、明文却留着）
  - 面板自用端点：`GET/POST /api/emby/accounts`、`PUT/DELETE /api/emby/accounts/{id}`（见「五」末尾的表）
- **服务器 Id**：首次握手时生成一次并写入设置（`serverId`），保证客户端缓存的服务器身份稳定；`User.Id` 由「serverId + 用户名」派生（**多账号下规则不变**）。
  - 推论：**改用户名或删账号 = 那个账号的 `User.Id` 变了 → 该客户端必须退出重登**（面板上有提示）
- **UserDto 复用**：登录响应里的 `User` 与 `GET /Users/{id}` 返回的是同一个对象（同一个 `buildUser`），避免两处字段不一致。
- **取用户资料的分支**：按 `Id` 反解账号（**不存 user_id 列，运行时现算**：serverId 一变库里那列就全废，现算永远自洽）—— 解析不出时，账号表为空 401、否则 404（不是 403）。
- **媒体库（`Users/{UserId}/Views`）—— 不再是留白**：把**每个「启用」的首页插件行**做成一个 Emby 媒体库（`Type: CollectionFolder`），客户端据此在首页列出这些库。数据取自插件 `registry` 的**快照**（不加载插件代码、不起沙箱 —— Views 是高频端点）。
  - **Id = `catpawhome_` + base64url(`<插件id>|<行id>`）**：插件 id 与行 id 都允许 `.`/`_`/`-`，用分隔符硬拼没法可靠反解，所以**整体编码**；base64url 字符集只有 `[A-Za-z0-9_-]`，URL 安全（不会像 `#` 那样被客户端当锚点吃掉 —— 同 `catpawSourceId` 那次的问题）。派生与解析是一对（`home.viewId` / `home.parseViewId`），**代码里挨着放**。
  - **与 `tmdb_*` 不冲突**：`tmdb.parseItemId()` 认不出 `catpawhome_*`，所以这类 Id 只属于 Views。
  - **库条目的字段（按真机逐字段补齐）**：真机 25 个库的响应逐项对过，现在两边字段**一一对应**。取值来源如下，**推不出来的一律不填**：

    | 字段 | 本面板给什么 | 依据 |
    |---|---|---|
    | `Guid` / `PresentationUniqueKey` / `DisplayPreferencesId` | `md5('view|'+库Id)` | 真机 25/25 里这三个是**同一个 GUID**；本面板的库 Id 不是 GUID 形状，派生一个**稳定**的 |
    | `Etag` | `md5(库Id\|库名\|封面URL)` | 真机是库内容指纹；本面板的"库"就是这一行 |
    | `DateCreated` | **占位值** `0001-01-01T00:00:00.0000000Z`（与下一行同一个，Emby 自己的零值） | 真机是库创建时间，本面板既没有"建库"动作、TMDB 里也没有"这一行"这个实体 —— 拿不到任何真实时间。**改法**：原先用"库首次出现在响应里的时刻"（`view_seen` 表）近似，但那是个**不可再生**的值（表一丢所有库就"全新建了"），为它维护一张表代价过高；既定口径是"给个一看就知道是占位的值"。⚠️ 必须是**合法时间**：`0000-00-00` 那种非法日期会让客户端的 DateTime 解析整条失败 |
    | `DateModified` | `0001-01-01T00:00:00.0000000Z` | 真机 25/25 **全是**这个零值（Emby 的"从未修改"），照给同一个值 |
    | `CanDelete` / `CanDownload` | `false` | 真值 |
    | `SortName` / `ForcedSortName` | 库名 | 真机也是名字 |
    | `ExternalUrls` / `Taglines` / `RemoteTrailers` | `[]` | 真机 25/25 就是空 |
    | `ProviderIds` | `{}` | 同上 |
    | `BackdropImageTags` | `[]` | 真机**有封面的库**这里也是 `[]`（封面只在 `ImageTags.Primary`） |
    | `LockedFields` / `LockData` | `[]` / `false` | 真值 |
    | `CollectionType` | 行声明（`movies`/`tvshows`/`mixed`）→ 按该行 `type` 参数推 → `mixed` | 真机每个库都有；见首页插件指南的 `collectionType` |
    | `ImageTags.Primary` + `PrimaryImageAspectRatio` | 封面见下；**没有就都不给**（`ImageTags: {}`、不给 ratio） | 真机无图的库正是这个形状 |
    | `UserData` | `{PlaybackPositionTicks, IsFavorite, Played}` | 真机库条目就是这三个（比普通条目**少** `PlayCount`） |
    | `ParentId` | **不给** | 真机 25/25 都是 `"2"`（服务器根节点），本面板没有那个节点 —— 给了就是指向不存在的东西 |
  - **库封面**：封面用的是**该行里第一个带横图（`backdrop`）的条目** —— 那是 TMDB 顺路带回来的数据，**为零个额外上游请求**。
    - 两条取值路：① 图片索引（持久，默认 90 天，重启后仍在）→ ② 该行的**内存结果缓存**（客户端逛过一次就有）。两条路都**只在本地读**；**绝不为了封面单独打 TMDB**（代价随库数线性增长）。
    - 只用**横图**，所以 `PrimaryImageAspectRatio` 恒为 `1.7777777777777777`（真机库封面基本 16:9）；竖图海报硬当库封面会变形，宁可不给。
    - **冷启动**（面板刚重启、客户端还没逛过）那一轮就是**没有封面**——如实，不编。（`peekRowItems` 只读缓存，不触发上游。）
  - **行内容**：客户端为某个库去要条目时打 `Items?ParentId=<库Id>`（见「五」），由 `home.listByQuery` 路由到那一行。
  - 停用/启用的插件行即时生效（Views 每次现读 registry），客户端可能要**重启或清缓存**才会刷新库列表。
- **AccessToken 校验（已实现）**：登录发的 token 落 `data/emby/emby.db` 的 `sessions` 表，之后每个受保护端点都校验它 —— **没有"宽松/严格"之分，校验就是校验**（拿不到有效 token 一律 401，与官方对 401 的定义一致：token 无效或被吊销，客户端应回登录界面）。
  - **三种带法都认**（`service.tokenFrom`）：头 `X-Emby-Token`（官方文档写明的标准带法）、`X-Emby-Authorization` / `Authorization` 里的 `Token="…"`、query `api_key=`（官方把它归为 API Key 认证，可实测客户端把**用户 token** 也塞在这个槽里拉流）
  - **保护范围**：`Users/{id}` / `Views` / `Items` / `Items/Latest` / `Items/{id}`（详情）/ `Shows/*/Seasons` / `Shows/*/Episodes` / `PlaybackInfo` / `Stream`×2 / `videos/*` / `Items/{id}/Download`，共 12 条。请求里带了 `UserId` 时，**该 Id 必须属于这个 token 的账号**，否则 401（避免拿 A 的 token 当 B 用）
  - **豁免**：握手 `System/Info/Public`、登录 `AuthenticateByName`、面板自用端点（账号管理、tmdb 测试）、以及 **501 通配**。**图片端点也必须豁免**：实测**图片请求的凭证携带并不统一** —— 同一批 8 条 `Items/{id}/Images/*` 里，5 条带 `x-emby-authorization`（Rex-Standard），**3 条什么凭证都不带**（原生 `Rex/13 CFNetwork` 客户端，头里只有 `accept`/`user-agent`）。要求 token 会让那部分客户端图全挂。（对照：**非图片请求 9/9 都带 `x-emby-token`**。）
  - **生命周期**：改密或删账号 → 该账号的所有 token 一并作废（客户端需重新登录）；`last_seen_at` 每次请求更新（60 秒节流，拉流时不会每个 Range 都写库）
  - **还没做**：官方登出端点 `POST /Sessions/Logout`（客户端"退出登录"目前打到 501 通配，token 不会被吊销）、`/Users/Public`（登录界面取用户列表）
  - **换新号/重登**：校验上线**之前**发出的 token 不在表里 → 客户端会被一路 401，**在客户端退出重登一次**即可（`sessions` 表里就有了）
- **TMDB 失败一律照实回失败**：**不编占位数据、不回空的假成功**。状态码 = 上游的真实原因，由 `tmdb.httpStatusOf()` 一处决定：

| 失败原因 | 回的码 |
|---|---|
| 上游给过状态码（`401/403/404/429/5xx`…） | **照搬那个码** |
| 网络不可达（连不上） | `502` |
| 请求超时（10s） | `504` |
| 面板还没配 token | `500`（是面板没配好，不是客户端的问题） |
| tmdb id 不合法 | `400` |

  响应体形如 `{"error":"连不上 TMDB：ECONNRESET","code":"NETWORK","tmdb":"tv/95350"}`（`code` 是内部错误分类，便于日志对照）。
  **网络类失败会先立即重试一次**（`core/tmdb.js` 的 `requestWithRetry`，日志里是 `↻ tmdb NETWORK，立即重试一次：…`）——
  经过代理的网络里 TMDB 链路可能不稳定（实测会在握手阶段被中断），重试能把单次抖动的成功率拉回来；
  **确定性失败（401/404）不重试**（重试没有意义），失败仍然**不写缓存**。
- **兼容取向**：握手对外自称 `Emby Server 4.8.0.0` —— 客户端按 Emby 的版本号判断能力，这是刻意的兼容选择。
- **条目列表（`Users/{UserId}/Items`）—— 「列表数据由首页模块决定」**（部署者指定）：
  emby 层在这里只做**端点映射 + DTO 转换**，不再自己造列表数据。六条分支：
  0. **`SearchTerm=<词>` → 按名字搜**（见下面「搜索」那条）—— 排在前面因为它最具体
  1. `ParentId=<catpawhome_…>` → `home.listByQuery()` 跑对应插件行 → `HomeItem` → `BaseItemDto`；**`StartIndex`/`Limit` 原样透传给模块**（进 `ctx.startIndex`/`ctx.limit`，**emby 层不切片** —— 取哪一页是模块的决定），`SortBy`/`Recursive`/`IncludeItemTypes` 忽略；`TotalRecordCount` 用**模块给的 `total`**
  2. **「推荐」查询**（无 `ParentId` + 无 `Filters` + `SortBy` 含 `IsFavoriteOrLiked`）→ 路由到**插件声明了 `feed: 'random'` 的那一行**（见下面「推荐查询」那条）
  3. `Filters=IsPlayed` → **读 `playback` 表**出已看的条目（真数据，要 token）；`Filters=IsFavorite` → 空（没有收藏数据，**如实**）
  3.5 `AnyProviderIdEquals=tmdb.{id}` → **按外部 id 搜一条**（见下面那条）—— 与「搜索」同类：**检索归 emby 层**，不归首页模块
  4. 其余查询（含认不出的 `AnyProviderIdEquals`）→ 空
  - **搜索（`SearchTerm=<词>`）**：**按名字搜**，数据来自 TMDB 的 `search/tv` 与 `search/movie`。
    - **为什么要加**：SenPlayer 6.1.8 的搜索框打的就是这条 —— `Items?...&IncludeItemTypes=Movie,Series,Video,Person&Recursive=true&SearchTerm=斗破苍穹`，
      以前落到「没有可识别的查询参数 → 空」，日志里连打 4 次 `Items=0`（搜索框永远是空的）。
    - **归属**：**归 emby 层**（与详情/相似同类）—— 它是"按名字去 TMDB 反查"，不是"这台服务器上有哪些片"。
    - **真机模板**（`emby.example.com`，实测）：同一条 query → `TotalRecordCount: 7`（剧 + 电影混排），
      列表项只有 **11 个字段**（`AirDays/BackdropImageTags/DateCreated/Id/ImageTags/IsFolder/Name/RunTimeTicks/ServerId/Type/UserData`）
      ⇒ 客户端对"搜索卡片"没有更多期待；本面板给的 42 个字段是**超集**（超集不会出错，见「四」）。
      顺带实测：真机的 `GET /Search/Hints` 回的是**空数组**（该服务器没实现）—— 所以不照抄那条，只做客户端真正在用的这条。
    - **三条实现口径**（都写在 `getSearchItems()` 的注释里）：
      ① **不为结果再打 `lookup()`** —— 搜索行里的名字/简介/海报/横图/年份/评分够画卡片，`lookup({rich:true})` 留给**详情**
        （客户端点进某条时本来就会打详情）；代价是**每类型 1 次上游**，不是"结果数 × 1 次"。
      ② **只取上游第 1 页**（每类型 20 条，`Limit` 缺省 20 / 硬顶 40）：`StartIndex`/`Limit` 在这堆结果里切片，
        `TotalRecordCount` = **手里的条数**（"TMDB 里有多少条"无从得知，不编）。
      ③ **跨类型按名次轮流合并**（tv#1, movie#1, tv#2, …）：两份列表各自保留 TMDB 的相关度次序。
        曾按 `popularity` 降序合并，**实测是错的**：搜「斗破苍穹」会把一个叫 `111` 的剧排到第 7 位、把真正相关的电影挤下去。
    - **`IncludeItemTypes`**：`Series`→tv、`Movie`→movie，**两个都没给 = 都搜**；`Video`/`Person` 忽略（分集搜索要按剧集层级走，人物不是本项目的条目 —— 不假搜）。
    - **失败**：全失败 → 照实回失败码；一类型失败另一类型有结果 → 回有结果的部分 + 日志写明（部分失败 ≠ 整条失败）。
    - **鉴权**：它**真会出数据** ⇒ `itemsWillReturnData()` 里已加上它，无 token 一律 **401**（实测 `curl` 不带 token → 401）。
    - 实测（路由器）：`斗破苍穹` → **14 条**（剧 + 电影，`tmdb_79481_tv` / `tmdb_1206282_movie` …，均带图、可点进详情）；
      `律师` + `IncludeItemTypes=Series` + `Limit=5` → 20 条里切 5 条；不存在的词 → **0 条**；
      第 1 次 250~1300ms（看 TMDB 抖动）→ **第 2 次 111ms**（走 `name_index`，见「本地缓存」那条）。
      ⇒ 客户端侧已生效：日志里紧接着出现 `Items/tmdb_241007_tv/Images/Primary`、`tmdb_1599184_movie` 等**取图请求**（搜索卡片在渲染）。

  - **`AnyProviderIdEquals=tmdb.{id}`**：**按外部 id 搜一条**。
    客户端手里只有一个 tmdb 号（外部链接 / 书签 / 它自己记着的），**拼不出本面板的 Id**，需要向本面板确认
    「这条在本面板的 Id」；本面板回**一条带 Id 的条目**（`tmdb_{id}_{movie|tv}`，`TotalRecordCount: 1`），
    它拿到就接着打详情。类型从 `IncludeItemTypes` 推（`Series`→tv / `Movie`→movie / 都没给→tv）；
    取不到 **照实回失败码**（不编占位条目）。
    - **它被删过一次又恢复**：曾以「emby 层自己造列表数据、与首页模块口径冲突」为由删掉，
      依据是「实测客户端 0 次使用」。但 —— ① **模块管的是首页渲染**（给客户端什么样的行列、每个条目的 Id），
      **详情 / 搜索 / 播放本来就归 emby 层**；② 删它之后**详情那条路一直在做同一件事**（`tmdbItemDto()` 按坐标反查），
      只会让两条路不自洽；③ 那条「0 次使用」的依据**已被 Rex/0.1.0 推翻**（它连打两条
      `AnyProviderIdEquals=tmdb.1339713`，回空之后拿不到 Id、链路就断在那儿）。
    - 结论同 `Items/Latest`：某条查询「没人要」**只对当时那批客户端成立**。
  - **顺带修了一处回归**：`Items/{ItemId}` 详情原本靠「复用列表实现挑那一条」拿电影/剧的元数据，列表改口径后它会 404 —— 现在改成**直接 `tmdbItemDto()` 反查**（季/集仍复用 `getSeasons`/`getEpisodes`）。**"点进去 → TMDB 反查"这一环不能断**。
  - 条目 Id 由插件给出，**建议**（非强制）是 `tmdb_{id}_{tv|movie}` —— 点进去要靠这个坐标反查（见插件指南「五」）；插件给了别的 Id 也能显示，只是点进去没有资源，**emby 层不兜底**。
  - **条目给 `ImageTags`**：图片端点已实现，所以列表/详情都照给；tag 是**签名 tag**（见下面「图片」那条）。
  - `Filters=IsFavorite` 直接回空：没有收藏数据（见「六、明确无视的请求」），空是**如实**，不是留白；
    `Filters=IsPlayed` 读 `playback` 表出**已看条目**（见 [0023](adr/0023-playback-progress.md)），因此**要 token**。
  - 响应形状就是 Emby 的 `QueryResult<BaseItemDto>`：`{Items, TotalRecordCount}`。官方定义只有这两个字段（已核实）。
  - `Id` 由 tmdb 坐标派生：`tmdb_{id}_tv` / `tmdb_{id}_movie`（带类型是因为 TMDB 里 tv 95350 与 movie 95350 是两条数据）。**不含源信息** —— 客户端把它当主键缓存，掺进"哪个站点、哪次搜索"就会因为源变动而变 Id，客户端缓存的「已看」会全丢。
  - `ImageTags` / `BackdropImageTags` 的 tag 是**签名 tag**，内容就是"这张图的完整 URL"，见下面「图片」那条。
  - `UserData` 只回空进度（`Played/PlayCount/PlaybackPositionTicks/IsFavorite`），没有任何观看记录。
  - **「推荐」查询（无 `ParentId` + `SortBy` 含 `IsFavoriteOrLiked`）**：
    这条 query 喂的是**客户端首页顶部的轮播图**（实测 Rex 首页**第一发**，比 `Views` 还早 42ms ——
    它在**还不知道有哪些库**的时候就要结果，按库驱动的行不可能这么发）。
    - **怎么认出它**（`service.feedOfQuery`，三条都不猜）：没有 `ParentId` + 没有 `Filters` + `SortBy` 里含 `IsFavoriteOrLiked`。
    - **路由到哪一行**：**插件自己声明** —— 清单一行的可选字段 `feed: 'random'`（见插件指南「三」）。
      宿主 `home.rowByFeed()` 找**第一个声明了它的启用行**；**没有插件声明 → 照旧回空**。
      绝不"挑一行顶上"：挑错了等于给出与内容不符的路由，而且哪一行该接这条只有插件作者知道。
    - **语义要说清**：这条 query 的原意是"用户**收藏或喜欢的**、随机"。本面板**没有收藏数据**，
      所以只能按「随机推荐」理解 —— 给的是**随机热门**，**不是**用户的收藏。不要在任何地方把它当作收藏。
    - 它接上之后**也变成受保护端点**：`itemsWillReturnData()` 对这条返回 true，无 token 会 401
      （以前回空所以不校验）。判据仍然只收敛在 `itemsWillReturnData()` 一处，路由与 service 共用。
- **图片（`Items/{Id}/Images/{type}`）**：客户端取图时**只回传 `Id` + `tag`，不回传 URL**，所以 tag 得自己带上"图在哪"：
  - **tag = `cpimg.<base64url(图片URL)>.<签名>`**（`service.imageTag` / `parseImageTag`）。签名 = HMAC-SHA256(密钥, `Id|URL`) 取前 22 位。
  - **为什么要签名**：这个端点**必须豁免 token**（实测图片请求的凭证携带不统一，8 条里 3 条啥都不带），那它就是个"面板代为取任意 URL"的接口 —— 不签名等于把面板变成局域网 / Tailscale 上的**开放代理（SSRF）**。签名绑 `Id|URL`：tag 挪到别的条目上用不了，也造不出新 URL（实测：篡改 tag / 换条目 / 伪造 URL 全部 404）。
  - **密钥 `imageKey`**：首次用到时随机生成、落 `data/settings/emby.json`，**不随任何 DTO 外发**（`serverId` 是外发的，不能当密钥）。
  - URL 从哪来：**详情/季集**由 `tmdb.imageUrlOf()` 拼图床地址；**列表/库内容**直接用插件给的 `poster`/`backdrop`（完整 URL，见插件指南「五」）。所以两种来源统一成同一种 tag 形状，端点不必分类讨论。
  - **面板代为取图**（不是 302）：图很小；而且插件给的图地址可能是客户端根本连不到的地方。单张上限 8MB（海报正常几十 KB～1MB）。
  - **协议背景（关键，不要再重新引入这条路）**：Emby 里 `BaseItemDto` **没有任何"图片直链"字段** —— 图片相关字段只有 `ImageTags`（类型→tag 映射）、`BackdropImageTags`（数组）、`PrimaryImageTag` / `PrimaryImageItemId`（主图的便捷字段）、`Parent*ImageTag`、`PrimaryImageAspectRatio`。客户端**一律自己拼** `{host}/Items/{Id}/Images/{Type}/{Index}?Tag=…`。所以"把直链交给客户端让它自己加载"在协议下**没有这条路**（面板自己的预览页能用直链，那是本项目的 UI，不是 Emby 客户端）。
  - **官方定性：`Tag` 是可选参数**（Images 文档原文："This is an optional parameter. You do not have to specify the tag, but without it you will only receive conditional http response caching."）。它的正经用途是**缓存**：图变了 tag 就变、URL 跟着变，客户端就能无条件永久缓存。本项目的非常规做法是**拿这个缓存字段当数据通道**（把直链 base64 编进去），因为协议里没别的地方能放直链。
  - **Primary 的 tag 有两个存放位置**：`ImageTags.Primary` **和**便捷字段 `PrimaryImageTag`。只填前者时，**读便捷字段的客户端会认为"这张图没有 tag"**，于是裸请求 `Images/Primary`。而 Backdrop 只有 `BackdropImageTags` 一处 —— 这正好解释实测里那个异常现象：**同一个客户端 Backdrop 带 tag（6/6 成功）、Primary 不带 tag（340 次 404）**。修法是 `baseItem()` 里两个字段都填（`PrimaryImageItemId` 一并指向自己）。
  - **补 `PrimaryImageTag` 并没有解决问题**（实测，别再重复这条路）：客户端照样裸请求，200 次全 404。决定性证据是**时序** ——
    ```
    12:33:03.287  ✔ 登录 Lumenic (iPhone)
    12:33:03.291  ✘ 图片 tmdb_1423191/Primary 404   ← 登录后 4ms 就要图
    12:33:03.504  ✔ Views → 200                     ← 213ms 之后才拿到列表
    ```
    **要图发生在拿到列表之前** —— 客户端用它**自己持久缓存的条目 Id** 发起请求，这次会话给它的 DTO 根本没参与。所以"给它 tag 它就会带"这个假设不成立：这个客户端（以及很可能同类客户端）**按设计就不读 Primary 的 tag**，而这是合规的（tag 本就可选）。
  - **最终方案：两条取图路**
    | 路 | 触发 | 代价 |
    |---|---|---|
    | ① tag | 客户端把 tag 带回来了、验签通过 → base64 解出 URL | 0 上游 |
    | ② **本地图片索引** | 没带 / 验签不过 → 查 `image_index` 表 | 0 上游 |
    | ③ 都没有 | — | **404** |
  - **图片索引**（`service.tagAndRemember` 写、`service.imageUrlFromIndex` 读）：
    - **写入零成本**：`baseItem()` 本来就在算 tag（URL 就在手边），同时把 `Id|类型|索引 → 图片位置` 记进 `cache.db`。出 tag 与记账绑在**同一个函数**里，两者不可能漂移。
    - **按模块给的 id 记**，不依赖 tmdb 坐标 ⇒ **自定义 id 的插件也能取到图**（这条推翻了插件指南里原来那条警告）。
    - **无头存**：TMDB 图床的地址剥掉基地址只留相对路径（`tmdb.splitImageUrl`，如 `w500/x.jpg`），取的时候再拼**当前**基地址（`tmdb.joinImageUrl`）⇒ **换图床镜像立刻生效，不用清缓存**；别处的绝对地址原样存。判据用"值里有没有 `://`"，无歧义。
    - 落 `data/emby/cache.db` 的 `image_index` 表，TTL 90 天、上限 5MB（默认，面板可改）。**落库顺带解决了冷启动**：容器重启后索引还在，客户端启动那批缓存 Id 的请求直接命中（实测重启后无 tag 取图仍 200）。
  - **明确不做**：不回退"按条目 Id 反查 TMDB"。那条路随片库规模**线性**烧配额（实测 340 次请求 ≈ 55 次调用，注意这是**元数据账**，与图片字节流量是两回事）—— 走了两个弯才定下来：先补 `PrimaryImageTag`（没用），再拆掉反查（对但没解决问题），最后用零成本的本地索引。
  - 日志会区分来源与成因：成功时 `（索引）` 表示走的是第②条；404 时会写明「客户端没带 tag」/「tag 非本面板格式」/「tag 验签不过」，并注明索引也没有。
  - **签名仍是这里唯一的 SSRF 防线**：端点豁免 token，URL 只认签过的（第①条）或自己记过的（第②条），客户端造不出新 URL。

- **详情页"丰富度"（一次性补齐）**：详情的元数据来自 TMDB 的 `lookup({rich:true})` —— **一次请求**带上 `append_to_response=credits,external_ids,keywords,videos,images,recommendations`（电影再加 `release_dates`、剧加 `content_ratings`），把下面这批一起拿回来（`service.applyRich`）：
  | 详情页上的东西 | Emby 字段 | 数据来源 |
  |---|---|---|
  | 年龄分级徽章 | `OfficialRating` | 电影 `release_dates`、剧 `content_ratings`（优先美国，没有就取第一个有值的） |
  | 时长 | `RunTimeTicks` | 电影 `runtime`、剧 `episode_run_time[0]`；1 分钟 = 6×10⁸ ticks |
  | 标语 | `Taglines[]` | `tagline` |
  | 演职人员 | `People[]`（**带 `Id`，有头像的还带 `PrimaryImageTag`**） | `credits`：演员前 20（`Role` = 角色名），幕后只要导演/编剧（翻成 Emby 的 `Type`）；`Id` = **TMDB 人物 id**（是**真 id**，不是编的） |
  | 制片公司 | `Studios[]`（`{Id, Name}`） | `production_companies[]`；`Id` 是**数字**（TMDB 公司 id），且按 Id **去重**（TMDB 实测会把同一个公司给两次） |
  | 出品国家 | `ProductionLocations[]` | `production_countries[].name` |
  | 题材关键词 | `Tags[]` | 电影是 `keywords.keywords[]`、剧是 `keywords.results[]`（**TMDB 两处形状不一样，注意区分**） |
  | 预告片 | `RemoteTrailers[]` + `TrailerCount` | `videos` 里 YouTube 的 Trailer/Teaser |
  | 外部链接 | `ExternalUrls[]` | 见下条 |
  | 片名艺术字 | `ImageTags.Logo` | `images.logos`（按语言挑，退化到无语言那张） |
  | 多张背景图 | `BackdropImageTags[]`（最多 8 张） | `images.backdrops` |
  | 可点的类型 | `GenreItems[]`（`{Id, Name}`，**`Id` 是数字**） | `genres[]`（TMDB 的 genre id 本身就是数字，**别给字符串**） |
  | 相似推荐 | 走 `Items/{id}/Similar` | `recommendations`（同一次请求就带着，不额外打） |
  - **外部链接（`ExternalUrls`）—— 按真机补齐，同时去掉 Trakt**：真机的**名字与顺序**固定（实测电影与剧集两条都抓过）：

    | 名字 | 电影 | 剧集 | 怎么得到 |
    |---|---|---|---|
    | `IMDb` | 是 | 是 | TMDB 的 `external_ids.imdb_id`（**列表接口不给**，所以详情才有） |
    | `TheMovieDb` | 是 | 是 | tmdb id 本身 |
    | `TheTVDB` | — | 是 | TMDB 的 `external_ids.tvdb_id`（**只有剧有**） |
    | ~~`Trakt`~~ | 否 | 否 | **刻意不给** —— 见下 |
    | `官网` | — | — | TMDB 的 `homepage` —— **真机没有这一条**，但它是真 URL，保留（放在最后） |

    - **Trakt 为什么去掉**（实测）：真机给的是 `https://trakt.tv/search/tmdb/{id}?id_type=movie|show`，
      而 **Trakt 已经把这条深链下架了** —— 电影、剧集、`search/imdb/tt…` 三种形状实测**全部 404**
      （`404: Nothingness. The void.`），同站一个**有效**路由（`/shows/breaking-bad`）却正常 200
      ⇒ **是路由被删，不是被墙、也不是 UA**。
      Trakt 的条目页要用**它自己的 id / slug**，手上只有 tmdb / imdb 号，**造不出能用的直链** ——
      那就**不给**：发一条必 404 的死链比不发更差（同「不知道就空字段」的口径）。
      **哪天 Trakt 又支持了、或者能拿到它自己的 id，再加回来。**
    - **列表项也给**（真机列表项就有）：只有 `TheMovieDb` 一条 —— 列表接口没有 `imdb_id`/`tvdb_id`，**IMDb 不编**（不知道 tt 号就是不知道）。
    - IMDb 的 URL **结尾没有斜杠**（`…/title/tt41332009`）—— 原先多带了一个 `/`，已对齐真机。
    - 其余几条**都实测过能打开**：IMDb（浏览器正常）、TheMovieDb（电影/剧/季三种形状都 200 且标题对得上）、TheTVDB（200）。
  - **`SpecialFeatureCount: 0`**：真机**电影**条目列表与详情都带它（值 0，本项目没有花絮这类附加内容）。真机的**剧集**条目不给这个字段 —— 给了也无害（真机自己都不保证有）。
  - **`UserData` 去掉 `Key`**：真机条目是 `{IsFavorite, PlayCount, PlaybackPositionTicks, Played}`、**库条目**是 `{PlaybackPositionTicks, IsFavorite, Played}`（少 `PlayCount`）。原先多给一个 `Key`，真机既然不给，客户端就不可能依赖它 ⇒ 删掉；库条目单独一个 `emptyViewUserData()`，别复用条目的。
  - **简介放宽**：详情用 2000 字上限（列表仍用 400 —— 列表只要够画卡片）。
  - **TMDB 的一处行为**：只要同时给了 `language` 和 `images`，它就把 images **按语言过滤** —— logo 一定带语言标记、背景图大多不带，结果两边都空。所以必须显式带 `include_image_language=null,<语言>`。
  - **刻意没做**（都写了理由，免得以后反复琢磨）：`OriginalLanguage`（TMDB 给 2 位码、Emby 要 3 位码，映射表易错且客户端基本不显示 —— **又添一条硬证据：真机自己也不返回它**，带 `Fields=OriginalLanguage` 请求真机照样没有，所以加了反而偏离真机）；`CriticRating`（TMDB 没有媒体评分）；`ScreenshotImageTags`（TMDB 没有独立的"截图"类别，那些就是背景图）；合集 Boxset（Emby 里是另一类条目）；**`ExternalUrls` 里的 `Trakt`**（默认给的那个格式实测 404，造不出能用的直链 —— 见上面「外部链接」那条）。
  - **演职人员：`Id` 必须给，头像顺带做通**（**推翻了原来"不给 Id"的决定**）：
    - **`Id` 用 TMDB 人物 id**。原来刻意不给，理由是"人物不是本项目的条目，给了 Id 客户端就会去点、去要人物图片"。
      但真机 `People[]` **每条都带 `Id`**，而 **`People` 正在 SenPlayer 的 `Fields` 清单里** ——
      缺这个键会让客户端的解码器**整条响应失败**（表现成「网络错误/不存在该项目」），代价远大于收益。
    - **头像**：有 `profile_path` 的给 `PrimaryImageTag`，值由 `tagAndRemember(personId,'Primary',0,…)` 生成 ——
      **复用已有的图片端点**（`Items/{Id}/Images/{type}`），**不需要新增路由**：带 tag 走签名快路径、
      不带 tag 走本地索引，两条都通。**没有头像的就不给 tag**（客户端只在有 tag 时才去取图，不承诺就不产生 404）。
  - **`GenreItems` 给了 id 就等于承诺「点类型能进列表」** —— 那个端点**还没实现（会 501）**。这是**刻意**的"先给承诺、看客户端要什么"（当年 `ImageTags` 就是这么把图片端点逼出来的）。
    **`People[].Id` 同理**（点人物也会 501）—— 但它已经不能算是"刻意承诺"了，而是**必须给的**（见上条）。

- **条目 DTO 的「结构性字段」（按真机 Emby 4.9.5 逐项补齐）**：起因是
  **SenPlayer 详情页打不开**（拿到 `200` 却不再往下走、提示「网络错误/不存在该项目」），
  而换成真机响应就正常 ⇒ 缺字段会让客户端**整条解码失败**。判据与要求见「四」。
  - **条目级**（`service.baseItem`，列表项也受益）：`Etag` `SortName` `ForcedSortName` `PartCount`
    `Chapters` `TagItems` `LockData` `LockedFields` `CanDelete` `CanDownload` `LocalTrailerCount`
    `DisplayPreferencesId` `PresentationUniqueKey` `DateCreated` `DateModified`。
    ⚠️ 其中 `CanDownload` 是 **`true`**（条目级）：握手的 `Policy.EnableContentDownloading` 一直是 `true`，
    而 `Items/{ItemId}/Download` 也真做了 —— 这两处必须一致，否则客户端"照 policy 去试、又按条目不提供下载入口"
    （实测 SenPlayer 就是照前者试了 8 次）。**库条目**（`CollectionFolder`）那条仍是 `false`：
    文件夹下不了，真机也是 false。`CanDelete` 一律 `false`（删除确实没有）。
  - **条目级「线路派生」**（`getItem` 拿到线路后才补）：`Container` `Size` `Bitrate` `MediaStreams`
    `Path` `FileName`（`FileName` 用**源给的真文件名** `target.name`，不是版本副标题）。
  - **MediaSource 级**：`ItemId` `Chapters` `Formats` `RequiredHttpHeaders` `IsInfiniteStream`
    `ReadAtNativeFramerate` `HasMixedProtocols` `AddApiKeyToDirectStreamUrl`
    `RequiresOpening`/`Closing`/`Looping`（原有的 `VideoType` 已删 —— 真机没有）。
  - **MediaStream 级**：`AttachmentSize` `IsExternal` `IsForced` `IsTextSubtitleStream`
    `SupportsExternalStream`；视频另加 `AspectRatio`（宽高比**化简**成 `240:101` 这种）。
  - **`Etag` 是内容哈希**（`md5(名字+简介+上映+时长+分级+图片tag)`）—— 它必须**随内容变**，
    客户端才肯刷新缓存。**不是**由 Id 派生（那样内容变了 Etag 不变，客户端会一直吃旧缓存）。
  - **`DateCreated`/`DateModified` = TMDB 发行日期**；拿不到发行日期（插件行只有 `year`）就
    **不给这两个字段**。真机给的是**文件**的创建/修改时间 —— 本项目没有文件，这是"用上映日期近似"，
    语义如实记着。**佐证它非必需**：列表项一直没有这两个字段，而列表一直渲染正常。
    · **另一条路已否**：用"**条目首次见到的时刻**"当 `DateCreated`（当时真在 `cache.db` 里建过一张
      `item_seen(item_id, first_seen)`、写过 84 行）。**别再试它** —— 已否，改成用发行日期；
      那张表与它的数据已删除。
  - **`ParentId`**：列表项 = **它所在的那个库（准确值）**；详情/相似**没有库上下文**
    （实测 SenPlayer 的详情请求连 query 都不带）⇒ `defaultLibraryId()` 兜底第一个启用的行。
    那是 **best-effort，不是事实** —— 同一部片可以同时出现在多个库里（`trending` + `top_rated`）。
  - **`Path` 一律绝对 URL**（真机的 Path 从来不是相对路径）：`getItem`/`getPlaybackInfo` 收一个
    `host` 参数（routes 传 `req.headers.host` —— 那正是客户端能连到的地址）。
  - **实测**（路由器，真实数据）：字段数 **54**（真机 48 + 本项目几个额外的）；对真机**逐项不缺**。
- **季列表（`Shows/{Id}/Seasons`）也是占位**：数据来自**同一个** TMDB 接口（`GET /tv/{id}` 的响应里本来就有 `seasons[]`，不额外多打一次），**不加缓存，每次请求硬查**。
  - **季 Id 派生**：`tmdb_{id}_tv_s{n}`。派生与解析是一对（`tmdb.itemId` / `tmdb.parseItemId`），**代码里必须挨着放**，改格式时一起改 —— 否则发出去的 Id 回不来，客户端拿到 404。
  - **特别篇（`season_number === 0`）本轮不返回**。注意 TMDB 的季 `name` 是**本地化文案**（zh-CN 下特别篇显示为「特别篇」，en-US 是 "Specials"），**判定只能看 `season_number`，绝不能匹配名字**。
  - 实测：`number_of_seasons` **不含**特别篇（GoT 返回 s0~s8 共 9 条，字段报 8）→ 过滤后条数与 Items 里的 `ChildCount` 天然一致，不会出现「剧说 8 季、列表给 9 条」。
  - 季的 `Genres` 回空数组：TMDB 的 season 对象没有 genres 字段，**不套用剧的**（如实，不编）。
  - 季海报缺失时回退用剧的海报（`s.posterPath || show.posterPath`），免得客户端显示白块。
  - **TMDB 失败 → 照实回失败码**（与 Items 同一取向，见上面的映射表）。曾试过「回 200 空列表」，改成照实回是因为空列表会把"上游挂了"伪装成"这部剧没有季"。
  - Id 不是剧（如 `tmdb_550_movie`）→ **404**：说明客户端拿了错的 Id，静默回空会掩盖问题。
  - `UserId` 在这条请求里是 **query 参数**（`&UserId=…`），不在路径里 —— 与 `Users/{UserId}/Items` 的写法不同，校验语义一致。
- **分集列表（`Shows/{Id}/Episodes`）也是占位**：数据来自 **season 接口** `GET /tv/{id}/season/{n}` —— 剧接口只有 `seasons[]` **汇总**，**没有** `episodes[]`，所以这条必须单独多打一次 TMDB。
  - **入参**：路径 `Id` = 剧 Id（`tmdb_{id}_tv`）；`UserId` 与 `SeasonId` 都在 query，其中 `SeasonId` 就是上一步 Seasons 发出去的那个季 Id（`tmdb_{id}_tv_s{n}`）；`EnableTotalRecordCount` 与一长串 `Fields` 忽略（只回手里有的）。
  - **路径里给「季 Id」也算数**（依据是面板日志 + 真机实测）：
    官方文档写的是 `Id` = 剧，但**真机**（`emby.example.com`）实测
    `Shows/{季Id}/Episodes?SeasonId={季Id}` **回 200**（212 条，与剧 Id 那条一模一样）；
    而 **Lumenic/1.0.0 打的就是这种**（面板日志里 3 次 `Id 不是剧 → 404：tmdb_79481_tv_s5`）。
    季 Id 里本来就带着剧号与季号，信息不缺 ⇒ 现在认它：**季号以路径为准**（它更具体），
    并在这条日志里写明「路径给的是季 Id」；**若路径季号与 `SeasonId` 的季号不一致**，以路径为准并额外记一句
    （不一致本身说明客户端与本面板的 Id 认知可能漂了）。实测：季 Id 当路径 → 200/219 集（不带 `SeasonId` 也认）；
    剧 Id 当路径 → 200/219 集（回归不变）；**集 Id 当路径 → 仍 404**；路径 S1 + query S5 → 按 S1 回并记日志。
  - **分集 Id** = `tmdb_{id}_tv_s{n}_e{m}`。`itemId()` / `parseItemId()` 已同步支持 `_e{m}`，并强制**集号必须挂在季号下**（`tmdb_x_tv_e3` 这种解析返回 `null`）—— 派生与解析仍然互逆。
  - **季定不下来就回空（200）+ 日志写明原因**：没带 `SeasonId`（且路径也没给季）、`SeasonId` 认不出、`SeasonId` 不属于这部剧 —— 都回空 `QueryResult`。与 Items 同一思路：**先把客户端的真实调用逼出来**，不为没见过的形态现编数据。
  - 路径 Id 不是剧/季（如 `tmdb_550_movie`、集 Id）→ **404**（与 Seasons 一致；静默回空会掩盖问题）。
  - **分集字段**：`IndexNumber`(集号) / `ParentIndexNumber`(季号) / `SeriesId` / `SeasonId` / `SeasonName`；`IsFolder=false` —— 集不是容器，而 `baseItem()` 默认给 `true`，**必须显式改掉**；`Primary` 图用**剧照** `still_path`，因此 `PrimaryImageAspectRatio` 改成 16:9 的 `1.7777778`（海报是 0.667）；`runtime` 有值才填 `RunTimeTicks`（1 分钟 = 6×10⁸ ticks），未定档的不编时长。
  - **不填 `SeriesName`**：那要再打一次剧接口，而客户端是在剧/季页里发的这条请求，本来就知道剧名。
  - **TMDB 失败 → 照实回失败码**（与 Items / Seasons 一致，见上面的映射表）。
  - 实测（Rex-Standard）：`Shows/tmdb_95350_tv/Episodes?SeasonId=tmdb_95350_tv_s1` → 200、8 集，首集 `Name=试播集`、`PremiereDate=2026-08-16T00:00:00.0000000Z`。
- **单条详情（`Users/{UserId}/Items/{ItemId}`）—— 元数据来自 TMDB，源绑定走聚合层（本面板自己）**。客户端点进某一条（剧 / 季 / 集）时来要，返回**单个 `BaseItemDto` 本体**（不包 `QueryResult`）。
  - **元数据**：按 Id 的层级直接**复用列表实现**（集→`getEpisodes`、季→`getSeasons`、剧影→`getItems`）再挑出那一条，**不重复组装逻辑**，形状与列表里那条完全一致 —— 客户端就是按发出去的 Id 回查的。
  - **线路 + 源绑定**：用 TMDB 的**影视名**（剧名，另有年份消歧）调聚合层 `detail()` —— 那个函数**内部含搜索**（挑同名 → 取站源 `/detail` → 拆线路），所以 emby 层**一次调用拿回线路与定位**，一个字节的 `$$$` / `#` / `$` 都不碰。是**进程内直调**（`require('../agg/api')`），地址不再有"配不配"的问题。给它的就是**名字 + 年份 + 季集**（不再传 tmdb 坐标 —— 挑片判据换成了聚合层自己的打分，见下条）。
  - **站源名字对不上时怎么找：本地打分**（**取代了早先的 TMDB 别名回退**）
    - 为什么换：原来的判据是"归一化后完全同名"，对不上就拿**源的原始标题**去 TMDB 反查。实测坏在**输入**上 ——
      源的标题常写成 `斗破苍穹年番4更211[2025][动漫]` / `…4K臻彩中字【1GB/集】更211集`，这种拿去 TMDB 查不到
      ⇒ 同名 0、回退 0 ⇒ **版本列表空**（Emby 里表现为"条目在、点开没版本"）。
    - 现在：搜索这一步就给每条结果打分（`server/modules/agg/match.js`）——
      **名字 0.7 · 季集 0.2 · 年份 0.1**，缺的项**不进分母**（源里常常没季集/年份，按"缺=0"算会把名字全对的条目也压到阈值以下）。
      分项：名字（清洗后相等 1.0 / 主干同名 + 受控限定词 0.95 / 其余按 LCS 相似度）、
      季集（`更211` / `更新至211集` / `第N集` / `EP14` / 季号；对不上只给 0、不扣分）、
      年份（标题里的四位数字，差 1 年算 0.6）。
    - **两道闸门**：① **名字硬拒**（清洗后没有公共主干、或相似度 < 0.5 → 直接出局，拦 `斗破苍穹4：逃亡`、`斗破苍穹·止戈`）；
      ② **分数线** `matchMinScore`（默认 0.85；**填 0 = 不筛选**，那就只按分数排名取前 `matchMaxItems` 条）。
    - **为什么限条数**：每条命中后面都要打一次站源 `/detail` 取链 —— 不限就是十几秒（实测 3 条 ≈ 2s）。
      阈值与条数在 `agg.json`，可在「聚合设置」页改；web 的「聚合搜索」页可以单次覆盖。
    - **不去重**：同名的几条各有自己的 `vod_id`，谁能播要取过 `/detail` 才知道 ——
      按分数猜一条留、把别的丢掉就是"同名反而匹配错"的来源。所以源给了几条就算几条，只在
      `match.sameNameSameSite` 里数一下（诊断用）。
    - 诊断：日志 `✔ agg 打分「斗破苍穹」：扫 121 条 → 命中 3（分数线 0.85，上限 3）；没进：低分 33 / 超上限 0 / 名字不过闸 40；同站同名 45 条（照收，不去重）`；
      API 出参有 `match{…各桶计数}` 与 `unmatched[]`（带分数与原因）。
    - **接续补打 = 前面一条能用的都没拿到时才兜底往下打**：命中 ≠ 能播 —— 前
      `matchMaxItems`（N）条取详情后**一条能用的都没有**（空壳没线路、或集名定位不到这一集）时，
      按分数**继续往下打，最多再试 `matchExtraK`（K）条**，**整批并发、第一批拿到就不再发第二批**；
      K 填 0 = 不补打（默认）；`matchExtraAll` 开关 = **匹配到底**（不看 K，直到拿到一条或名单打完，可能很慢）。
      补打的能用的条目里**第一条当"代表"**（`picked.matchedBy = 'score+extra'`），其余进版本列表。
      诊断：`stats.targetN / matchUsable / extraTried / usableExtra`，日志 `↻ agg 接续补打：…`。
      前面只要有能用的就**一次都不补**（实测：首条可用 → 日志里不出现补打那一行）。
    - **仍然没有的，就如实为空** —— 不编、不回退到"随便挑一条"。
  - **命中落在三处**：
    - `ProviderIds.Catpaw` = **所有命中站的绑定**，`<站点key>|<vod_id>` 用 `;` 分隔（多站之后不再只有一个）；
    - 非标准字段 `CatpawSource`：老字段（`Site` / `SiteName` / `Api` / `VodId` / `VodName` / `VodPic` / `VodRemarks` / `Lines` / `Target`）取**第一个命中站**（兼容既有读取），新增 **`Sites`** 放**全部命中站**的同一套明细。客户端会忽略这个字段，纯给面板与日志核对；
    - **`MediaSources` —— 线路就是 Emby 的「版本」**：**命中站的每条线路都映射成一个版本**（已决定「去掉 picked 直接全部」，多站的线路全列出来），`Id` = `catpaw:` + base64url(JSON `{s,t,f,v,i?}`)（`catpawSourceId()` —— **站点与该站自己的 vod 都必须编在 Id 里**：客户端播直连时只回传这个 Id，播放那一格靠它回查那个站。**而且必须整体编码**：客户端把 Id 拼进 query 时不编码 `#`，而线路名里就有 `#`（如 `夸克原画#01`），于是 `#` 之后的 `01|<vod>` 被当成 URL 锚点**根本发不到服务端** → 服务端收到一个没有 vod 的 Id → 400，客户端反复重试。**实测**：`nodejs_wogg` 的线路名带 `#`，e1/e2 各失败 **34 次**；`nodejs_muou` / `nodejs_huban` 的线路名不带 `#`，一路正常 —— 这就是「有些能播、有些播不了」的全部原因。base64url 字符集只有 `[A-Za-z0-9_-]`，客户端编不编码都是同一串，**免疫**）；`Name` 与视频流 `DisplayTitle` = **`站点标签 · 线路`**，**同站其余命中条目再挂一段 ` · <变体标注>`**（变体＝**同一个站里其余被判定为同一部片的条目** —— 即"同片别名变体"这条口径；如 `虎斑|4K · 夸克原画 · 4K 偷跑`；站点用完整 `name`，如 `木偶|4K` —— 多站之后线路名会撞，必须带站点才分得清）。**「集」与「电影」都给** —— 剧/季是容器，给了会让客户端以为能播（电影那套见下面「电影也能播」）。
  - **电影（`tmdb_{id}_movie`）也给版本列表**：站源里电影就是「一条线路 + 若干播放项」，与剧集**同构**，只是**没有季集号**。
    - **电影取法 = `pick: 'items'`**（emby 层 `wantLocator()`）：聚合层把**每条线路下的每一个播放项**都算成一个可播目标 —— 同一部片的多个压制版本（`5.0GB 1080p` / `4.4GB` / `1.6GB` …）因此各自成为一个版本，由客户端自己挑。可播性判定收在 `isPlayable()` / `isPlayableId()`（集 = `Episode` 带季集，电影 = `Movie` 不带季集）。
    - **版本 Id 多一个 `i`**（该线路下的第几个播放项）：`Id` = `catpaw:` + base64url(JSON `{s,t,f,v,i?}`)；`i = 0` 时**不写进载荷** ⇒ 第 1 项的 Id 与从前逐字相同，**客户端缓存着的老 Id 天然可用**。`resolveStream` 按 `i` 取项，与拼版本列表**同一口径**，否则会出现"版本列出来了、点了 404"。
    - **为什么不再借 `S1E1` 定位**：电影文件名里没有集号（只有体积 / 年份 / 分辨率 / 编码），而剧集那套定位三条路全是"按集名里的集号匹配"。实测 20 部 TMDB 首页电影里 **19 部一条都定位不到**（源里有 4~20 条线路，`target` 却全空）⇒ 客户端版本列表恒为 **0 条**。改动前的诊断字段里 `matchedBy` 是 `sequence`、日志写「电影第 1 项（借 S1E1）」；那个"按选集序号"的规则其实早已被 `locateEpisode()` 的 ③ 取代。
    - 代价如实记着：**版本数 = 线路 × 项**（实测「生化危机：爆发夜」经 `play.filter` 的 `夸克` 过滤后 **10 个版本**、不过滤 26 个）；若某条线路把「预告」与正片并列，预告也会成为一个可播版本 —— 不猜、不挑，由客户端自己选。
    - 实测：`Items/tmdb_969681_movie` → **6 个版本** —— `虎斑|4K · 夸克原画` / `… · 夸克极速` / `… · 臻彩` / `… · 4K 偷跑`（代表 6 条 + 臻彩 2 条 + 4K 偷跑 2 条 = 10 条线路，经 `play.filter` 的 `夸克` 过滤后留 6 条，`LineFilter={Pattern:"夸克", Total:10, Kept:6}`）。
  - **同片变体（`（臻彩）` / `（4K 偷跑）`）也进版本列表**（「**收变体 + 标注来源**」）：站源里同一部片常有**多个独立条目**（各有自己的 `vod_id`），名字只在括号里差一点。聚合层 `pickByName()` 除"完全同名"（`sameName`）外，还会挑出**基础名相同**（`normBase()` —— 去掉**首尾**括号段后归一化）而名字不同的条目当 `variants`，逐条取详情；emby 层把**代表 + 变体**的线路**全部**展开成版本，标题位挂上括号里那截（`variantLabel()`）。**不加后缀不行**：同一部片的两个条目常常线路名完全一样（`虎斑|4K · 夸克原画` × 2），不标注就又变成"分不清哪条是哪条"。
    - 数据落在 `sites[key]`：代表仍占 **`detail`**（向后兼容，老消费方/面板不受影响），变体放 **`variants[]`**（`{variant:true, label, vodName, vodId, detail}`）；诊断字段 `CatpawSource.Sites[].Details` 列该站的**全部条目**，老字段（`VodId` / `VodName` / `Lines` / `Target`）仍取**第一条**。
    - **"多条完全同名"（不同年份的翻拍）不算变体** —— 那边仍按规则②只取一条（年份优先），否则会把两部翻拍混进同一份版本列表。
    - **变体的线路一并展开 ⇒ 版本数按条目数倍增**（实测这部电影：代表 6 条 + 臻彩 2 条 + 4K 偷跑 2 条 = 10 个版本），所以标题位的变体后缀是必需的，`play.filter` 也可以用来收窄。
    - 实测：`agg/detail {"name":"蜘蛛侠：崭新之日","season":1,"episode":1}` → `stats={sameName:1, variants:2, detailOk:3, detailFailed:0}`，`sites.nodejs_huban` 三条 `vodId` 各不相同（`…/499280.html` 代表、`…/500071.html` 臻彩、`…/500069.html` 4K 偷跑），各自定位到自己的播放项。
  - **`MediaSources[].Path` 刻意留空**：播放地址会过期，留到 **PlaybackInfo** 那一步按 `MediaSourceId` 现取（聚合层 `POST /api/agg/play`：`{site, flag, episodeId}` → `{urls, header, parse}`）。**待实测**：客户端会不会显示没有 `Path` 的版本。
  - **季集定位归聚合层**：站源的集是扁平列表（`第1集…第N集`），没有 Emby 的 S/E 概念。聚合层按「集名里的 `第X季第Y集` / `SxEy` → 第 1 季按选集序号 → 集名只写集号」三级顺序定位，并**必须回 `matchedBy`**；定位不到就 `Target: null` + `TargetNote`，**不猜**。
  - **聚合只做补充，失败不降级成错误**：连不上 / 没配 / 没同名 / 站源没详情 → **元数据照常 200 返回**，日志写明原因（详情页不至于打不开）。这不与「TMDB 失败照实回失败」冲突：**元数据是主体，线路是附加**。
  - **认不出的 Id 不静默吞掉**：路径形状与它相同、但不归它的请求 → 沿用通配那套，**记日志 + 501**（共用 `notImplemented()`）。
    **但「形状相同」的已实现端点必须注册在它前面**，否则会被这个 `:itemId` 吞掉 —— `Users/{id}/Items/Resume` 就出现过这个问题（此前它 501 就是因为落进这里、`parseItemId('Resume')` 认不出）。**同形状的路由，具体的排前面。**
  - 实测（三个启用站全命中）：`Items/tmdb_95350_tv_s1_e1` → 200：`ProviderIds.Catpaw=nodejs_huban\|/index.php/vod/detail/id/500036.html;nodejs_wogg\|/voddetail/130077.html;nodejs_muou\|/index.php/vod/detail/id/8471.html`、`CatpawSource.Sites` **3 个站**（各自 `Lines` 为 6 / 12 / 6 条）、`MediaSources` **24 个版本**（`虎斑|4K · 夸克原画` … `玩偶|4K · 夸克原画#02` … `木偶|4K · 夸克原画`）；日志：`id=… → 3 站命中（nodejs_huban/nodejs_wogg/nodejs_muou） 24 线路，3 条目定位到 S1E1`。剧与季同样拿到 `Lines`，但**不给** `MediaSources`。

- **播放（`PlaybackInfo` + `Stream`）—— 线路即版本，Path 只放稳定坐标**
  - **`MediaSources` 每条线路给全**（客户端靠它决定能不能直连解码）：`Id` / `Name` / `Path` / `Protocol` / `Type:Default` / `IsRemote` / `VideoType:VideoFile` / `Container` / `Size` / `RunTimeTicks` / `Bitrate` / `SupportsDirectPlay|DirectStream|Transcoding` / `RequiredHttpHeaders` / `DefaultAudioStreamIndex` / `MediaStreams`。**字段形状按真实 Emby 服务端的输出来对齐**（逐字段差异见下面「多版本字段对照」）。
    - **规格类字段全部来自源在集名里的标注**，由聚合层 `parseEpisodeMeta()` 解析 —— **能提取的全部提取**（既定要求）：容器 / 体积 / 分辨率 / 视频编码 / 档位（`Main10`）/ 位深（`10bit`）/ 帧率（`60fps`）/ 动态范围（`DOVI`｜`HDR10+`｜`HDR10`｜`HDR`｜`HLG`）/ 音频编码 / 声道布局（`5.1`→6、`7.1`→8）/ Atmos。例：`[1.8GB]…2160p…H.265.DV.HDR.DDP5.1.Atmos.mkv` → `mkv` / `1932735283` / `3840×2160` / `hevc` / `DOVI` / `eac3` / `5.1` / `6` / `atmos`。
    - **视频流的 `DisplayTitle` = `站点标签 · 线路`**（完整的站点 `name`，如 `木偶|4K · 夸克原画`）—— 它是客户端「版本列表」那一行的**标题位**。实测（Rex）：不给这个字段时客户端拿 `VideoRange` 自己拼出 "Dolby Vision"，多条线路全显示成一模一样；`MediaSources[].Name` 填了它也不读。**多站之后必须带站点**（`夸克原画` 好几个站都有），而且**无论源有没有标规格都要建这条视频流** —— 否则没规格的线路会丢掉标题位（实测 24 条里曾有 4 条为空，见 `buildMediaSource`）。为什么不像真实 Emby 那样给规格串 —— 见下面「多版本字段对照」。
    - **动态范围两处一起给**：`VideoRange` 用 Emby 的词表（`DOVI → DolbyVision`、HDR 系 → `HDR`、`HLG → HLG`），细类放 `ExtendedVideoType`（`DolbyVision`｜`HDR10Plus`｜`HDR10`｜`HLG`）—— 只写 `HDR` 但没说是哪一种的**两边都不给细类**（可能是 HLG，猜就错了）。色彩三元组（`ColorSpace` / `ColorPrimaries` / `ColorTransfer`）**是规范定的、不是猜**：DV/HDR10/HDR10+ 一律 `bt2020nc` + `bt2020` + `smpte2084`，HLG 用 `arib-std-b67`；只写 `HDR` 的不给（传输函数定不下来）。
    - **码率是算出来的、标注了近似**：`Bitrate`（源级）与视频流 `BitRate` = `Size×8 ÷ 时长`（时长取 TMDB 的 `RunTimeTicks`）。源标的体积本身就是近似值，而且这算的是**整条流的平均码率**（音视频分不出来）——所以按"整条流"的口径同时给两处，缺体积或缺时长就都不给。
    - 音频流给 `DisplayTitle`（编解码 + 声道 + Atmos，如 `EAC3 5.1 Atmos`）、`Channels`、`ChannelLayout`，并让 `DefaultAudioStreamIndex` 指向它 —— 与真实 Emby 同款式（真实 Emby 是 `English EAC3 5.1 (默认)`，**语言本项目没有，不编**）。
    - **每条线路各自定位各自那一集**（不同线路的集名/顺序可能不同），所以规格是按线路给的，不是全剧一套。
    - 解析不出来的字段**一律留空**（`Container:''`、没有 `Size`、`MediaStreams:[]`），**绝不补默认值** —— 给假的比不给更有害。
  - **`Path` 不放源的真实地址**，而放**本面板的 Stream 端点**，形状 `/api/emby/Items/{ItemId}/Stream/{base64url(版本 Id)}/{站点来源标签 · 集名}`（见 `service.streamPath` / `buildMediaSource`）。季集号不放进去 —— Stream 路径里的 `ItemId` 解开就有。这样一个 Path **永久有效**，与源地址、时效 token 彻底解耦。
    - **为什么用 base64url 编版本 Id、末段放「站点标签 · 集名」**：客户端版本行的**副标题就是「Path 解码后最后一个 `/` 之后」** —— 明文 `vod` 里的 `…/id/8471.html` 会把副标题变成 `8471.html`（多条一模一样）；base64url 解码后**也不含 `/`**，末段才能安心放内容。放**站点来源标签**（站点完整 `name`，如 `木偶|4K`）是因为多站之后副标题（集名）常常**逐字相同**，光看集名分不出来源；标签放最前面，长集名被客户端截断时也还看得见。
    - token → 版本 Id 用 `service.decodeSourceToken()` 拆（base64url → `catpaw:…`）；认不出的 token → **400**，不猜。
    - 为什么不能直接放源地址：实测同一个 `S01E01` 两次 detail 返回的集 ID **不一样**，base64 解出来是 `{"providerId":"quark",…,"playToken":"{…stoken…}"}` —— **它自己就是时效令牌**，拼进 Path 会跟着过期。
    - **但客户端不读 `Path`**（日志实测）：它自己拼 Emby 的标准直连端点 `GET /videos/{ItemId}/stream.{Container}?Static=true&MediaSourceId=<版本 Id>`。所以 `Path` 目前只留着「给读它的客户端 / 手动调试」，真正播放靠下面这条。
  - **直连渠道认 `MediaSourceId`**（修正自原先的「不认」）：客户端播直连时**只回传版本 Id**，不带任何路径参数 —— 因此 `MediaSources[].Id` 编成 `catpaw:` + base64url(JSON `{s,t,f,v}`)（见 `catpawSourceId()`），播放那一格从 Id 里就能拿到站点/线路/vod，不必回头再搜一遍。两个渠道（`Items/{Id}/Stream` 与 `videos/{Id}/stream.{ext}`）共用 `resolveStream`：**显式 `vod` 参数优先，其次用 Id 里自带的**。
  - **Id 解析两种形状都认**（`parseCatpawSourceId()`）：新的 base64url，以及**旧版明文** `catpaw:<site>:<flag>|<vod>`（客户端可能还缓存着）。区分靠**有没有 `:`** —— base64url 的字符集是 `[A-Za-z0-9_-]` 不含 `:`，而明文形状里站点与线路之间必有；不必加标记位。但线路名带 `#` 的**旧明文** Id **救不回来**（`#` 之后的内容客户端根本没发出来），只能等它从新的 `PlaybackInfo` 重新取一次 Id。
  - **载荷改成 JSON**：原来拼的是 `<源>:<站点>:<线路>|<vod>`，但 **vod 里就可能有 `|`** —— 站源把 meta 塞进 `vod_id` 是常态，`vod_remarks` 里带竖线（实测 Lmentor 的 `nodejs_bili_all`：`{"…","vod_remarks":"5分18秒|2.6万|19天前"}`）。老写法按「最后一个 `|`」切 vod，于是拉流时 vod 被切成 `19天前"}}` → 聚合层查不到这条绑定 → **404**，客户端表现为"点了播放没反应"。现在整段编成 JSON `{s,t,f,v}` 再 base64url：字段边界靠结构，`|`/`:`/`#` 出现在任何字段里都不是问题；**老的两种形状仍然认**（客户端可能缓存着旧 Id），认哪种看解出来的内容（以 `{` 开头 = JSON）。
  - **拉流时现取、不缓存**：`detail`（快路径 site+vodId，拿**新鲜**的集 ID）→ `agg.play`。代价是首帧要等两次上游调用（实测各 ≈2.5s）；先不缓存，等测出真实首帧延迟再说。
  - **下载（`Items/{ItemId}/Download`）走的是这一套，不是另写一套**：客户端的下载请求同样只带 `MediaSourceId`
    （`?MediaSourceId=catpaw:<base64>&DeviceId=…`），要的东西与拉流逐项相同，所以那条路由就是
    「`MediaSourceId` → `resolveStream` → `serveStream` 302」—— 与 `videos/*` 那段代码同构，不新增取数逻辑。
    差别只在两处：日志那行写「下载」（`serveStream` 的 `verb` 参数），以及**语义**上：302 之后
    `Content-Disposition`（文件名）/`Content-Type`/断点续传都由源站决定，面板改不了 ——
    想给「片名.S01E01.mkv」那种名字就必须由面板转发**全量字节**，那是 ADR-0006 明确不要的。
  - **拉流方式 = 一律 302**（「面板代理」那条路与 `play.mode` 一并删掉）：
    面板只回一个 `Location`，视频字节全在客户端与源之间跑。
    为什么删代理：面板跑在路由器上（2G 内存、U 盘），把每条流的字节都接一遍是代价最高的一种做法；
    而 302 的代价（"客户端够不到源地址"）在**同一天用地址改写解决掉了**（见下一条），所以代理没有存在的理由了。
    **代价如实记着**：该线路 `play.header` 非空时，302 后**客户端带不了那些请求头**
    （源把 `User-Agent`/`Cookie`/`Referer` 内嵌在自己 proxy URL 里的那种不受影响，那种 `header` 是 `{}`）。
    真碰上就**如实记一行日志**（`⚠️ 该线路要求请求头 X/Y，302 后客户端带不了`），不静默。
  - **302 前改写地址**（`service.redirectUrl()`）：**本地部署的源**回的播放地址是**回环地址**
    （源按"谁访问它"回填 host —— 聚合层是用 `http://127.0.0.1:<端口>` 打它的，它就回 `127.0.0.1`），
    那个地址对客户端毫无意义（客户端上的 `127.0.0.1` 是客户端自己）。所以换成
    **`http://<客户端访问面板用的域名>:<源端口>/…`**：用 192.168.1.100 进的 Emby 就回 `192.168.1.100:9988`，
    用 192.168.1.10 进的就回 `192.168.1.10:9988`（docker-compose 已把 9988-9998 发布到宿主）。
    · 只在地址**确实是回环**时才改（真直链如 `drive.example.com` 一律不动）；
    · **自定义（外部）源一律原样**——那种源在别的机器上，它的地址面板管不着，也不该管；
    · 源只回相对地址（`/proxy/…`）时按同一个域名 + 源端口补全（否则客户端会拼到**面板**身上）；
    · 拿不到 `Host` 头 / 认不出的地址 → 原样回，并把原因写进日志那一行。
    改写成功时日志会写全：`→ 302 地址改写 http://127.0.0.1:9988 → 客户端域名(192.168.1.100:9988)`。
  - 老配置里残留的 `play.mode` **不再读、也不再校验**（`PLAY_MODE_VALUES` 已删）：盘上留着那个键不影响任何一张卡片保存。
  - **线路过滤（可在面板配：「聚合设置 → 聚合参数 → 线路过滤」）**：一个正则，**只匹配线路名**（`line.flag`）—— 写 `夸克` 只留夸克类线路，写 `百度|UC` 留这两类；留空 = 不过滤。
    **已从 emby 层搬到聚合层**（`agg.json` 的 `lineFilter`，理由是「放聚合设置里面更稳」）：
    线路本来就是聚合层产出的东西，规则跟它放一起才不「配置在 A、生效在 B」。读数只此一处（现在在 `agg/service.js` 的 `lineFilter()`，`agg/api.js` 与 emby 层都转发），
    emby 层只转发（`emby/service.js` 的 `lineFilter()` = 一行 `return agg.lineFilter()`）；盘上老的 `emby.json` 的 `play.filter`
    由 `server.js` 启动时搬一次（agg 侧为空、emby 侧有值才搬）。语义没变：**只影响列出的版本，不影响播放**。
    ⚠️ 但它现在**还参与聚合层"这条详情对客户端有没有用"的判据**（[ADR-0025](adr/0025-line-filter-in-usable-judgement.md)）：
    过滤后一条都列不出来的条目不算"能用"（补打继续找、快照也不存），并且规则进了快照 key
    （改规则后第一次请求要重算）。客户端看到的版本列表行为不变。
    - **只影响客户端「列出来的版本」，不影响播放**：`resolveStream` 是按版本 Id（`site + flag + vod`）回查的，**不查这个列表** —— 否则改一次规则，客户端缓存里的旧版本 Id 再来拉流就 404 了。
    - **站点维度的取舍不在这里**（那是聚合层的 `agg.enabled` / `agg.order`）—— 一条正则只管线路名，两个维度各管各的。
    - **过滤后为空就是空的**（既定口径）：**不回退成全部**。日志写清 `线路过滤(/<规则>/)：源里 N 条 → 过滤后 M 条`，M=0 时再加「（版本列表为空）」—— 免得规则写错还误以为生效了。诊断字段 `CatpawSource.LineFilter = { Pattern, Total, Kept, Invalid }`（客户端会忽略）便于面板核对。
    - 正则在**保存时**就校验（面板直接拒绝非法写法）；运行时另有一层兜底：万一仍然非法，**当不过滤**走并在日志里写明 `规则非法，已忽略` —— 规则坏了不该把版本列表整个清空。
    - 实测：`filter=夸克` → 24 条降到 **10 条**（三个站的夸克类线路）；`filter=zzz没有这种线路` → **0 条**并留下上面那行日志；`filter=[` → 保存直接 **HTTP 400**（提示 `线路过滤不是合法正则：…`）。
    - 搬完之后复验：把 `agg.lineFilter` 设成匹配不到任何线路的正则 → Emby 那条 `tmdb_79481_tv_s5_e211` 的 `MediaSources` **0 个**；清空 → **1 个**（证明 emby 侧确实在读聚合层这份）。
  - **源回报回环地址这件事已经不再需要"选代理"来躲**：本地部署的源按"谁访问它"回填 host 是常态，
    以前只能靠面板代理绕过去；现在 302 前会把那个回环地址换成**客户端访问用的域名 + 源端口**（见上面那条）。
    **仍然够不到的是**：源在**别的机器**上（自定义源）而它自己回报了一个客户端够不着的地址 —— 那种源面板管不着，如实 302。
  - **走 302 不等于绕过中转**：实测站源 `/play` 返回的常常就是**源自己的** `/proxy/<provider>/<uuid>?pst=…` 地址 —— 解 `pst` 载荷能看到真直链（`drive.example.com`）、必需请求头（`User-Agent` / `Cookie` / `Referer`）、分片参数（`threads=16`、`chunkKB=256`），真直链的 `auth_key` 比 `createdAt` 大约 **21 小时**（限时签名）。所以选 302 只是「**本面板**不扛流量」，**源那边的流量与压力照旧**。要直连网盘得**改源**、由源提供直链契约（`pst` 是源私有格式，emby 层不该去解）。
  - **实测发现**：夸克线路的 `play.header` 是 `{}`，因为源把 `User-Agent` / `Cookie` / `Referer` **内嵌在自己 proxy URL 的载荷里**（`pst=` base64 解出来就含 `headers`），由源服务端自己加。所以「302」这条轻路径实际覆盖了大部分线路。
  - **流端点不做强制账号校验**（有 `UserId` 就校验，没有也放行）—— 客户端拉流不保证带上 `UserId`。**但 AccessToken 要校验**：客户端拉直连流用的是 query `api_key=`，正好被 `tokenFrom` 认到，所以这条不需要额外要求 `UserId`。（曾经的"AccessToken 只发不校验"取向已作废；`MediaSourceId` / `Path` 里的 `vod` 仍然相当于第二重凭据。）
  - 实测（端到端复现客户端的原样请求）：`PlaybackInfo` → **24 个版本**（3 个站 × 各自线路，标题形如 `虎斑|4K · 夸克原画` / `玩偶|4K · 夸克原画#02` / `木偶|4K · 夸克原画`，**无一为空**）；逐个验证**非首个站**的线路也能播：`MediaSourceId=catpaw:nodejs_huban:夸克原画|/index.php/vod/detail/id/500036.html` 与 `catpaw:nodejs_wogg:夸克原画#01|/voddetail/130077.html` → **302** → 跟随并带 `Range: bytes=0-1023` → **HTTP 206 / 1024 字节 / `video/x-matroska`**，魔数 `1a45dfa3`（EBML/Matroska）→ 说明 Id 里**各站自己的 vod** 回查正确。
  - **由此得到的结论**：在此之前只实现了 `Items/{ItemId}/Stream`（本面板在 `Path` 里指的那条），客户端**从未调用过它** —— 播放请求全部落到通配器吃 **501**，客户端只会反复重试（日志 emby#39~#45 连打 7 次）。**"端点通了"不等于"播放通了"**：以客户端**实际发出的路径**为准。
  - **"版本列表为空"先查聚合源地址**：`data/settings/agg.json` 的 `upstream.source` **一旦被手动填成固定地址就不再回落本地源** —— 而那个地址很可能是**面板崩溃后留下的孤儿源进程**（崩溃不走优雅退出，`stopAll` 没执行，源进程被 PID 1 收养并一直占着旧端口；那次是崩溃留下的 `192.168.1.101:9988`）。症状：`PlaybackInfo` 一直是 **0 个版本**，日志 `聚合取数失败（UPSTREAM_HTTP）`，每次卡满 20s 超时；源列表里那个有问题的源**看起来还是 running**。定位与修法：面板「聚合设置 → 托管源」会明说生效地址与来源是 `local`（本地运行中的源）还是 `manual`（配置里那个）（`GET /api/settings` 的 `base` 字段同源）——`manual` 指向的端口必须能与 `resolveLocal()` 的一致；清空 `upstream.source` 回落本地、并杀掉孤儿进程（`lsof -nP -iTCP:<端口>` 找 PID）。根因（流错误把进程带崩）已在 `serveStream` / `server.js` 两面堵住。

- **工作室清单（`GET /Studios`）—— 如实回空**：回空 `QueryResult`（`{Items:[],TotalRecordCount:0}`），**不是 501、也不是没做**。
  - 一个关键问题是"**工作室内容 TMDB 已经给了吗？**" —— 给了，而且已经在输出：详情页每条片的 `Studios[]` 就是从 TMDB 的 `production_companies` 映射的（`service.applyRich`），实测 `movie/603` 给 4 个（`Village Roadshow Pictures` / `Groucho II Film Partnership` / `Silver Pictures` / **`Warner Bros. Pictures`**）。
  - 那为什么还回空？**不是"缺一张匹配表"，是缺被匹配的那个源**：
    | | 内容 | 有吗 |
    |---|---|---|
    | **有**的 | `某条片 → 它的工作室` | 只有详情查过的那些（列表项**不带工作室** —— 插件 `HomeItem` 里根本没这个字段） |
    | `/Studios` **要**的 | `全库去重后的工作室清单` | 否，需要全量片库才能算 |
    | `/Studios/{Name}/Items` **要**的 | `某工作室 → 哪些片` | 否，同上 |
  - 关键在于**服务端没有"库里有哪些片"这份索引**：列表数据由首页插件在**请求时**现跑，从不存片库。所以不是匹配不上，是**没有东西可枚举**。
  - 若一定要凑出这份清单，只有一条路：跑一遍启用的行、把工作室名聚合去重。但那拿到的是**行返回的那几页**里的工作室（榜单片 ≠ 片库），**清单会随榜单波动** —— 用户拿一个会变的清单去筛选，结果没法解释。那是**编数据，比回空更差**（同 `getResume` 的取向）。
  - 另外 TMDB 的 `production_companies` 噪音很大：一条片常 4~8 个，很多是为单部片临时成立的空壳公司（上面那 4 个里就有 2 个）。
  - 顺带：详情里的 `Studios[]` **现在给 `{Id, Name}`**（原来只给 `Name`，
    而真机每条都带 `Id`，缺它会让客户端整条响应解码失败，见「四」）。`Id` 用 TMDB 的公司 id（**数字**）。
    给了 Id 就等于承诺"点公司能进列表"，而 `/Studios/{Name}/Items` 没实现（会 501）——
    但这条**只能这样**：**完整性优先**，宁可点了 501，也不能让整页打不开。
  - **不校验账号**（既定口径）：**回空的响应没有数据可保护**，校验只会有坏处 ——
    客户端不带 token 时会白白收到一个 401，而它本该拿到一个空列表。同口径的还有 `Items/Counts`
    与 `Items` 里那些回空的分支（判据收敛在 `service.itemsWillReturnData()` 一处，
    路由层与 `service.getItems` 共用，不会漂移）。
    实测：不带 token 取 `Studios` → **200 空**（改之前是 401）。
- **「如实回空」这一家子**：`Studios` / `Items/Counts`，以及 `Items` 里 `Filters=IsFavorite`
  与认不出的查询。共同点：**确实没有那份数据**，所以回空（回全 0 的那种也叫回空）；
  且**一律不校验账号**（回空没有数据可保护）。
  | 端点 | 为什么是空的 | 缺的是什么 |
  |---|---|---|
  | `Studios` | 没有片库可枚举 | 片库索引 |
  | `Items/Counts` | 数不出来 | 片库索引 |
  | `Items?Filters=IsFavorite` | 收藏要有写端点（没做） | 收藏功能 |
  - **`Items/Resume` / `Shows/NextUp` 已不在这一家**：自 [0023](adr/0023-playback-progress.md) 起它们读
    `playback` 表出真数据，也**因此改成要 token**（回的是某个账号的观看记录）。
  - ⚠️ **`Items/Counts` 的全 0 要说清**：意思是**"数不出来"**，**不是"库是空的"**。
    `ItemCounts` 的 14 个字段都是数字、没有"未知"这种取值，所以只能填 0。
    那为什么不去凑？唯一的数据源是各插件行返回的 `total`（如 `top_rated` 报 `11216`）——
    那是 **TMDB 榜单的总数，不是库里的数量**，拿它当"库里有 11216 部片"就是**编数据**，比 0 更差。
  - `Shows/NextUp` 与 `Items/Resume` 的分工（都靠观看历史，见 [0023](adr/0023-playback-progress.md)）：
    `Resume` = **有播放进度、还没看完**的条目；`NextUp` = 正在追的剧里**下一集**该看哪一集
    （最近看的那集没看完 → 回它自己；看完 → 回下一集，且必须在 TMDB 季数据里真实存在）。
  - 路由形状提醒：这两条都**没有**同名冲突（没有裸的 `Shows/:showId`、条目详情那条是
    `Users/:userId/Items/:itemId` 而不是 `Items/:itemId`）。但 `Items/Resume` 与 `Items/Latest`
    **都**被同形状路由吞过一次（后者曾导致 VidHub 首页全空）——
    **以后若新增 `Items/{Id}` 之类，记得把这几个挪到它前面**。

### 多版本字段对照（真实 Emby 服务端样例）

参考样例：某线上 Emby 服务（`emby.example.com`）的 `GET /emby/Shows/943883/Episodes`（Rex 发的，`Fields` 里明确写出 `MediaSources,MediaStreams`）。同一集它给了**两个版本**：

| 版本 | `MediaSources[].Name` | 视频流 `DisplayTitle` | 分辨率/编码/HDR | 码率 | 体积 |
|---|---|---|---|---|---|
| `mediasource_943887` | `H.264.(mkv)` | `4K Dolby Vision HEVC` | 3840×1920 · hevc · DolbyVision | 4557767 | 1.93 GB |
| `mediasource_943886` | `DV.HDR.H.265.(mkv)` | `4K Dolby Vision HEVC` | 3840×1920 · hevc · DolbyVision | 19807913 | 8.39 GB |

逐字段对照（**真实 Emby 的那套形状就是客户端的期待值**）：

| 字段 | 真实 Emby | 本面板 | 说明 |
|---|---|---|---|
| `MediaSources[].Id` | `mediasource_943887` | `catpaw:` + base64url(JSON `{s,t,f,v}`) | 客户端只当唯一键，但**必须 URL 安全**：它拼进 query 时不编码 `#`，明文 Id 里线路名带 `#` 的话后半段会被当锚点丢掉（实测） |
| `MediaSources[].Name` | 文件名尾段，**版本标识** | **`站点标签 · 线路`**（`虎斑|4K · 夸克原画` / `木偶|4K · 夸克原画`） | 多站之后才分得清 |
| 视频流 `DisplayTitle` | `4K Dolby Vision HEVC`（规格描述） | **`站点标签 · 线路`**（同上；**源没标规格也照建这条流**，否则标题位会空） | 见下面的「为什么」 |
| 音频流 `DisplayTitle` | `English EAC3 5.1 (默认)` | `EAC3` | 语言/声道没数据，不给 |
| `VideoRange` | `DolbyVision`（Emby 词表） | `DOVI` 经 `embyVideoRange()` 翻成 `DolbyVision` | 词表不对口客户端认不出 |
| `ExtendedVideoType` | `DolbyVision` | 同左（DoVi 时才给） | |
| `DefaultAudioStreamIndex` | 有 | 有 | |
| `VideoType` | `None` | `VideoFile` | 本项目是 http 流，不是本地文件，如实给 |
| `Path` | 真实文件 URL（末段是文件名） | 本面板 Stream 端点，**末段也放文件名（集名）**：`/Stream/{base64url(版本 Id)}/{集名}` —— 客户端版本行的副标题就显示它 | 形状见「播放」段 |
| 其余流字段（`Profile` / `ColorSpace` / `BitDepth` / `ChannelLayout` / 语言 / `ExtendedVideoSubType`…） | 全套（本地库 + ffprobe 探得） | **只给源在集名里标了的** | 解析不出来就留空，不编 |
| Episode 项自带 `MediaSources` / `MediaStreams` | 有 | 无（只在详情与 `PlaybackInfo` 给） | 真实 Emby 是本地库扫出来的；本项目是**在线聚合**，分集列表要给每集配版本就得多打上游，代价过高。**待观察**：Rex 既然在 Episodes 里明确要求 `MediaSources`，将来若发现它靠列表渲染版本，再议 |

**为什么 `DisplayTitle` 必须给「站点标签 · 线路」**（而不是像真实 Emby 那样给规格串）：真实 Emby 的两个版本是**两个不同文件**（码率/体积不同、`Name` 也不同），规格串本来就能替它区分；而本项目是**同一个源条目里的多条线路、甚至多个站的同名条目** —— `VideoRange` / `Codec` / `Size` 往往完全相同，规格串会撞成一片，**只有站点标签能把它们分开**。而版本行的标题位只认流上的 `DisplayTitle`：缺了就退回 `VideoRange` 拼出的 `Dolby Vision`，`MediaSources[].Name` 填了它也不读。站点的完整 `name`（`木偶|4K`）比截短的"木偶"多带画质后缀，标题位与副标题现在用**同一个标签**。

**副标题：已修**。版本行的副标题是客户端把 `Path` 解码后取「最后一个 `/` 之后」得来的：之前 `Path` 是 `…/Stream?src=…&vod=…/id/8471.html`，于是六条全显示 `8471.html`。现在改成 `/Stream/{base64url(版本 Id)}/{站点来源标签 · 集名}` —— token 用 base64url（**解码后也不含 `/`**）承载源路径，使其不出现在 URL 里，末段放**站点来源标签**（站点完整 `name`，如 `木偶|4K`）+ **该线路自己定位到的那一集的集名**（源给的原始文件名），副标题就变成：

```
木偶|4K · [1.8GB]Lanterns.2026.S01E01.2160p.MAX.WEB-DL.H.265.DV.HDR.DDP5.1.Atmos.mkv【L 绿灯军团】
```

（未定位到集名的线路退回「线路名.mkv」。注意客户端**播放并不读这个 Path**，它只影响副标题与手工调试 —— 播放走 `/videos/{Id}/stream.{ext}`。）

**流字段能提取的都提取，但"有才有、没有就空"**（既定口径：**只用 `agg/detail` 的数据，不做探测**）。分三类：

| 类别 | 字段 | 依据 |
|---|---|---|
| **算出来的**（近似） | `Bitrate`、视频流 `BitRate` | `Size×8÷时长`；源标的体积本身是近似值，且分不出音视频，故按"整条流"口径给 |
| **由已解析项推导**（规范确定） | `ColorSpace` / `ColorPrimaries` / `ColorTransfer` | DV/HDR10/HDR10+ → `bt2020nc`+`bt2020`+`smpte2084`；HLG → `arib-std-b67` |
| **源写了才有** | `BitDepth`（`10bit`）、`Profile`（`Main10`）、`AverageFrameRate`/`RealFrameRate`（`60fps`）、`Channels`/`ChannelLayout`（`5.1`）、Atmos、`ExtendedVideoType` 细类 | 集名里的明确写法 |

本例集名 `…2160p…H.265.DV.HDR.DDP5.1.Atmos.mkv` **没写**帧率、位深、档位 —— 所以那三项**就是空的**（不是漏了，是源没说）。想要"一定有"只有一条路：真去探测文件头（ffprobe）。**本项目不做** —— 源是远程流，为元数据去读它的头部是另一条链路的事；既定要求是"就通过 `agg/detail` 最大限度拿数据"。

### 面板自用端点（不属于 Emby 客户端协议）

这些是面板自己用的接口，**同样必须注册在通配之前**（否则会被 501 通配吞掉），但**不参与** Emby 兼容语义，客户端永远不会请求它们。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/emby/accounts` | 账号列表（`id/username/createdAt/updatedAt/lastLoginAt/lastClient`，**绝不含密码或哈希**） |
| POST | `/api/emby/accounts` | 新增账号 `{username,password}` → 200 `{account}`；400 空/用户名>64/密码<6；409 用户名已存在 |
| PUT | `/api/emby/accounts/{id}` | 改 `{username?,password?}`（只传 password 就是改密）→ 200；400 没内容可改/格式不对；404；409 |
| DELETE | `/api/emby/accounts/{id}` | 删除（**允许删最后一个**，删光后退化成"还没有账号 → 登录 401"）→ 200 `{ok,remaining}`；404 |
| POST | `/api/panel/tmdb/test` | 测 TMDB 设置：先 `GET {apiBase}/configuration` 验 v4 Token，再实查一个 tmdb id（**两步都绕缓存**）。**已从 `/api/emby/tmdb/test` 搬到面板层**（配置跟着走了） |
| GET / DELETE | `/api/panel/cache` | **缓存用量 / 清空**：跨两个库一把抓（`data/cache/tmdb.db` 的 `tmdb_cache`+`name_index`、`data/emby/cache.db` 的 `image_index`），走 `core/cachedb.js` 的 `statsAll()`/`clearAll()`。**取代了 `/api/emby/cache`**（缓存分家后"清空"必须只有一个入口） |
| ANY | `/api/emby/home/**` | **首页插件**：`GET/POST /plugins`、`GET/PUT/DELETE /plugins/{id}`、`POST /plugins/{id}/rows/{rowId}/run`、`GET /example`、`GET /skill`（开发文档下载）。上传单文件 JS 插件产出「首页行」，**已接客户端端点**（`Views` / `Items?ParentId=` / `Items/Latest` / 库封面 / 「推荐」查询 → `feed` 行，见「五」）；契约见 [emby-home-plugin.md](emby-home-plugin.md) |
| GET / DELETE | `/api/logs` | **面板日志**（属**面板层**，不是 emby）：`GET ?since=&limit=` 增量取内存缓冲、`DELETE` 清空。给「面板设置 → 日志」页用，契约见「二」 |

- 账号接口的**响应与日志绝不出现 `password` / `password_hash` / `salt`**：对外形状统一走 `db.publicAccount()`（只此一处做字段映射），日志只打 `id` 与 `username`。
- 这些**面板自用端点不校验 AccessToken**：它们（`/api/emby/accounts*`、`/api/emby/home/**`）在**面板门禁**的保护范围内，访问需要面板登录会话，因此不再叠加客户端 token 校验（见 [ADR-0017](adr/0017-panel-auth-single-password.md)）。
- 查重先给友好的 409，同时靠 `username_lc UNIQUE` 兜并发。

- body 可带 `token / apiBase / imageBase / language`（用界面里**尚未保存**的当前值）与 `tmdbId / type`；合并规则：基地址**带了这个键就算数**（空串 = 用官方），token/language 的空串视为「没改」回落已保存值。
- **HTTP 一律 200**，成败看 `ok` 与 `error.code`（`NO_TOKEN` / `INVALID_TOKEN` / `NOT_FOUND` / `NETWORK` / `TIMEOUT` / `UPSTREAM_HTTP`）—— 前端 `api()` 在非 2xx 时只能拿到一句 error 字符串，看不到细节。
- **绝不回显 token**：响应里只有 `tokenSet` / `tokenLength`，日志里只有基地址、探测对象、状态与耗时。

### TMDB 设置（按 tmdb id 反查元数据用）

- **归面板层**：存 `data/settings/panel.json` 的 `tmdb.{token,apiBase,imageBase,language}`，
  面板「面板设置 → 设置 → TMDB 设置」卡读写（原先在 `emby.json`，启动时自动搬迁、token 不丢）。
  **为什么搬**：它跟"名字 → 搜索结果"这张表同类，且要走同一个 `search()`（emby 的搜索端点用；聚合层已不再用它），
  而依赖是单向的 `emby → agg → source` —— agg 不能读 emby 的配置。协议层在 `core/tmdb.js`。
- **凭证只支持 v4 API Read Access Token**（`Authorization: Bearer`）；v3 `api_key` 不支持 —— 两种凭证在 TMDB 侧权限完全相同，token 是官方推荐且不会出现在 URL/日志里。
- `apiBase` / `imageBase` 留空即用官方（`https://api.themoviedb.org/3`、`https://image.tmdb.org/t/p`），直连不通时可填反代/镜像；`validate` 只校验非空时必须是 `http(s)://`（校验也搬到 panel 的 settings.validate 了）。
- Token 以**明文**落在 `data/settings/panel.json`（本地面板；含凭证的 `data/` 已在 `.gitignore`）。

### TMDB 出口全清单（做缓存/限速/记账前必看）

TMDB 流量分**两类**，走的路完全不同 —— 混在一起算账一定会算错：

| # | 谁发起 | 代码位置 | 落到哪 | 走 tmdb 客户端？ |
|---|---|---|---|---|
| 1 | 详情/影剧反查 | `service.tmdbItemDto` → `tmdb.lookup()` | api.themoviedb.org | 是 |
| 2 | 季/集反查 | `service.getEpisodes` → `tmdb.lookupSeason()` | api.themoviedb.org | 是 |
| 3 | 插件 `Catpaw.tmdb.get` | `home/sandbox.js` →RPC→ `home/spawn.js` → `tmdb.get()`（注入 emby 的元数据缓存） | api.themoviedb.org | 是 |
| 4 | 面板「连通性测试」 | `core/tmdb.test()`（打 `/configuration` + 实查一个 id，**都绕缓存**） | api.themoviedb.org | 是 |
| 5 | **图片端点取图** | `routes.js` 的 `imagesByType` 直接 `fetch(tag 里的 URL)` | **image.tmdb.org** | 否 |
| 6 | **插件 `Catpaw.http`** | `home/sandbox.js` →RPC→ `home/spawn.js` 裸 `fetch` | 任意 URL | 否 |

统一的底层是 `server/core/upstream.js` 的 `request(baseUrl, path, {timeout, headers})` —— **表中第 1~4 条（即全部 API 调用）都走它**（第 1~3 条经 `emby/tmdb.js` 的缓存包装）。

- **已删除的一条**（原表中的聚合层「别名回退」反查）：那时**只在"站源没有同名"这一条失败路径上**才会打（每次最多 5 个候选名），正常请求一次都不打；它走 `core/tmdb.js` 的 `search`，该函数带进程内小缓存。已删 —— 挑片判据换成聚合层本地打分（`agg/match.js`），聚合层不再出网；`core/tmdb.search()` 仍归 emby 的搜索端点用。

**第 1~4 条 = 「API 调用」**（消耗配额）：**100% 由两个 tmdb 客户端独占**（`core/tmdb.js` 是协议层、
`modules/emby/tmdb.js` 是 emby 专有层）。
插件也绕不过去 —— 因为沙箱里**根本没有 token**（`home/spawn.js` 随 job 只下发
`env: { tmdbImageBase }`，就是拼图用的图床基地址）。插件自己拼 `api.themoviedb.org` 也是 401。
⇒ 要给 API 调用做**统一记账/限速/缓存**，`tmdb.js` 是唯一插入点，做一次全覆盖。

**第 5 条 = 「取字节」**（不消耗配额，但要走网络）：**唯一一处**，在 `routes.js` 的图片端点。
它天然不经过 `tmdb.js` —— 端点必须把图的**内容**取回来再转发（不能只 302 让客户端自己去
`image.tmdb.org`，因为插件给的图地址可能是客户端根本连不通的地方）。
⇒ 这条账要单独挂在 `routes.js`，且**跟配额无关**：客户端每张图只来要一次，之后靠
`Cache-Control: max-age=86400` 自己缓存。

**第 6 条 = 通用 HTTP 能力**：`Catpaw.http` 设计上就允许请求任意地址（插件的自由度），不能也不该收窄成只准打 TMDB。它打到哪儿算哪儿，不在 TMDB 记账范围内。

> ⚠️ **不要把第 5 条（取字节）算进「TMDB 请求数」**。讨论「按 Id 反查」的代价时算的是**第 1~4 条**那张账
> （实测 340 次图片请求 ≈ 55 次 API 调用）；第 5 条的字节流量**本来就有**，且与配额无关。

### 本地缓存（**两个库**：`data/cache/tmdb.db` + `data/emby/cache.db`）

**按"谁用"分家**（判据不是"是不是 TMDB 数据"—— 图片索引里混着插件给的自定义图地址，
按来源切对它不成立）：

| 表 | 存什么 | 写入时机 | 谁读 | 库 |
|---|---|---|---|---|
| `tmdb_cache` | **元数据类** TMDB 响应（`/movie/{id}`、`/tv/{id}`、`/tv/{id}/season/{n}`） | `core/tmdb.js` 的 `requestCached` 里，成功响应才写 | 同上（lookup / lookupSeason / 插件 get 三个调用点共用） | `data/cache/tmdb.db` |
| `name_index` | **名字 → TMDB 搜索结果**（`search/tv\|movie`，键 `<类型>\|<语言>\|<名字>`，值=整条 `results[]`） | `core/tmdb.js` 的 `search()`，**只写有结果的成功响应** | emby 的搜索端点（聚合层已不再用它） | 同上 |
| `image_index` | 条目 Id → 图片位置（无头相对路径或绝对 URL） | `baseItem()` 里出 tag 的那一刻 | 图片端点（没带 tag 时） | `data/emby/cache.db` |

- **为什么这么切**：`name_index` 是 agg 与 emby **共用**的，留在 emby 就会让 agg 反向依赖 emby
  （依赖是单向的 `emby → agg → core`）；`image_index` 的读写都在 emby，agg 从不碰它，留下即可。
  通用设施（开库 / TTL / 按字节 LRU / 统计 / 清空）下沉到 **`server/core/cachedb.js`**，
  两个库各自建一个 store 复用它 —— 不这么抽，TTL 与淘汰会变成两份必然漂移的实现。
- **设置、用量、清空统一在面板层**：`cache.*` 存 `panel.json`（UI 在「面板设置 → 缓存设置」），
  端点 `GET|DELETE /api/panel/cache`（**原 `/api/emby/cache` 已删**）—— 缓存跨两个库了，
  "清空"必须只有一个入口，散在各模块里迟早漏清一处。清的是 `tmdb_cache` + `name_index` + `image_index`。
- **`name_index` 的口径**：TTL **6 小时**、上限 **2MB**（`core/cachedb.js` 的 `NAME_TTL_MS` / `NAME_MAX_BYTES`，
  不进面板设置）；**负结果（空数组）不存** —— 存了会让新上线的别名条目永远看不见；
  TTL 故意不拉长：将来 emby 的搜索端点也要用它，"现在有哪些"要新鲜。
  它从"进程内 Map"改成落盘，直接原因是 **dev 模式 `--watch` 一重启就全丢**，
  刚查过的名字马上又打一遍上游、正好撞上 TMDB 的抖动窗口（实测：第 1 次 1.08s、第 2 次 3ms）。
- **网络失败会立即重试一次**（`core/tmdb.js` 的 `requestWithRetry`）：路由器上 TMDB 链路是抖的
  （实测会在握手阶段被中断），而一次搜索要连打多个名字 —— 全撞上坏窗口的概率不低，
  表现就是"版本列表空"。**只重试网络/超时**（401/404 这类确定性失败重试没意义）；
  失败照旧**不缓存**，所以重试是唯一能压住抖动的动作。

- **删掉的孤儿表 `item_seen`**（`item_id` + `first_seen`，84 行）：它是"用**条目首次见到的时刻**
  当 `DateCreated`"那次尝试的残留，那个口径**已被否**（改用 TMDB 发行日期，见「五」）。
- **其后又删掉两张**：`view_seen`（库首见时刻 —— 库 `DateCreated` 改占位值后失去唯一用途，
  见「五」）与旧的 `tmdb_cache`（已搬到 `data/cache/tmdb.db`）。现在 `emby/cache.db` 里**只剩 `image_index`**。
  ⇒ 规矩照旧：**不可再生的表（`*_seen` 丢了就再也算不出来）做实验时要么叫 `_tmp`、要么删干净**。

**为什么图片索引独立文件、不并进 `emby.db`**：`emby.db` 存账号（scrypt 哈希），它的两句话是"写入量极小 + 文件级备份不漏数据"（DELETE journal）与"chmod 0600"。缓存正好相反：**高写入、可随时删掉重建**。混在一起会让备份把可丢的缓存混进不可丢的账号，还会在缓存写盘时锁住整个库、挡住登录。
⇒ 运维上就一句话：**缓存出问题就删掉重建，账号不受影响、不用重新登录**（面板「缓存设置」里有「清空缓存」按钮）。
⇒ 因此两个缓存库反过来**用 WAL + `synchronous=NORMAL`**（缓存要的是写吞吐，掉电丢几条无所谓），与 `emby.db` 的取舍**正好相反**，这是刻意的。

**只缓存元数据，不缓存榜单**：判据是**请求的性质**而非"谁问的"（`core/tmdb.js` 的 `isMetaPath`，正则要求 id 是**纯数字**，否则 `/movie/top_rated` 会被误伤）。所以榜单/搜索/`/configuration` 一律不进 `tmdb_cache` —— 榜单归首页模块自己的 `cacheDuration` 管；`/configuration` 是连通性测试，缓存了会让自检结果失真。
顺带一个好处：插件经 `Catpaw.tmdb.get` 问**元数据**也享受缓存，而榜单照旧不缓存。
（`name_index` 是**另一张表**：它缓存的是"检索结果"，与 `isMetaPath` 那条判据无关，见上面那行。）

**只缓存成功响应**：401/404/5xx/超时一律不写。否则一次网络抖动会把"404"钉在缓存里，部署者改了 token 还是错的。

**淘汰：TTL + 字节上限 + LRU，三者各管一件事**
- TTL 管**正确性**（元数据会变：评分、简介、海报更换）
- 字节上限管**空间**（片库不封顶）
- 两者都不管冷热 ⇒ 按 `used_at` 做 LRU（读命中时按**每小时**节流刷 `used_at`，避免把缓存变成写放大源）
- **上限必须按字节不能按条数**：实测同一条元数据 **lean 1.9KB vs rich 119KB，差 60 倍**，按条数算不准

**默认值与面板**：`cache.{tmdbTtlDays,tmdbMaxMB,imageTtlDays,imageMaxMB}` = 30 天 / 200MB / 90 天 / 5MB，
存在 **`panel.json`**（已从 `emby.json` 搬来，启动时自动搬迁、数值不丢），
面板「**面板设置 → 缓存设置**」可改（还有用量显示与清空按钮；名字索引那两行也一并显示）。
⚠️ 两个 0 的语义**不一样**：**天数 0 = 不缓存**（写完即过期）；**上限 0 = 不限**（不淘汰）。
改了设置后由 `panel/index.js` 的 `onSettingsChange` 钩子调 `cachedb.sweepAll()` 立刻扫一遍两个库 ——
否则把上限调小后要等下次写入才收拾，面板上会显示"已用 60MB / 上限 10MB"，看起来像故障。

**实测**（路由器）：

| 项 | 结果 |
|---|---|
| rich 元数据 第1次 / 第2次 | 1318ms → **9ms**（0 网络，行数不变） |
| lean 与 rich | 是两个键（`append_to_response` 在 query 里） |
| 失败不写缓存 | 404 → 下次仍走网络 |
| 无 tag 取图 | **200**（走索引） |
| **容器重启后** | 索引与元数据缓存**都还在** —— 无 tag 取图仍 200，冷启动窗口消失 |
| 上限 200MB→50KB | 立刻淘汰到 1 条 / 2.2KB（不等下次写入） |


## 六、明确无视的请求（不补、不报）

> 这些是**明确决定不做**的请求。日志里再看到，**直接跳过**：不实现、不上报、不再询问、不进「待补端点」。

| 方法 | 路径 | 识别特征 | 决定 |
|---|---|---|---|
| GET | `/api/emby/Users/{UserId}/Items` | query 带 `Filters=IsFavorite`（首页「收藏」） | **无视** —— 不补 |

- 判定只看 query 里的 `Filters=` 值命中 `IsFavorite` 即算，其余参数（`SortBy`、`Limit`、`Fields`、`Recursive`…）怎么变都无视。
- **`Filters=IsPlayed` 已从这张表移出**：自 [0023](adr/0023-playback-progress.md) 起它**出真数据**
  （读 `playback` 表的已看条目），不再回空。
- **不是整体无视 `Users/{UserId}/Items`**：`Filters=IsFavorite` 如实回空（没有收藏数据，空是如实）；`Filters=IsPlayed` 读库出真数据；`ParentId=<本面板的库Id>` 走首页模块（见「五」）；**`AnyProviderIdEquals=tmdb.{id}` 归 emby 层**（按外部 id 搜一条 —— 删过、后恢复，理由见「五」）。
- 实现后的行为：`Users/{UserId}/Items` 会正常收下这些请求，不会再落到 501 通配里。

> **字段级**的"故意不给"记在别处（不是端点级，所以不列上面的表）：详情页哪些字段不给、为什么不给 —— 见「五」的**详情页"丰富度"**那条（`OriginalLanguage` / `CriticRating` / `ScreenshotImageTags` / 合集 Boxset）。
> 原来那份清单里还有"**演员头像**"和"**演职人员不给 `Id`**"两条，**已推翻**（缺 `Id` 会让客户端整条响应解码失败），改成了"给 Id + 头像顺带做通"，理由见同一条。
> **还没做、等指定的端点**：见「七」。

## 七、客户端要过的端点（记录 + 现状）

> 这张表是**客户端实际要过什么**的流水记录，不是"待办清单" —— 有的已实现、有的如实回空、有的判定不实现。
> 判断依据一律是**日志**（谁要的、要了什么），不靠猜；要补也得等明确指定。

| 方法 | 路径 | 用途 | 现状 |
|---|---|---|---|
| GET | `/api/emby/Users/{UserId}/Items/Resume` | ~~首页「继续观看」~~ | **已实现**（**真数据** —— 读 `playback` 表的未看完条目，见「五」与 [0023](adr/0023-playback-progress.md)） |
| GET | `/api/emby/Studios` | ~~工作室筛选列表~~ | **已实现**（**如实回空** —— 没有片库可枚举，见「五」） |
| GET | `/api/emby/Items/{Id}/Images/{type}` | ~~图片~~ | **已实现**（见「五」；tag 验签通过 **或** 命中本地图片索引都出图，否则 404；端点豁免 token） |
| GET | `/api/emby/Users/{UserId}/Items/Latest` | ~~官方另一条「每库最新」路径（回裸数组，与 `QueryResult` 形状不同）~~ | **已实现**（见「五」；**VidHub 3.0.6 的整个首页都靠它** —— 实测拿到 `Views` 后逐库各打一次） |
| GET | `/api/emby/Users/{UserId}/Items?SearchTerm=<词>` | ~~搜索框（`IncludeItemTypes=Movie,Series,Video,Person&Recursive=true`）~~ | **已实现**（见「五」的「搜索」那条；**SenPlayer 6.1.8 实测在用**，以前回空 → 搜索框永远空） |
| GET | `/api/emby/Users/{UserId}/Items/{库Id}` | 客户端问「这个库是什么」（形状与 `Items/{ItemId}` 相同，现在会被 `parseItemId` 判成 501） | **未指定**（客户端尚未请求） |
| GET | `/api/emby/System/Info` | **带 token 的完整服务器信息**（`System/Info/Public` 的加强版：编码器位置、各类路径、能否自更新/自重启等 —— 大部分是**本项目没有的能力**） | **未指定**（VidHub 3.0.6 登录后要它，现在落到 501 通配；**它容忍了**、照常往下走） |
| GET | `/api/emby/Shows/{Id}/Seasons` | **特别篇（TMDB `season_number=0`）是否返回** | **待定**（客户端可能支持显示特别篇，暂不确定；现在按"不返回"实现，见「五」） |
| GET | `/api/emby/Shows/NextUp` | ~~SenPlayer 的「接下来看」~~ | **已实现**（**真数据** —— 按库里进度算下一集，见「五」与 [0023](adr/0023-playback-progress.md)） |
| POST | `/api/emby/Sessions/Playing` | ~~客户端上报「开始播放」~~ | **已实现**（落库；实测 SenPlayer 6.2.1 每次播放发 1 次） |
| POST | `/api/emby/Sessions/Playing/Progress` | ~~播放中的心跳（实测每 10 秒一次）~~ | **已实现**（落库；被 501 拒了客户端也照发，所以必须收下） |
| POST | `/api/emby/Sessions/Playing/Stopped` | ~~停止 / 退出上报~~ | **已实现**（落库；位置 ≥ 时长 90% 判为看完） |
| POST | `/api/emby/Users/{UserId}/Items/{ItemId}/HideFromResume` | ~~从「继续观看」里移除 / 恢复~~ | **已实现**（只翻 `hidden`，不动位置；重播会自动取消隐藏，见 [0023](adr/0023-playback-progress.md) 的补充） |
| POST | `/api/emby/Users/{UserId}/PlayedItems/{ItemId}` | ~~标记已看~~ | **已实现**（`played=1`、位置归零、`play_count` 加一；见 [0023](adr/0023-playback-progress.md) 的补充） |
| DELETE | `/api/emby/Users/{UserId}/PlayedItems/{ItemId}` | ~~标记未看~~ | **已实现**（`played=0`、位置归零、`play_count` 归 0） |
| GET | `/api/emby/Items/Counts` | ~~侧边栏每个库的条目数~~ | **已实现**（**全 0** —— 数不出来，不是库空，见「五」） |
| GET | `/api/emby/System/Ext/ServerDomains` | **不是 Emby 核心端点** —— 第三方插件 `uhdnow/emby_ext_domains` 提供的「服务器地址清单」（`{data:[{name,url}],ok}`，用于内网/外网/备用域名切换）。真 Emby 没装那插件也是 404 | **不实现**（不在 Emby 协议里；接了反而像冒充那个插件。客户端本就该容忍它不存在） |

> **这张表里"没实现"的只剩三条**：`Items/{库Id}`（库详情，客户端尚未请求）、`System/Info`（带 token 的完整版，
> VidHub 在要）、`System/Ext/ServerDomains`（判定**不实现** —— 不是 Emby 核心端点，是第三方插件提供的，接了像冒充它）。
> 其余各行**都已实现**（`Resume` / `Studios` / 图片 / `Items/Latest` / `NextUp` / `Items/Counts` / `Views` /
> `Items?ParentId=` / 三条进度上报 / 三条观看状态写端点），其中 `Studios` / `Counts` 是**如实回空** —— 没有那份数据，空是如实；
> `Resume` / `NextUp` / `Items?Filters=IsPlayed` 自 [0023](adr/0023-playback-progress.md) 起出**真数据**
> （数据来自客户端上报的播放进度）。
> **还没做的端点级缺口**（`GenreItems` 的列表端点、`Sessions/Logout`、`/Users/Public`、用户级 `Similar`）
> 记录在 [develop.md](develop.md) 的「未实现」一节。

> **几个客户端的画像**（全部来自日志）：
>   · **Rex** —— 库内容走 `Items?ParentId=<库Id>`；另外发**无 `ParentId` 的「推荐」查询**（喂首页轮播图，见「五」）
>     与 **`AnyProviderIdEquals=tmdb.{id}`**（只有 tmdb 号 → 问本面板要 Id → 拿到就进详情）；要过 `Studios`。
>   · **VidHub 3.0.6** —— 首页**每一行**走 `Items/Latest?ParentId=<库Id>`；另外要 `System/Info`（未实现，它容忍）。
>   · **SenPlayer 6.1.8** —— 要过 `Shows/NextUp` / `Items/Counts` / `System/Ext/ServerDomains`；
>     **搜索框走 `Items?SearchTerm=`**（实测；以前回空 → 搜索永远是空的）；
>     另会打非 Emby 协议的 `api/danmu/{条目Id}`（弹幕插件，**501，暂不实现**）。
>   · **结论**：某条端点"没人要"**只对当时那批客户端成立** —— `Items/Latest` 原先就记着
>     "实测客户端从没打过"，来了 VidHub 直接作废（Rex 走的是 `Items?ParentId=`，只盯 Rex 的日志根本看不到）。
>     所以不要把"没人要"当永久结论，新客户端一进来就得重新看一遍。
> `Shows/{Id}/Seasons`、`Shows/{Id}/Episodes` 仍是 **TMDB 占位**（见「五」）—— 它们**不走聚合、没有源绑定**；
> 它们的「真实条目 + 源绑定」（tmdb id → 站点 `vod_id`）仍是待指定。

## 八、参考：猫爪源自带的相关能力

这些在**源服务**侧（`/website/api/**`，面板已同源代理到 `/website`），可作为实现时的参考，但不等于 Emby 客户端协议：

- `GET /website/api/emby/config`、`POST /website/api/emby/test`、`POST /website/api/emby/choose` —— 源里的多台 Emby 服务器配置与默认选择
- 源里的 `EmbyDiy` 通过 `ext` 的 `embynumber` 读取服务器序号
- 播放链路：`POST {api}/play` 得到 `url`（字符串或数组）+ `header`

## 九、相关文件

| 文件 | 作用 |
|---|---|
| `server/modules/emby/routes.js` | 已实现端点（握手 / 登录 / 取用户资料 / 媒体库留白 / 条目列表占位 / 季列表占位 / 分集列表占位 / 单条详情 / PlaybackInfo / Stream）+ 面板自用端点（账号管理 `GET/POST /api/emby/accounts`、`PUT/DELETE /api/emby/accounts/{id}`）+ 通配监控路由（记录 + 501，与 `notImplemented()` 共用），**通配必须注册在最后**。stream 端点在这一层**一律 302**（service 只回 `{url, headers, parse}` 描述，地址改写也在 service 做，见 `redirectUrl()`）；路由把 `req.headers.host` 传下去当"客户端域名" |
| `server/modules/emby/db.js` | emby 私有的本地库（**Node 内置 `node:sqlite`**，零依赖）：开库/建表/schema、`accounts` 表（用户名 + `username_lc UNIQUE` + scrypt 哈希 + 最近登录）、`sessions` 表（登录发的 AccessToken → 账号/设备/最后活跃）、`hashPassword/verifyPassword`、账号与会话的 CRUD、`publicAccount()`（**对外字段映射只此一处**，防手滑回传哈希）、`migrateLegacy()`（单账号明文 → 库，并**无条件清掉设置里的残留明文**）。文件 `data/emby/emby.db`，权限 600；**不存 `user_id` 列**（serverId 一变就全废，运行时现算） |
| `server/modules/emby/service.js` | 端点业务逻辑：服务器 Id、登录校验（多账号 + scrypt）、**AccessToken 校验（`tokenFrom` / `authorize`，无效即 401）**、UserDto 组装、媒体库（`getViews`——**按真机字段表补齐，含封面与 `CollectionType`**）、条目列表（`getItems`）、**最新条目（`getLatest`，回裸数组，顺序由模块决定）**、季列表、分集列表、单条详情（元数据复用列表实现 + 聚合取线路/绑定 + 线路→`MediaSources`）、播放信息（复用 getItem）、拉流解析（`resolveStream`：现取 detail+play，只回描述，不碰 res）；公共函数 `assertUser()`（账号校验，各端点共用）/ `baseItem()`（条目公共字段）/ `tmdbFailure()`（TMDB 失败 → 状态码 + 错误体，各端点共用）/ `catpawSourceId()` + `parseCatpawSourceId()`（`catpaw:<site>:<flag>` 的编解码）/ `streamPath()`（稳定 Path 拼接）/ `emptyUserData()` + `emptyViewUserData()`（**条目与库条目的 `UserData` 形状不同**）/ `itemsWillReturnData()`（判据只此一处）/ `feedOfQuery()`（认出客户端"只要推荐"的查询 → 路由到插件声明了 `feed` 的行）/ `imageTag()`；`X-Emby-Authorization` 解析 |
| `server/modules/agg/match.js` | **挑片判据（唯一一处）**：片名清洗（剥更新话术/画质/体积/年份/括号/分类后缀、去 emoji）+ 打分（名字 0.7 / 季集 0.2 / 年份 0.1，缺项不进分母）+ 两道闸门（名字硬拒 / 分数线可关）+ 按分数「取前 N」（**不去重**：同名照收，只统计）。取代了原来的「精确同名 + TMDB 别名回退」 |
| `server/modules/agg/api.js` | **聚合层的进程内调用面**：`loadSites()`、`detail()`（**内部含搜索**，可用 site+vodId 走快路径）、`play()`（→ 播放地址，PlaybackInfo 会用）。路由层（`/api/agg/detail` / `/play`）与 emby 层**共用这一套**；失败统一 `{ok:false, error:{code,status,message}}` |
| 聚合层契约（[develop.md](develop.md) 的「聚合层（agg）」一节） | `/api/agg/search`、`/api/agg/detail`、`/api/agg/play` 的入参、出参与错误码 |
| `server/core/tmdb.js` | **TMDB 协议层（共享）**：默认值与 `effective()` 合并、`current()`（读 `panel.json` 的 `tmdb.*`，**读配置的唯一入口**）、通用 `get()`（`noCache` 绕缓存，连通性自检用）、**响应缓存**（从 emby 搬来）：`isMetaPath()` / `cacheKey()` / `requestCached()`（落 `data/cache/tmdb.db` 的 `tmdb_cache`）、`requestWithRetry()`（**网络失败立即重试一次**）、`search()`（`search/tv\|movie`，结果落同库的 `name_index`，**emby 搜索端点用**；聚合层已改本地打分、不再调它）、图片拼串（`imageUrl` / `imageUrlOf` / `imageBase`）、`test()`（连通性 + 实查一个 id，两步都绕缓存）。**已从 emby 层拆出来** —— 聚合层也要用 TMDB，而 `emby → agg` 是单向依赖 |
| `server/core/cachedb.js` | **缓存的通用设施**（从 `emby/cache.js` 抽出来）：`createStore({label,dir,file,tables})`（**同 label 单例**：一库一句柄，避免 WAL 互锁）、`get`/`put`/`enforce`（TTL + 按字节 LRU）、`stats`/`clear`/`sweep`，以及跨 store 的 `statsAll()` / `clearAll()` / `sweepAll()`（面板的用量、清空、设置变更后扫一遍都走它们）；`cfg()`（缓存策略**只此一处**，读 `panel.json` 的 `cache.*`）、`NAME_TTL_MS`/`NAME_MAX_BYTES`（名字索引的固定口径）。WAL + `synchronous=NORMAL` |
| `server/modules/emby/tmdb.js` | **emby 专有那一层**（协议、配置与**缓存**都在 `core/tmdb.js`）：`itemId()`/`parseItemId()`（条目 Id 派生与解析，**互逆且必须挨着**，支持 `_{tv\|movie}[_s{n}][_e{m}]`）、`lookup()` 反查剧/影元数据（各端点共用，带 `withSeasons` 开关）、`lookupSeason()` 反查某一季的分集（season 接口）、`get()`（给首页插件的任意路径 GET，直接调 core，**不再注入任何缓存**）、`httpStatusOf()`（失败原因 → 回的 HTTP 码，**只此一处**）；图片索引：`splitImageUrl()`（剥成无头相对路径）/ `joinImageUrl()`（按当前基地址拼回） |
| `server/modules/emby/cache.js` | emby 自用的缓存（**独立** SQLite `data/emby/cache.db`，与账号库 `emby.db` 分开）：**只剩 `image_index`**（条目 Id → 图片位置，含插件给的自定义图地址）；`getImage`/`putImage`、`cfg()`（转调 `core/cachedb.js`）、`sweepFromSettings()`。`tmdb_cache` 与 `view_seen` 已搬走/删除（见上面「本地缓存」那条）；统计与清空**不在这里**（面板层统一，见 `core/cachedb.js`） |
| `server/modules/emby/log.js` | 请求日志（**每请求一行，不筛**）：`logResult` / `logMissing`（501 一行 + `logSeq`）/ `countOf`（只给日志数条数）/ `queryBrief` / `clientTag`；敏感信息掩码在 `queryBrief` 与 `logMissing` 里（见「二」） |
| `server/core/logbus.js` | 日志总线：`install()` 包一层 `console.log/warn/error`（**先透传 stdout，再入内存环形缓冲**）、按行拆分、单条截断 1000 字符、固定条数（默认 500，`panel.logMax` 可调）；`list()`/`clear()`/`resize()`/`stats()`。**纯内存、不落盘**（长期留档交给 docker 的 json-file）。在 `server.js` 里**加载模块之前**装（见「二」） |
| `server/modules/panel/routes.js` + `public/modules/panel/logs.js` | 日志页的数据口与页面：`GET /api/logs?since=&limit=`（增量）、`DELETE /api/logs`（清空）；页面「面板设置 → 日志」带暂停/清空/复制/级别过滤，增量轮询 + `isConnected` 守卫（见「二」） |
| `server/modules/emby/index.js` | 模块清单：`upstream: 'agg'`、设置项（`serverName` / `imageKey` / 账号空壳）与校验（服务器名长度）。**`play.filter` 已搬到聚合层**（`agg.json` 的 `lineFilter`，UI 在「聚合设置 → 聚合参数」），那份校验也跟着走了；`play.mode`（随"面板代理"一起删）、`tmdb.*` 与 `cache.*` 都不在这里了；这里也不再需要"放行老值"的兼容校验 —— 校验里没有那个键，盘上留着也不挡保存 |
| `server/modules/panel/index.js` | 面板层设置与钩子：`logMax`（改了就 `resize`）、`tmdb.*`、**`cache.*`**（`onSettingsChange` 里调 `cachedb.sweepAll()` 落实新上限） |
| `public/modules/emby/setup.js`（「Emby → 连接设置」页） | **两张卡**：**服务器名** / **账号管理（多账号：列表 + 弹窗新增 + 改密 + 删除）**。（原来的「播放设置」卡整张撤掉：拉流一律 302 没有可选项、线路过滤搬到「聚合设置 → 聚合参数」。）**聚合地址不显示**（就是本面板自己，没得填）；TMDB 与缓存设置已搬到面板设置页 |
| `public/modules/panel/settings.js`（「面板设置」页） | 版本与更新（**更新内容用弹窗展示**，含 GitHub 上那个 Release 的链接）/ 备份还原 / **TMDB 设置** / **缓存设置**（用量 + 上限 + 清空，端点 `GET\|DELETE /api/panel/cache`）/ 面板密码 / **关于**（名称、版本、仓库地址 —— 地址取自 `GET /api/panel/info`） |
| `data/settings/emby.json` | `account`（**只剩空壳**，账号已搬到 sqlite）、`serverId`、`imageKey`（`tmdb.*` 与 `cache.*` 搬到 `panel.json`；`play.filter` 搬到 `agg.json` 的 `lineFilter`，盘上那两个老键既不读也不校验） |
| `data/settings/panel.json` | 面板监听参数、`logMax`、`modules`、**`tmdb.{token,apiBase,imageBase,language}`**、**`cache.{tmdbTtlDays,tmdbMaxMB,imageTtlDays,imageMaxMB}`**（都在启动时从 `emby.json` 自动搬迁、数值不丢） |
| `data/emby/emby.db` | 客户端登录账号表（内置 sqlite；密码为 scrypt 哈希）。**「配置备份/还原」不包含它**（`backup.js` 只打包 `settings/`）—— 还原备份后账号要重建 |

