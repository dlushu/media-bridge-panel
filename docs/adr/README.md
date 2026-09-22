# 设计决策记录（ADR）

本目录记录**会影响系统形态的决策**：为什么这样分层、为什么采用某个判据或失败语义、
否决了哪些方案。每条决策一个文件，只写背景、决定、理由、备选与后果，不复述实现细节
（实现细节见 [develop.md](../develop.md) 与各模块文档）。

状态取值：**已采纳** / **已否决** / **已被取代**（被取代时注明后继条目）。

| 编号 | 决策 | 状态 |
|---|---|---|
| [0001](0001-module-layering.md) | 模块分层与依赖方向 | 已采纳 |
| [0002](0002-in-process-emby-to-agg.md) | emby 层进程内直调聚合层 | 已采纳 |
| [0003](0003-local-title-scoring.md) | 挑片判据：本地打分，不做 TMDB 反查 | 已采纳（取代精确同名 + 别名回退） |
| [0004](0004-no-same-site-dedup.md) | 同一站点内不做同名去重 | 已采纳 |
| [0005](0005-continuation-fetch.md) | 接续补打：最多试 N+K 条，凑够 N 条即止 | 已采纳（取代"命中即止"） |
| [0006](0006-redirect-for-playback.md) | 播放一律 302，不代理流量 | 已采纳（取代代理/跳转双模式） |
| [0007](0007-emby-dto-shape.md) | Emby 响应按真机 DTO 形状对齐 | 已采纳 |
| [0008](0008-no-fabricated-data.md) | 不编数据：不知道就空字段，没有数据就如实回空 | 已采纳 |
| [0009](0009-unauthenticated-empty-responses.md) | 回空的端点不校验账号 | 已采纳 |
| [0010](0010-tmdb-config-in-panel.md) | TMDB 配置归面板层 | 已采纳 |
| [0011](0011-cache-split-by-consumer.md) | 缓存按消费方分库 | 已采纳 |
| [0012](0012-deployed-sources-auto-aggregate.md) | 本地托管的源自动参与聚合 | 已采纳 |
| [0013](0013-image-endpoint-signing.md) | 图片端点：签名 tag + 本地索引 | 已采纳 |
| [0014](0014-frontend-no-build.md) | 前端零构建 | 已采纳 |
| [0015](0015-source-bundle-integrity.md) | 源包的两道 md5 校验 | 已采纳 |
| [0016](0016-source-auto-update-default-off.md) | 源自动更新默认关闭 | 已采纳 |
| [0017](0017-panel-auth-single-password.md) | 面板门禁：单密码，不是用户体系 | 已采纳 |
| [0018](0018-branding-single-source.md) | 产品名只在一处定义 | 已采纳 |
| [0019](0019-self-update-from-release.md) | 自身更新：应用装在数据卷、按 Release 资产安装、进程重启生效 | 已采纳 |
| [0020](0020-detail-snapshot.md) | 详情快照 + 剧集详情提前返回（同一次点播被算三遍的那一步存下来） | 已采纳 |
| [0021](0021-update-replaces-app-dir.md) | 更新即完整替换：只保留当前版本，不留本地旧版本 | 已采纳 |
| [0022](0022-movie-all-play-items.md) | 电影取法：每条线路列出全部播放项（剧集仍按集号定位） | 已采纳 |

## 新增一条 ADR

1. 复制任一条目作为模板，编号取当前最大值 +1，文件名 `NNNN-短横线短语.md`。
2. 必须写清"备选方案"与"后果" —— 这两节是后来者最需要的部分。
3. 若某条决策取代了既有条目，把旧条目的状态改为"已被取代"并链到新条目，**不要删除旧条目**。
