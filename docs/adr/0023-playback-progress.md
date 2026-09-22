# ADR-0023 观看进度：客户端上报落库，读端点出真数据

- 状态：已采纳
- 相关：[0008](0008-no-fabricated-data.md)（不编数据）· [0009](0009-unauthenticated-empty-responses.md)
  （回空不校验账号、真数据必须校验）· [0007](0007-emby-dto-shape.md)（DTO 形状）·
  [播放进度实现方案与实测记录](../playback-progress.md) · [db.js](../../server/modules/emby/db.js)（`playback` 表）·
  [service.js](../../server/modules/emby/service.js)（`recordPlayback` / `getResume` / `getNextUp` / `applyUserData`）·
  [routes.js](../../server/modules/emby/routes.js)（三条上报端点）

## 背景

Emby 客户端在播放过程中会往服务器上报三件事（实测 SenPlayer 6.2.1 与 Rex 0.1.0）：

| 端点 | 时机 | 实测频率 |
|---|---|---|
| `POST /Sessions/Playing` | 开始播放 | 1 次 |
| `POST /Sessions/Playing/Progress` | 播放中 | **每 10 秒一次** |
| `POST /Sessions/Playing/Stopped` | 停止 / 退出 | 1 次 |

body 里 `ItemId` **就是本面板发出去的 Id**（`tmdb_{id}_tv_s{n}_e{m}` / `tmdb_{id}_movie`）—— 客户端原样回传、
不做解析；另有 `PositionTicks`、`RunTimeTicks`（**只有部分心跳带它**）、`PlaySessionId`、`MediaSourceId`。
**没有 `Played` 字段，也不带 `UserId`**（账号只能从 token 认）。

这三条此前落到 501 通配，于是**同一份数据在读侧也只能如实回空**：`Items/Resume`、`Shows/NextUp`、
`Items?Filters=IsPlayed`，以及每个条目的 `UserData`（永远 `{PlaybackPositionTicks:0, Played:false}`）。
实测日志里 `Stopped` 之后紧接着的 `Resume` 与 `NextUp` 都是 `Items=0` —— 客户端首页的
「继续观看 / 接下来看」永远是空的。

## 决定

**三条上报端点收下并落库；读侧改成按库里的进度出真数据。**

- **落库**：`data/emby/emby.db` 新增 `playback` 表（`SCHEMA_VERSION` 2 → 3）。一行 = 一个账号 +
  一条**可播条目**（电影 / 集）的最后状态，主键 `(account_id, item_id)`，**覆盖写** ——
  心跳每 10 秒一条，append 会让库随播放时长线性增长。
- **关联键用 `account_id`**，不用 `user_id`：后者是 `md5(serverId + 用户名)`，serverId 丢一次
  或改个用户名就全变。
- **"看完"按比例判**：`PositionTicks / RunTimeTicks ≥ 0.9`（客户端不报 `Played`）。判为看完时
  `played = 1`、`play_count + 1`、**位置归零** —— 与真机行为一致（实测：报 95% 后 `Stopped` →
  `Played: true`、`PlaybackPositionTicks: 0`，同时从 `Resume` 消失、进 `IsPlayed`）。已看条目又有了进度
  （重看）时退回"未看完"，否则「继续观看」永远看不到它。
- **响应一律 204 空体**：真机实测三条都是 204（空 body 的 `Stopped` 也是 204）。
- **三条都校验账号**（与真机的一处差异，见「后果」）。
- **读侧**：
  - `Items/Resume` = 有位置、未看完的条目，按最近更新倒序（与真机排序一致）；
  - `Shows/NextUp` = 该剧最近观看的那一集**未看完就回它自己**，**看完则回下一集** ——
    下一集必须在 TMDB 的季数据里**真实存在**（同季找不到就试下一季第 1 集），否则跳过这部剧；
  - `Items?Filters=IsPlayed` = 已看列表；
  - `applyUserData()` 给列表 / 详情 / 季 / 集 / 最新 / 相似这些端点的条目补真实 `UserData`。
  - 前三条**全部校验账号**（回的是某个账号的观看记录）；`Filters=IsFavorite` 仍如实回空
    （收藏需要写端点，**没做**）。
- **不编数据**：条目元数据按坐标反查 TMDB（走 `data/cache/tmdb.db` 缓存），**反查不到就不列出那一条**
  （不编名字、不编封面）；剧级条目（`tmdb_x_tv`）**不补任何 `UserData`** —— "整剧是否看完"要知道总集数，
  本层不知道，宁可不给。
- **条目上要给客户端画进度条所需的两样东西**（对比真机后补齐）：`UserData.PlayedPercentage`
  （小数百分比，如 `5`；位置为 0 时**不给** —— 真机也是如此）与**条目级 `RunTimeTicks`**
  （用客户端上报的时长）。只给 `PlaybackPositionTicks` 而条目又没有时长时，客户端界面上就是
  **光秃秃没有进度条**。另补 `LastPlayedDate`（进度行最后更新的时间）。

## 理由

- 客户端已经在按协议上报，面板是唯一缺口：接住它，四个读端点一起活过来，**不需要客户端配合**。
- 心跳是覆盖写、每账号每片一行，库的体积与"看过多少"线性相关（每条几十字节），不需要清理策略。
- 进度是**用户数据**，与账号同库（`emby.db`）：账号删掉时一并清掉（`removeAccount` 已经带上这一步）。
- `node:sqlite` 的接口是**同步**的，所以"给条目补 `UserData`"这一步不必 async 化，
  做成响应后处理（`applyUserData`）就够，不必给每个 DTO 都加账号参数。

## 备选

- **只把 501 改成 204 收下，不落库**：客户端不再报错，但「继续观看 / 已看」永远是空的 ——
  等于假装支持，比回空更差（ADR-0008 的取向）。
- **写时快照元数据**（把名字/封面存进 `playback`）：读侧完全不碰上游。代价是心跳路径要做 TMDB 反查
  （写变重），且快照会与 TMDB 的后续变化脱节。当前选择**读时反查**。
- **按 `PlaySessionId` 分设备存**（真机就是按 session 存的）：能支持"两台设备各自的进度"，
  但读侧要定合并策略、主键也要改。当前取"尾写胜出"。

## 后果

- **多设备不区分**：同一账号两台设备看同一部片会互相覆盖位置（见上）。
- **与真机的差异（三处，都是刻意的）**：
  1. 真机在 `Sessions/Playing` 那一刻就 `PlayCount + 1`；本层按**看完才 +1**（`Resume` / `已看` 的语义更自洽）。
  2. 真机的 `Progress` **不校验 token**（实测不带 token 也回 204）；本层三条都校验（写真实数据，按 ADR-0009）。
  3. 真机的 `Resume` 会带 `PlaybackPositionTicks: 0` 的"该接着看的下一集"；本层 `Resume` 只要"位置 > 0 且未看完"，
     那种语义由 `NextUp` 承担。
- **进度不进备份**：面板的导出备份只有设置 + 源清单（见 [backup.js](../../server/modules/panel/backup.js)），
  `emby.db` 里的账号、会话与进度都不在其中 —— 重装 / 换机即丢。
- **`Filters=IsPlayed` 从"必然空"变成"真数据"**，所以 `itemsWillReturnData()` 的判据跟着翻
  （ADR-0009 的口径：真数据端点必须校验账号）。⚠️ 这一处若漏改，就是"未鉴权可读别人的观看记录"。
- 剧（Series）条目仍然给空 `UserData`：客户端不会在剧上看到"已看 / 看到哪"，只有在集上能看到。
