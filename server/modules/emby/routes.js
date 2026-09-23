'use strict';
/**
 * Emby 层路由
 *
 * 已实现：
 *   GET  /api/emby/System/Info/Public        握手：客户端据此确认这是 Emby 服务器
 *   POST /api/emby/Users/AuthenticateByName  登录：校验面板账号（见「Emby → 账号管理」）
 *   GET  /api/emby/Users/{UserId}            取用户资料
 *   GET  /api/emby/Users/{UserId}/Views      媒体库列表（每个启用的首页插件行 = 一个库；不再是留白）
 *   GET  /api/emby/Users/{UserId}/Items/Resume   继续观看（读 `playback` 表的未看完条目；必须注册在 Items/{ItemId} 之前）
 *   GET  /api/emby/Users/{UserId}/Items      条目列表（列表数据由首页模块决定：认 ParentId=<库Id>；其余如实空）
 *   GET  /api/emby/Users/{UserId}/Items/{ItemId}  单条详情（元数据 TMDB + 源绑定走本模块设置里的聚合地址）
 *   POST /api/emby/Users/{UserId}/Items/{ItemId}/HideFromResume  「从继续观看里移除 / 恢复」（`Hide=false` 恢复）
 *   POST|DELETE /api/emby/Users/{UserId}/PlayedItems/{ItemId}    「标记已看 / 未看」（POST=已看、DELETE=未看）
 *   POST /api/emby/Sessions/Playing[/Progress|/Stopped]  客户端播放上报（落库，见下面「播放进度上报」）
 *   POST /api/emby/Items/{ItemId}/PlaybackInfo   播放信息（版本清单 = 线路，Path 指向下面的 Stream）
 *   GET  /api/emby/Items/{ItemId}/Stream         拉流（现取地址后**一律 302**；本地部署的源会把回环地址换成客户端域名）
 *   GET  /api/emby/videos|Videos/{ItemId}/stream[.{ext}]  直连播放（**Emby 标准端点**：实测客户端播直连时
 *                                                走的是这条 + MediaSourceId，而不是上面那条 Path；
 *                                                两种大小写都注册 —— 小写是早期日志实录，大写是 Emby 官方路径）
 *   GET  /api/emby/Items/{ItemId}/Download       下载（与拉流**同一条链路**：MediaSourceId → 现取地址 → 302；
 *                                                302 之后文件名/断点续传归源站，面板不扛流量）
 *   GET  /api/emby/Shows/{Id}/Seasons        剧的季列表（**占位**：TMDB 的 seasons[]；UserId 在 query 里）
 *   GET  /api/emby/Shows/{Id}/Episodes       某一季的分集（**占位**：TMDB season 接口；UserId/SeasonId 在 query 里）
 *   GET  /api/emby/Items/{Id}/Images/{type}  图片（**豁免 token**；tag = `cpimg.<base64url(URL)>.<签名>`，验签不过 404；支持 `/Images/{type}/{index}`）
 *   GET  /api/emby/Items/{Id}/Similar        相似推荐（按 tmdb 坐标反查 TMDB，归 emby 层）
 *
 * 面板自用（不是 Emby 客户端协议，但同样必须注册在通配之前）：
 *   GET/POST    /api/emby/accounts       账号列表 / 新增
 *   PUT/DELETE  /api/emby/accounts/{id}  改（用户名/密码）/ 删
 *   ANY  /api/emby/home/**              首页插件：上传/列表/启用/参数/预览（见 home/routes.js）
 *   （TMDB 的设置与测试已搬到面板层：`/api/panel/tmdb/test`，见 core/tmdb.js）
 *
 * 通配（必须注册在最后）：
 *   ANY  /api/emby/*rest   其余请求一律**记一行**日志 + 回 501，待明确需求后再实现
 *
 * **日志口径**：**每个请求都记一行，不做筛选**（见 `./log.js`）——
 * 2xx 记为成功、≥400 记为失败、未实现记 `未实现#N`，都带客户端标记与 query 摘要。
 * 量靠别处压：面板「日志」页是**固定条数的内存环形缓冲**，页面里还能按级别过滤。
 * 查看：面板「面板设置 → 日志」（内存最近 N 条）+ `docker logs`（长期，自带轮转）。
 *
 * **AccessToken 校验**：除下面这些豁免项外，所有端点都先过 `service.authorize()`
 *   （豁免：握手 / 登录 / 面板自用端点 / 501 通配 —— 图片端点将来也要豁免：
 *   实测 8 条图片请求里 5 条带 `x-emby-authorization`、3 条**什么凭证都不带**（原生 Rex 客户端），
 *   要求 token 会让那部分客户端图全挂；而非图片请求 9/9 都带 `x-emby-token`）。
 *
 * 端点清单与规矩见 docs/emby-compat.md。
 */
const { sendJson, readBody, readRawBody } = require('../../core/http');
const { UA } = require('../../core/upstream');
const service = require('./service');
const log = require('./log');
const tmdb = require('./tmdb');
const db = require('./db');

/** 图片端点单张上限：海报/剧照正常几十 KB～1MB，超过这个数说明取到的东西不对 */
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 未实现端点的统一回应：**记一行**日志（返回序号）+ 501。
 *
 * 通配路由 与「路径形状被已实现端点占住、但 Id 不归它管」的请求共用 ——
 * 后者指 `Users/{UserId}/Items/{ItemId}` 这条：`Items/Resume` / `Items/Latest`（继续观看 / 最新）
 * 路径形状一样，但这里只认本面板发出去的 tmdb Id，认不出的仍按「未实现」记一行 + 501，不静默吞掉。
 *
 * `body` 可选（通配路由读下来的原始体）：只用来打一行摘要（掩码 + 压平 + 限长，见 `log.bodyBrief`）。
 * POST 端点没有 query，不看 body 就无从知道客户端报了什么。
 */
function notImplemented(req, res, { pathname, query, body }) {
  const n = log.logMissing(req, { pathname, query, body });
  res.writeHead(501, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(
    JSON.stringify({
      error: 'EMBY_ENDPOINT_NOT_IMPLEMENTED',
      path: pathname,
      logSeq: n,
      hint: '该端点尚未实现，已记录到面板日志',
    })
  );
}

/**
 * 把 `resolveStream` 的结果落到响应上：**一律 302**（不再有"面板代为转发"那条路）。
 * 面板只回一个 `Location`，字节全在源与客户端之间跑 —— 见 service.resolveStream 上面那段说明。
 * 本地部署的源回的地址是回环地址，这里拿到的已经是**换过域名**的那份（见 service.redirectUrl）。
 *
 * `verb` 只进日志那行（拉流 / 下载）：两个端点共用这一段，日志里得能分清是哪条在跑。
 */
function serveStream(req, res, out, label, verb = '拉流') {
  if (!out.stream) {
    /* 失败时把**客户端原始 URL** 一起打出来 —— 光看状态行根本不知道它回传了什么
     * `MediaSourceId`（排查"缺少 vod"时就卡在这）。**只在失败时打**，所以并成一行。 */
    log.logResult(req, `${verb} ${label}`, out, out.status >= 400 ? ` 原始请求: ${req.url}` : '');
    return sendJson(res, out.status, out.body);
  }
  log.logResult(req, `${verb} ${label}`, { status: 302, log: out.log });
  res.writeHead(302, { Location: out.stream.url, 'Cache-Control': 'no-store' });
  return res.end();
}

/**
 * 把 `{status, body}` 落到响应上：**没有 body 就 204 空体**。
 *
 * 播放上报与几个写端点共用 —— 这类端点的 body 本来就是可选的：有就回 JSON
 * （客户端拿它更新界面上的「已看 / 继续观看」），没有就一个字节都不回。
 */
function sendOut(res, out) {
  if (!out.body) {
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    return res.end();
  }
  return sendJson(res, out.status, out.body);
}

module.exports = function routes(r) {
  /* ---------------- 已实现端点（先于通配注册） ---------------- */

  r.add('GET', '/api/emby/System/Info/Public', (req, res) => {
    const info = service.publicInfo(req);
    log.logResult(req, '握手 System/Info/Public', { status: 200, log: `ServerName=${info.ServerName} Version=${info.Version}` });
    return sendJson(res, 200, info);
  });

  r.add('POST', '/api/emby/Users/AuthenticateByName', async (req, res) => {
    const body = await readBody(req);
    const out = service.authenticate(req, body);
    /* 登录**成功与失败都记**：客户端登录时带上试的用户名，401 排查全靠它 */
    const who = String((body && (body.Username || body.username)) || '(空)');
    log.logResult(req, '登录 Users/AuthenticateByName', out, ` user=${who}`);
    return sendJson(res, out.status, out.body);
  });

  r.add('GET', '/api/emby/Users/:userId', (req, res, { params }) => {
    /* AccessToken 守卫（见 service.authorize）：无效/缺失一律 401 */
    const denied = service.authorize(req, params.userId);
    if (denied) {
      log.logResult(req, `取用户资料 Users/${params.userId}`, denied);
      return sendJson(res, denied.status, denied.body);
    }

    const out = service.getUser(params.userId);
    log.logResult(req, `取用户资料 Users/${params.userId}`, out);
    return sendJson(res, out.status, out.body);
  });

  /* 媒体库列表：每个「启用的」首页插件行 = 一个库（已不再是留白端点） */
  r.add('GET', '/api/emby/Users/:userId/Views', (req, res, { params, query }) => {
    const q = log.queryBrief(query);
    /* AccessToken 守卫（见 service.authorize）：无效/缺失一律 401 */
    const denied = service.authorize(req, params.userId);
    if (denied) {
      log.logResult(req, `媒体库 Users/${params.userId}/Views`, denied, q);
      return sendJson(res, denied.status, denied.body);
    }

    const out = service.getViews(params.userId);
    log.logResult(req, `媒体库 Users/${params.userId}/Views`, out, q + " " + log.countOf(out, "Items"));
    return sendJson(res, out.status, out.body);
  });

  /**
   * 继续观看 —— 客户端 `POST /Sessions/Playing*` 上报的进度落在 `playback` 表里，这条读它。
   *
   * ⚠️ **必须注册在下面 `Users/:userId/Items/:itemId` 之前** —— 两条的路径形状完全一样
   * （`Items/Resume` 会被 `:itemId` 当成一个条目 Id 吞掉）。之前它 501 就是这个原因：
   * 落进 `:itemId` 后 `parseItemId('Resume')` 认不出 → 走 `notImplemented`。
   *
   * 校验账号（回的是**某个账号的观看记录**）：`service.getResume` 内部就校验了，路由层不重复。
   */
  r.add('GET', '/api/emby/Users/:userId/Items/Resume', async (req, res, { params, query }) => {
    const q = log.queryBrief(query);
    const out = await service.getResume(params.userId, req, query);
    log.logResult(req, `继续观看 Users/${params.userId}/Items/Resume`, out, q + " " + log.countOf(out, "Items"));
    return sendJson(res, out.status, out.body);
  });

  /**
   * GET /Studios[?UserId=…&Limit=…] —— 工作室（制片公司 / 电视台）清单
   *
   * **如实回空**。理由见 `service.getStudios`：不是没做，
   * 是**没有片库可枚举** —— 硬凑只会得到一个随榜单波动的假清单，比空更糟。
   *
   * **不校验 token / UserId**：**回空的响应没有数据可保护**，
   * 校验只会有坏处 —— 客户端不带 token 时白吃一个 401，而它本该拿到一个空列表。
   * 同口径的还有 `Items/Resume` 与 `Items` 里那些回空的分支（见 `service.itemsWillReturnData`）。
   */
  r.add('GET', '/api/emby/Studios', (req, res, { query }) => {
    const q = log.queryBrief(query);
    const out = service.getStudios();
    log.logResult(req, '工作室 Studios', out, q + " " + log.countOf(out, "Items"));
    return sendJson(res, out.status, out.body);
  });

  /**
   * GET /Shows/NextUp —— 「接下来看」（SenPlayer 实测在请求该端点，还会带 `SeriesId` 只问一部剧）
   *
   * 按库里的进度算"该看哪一集"，见 `service.getNextUp`。
   * `UserId` 在 **query**（`&UserId=…`），不在路径里 —— 与 `Shows/{Id}/Seasons` 同款。
   *
   * 无路由冲突：这里**没有**裸的 `Shows/:showId` 那条路由（只有 `Shows/:showId/Seasons|Episodes`），
   * 所以 `NextUp` 不会被当成 showId 吞掉；`SeriesId` 是 query 参数，与路由形状无关。
   */
  r.add('GET', '/api/emby/Shows/NextUp', async (req, res, { query }) => {
    const q = log.queryBrief(query);
    const out = await service.getNextUp(query.get('UserId'), req, query);
    log.logResult(req, '接下来看 Shows/NextUp', out, q + " " + log.countOf(out, "Items"));
    return sendJson(res, out.status, out.body);
  });

  /**
   * GET /Items/Counts —— 全库各类条目数量（SenPlayer 实测在请求该端点）
   *
   * **回全 0**＝"数不出来"，不是"库是空的"（理由见 `service.getItemCounts` —— 没有片库索引，
   * 而唯一能凑的数据源是插件行的 `total`，那是 TMDB 榜单总数，不是本面板的库，拿它当数就是编数据）。
   *
   * 无路由冲突：条目详情那条是 `Users/:userId/Items/:itemId`，**没有**裸的 `Items/:itemId`，
   * 所以 `Counts` 不会被当条目 Id 吞掉（⚠️ 但 `Users/:userId/Items/Resume` 曾被这种
   * 同形状路由吞掉 —— 以后若新增 `Items/{Id}` 之类，需把这条挪到前面）。
   * **不校验账号**：回空没有数据可保护。
   */
  r.add('GET', '/api/emby/Items/Counts', (req, res, { query }) => {
    const q = log.queryBrief(query);
    const out = service.getItemCounts();
    log.logResult(req, '条目计数 Items/Counts', out, q);
    return sendJson(res, out.status, out.body);
  });

  /* 条目列表：列表数据由首页模块决定（认 ParentId=<库Id>）；收藏/已播放如实空；其余查询如实空 */
  r.add('GET', '/api/emby/Users/:userId/Items', async (req, res, { params, query }) => {
    const q = log.queryBrief(query);
    /* AccessToken 守卫**只挂在这条真会出数据的路上**（见 `service.itemsWillReturnData`）：
     * 收藏/已播放、以及认不出的查询都是**如实回空**，回空没有数据可保护，
     * 校验只会有坏处 —— 客户端不带 token 时白吃一个 401，而它本该拿到空列表。
     * ⚠️ 判据与 `service.getItems` 内部用的是**同一个函数**，别在这里另写一份。 */
    if (service.itemsWillReturnData(query)) {
      const denied = service.authorize(req, params.userId);
      if (denied) {
        log.logResult(req, `条目列表 Users/${params.userId}/Items`, denied, q);
        return sendJson(res, denied.status, denied.body);
      }
    }

    const out = await service.getItems(params.userId, query);
    service.applyUserData(out, params.userId, req);
    log.logResult(req, `条目列表 Users/${params.userId}/Items`, out, q + " " + log.countOf(out, "Items"));
    return sendJson(res, out.status, out.body);
  });

  /**
   * 最新条目（VidHub 首页每一行都靠它）—— **回的是裸数组**，不是 `QueryResult`。
   *
   * ⚠️ **必须注册在下面 `Users/:userId/Items/:itemId` 之前** —— 两条路径形状一样，
   * `Items/Latest` 会被 `:itemId` 当成一个条目 Id 吞掉，然后 501（`Items/Resume` 曾因同样的路由顺序被吞掉）。
   *
   * 内容由首页模块决定（见 `service.getLatest`）：emby 层不排序、不筛"入库时间"。
   */
  r.add('GET', '/api/emby/Users/:userId/Items/Latest', async (req, res, { params, query }) => {
    const q = log.queryBrief(query);
    /* 与 `Items` 同一条口径：只在"真会出数据"的路上校验账号（判据共用 `itemsWillReturnData`） */
    if (service.itemsWillReturnData(query)) {
      const denied = service.authorize(req, params.userId);
      if (denied) {
        log.logResult(req, `最新条目 Users/${params.userId}/Items/Latest`, denied, q);
        return sendJson(res, denied.status, denied.body);
      }
    }

    const out = await service.getLatest(params.userId, query);
    service.applyUserData(out, params.userId, req);
    log.logResult(req, `最新条目 Users/${params.userId}/Items/Latest`, out, q + " " + log.countOf(out, "items"));
    return sendJson(res, out.status, out.body);
  });

  /* 季列表：只认剧的 Id（tmdb_{id}_tv）；UserId 在 query 里，走同一套账号校验 */
  r.add('GET', '/api/emby/Shows/:showId/Seasons', async (req, res, { params, query }) => {
    const q = log.queryBrief(query);
    /* AccessToken 守卫（见 service.authorize）：无效/缺失一律 401 */
    const denied = service.authorize(req, query.get('UserId'));
    if (denied) {
      log.logResult(req, `季列表 Shows/${params.showId}/Seasons`, denied, q);
      return sendJson(res, denied.status, denied.body);
    }

    const out = await service.getSeasons(params.showId, query.get('UserId'));
    service.applyUserData(out, query.get('UserId'), req);
    log.logResult(req, `季列表 Shows/${params.showId}/Seasons`, out, q + " " + log.countOf(out, "Items"));
    return sendJson(res, out.status, out.body);
  });

  /* 分集列表：只认剧的 Id + SeasonId（tmdb_{id}_tv_s{n}），其余回空 */
  r.add('GET', '/api/emby/Shows/:showId/Episodes', async (req, res, { params, query }) => {
    const q = log.queryBrief(query);
    /* AccessToken 守卫（见 service.authorize）：无效/缺失一律 401 */
    const denied = service.authorize(req, query.get('UserId'));
    if (denied) {
      log.logResult(req, `分集列表 Shows/${params.showId}/Episodes`, denied, q);
      return sendJson(res, denied.status, denied.body);
    }

    const out = await service.getEpisodes(params.showId, query.get('UserId'), query.get('SeasonId'));
    service.applyUserData(out, query.get('UserId'), req);
    log.logResult(req, `分集列表 Shows/${params.showId}/Episodes`, out, q + " " + log.countOf(out, "Items"));
    return sendJson(res, out.status, out.body);
  });

  /* 单条详情：只认本面板发出去的 tmdb Id；认不出的（如 Items/Resume）走 501 */
  r.add('GET', '/api/emby/Users/:userId/Items/:itemId', async (req, res, { params, query, pathname }) => {
    const q = log.queryBrief(query);
    /* AccessToken 守卫（见 service.authorize）：无效/缺失一律 401 */
    const denied = service.authorize(req, params.userId);
    if (denied) {
      log.logResult(req, `条目详情 Users/…/Items/${params.itemId}`, denied, q);
      return sendJson(res, denied.status, denied.body);
    }

    if (!tmdb.parseItemId(params.itemId)) return notImplemented(req, res, { pathname, query });

    /* `host` 传进去是为了让 `MediaSources[].Path` / 条目级 `Path` 是**绝对 URL**
     * （真机的 Path 也从来不是相对路径）。用请求自己的 Host —— 那正是客户端能连到的地址。 */
    const out = await service.getItem(params.itemId, params.userId, req.headers.host || '');
    service.applyUserData(out, params.userId, req);
    log.logResult(req, `条目详情 Users/…/Items/${params.itemId}`, out, q + (out.body && out.body.CatpawSource ? " 源=" + out.body.CatpawSource.Site : ""));
    return sendJson(res, out.status, out.body);
  });

  /* 播放信息：客户端点播放前必来，返回版本清单（Path 指向下面的 Stream 端点，不带时效地址） */
  r.add('POST', '/api/emby/Items/:itemId/PlaybackInfo', async (req, res, { params, query }) => {
    const q = log.queryBrief(query);
    /* AccessToken 守卫（见 service.authorize）：无效/缺失一律 401 */
    const denied = service.authorize(req, query.get('UserId'));
    if (denied) {
      log.logResult(req, `播放信息 Items/${params.itemId}/PlaybackInfo`, denied, q);
      return sendJson(res, denied.status, denied.body);
    }

    const out = await service.getPlaybackInfo(params.itemId, query.get('UserId'), req.headers.host || '', service.tokenFrom(req).token);
    log.logResult(req, `播放信息 Items/${params.itemId}/PlaybackInfo`, out, q + " " + log.countOf(out, "MediaSources"));
    return sendJson(res, out.status, out.body);
  });

  /**
   * 渠道 ①：`MediaSource.Path` 指向的端点 —— 形状 `/Stream/{token}[/{文件名}]`（见 `service.streamPath`）。
   * `token` 是 base64url 的版本 Id（自带站点/线路/vod）；**末段文件名只为版本行副标题存在**：
   * 客户端会把 Path 解码后取「最后一个 `/` 之后」当副标题，所以那里放集名，而不是源路径里的 `8471.html`。
   * 注册两条（带文件名 / 不带）共用同一处理。
   */
  const streamByPath = async (req, res, { params, query }) => {
    /* AccessToken 守卫（见 service.authorize）：无效/缺失一律 401 */
    const denied = service.authorize(req, query.get('UserId'));
    if (denied) {
      log.logResult(req, `拉流 Items/${params.itemId}/Stream`, denied);
      return sendJson(res, denied.status, denied.body);
    }

    const src = service.decodeSourceToken(params.token);
    if (!src) {
      console.log(`  ✘ emby 拉流 Items/${params.itemId}/Stream → HTTP 400  token 认不出：${params.token}${log.clientTag(req)}`);
      return sendJson(res, 400, {
        error: '路径里的 token 认不出（应是 base64url 的 catpaw:<JSON {s,t,f,v}>，或旧的 catpaw:<站点>:<线路>|<vod>）',
      });
    }
    const out = await service.resolveStream(params.itemId, src, null, query.get('UserId'), req.headers.host || '');
    return serveStream(req, res, out, `Items/${params.itemId}/Stream`);
  };
  r.add('GET', '/api/emby/Items/:itemId/Stream/:token', streamByPath);
  r.add('GET', '/api/emby/Items/:itemId/Stream/:token/:file', streamByPath);

  /* 渠道 ①'：老的 `?src=&vod=` 形状 —— 不再写进 `Path`，留着手工调试（文档里那条实测走的就是它）。 */
  r.add('GET', '/api/emby/Items/:itemId/Stream', async (req, res, { params, query }) => {
    /* AccessToken 守卫（见 service.authorize）：无效/缺失一律 401 */
    const denied = service.authorize(req, query.get('UserId'));
    if (denied) {
      log.logResult(req, `拉流 Items/${params.itemId}/Stream`, denied);
      return sendJson(res, denied.status, denied.body);
    }

    const out = await service.resolveStream(params.itemId, query.get('src'), query.get('vod'), query.get('UserId'), req.headers.host || '');
    return serveStream(req, res, out, `Items/${params.itemId}/Stream`);
  });

  /**
   * 渠道 ②：Emby 的标准直连端点 —— **客户端真正走的**是这条
   *   `GET /videos/{ItemId}/stream.mkv?Static=true&MediaSourceId=<版本 Id>&PlaySessionId=…&api_key=…`
   * （实测日志 emby#39~#45），而**不是**上面那条 Path。缺了它播放一律 501，客户端只会反复重试。
   *
   * `MediaSourceId` 自带站点/线路/vod（**base64url 编在 Id 里**，见 service.catpawSourceId），所以这里没有额外参数；
   * `Static=true` 表示要直连（不转码），与一律 302 的语义一致。
   * `:file` 只认 `stream` / `stream.<扩展名>`（后缀来自 `MediaSource.Container`）；`original.mkv` 之类
   * 没在任何日志里出现过，仍按「未实现」记日志 + 501，不提前猜。
   */
  const serveDirectVideo = async (req, res, { params, query, pathname }) => {
    /* AccessToken 守卫（见 service.authorize）：无效/缺失一律 401 */
    const denied = service.authorize(req, query.get('UserId'));
    if (denied) {
      log.logResult(req, `拉流 videos/${params.itemId}/${params.file}`, denied);
      return sendJson(res, denied.status, denied.body);
    }

    if (!/^stream(\.[a-z0-9]+)?$/i.test(params.file)) return notImplemented(req, res, { pathname, query });

    const out = await service.resolveStream(
      params.itemId,
      query.get('MediaSourceId'),
      null, // vod 已编码在 MediaSourceId 里，不需要另外传
      query.get('UserId'),
      req.headers.host || '' // 本地部署的源回的地址是回环地址，302 前要用它换成客户端那个域名
    );
    return serveStream(req, res, out, `videos/${params.itemId}/${params.file}`);
  };
  /* **两种大小写都注册**：路由是**区分大小写**的，而两条实录都得认 —— 小写 `videos` 是早期日志
   * （emby#39~#45），大写 `Videos` 是 Emby 官方路径（实测 Lumenic/1.0.0 打的就是大写：
   * 先白吃一个 501，随后才退回小写拿到 302）。同一条实现，不复制逻辑。 */
  r.add('GET', '/api/emby/videos/:itemId/:file', serveDirectVideo);
  r.add('GET', '/api/emby/Videos/:itemId/:file', serveDirectVideo);

  /**
   * 下载：`GET /api/emby/Items/{ItemId}/Download?MediaSourceId=<版本 Id>&DeviceId=…`。
   *
   * 实测（SenPlayer/6.2.1，三体 S1E2）12 小时里试了 **8 次**，每次都落进通配的 501 → 它就一直重试。
   * 这条端点要的东西**和拉流一模一样**：`MediaSourceId` 里已经编着 站点/线路/vod，所以直接复用
   * `resolveStream` → `serveStream`（同一条链路、同一次上游取地址），不新增任何取数逻辑。
   *
   * ⚠️ **302 之后由源站应答**：`Content-Disposition`（文件名）、`Content-Type`、断点续传全是源站说了算，
   * 面板改不了。要"片名.S01E01.mkv"那种漂亮文件名，只能在面板里代为转发**全量字节**并自己写
   * `Content-Disposition` —— 那与「面板不扛流量」（ADR-0006）直接冲突，本实现不做。
   *
   * 同族的 `Items/{ItemId}/File`（也是下载）**先不做**：客户端日志里从没出现过，
   * 按"等客户端日志暴露再接线"的老规矩办 —— 出现了再加一条同样的路由即可。
   */
  r.add('GET', '/api/emby/Items/:itemId/Download', async (req, res, { params, query }) => {
    /* AccessToken 守卫（见 service.authorize）：无效/缺失一律 401 */
    const denied = service.authorize(req, query.get('UserId'));
    if (denied) {
      log.logResult(req, `下载 Items/${params.itemId}/Download`, denied);
      return sendJson(res, denied.status, denied.body);
    }

    const out = await service.resolveStream(
      params.itemId,
      query.get('MediaSourceId'),
      null, // vod 已编码在 MediaSourceId 里，不需要另外传
      query.get('UserId'),
      req.headers.host || '' // 本地部署的源回的地址是回环地址，302 前要用它换成客户端那个域名
    );
    return serveStream(req, res, out, `Items/${params.itemId}/Download`, '下载');
  });

  /* 相似推荐：按条目的 tmdb 坐标反查 TMDB（与季/集同类，归 emby 层，不走首页模块） */
  r.add('GET', '/api/emby/Items/:itemId/Similar', async (req, res, { params, query }) => {
    const q = log.queryBrief(query);
    const denied = service.authorize(req, query.get('UserId'));
    if (denied) {
      log.logResult(req, `相似推荐 Items/${params.itemId}/Similar`, denied, q);
      return sendJson(res, denied.status, denied.body);
    }

    const out = await service.getSimilar(params.itemId, query.get('UserId'), query.get('Limit'));
    service.applyUserData(out, query.get('UserId'), req);
    log.logResult(req, `相似推荐 Items/${params.itemId}/Similar`, out, q + " " + log.countOf(out, "Items"));
    return sendJson(res, out.status, out.body);
  });

  /* ---------------- 图片（**豁免 AccessToken**） ---------------- */

  /**
   * `GET /Items/{ItemId}/Images/{type}[?tag=…&maxWidth=…&quality=…]` —— `type` 形如 `Primary` / `Backdrop` / `Logo`。
   *
   * - **豁免 AccessToken**：实测图片请求的凭证携带**不统一**（同一批 8 条里 5 条带 `x-emby-authorization`、
   *   3 条**什么凭证都不带**）。要求 token 会让那部分客户端图全挂。
   * - tag 是 `cpimg.<base64url(图片URL)>.<签名>`（见 `service.imageTag`）——
   *   **验签不过一律 404**：这个端点豁免 token，不签名就等于把面板变成"替任何人取任意 URL"的开放代理。
   * - **由面板代为取图**（不是 302）：图很小；而且插件给的图地址可能是客户端根本连不到的地方。
   * - **两条取图路**：① tag 验签通过（客户端把 tag 带回来了）→ 从 tag 里解出 URL；
   *   ② 没带 tag / 验签不过 → 查**本地图片索引**（见下）。两条都取不到才 404。
   *   ⚠️ 已否决方案：不要用"按条目 Id 反查 TMDB"作兜底 ——
   *   那随片库规模**线性**消耗 TMDB 配额（实测 340 次请求 ≈ 55 次调用），而图片位置**本来就在本地**。
   *   现为零成本的本地索引。
   * - `maxWidth` / `quality` / `type` / `index` 忽略：URL 来自 tag 或索引，原图转给客户端
   *   （TMDB 那张已经是按尺寸取的）。
   * - **`/:index` 变体**：给了多张背景图（`BackdropImageTags[]`）后，客户端会按
   *   `Images/Backdrop/0`、`/1`… 逐张要 —— 路径里那个 index **只在查索引时用**（tag 里逐张带着呢）。
   */
  const imagesByType = async (req, res, { params, query }) => {
    const label = `Items/${params.itemId}/Images/${params.type}${params.index !== undefined ? '/' + params.index : ''}`;
    const rawTag = String(query.get('tag') || '');

    /* tag 验签通过 → 直接用它里面的 URL（零上游调用）。
     * ② 没带 tag / 验签不过 → 查**本地图片索引**（`service.imageUrlFromIndex`）：
     *    索引在发 tag 时顺带记下（见 `service.tagAndRemember`），URL 本来就在本地，
     *    所以这一步**零上游调用**。命中即可正常出图。
     * ③ 都取不到 → 404，**不回退 TMDB 反查** —— 那条路随片库规模线性消耗配额
     *    （实测 340 次请求 ≈ 55 次调用，6h 过期重来），而位置本就在索引里。
     * 图片端点豁免 token，所以"URL 必须由本面板签过或记过"是这里唯一的 SSRF 防线。 */
    let url = service.parseImageTag(params.itemId, rawTag);
    let via = 'tag';
    if (!url) {
      url = service.imageUrlFromIndex(params.itemId, params.type, params.index);
      via = '索引';
    }
    if (!url) {
      /* 诊断要能一眼看出"是没带 tag，还是带了但对不上"——两者的修法完全不同 */
      const shape = rawTag
        ? rawTag.startsWith('cpimg.')
          ? 'tag 验签不过'
          : `tag 非本面板格式：${rawTag.slice(0, 24)}…`
        : '客户端未回传 tag';
      console.log(`  ✘ emby 图片 ${label} → HTTP 404 ${shape}，索引也没有${log.clientTag(req)}`);
      return sendJson(res, 404, { error: '这张图取不到：tag 验签不过，索引里也没有' });
    }

    const t0 = Date.now();
    try {
      /* 取图是**裸 fetch**（不走 `upstream.request`），所以自称要单独带上 ——
       * 用同一条常量（`core/upstream.js` 的 `UA`），别在这儿另写一串。 */
      const up = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
      if (!up.ok) throw new Error('上游 HTTP ' + up.status);
      const buf = Buffer.from(await up.arrayBuffer());
      if (buf.length > IMAGE_MAX_BYTES) throw new Error(`图太大（${buf.length} 字节）`);
      res.writeHead(200, {
        'Content-Type': up.headers.get('content-type') || 'image/jpeg',
        'Content-Length': buf.length,
        'Cache-Control': 'public, max-age=86400',
      });
      res.end(buf);
      /* 出图成功也记一行（**这条量最大**：客户端一屏海报就是十几二十行）——
       * 记录口径见 log.js 文件头：不做筛选；量由内存缓冲的固定条数与「看的时候再过滤」兜住。 */
      log.logResult(req, `图片 ${label}`, {
        status: 200,
        log: `${buf.length} 字节${via === 'tag' ? '' : '（' + via + '）'} ${Date.now() - t0}ms`,
      });
    } catch (e) {
      const msg = String((e && e.message) || e);
      console.log(`  ✘ emby 图片 ${label} → HTTP 502 取图失败：${msg}${log.clientTag(req)}`);
      return sendJson(res, 502, { error: '取图失败：' + msg });
    }
  };
  r.add('GET', '/api/emby/Items/:itemId/Images/:type', imagesByType);
  r.add('GET', '/api/emby/Items/:itemId/Images/:type/:index', imagesByType);

  /* ---------------- 面板自用（非 Emby 客户端协议） ---------------- */

  /* 账号管理：Emby 客户端登录用的账号表（存 data/emby/emby.db，密码只有 scrypt 哈希）。
   * 入参校验 + 日志都在这里；**响应与日志绝不出现密码或哈希**（对外的形状统一走 db.publicAccount）。 */
  const ACC_NAME_MAX = 64;
  const ACC_PASS_MIN = 6;

  /** 新增账号的入参校验；返回 { error } 或 { username, password } */
  function readNewAccount(body) {
    const username = String((body && body.username) || '').trim();
    const password = String((body && body.password) || '');
    if (!username) return { error: '用户名不能为空' };
    if (username.length > ACC_NAME_MAX) return { error: `用户名最长 ${ACC_NAME_MAX} 个字符` };
    if (password.length < ACC_PASS_MIN) return { error: `密码至少 ${ACC_PASS_MIN} 位` };
    return { username, password };
  }

  const isUniqueErr = (e) => /UNIQUE/i.test(String((e && e.message) || ''));

  r.add('GET', '/api/emby/accounts', (req, res) => {
    const list = db.listAccounts().map(db.publicAccount);
    log.logResult(req, '账号列表', { status: 200, log: `${list.length} 个` });
    return sendJson(res, 200, { accounts: list });
  });

  r.add('POST', '/api/emby/accounts', async (req, res) => {
    const body = await readBody(req);
    const input = readNewAccount(body);
    if (input.error) {
      console.log(`  ✘ emby 新增账号 → HTTP 400 ${input.error}`);
      return sendJson(res, 400, { error: input.error });
    }
    if (db.findAccountByName(input.username)) {
      console.log(`  ✘ emby 新增账号 → HTTP 409 用户名已存在：${input.username}`);
      return sendJson(res, 409, { error: '用户名已存在' });
    }
    try {
      const acc = db.publicAccount(db.addAccount(input.username, input.password));
      console.log(`  ✔ emby 新增账号 → HTTP 200 id=${acc.id} user=${acc.username}`);
      return sendJson(res, 200, { account: acc });
    } catch (e) {
      /* 并发插入时唯一约束兜底（上面的查重只是给友好提示） */
      if (isUniqueErr(e)) return sendJson(res, 409, { error: '用户名已存在' });
      throw e;
    }
  });

  /* 改：username / password 各自可选（只传 password 就是改密）；两个都不传 = 没内容可改 */
  r.add('PUT', '/api/emby/accounts/:id', async (req, res, { params }) => {
    const exists = db.getAccount(params.id);
    if (!exists) {
      console.log(`  ✘ emby 改账号 → HTTP 404 id=${params.id}`);
      return sendJson(res, 404, { error: '账号不存在' });
    }
    const body = (await readBody(req)) || {};
    const patch = {};

    if (body.username !== undefined) {
      const username = String(body.username).trim();
      if (!username) return sendJson(res, 400, { error: '用户名不能为空' });
      if (username.length > ACC_NAME_MAX) return sendJson(res, 400, { error: `用户名最长 ${ACC_NAME_MAX} 个字符` });
      const other = db.findAccountByName(username);
      if (other && Number(other.id) !== Number(exists.id)) {
        console.log(`  ✘ emby 改账号 → HTTP 409 用户名已存在：${username}`);
        return sendJson(res, 409, { error: '用户名已存在' });
      }
      patch.username = username;
    }
    if (body.password) {
      const password = String(body.password);
      if (password.length < ACC_PASS_MIN) return sendJson(res, 400, { error: `密码至少 ${ACC_PASS_MIN} 位` });
      patch.password = password;
    }
    if (!patch.username && !patch.password) return sendJson(res, 400, { error: '没有要修改的内容' });

    try {
      const acc = db.publicAccount(db.updateAccount(params.id, patch));
      const changed = [patch.username && patch.username !== exists.username ? '用户名' : '', patch.password ? '密码' : ''].filter(Boolean).join('+');
      console.log(`  ✔ emby 改账号 → HTTP 200 id=${acc.id} user=${acc.username} 改了：${changed}`);
      return sendJson(res, 200, { account: acc });
    } catch (e) {
      if (isUniqueErr(e)) return sendJson(res, 409, { error: '用户名已存在' });
      throw e;
    }
  });

  r.add('DELETE', '/api/emby/accounts/:id', (req, res, { params }) => {
    const acc = db.getAccount(params.id);
    if (!acc || !db.removeAccount(params.id)) {
      console.log(`  ✘ emby 删账号 → HTTP 404 id=${params.id}`);
      return sendJson(res, 404, { error: '账号不存在' });
    }
    /* 删最后一个也允许：删光后退化成「还没有账号 → 登录 401」，面板随时能重建 */
    console.log(`  ✔ emby 删账号 → HTTP 200 user=${acc.username} 剩余 ${db.countAccounts()} 个`);
    return sendJson(res, 200, { ok: true, remaining: db.countAccounts() });
  });

  /* 缓存用量 / 清空**不在这一层**了：缓存跨两个库（`data/cache/tmdb.db` +
   * `data/emby/cache.db`），"清空"必须只有一个入口 —— 见面板层 `GET|DELETE /api/panel/cache`。 */

  /* ---------------- 首页插件（面板自用，非 Emby 客户端协议） ----------------
   * 上传的插件产出「首页行」，本阶段只在面板内预览；映射到 Emby 端点待明确需求后再做。
   * 与账号管理同类：豁免 AccessToken，但**必须在下面通配之前注册**。 */
  require('./home/routes')(r);

  /* ---------------- 播放进度上报（客户端 → 落库） ----------------
   * 实测（SenPlayer 6.2.1，见 docs/playback-progress.md §11）：
   *   · 开始 1 次 `POST /Sessions/Playing`；心跳每 **10 秒** 1 次 `POST /Sessions/Playing/Progress`；结束 1 次 `…/Stopped`；
   *   · body 里 `ItemId` 就是**本面板发出去的 Id**（`tmdb_…_s{n}_e{m}` / `tmdb_…_movie`），
   *     另有 `PositionTicks` / `RunTimeTicks`（**只有部分心跳带**）/ `MediaSourceId` / `PlaySessionId`；
   *   · **没有 `Played` 字段，也不带 `UserId`** ⇒ "看完"只能按比例判，账号从 token 认。
   * 三条一律回 **204 空体**（真机实测同此：它连 `Progress` 的 token 都不校验；本层按 ADR-0009 三条都校验）。
   * ⚠️ 必须注册在下面的通配之前，否则又是 501。
   */
  const playbackReport = (kind, label) =>
    r.add('POST', `/api/emby/Sessions/${label}`, async (req, res, { query }) => {
      let body = {};
      try {
        body = await readBody(req);
      } catch {
        /* body 不是合法 JSON（或读失败）→ 当空上报处理，`recordPlayback` 会如实说"Id 认不出" */
        body = {};
      }
      const out = service.recordPlayback(req, kind, body);
      log.logResult(req, `播放上报 Sessions/${label}`, out, log.queryBrief(query));
      return sendOut(res, out);
    });
  playbackReport('start', 'Playing');
  playbackReport('progress', 'Playing/Progress');
  playbackReport('stop', 'Playing/Stopped');

  /* ---------------- 观看状态的**写**端点（客户端改「继续观看」「已看」） ----------------
   * 三条都是实测在打的：
   *   · `POST Users/{UserId}/Items/{ItemId}/HideFromResume?Hide=true|false` —— Rex/0.1.0，「从继续观看里移除」；
   *   · `POST Users/{UserId}/PlayedItems/{ItemId}` —— SenPlayer/6.2.1，「标记已看」；
   *   · `DELETE Users/{UserId}/PlayedItems/{ItemId}` —— 同上，「标记未看」。
   * 一律**校验 token**（动的是某个账号的观看记录，见 ADR-0009），回 **200 + 该条目的 `UserData`**；
   * Id 认不出 → **204 且不写库**（与三条上报同口径 —— 客户端只是想让状态变一下，回错会弹错误框）。
   * ⚠️ 必须注册在下面的通配之前，否则又是 501。
   */
  r.add('POST', '/api/emby/Users/:userId/Items/:itemId/HideFromResume', (req, res, { params, query }) => {
    /* `Hide` 缺省当 true —— 端点名字就是 Hide，客户端只在要恢复时才带 `false` */
    const hide = String(query.get('Hide') || '').toLowerCase() !== 'false';
    const out = service.setHiddenFromResume(req, params.userId, params.itemId, hide);
    log.logResult(req, `继续观看开关 Users/…/Items/${params.itemId}/HideFromResume`, out, log.queryBrief(query));
    return sendOut(res, out);
  });

  /* 标记已看 / 未看：同一个处理器，只差 `played`（真机是 POST = 已看、DELETE = 未看） */
  const playedItems = (played) => (req, res, { params, query }) => {
    const out = service.setPlayed(req, params.userId, params.itemId, played);
    log.logResult(req, `标记${played ? '已看' : '未看'} Users/…/PlayedItems/${params.itemId}`, out, log.queryBrief(query));
    return sendOut(res, out);
  };
  r.add('POST', '/api/emby/Users/:userId/PlayedItems/:itemId', playedItems(true));
  r.add('DELETE', '/api/emby/Users/:userId/PlayedItems/:itemId', playedItems(false));

  /* ---------------- 通配：其余一切 /api/emby/** ---------------- */

  r.add('ANY', '/api/emby/*rest', async (req, res, { pathname, query }) => {
    let body = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      try {
        body = await readRawBody(req, 1024 * 1024);
      } catch {
        body = '(请求体读取失败)';
      }
    }
    return notImplemented(req, res, { pathname, query, body });
  });
};
