# 播放进度上报（`POST /Sessions/Playing*`）实现方案

> 状态：**已实施**（决策落在 [ADR-0023](adr/0023-playback-progress.md)；本文保留为设计过程与真机实测记录）。
> 与方案的两处偏差：① 元数据**读时按坐标反查 TMDB**（走 `data/cache/tmdb.db` 缓存），**不写快照**（§5.2 选 B 而非 A）；
> ② `PlayCount` 按"看完才 +1"（真机是"开始播放就 +1"，差异记在 ADR-0023 的「后果」）。
> 实测依据：面板容器留档日志 `2026-09-22T16:52:35 ~ 17:01:31Z`（96 行，`docker logs media-bridge-panel`）。
> 实施时按 `CONTRIBUTING.md` 的规矩补一条 **ADR-0023**（新数据结构 + 新失败语义），并把三条端点登记进
> `docs/emby-compat.md`「五、已实现端点」表、把缺口从 `docs/develop.md` 的「未实现」节里划掉。

---

## 1. 为什么要做（实测，不是推测）

| 本地时间 | 请求 | 结果 |
|---|---|---|
| 01:00:38 | `POST /api/emby/Sessions/Playing` `[SenPlayer/6.2.1]` | 501 `未实现#9` |
| 01:00:42 | `POST /api/emby/Sessions/Playing/Progress` | 501 `未实现#10` |
| 01:00:52 | `POST /api/emby/Sessions/Playing/Progress` | 501 `未实现#11` |
| 01:01:02 | `POST /api/emby/Sessions/Playing/Progress` | 501 `未实现#12` |
| 01:01:09 | `POST /api/emby/Sessions/Playing/Stopped` | 501 `未实现#13` |

- **心跳是规整的每 10 秒一次**（`:42 → :52 → :02`），这是 Emby 客户端的标准行为。
- **501 不会让客户端停止上报**：连被拒 3 次仍照发。（早前 `Rex/0.1.0` 只发了 `Playing` 一条、没有 `Progress` ——
  那一轮它没真正进入播放态，不是被 501 劝退。这条排除了"是不是客户端不发"的疑问。）
- **写侧被拒 → 读侧必然空**：`Stopped` 之后的 `Resume`（01:01:09）与 `NextUp`（01:01:10）仍然
  `Items=0  没有观看记录 → 空（如实）`。读侧现在是**硬编码回空**：`service.js` 的 `getResume`（432-434）、
  `getNextUp`（596-598）、`getItems` 的 `Filters=IsPlayed` 分支（665-667）。

结论：**协议侧只差这三条端点**。接住它们并落库，`继续观看` / `接下来看` / `已看` 就能一起活过来。

## 2. 范围

**做**：三条写端点（`Playing` / `Progress` / `Stopped`）+ 进度落库 + 读侧四处（`Resume` / `NextUp` /
`Filters=IsPlayed` / 每个条目的 `UserData`）。

**不做**（写下来免得以后反复琢磨）：

- `POST /Sessions/Logout`、`/Users/Public`（已在 `develop.md` 的未实现清单里，本轮不碰）；
- 弹幕端点（`GET /api/emby/api/danmu/*`，SenPlayer 与 Rex 都在要，属另一件事）；
- `GET /Sessions`（在线设备列表）、远程控制、`Sessions/Capabilities`、WebSocket / Notifications；
- 转会/播放统计报表（码率、卡顿、总时长）；
- `IsFavorite`（收藏需要**写**端点，另立一件事；`Filters=IsFavorite` 继续如实回空）。

## 3. 第 0 步：先观测 body，再实现（1 处小改动，零风险）

**为什么必须先做**：body 的字段名**不能猜**。现在这条请求落到通配
`ANY /api/emby/*rest`（`routes.js:580-590`），它**读了 body 却丢掉**：

```js
r.add('ANY', '/api/emby/*rest', async (req, res, { pathname, query }) => {
  let body = null;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try { body = await readRawBody(req, 1024 * 1024); } catch { body = '(请求体读取失败)'; }
  }
  return notImplemented(req, res, { pathname, query, body });   // ← notImplemented 只取 pathname/query
});
```

**只做两件事**：

1. `notImplemented(req, res, { pathname, query, body })` 接收 body（`routes.js:60`）；
2. `log.js` 新增 `bodyBrief(raw)`：**掩码 + 限长 300 字符**（掩码复用 `SENSITIVE_KEY`，`log.js:34`），
   附在 `未实现#N` 那行末尾。

跑一轮真实播放后，才能确定要读的真名：`ItemId` / `PositionTicks` / `MediaSourceId` / `PlaySessionId` /
`Played` / `RunTimeTicks`（各家客户端与版本有差异，官方文档也只写了个大概）。

**验收**：日志里出现形如 `未实现#N POST /api/emby/Sessions/Playing {ItemId:…,PositionTicks:…}` 的一行，
且**不出现任何 token / 密码原文**。

## 4. 第 1 步：接住 + 落库

### 4.1 端点契约

| 方法 | 路径 | 语义 | 响应 |
|---|---|---|---|
| POST | `/api/emby/Sessions/Playing` | 开始播放 | 204 空体 |
| POST | `/api/emby/Sessions/Playing/Progress` | 每 10 秒心跳 | 204 空体 |
| POST | `/api/emby/Sessions/Playing/Stopped` | 结束 / 停止 | 204 空体 |

- **注册位置**：三条都必须注册在 `routes.js:580` 的通配**之前**，否则永远 501。
  段数 4/5/5 不同，`router.js:38` 要求段数相等才匹配 ⇒ 三条互不冲突。
- **鉴权**：`service.authorize(req, body.UserId)`（ADR-0009：会写真实数据的端点必须校验账号）。
  这三条客户端都带 token（实测非图片请求 9/9 都带）——**没 token 一律 401**，不要豁免。
- **读 body**：`readBody(req)`（`core/http.js:62`，JSON，默认上限 8MB，非法 JSON 抛 `code=400`）。
  ⚠️ `readRawBody` 超限抛的 Error **没有 `.code`**，`server.js:91-93` 会把它当 500（不是 413）——
  要在意就自己先看 `Content-Length`。
- **响应码 204 空体**：三条都是。**已在真机 Emby 4.9.5.0 上实测确认**（见 §11），不再是"照官方参考实现推测"。
  实现照此写：`res.writeHead(204)` + `res.end()`，不回 JSON 体。
- **空 body 的语义**（实测）：`Playing` / `Progress` 回 **400** `Value cannot be null. (Parameter 'key')`；
  `Stopped` 回 **204**（空 body 当空操作）—— 所以 `Stopped` 要容忍空 body，别因此报错。
- **鉴权**（实测）：`Playing` / `Stopped` 缺 token → **401** `Access token is invalid or expired.`；
  而 **`Progress` 缺 token 也回 204**（真机对进度心跳是"尽力而为、不求鉴权"）。
  本面板按 ADR-0009 的口径**三条一律校验账号**（它们都会写真实数据）—— 这处与真机的差异写进 ADR-0023。
- **ItemId 形状**：真机要求 Guid（非 Guid 回 **500** `Unrecognized Guid format.`），
  而本面板发出去的是 `tmdb_*`。客户端**只是原样回传**，所以实现按 `tmdb.parseItemId` 判形状；
  认不出的仍按「未实现」记一行 + 501（不静默吞掉，沿用现有口径）。

### 4.2 数据模型（新表 `playback`）

`db.js` 头注释早就写了"**以后还会挂进度与收藏**"（`db.js:9`），这张表就是那一句的兑现。

```sql
CREATE TABLE IF NOT EXISTS playback (
  account_id     INTEGER NOT NULL,   -- accounts.id（**绝不用 user_id**，理由见 4.3）
  item_id        TEXT    NOT NULL,   -- 面板派生的 ItemId（episode 或 movie 级，见 4.4）
  position_ticks INTEGER NOT NULL DEFAULT 0,   -- 100ns tick（10^7 tick = 1 秒）
  runtime_ticks  INTEGER NOT NULL DEFAULT 0,   -- 判"看完"用
  played         INTEGER NOT NULL DEFAULT 0,   -- 0/1
  play_count     INTEGER NOT NULL DEFAULT 0,   -- 只在 Stopped 判为看完时 +1
  snapshot       TEXT,                         -- §5.2 的元数据快照（JSON，可为空）
  updated_at     TEXT    NOT NULL,
  PRIMARY KEY (account_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_playback_recent ON playback(account_id, played, updated_at DESC);
```

- 建表方式照现有：`CREATE TABLE IF NOT EXISTS` + 把 `SCHEMA_VERSION` 从 2 提到 **3**（`db.js:19`、`49-73`）。
  没有版本号迁移机制，也不需要（新表而已，与当年加 `sessions` 同样）。
- **写入是覆盖写（upsert），绝不 append**：心跳每 10 秒一条，append 会让库随播放时长线性增长。
  `INSERT … ON CONFLICT(account_id, item_id) DO UPDATE`。

**写入口径**：

| 端点 | position_ticks | played / play_count |
|---|---|---|
| `Playing` | `body.PositionTicks \|\| 0` | 不动 |
| `Progress` | 同上报值 | 不动（`IsPaused` 不改变语义） |
| `Stopped` | 写完最后位置 | 判为看完 → `played=1`、`play_count+1`、**`position_ticks` 归零** |

- "看完"的判据：**优先用 body 里明确的字段（若实测有 `Played`）**；否则按
  `position_ticks / runtime_ticks ≥ 0.9`（阈值写成带注释的常量，先不开口子）。
- `played=1` 时 `position_ticks=0`：真机"看完"的条目 `PlaybackPositionTicks` 就是 0，`Resume` 也不该再列它。
- 单位是 100ns tick：只做**比较与透传**，不做秒换算、不在前端显示时长。
- ⚠️ **与真机的一处差异（实测）**：真机在 `Sessions/Playing` 那一刻就把 `PlayCount` +1（实测 2 → 3），
  并不等"看完"。本方案按"看完才 +1"（`Resume` / `已看` 的语义更自洽）—— 差异写进 ADR-0023。

### 4.3 账号归属：用 `account_id`，不用 `user_id`

`user_id = md5(serverId + '|' + 归一化用户名)`（`service.js:54-56`），而 `serverId` 存在 `emby.json` 里、
**可能丢**（丢一次全变），改用户名也会变。`db.js` 也刻意不存 `user_id` 列。
`db.findSession(token)` 已经把 `account_id` JOIN 出来了（`db.js:255-267`）—— 落库键就用它。

### 4.4 键的粒度：集 / 电影

条目 Id 由 `tmdb.js:81-106` 的 `itemId()` 派生，四种形状：`tmdb_<id>_movie`、`tmdb_<id>_tv`、
`tmdb_<id>_tv_s{n}`、`tmdb_<id>_tv_s{n}_e{m}`。**可播的只有后两种里的"电影 / 集"**（`isPlayableId()`，`service.js:2168`），
所以客户端上报的 `ItemId` 一定是 **episode 或 movie 级** —— 进度就记在这一级，剧级（`_tv`）不记。
`Resume` 列表里"某部剧"的呈现，由读侧从集坐标反推 `SeriesId` / `SeriesName` / 季集号。

`PlaySessionId` 本轮**不入库**：它区分设备，而入库后要多设备合并策略（见 §7 的后果说明）。

## 5. 第 2 步：读侧，让"继续观看"出真数据

### 5.1 注入点只有三处，而且是**同步**的

`node:sqlite` 的 `DatabaseSync` 是同步 API ⇒ `baseItem()` 里**可以直接查库**，读侧不需要 async 改造：

| 位置 | 现状 | 改法 |
|---|---|---|
| `service.js:2416`（`baseItem()` 内） | `UserData: emptyUserData()` | 由调用方传 `f.userData`（有记录给真值，无记录给现有的空形状） |
| `service.js:395`（`homeViewItem()`） | `UserData: emptyViewUserData()` | 库条目形状不同（少 `PlayCount`），**别复用**那条 |
| `homeItemDto()` / `leanItemDto()` / `tmdbItemDto()` / `getSeasons()` / `getEpisodes()` | 多数**不带** `UserData` | 补上（否则库列表与详情看不到"已看"和"看到哪"） |

⚠️ **字段集合必须一致**（ADR-0007）：有记录与无记录时 `UserData` 的键要完全相同，只是取值不同。

`accountId` 的来源是本方案**唯一需要动公共 API 的地方**：`authorize()` / `assertUser()` 目前通过时只返回
`null`（`service.js:197-211`、`279-287`），拿不到账号。二选一：

- ① 新增 `authorizeAccount(req, uid)` → 通过时返回 `{account}`，拒绝时返回 `{status, body, log}`；
- ② 通过时把账号挂到 `req`（`req.embyAccount`），后续读取。

（倾向 ①：显式、好搜、不隐式改 req。）

### 5.2 `Items/Resume`（现在硬回空：`service.js:432-434`）

查询：`SELECT … FROM playback WHERE account_id=? AND played=0 AND position_ticks>0 ORDER BY updated_at DESC LIMIT ?`
（`Limit` 由客户端给，默认取一个稳妥值，硬顶防打爆）。

**元数据从哪来 —— 这是本方案最需要先定下来的一处**，因为进度表只有 Id：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A（推荐）写时快照** | 写端点里**只在该 item 还没有快照时** resolve 一次（`tmdb.lookup`，通常命中已有缓存），把最小字段存进 `snapshot` | 写路径多一次（一次性的）解析；读路径完全不碰上游，行为可预测 |
| B 读时 resolve | `Resume` 时按坐标现查，走 `tmdb` 缓存 | 冷缓存时**会真的打上游**；`Resume` 是客户端高频端点 |
| C 只读缓存 | 只读缓存，查不到就不列 | 需要在 `core/tmdb.js` 新增 `cacheOnly`（现在只有 `noCache`，**没有**"只读"的口子） |

**快照要存的最小字段**（够拼一条列表项）：`Name` / `Type`(`Episode`\|`Movie`) / `ProductionYear` /
`posterUrl` / `runTimeTicks` / 剧集还需 `SeriesId` / `SeriesName` / `ParentIndexNumber` / `IndexNumber`。

⚠️ 真机在 `Resume` 里给的字段比上面更多（见 §11 的响应样例），而且有一条容易踩：
**集条目的海报来自"剧"**（`SeriesPrimaryImageTag` + `ParentBackdropItemId` / `ParentBackdropImageTags`，
集自己的 `ImageTags` 是**空对象**）。所以快照里要存的是**剧的海报 tag**，不能只按集 Id 去查图片索引 ——
否则集卡片全都没有封面。
**resolve 失败就不存**（不编名字、不编封面，ADR-0008）——读侧遇到没有快照的行**跳过它**并记一行日志，
而不是显示一条无名条目。

- 图片**必须**走 `tagAndRemember()`（`service.js:2465-2481`）给 `PrimaryImageTag`，否则客户端不显示封面。
- ⚠️ **`getResume` 现在不校验账号**（ADR-0009 把它归为"必然回空"）。一旦会回真数据，
  **必须**改成先鉴权 —— 否则任何人都能读到某个账号的观看记录。
- `Shows/NextUp`（`service.js:596-598`）语义是"正在追的剧的下一集"，需要季集信息，
  **建议放到第 3 步**（本轮先只让 `Resume` 活起来）。

### 5.3 `Filters=IsPlayed`（`service.js:665-667`）

- 拆开两个过滤器：`IsPlayed` → 查 `playback` 里 `played=1` 的条目（元数据同 §5.2）；`IsFavorite` 继续回空。
- ⚠️ **必须同时改 `itemsWillReturnData()`（`service.js:476-484`）**：它现在把 `Filters=IsPlayed` 判成
  "必然回空 ⇒ 不校验账号"，而这个判据被**路由层**（`routes.js:210`）与 `getItems`（`service.js:720`）共用。
  不改它 = **未鉴权就能读到别人账号的观看记录**（跨账号泄漏）。这是本方案风险最高的一处。

## 6. 与既有决策的关系

不推翻任何 ADR，但有三条**必须遵守**（从"回空"变成"回真数据"会踩到它们）：

- **ADR-0008（不编数据）**：resolve 不到就不放那条，绝不编名字/封面；进度值只写真值。
- **ADR-0009（真数据端点必须校验账号）**：`Resume` / `NextUp` / `Filters=IsPlayed` 三条全部加校验，
  并在新 ADR 里写明它们从"必然空"迁到了"真数据"。
- **ADR-0007（DTO 形状）**：`UserData` 的字段集合在有无记录时保持一致。

按 `CONTRIBUTING.md:18-19`（涉及数据结构与失败策略的改动要补 ADR）新增 **ADR-0023**，
内容 = 本方案的"决定 + 理由 + 备选 + 后果"（尤其要写下 §7 的两条后果）。

## 7. 已知代价与后果（写进 ADR 的"后果"一节）

1. **多设备不区分**：真机按 session 存，同一账号两台设备看同一部片会互相覆盖位置。
   本方案的取舍是"尾写胜出"（`PRIMARY KEY (account_id, item_id)` 的 upsert 天然如此）。
2. **账号没了进度也没了**：`removeAccount()` 时要顺手删该账号的行（`db.js:227-230` 加一句）。
3. **备份不含这张表**：`server/modules/panel/backup.js` 写明只备份「配置」（`settings/<模块>.json` + 源清单），
   所以 `data/emby/emby.db` 里的账号、会话与**播放进度都不进备份**，重装 / 换机即丢。
   要不要把 `emby.db` 一起纳入备份，是一个独立取舍（见 §9）。
4. **库会长期长胖**：每账号每条最多一行，但仍要定保留策略（见 §9）。

## 8. 改动文件清单

| 文件 | 改动 |
|---|---|
| `server/modules/emby/routes.js` | 新增 3 条 POST 路由（注册在 580 通配前）；第 0 步把通配读到的 body 传给 `notImplemented` |
| `server/modules/emby/service.js` | 新增 `recordPlayback()`；改 `getResume` / `getNextUp` / `getItems` 的 Filters 分支 / `itemsWillReturnData`；`baseItem` 与各 DTO 的 `UserData` 注入；`userDataOf(accountId,itemId)`；`authorize` 的回账号通道 |
| `server/modules/emby/db.js` | `playback` 表 + `SCHEMA_VERSION=3`；`upsertPlayback` / `listResume` / `listPlayed` / `userDataOf` / `removePlaybackOfAccount` |
| `server/modules/emby/log.js` | `bodyBrief()`（掩码 + 限长 300）并导出 |
| `server/core/tmdb.js` | 仅当选 §5.2 的 C 方案：加 `cacheOnly` |
| `docs/adr/0023-*.md`（新）、`docs/adr/README.md`、`docs/emby-compat.md`、`docs/develop.md` | 决策与端点清单同步（`Sessions/Playing*` 现在**根本没登记**在缺口清单里，顺手补上） |
| `CHANGELOG.md` | `[Unreleased]` 记一条 |

## 9. 动工前需要定下的几件事

1. **§5.2 元数据来源**选 A / B / C（建议选 **A**：写时一次性快照，读侧绝不碰上游）。
2. **`NextUp` 本轮做还是下一轮**（建议放到下一轮，先让"继续观看"活起来）。
3. **保留策略**：每账号最多 N 行（如 500）／或按时间淘汰（如 90 天，与图片索引一个口径）。
4. **成功日志要不要带 body 摘要**（建议带：一行 `Playback` 能复盘"客户端到底报了什么"）。
5. **是否同时动 `PlaybackInfo`**：客户端重开时给"从上次位置继续"（`StartTimeTicks` / `MediaSources[].DefaultAudioStreamIndex` 等）
   需要把 `position_ticks` 回给客户端 —— 真机是在 `PlaybackInfo` 响应里给"续播位置"的。
   这属本方案的**自然延伸**，会再加一处改动（建议做完 `Resume` 看到效果后再定）。
6. **`emby.db` 要不要纳入面板备份**：现状不在（`backup.js` 只导设置 + 源清单），账号 / 会话 / 进度重装即丢；
   纳进去会让备份包含密码哈希与观看记录，需要权衡。

## 10. 验收清单（真机跑，逐条打勾）

- [ ] SenPlayer 播 30 秒 → 库里出现 1 行（`account_id` / `position_ticks` / `runtime_ticks` / `updated_at`）
- [ ] 三条端点日志都是 2xx，且带 body 摘要
- [ ] 播放中退出客户端 → `Resume` 第一条就是它，`PlaybackPositionTicks` 与实际位置差 < 10 秒
- [ ] 播到 ≥90% → `played=1`、`position_ticks=0`、`Filters=IsPlayed` 能查到、`Resume` 不再列它
- [ ] 同一部片连播两次：`PlayCount` 不重复涨
- [ ] 无 token 调这三条 → 401；A 的 token 报 B 的 `UserId` → 401
- [ ] 两个账号的进度互不可见（跨账号读取必须被 `itemsWillReturnData` 的鉴权拦住）
- [ ] `data/emby/emby.db` 的 schema_version 已变 3，老库升级后账号/会话照旧可用

## 11. 真机实测记录（`2026-09-22`，Emby 4.9.5.0 兼容实现）

探测方式：登录真机拿到 token → 对三条端点发最小 body（`PositionTicks = 0`）→ 立刻 `Stopped` 收尾。
探测前后 `Items/Resume` 与 `Filters=IsPlayed` 的返回**完全一致** ⇒ 没有在真机上留下观看痕迹。

| 探测 | 结果 |
|---|---|
| `POST /Sessions/Playing`（真实条目） | **204**，空体 |
| `POST /Sessions/Playing/Progress` | **204**，空体 |
| `POST /Sessions/Playing/Stopped` | **204**，空体 |
| `Playing` / `Progress` 空 body | **400** `Value cannot be null. (Parameter 'key')` |
| `Stopped` 空 body | **204**（当空操作处理） |
| `Playing` / `Stopped` 不带 token | **401** `Access token is invalid or expired.` |
| `Progress` 不带 token | **204**（不拦） |
| 乱造形状的 `ItemId` | **500** `Unrecognized Guid format.` |

真机 `Items/Resume` 的**集**条目形状（读侧要照着拼；比普通列表项多一批 `Series*` / `Season*` 字段）：

```json
{"Id":"974380","Name":"临阵脱逃","Type":"Episode","MediaType":"Video","IsFolder":false,
 "RunTimeTicks":13845600000,"IndexNumber":210,"ParentIndexNumber":5,
 "SeriesId":"964450","SeriesName":"斗破苍穹","SeasonId":"964451","SeasonName":"Season 5",
 "SeriesPrimaryImageTag":"…","ParentBackdropItemId":"964450","ParentBackdropImageTags":["…"],
 "UserData":{"PlaybackPositionTicks":0,"PlayCount":0,"IsFavorite":false,"Played":false},
 "ImageTags":{},"BackdropImageTags":[]}
```

两条要点：

- **集的海报来自剧**（`SeriesPrimaryImageTag`，集自身 `ImageTags` 为空）⇒ 读侧要记住"剧的海报 tag"。
- 这台真机的 `Resume` 两条都带 `PlaybackPositionTicks: 0` ⇒ 它的语义比"位置 > 0"更宽（含"该接着看的下一集"）。
  本面板的 `Resume` 按方案走"位置 > 0 且未看完"，**不照抄这个宽度**。

### 写端点（`2026-09-23`，Emby 4.9.5.0；同样探测前后已还原）

| 探测 | 结果 |
|---|---|
| `POST …/Items/{id}/HideFromResume?Hide=true` | **200** + `UserItemDataDto`；**`UserData` 一个字段都没动**；`Resume` 3 → 2 条 |
| `POST …/HideFromResume?Hide=false` | **200** + 同样的 DTO；`Resume` 回到 3 条 |
| `POST …/PlayedItems/{id}` | **200** + `UserItemDataDto`（`Played:true`、**`PlayCount` 原样**）；`Resume` 3 → 2、`IsPlayed` 5 → 6 |
| `DELETE …/PlayedItems/{id}` | **200** + `UserItemDataDto`（`Played:false`、`PlayCount:0`、**`LastPlayedDate` 消失**）；`Resume` 回 3、`IsPlayed` 回 5 |

三条结论直接改进了实现：**隐藏不动进度**、**隐藏就是"把这条从接着看里拿掉"**（本层因此把隐藏也记进库，
并让 `Shows/NextUp` 跳过被隐藏的集）、**「标记已看」把 `PlayCount` 抬到至少 1**（本层先写成"不动"、
再改成"加一"，最终按实测定为 `max(1, 已有值)`）。

另补一条实测：**真机的 `Shows/NextUp` 始终是空的**（标记已看 / 真实播放进度 / 正规集号三种条件都试过）——
它把"接着看的下一集"放在 `Resume` 里（位置 0）。所以"隐藏是否影响 `NextUp`"**在真机上问不出来**，
本层按"隐藏 = 从接着看里拿掉"自行定口径，并在 ADR-0023 写明。

整轮探测没留残迹：用过的那两集在收尾后 `UserData` 逐字段与探测前一致。

一处**探不掉的残留**：真机 `DELETE` 把 `PlayCount` 归 0，而探测前那条是 `PlayCount:1 / Played:false` ——
API 没有"设置播放次数"的端点，补不回去。

### 深一层探测（同一台真机）

用一部电影（`RunTimeTicks = 76711040000`，约 127.9 分钟）走完整链路：

| 步骤 | 真机结果 |
|---|---|
| 报 5%（`Playing` + `Progress`，3835552000 tick） | 条目 `UserData.PlaybackPositionTicks` **与上报值完全相等**，并多出 `PlayedPercentage: 5` |
| 同一时刻的 `Items/Resume` | 该条目排**第一条**（最近更新优先）⇒ 读侧按 `updated_at DESC` 排序与真机一致 |
| 报 95% 后 `Stopped` | `Played: true`、`PlaybackPositionTicks: 0`；从 `Resume` 消失、进 `IsPlayed` ⇒ 与 §4.2 的写入口径一致 |
| `PlayCount` | **在 `Playing` 那一刻就 +1**（2 → 3），不是"看完才 +1" |
| 清理：`DELETE /Users/{uid}/PlayedItems/{id}` | **200**，返回完整 UserData（位置、计数、`Played` 全归零）—— 排障时一次到位 |
| 清理：`POST /Users/{uid}/Items/{id}/UserData` `{PlaybackPositionTicks:0,Played:false}` | **204** |
| 清理：`DELETE /Users/{uid}/Items/{id}/UserData` | **404**（没有这条端点） |

探测后 `Items/Resume` 与 `Filters=IsPlayed` **与基线完全一致**。唯一可见改动：清理用的
`DELETE PlayedItems` 把该条目的 `PlayCount` 从 2 清成 0（那是它自己维护的计数，不由进度上报决定）。
