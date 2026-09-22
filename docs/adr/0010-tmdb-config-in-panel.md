# ADR-0010 TMDB 配置归面板层

- 状态：已采纳
- 相关：[0001](0001-module-layering.md) · [tmdb.js](../../server/core/tmdb.js) · [0011](0011-cache-split-by-consumer.md)

## 背景

TMDB 设置原先存放在 emby 模块的设置里（`settings/emby.json` 的 `tmdb.*`），因为最早只有 emby 层使用它。
随后聚合层也开始使用它（在名字匹配不上时按名字反查 tmdb id）。
而依赖方向是 `emby → agg`（见 [ADR-0001](0001-module-layering.md)），**聚合层读不到 emby 层的配置**。
TMDB 协议实现位于 `server/core/tmdb.js`，属于基础层，被两层共用 ——
它的配置若留在消费层，基础层就要反向依赖消费层。

## 决定

TMDB 配置上移到面板层（`data/settings/panel.json` 的 `tmdb.*`），
连通性测试端点一并移动（`POST /api/panel/tmdb/test`）。
`core/tmdb.js` 作为协议层与响应缓存，被 emby 层与面板层共用。

## 理由

- 维持依赖单向：共用设施的配置放在共用它的那一层。
- 配置跟着"谁共用"走，而不是跟着"谁最先使用"走。

## 备选方案

- **配置留在 emby 层**：需要为聚合层开一条读取 emby 设置的通道，破坏分层。
- **两层各存一份**：同一配置出现两份，必然出现不一致。

## 后果

- 升级时旧配置会在启动阶段自动搬迁，token 不丢失。
- 面板「设置」页提供 TMDB 配置与连通性测试。
- 后续聚合层不再使用 TMDB（见 [ADR-0003](0003-local-title-scoring.md)），但配置留在面板层仍然成立：
  `core` 层的共用设施不应反向依赖任何消费层。
