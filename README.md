# 媒体桥面板

> **English summary** — Media Bridge Panel is a self-hosted service that manages one or more
> media source endpoints, aggregates their search results and stream lists, and exposes the
> result through an Emby-compatible API. Emby clients (official apps and most third-party
> players) can connect to it directly and play from any configured source, with all sources
> merged into a single version list. No build step, no runtime dependencies beyond Node.js ≥ 22.

把多个数据源（当前支持猫爪 / CatPawOpen 源）聚合成一份可以直接交给播放客户端的媒体源：
一个面板负责托管源、跨源搜索、合并线路，对外提供 Emby 兼容接口。

- **源托管** —— 填入一个能下载 `index.js` 的源地址，面板负责下载、校验并运行它；支持多源并存、
  开机自启，以及按间隔自动检查更新。
- **聚合搜索** —— 一个关键字并发查询多个源的多个站点，对片名做规范化清洗后按权重打分匹配，
  命中与未命中都可查看（含分数与原因）。
- **版本合并** —— 同一部作品在多处的线路，在客户端里表现为多个可选的「版本」，点哪条播哪条。
- **Emby 兼容** —— 客户端把面板当作一台 Emby 服务器使用（握手、登录、媒体库、搜索、详情、图片、播放均已实现）。
- **零依赖** —— 只使用 Node 内置模块（含内置 `node:sqlite`），没有第三方包，没有构建步骤。

> 本项目不内置、不分发任何源或内容。源地址由用户自行填写，其可用性与合法性由用户判断。

## 目录

- [安装](#安装) · [第一次使用](#第一次使用) · [界面导览](#界面导览)
- [常见问题](#常见问题) · [参与开发](#参与开发) · [许可](#许可)

## 安装

### 方式一：Docker（推荐）

镜像发布在 Docker Hub：`dlushu/media-bridge-panel`，同时提供 `linux/amd64` 与 `linux/arm64`。

```bash
docker run -d --name media-bridge-panel --init --restart unless-stopped \
  -p 8099:8099 -p 9988-9998:9988-9998 \
  -v media_bridge-data:/data \
  dlushu/media-bridge-panel:1.0.0
```

等价的 compose 文件：

```yaml
services:
  media-bridge-panel:
    image: dlushu/media-bridge-panel:1.0.0
    container_name: media-bridge-panel
    restart: unless-stopped
    init: true
    ports:
      - "8099:8099"
      - "9988-9998:9988-9998"
    volumes:
      - media_bridge-data:/data
    environment:
      TZ: Asia/Shanghai

volumes:
  media_bridge-data:
    name: media_bridge-data
```

启动后打开 `http://<主机地址>:8099`。

> 运行数据只存在于具名卷 `media_bridge-data`（源、站点勾选、Emby 账号、面板密码、配置都在其中）。
> 备份该卷即可完整迁移。不要执行 `docker compose down -v`：`-v` 会一并删除数据卷。

### 方式二：运行源码

```bash
node --version    # 需要 ≥ 22.13（内置 sqlite 从该版本起无需开启实验开关）
npm start
```

默认监听 `0.0.0.0:8099`，运行数据写入项目内的 `data/`。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `WEB_PORT` | `8099` | 面板端口，也是 Emby 客户端要连接的端口 |
| `WEB_HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | 项目内 `data/`（镜像内为 `/data`） | 运行数据目录 |
| `TZ` | 跟随系统 | 日志时间（建议 `Asia/Shanghai`） |

## 第一次使用

1. **登录面板** —— 默认密码 `123456`；进入后先到「面板设置 → 设置」修改密码。
2. **添加源** —— 「源托管 → 猫源地址」填一个可下载 `index.js` 的源地址（面板会下载、校验并运行）。
   同一页的「自动更新」可以按间隔检查新版本并自动重启该源。
   若源已在别处运行而不需要面板托管，跳过本步，直接在「聚合设置 → 源列表」填入它的地址。
3. **勾选站点** —— 「聚合设置 → 站点与参数」勾选参与聚合的站点，勾选顺序即结果顺序；
   工具栏的「视图」可只看已勾选项。
4. **（可选）调整匹配策略** —— 「聚合设置 → 聚合参数」：
   - *打分设置*：分数线（填 `0` 表示不按分数线筛选）、「最多留几条命中」（希望得到几条可用的结果，
     不足时按分数继续向后尝试）、「匹配到底」（忽略条数上限，直到凑够或名单结束）。
   - *线路过滤*：一个正则，只有匹配的线路名才会进入客户端看到的版本列表。
5. **接入客户端** —— Emby 客户端「添加服务器」，地址填 `http://<主机地址>:8099`；
   账号需先在「Emby → 连接设置 → 账号管理」中新建。
   客户端内显示的服务器名默认为「媒体桥 Emby」，可在同一页修改。

不接入客户端也可以先在网页上验证效果：「聚合搜索」搜索片名，结果里每条的「这条的版本」
展示的就是客户端点开该条目时会拿到的东西。

## 界面导览

左侧为功能大类，每类下按子标签分页：

```
源托管
  ├ 猫源地址        添加、更新、运行源（含「自动更新」）
  └ 配置中心        源自身提供的配置页（每个运行中的源各一份）

聚合设置
  ├ 源列表          参与聚合的源（本地托管的自动出现，外部地址可手动添加）
  ├ 站点与参数      勾选参与聚合的站点并排序
  ├ 聚合参数        超时 / 并发 / 打分设置 / 线路过滤
  └ 聚合搜索        多源并发搜索（带打分），每条可查看「这条的版本」

Emby
  ├ 连接设置        服务器名、账号管理
  └ 首页插件        上传单文件 JS 插件，令客户端首页多出媒体库

面板设置
  ├ 概览            版本、Node 版本、数据目录、当前地址
  ├ 设置            配置备份与恢复、TMDB 设置、面板密码
  └ 日志            面板进程的实时日志
```

## 常见问题

**客户端里点开条目，版本列表为空或缺少部分线路**

面板只列出「可用」的线路：有线路，且定位到了请求的那一集。核对方法：「聚合搜索」搜索片名 →
点击某条的「这条的版本」，可以看到每个源取回几条线路、哪条定位到了该集；这份内容与客户端拿到的相同。
常见原因是源里确实没有该集（例如源只更新到第 210 集），或排在候选前列的条目没有可用线路 ——
后者可在「聚合参数 → 打分设置」中调大「最多留几条命中」，或启用「匹配到底」。

**客户端搜不到作品**

客户端的关键字走面板自身的搜索；面板里搜不到即确实没有。若网页「聚合搜索」能搜到而客户端搜不到，
通常是站点未勾选（「站点与参数」）或源未运行（「源托管」）。

**点击播放无反应或返回 404**

面板对播放一律以 `302` 跳转到源提供的直链，不代理流量，因此跳转后的地址必须能被客户端访问
（局域网内通常没有问题）。

**端口与安全**

| 端口 | 用途 |
|---|---|
| `8099` | 面板本体（Emby 兼容接口），有密码保护 |
| `9988-9998` | 面板托管的源自身的 HTTP 服务，**没有鉴权** |

后一组端口仅用于让客户端直连源，应只暴露在受信任的网络内。需要外网访问时，只发布 `8099` 并置于
反向代理与 HTTPS 之后。更多细节见 [SECURITY.md](SECURITY.md)。

**数据位置、备份与升级**

- Docker 部署：数据在具名卷 `media_bridge-data` 内（`docker volume inspect media_bridge-data` 可查看实际路径）。
- 备份：面板「面板设置 → 设置 → 导出备份」，或直接备份上述卷。
- 升级：`docker pull dlushu/media-bridge-panel:<新版本>` 后重建容器（`docker compose up -d`）。
  数据卷不受影响，配置保留。

**改名**

- 客户端内显示的服务器名：「Emby → 连接设置 → 服务器名」。
- 面板自身的名称：`server/core/branding.js` 与 `public/core/branding.js`（两处成对）。

## 参与开发

- 文档地图：[docs/index.md](docs/index.md)
- 架构与依赖方向：[ARCHITECTURE.md](ARCHITECTURE.md)
- 设计决策记录：[docs/adr/](docs/adr/)
- 贡献流程与书写规范：[CONTRIBUTING.md](CONTRIBUTING.md)
- 变更记录：[CHANGELOG.md](CHANGELOG.md)
- 安全策略：[SECURITY.md](SECURITY.md)

提交前请运行 `npm run check`（语法检查与文风检查）。

> 本仓库只包含应用源码。容器定义与镜像构建脚本不属于项目源码，由维护者另行维护；
> 分发方式为 Docker Hub 上的官方镜像（见上文）。

## 许可

[MIT](LICENSE)
