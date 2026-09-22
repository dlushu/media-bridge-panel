'use strict';
/**
 * Emby 层服务：服务器标识、登录校验、用户资料、条目（均基于 TMDB 元数据）
 *
 * 只做已实现端点所需的事：
 *   GET  /api/emby/System/Info/Public        握手：告诉客户端这是个 Emby 服务器
 *   POST /api/emby/Users/AuthenticateByName  登录：校验面板账号，发一个 AccessToken
 *   GET  /api/emby/Users/{UserId}            取用户资料（客户端登录后紧接着就会要）
 *   GET  /api/emby/Users/{UserId}/Views      媒体库列表（每个启用的插件行 = 一个库，见 getViews）
 *   GET  /api/emby/Users/{UserId}/Items      条目列表（**列表数据由首页模块决定**：认 ParentId=<库Id>；其余如实空，见 getItems）
 *   GET  /api/emby/Shows/{Id}/Seasons        剧的季列表（**占位**：TMDB 的 seasons[]，见 getSeasons）
 *   GET  /api/emby/Shows/{Id}/Episodes       某一季的分集列表（**占位**：TMDB season 接口，见 getEpisodes）
 *
 * 条目 Id 由 tmdb 坐标派生（`tmdb_{id}_{tv|movie}[_s{n}]`），派生与解析是一对：tmdb.itemId / tmdb.parseItemId。
 * TMDB 失败一律**照实回失败**（状态码与上游一致，网络层由 tmdb.httpStatusOf 归类）—— 不编占位数据。
 *
 * 账号（**多账号**）：存 `data/emby/emby.db`（内置 sqlite，见 db.js），密码只存 scrypt 哈希；
 * 老的单账号（设置文件里的 `account.{username,password}` 明文）会在首次用到库时自动迁移并清明文。
 * UserId 仍由「serverId + 用户名」派生 —— 规则没变，多账号各自不同。
 * AccessToken 校验：登录时把 token 存进 `sessions` 表，之后各端点先过 `authorize()`
 * —— 无效/缺失一律 401，且 `UserId` 必须属于该 token 的账号。
 * 三种带法都认：`X-Emby-Token` / `Authorization`·`X-Emby-Authorization` 里的 `Token="…"` / query `api_key=`。
 * 改密或删账号会作废该账号的所有 token。豁免：握手、登录、面板自用端点、501 通配（图片端点将来也要豁免）。
 */
const crypto = require('crypto');
const settings = require('../../core/settings');
const tmdb = require('./tmdb');
/* 协议层的 `search()` 直接用 core 那份（emby 层没有自己的名字搜索逻辑；
 * 缓存（name_index）也在 core —— 见 `getSearchItems` 的注释） */
const tmdbCore = require('../../core/tmdb');
const agg = require('../agg/api'); // 聚合层的进程内调用面（原来是打自己的 /api/agg/*，会撞面板门禁 → 见那个文件顶部）
const BRAND = require('../../core/branding'); // 默认服务器名（客户端「服务器列表」里显示的那个）
const home = require('./home');
const db = require('./db');
const cache = require('./cache');

/** 兼容目标版本：客户端按 Emby 的版本号判断能力，这里报一个常见的 Emby 4.8 */
const EMBY_VERSION = '4.8.0.0';

/** 服务器 Id：首次使用时生成一次并落到设置里，保证客户端缓存的服务器身份稳定 */
function serverId() {
  const s = settings.read('emby');
  if (s.serverId) return s.serverId;
  const id = crypto.randomBytes(8).toString('hex');
  settings.patch('emby', { serverId: id });
  return id;
}

/**
 * 用户 Id：由「服务器 Id + 用户名」派生，稳定且无需额外存储（多账号各自不同）。
 * 归一化走 db.normName —— 登录、查重、UserId 必须同一套规则，否则会出现
 * 「登录成功但 /Users/{id} 404」（用户名带大小写/全角时最明显）。
 */
function userId(username) {
  return crypto.createHash('md5').update(serverId() + '|' + db.normName(username)).digest('hex');
}

function newToken() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * 按 UserId 反解账号 —— 多账号下 `assertUser` 靠它判断"这个 id 属于谁"。
 * 不把 user_id 存库：serverId 一变（重装/误删设置）库里那列就全废，现算永远自洽；
 * 账号数是个位数，逐个算 md5 可忽略。
 */
function resolveAccountById(requestedId) {
  const want = String(requestedId || '').toLowerCase();
  if (!want) return null;
  const sid = serverId(); // 循环外读一次，别每个账号都去读设置文件
  for (const acc of db.listAccounts()) {
    const id = crypto.createHash('md5').update(sid + '|' + db.normName(acc.username)).digest('hex');
    if (id === want) return acc;
  }
  return null;
}

/** 解析客户端的 X-Emby-Authorization：MediaBrowser Client="…", Device="…", DeviceId="…", Version="…" */
function parseClientHeader(raw) {
  const out = { Client: '', Device: '', DeviceId: '', Version: '' };
  const text = String(raw || '');
  for (const key of ['Client', 'Device', 'DeviceId', 'Version']) {
    const m = text.match(new RegExp(key + '="([^"]*)"', 'i'));
    if (m) out[key] = m[1];
  }
  return out;
}

/**
 * 组装 UserDto —— 登录响应里的 User 与 GET /Users/{id} 返回的是同一个对象，
 * 共用这里以保证两处字段一致。字段按 Emby 4.8 的 UserDto 常见项填充。
 */
function buildUser(username, account) {
  const now = new Date().toISOString();
  return {
    Name: username,
    ServerId: serverId(),
    Id: userId(username),
    HasPassword: true,
    HasConfiguredPassword: true,
    HasConfiguredEasyPassword: false,
    EnableAutoLogin: false,
    LastLoginDate: (account && account.last_login_at) || now,
    LastActivityDate: now,
    Configuration: {
      PlayDefaultAudioTrack: true,
      SubtitleLanguagePreference: '',
      DisplayMissingEpisodes: false,
      GroupedFolders: [],
      SubtitleMode: 'Default',
      DisplayCollectionsView: false,
      EnableLocalPassword: false,
      OrderedViews: [],
      LatestItemsExcludes: [],
      MyMediaExcludes: [],
      HidePlayedInLatest: true,
      RememberAudioSelections: true,
      RememberSubtitleSelections: true,
      EnableNextEpisodeAutoPlay: true,
    },
    Policy: {
      IsAdministrator: true,
      IsHidden: false,
      IsDisabled: false,
      EnableAllFolders: true,
      EnabledFolders: [],
      EnableContentDownloading: true,
      EnableMediaPlayback: true,
      EnableAudioPlaybackTranscoding: true,
      EnableVideoPlaybackTranscoding: true,
      EnablePlaybackRemuxing: true,
      EnableRemoteControlOfOtherUsers: false,
      EnableSharedDeviceControl: false,
      EnableSyncTranscoding: false,
    },
  };
}

/** GET /System/Info/Public —— 客户端握手 */
/**
 * 服务器名 —— 客户端「服务器列表」里显示的就是它。
 *
 * 默认 `BRAND.embyServerName`（core/branding.js），可在面板「Emby → 连接设置」里改（存 `settings/emby.json` 的 `serverName`）。
 * **取不到 / 空 / 全空白就回默认值**：客户端拿空 ServerName 会显示成空白条目，比显示默认名更糟。
 * 长度上限在模块设置的 `validate` 里管（不在这一层兜）。
 */
function serverName() {
  const s = settings.read('emby') || {};
  return String(s.serverName || '').trim() || BRAND.embyServerName;
}

function publicInfo(req) {
  const host = req.headers.host || '127.0.0.1:8099';
  return {
    LocalAddress: 'http://' + host,
    ServerName: serverName(),
    Version: EMBY_VERSION,
    ProductName: 'Emby Server',
    OperatingSystem: process.platform,
    Id: serverId(),
    StartupWizardCompleted: true,
  };
}

/**
 * 从请求里取客户端带来的 AccessToken —— Emby 客户端三种带法都认：
 *   ① 头 `X-Emby-Token`（绝大多数请求）
 *   ② 头 `X-Emby-Authorization` 里的 `Token="…"`（部分客户端把 token 塞进那串）
 *   ③ query `api_key=`（实测客户端拉直连流时是这个）
 */
function tokenFrom(req) {
  const h = (req && req.headers) || {};
  const direct = String(h['x-emby-token'] || '').trim();
  if (direct) return { token: direct, from: 'x-emby-token' };
  /* MediaBrowser / Emby 授权头：`Client="…", Device="…", Token="…"`
   *   客户端实测发在 `X-Emby-Authorization`；官方文档写的是 `Authorization` —— 两个都看 */
  for (const name of ['x-emby-authorization', 'authorization']) {
    const m = /Token="([^"]+)"/i.exec(String(h[name] || ''));
    if (m) return { token: m[1].trim(), from: name };
  }
  try {
    const q = new URL(String((req && req.url) || ''), 'http://local').searchParams.get('api_key');
    if (q) return { token: String(q).trim(), from: 'api_key' };
  } catch {
    /* url 解析不了就当没带 */
  }
  return { token: '', from: '' };
}

/**
 * 受保护端点的统一守卫：AccessToken 必须有效，且（请求里给了 UserId 时）那个 Id 必须属于这个 token 的账号。
 *   通过 → null；拒绝 → { status, body, log }（调用方直接回给客户端，401）
 *
 * 没有"宽松/严格"之分 —— 校验就是校验。客户端拿不到 token 时应当回登录界面，
 * 这与官方 Emby 对 401 的定义一致（401 = token 无效或被吊销）。
 */
function authorize(req, requestedUserId) {
  const { token, from } = tokenFrom(req);
  const sess = token ? db.findSession(token) : null;

  let problem = '';
  if (!sess) problem = token ? `token 无效（来自 ${from}）` : '没带 token';
  else if (requestedUserId && userId(sess.username).toLowerCase() !== String(requestedUserId).toLowerCase()) {
    problem = `token 属于「${sess.username}」，请求的却是别的 UserId`;
  }
  if (!problem) {
    db.touchSession(token);
    return null;
  }
  return { status: 401, body: { error: '需要有效的 AccessToken（' + problem + '）' }, log: `token 校验不过：${problem}` };
}

/**
 * POST /Users/AuthenticateByName —— 登录（多账号：按用户名查库 + scrypt 校验）
 * 返回 { status, body, log }；账号不存在 / 密码错都回 401（与 Emby 行为一致）
 */
function authenticate(req, body) {
  const username = String((body && (body.Username || body.username)) || '').trim();
  const password = String((body && (body.Pw || body.Password || body.password)) || '');
  const client = parseClientHeader(req.headers['x-emby-authorization']);

  if (!db.countAccounts()) {
    return {
      status: 401,
      body: { error: '面板还没有 Emby 账号：请到「Emby → 账号管理」先添加一个账号' },
      log: '还没有账号',
    };
  }

  const acc = db.findAccountByName(username);
  if (!acc || !db.verifyPassword(password, acc.password_hash)) {
    /* 只说"用户名或密码不正确"，**不要**分别标出哪个不匹配 —— 那等于告诉别人某个用户名存不存在 */
    return {
      status: 401,
      body: { error: '用户名或密码不正确' },
      log: `校验失败（用户=${username || '(空)'}）`,
    };
  }

  const clientLabel = [client.Client, client.Device].filter(Boolean).join(' / ');
  try {
    db.touchLogin(acc.id, clientLabel);
  } catch {
    /* 记登录时间失败不该拦住登录 */
  }

  /* token 落到 sessions 表 —— 之后每个受保护端点都靠它认人（见 authorize）。
   * 这里**不吞异常**：存不下 token 的登录等于发了个假凭证，宁可 500 让它显形。 */
  const token = newToken();
  db.createSession(token, acc.id, { client: clientLabel, deviceId: client.DeviceId });

  const now = new Date().toISOString();
  return {
    status: 200,
    log: `登录成功（${acc.username}${clientLabel ? ' · ' + clientLabel : ''}）`,
    body: {
      User: buildUser(acc.username, acc),
      SessionInfo: {
        Id: crypto.randomBytes(16).toString('hex'),
        UserId: userId(acc.username),
        UserName: acc.username,
        Client: client.Client,
        DeviceName: client.Device,
        DeviceId: client.DeviceId,
        ApplicationVersion: client.Version,
        LastActivityDate: now,
      },
      AccessToken: token,
      ServerId: serverId(),
    },
  };
}

/**
 * 校验 requestedId 是不是**某个账号**派生的 User Id —— /Users/{UserId} 这一族端点共用。
 * 通过 → null（调用方继续）；不通过 → { status, body, log }（调用方直接 return）。
 * （多账号前这里只认唯一账号；现在认库里任意一个账号。）
 */
function assertUser(requestedId) {
  if (!db.countAccounts()) {
    return { status: 401, body: { error: '面板还没有 Emby 账号' }, log: '还没有账号' };
  }
  if (!resolveAccountById(requestedId)) {
    return { status: 404, body: { error: '用户不存在' }, log: 'id 不属于任何账号 → 404：' + requestedId };
  }
  return null;
}

/**
 * GET /Users/{UserId} —— 取用户资料（返回 UserDto 本体，不包一层）
 * 按 Id 找回对应账号：找不到时，表为空 401、否则 404。
 */
/* ------------------------------------------------ 观看进度（写端点落库，读端点共用） */

/**
 * 「看完」的判定阈值：位置 ≥ 时长的 90%。
 *
 * 客户端**不报 `Played` 字段**（实测 SenPlayer 6.2.1 / Rex 0.1.0 的 body 里都没有），
 * 所以只能按比例判 —— 阈值只此一处。真机同样是按比例判的（实测：报 95% 后 `Stopped`
 * 即变 `Played: true`，见 docs/playback-progress.md §11）。
 */
const PLAYED_RATIO = 0.9;

/** tick → 人话（**只给日志用**；10^7 tick = 1 秒）。日志上要一眼看出"看到了第几分钟"。 */
function ticksText(t) {
  const s = Math.max(0, Number(t) || 0) / 1e7;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
}

/** 这个请求是哪个账号发的（token → 会话）；没带 token 或 token 无效 → null */
function sessionOf(req) {
  const { token } = tokenFrom(req);
  return token ? db.findSession(token) : null;
}

/** 请求对应的账号 id：优先 token 认出的那个（权威），其次按 `UserId` 反查（客户端有时只给 UserId） */
function accountIdFor(req, requestedUserId) {
  const sess = sessionOf(req);
  if (sess) return sess.account_id;
  const acc = resolveAccountById(requestedUserId);
  return acc ? acc.id : null;
}

/** `Limit` 查询参数 → 实际条数（默认 `def`，硬顶 100：别让一个客户端一次把整库拉走） */
function limitOf(query, def) {
  const v = Number(query && typeof query.get === 'function' ? query.get('Limit') : 0);
  if (!Number.isFinite(v) || v <= 0) return def;
  return Math.min(Math.floor(v), 100);
}

/**
 * 日志里"这次列出的是哪几条"（最多 5 个 Id，多了只报总数）。
 *
 * 为什么值得占这点位置：「列表对不对」是排查的第一问，而原来只报 `Items=1` ——
 * 客户端"移除之后还在"那次就卡在这里：分不清它列的是被移除的那一集还是下一集。
 */
function briefIds(items, max = 5) {
  const ids = (items || []).map((i) => i && i.Id).filter(Boolean);
  if (!ids.length) return '';
  return `（${ids.slice(0, max).join(', ')}${ids.length > max ? ` …共 ${ids.length} 条` : ''}）`;
}

/**
 * 库里这条的记录 → `{ userData, runtimeTicks }`；**没有记录返回 null**（调用方保持空形状）。
 *
 * `PlayedPercentage` 与 `LastPlayedDate` 是**实测对真机补齐**的两个字段：
 *   · 真机在有位置的条目上给 `PlayedPercentage`（小数，如 `4.333496627087306`；位置为 0 时**不给**）；
 *   · 客户端画进度条主要靠它 —— 只给 `PlaybackPositionTicks` 而条目又没有 `RunTimeTicks` 时，
 *     界面上就是**光秃秃没有进度条**（对比真机发现的那次）。
 * `LastPlayedDate` 用进度行最后一次更新的时间（就是"最后观看时间"）。
 */
function progressOf(accountId, itemId) {
  if (!accountId || !itemId) return null;
  const r = db.getPlayback(accountId, itemId);
  if (!r) return null;
  const position = Math.max(0, Number(r.position_ticks) || 0);
  const runtime = Math.max(0, Number(r.runtime_ticks) || 0);
  const userData = {
    IsFavorite: false,
    PlayCount: Number(r.play_count) || 0,
    PlaybackPositionTicks: position,
    Played: !!r.played,
  };
  if (position > 0 && runtime > 0) userData.PlayedPercentage = (position / runtime) * 100;
  if (r.updated_at) userData.LastPlayedDate = String(r.updated_at).replace(/\.\d+Z$/, '.0000000Z'); // 真机是 7 位小数
  return { userData, runtimeTicks: runtime };
}

/**
 * 把进度与时长落到条目上（`progressItem` 与 `applyUserData` **共用同一口径**）。
 *
 * `RunTimeTicks` 只在条目本来没有时补：值来自**客户端上报的 `RunTimeTicks`**（源给的时长，
 * 不是编的）；集条目通常已由 TMDB 的 `runtimeMinutes` 填过，就以那个为准。
 */
function applyProgressToItem(item, prog) {
  if (!prog || !item) return item;
  item.UserData = Object.assign({}, item.UserData || emptyUserData(), prog.userData);
  if (!item.RunTimeTicks && prog.runtimeTicks > 0) item.RunTimeTicks = prog.runtimeTicks;
  return item;
}

/**
 * 就地给响应里的条目补**真实**观看状态（`UserData`）；库里没记录的条目**保持原来的空形状**
 * （字段集合与 `emptyUserData()` 完全一致，见 ADR-0007）。
 *
 * 为什么做成"响应后处理"而不是给每个 DTO 都加账号参数：读侧有 6 处会产出条目 DTO
 * （列表 / 详情 / 季 / 集 / 最新 / 相似），逐个改签名既啰嗦又容易漏；而入参形状就那么几种
 * （`{Items:[…]}` / 裸数组 / 单条），处理一次全覆盖。数据库是**同步**的（`node:sqlite`），
 * 所以这一步不必 async 化。
 *
 * 剧级条目（`tmdb_x_tv`）**不补任何东西**：进度记在集上，而"整剧是否看完"要知道总集数，
 * 本层不知道 —— 宁可不给，也不编（ADR-0008）。
 */
function applyUserData(out, requestedUserId, req) {
  const accountId = accountIdFor(req, requestedUserId);
  if (!accountId || !out || !out.body) return out;
  const patch = (item) => {
    if (!item || !item.Id) return;
    applyProgressToItem(item, progressOf(accountId, item.Id));
  };
  const b = out.body;
  if (Array.isArray(b)) b.forEach(patch);
  else if (Array.isArray(b.Items)) b.Items.forEach(patch);
  else patch(b);
  return out;
}

/**
 * 三条上报端点的共同入口：`Sessions/Playing`（开始）/ `/Playing/Progress`（心跳）/ `/Playing/Stopped`（结束）。
 *
 * 客户端实测（SenPlayer 6.2.1，见 docs/playback-progress.md §11）：
 *   · `ItemId` 就是**本面板发出去的 Id**（`tmdb_{id}_tv_s{n}_e{m}` / `tmdb_{id}_movie`）—— 原样回传，不做解析；
 *   · 心跳每 10 秒一次，带 `PositionTicks`，**部分**心跳才带 `RunTimeTicks`；
 *   · **没有 `Played` 字段** ⇒ "看完"只能按位置/时长比例判（真机同样如此）；
 *   · 一律**不报 `UserId`** ⇒ 账号从 token 认。
 *
 * 响应一律 **204 空体**（真机实测三条都是 204；Progress 连 token 都不校验，但本层按 ADR-0009 校验）。
 * 认不出的 `ItemId` **不写库**，但**记一行日志**说明被忽略 —— 不静默吞掉。
 */
function recordPlayback(req, kind, body) {
  const denied = authorize(req, body && body.UserId);
  if (denied) return denied;
  const sess = sessionOf(req);
  if (!sess) return { status: 401, body: { error: '需要有效的 AccessToken' }, log: 'token 校验不过' };

  const t = playableOf(body && body.ItemId);
  if (!t) {
    return { status: 204, body: null, log: `上报的 ItemId 认不出（不是本面板发出去的电影/集 Id）→ 不写库：${(body && body.ItemId) || '(空)'}` };
  }
  const itemId = t.itemId;
  const prev = db.getPlayback(sess.account_id, itemId) || {};
  const position = Math.max(0, Number((body && body.PositionTicks) || 0) || 0);
  const runtime = Math.max(0, Number((body && body.RunTimeTicks) || 0) || Number(prev.runtime_ticks) || 0);

  let played = !!prev.played;
  let playCount = Number(prev.play_count) || 0;
  let storePos = position;
  let note = '';
  /* 又开始播了 → 从「继续观看」的隐藏状态里放出来（用户又在看它了，它该回到那一行）。
   * 只在这条被隐藏过时才写，免得每次开始播放都多一次 UPDATE。 */
  if (kind === 'start' && Number(prev.hidden)) {
    db.setHidden(sess.account_id, itemId, false);
    note = '重新开始播放 → 取消「已从继续观看移除」';
  }
  if (kind === 'stop') {
    const ratio = runtime > 0 ? position / runtime : 0;
    if (body && body.Played === true) {
      played = true;
      playCount += 1;
      storePos = 0;
      note = '客户端明确说看完 → 标记已看';
    } else if (runtime > 0 && ratio >= PLAYED_RATIO) {
      played = true;
      playCount += 1;
      storePos = 0; // 已看的条目不该再出现在「继续观看」里（真机的 `PlaybackPositionTicks` 也是 0）
      note = `位置 ${Math.round(ratio * 100)}% ≥ ${PLAYED_RATIO * 100}% → 标记已看`;
    }
  } else if (played && position > 0) {
    /* 重看：已看的条目又有了进度 → 退回"未看完"，否则「继续观看」永远看不到它 */
    played = false;
    note = '重看 → 取消已看标记';
  }

  /* 名称里的 `kind` 直接写进日志，三种端点共用一行格式 */
  const label = kind === 'start' ? '开始' : kind === 'progress' ? '心跳' : '停止';
  db.upsertPlayback(sess.account_id, itemId, {
    positionTicks: storePos,
    runtimeTicks: runtime,
    played,
    playCount,
    seriesId: t.seriesId,
    season: t.season,
    episode: t.episode,
  });
  return {
    status: 204,
    body: null,
    log:
      `${label} ${itemId} 位置 ${ticksText(storePos)}` +
      (runtime ? ` / ${ticksText(runtime)}` : ' / 时长未知') +
      (note ? ` · ${note}` : ''),
  };
}

/**
 * 请求里的条目 Id → 「库里那一行的主键 + 集的坐标」；**认不出返回 null**。
 *
 * 三条上报 + 三个写端点共用：认不出的 Id 一律**不写库**，与上报端点同口径 ——
 * 客户端只是想让状态变一下，回 4xx/501 只会让它弹一个错误框。
 */
function playableOf(rawItemId) {
  const p = tmdb.parseItemId(String(rawItemId || '').trim());
  if (!p || !isPlayableId(p)) return null;
  return {
    itemId: tmdb.itemId(p.type, p.tmdbId, p.season, p.episode),
    seriesId: p.season !== null ? tmdb.itemId('tv', p.tmdbId) : null,
    season: p.season,
    episode: p.episode,
  };
}

/** 一个条目的 `UserData` 形状（库里没记录就是空形状）—— 三个写端点的响应体用它 */
function userDataOf(accountId, itemId) {
  const prog = progressOf(accountId, itemId);
  return prog ? prog.userData : emptyUserData();
}

/**
 * `POST /Users/{UserId}/Items/{ItemId}/HideFromResume?Hide=true|false` ——「从继续观看里移除 / 恢复」。
 *
 * 只翻 `playback.hidden`，**不动位置**（真机实测同此：隐藏前后 `UserData` 一个字段都没变）——
 * `Hide=false` 之后位置还在，回来还是原来那一行。重新开始播放会**自动取消隐藏**（见 `recordPlayback`）。
 *
 * 库里**没有这一行**时：隐藏 → 写一行**占位**（否则"移除"记不住，下次拉列表它又回来；
 * 实测 SenPlayer 就会对「接着看」里那条还没看过的下一集发这条）；恢复 → 不动库。
 * 读侧随之要跳过被隐藏的：`Items/Resume` 与 `Shows/NextUp` 都排除 `hidden`
 * （见 `db.listResume` / `db.listRecentBySeries`，以及 `nextEpisodeItem` 里"往后找下一个没被隐藏的集"）。
 *
 * 回 **200 + 该条目的 `UserData`**；Id 认不出 → **204 且不写库**（记一行日志）。
 */
function setHiddenFromResume(req, requestedUserId, rawItemId, hide) {
  const denied = authorize(req, requestedUserId);
  if (denied) return denied;
  const sess = sessionOf(req);
  if (!sess) return { status: 401, body: { error: '需要有效的 AccessToken' }, log: 'token 校验不过' };

  const t = playableOf(rawItemId);
  if (!t) {
    return {
      status: 204,
      body: null,
      log: `HideFromResume 的 ItemId 认不出（不是本面板发出去的电影/集 Id）→ 不写库：${rawItemId || '(空)'}`,
    };
  }
  const hadRow = !!db.getPlayback(sess.account_id, t.itemId);
  const changed = db.setHidden(sess.account_id, t.itemId, hide, t);
  return {
    status: 200,
    body: userDataOf(sess.account_id, t.itemId),
    log:
      `${hide ? '移出' : '恢复'}「继续观看」${t.itemId}` +
      (hide && !hadRow ? '（库里本来没有这条 → 写一行占位记住它）' : '') +
      (!hide && !hadRow ? '（库里本来就没有这条 → 不动库）' : ''),
  };
}

/**
 * `POST|DELETE /Users/{UserId}/PlayedItems/{ItemId}` ——「标记已看 / 标记未看」。
 *
 *   · 已看（`POST`）→ `played=1`、位置归零、`play_count` **抬到至少 1**（真机实测：`0 → 1`、`1 → 1`，
 *     它不是每次 +1）—— 于是它从「继续观看」消失、进「已看」；
 *   · 未看（`DELETE`）→ `played=0`、位置归零、`play_count` 归 0 —— 行**留着**：
 *     时长与季集坐标对「接下来看」还有用，重看时也不必重新攒。
 *
 * 回 **200 + 该条目的 `UserData`**（真机这两条回的就是 `UserItemDataDto`）；认不出的 Id → **204 且不写库**。
 */
function setPlayed(req, requestedUserId, rawItemId, played) {
  const denied = authorize(req, requestedUserId);
  if (denied) return denied;
  const sess = sessionOf(req);
  if (!sess) return { status: 401, body: { error: '需要有效的 AccessToken' }, log: 'token 校验不过' };

  const t = playableOf(rawItemId);
  if (!t) {
    return {
      status: 204,
      body: null,
      log: `PlayedItems 的 ItemId 认不出（不是本面板发出去的电影/集 Id）→ 不写库：${rawItemId || '(空)'}`,
    };
  }
  const prev = db.getPlayback(sess.account_id, t.itemId) || {};
  const wasPlayed = !!prev.played;
  db.upsertPlayback(sess.account_id, t.itemId, {
    positionTicks: 0,
    /* 传 0 = **保持库里已有的时长**（upsert 里的 CASE 只在传入 > 0 时才覆盖）——
     * 标记已看 / 未看都不该把客户端上报过的时长弄丢。 */
    runtimeTicks: Number(prev.runtime_ticks) || 0,
    played,
    /* 「标记已看」把 `play_count` **抬到至少 1**（真机两次实测都吻合：`0 → 1`、`1 → 1`）——
     * 它不是"每次 +1"，那是播放上报的事；「标记未看」归 0（真机实测同此）。 */
    playCount: played ? Math.max(1, Number(prev.play_count) || 0) : 0,
    seriesId: t.seriesId,
    season: t.season,
    episode: t.episode,
  });
  return {
    status: 200,
    body: userDataOf(sess.account_id, t.itemId),
    log: `${played ? '标记已看' : '标记未看'} ${t.itemId}` + (played && wasPlayed ? '（本来就是已看）' : ''),
  };
}

/** 账号被删时清掉它的进度（`/api/emby/accounts` 的删除走 `db.removeAccount`，那里已经带了） */

/**
 * 一条进度行 → 一条 `BaseItemDto`（「继续观看」/「已看」/「接下来看」共用）。
 *
 * 元数据**按坐标反查 TMDB**（走 `data/cache/tmdb.db` 缓存；播过的东西刚查过，基本是命中）。
 * **查不到就返回 null**，由调用方跳过 —— 不编名字、不编封面（ADR-0008）。
 * 集的拼装与 `getEpisodes()` 保持一致（同样是剧照当 Primary、`IsFolder=false`、带季集号）。
 */
async function progressItem(r, accountId) {
  const p = tmdb.parseItemId(r.item_id);
  if (!p) return null;
  const prog = progressOf(accountId, r.item_id);

  if (p.type === 'movie') {
    const look = await tmdb.lookup({ type: 'movie', tmdbId: p.tmdbId });
    if (!look.ok) return null;
    const item = leanItemDto({
      type: 'movie',
      tmdbId: p.tmdbId,
      parentId: defaultLibraryId(),
      title: look.item.title,
      year: look.item.year,
      overview: look.item.overview,
      communityRating: look.item.communityRating,
      posterPath: look.item.posterPath,
      backdropPath: look.item.backdropPath,
    });
    item.IsFolder = false;
    applyProgressToItem(item, prog);
    return item;
  }

  if (p.season === null || p.episode === null) return null; // 剧（`_tv`）本身没有进度，见 applyUserData 的说明
  const seasonLook = await tmdb.lookupSeason({ tmdbId: p.tmdbId, season: p.season });
  if (!seasonLook.ok) return null;
  const e = (seasonLook.item.episodes || []).find((x) => Number(x.episodeNumber) === Number(p.episode));
  if (!e) return null; // 这一季里没有这一集（源与 TMDB 对不上）→ 不列，不编

  const showLook = await tmdb.lookup({ type: 'tv', tmdbId: p.tmdbId }); // 只为剧名（缓存里通常已有）
  const item = baseItem({
    id: tmdb.itemId('tv', p.tmdbId, p.season, p.episode),
    parentId: defaultLibraryId(),
    name: e.name || `第 ${p.episode} 集`,
    type: 'Episode',
    year: e.year,
    premiereDate: e.premiereDate,
    overview: e.overview,
    communityRating: e.rating,
    providerIds: { Tmdb: String(p.tmdbId) },
    posterUrl: tmdb.imageUrlOf('w300', e.stillPath),
  });
  item.IsFolder = false;
  item.IndexNumber = e.episodeNumber;
  item.ParentIndexNumber = p.season;
  item.SeriesId = tmdb.itemId('tv', p.tmdbId);
  if (showLook.ok) item.SeriesName = showLook.item.title || '';
  item.SeasonId = tmdb.itemId('tv', p.tmdbId, p.season);
  item.SeasonName = seasonLook.item.name || `第 ${p.season} 季`;
  if (e.runtimeMinutes) item.RunTimeTicks = e.runtimeMinutes * 600000000;
  if (e.stillPath) item.PrimaryImageAspectRatio = 1.7777778;
  applyProgressToItem(item, prog);
  return item;
}

/** 一组进度行 → `QueryResult<BaseItemDto>`（取不到元数据的行**跳过并计数**，日志里说明） */
async function progressList(rows, accountId, label) {
  const items = [];
  let skipped = 0;
  for (const r of rows) {
    const it = await progressItem(r, accountId);
    if (it) items.push(it);
    else skipped += 1;
  }
  return {
    status: 200,
    body: { Items: items, TotalRecordCount: items.length },
    log:
      `${label}：库里 ${rows.length} 条 → 列出 ${items.length} 条${skipped ? `（${skipped} 条取不到元数据，未列出）` : ''}` +
      briefIds(items),
  };
}

/**
 * GET /Users/{UserId} —— 取用户资料（返回 UserDto 本体，不包一层）
 * 按 Id 找回对应账号：找不到时，表为空 401、否则 404。
 */
function getUser(requestedId) {
  const acc = resolveAccountById(requestedId);
  if (!acc) {
    if (!db.countAccounts()) {
      return { status: 401, body: { error: '面板还没有 Emby 账号' }, log: '还没有账号' };
    }
    return { status: 404, body: { error: '用户不存在' }, log: 'id 不属于任何账号 → 404：' + requestedId };
  }
  return { status: 200, body: buildUser(acc.username, acc), log: 'ok（' + acc.username + '）' };
}

/**
 * GET /Users/{UserId}/Views —— 媒体库列表
 *
 * **不再留白**：每个「启用」的首页插件行做成一个 Emby 媒体库
 * （`Type: CollectionFolder`），客户端据此在首页列出这些库。
 *
 * 行内容走 `Items?ParentId=<库Id>`（见 `getItems` → `home.listByQuery`）。
 *
 * 条目的字段形状见 `homeViewItem()`（按真机逐字段补齐，含封面）。
 *
 * 数据取自 registry 快照（不加载插件代码、不起沙箱）；没有启用的插件行时回空 ——
 * 与留白时期的空响应形状完全一致，客户端不受影响。
 */
function getViews(requestedId) {
  const denied = assertUser(requestedId);
  if (denied) return denied;

  const items = home.enabledRows().map(homeViewItem);
  return {
    status: 200,
    body: { Items: items, TotalRecordCount: items.length },
    log: items.length ? `${items.length} 个库（来自启用的首页插件行）` : '0 个库（没有启用的首页插件行）',
  };
}

/**
 * 首页插件行 → Emby 的媒体库条目（`CollectionFolder`）。
 *
 * 刻意**不复用 `baseItem()`**：那是"媒体条目"的形状（`MediaType: Video`、`ProductionYear: 0`、
 * `PremiereDate: ''`…），容器套上那些会让客户端按"影片"去理解它。
 *
 * **按真机字段表补齐**：拿真机 25 个库的响应逐字段对过
 * （`docs/emby-compat.md` 有实测值）。每个值的来源都写在下面各自那一行上 ——
 * **推不出来的一律不填**，不为凑字段编值。
 *
 * 唯一**刻意不给**的是 `ParentId`：真机 25/25 都是 `"2"`（服务器根节点），
 * 本实现根本没有那个节点 —— 给了就是指向一个不存在的东西，客户端顺着它去取只会拿到空。
 */
function homeViewItem(r) {
  const id = home.viewId(r.pluginId, r.rowId);
  const name = r.title || r.rowId;

  /* ---- 封面（真机每个有图的库都有，且**只**放在 `ImageTags.Primary`）----
   * 两条路都**零上游请求**：
   *   ① 图片索引（持久，默认 90 天）—— 发过 tag 就记下了，重启后仍在；
   *   ② 该行的**内存缓存结果** —— 客户端逛过一次就会有。
   * **绝不为了封面单独打一次 TMDB**：那份代价随库数线性增长（已定为红线）。
   * 取不到就不给 `ImageTags` / `PrimaryImageAspectRatio` —— 真机无图的库正是这个形状
   * （实测：`ImageTags: {}`、`BackdropImageTags: []`、**没有** `PrimaryImageAspectRatio` 这个键）。
   *
   * 只用**横图**（`backdrop`）：真机库封面基本是 16:9，客户端按横图布局时不会把图裁烂；
   * 也因此 ratio 恒为 1.777…（竖图海报硬当库封面会变形，宁可不给）。 */
  let cover = imageUrlFromIndex(id, 'Primary', 0);
  if (!cover) {
    const first = (home.peekRowItems(r.pluginId, r.rowId) || []).find((it) => it && it.backdrop);
    if (first) cover = first.backdrop;
  }

  /* 三个标识：真机里 `Guid` = `PresentationUniqueKey` = `DisplayPreferencesId`（同一个 GUID，
   * 实测 25/25 相同）。库 Id 不是 GUID 形状，就用它派生一个**稳定**的 32 位 hex ——
   * 客户端拿它们做缓存键，每次请求都变会让缓存反复失效。 */
  const guid = stableHash('view|' + id);
  const item = {
    Name: name,
    ServerId: serverId(),
    Id: id,
    Guid: guid,
    /* 真机的 `Etag` 是**库内容**的指纹。这里的"库"就是这一行：库名或封面变了才算变。
     * （TMDB 榜单内容每天在变，但本层无从观察 —— 那就只对能观察到的部分负责。） */
    Etag: stableHash([id, name, cover || ''].join('|')),
    /* `DateCreated` = **占位值**。
     * 真机那是库的创建时间，而本层没有"建库"这个动作 —— TMDB 里也没有"这一行"这个实体，
     * 拿不到任何真实时间可用。曾经用"库首次出现在 `Views` 的时刻"（`view_seen` 表）近似，
     * 但那是个**不可再生**的值（表一丢，所有库看起来就"全新建了"），为它养一张表不划算；
     * 占位值取 Emby 自己的零值（与 DateModified 同一个），这样"一看就知道是占位"，
     * 也**必须是合法时间**：`0000-00-00` 这种非法日期会让客户端的 DateTime 解析整条失败
     * （文档里记过的最贵那种故障）。 */
    DateCreated: ZERO_STAMP,
    /* `DateModified` 真机 25/25 全是这个值 —— Emby 里"从未修改"的零值，照给。 */
    DateModified: ZERO_STAMP,
    CanDelete: false,
    CanDownload: false,
    PresentationUniqueKey: guid,
    SortName: name,
    ForcedSortName: name,
    ExternalUrls: [],
    Taglines: [],
    RemoteTrailers: [],
    ProviderIds: {},
    IsFolder: true,
    Type: 'CollectionFolder',
    UserData: emptyViewUserData(),
    DisplayPreferencesId: guid,
    BackdropImageTags: [],
    LockedFields: [],
    LockData: false,
  };

  /* `CollectionType`：真机每个库都有（`movies`/`tvshows`/`playlists`/`boxsets`）。
   * 值由 `home.enabledRows()` 定好（**行自己声明** → 按该行当前的 `type` 参数推 → `mixed`，
   * 取值顺序的理由写在 `home.resolveCollectionType()` 上）。
   * ⚠️ 该字段曾经**刻意不给**（当时担心客户端不认），实测真机每个库都给 ⇒ 给了更贴近真机。
   * 若哪个客户端反而异常，**第一个该试的就是把这一行去掉**。 */
  if (r.collectionType) item.CollectionType = r.collectionType;

  if (cover) {
    item.ImageTags = { Primary: tagAndRemember(id, 'Primary', 0, cover) };
    item.PrimaryImageAspectRatio = 1.7777777777777777;
  } else {
    item.ImageTags = {};
  }
  return item;
}

/**
 * GET /Users/{UserId}/Items/Resume —— 首页「继续观看」
 *
 * 数据来自 `playback` 表（客户端 `POST /Sessions/Playing*` 上报的结果）：
 * **有位置、还没看完**的条目，最近看的在前 —— 排序与真机一致（实测）。
 *
 * **必须校验账号**（与 `getStudios` 那种"回空"端点不同）：这里回的是**某个账号的观看记录**，
 * 不校验就是跨账号泄漏（ADR-0009：回真数据的端点必须校验）。没有记录时照样回空列表 + 200 ——
 * "这台服务器上还没看过任何东西"本来就是 Emby 的合法状态。
 */
async function getResume(requestedId, req, query) {
  const denied = authorize(req, requestedId);
  if (denied) return denied;
  const accountId = accountIdFor(req, requestedId);
  if (!accountId) return { status: 200, body: { Items: [], TotalRecordCount: 0 }, log: '账号认不出 → 空' };
  const rows = db.listResume(accountId, limitOf(query, 20));
  return progressList(rows, accountId, '继续观看');
}

/**
 * GET /Studios —— 工作室（制片公司 / 发行方 / 电视台）清单
 *
 * **如实回空**。这不是"还没做"，是**做不出真数据**：
 *
 *   · 每条片的 `Studios[]` **本地本来就有** —— 详情页从 TMDB 的 `production_companies` 映射
 *     （见 `applyRich`），实测 `movie/603` 给 4 个（含 `Warner Bros. Pictures`）
 *   · 但这个端点要的是**全库去重后的清单**，而**服务端没有片库索引**：列表数据由首页插件
 *     在请求时现跑，本层从不存"库里有哪些片"
 *   · 硬凑只能去跑一遍启用的行来聚合 —— 那得到的是**行返回的那几页**里的工作室（榜单片 ≠ 片库），
 *     清单会随榜单波动。用户拿着一个会变的清单去筛选，得到的结果没法解释 —— 那是**编数据**，
 *     比空更糟
 *   · 何况它还有个配套的 `/Studios/{Name}/Items`（点某个工作室看它出了哪些片）同样无从回答，
 *     所以只给清单本身也没多大意义
 *
 * ⇒ 回一个空 `QueryResult`：筛选列表是空的，但**不骗人**（与 `getResume` 同一取向）。
 * 另外：详情里的 `Studios[]` **只给 `Name` 不给 `Id`**，也是同一个道理 ——
 * 给了 Id 客户端就会去点，而这里没有那条路。
 */
function getStudios() {
  return {
    status: 200,
    body: { Items: [], TotalRecordCount: 0 },
    log: '没有片库可枚举（见 service.getStudios）→ 空（如实）',
  };
}

/**
 * 这个 `Items` 查询**会不会真的返回数据**？
 *
 * 只有「认得出是本面板发出去的库 Id」（`ParentId=catpawhome_…`）且不是收藏/已播放时，才会去向
 * 首页模块要数据；其余分支一律**如实回空**。
 *
 * **为什么需要它**：**回空的响应不该校验账号** ——
 * 没有数据可保护，校验只会有坏处：客户端不带 token 时白吃一个 401，而它本该拿到一个空列表。
 * 所以校验只挂在"真会出数据"的那条支路上。
 *
 * ⚠️ 路由层（`routes.js` 决定要不要 `authorize`）与 `getItems` 用的是**同一个函数**，
 * 别各写一份判断 —— 两处一旦漂移，就会出现"校验了但回空"或"出数据却没校验"。
 */
function itemsWillReturnData(query) {
  const val = (k) => (query && typeof query.get === 'function' ? query.get(k) || '' : '');
  /* 收藏：仍然一条数据都没有 → 不校验账号；
   * **已看：现在会出真数据**（读 `playback` 表）⇒ 必须校验，否则未鉴权就能读到
   * 某个账号的观看记录（跨账号泄漏）。这条判据被路由层与 `getItems` 共用，改一次两边同步。 */
  if (/IsFavorite/i.test(val('Filters'))) return false;
  if (/IsPlayed/i.test(val('Filters'))) return true;
  if (home.parseViewId(val('ParentId'))) return true;
  if (searchTermOf(query)) return true; // 按名字搜（SearchTerm，见 getItems 的搜索分支）
  if (searchProviderId(query)) return true; // 按外部 id 搜索（见 getItems 的搜索分支）
  /* 推荐查询：**只有真的有行接它**才算"会出数据"（没行接 → 回空 → 也就不该校验账号） */
  return !!home.rowByFeed(feedOfQuery(query));
}

/**
 * 客户端在按**外部 id** 找一条吗？`AnyProviderIdEquals=tmdb.{数字}` → 回那个 tmdb id，否则回 0。
 *
 * **判据只此一处**：`getItems` 的搜索分支与 `itemsWillReturnData`（决定要不要校验账号）都用它，
 * 别各写一份正则（两处一旦漂移，就会出现"出数据却没校验"）。
 */
function searchProviderId(query) {
  const val = (k) => (query && typeof query.get === 'function' ? query.get(k) || '' : '');
  const m = /^tmdb\.(\d+)$/i.exec(val('AnyProviderIdEquals'));
  return m ? Number(m[1]) : 0;
}

/**
 * 客户端在**按名字搜条目**吗？`SearchTerm=斗破苍穹` → 回那个词，否则回 `''`。
 *
 * **为什么要有这条**（依据是日志）：SenPlayer 6.1.8 的搜索框打的是
 * `GET /Users/{id}/Items?...&IncludeItemTypes=Movie,Series,Video,Person&Recursive=true&SearchTerm=斗破苍穹`
 * —— 早期落到「没有可识别的查询参数 → 空」，于是搜索永远是空的（日志里连打 4 次 `Items=0`）。
 *
 * ⚠️ 真机（`emby.example.com`，实测）同一条 query 回 **7 条**（剧 + 电影混排），
 * 列表项只有 11 个字段（`Id/Name/Type/ImageTags/UserData/…`）—— 说明它就是"给搜索框列卡片"，
 * 不是详情。本实现的形状更全（超集不会出错，见指南「四」）。
 *
 * **判据只此一处**：`getItems` 的搜索分支与 `itemsWillReturnData`（决定要不要校验账号）都用它。
 */
function searchTermOf(query) {
  const val = (k) => (query && typeof query.get === 'function' ? query.get(k) || '' : '');
  return String(val('SearchTerm')).trim();
}

/** 搜索每类型默认取多少条（`Limit` 缺省时）与硬上限（防客户端要 999 条把上游打爆） */
const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 40;

/**
 * `IncludeItemTypes` → 要搜哪几种：`Series`→tv、`Movie`→movie；**两个都没给 = 都搜**。
 * （`Video` / `Person` 不认：分集搜索要按剧集层级走，人物不是本层的条目 —— 忽略，不假搜。）
 */
function searchTypesOf(include) {
  const s = String(include || '');
  const tv = /series/i.test(s);
  const movie = /\bmovie/i.test(s);
  if (!tv && !movie) return ['tv', 'movie'];
  return [tv ? 'tv' : null, movie ? 'movie' : null].filter(Boolean);
}

/**
 * TMDB **搜索结果行** → 一条 `BaseItemDto`（走 `leanItemDto`，与相似推荐同款）。
 *
 * ⚠️ **不为搜索结果再打 `lookup()`**（那会是"每类型 N 次上游"的线性账）：
 * 搜索行里已经给了名字 / 简介 / 海报 / 横图 / 年份 / 评分，`baseItem()` 需要的那几项都够；
 * 缺的（演职、分级、外部链接的 IMDb 号…）本来就是**详情页**才要的东西 ——
 * 客户端点进某一条时会打详情，那时才 `lookup({rich:true})`（同首页模块给的列表项一个路子）。
 * 真机的搜索项也只有 11 个字段，说明客户端对"搜索卡片"没有更多期待。
 */
function searchRowDto(row, type) {
  const date = String(row.release_date || row.first_air_date || '');
  return leanItemDto({
    type,
    tmdbId: row.id,
    parentId: defaultLibraryId(),
    title: row.name || row.title || '',
    year: date.slice(0, 4),
    overview: row.overview,
    communityRating: row.vote_average,
    posterPath: row.poster_path,
    backdropPath: row.backdrop_path,
    originalTitle: row.original_name || row.original_title,
  });
}

/**
 * 客户端有没有在问「要一些推荐」？—— 认得出就回 `'random'`，认不出回 `''`。
 *
 * **为什么需要这个**：有些客户端首页顶部那块**轮播图**不用库 Id —— 它发的是一条
 * 无 `ParentId` 的 `SortBy=IsFavoriteOrLiked,Random`（实测 Rex 首页第一发，比 `Views` 还早）。
 * 这类查询早期一律回空，于是轮播图没素材、整块不显示。
 *
 * 判据只有三条，都不猜：**没有 `ParentId` + 没有 `Filters` + `SortBy` 里含 `IsFavoriteOrLiked`**。
 * 认出来之后**路由到插件声明了 `feed: 'random'` 的那一行**（内容仍然是模块决定的）；
 * 没有插件声明 → 回空（不挑一行顶上）。
 *
 * ⚠️ 语义：这条 query 的原意是"用户收藏或喜欢的、随机"。本层**没有收藏数据**，
 * 所以只能按「随机推荐」理解 —— 给的是随机热门，**不是**用户的收藏（文档中不要写成收藏）。
 */
function feedOfQuery(query) {
  const val = (k) => (query && typeof query.get === 'function' ? query.get(k) || '' : '');
  if (home.parseViewId(val('ParentId'))) return ''; // 指名了库 → 走正常路
  if (val('Filters')) return ''; // 收藏/已播放有自己的一支，别抢
  return /isfavoriteorliked/i.test(val('SortBy')) ? 'random' : '';
}

/** 复制一份 query 并塞进 `ParentId`（不改原件：日志要打客户端**原样**发的参数） */
function withParentId(query, parentId) {
  const q = new URLSearchParams(query);
  q.set('ParentId', parentId);
  return q;
}

/**
 * GET /Shows/NextUp —— 「接下来看」
 *
 * 与 `Items/Resume` 同一族（都要观看历史），差别是它按**剧**回答：
 *   · 该剧最近看的那一集**没看完** → 回它自己（接着看）；
 *   · 已经看完 → 回**下一集**：同一季内找得到就回；找不到再试下一季第 1 集。
 *
 * 「下一集」一律要**在 TMDB 的季数据里真实存在**才回 —— 不存在就跳过这部剧，不编（ADR-0008）。
 *
 * 参数：`SeriesId` 可选（SenPlayer 实测会带，只问某一部剧）、`UserId` 在 query；
 * `MediaTypes` / `Recursive` / `Fields` 忽略，`Limit` 只用来截断条数。
 * **必须校验账号**（回的是某个账号的观看记录）。
 */
async function getNextUp(requestedId, req, query) {
  const denied = authorize(req, requestedId);
  if (denied) return denied;
  if (!accountIdFor(req, requestedId)) {
    return { status: 200, body: { Items: [], TotalRecordCount: 0 }, log: '账号认不出 → 空' };
  }
  const accountId = accountIdFor(req, requestedId);
  const wantSeries = String((query && typeof query.get === 'function' ? query.get('SeriesId') : '') || '').trim();
  const limit = limitOf(query, 20);
  let rows = db.listRecentBySeries(accountId);
  if (wantSeries) rows = rows.filter((r) => r.series_id === wantSeries);

  const items = [];
  let skipped = 0;
  for (const r of rows) {
    if (items.length >= limit) break;
    const it = await nextEpisodeItem(r, accountId);
    if (it) items.push(it);
    else skipped += 1;
  }
  return {
    status: 200,
    body: { Items: items, TotalRecordCount: items.length },
    log:
      `接下来看：库里 ${rows.length} 部在追 → 列出 ${items.length} 条` +
      (wantSeries ? `（只问 ${wantSeries}）` : '') +
      (skipped ? `（${skipped} 部算不出下一集，未列出）` : '') +
      briefIds(items),
  };
}

/**
 * 一部剧的"接下来看"：按 `getNextUp` 的口径算出该看哪一集，再交给 `progressItem` 组装
 * （这样带出来的是**那一集自己**的位置与已看状态，而不是"最近那条"的）。
 */
async function nextEpisodeItem(row, accountId) {
  const p = tmdb.parseItemId(row.item_id);
  if (!p || p.season === null || p.episode === null) return null;

  let season = p.season;
  let episode = p.episode;
  if (row.played) {
    /* 已看完 → 往后找**真实存在、且没被隐藏**的那一集：同一季里往后退；
     * 本季到头就试下一季第 1 集（只试一次，与原来的口径一致）；
     * **被隐藏的集跳过** —— 客户端"从继续观看里移除"的就是它在列表里点的那一条，
     * 移除之后该让位给下一集（真机实测：隐藏会让那条从「Resume」消失）。
     * 上限 50 次：源与 TMDB 对不上时别在这里空转，找不到就如实跳过这部剧（ADR-0008）。 */
    let cur = { season, episode: p.episode + 1 };
    let fellBack = false;
    let found = null;
    for (let i = 0; i < 50 && !found; i += 1) {
      if (!(await episodeExists(p.tmdbId, cur.season, cur.episode))) {
        if (fellBack) break; // 下一季第 1 集也不存在 → 放弃
        fellBack = true;
        cur = { season: p.season + 1, episode: 1 };
        continue;
      }
      const id = tmdb.itemId('tv', p.tmdbId, cur.season, cur.episode);
      if (Number((db.getPlayback(accountId, id) || {}).hidden) === 1) cur = { season: cur.season, episode: cur.episode + 1 };
      else found = cur;
    }
    if (!found) return null;
    season = found.season;
    episode = found.episode;
  }

  const nextId = tmdb.itemId('tv', p.tmdbId, season, episode);
  const next = db.getPlayback(accountId, nextId);
  if (next) return progressItem(next, accountId);
  /* 下一集还没看过 → 库里没有它的行。造一条**只用于组装、不写库**的临时行，
   * 其余字段沿用最近那条（`progressItem` 只用到 `item_id` 与坐标）。 */
  return progressItem(
    Object.assign({}, row, { item_id: nextId, position_ticks: 0, played: 0, season, episode }),
    accountId
  );
}

/** TMDB 的季数据里有没有这一集（`NextUp` 只回真实存在的下一集） */
async function episodeExists(tmdbId, season, episode) {
  const look = await tmdb.lookupSeason({ tmdbId, season });
  if (!look.ok) return false;
  return (look.item.episodes || []).some((e) => Number(e.episodeNumber) === Number(episode));
}

/**
 * `ItemCounts` 的 14 个字段（Emby 官方 schema，全是 int32）—— 一个都不能少：
 * 客户端常常直接读 `counts.MovieCount`，字段缺失拿到的是 `undefined`，而这个形状本身没有
 * "未知"这种取值，所以只能是数字。
 */
const ITEM_COUNT_FIELDS = [
  'MovieCount',
  'SeriesCount',
  'EpisodeCount',
  'GameCount',
  'ArtistCount',
  'ProgramCount',
  'GameSystemCount',
  'TrailerCount',
  'SongCount',
  'AlbumCount',
  'MusicVideoCount',
  'BoxSetCount',
  'BookCount',
  'ItemCount',
];

/**
 * GET /Items/Counts —— 全库各类条目的数量
 *
 * **回全 0**（口径是"如实回空"）。这里要说清一件事，免得日后误解：
 *
 *   **全 0 的意思是"数不出来"，不是"库是空的"。** 服务端没有片库索引（列表数据由首页插件
 *   在请求时现跑，见 `getStudios` 的同款说明），所以这个数**根本算不出来**。而 `ItemCounts`
 *   的形状里没有"未知"这个取值（14 个字段都是数字），只能填 0。
 *
 *   为什么不去凑：唯一的数据来源是各插件行返回的 `total`（如 `top_rated` 报 11216）—— 那是
 *   **TMDB 榜单的总数，不是本面板库里的数量**，拿它当"库里有 11216 部片"是**编数据**，比 0 更糟。
 *
 * 参数（`ParentId` 等）全忽略 —— 给哪个范围数都一样是 0。
 * **不校验账号**：回空没有数据可保护（同 `getResume` / `getStudios`）。
 */
function getItemCounts() {
  const body = {};
  for (const k of ITEM_COUNT_FIELDS) body[k] = 0;
  return { status: 200, body, log: '没有片库索引 → 全 0（如实：数不出来，不是库空）' };
}

/**
 * GET /Users/{UserId}/Items —— 条目列表
 *
 * **列表数据由首页模块决定，emby 层只做端点映射与 DTO 转换**（见
 * docs/emby-home-plugin.md）。分支共五条：
 *   - `SearchTerm=<词>` → **按名字搜**（TMDB 搜索；SenPlayer 的搜索框走这条）
 *   - `AnyProviderIdEquals=tmdb.{id}` → **按外部 id 搜一条**（回一条带本面板 Id 的条目，客户端接着进详情）
 *   - `ParentId=<catpawhome_…>`（本面板发给客户端的媒体库 Id，见 getViews）→ `home.listByQuery` 跑对应插件行
 *   - 无 `ParentId` 的「推荐」查询（`SortBy` 含 `IsFavoriteOrLiked`）→ 路由到插件声明了 `feed` 的行
 *   - `Filters=IsPlayed` → 读 `playback` 表（**已看的条目，真数据**）；`Filters=IsFavorite` → 仍如实回空
 *   - 其余查询（含认不出的 `AnyProviderIdEquals`）→ **如实回空**
 *
 * **分页是协议的事，但 emby 层不做切片**：客户端给的 `StartIndex` / `Limit` **原样透传给模块**
 * （进 `ctx.startIndex` / `ctx.limit`），取哪一页由**插件**决定；模块回来的 `total` 直接当
 * `TotalRecordCount`。`SortBy` / `Recursive` / `IncludeItemTypes` 忽略 —— 插件返回的顺序就是它想要的顺序。
 *
 * 插件行取数失败 → **照实回失败码**（与 TMDB 同一取向：不编占位数据、不回空的假成功）。
 */
async function getItems(requestedId, query) {
  const val = (key) => (query && typeof query.get === 'function' ? query.get(key) || '' : '');
  const empty = (log) => ({ status: 200, body: { Items: [], TotalRecordCount: 0 }, log });

  /* 用户级筛选：`IsPlayed` 现在**有真数据**（进度已落库）；`IsFavorite` 仍然没有
   * （收藏需要写端点，没做）—— 两者分开处理，别一起回空。 */
  const filters = val('Filters');
  if (/IsFavorite/i.test(filters)) return empty(`Filters=${filters}（没有收藏数据 → 空）`);
  if (/IsPlayed/i.test(filters)) {
    const acc = resolveAccountById(requestedId);
    if (!acc) return empty('Filters=IsPlayed（账号认不出 → 空）');
    const want = val('IncludeItemTypes');
    const rows = db.listPlayed(acc.id, limitOf(query, 50)).filter((r) => {
      if (!want) return true;
      const p = tmdb.parseItemId(r.item_id);
      if (!p) return false;
      return p.type === 'movie' ? /movie/i.test(want) : /episode|series/i.test(want);
    });
    return progressList(rows, acc.id, 'Filters=IsPlayed');
  }

  /* ---- 按名字搜：`SearchTerm=…`（见 `searchTermOf` 那段）----
   * SenPlayer 的搜索框打的就是这条；早期落到"没有可识别的查询参数 → 空"。 */
  if (searchTermOf(query)) return getSearchItems(requestedId, query);

  /* ---- 搜索/定位：`AnyProviderIdEquals=tmdb.{id}` —— 按**外部 id** 找那一条 ----
   *
   * 链路：客户端手里只有一个 tmdb 号（外部链接 / 书签 / 它自己记着的），**拼不出本面板的 Id**，
   * 于是来问一句"这条在本面板的 Id 是多少"；这里回**一条带 Id 的条目**（`tmdb_{id}_{movie|tv}`），
   * 它拿到就接着打详情 → 详情那条同样是"按 tmdb 坐标反查"，两条路同源。
   *
   * ⚠️ 该分支曾以「列表数据由首页模块决定」为由**删掉过**，后来又**恢复**：
   *   · 模块管的是**首页渲染**（给客户端什么样的行列、每个条目的 Id），
   *     **详情 / 搜索 / 播放本来就归 emby 层** —— 这是既定的分层；
   *   · 而且**详情端点在删它之后一直还在做同一件事**（`tmdbItemDto()` 按坐标反查），
   *     删检索这条只会让两条路不自洽；
   *   · 当时删它的依据是"实测客户端 0 次使用"—— **已被 Rex/0.1.0 推翻**
   *     （它连打两条 `AnyProviderIdEquals=tmdb.1339713`，回空之后就拿不到 Id、链路断在那里）。
   *   结论同 `Items/Latest`：某条查询"没人要"只对**当时那批客户端**成立。
   *
   * 类型从 `IncludeItemTypes` 推（`Series`→tv / `Movie`→movie；都没给 → tv，照旧例）；
   * 取不到 → **照实回失败码**（`tmdbFailure`，不编占位条目）。
   */
  const searchId = searchProviderId(query);
  if (searchId) {
    const include = val('IncludeItemTypes');
    const type = /series/i.test(include) ? 'tv' : /movie/i.test(include) ? 'movie' : 'tv';
    const look = await tmdb.lookup({ type, tmdbId: searchId });
    if (!look.ok) return tmdbFailure(look.error, `${type}/${searchId}`);
    const item = leanItemDto(Object.assign({}, look.item, { type, parentId: defaultLibraryId() }));
    return {
      status: 200,
      body: { Items: [item], TotalRecordCount: 1 },
      log: `AnyProviderIdEquals=tmdb.${searchId} → ${type}「${item.Name}」id=${item.Id}（搜索结果，可进详情）`,
    };
  }

  const vid = home.parseViewId(val('ParentId'));

  /* 客户端"不要库 Id、只要推荐"的查询（见 `feedOfQuery`）→ 路由到插件声明了对应 `feed` 的那一行。
   * **没有插件声明就什么都不做**，后面照常回空。 */
  const feed = feedOfQuery(query);
  const feedRow = feed ? home.rowByFeed(feed) : null;
  const effQuery = feedRow ? withParentId(query, home.viewId(feedRow.pluginId, feedRow.rowId)) : query;
  if (feedRow) {
    console.log(`  ↪ emby 推荐行：「${feed}」查询（无 ParentId）→ ${feedRow.pluginId}/${feedRow.rowId}（由插件声明 feed 决定，非写死）`);
  }
  const effVid = feedRow ? home.parseViewId(effQuery.get('ParentId')) : vid;

  /* ⚠️ **只在"真的会返回数据"这条路上校验账号**。
   * 回空的分支没数据可保护，校验只会有坏处 —— 不带 token 的客户端白吃一个 401。
   * 判据收敛在 `itemsWillReturnData()` 一处，路由层用的是同一个函数，不会漂移。 */
  if (itemsWillReturnData(query)) {
    const denied = assertUser(requestedId);
    if (denied) return denied;
  }

  /* 列表数据交给首页模块：它只认自己发出去的库 Id（`catpawhome_…`），其余回 null = 不归它管。
   * **分页也一起透传**（`StartIndex`/`Limit` 进 `ctx`）—— emby 层**不切片**：
   * 取哪一页是模块的决定，这里只把结果翻译成 Emby 形状。 */
  let got = null;
  try {
    got = await home.listByQuery(effQuery);
  } catch (e) {
    /* 日志里报**解码后的**「插件/行」，别报 `catpawhome_ZXhh…` 那串 —— 排查时没人愿意手解 base64 */
    return homeFailure(e, effVid ? `${effVid.pluginId}/${effVid.rowId}` : val('ParentId'));
  }
  if (!got) {
    const provider = val('AnyProviderIdEquals');
    return empty(
      provider
        ? `AnyProviderIdEquals=${provider} → 空（只认 tmdb.{数字}；列表本身由首页模块决定）`
        : '没有可识别的查询参数 → 空'
    );
  }

  return {
    status: 200,
    /* 每个条目的 `ParentId` = **它自己那个库**（这里是准确值，不是 defaultLibraryId 的兜底） */
    body: { Items: (got.items || []).map((it) => homeItemDto(it, home.viewId(got.pluginId, got.rowId))), TotalRecordCount: got.total },
    log:
      `${got.pluginId}/${got.rowId} 库内容 → 本页 ${(got.items || []).length} 条 / 共 ${got.total}` +
      `（StartIndex=${val('StartIndex') || 0} Limit=${val('Limit') || '不限'}，模块透传不切片）` +
      (got.cached ? ' 缓存' : ''),
  };
}

/** `Items/Latest` 不带 `Limit` 时的条数 —— 真机实测就是 20 */
const LATEST_DEFAULT_LIMIT = 20;

/**
 * `Items?SearchTerm=…` —— **按名字搜**（依据见 `searchTermOf`）。
 *
 * 数据来源：TMDB `search/tv` 与 `search/movie`（**归 emby 层** —— 与详情同类：
 * 它是"按坐标/名字去 TMDB 反查"，不是"这台服务器上有什么"，所以不走首页模块）。
 *
 * 三条口径，都不猜：
 *   ① **不为结果再打 `lookup()`**：搜索行里的字段够画卡片，详情才需要 rich（见 `searchRowDto`）。
 *      代价是**每类型 1 次上游**（`Limit` 由 TMDB 自己的分页决定），不是"结果数 × 1 次"。
 *   ② **只取上游第 1 页**（每类型 20 条）：翻页要再打上游，而客户端的搜索框极少翻到第 2 页；
 *      `StartIndex`/`Limit` 在这**一堆结果里切片**，`TotalRecordCount` 如实 = 本地手里的条数
 *      （**不是"TMDB 里有多少条"** —— 那个数本层不知道，不能编）。
 *   ③ **跨类型怎么排 = 按名次轮流**（tv#1, movie#1, tv#2, movie#2…）：TMDB 的 tv / movie 是两份
 *      **独立的相关度排序**，谁也不能替谁排序 —— 轮流合并让两份次序都原样保留，不引入跨类型的人造指标。
 *      ⚠️ 曾经按行的 `popularity` 降序合并，**实测是错的**：搜「斗破苍穹」时它把一个叫 `111` 的剧
 *      （TMDB 相关度很低、但 popularity 数字不小）顶到了第 7 位，把真正相关的电影挤下去。
 *
 * 取不到 → **照实回失败码**（与详情/相似同一取向，不编占位条目）：
 * 一个类型失败、另一个有结果时，回有结果的那部分并在日志里写明（部分失败 ≠ 整条失败）。
 */
async function getSearchItems(requestedId, query) {
  const val = (k) => (query && typeof query.get === 'function' ? query.get(k) || '' : '');
  const term = searchTermOf(query);

  /* 真会出数据 ⇒ 校验账号（与 `itemsWillReturnData()` 同口径，那条判据已包含 SearchTerm） */
  const denied = assertUser(requestedId);
  if (denied) return denied;

  const types = searchTypesOf(val('IncludeItemTypes'));
  const limit = Math.min(Math.max(1, Number(val('Limit')) || SEARCH_DEFAULT_LIMIT), SEARCH_MAX_LIMIT);
  const startIndex = Math.max(0, Number(val('StartIndex')) || 0);

  const settled = await Promise.allSettled(types.map((t) => tmdbCore.search(t, term)));
  const failures = [];
  const buckets = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      buckets.push(((r.value || []).map((row) => ({ row, type: types[i] }))));
    } else {
      failures.push({ type: types[i], error: r.reason });
    }
  });

  /* 全失败 → 照实回失败码（一个字都不编） */
  if (failures.length === types.length) return tmdbFailure(failures[0].error, `search/${types.join('+')}`);

  /* 客户端有没有把搜索限制在某个库？（真机会按媒体库过滤）
   * 本层**做不到**：库是插件行**请求时现跑**的，没有"成员索引"可查 ⇒ 一律全局搜，
   * 但**在日志里写明**，免得以后有人以为搜出来的结果被库限制过。 */
  const scopedTo = home.parseViewId(val('ParentId')) ? '（带了库 ParentId，但库没有成员索引 → 全局搜）' : '';

  /* 按名次轮流合并（见本函数注释 ③）：每份列表保持 TMDB 给的相关度次序 */
  const rows = [];
  for (let rank = 0; ; rank++) {
    let added = false;
    for (const b of buckets) {
      if (rank < b.length) {
        rows.push(b[rank]);
        added = true;
      }
    }
    if (!added) break;
  }
  const page = rows.slice(startIndex, startIndex + limit);
  const warn = failures.length ? `；${failures.map((f) => f.type + ' 失败(' + (f.error && f.error.code) + ')').join('、')}` : '';

  return {
    status: 200,
    body: { Items: page.map((x) => searchRowDto(x.row, x.type)), TotalRecordCount: rows.length },
    log:
      `搜索「${term}」→ ${rows.length} 条（${types.join('/')}，各取上游第 1 页）` +
      `本页 ${page.length} 条（StartIndex=${startIndex} Limit=${limit}）${warn}${scopedTo}`,
  };
}

/**
 * GET /Users/{UserId}/Items/Latest —— 「最新条目」（客户端首页那几排横向行）
 *
 * **为什么要有这条**：VidHub 3.0.6 的**整个首页**都靠它 —— 拿到 `Views` 之后
 * 逐个库打 `Items/Latest?ParentId=<库Id>`（实测 10 个库 = 10 次）。早期这条会被
 * `Users/:userId/Items/:itemId` 当成"一个 Id 叫 Latest 的条目"吞掉 → 501 → VidHub 首页空白。
 * （`Items/Resume` 曾因同样的路由顺序被吞掉，所以路由必须注册在详情那条**之前**。）
 *
 * 协议的三个要点**按真机实测**定，不猜：
 *   ① **回的是裸数组**，不是 `QueryResult`（真机响应直接以 `[` 开头）；
 *   ② **默认 20 条**（不带 `Limit` 时）；
 *   ③ `StartIndex` 有效（`Limit=2&StartIndex=3` 真的跳过了前 3 条）。
 *
 * **内容是模块决定的**：emby 层**不排序、不筛"入库时间"** ——
 * 真机那边"最新"= 文件入库时间，本层根本没有这个量（没有片库、没有文件）。
 * 插件这一行返回的顺序**就是它认为的"最新"**。所以这里只做三件事：
 * 透传 `ParentId`/`StartIndex`/`Limit` → 翻成 Emby 条目形状 → 把数组原样回出去。
 *
 * `ParentId` 不是本面板的库（含不带 `ParentId`）→ **回空数组**（如实）：
 * 真机那条会跨所有库给结果，它靠的是自己的片库索引；这里没有索引，
 * 要凑就得把每一行都跑一遍（10 次上游），那是拿代价换一个答不准的答案。
 */
async function getLatest(requestedId, query) {
  const val = (k) => (query && typeof query.get === 'function' ? query.get(k) || '' : '');
  const vid = home.parseViewId(val('ParentId'));

  /* 与 `Items` 同一条口径：只在"真会出数据"的路上校验账号（判据共用一个函数，别各写一份） */
  if (itemsWillReturnData(query)) {
    const denied = assertUser(requestedId);
    if (denied) return denied;
  }

  if (!vid) return { status: 200, body: [], log: 'ParentId 不属于本面板的库 → 空数组（如实）' };

  /* 把协议的默认值**落实成实际参数**再交给模块：`Limit` 缺省补 20（真机默认），
   * `StartIndex` 缺失当 0。复制一份 query 而不是改原件 —— 日志要打客户端**原样**发的参数。 */
  const startIndex = Math.max(0, Number(val('StartIndex')) || 0);
  const limit = Math.max(1, Number(val('Limit')) || LATEST_DEFAULT_LIMIT);
  const effective = new URLSearchParams(query);
  effective.set('StartIndex', String(startIndex));
  effective.set('Limit', String(limit));

  let got = null;
  try {
    got = await home.listByQuery(effective);
  } catch (e) {
    return homeFailure(e, `${vid.pluginId}/${vid.rowId}`);
  }
  if (!got) return { status: 200, body: [], log: '没有可识别的查询参数 → 空数组' };

  const items = (got.items || []).map((it) => homeItemDto(it, home.viewId(got.pluginId, got.rowId)));
  return {
    status: 200,
    /* 裸数组 —— 这条端点的协议形状就是这样，别套 `{Items,…}`（真机实测以 `[` 开头） */
    body: items,
    log:
      `${got.pluginId}/${got.rowId} 最新 → ${items.length} 条` +
      `（StartIndex=${startIndex} Limit=${limit}，顺序由模块决定）` +
      (got.cached ? ' 缓存' : ''),
  };
}

/**
 * 首页插件条目（HomeItem）→ Emby `BaseItemDto`。
 *
 * - **Id 原样带过去**：插件规范**建议**它就是 `tmdb_{id}_{tv|movie}` —— 客户端点这一条时会去打
 *   `/Users/{id}/Items/{这个Id}`，那条走 **TMDB 反查 + 聚合资源**（见指南「五」）。
 *   插件自己编的 Id 照样显示，只是点进去没有资源（模块自己的事，这边不兜底）。
 * - **图片**：插件的 `poster` / `backdrop` 是**完整 URL**，直接编成签名 tag 交给客户端
 *   （见 `imageTag`）。插件没给就不给 `ImageTags`（不承诺）。
 * - `IsFolder`：剧是容器（能进季集）→ true；电影不是 → false。
 *   `baseItem()` 默认给 true，电影必须显式改掉，否则客户端可能当目录去浏览而不是打开详情。
 */
function homeItemDto(it, parentId) {
  const item = baseItem({
    id: it.id,
    /* **父级 = 这个条目所在的那个媒体库**（列表项走的是"它自己那个库"，准确）——
     * 见 defaultLibraryId 上面那段说明：真实 Emby 每条 item 都有 ParentId，
     * 客户端靠它把条目录到某个媒体库下。 */
    parentId,
    name: it.title,
    type: it.type === 'movie' ? 'Movie' : 'Series',
    year: it.year,
    overview: it.overview,
    communityRating: it.rating,
    providerIds: it.providerIds,
    posterUrl: it.poster,
    backdropUrl: it.backdrop,
  });
  item.IsFolder = it.type === 'tv';
  if (it.originalTitle !== undefined) item.OriginalTitle = it.originalTitle;
  if (it.genres !== undefined) item.Genres = it.genres;

  /* 外部链接：真机**列表项**就有（IMDb / TheMovieDb / Trakt）。本地只有插件的
   * `providerIds.Tmdb`（列表接口不给 `imdb_id`），所以**只给能从 id 推出来的那条**：
   * TheMovieDb。**IMDb 不编** —— 不知道 tt 号就是不知道；**Trakt 不给** —— 那个格式已失效（见 `applyRich`）。 */
  const tmdbId = it.providerIds && it.providerIds.Tmdb;
  if (tmdbId) {
    item.ExternalUrls = [
      { Name: 'TheMovieDb', Url: `https://www.themoviedb.org/${it.type === 'movie' ? 'movie' : 'tv'}/${tmdbId}` },
    ];
  }
  return item;
}

/**
 * 「这个条目属于哪个媒体库」—— **只能给一个兜底值**。
 *
 * 真实 Emby 里每条 item 都有 `ParentId`（它所在的媒体库），客户端会靠它把条目录到某个媒体库下。
 * 这里没有精确答案：**同一部片可以同时出现在多个库里**（`trending` 和 `top_rated` 都有），
 * 而详情请求 `Items/{id}` 里**不带库上下文**（实测 SenPlayer 连 query 都不带）。
 *
 * 所以取第一个**启用**的行当作它的库 —— 至少是一个客户端认识的、有效的库 Id。
 * 列表项不走这里：它们有**准确**的库（`getItems` 直接用它自己那个库 Id）。
 *
 * ⚠️ 这是 best-effort，不是"事实"。客户端若要精确的归属，得由请求带上库上下文。
 */
function defaultLibraryId() {
  try {
    const rows = home.enabledRows();
    const r = rows && rows[0];
    return r ? home.viewId(r.pluginId, r.rowId) : '';
  } catch {
    return '';
  }
}

/** 首页模块取数失败 → 照实回失败（与 tmdbFailure 同一取向；状态码归类共用 tmdb.httpStatusOf） */
function homeFailure(error, what) {
  const status = tmdb.httpStatusOf(error);
  return {
    status,
    body: { error: error.message, code: error.code, home: what },
    log: `首页模块「${what}」取数失败（${error.code}）→ HTTP ${status}`,
  };
}

/** TMDB 失败 → 照实回失败（状态码与上游一致；网络层由 tmdb.httpStatusOf 归类） */
function tmdbFailure(error, what) {
  const status = tmdb.httpStatusOf(error);
  return {
    status,
    body: { error: error.message, code: error.code, tmdb: what },
    log: `tmdb ${what} 取不到（${error.code}）→ HTTP ${status}`,
  };
}

/**
 * GET /Shows/{Id}/Seasons —— 剧的季列表（Rex-Standard 实测端点：`Id` 在路径、`UserId` 在 query）
 *
 * 只认剧的 Id（`tmdb_95350_tv`），季条目 Id 为 `tmdb_95350_tv_s{n}`（与 itemId/parseItemId 互逆）。
 * 季数据来自同一个 TMDB 接口（`/tv/{id}` 的响应里本来就有 seasons[]），不额外多打一次。
 *
 * 特别篇（`season_number === 0`）**本轮不返回** —— 注意 TMDB 的季 `name` 是本地化文案
 * （zh-CN 下特别篇叫「特别篇」），所以判定只看 season_number，绝不能匹配名字。见指南「七」的待定条。
 *
 * TMDB 取不到 → 照实回失败（与 Items 同一取向，不编占位季）。
 */
async function getSeasons(showId, requestedId) {
  const denied = assertUser(requestedId);
  if (denied) return denied;

  const parsed = tmdb.parseItemId(showId);
  if (!parsed || parsed.type !== 'tv' || parsed.season !== null) {
    return { status: 404, body: { error: '没有这个剧' }, log: `Id 不是剧 → 404：${showId}` };
  }
  const tmdbId = parsed.tmdbId;
  const showKey = tmdb.itemId('tv', tmdbId);

  const look = await tmdb.lookup({ type: 'tv', tmdbId, withSeasons: true });
  if (!look.ok) return tmdbFailure(look.error, `tv/${tmdbId}`);

  const show = look.item;
  const items = (show.seasons || [])
    .filter((s) => Number.isFinite(s.seasonNumber) && s.seasonNumber > 0)
    .map((s) => {
      const item = baseItem({
        id: tmdb.itemId('tv', tmdbId, s.seasonNumber),
        name: s.name || `第 ${s.seasonNumber} 季`,
        type: 'Season',
        year: s.year,
        premiereDate: s.premiereDate,
        overview: s.overview,
        communityRating: s.rating,
        providerIds: { Tmdb: String(tmdbId) },
        posterUrl: tmdb.imageUrlOf('w500', s.posterPath || show.posterPath), // 季海报缺失时退回剧海报，免得客户端出白块
      });
      item.Genres = []; // TMDB 的季没有 genres，空是如实，不套剧的
      item.ChildCount = s.episodeCount;
      item.IndexNumber = s.seasonNumber;
      item.SeriesId = showKey;
      item.SeriesName = show.title || '';
      return item;
    });

  const gap = items.length !== show.seasonCount ? ` tmdb 报 ${show.seasonCount} 季` : '';
  return {
    status: 200,
    body: { Items: items, TotalRecordCount: items.length },
    log: `id=${showId} → ${items.length} 季${show.title ? `（TMDB「${show.title}」）` : ''}${gap}`,
  };
}

/**
 * GET /Shows/{Id}/Episodes —— 某一季的分集列表（Rex-Standard 实测端点）
 *
 * 入参形态（实测）：路径 `Id` 是剧 Id（`tmdb_95350_tv`），`UserId` 与 `SeasonId` 都在 query，
 * 另有 `EnableTotalRecordCount` / 一长串 `Fields`（忽略 —— 只回手里有的）。
 *
 * 季必须能唯一确定：`SeasonId` 取自上一步 Seasons 发出去的季 Id（`tmdb_{id}_tv_s{n}`），
 * 且 tmdbId 要与路径里的剧一致。定不下来就**回空 + 日志写明原因** —— 与 Items 同类处理：
 * 先把客户端的真实调用逼出来，不为没见过的形态现编数据。
 *
 * 分集 Id = `tmdb_{id}_tv_s{n}_e{m}`（与 itemId/parseItemId 互逆）。
 * 分集数据必须走 season 接口（剧接口只有 seasons[] 汇总，没有 episodes[]），见 tmdb.lookupSeason。
 */
async function getEpisodes(showId, requestedId, seasonId) {
  const denied = assertUser(requestedId);
  if (denied) return denied;

  const show = tmdb.parseItemId(showId);
  /* ⚠️ **路径里给「季 Id」也算数**（真机实测容错）：
   * 官方文档写的是 `Shows/{Id}/Episodes` 里 Id = **剧**，但真机（`emby.example.com`）实测
   * `Shows/{季Id}/Episodes?SeasonId={季Id}` **同样回 200**（212 条，与剧 Id 那条一模一样）——
   * 而 Lumenic/1.0.0 打的就是这种（面板日志里 3 次 `Id 不是剧 → 404：tmdb_79481_tv_s5`）。
   * 季 Id 里本来就带着剧号与季号，信息不缺，没有理由拒。 */
  if (!show || show.type !== 'tv' || show.episode !== null) {
    return { status: 404, body: { error: '没有这个剧' }, log: `Id 不是剧 → 404：${showId}` };
  }
  const pathSeason = show.season; // 路径给的是季 → 剧号与季号都从它来

  const empty = (log) => ({ status: 200, body: { Items: [], TotalRecordCount: 0 }, log });
  const season = tmdb.parseItemId(seasonId);

  let n = null;
  let seasonNote = '';
  if (pathSeason !== null) {
    n = pathSeason;
    /* 路径与 query 都给了季、且两边不一致时**以路径为准**（它就在请求路径上，更具体）——
     * 不一致这件事本身值得记一笔：说明客户端与本层的 Id 认知可能已经漂了。 */
    if (season && season.season !== null && season.tmdbId === show.tmdbId && season.season !== pathSeason) {
      seasonNote = `（路径季 S${pathSeason} 与 SeasonId 的 S${season.season} 不一致，以路径为准）`;
    }
  } else {
    if (!season || season.season === null) {
      return empty(seasonId ? `SeasonId 认不出 → 空：${seasonId}` : '没有 SeasonId → 空');
    }
    if (season.tmdbId !== show.tmdbId) return empty(`SeasonId 不是这个剧的季 → 空：${seasonId}`);
    n = season.season;
  }
  const look = await tmdb.lookupSeason({ tmdbId: show.tmdbId, season: n });
  if (!look.ok) return tmdbFailure(look.error, `tv/${show.tmdbId} S${n}`);

  const showKey = tmdb.itemId('tv', show.tmdbId);
  const seasonKey = tmdb.itemId('tv', show.tmdbId, n);
  const seasonName = look.item.name || `第 ${n} 季`;

  /* 不填 SeriesName：那要再打一次剧接口，而客户端是在剧/季页里发的这条请求，本来就知道剧名 */
  const items = (look.item.episodes || [])
    .filter((e) => Number.isFinite(e.episodeNumber))
    .map((e) => {
      const item = baseItem({
        id: tmdb.itemId('tv', show.tmdbId, n, e.episodeNumber),
        name: e.name || `第 ${e.episodeNumber} 集`,
        type: 'Episode',
        year: e.year,
        premiereDate: e.premiereDate,
        overview: e.overview,
        communityRating: e.rating,
        providerIds: { Tmdb: String(show.tmdbId) },
        posterUrl: tmdb.imageUrlOf('w300', e.stillPath), // 集的 Primary 图是剧照（still_path），不是海报
      });
      item.IsFolder = false; // 集不是容器（baseItem 默认 true，这里必须改掉）
      item.IndexNumber = e.episodeNumber;
      item.ParentIndexNumber = n;
      item.SeriesId = showKey;
      item.SeasonId = seasonKey;
      item.SeasonName = seasonName;
      if (e.runtimeMinutes) item.RunTimeTicks = e.runtimeMinutes * 600000000; // 1 分钟 = 6×10⁸ ticks
      if (e.stillPath) item.PrimaryImageAspectRatio = 1.7777778; // 剧照是 16:9；baseItem 给的是海报比例，这里改回来
      return item;
    });

  return {
    status: 200,
    body: { Items: items, TotalRecordCount: items.length },
    log:
      `id=${showId} ${seasonKey} → ${items.length} 集（${seasonName}）` +
      (pathSeason !== null ? '（路径给的是季 Id —— 真机也接受这种打法）' : '') +
      seasonNote,
  };
}

/**
 * TMDB 的 `status` → Emby 的剧状态。**Emby 只认 `Continuing` / `Ended` 两个值**，
 * 别的写法客户端会当成未知（等于白给）。电影没有这个概念 → 回空、不挂这个字段。
 */
function statusOf(s) {
  const v = String(s || '');
  if (/Returning Series|In Production|Planned|Pilot/i.test(v)) return 'Continuing';
  if (/Ended|Canceled|Cancelled/i.test(v)) return 'Ended';
  return '';
}

/**
 * 把 `lookup({rich:true})` 那一批铺到详情 DTO 上 —— **详情页"丰富度"就在这里**。
 *
 * 全部来自**同一次** TMDB 请求的 append 结果（不额外打上游）。每项都是「有才给、没有就不挂」：
 * 编不出真值的东西一律留空，宁可页面上少一块，也不给假数据。
 *
 * 刻意**没做**的几项（都写了理由，免得以后反复琢磨）：
 *   · `OriginalLanguage`：TMDB 给 2 位码（`en`）、Emby 要 3 位码（`eng`），映射表容易错，而客户端基本不显示。
 *   · `CriticRating`（媒体评分）：TMDB 没有这个数据（它的 vote 是用户评分）。
 *   · 演员头像：要再开一个「人物图片」端点（`Items/{personId}/Images/Primary`），人物不是本层的条目 —— 先不碰。
 *   · `ScreenshotImageTags`：TMDB 没有"截图"这个独立类别，它那些就是背景图，给了等于重复。
 *   · 合集（Boxset）：Emby 里是另一类条目，要单独建，不是塞个字段就行。
 */
function applyRich(item, got) {
  if (got.overview) item.Overview = got.overview; // rich 的简介更长，覆盖列表用的短版
  if (got.certification) item.OfficialRating = got.certification; // PG-13 / TV-MA 那个徽章
  if (got.runtimeMinutes > 0) item.RunTimeTicks = got.runtimeMinutes * 600000000; // 1 分钟 = 6e8 ticks
  if (got.tagline) item.Taglines = [got.tagline];
  /* 制片公司：**必须带 `Id`**（真机是 `NameLongIdPair`，Id 是**数字**）。
   * 实测：SenPlayer 曾打不开本层的详情，而换成真机响应（Studios 带 Id）就正常 ——
   * 客户端模型里缺这个键会让**整个响应解码失败**。 */
  if (got.productionCompanies && got.productionCompanies.length) {
    /* 按 Id 去重：TMDB 的 `production_companies` 会**重复**（实测同一部片里同一个公司出现两次），
     * 真机的 `Studios[]` 不会重复。 */
    const seenStudio = new Set();
    item.Studios = got.productionCompanies
      .map((c) => ({ Id: Number(c.id) || 0, Name: c.name }))
      .filter((c) => (seenStudio.has(c.Id) ? false : seenStudio.add(c.Id)));
  }
  if (got.productionCountries && got.productionCountries.length) item.ProductionLocations = got.productionCountries;
  if (got.keywords && got.keywords.length) item.Tags = got.keywords;
  /* 类型带 id：客户端点"动作"能跳该类型列表。⚠️ 那个端点还没实现（会 501）——
   * 这正是"先给承诺、看客户端要什么"的用法（`ImageTags` 早期就是这样把图片端点逼出来的）。
   * Id 用**数字**（真机 `{"Id":65,"Name":"剧情"}` 就是数字；早期给的是字符串，类型对不上解码器）。 */
  if (got.genreItems && got.genreItems.length) item.GenreItems = got.genreItems.map((g) => ({ Id: Number(g.id) || 0, Name: g.name }));

  /* 演职人员：演员给 `Role`（角色名），导演/编剧翻成 Emby 的 `Type`。
   *
   * `Id` **必须给**：曾经刻意不给（"人物不是本层的条目，给了 Id 客户端就会去点、
   * 去要人物图片"），但真机**每条都带 Id**，缺它会让客户端的解码器**整条响应失败** ——
   * 代价远大于收益。Id 用 TMDB 的人物 id（是**真 id**，不是编的）。
   *
   * **顺带把人物头像也做通**：有 `profile_path` 的就给
   * `PrimaryImageTag`，走的还是**已有的图片端点** —— `tagAndRemember` 会把
   * 「人物id|Primary|0 → 图床地址」记进索引，客户端带不带 tag 都取得到（见 routes.js 的图片端点）。
   * 没有头像的（`profile_path` 为空）就**不给** `PrimaryImageTag`，客户端因此不会去要（不承诺）。 */
  const people = [];
  const pushPerson = (p, extra) => {
    const one = Object.assign({ Name: p.name }, extra);
    if (p.tmdbPersonId) {
      one.Id = String(p.tmdbPersonId);
      const avatar = p.profilePath ? tagAndRemember(one.Id, 'Primary', 0, tmdb.imageUrlOf('w185', p.profilePath)) : '';
      if (avatar) one.PrimaryImageTag = avatar;
    }
    people.push(one);
  };
  for (const p of got.cast || []) pushPerson(p, { Role: p.role, Type: 'Actor' });
  for (const p of got.crew || []) pushPerson(p, { Type: p.job === 'Director' ? 'Director' : 'Writer' });
  if (people.length) item.People = people;

  const st = statusOf(got.status);
  if (st) item.Status = st;

  /* 外部链接：**名字与顺序照真机**（实测：电影 IMDb → TheMovieDb → [Trakt]、剧 IMDb → TheMovieDb
   * → TheTVDB → [Trakt]）。客户端有可能会按名字认这几个链接，所以名字不自创。
   * 每一条的来源：IMDb/TheTVDB ← TMDB 的 `external_ids`；TheMovieDb ← tmdb id 本身。
   *
   * ⚠️ **Trakt 刻意不给**（实测后去掉）：真机给的是
   * `https://trakt.tv/search/tmdb/{id}?id_type=movie|show`，而 **Trakt 已经下架了这条深链** ——
   * 影、剧、IMDb 三种形状实测**全部 404**（`404: Nothingness. The void.`），
   * 同站有效路由（`/shows/breaking-bad`）却正常 200 ⇒ 是路由被删，不是被墙/UA。
   * Trakt 的条目页要用**它自己的 id/slug**，本地手上只有 tmdb/imdb 号，**造不出能用的直链**——
   * 那就**不给**：发一条必 404 的死链比不发更糟（同"不知道就空字段"的口径）。
   * 哪天 Trakt 又支持了、或者能拿到它的 id，再加回来。 */
  const urls = [];
  const isMovie = got.mediaType === 'movie';
  if (got.externalIds && got.externalIds.imdb) {
    urls.push({ Name: 'IMDb', Url: `https://www.imdb.com/title/${got.externalIds.imdb}` });
  }
  if (got.tmdbId) {
    urls.push({ Name: 'TheMovieDb', Url: `https://www.themoviedb.org/${isMovie ? 'movie' : 'tv'}/${got.tmdbId}` });
  }
  if (!isMovie && got.externalIds && got.externalIds.tvdb) {
    urls.push({ Name: 'TheTVDB', Url: `https://thetvdb.com/?tab=series&id=${got.externalIds.tvdb}` });
  }
  if (got.homepage) urls.push({ Name: '官网', Url: got.homepage });
  if (urls.length) item.ExternalUrls = urls;

  if (got.trailers && got.trailers.length) {
    item.RemoteTrailers = got.trailers.map((t) => ({ Name: t.name, Url: t.url }));
    item.TrailerCount = got.trailers.length;
  }
}

/**
 * 一条「列表项形状」的 BaseItemDto（**轻量**：元数据 + 图片，不带 rich）。
 *
 * 三处用它，形状必须一致（客户端都靠 `Id` 点进详情）：
 *   · `Items/{id}/Similar` 的相似推荐条目；
 *   · `Items?AnyProviderIdEquals=tmdb.{id}` 搜到的那一条（见 `getItems` 的搜索分支）；
 *   · 首页模块给的列表项走 `homeItemDto()`（同样形状，只是数据来自插件）。
 */
function leanItemDto(r) {
  const item = baseItem({
    id: tmdb.itemId(r.type, r.tmdbId),
    /* 搜索命中的那一条没有库上下文 → 由调用方给兜底库（`defaultLibraryId()`）；相似推荐不给 */
    parentId: r.parentId,
    name: r.title,
    type: r.type === 'movie' ? 'Movie' : 'Series',
    year: r.year,
    overview: r.overview,
    communityRating: r.communityRating,
    providerIds: { Tmdb: String(r.tmdbId) },
    posterUrl: tmdb.imageUrlOf('w500', r.posterPath),
    backdropUrl: tmdb.imageUrlOf('w780', r.backdropPath),
  });
  item.IsFolder = r.type === 'tv';
  /* 有就带上（相似推荐那份没有这几个键 → 不填，输出与以前一致） */
  if (r.originalTitle !== undefined) item.OriginalTitle = r.originalTitle;
  if (r.genres !== undefined) item.Genres = r.genres;
  if (r.seasonCount !== undefined) item.ChildCount = r.seasonCount;
  return item;
}

/**
 * 按 tmdb 坐标组装一条「剧 / 影」的 BaseItemDto —— **详情（`Items/{Id}`）用**。
 *
 * 为什么单独放一份：客户端点进某一条时打的是 `/Users/{Id}/Items/{ItemId}`，那条**必须**能按 tmdb
 * 坐标把元数据反查回来（否则点进去就是 404）。这就是「点击条目 → TMDB 反查显示资源」里的"反查"那一环。
 *
 * ⚠️ 它比 `leanItemDto()` **重**（`rich: true`，一次带回分级/时长/演职/图集/相似）—— **只在详情用**；
 * 搜索/相似那些「列表项」用 `leanItemDto()`，别拿这个去凑数。
 *
 * `rich: true` —— 详情页要的那一批（分级/时长/标语/演职/公司/关键词/预告/图集/相似）**一次拿回**。
 */
async function tmdbItemDto(type, tmdbId) {
  const look = await tmdb.lookup({ type, tmdbId, rich: true });
  if (!look.ok) return { ok: false, error: look.error };

  const got = look.item;
  const item = baseItem({
    id: tmdb.itemId(type, tmdbId),
    /* 详情/相似没有库上下文 → 用兜底库（见 defaultLibraryId）。列表项另有准确值。 */
    parentId: defaultLibraryId(),
    name: got.title,
    type: type === 'movie' ? 'Movie' : 'Series',
    year: got.year,
    premiereDate: got.premiereDate,
    overview: got.overview,
    communityRating: got.communityRating,
    providerIds: { Tmdb: String(tmdbId) },
    posterUrl: tmdb.imageUrlOf('w500', got.posterPath),
    backdropUrl: tmdb.imageUrlOf('w780', got.backdropPath),
    backdropUrls: (got.backdropPaths || []).map((p) => tmdb.imageUrlOf('w780', p)),
    logoUrl: tmdb.imageUrlOf('w500', got.logoPath),
  });
  item.OriginalTitle = got.originalTitle;
  item.Genres = got.genres;
  item.ChildCount = got.seasonCount;
  /* 剧是容器（能进季集）→ true；**电影不是** → false。`baseItem()` 默认给 true，
   * 电影必须显式改掉，否则客户端可能当目录去浏览而不是打开详情。 */
  item.IsFolder = type === 'tv';
  applyRich(item, got);
  return { ok: true, item };
}

/**
 * GET /Items/{ItemId}/Similar —— 「相似 / 更多类似」。
 *
 * **归 emby 层**（和 `Shows/{Id}/Seasons`、`Items/{id}` 同类）：它是**按条目的 tmdb 坐标去 TMDB
 * 反查回来的关联内容**，不是"这台服务器上有什么" —— 所以不走首页模块。
 * 数据就来自详情那次 lookup 的 `recommendations`（**同一次 TMDB 请求**，不额外打）。
 *
 * ⚠️ 响应形状按 `QueryResult<BaseItemDto>`（`{Items, TotalRecordCount}`）实现，**待客户端实测复核**：
 * 官方这边没有可靠文档，若客户端不渲染，第一个要试的是 `RecommendationDto[]` 那种分组形状。
 */
async function getSimilar(itemId, requestedId, limit) {
  const denied = assertUser(requestedId);
  if (denied) return denied;

  const p = tmdb.parseItemId(itemId);
  if (!p) return { status: 404, body: { error: '没有这个条目' }, log: `Id 认不出 → 404：${itemId}` };

  const look = await tmdb.lookup({ type: p.type, tmdbId: p.tmdbId, rich: true });
  if (!look.ok) return tmdbFailure(look.error, `${p.type}/${p.tmdbId}`);

  const all = (look.item.recommendations || []).map(leanItemDto);
  const n = Number(limit) > 0 ? Number(limit) : all.length;
  const items = all.slice(0, n);
  return {
    status: 200,
    body: { Items: items, TotalRecordCount: items.length },
    log: `${p.type}/${p.tmdbId} → ${items.length} 条相似${n !== all.length ? `（Limit=${n}，上游给了 ${all.length}）` : ''}`,
  };
}


/**
 * GET /Users/{UserId}/Items/{ItemId} —— 按 Id 取单条详情
 *
 * 两个数据来源，各司其职：
 *   ① 元数据（名字 / 简介 / 图片 / 集号…）—— **TMDB 反查**。客户端认的是本面板发出去的 Id，
 *      所以必须回**同一个对象**（形状与列表里那条一致）。
 *   ② 源绑定 —— 用 TMDB 的**影视名**，交给聚合层（`agg/api.js` 的 `detail()`，**进程内直调**）搜一遍，
 *      挑同名条目，命中结果落到日志与 `ProviderIds.Catpaw` / `CatpawSource`。
 *
 * 实现上尽量不重复组装逻辑：季/集**复用列表实现**（`getSeasons` / `getEpisodes`）再挑出那一条；
 * 剧/影走 `tmdbItemDto()`（rich 版反查）—— 它是详情专用，别和列表项那套混。
 * 聚合只做补充：连不上 / 没配 → 元数据照常返回（日志写明原因），详情页不至于打不开。
 * 粒度说明：站源只有「剧」级条目（`vod_id` 是剧），**集的定位要等聚合层给 detail 契约**。
 */
async function getItem(itemId, requestedId, host = '') {
  const denied = assertUser(requestedId);
  if (denied) return denied;

  const p = tmdb.parseItemId(itemId);
  if (!p) return { status: 404, body: { error: '没有这个条目' }, log: `Id 认不出 → 404：${itemId}` };

  /* ---- ① 元数据：按层级复用列表实现，再挑出这一条 ---- */
  let found = null;
  let name = '';
  let year = '';

  if (p.season !== null) {
    const showKey = tmdb.itemId('tv', p.tmdbId);
    if (p.episode !== null) {
      const out = await getEpisodes(showKey, requestedId, tmdb.itemId('tv', p.tmdbId, p.season));
      if (out.status !== 200) return out;
      found = (out.body.Items || []).find((i) => i.Id === itemId);
    } else {
      const out = await getSeasons(showKey, requestedId);
      if (out.status !== 200) return out;
      found = (out.body.Items || []).find((i) => i.Id === itemId);
    }
    /* 集/季两条列表都不含剧名，而搜索关键词要的就是剧名 → 这里必须问一次剧 */
    const show = await tmdb.lookup({ type: 'tv', tmdbId: p.tmdbId });
    if (!show.ok) return tmdbFailure(show.error, `tv/${p.tmdbId}`);
    name = show.item.title;
    year = show.item.year;
  } else {
    /* 剧 / 影：**直接按 tmdb 坐标反查**（rich 版）——
     * 走到这里时客户端给的是本面板发出去的 Id（`tmdb_{id}_{movie|tv}`），坐标已在手里，不必再借列表绕一圈。
     * 这一环就是「客户端点条目 → TMDB 反查显示资源」里的"反查"（见指南「五」）。
     * ⚠️ 与检索那条的关系：`Items?AnyProviderIdEquals=tmdb.{id}` 是**反向**的一步
     * （客户端只有 tmdb 号 → 问本面板要 Id），最终都会走到这里。 */
    const look = await tmdbItemDto(p.type, p.tmdbId);
    if (!look.ok) return tmdbFailure(look.error, `${p.type}/${p.tmdbId}`);
    found = look.item;
    name = found.Name;
    year = found.ProductionYear ? String(found.ProductionYear) : '';
  }

  if (!found) return { status: 404, body: { error: '没有这个条目' }, log: `列表里没有 ${itemId} → 404` };

  /* ---- 不可播类型（剧 / 季）：TMDB 元数据照给，**源那一趟不跑** ----
   * Emby 里「剧」「季」是**容器**（真机就是 `IsFolder:true / CanPlay:false`），版本清单
   * （MediaSources）的语义是"这里有 N 个能直接播的文件"，给了客户端会以为整部剧是一个文件、
   * 给出播放入口 —— 而源里每条线路对应的是一集一个文件，点了必然播不出来。
   * 所以按设计**不给版本列表**（下面的 `if (!isPlayable(...)) continue` 就是这条规矩）。
   *
   * 从前是"先把源整趟跑完（4~7 秒）、算出线路与定位，**然后**才判类型、再全丢掉"——
   * 现在把判断提到问聚合层**之前**：结果一模一样（`sources` 为空时下面那些条目级字段
   * 本来也不会被填），只是不再白跑那一趟。实测剧集详情 5~6 秒 → 几十毫秒。 */
  if (!isPlayable(found.Type)) {
    return {
      status: 200,
      body: found,
      log: `id=${itemId}「${name}」→ 非可播类型「${found.Type}」，按设计不给版本列表（没查源站）`,
    };
  }

  /* ---- ② 线路 + 源绑定：把影视名交给聚合层，一次拿回线路与可播目标 ---- */
  /* 电影没有季集号：取法用 `pick: 'items'` —— 聚合层把**每条线路的全部播放项**都列成目标
   * （同一部片的多个压制版本各自成一个版本），见 `wantLocator()` 与 docs/adr/0022。
   * 名字 + 年份 + 季集就是全部输入：聚合层用它们**打分**挑片（`agg/match.js`）。
   * ⚠️ **不再把 tmdb 坐标传下去**（早期给"别名回退"用）：判据换成了本地打分，
   * 阈值与"最多留几条"都在聚合层的设置里，emby 这条链与 web 的聚合搜索**共用同一套**。 */
  const hit = await agg.detail(Object.assign({ name, year }, wantLocator(p)));
  if (!hit.ok) {
    return {
      status: 200,
      body: found,
      log: `id=${itemId}「${name}」→ 聚合取数失败（${hit.error.code}：${hit.error.message}）→ 只回元数据`,
    };
  }

  const d = hit;
  /* 命中的站**全部**用（已去掉 picked 挑选）—— 聚合层已对每个命中的站取过
   * detail，这里逐站展开：各站有自己的线路清单，也有自己「这一集」的定位。
   * 顺序即聚合层的站点顺序（`agg.order` 的优先级）；第一个站同时当"代表"填 `ProviderIds` 与老字段。 */
  const entries = (d.sites || []).filter((e) => e && e.detail);
  if (!entries.length) {
    const firstErr = (d.sites || []).find((e) => e && e.error);
    return {
      status: 200,
      body: found,
      /* 走到这里 = **没有任何站拿到详情**。三种情况要分开说（按打分口径）：
       *   ① 搜索没命中（打分把它判成"不是这部片"/分数不够）—— `stats.match` 里的各桶计数；
       *   ② 命中了但站源 `/detail` 拿不到线路（源里那一条本身是空壳）；
       *   ③ 站点失败（超时 / 连不上）。
       * 只有真有站**失败**时才带上错误，免得日志把"没有"说成"出错"
       * （实测曾被那句 `：HTTP 404` 误导过一轮）。 */
      log:
        `id=${itemId}「${name}」→ 源里没拿到详情（搜了 ${(d.stats && d.stats.searched) || 0} 站，` +
        `${d.stats && d.stats.match ? `打分：扫 ${d.stats.match.scanned} 条命中 ${d.stats.match.matched}` : '没命中'}` +
        `${firstErr && firstErr.error ? `；站点失败：${firstErr.error}` : ''}）→ 只回元数据`,
    };
  }

  const filter = lineFilter();
  const bindings = [];
  const siteDigest = [];
  /* 命中涉及**多个源**时，版本行标题要带上源名 —— 不同源可能有同名站点（都叫"木偶"），
   * 只带站点标签就分不清了。只命中一个源时保持原样（标题不变长）。 */
  const multiSource = new Set(entries.map((e) => e.source)).size > 1;
  /* 线路 = 版本：**每个站的线路都列出来**（多站之后线路名会重复，标题位要带站点才分得清，见
   * `buildMediaSource`）。**只有「集」与「电影」可播** —— 剧/季是容器，给了会让客户端以为能播。 */
  const sources = [];
  let firstFileName = ''; // 第一条版本**定位到的那个文件**的名字（条目级 `FileName` 用，见下）
  let totalLines = 0; // 过滤前的线路总数（日志与诊断字段要说清"源里有多少条"）
  let afterFilter = 0; // 过了线路过滤、还没过"定位"这一关的条数
  let noTarget = 0; // 因"没定位到这一集"而不进版本列表的线路数（见下面那处 continue）
  for (const entry of entries) {
    const siteKey = entry.key;
    const siteLabel = (multiSource && entry.sourceName ? `${entry.sourceName} ` : '') + (entry.name || siteKey);
    /* 一个站可能收下**多条条目**：代表（`entry.detail`）+ 同片别名变体（`entry.variants[]`，
     * 见 agg 的 `pickByName`）—— 每条条目各自展开自己的线路。老响应没有 `variants`，
     * 这里就是单条，行为与从前完全一样。 */
    const items = [{ detail: entry.detail, variant: false, label: '' }].concat(entry.variants || []);
    const detailDigests = [];
    for (const item of items) {
      const det = item.detail;
      if (!det) continue;
      const lines = det.lines || [];
      totalLines += lines.length;

      bindings.push(`${entry.source}/${siteKey}|${det.vodId}`);
      const dg = {
        VodId: det.vodId,
        VodName: det.name,
        Variant: !!item.variant,
        Label: item.label || '',
        Lines: lines.map((l) => ({ Flag: l.flag, EpisodeCount: l.episodeCount })),
        Target: det.target
          ? { Flag: det.target.flag, Name: det.target.name, EpisodeId: det.target.id, MatchedBy: det.target.matchedBy }
          : null,
      };
      if (det.targetNote) dg.TargetNote = det.targetNote;
      detailDigests.push(dg);

      /* **兜底**：不可播类型（剧/季）不进版本列表。正常走不到这里 ——
       * 函数开头那个「拿到 TMDB 元数据后先判类型」的早返回已经把剧/季挡在聚合层之前了
       * （见 `getItem` 里那段说明）；留着是给以后新增类型时的保险。 */
      if (!isPlayable(found.Type)) continue;
      /* 可播目标：**电影 = 该线路下的每个播放项**（多条压制版本各自成一个版本）；
       * **剧集 = 定位到的这一集**。判据见 `wantLocator`（电影的 `pick: 'items'`）与
       * agg 的 `fetchDetail` items 分支。 */
      const movie = found.Type === 'Movie';
      for (const line of lines) {
        /* 线路过滤（`play.filter`）：**只匹配线路名**，不匹配的不进版本列表。
         * ⚠️ 它只影响"列出来的版本"，**不影响播放** —— `resolveStream` 按版本 Id 回查，不查这个列表。 */
        if (filter.re && !filter.re.test(line.flag)) continue;
        afterFilter += 1;
        /* **没有可播目标的线路不进版本列表**：列出来的版本，客户端点了就得能播 ——
         * `resolveStream` 是按「线路 + 这一项」回查的，一条没有目标的线路，点了必然 404。
         * 实测（剧集）：`斗破苍穹 S5E171` 的详情是「4 线路，1 条目定位到」，
         * 也就是 4 个版本里只有 1 个真能播；客户端挑了 huban 那条（集名是
         * `[743.2MB]180x.mp4【D斗P苍q 2026/ximg】`，解析不出集号 → 没定位到）→ 拉流 404。
         * 面板**不猜**集号，所以这种线路宁可不出现在列表里（如实"少给"），也不给一条死路。
         * ⚠️ `totalLines` 不动 —— 日志里的"源里 N 条"说的是源里有多少，不是列出来多少。 */
        const targets = movie ? line.items || [] : line.target ? [line.target] : [];
        if (!targets.length) {
          noTarget += 1;
          continue;
        }
        /* 电影多版本：同一条线路下的各项要生成**互不相同**的短标签（规格优先，重了补项序号） */
        const itemLabels = movie ? itemLabelsOf(targets) : [];
        targets.forEach((t, i) => {
          /* 第一条版本**那个文件**的名字 = 条目级 `FileName` 的真来源
           * （真机给的就是文件名 `10间敢死队.2026….mkv`；版本名是"站点 · 线路"，不是文件名）。 */
          if (!firstFileName && t.name) firstFileName = String(t.name);
          sources.push(
            buildMediaSource({
              itemId,
              host,
              source: entry.source,
              siteKey,
              siteLabel,
              vodId: det.vodId,
              line,
              runtimeTicks: found.RunTimeTicks,
              variantLabel: item.label || '',
              item: t,
              itemIndex: movie ? i : 0,
              itemLabel: itemLabels[i] || '',
            })
          );
        });
      }
    }
    /* 诊断字段：老字段（单站那几个）取**第一条**（代表条目，兼容既有面板读取），
     * 新增 `Details` 放该站收下的**全部条目**（含变体）。 */
    const head = detailDigests[0] || {};
    const digest = {
      Source: entry.source,
      SourceName: entry.sourceName || '',
      Site: siteKey,
      SiteName: entry.name || '',
      Api: entry.api || '',
      VodId: head.VodId,
      VodName: head.VodName,
      VodPic: (entry.detail || {}).pic,
      VodRemarks: (entry.detail || {}).remarks,
      Lines: head.Lines || [],
      Target: head.Target || null,
      Details: detailDigests,
    };
    if (head.TargetNote) digest.TargetNote = head.TargetNote;
    siteDigest.push(digest);
  }

  /* 源绑定：**每个命中的站都记**（`<源id>/<站点>|<vodId>`，`;` 分隔）—— 客户端不解析它，面板/日志核对用 */
  found.ProviderIds = Object.assign({}, found.ProviderIds, { Catpaw: bindings.join(';') });
  /* CatpawSource 是非标准字段（Emby 客户端会忽略）：老字段（单站那几个）取**第一个站**以兼容既有文档
   * 与面板读取，新增 `Sites` 放**全部命中站**的明细。 */
  found.CatpawSource = Object.assign({}, siteDigest[0], { Sites: siteDigest });
  /* 有过滤规则时，把「源里多少条 / 留下多少条」一并记进诊断字段（客户端会忽略，面板核对用）。
   * **只有可播类型（集/电影）才算得通**：剧/季根本不会展开版本列表（上面 `if (!isPlayable(...)) continue`），
   * 那种 0 条是设计，不是规则滤的 —— 别把误导写进诊断字段。 */
  if (filter.raw && isPlayable(found.Type)) {
    found.CatpawSource.LineFilter = {
      Pattern: filter.raw,
      Total: totalLines,
      Kept: sources.length,
      Invalid: filter.invalid,
    };
  }
  if (sources.length) found.MediaSources = sources;

  /* ---- 条目级：把**所选线路**的事实提到条目上（真机就是这么给的）----
   * 真机的条目级也有 `Container`/`MediaStreams`/`Path`/`Size`/`Bitrate`/`FileName`，
   * 而早期只在 `MediaSources[]` 里给 —— SenPlayer 的 `Fields` 里**点名要 `Container` 和
   * `MediaStreams`**，且本层完全忽略 `Fields`，所以它要的字段一个都拿不到。
   * 取第一条版本（= 列表里排第一的那条线路），与真机"单文件条目"的形状一致。 */
  {
    const first = sources[0];
    if (first) {
      if (first.Container) found.Container = first.Container;
      if (first.Size) found.Size = first.Size;
      if (first.Bitrate) found.Bitrate = first.Bitrate;
      if (first.MediaStreams && first.MediaStreams.length) found.MediaStreams = first.MediaStreams;
      if (first.Path) found.Path = first.Path;
      /* `FileName` 用**源给的真文件名**（`target.name`，如 `10间敢死队.2026.2160p….mkv`）——
       * 真机给的就是文件名。早期从版本 `Path` 末段取，而那是"站点标签 · 文件名"的副标题，
       * **不是纯文件名**。 */
      if (firstFileName) found.FileName = firstFileName;
    }
  }

  const specs = sources.filter((m) => m.Container || m.MediaStreams.length).length;
  /* 定位到的**条目**数（一个站可能有代表 + 若干变体，各自算一条） */
  const located = siteDigest.reduce((n, d) => n + (d.Details || []).filter((x) => x.Target).length, 0);
  const variantCount = siteDigest.reduce((n, d) => n + (d.Details || []).filter((x) => x.Variant).length, 0);
  /* 日志里写清「源里 N 条 → 过滤后 M 条 → 列出 K 条」；**少给要一眼看得出来**，而且要分清是
   * **哪个原因**少给的（口径：如实为空、不回退成全部 —— 否则规则写错根本发现不了）：
   *   · 非可播类型（剧/季）**不展开版本列表**，那种 0 条是设计（曾被这句误导过一轮）；
   *   · 线路过滤（正则没匹配上）；
   *   · 没定位到这一集（集名里没有集号，面板不猜 → 那条线路不列）。 */
  /* 电影的一个"版本" = 线路 × 播放项，剧集 = 一条线路 —— 日志里分开说，免得把版本数读成线路数 */
  const isMovie = found.Type === 'Movie';
  const versionNote = isMovie ? `${sources.length} 个版本（${afterFilter} 条线路 × 播放项）` : `${sources.length} 线路`;
  const noTargetNote = noTarget
    ? `（另有 ${noTarget} 条线路${isMovie ? '没有播放项' : `没定位到 ${locatorLabel(found.Type, p)}`}，不进版本列表）`
    : '';
  const filterNote =
    !isPlayable(found.Type)
      ? ` 非可播类型「${found.Type}」，按设计不给版本列表（源里 ${totalLines} 条线路）` /* 兜底：早返回之后正常走不到 */
      : (filter.raw
          ? ` 线路过滤(/${filter.raw}/)${filter.invalid ? '规则非法，已忽略' : ''}：源里 ${totalLines} 条 → 过滤后 ${afterFilter} 条` +
            (filter.re && totalLines > 0 && afterFilter === 0 ? '（规则把线路全滤掉了）' : '')
          : noTarget
            ? ` 源里 ${totalLines} 条 → 列出 ${sources.length} 条`
            : '') + noTargetNote;
  return {
    status: 200,
    body: found,
    log:
      `id=${itemId}「${name}」→ ${entries.length} 站命中（${entries.map((e) => `${e.source}/${e.key}`).join(' ')}）` +
      ` ${versionNote}，${located} 条目${isMovie ? '有播放项' : `定位到 ${locatorLabel(found.Type, p)}`}` +
      `${variantCount ? `，同片变体 ${variantCount} 条` : ''}` +
      `${specs ? ` 带规格=${specs}` : ''}${filterNote} ${hit.elapsedMs}ms`,
  };
}

/**
 * 聚合层给的动态范围是**中立值**（`DOVI` / `HDR10+` / `HDR10` / `HDR` / `HLG`，见 agg 的
 * `parseEpisodeMeta`），而 Emby 客户端认的是 **Emby 的词表**：真实 Emby 服务端返回的是 `DolbyVision`
 * （对照样例见 docs「多版本对照」），`DOVI` 是 Jellyfin 的叫法。翻译只做这一处，认不出的原样给。
 */
const VIDEO_RANGE_EMBY = { DOVI: 'DolbyVision', 'HDR10+': 'HDR', HDR10: 'HDR', HDR: 'HDR', HLG: 'HLG' };
function embyVideoRange(v) {
  const s = String(v || '');
  return VIDEO_RANGE_EMBY[s] || s;
}

/**
 * `ExtendedVideoType` —— Emby 用它区分 HDR 的细类（`VideoRange` 只有 HDR 一档，说不出 HDR10/HLG）。
 * 只映射**源明确写了的**那几种；写 `HDR` 但没说哪一种的不给（可能是 HLG，说了就成猜了）。
 */
const EXTENDED_VIDEO_TYPE = { DOVI: 'DolbyVision', 'HDR10+': 'HDR10Plus', HDR10: 'HDR10', HLG: 'HLG' };
function extendedVideoType(v) {
  return EXTENDED_VIDEO_TYPE[String(v || '')] || '';
}

/**
 * 动态范围 → 色彩三元组。**这是规范定的，不是猜**：Dolby Vision / HDR10 / HDR10+ 一律 BT.2020 容器
 * + PQ（`smpte2084`）；HLG 是 BT.2020 + `arib-std-b67`。只写 `HDR` 的**不给**（传输函数定不下来），
 * SDR / 未知也不给 —— 缺字段比给错字段好。
 */
function colorOf(v) {
  const s = String(v || '');
  if (s === 'DOVI' || s === 'HDR10' || s === 'HDR10+') {
    return { ColorSpace: 'bt2020nc', ColorPrimaries: 'bt2020', ColorTransfer: 'smpte2084' };
  }
  if (s === 'HLG') return { ColorSpace: 'bt2020nc', ColorPrimaries: 'bt2020', ColorTransfer: 'arib-std-b67' };
  return null;
}

/**
 * 真实 Emby 的 `MediaStream` 上那一批**恒定型**字段 —— 流上那些**确知的事实**：
 * 本层的流是内嵌的（不是外挂字幕/外挂音轨）、不是字幕流、不单独外发。
 *
 * 早期一个都没给（视频流只有 6~8 个键），而真机有 35 个。实测已定性：
 * **SenPlayer 拿到那套薄字段就判定条目不可用**（拿到真实聚合数据、有线路、照样打不开），
 * 换成真机形状立刻正常 —— 所以这些**不是可有可无的装饰**。
 *
 * 这里只放**对本层的流一定成立**的常量；**不知道的不编**（语言、PixelFormat、Level、
 * RefFrames、SampleRate 这些本层不掌握，就不填 —— 宁缺毋滥）。
 *
 * ⚠️ **不填"猜的"**（口径：**不知道就空字段**）。真机有、但**本层不知道**的
 * 这些一律**不给**：`Protocol`（真机是 `File` 因为文件在本地，这里是从 http 拉的）、
 * `TimeBase`（真机来自**文件解析**）、`IsAnamorphic` / `IsInterlaced` / `IsHearingImpaired`
 * （要探测文件才知道）、`ExtendedVideoType/SubType/SubTypeDescription`（要知道 HDR 细类，
 * 源没标就不知道）。照抄真机会让响应"看起来更真"，但那是**编**。
 */
const STREAM_BASE = {
  AttachmentSize: 0,
  IsExternal: false,
  IsForced: false,
  IsTextSubtitleStream: false,
  SupportsExternalStream: false,
};

/** 宽高比化简成 `240:101` 这种（真机就是这么给的，不是原始的 3840×1616） */
function aspectRatioOf(w, h) {
  const a = Math.round(Number(w) || 0);
  const b = Math.round(Number(h) || 0);
  if (!a || !b) return '';
  const gcd = (x, y) => (y ? gcd(y, x % y) : x);
  const g = gcd(a, b);
  return `${a / g}:${b / g}`;
}

/**
 * 一条线路 → 一个 Emby `MediaSource`（**版本**）。
 *
 * 多站之后每条线路都带**站点**：
 *   - `Id` = `catpaw:` + base64url(`<site>:<flag>|<vod>`)（**该站自己的** vodId）—— 客户端播直连时
 *     只回传它，所以站点与 vod 都必须编在里面，且**必须编码**（线路名里的 `#` 被 URL 当锚点吃掉，
 *     见 `catpawSourceId`）；
 *   - `Name` 与视频流 `DisplayTitle` = **`站点标签 · 线路`**（站点完整 `name`，如 `木偶|4K · 夸克原画`）
 *     —— 版本行的标题位就取 `DisplayTitle`
 *     （Rex 实测：缺了它客户端拿 `VideoRange` 拼 "Dolby Vision"，多条版本会一模一样），
 *     多站之后不带站点同样会撞名，所以站点必须在标题里；
 *   - `Path` 末段放 **`站点来源标签 · 集名`**，客户端版本行的**副标题**取它（见 `streamPath`）。
 *
 * 字段形状照**真机 Emby 4.9.5**（见 `_mock-real-detail.json` 的对照）：
 * MediaSource 级补了 `ItemId`/`Chapters`/`Formats`/`RequiredHttpHeaders`/`SupportsProbing`/
 * `IsInfiniteStream`/`ReadAtNativeFramerate`/`HasMixedProtocols`/`AddApiKeyToDirectStreamUrl`/
 * `Requires*`，流级补了上面 `STREAM_BASE` 那一批 + `AspectRatio`/`VideoRange`/色彩三元组。
 * `host` 给了就把 `Path` 写成**绝对 URL**（真机的 Path 也不是相对路径）。
 *
 * 规格全部来自源在集名里的标注（`line.target.*`）：**有才给、缺就空着** —— 给假的比不给更坑。
 */
/**
 * **直连播放地址**（`MediaSources[].DirectStreamUrl`）—— 真机**只在 PlaybackInfo 里给**，详情里没有
 * （拿真机同一集 `S05E211` 逐字段对过：详情 27 个字段、PlaybackInfo 28 个，差的就是它）。
 *
 * 形状照真机：`…/videos/{id}/stream?MediaSourceId=…&api_key=…&Static=true`。两点刻意：
 *   · 给**绝对** URL —— 本面板发出去的 `Path` 就是绝对的，绝对地址在任何解析规则（按 base 拼还是按 host 拼）下都不会错；
 *   · 带上**客户端自己的 token** —— 本层的流端点要校验 AccessToken，不带就是 401（那比不给更糟）。
 *     ⚠️ 用 query 里的 `api_key`，**不能写 `X-Emby-Token`**：后者本层只认请求头，
 *     写进 query 等于没带（拿这个 URL 直接去播就是 401 —— 客户端自己会带头所以看不出来，
 *     但把 URL 交给外部播放器/投屏时就会踩到）。`api_key` 这个 query 形式真机也认。
 *
 * ⚠️ 真机 PlaybackInfo 里它还是**相对路径**（`/videos/...`），这里给绝对的 —— 同理：只多不少、不会解析错。
 */
function directStreamUrl({ itemId, host, token, src, container }) {
  if (!host) return '';
  const file = `stream${container ? '.' + container : ''}`;
  return (
    `http://${host}/api/emby/videos/${encodeURIComponent(itemId)}/${file}` +
    `?MediaSourceId=${encodeURIComponent(src)}&Static=true` +
    (token ? `&api_key=${encodeURIComponent(token)}` : '')
  );
}

/* ---------------------------------------------------------------- 播放快路径备忘 */

/**
 * **播放快路径备忘**：构建版本列表时，本层其实**已经知道**"这一集在源里的播放 id"（`line.target.id`），
 * 而播放时却要为此再取一次源详情 —— 实测那次详情约 2 秒，而源自己的 `/play` 只要 0.07 秒。
 *
 * 为什么**不把它编进 `MediaSourceId`**：那个 id 又长又只对一条线路有效（夸克类 ≈460 字符），
 * 编进去会让客户端要访问的 URL 涨到 700 字符上下。客户端与中间代理对 URL 长度的容忍度未知，
 * 一旦被截断就是"点了播不了"，比慢两秒糟得多。
 *
 * 所以改为**服务端记住**：key = `(条目 Id, 源, 站点, 线路, vod)` → 集 id。
 *   · 命中 → 直接调 `/play`，省掉那次详情；
 *   · 未命中（面板重启、过期、换了源）→ 照旧取详情，**行为与没有这条备忘时完全一致**，只是慢。
 * 因此这条备忘只影响快慢，不影响对错。
 */
const PLAY_HINT_TTL_MS = 30 * 60 * 1000;
const PLAY_HINT_MAX = 500;
const playHints = new Map();

/* key 里带 `i`（第几个播放项）：电影同一条线路下有多个版本，不带项序号会互相覆盖 —— 结果是"永远播第 1 项" */
const playHintKey = (itemId, source, site, flag, vodId, itemIndex) =>
  [itemId, source, site, flag, vodId, Number(itemIndex) || 0].join('\u0001');

function rememberPlayHint(itemId, source, site, flag, vodId, itemIndex, episodeId) {
  if (!episodeId) return;
  playHints.set(playHintKey(itemId, source, site, flag, vodId, itemIndex), { episodeId: String(episodeId), at: Date.now() });
  /* 超上限按插入顺序淘汰最旧的（Map 保序） */
  while (playHints.size > PLAY_HINT_MAX) playHints.delete(playHints.keys().next().value);
}

/** 取出备忘的集 id；过期即删。**取走不删** —— 同一集客户端会反复请求。 */
function playHintOf(itemId, source, site, flag, vodId, itemIndex) {
  const key = playHintKey(itemId, source, site, flag, vodId, itemIndex);
  const hit = playHints.get(key);
  if (!hit) return '';
  if (Date.now() - hit.at > PLAY_HINT_TTL_MS) {
    playHints.delete(key);
    return '';
  }
  return hit.episodeId;
}

/**
 * 电影多版本时，版本行标题要能**区分**同一条线路下的各个播放项 —— 用源标的规格拼一句短标签。
 * 读不出规格就返回空（调用方退回「第 N 项」，不编）。例：`5.0GB 1080p`。
 */
function itemSpecLabel(t) {
  const bits = [];
  if (t.sizeBytes) {
    bits.push(t.sizeBytes >= 1024 ** 3 ? `${(t.sizeBytes / 1024 ** 3).toFixed(1)}GB` : `${Math.round(t.sizeBytes / 1024 ** 2)}MB`);
  }
  if (t.width && t.height) bits.push(t.height >= 2000 ? '4K' : `${t.height}p`);
  return bits.join(' ');
}

/**
 * 一条线路下**全部播放项**的短标签（电影专用）：规格互不相同就直接用规格；
 * 有重复（同一部片的两个压制版本体积+分辨率一样）或读不出规格时，补 `· 第 N 项` 保证**互不相同** ——
 * 标题撞名的后果是客户端里几条版本长得一模一样（同片变体已经踩过一次）。
 */
function itemLabelsOf(items) {
  const specs = items.map((t) => itemSpecLabel(t));
  const seen = new Set();
  const dup = new Set();
  for (const s of specs) {
    if (!s || seen.has(s)) dup.add(s);
    seen.add(s);
  }
  return specs.map((s, i) => (dup.has(s) ? `${s || '播放项'} · 第 ${i + 1} 项` : s));
}

function buildMediaSource({ itemId, source, siteKey, siteLabel, vodId, line, runtimeTicks, variantLabel = '', host = '', headers = {}, item, itemIndex = 0, itemLabel = '' }) {
  const src = catpawSourceId(source, siteKey, line.flag, vodId, itemIndex);
  /* 这个版本要播的那一项：电影 = 该线路下的**第 `itemIndex` 个播放项**；剧集 = **定位到的这一集**。
   * 两者都带集名里源标的规格（容器/分辨率/编码/体积）。 */
  const t = item || line.target || {};
  /* 记下这一项的播放 id：播放时就不必再取一次详情（见上面 playHintOf 那段）。 */
  if (t.id) rememberPlayHint(itemId, source, siteKey, line.flag, vodId, itemIndex, t.id);
  /* 站点标签用**完整 `name`**（`木偶|4K`）—— 带着 `|4K` 这类画质后缀，比截短的"木偶"信息更全；
   * 标题位与副标题（Path 末段）用**同一个标签**，两行格式统一。
   * 同片别名（`（臻彩）`/`（4K 偷跑）`）**必须**进标题位：同一部片的两个条目常常线路名完全一样
   * （`虎斑|4K · 夸克原画` × 2），不加后缀又变成"分不清哪条是哪条"（同类问题已出现过）。
   * 电影多版本（`itemLabel`）同理：同一条线路下挂着 4 个压制版本时，不加规格就是 4 行一模一样。 */
  const title = `${siteLabel} · ${line.flag}${variantLabel ? ` · ${variantLabel}` : ''}${itemLabel ? ` · ${itemLabel}` : ''}`;
  const fileName = t.name || `${line.flag}.mkv`;
  /* Path 末段 = 版本行的**副标题**（客户端取「解码后最后一个 `/` 之后」，见 streamPath）：
   * 前面挂**站点来源标签**（站点的完整 `name`，如 `木偶|4K`）—— 多站之后副标题（集名）常常逐字
   * 相同，光看集名分不出来源；标签放前面，长集名被客户端截断时也还看得见是哪个站。 */
  const rel = streamPath(itemId, src, `${siteLabel} · ${fileName}`);
  const abs = host ? `http://${host}${rel}` : rel;
  const ms = {
    Id: src,
    Name: title,
    Path: abs,
    Protocol: 'Http',
    Type: 'Default',
    IsRemote: true,
    Container: t.container || '',
    SupportsDirectPlay: true,
    SupportsDirectStream: true,
    SupportsTranscoding: false,
    /* 真机是 `true`（它的库扫过文件、能探测）；本层**不探测**远程流（只用 agg/detail 的数据），
     * 所以如实给 `false`，而不是照抄真机的 true。 */
    SupportsProbing: false,
    IsInfiniteStream: false,
    ReadAtNativeFramerate: false,
    HasMixedProtocols: false,
    AddApiKeyToDirectStreamUrl: false,
    RequiresOpening: false,
    RequiresClosing: false,
    RequiresLooping: false,
    Chapters: [],
    Formats: [],
    /* 该线路**自己**需要的请求头（多由源内嵌在 proxy URL 里，这里是空对象）——
     * 真机有这一项，且它正是"面板代为拉流"要用的东西，如实给。 */
    RequiredHttpHeaders: Object.assign({}, headers),
    ItemId: itemId,
    MediaStreams: [],
  };
  /* 体积是源标的近似值；时长来自 TMDB（`RunTimeTicks`），两个都有才能算码率 */
  if (t.sizeBytes) ms.Size = t.sizeBytes;
  if (runtimeTicks) ms.RunTimeTicks = runtimeTicks;
  const avgBitrate = t.sizeBytes && runtimeTicks ? Math.round((t.sizeBytes * 8) / (runtimeTicks / 1e7)) : 0;
  if (avgBitrate) ms.Bitrate = avgBitrate;
  if (t.bitRate) ms.Bitrate = t.bitRate;

  const streams = [];
  /* `VideoRange` / 色彩三元组 / `ExtendedVideoType` **只在源标了 HDR 时才填** ——
   * 源没标时本层**并不知道**它是 SDR 还是没写，一律假设成 SDR 就是编（口径：
   * 不知道就空字段）。真机给 bt709 是因为它**扫过文件**，这里没有文件。 */
  const videoRange = embyVideoRange(t.videoRange);
  const extended = extendedVideoType(t.videoRange);
  const color = colorOf(t.videoRange);
  /* 视频流**无条件建** —— 它承载版本标题位（`DisplayTitle`）。源没标任何规格时（集名写成
   * `ZY.S01E01.mkv` 这种）也得有它：否则客户端那一行没有名字，多条版本又变成"看不出是哪条"
   * （实测：24 条里有 4 条标题位是空的）。规格字段照旧「有才填、缺就空」。 */
  {
    const v = Object.assign({}, STREAM_BASE, {
      Type: 'Video',
      IsDefault: true,
      Index: 0,
      DisplayTitle: title,
    });
    if (videoRange) v.VideoRange = videoRange;
    if (extended) v.ExtendedVideoType = extended;
    if (color) Object.assign(v, color);
    if (t.width && t.height) {
      v.Width = t.width;
      v.Height = t.height;
      const ar = aspectRatioOf(t.width, t.height);
      if (ar) v.AspectRatio = ar;
    }
    if (t.videoCodec) v.Codec = t.videoCodec;
    if (t.videoProfile) v.Profile = t.videoProfile;
    if (t.bitDepth) v.BitDepth = t.bitDepth;
    if (t.frameRate) {
      v.AverageFrameRate = t.frameRate;
      v.RealFrameRate = t.frameRate;
    }
    if (avgBitrate) v.BitRate = avgBitrate;
    streams.push(v);
  }
  if (t.audioCodec) {
    const a = Object.assign({}, STREAM_BASE, {
      Type: 'Audio',
      Codec: t.audioCodec,
      IsDefault: true,
      Index: streams.length,
      /* 编解码 + 声道 + Atmos 拼成一句（`EAC3 5.1 Atmos`）—— 与真实 Emby 的
       * `English EAC3 5.1 (默认)` 同款式，只是本层没有语言信息，不编。 */
      DisplayTitle: [String(t.audioCodec).toUpperCase(), t.channelLayout, t.atmos ? 'Atmos' : '']
        .filter(Boolean)
        .join(' '),
    });
    if (t.channels) a.Channels = t.channels;
    if (t.channelLayout) a.ChannelLayout = t.channelLayout;
    streams.push(a);
    ms.DefaultAudioStreamIndex = a.Index;
  }
  ms.MediaStreams = streams;
  return ms;
}

/**
 * MediaSource 的 Id：把「站点 + 线路 + 绑定的站源条目」编码进去。
 *
 * 形状：`catpaw:` + **base64url**(`<site>:<flag>|<vod>`)。
 *
 * **为什么必须编码**（实测）：客户端把 Id 拼进 query 时，中文它会编码
 * （日志里是 `%E5%A4%B8%E5%85%8B…`），但 **`#` 它不编码** —— 而线路名里就有 `#`（如 `夸克原画#01`），
 * 于是 `#` 之后的 `01|/voddetail/130077.html` 被当成 URL 锚点，**根本发不到服务端**：服务端收到
 * 一个没有 vod 的 Id → 400，客户端反复重试（实测 e1/e2 各 34 次）。线路名不含 `#` 的站点
 * （`nodejs_muou` / `nodejs_huban`）则一路正常 —— 这正是"有些能播、有些播不了"的全部原因。
 * base64url 字符集只有 `[A-Za-z0-9_-]`，客户端编不编码都是同一串，对该问题**免疫**。
 *
 * **为什么要自带 vod**：客户端播直连时只会回传 `MediaSourceId`，**不读本面板给的 `Path`**
 * （实测 Rex 打的是 `/videos/{ItemId}/stream.{Container}?MediaSourceId=…`，见 routes.js）。而拉流要
 * vod 才能走 detail 快路径（拿新鲜集 ID）—— 让 Id 自包含，播放链路就不看客户端的脸色。
 */
function catpawSourceId(source, site, flag, vodId, itemIndex = 0) {
  /* 载荷 = 五个字段的 **JSON**（再整体 base64url）：
   *   `{s: 源id, t: 站点key, f: 线路, v: vod, i: 第几个播放项}`（`i = 0` 时**不写**）
   *
   * 为什么不是 `<源>:<站点>:<线路>|<vod>` 那种"分隔符拼串"：
   * **vod 里可能就有 `|`** —— 站源给 `vod_id` 塞 JSON 是常态，里面的 `vod_remarks`
   * 就带竖线（实测 Lmentor 的 `nodejs_bili_all`：`{"…","vod_remarks":"5分18秒|2.6万|19天前"}`）。
   * 老写法按「最后一个 `|`」切 vod，于是一播就切成 `19天前"}}` → 聚合层查不到这条绑定 → 404，
   * 客户端表现为"这个视频点了没反应"。JSON 里字段边界是结构化的，`|`/`:`/`#` 一律不是问题。
   *
   * 多源之后**必须带源**：否则拉流回查不知道去哪个源（同一站点 key 在多个源里都可能存在）。
   *
   * `i` 是**电影**多版本才需要的坐标（同一线路下挂了多个压制版本，客户端回传时靠它区分是哪一个）。
   * `i = 0` 时不写进载荷 ⇒ **第 1 项的 Id 与改动前逐字相同**，客户端手里缓存的旧 Id 天然就是
   * "第 1 项"，不需要单独的兼容分支（见 docs/adr/0022）。 */
  const body = { s: String(source || ''), t: String(site || ''), f: String(flag || ''), v: String(vodId || '') };
  if (Number(itemIndex) > 0) body.i = Number(itemIndex);
  const payload = JSON.stringify(body);
  return 'catpaw:' + Buffer.from(payload, 'utf8').toString('base64url');
}

/* 拉流方式：**一律 302**（`play.mode` 与「面板代理」那条路一并删掉）。
 *
 * 为什么删代理：面板在路由器上（2G 内存、U 盘），把每条流的字节都接一遍是最贵的那种"省事"——
 * 而 302 把流量留在源与客户端之间，面板只回一个 Location。代价是**客户端得连得到源地址**，
 * 所以同一时间加了下面 `redirectUrl()` 的地址改写：本地部署的源回的是回环地址，
 * 302 前换成客户端访问用的那个域名（够得着）。
 *
 * 老配置里残留的 `play.mode` 不再读、也不再校验（`PLAY_MODE_VALUES` 已删）——
 * 盘上留着那个键不影响任何事。
 */

/** 回环地址的各种写法：源按「谁访问它」回填 host，聚合层从 127.0.0.1 打过去，源就回这些 */
const LOOPBACK_HOST = /^(127\.\d+\.\d+\.\d+|0\.0\.0\.0|localhost|\[::1\]|::1)$/i;

/** 从 `Host` 头里取"客户端用来访问的那台机器"（去掉端口；IPv6 保留方括号） */
function clientHostName(host) {
  const h = String(host || '').trim();
  if (!h) return '';
  if (h.startsWith('[')) {
    const i = h.indexOf(']');
    return i > 0 ? h.slice(0, i + 1) : '';
  }
  return h.split(':')[0];
}

/**
 * 302 的 Location 改写：**本地部署的源**用客户端访问用的域名，自定义源按源给的原始地址。
 *
 * 为什么要改：源内嵌的 HTTP 服务会按"谁访问它"回填 host —— 聚合层是用 `http://127.0.0.1:<端口>`
 * 打它的，于是它回的播放地址也是 `127.0.0.1:<端口>/proxy/…`。那个地址对**客户端**毫无意义
 * （客户端上的 127.0.0.1 是客户端自己），302 过去必然连不上。所以换成：
 *   `http://<客户端访问用的域名>:<源端口>/…` —— 端口原样保留（docker-compose 已把源端口发布到宿主，
 *   所以"客户端用哪个域名进的 Emby，就用哪个域名 + 那个端口"就够得着，如 192.168.1.100:9988）。
 *
 * 只在**地址确实是回环**时才改：源给的是真直链（CDN 域名那种）就不动它。
 * 自定义（外部）源一律原样 —— 那种源在别的机器上，它的地址面板管不着，也不该管。
 * 相对地址（源只回 `/proxy/…`）按同一个域 + 源端口补全，否则客户端会把它拼到**面板**身上。
 *
 * 返回 `{ url, rewrote, note }`，`note` 是给日志的说明（没改写但原因值得记时才有值）。
 */
function redirectUrl(rawUrl, sourceRow, clientHost) {
  const url = String(rawUrl || '').trim();
  if (!sourceRow || !sourceRow.deployed) return { url, rewrote: false, note: '' };
  const host = clientHostName(clientHost);
  if (!host) return { url, rewrote: false, note: '没拿到客户端 Host（302 只能原样回源地址）' };
  const port = sourceRow.port ? String(sourceRow.port) : '';

  if (url.startsWith('/')) {
    if (!port) return { url, rewrote: false, note: '源只回了相对地址，但它的端口未知（没法补全）' };
    return { url: `http://${host}:${port}${url}`, rewrote: true, note: '' };
  }

  const m = /^(https?):\/\/([^/?#]+)([\s\S]*)$/i.exec(url);
  if (!m) return { url, rewrote: false, note: '播放地址认不出（不是 http 绝对地址）' };
  const at = m[2].lastIndexOf('@');
  const userinfo = at >= 0 ? m[2].slice(0, at + 1) : '';
  const hostport = at >= 0 ? m[2].slice(at + 1) : m[2];
  let hostOnly = hostport;
  let portInUrl = '';
  if (hostport.startsWith('[')) {
    const i = hostport.indexOf(']');
    hostOnly = hostport.slice(0, i + 1);
    portInUrl = hostport.slice(i + 1);
  } else {
    const i = hostport.indexOf(':');
    if (i >= 0) {
      hostOnly = hostport.slice(0, i);
      portInUrl = hostport.slice(i);
    }
  }
  if (!LOOPBACK_HOST.test(hostOnly)) return { url, rewrote: false, note: '' }; // 真直链，别动
  const tailPort = portInUrl || (port ? ':' + port : '');
  return { url: `${m[1]}://${userinfo}${host}${tailPort}${m[3]}`, rewrote: true, note: '' };
}

/**
 * 线路过滤（面板「Emby → 播放设置」→ `play.filter`）：一个正则，**只匹配线路名**（`line.flag`）——
 * 匹配上的线路才进客户端的版本列表。站点维度的取舍不在这里（那是聚合层的 `agg.enabled` / `agg.order`）。
 *
 * 留空 = 不过滤（`re:null`）。**非法正则在保存时就已被拒绝**（见 index.js 的 validate），这里是运行时
 * 兜底：真碰上就按「不过滤」走，并在日志里点名 —— 规则坏了不该把版本列表整个清空。
 *
 * 返回值：`{ raw, re, invalid }`，`raw` 也用于日志与诊断字段。
 */
function lineFilter() {
  /* **设置已搬到聚合层**（`agg.json` 的 `lineFilter`，UI 在「聚合设置 → 聚合参数」）——
   * 线路是聚合层产出的东西，规则跟它放一起才不"配置在 A、生效在 B"。这里只转发（读实现见 `agg/api.js`）。 */
  return agg.lineFilter();
}

/**
 * 拆版本 Id —— **三种形状都认**（老的两种是历史包袱：客户端可能缓存着旧 Id）：
 *   - **新**（当前发出的）：`catpaw:<base64url>`，解出来是 JSON `{s,t,f,v,i?}`；
 *   - 旧·带源：`catpaw:<源id>:<站点key>:<线路>[|<vod>]`（base64url 或明文）；
 *   - 旧·无源（多源之前）：`catpaw:<站点>:<线路>[|<vod>]` —— 多源下无法回查，上层报错让客户端重取。
 *
 * 认哪一种是**看解出来的内容**，不是猜：base64url 字符集 `[A-Za-z0-9_-]` 不含 `:`，所以
 * 「原样就带 `:`」= 明文旧形状；否则先 base64url 解码 —— 解出来以 `{` 开头就是新形状（JSON），
 * 否则按旧形状的字段切法（`vod` 取最后一个 `|` 之后，`head` 按 `:` 切：
 * 2 段 = 旧·无源，≥3 段 = 旧·带源，线路名里可能还有冒号）。
 * 认不出回 `null` —— 上层据此报 400，不猜。
 *
 * **`i`（该线路下的第几个播放项）缺省 0**：改动前发出的 Id 里没有这个字段，缺省 0 就是"第 1 项"，
 * 与那时的行为一致 —— 老 Id 因此天然可用（见 docs/adr/0022）。
 */
function parseCatpawSourceId(src) {
  const s = String(src || '');
  if (!s.startsWith('catpaw:')) return null;
  const rest = s.slice('catpaw:'.length);
  const plain = rest.includes(':') ? rest : b64urlDecode(rest);
  if (!plain) return null;

  /* 新形状：JSON 载荷 —— 字段边界靠结构，不靠分隔符（`|`/`:`/`#` 出现在任何字段里都没事） */
  if (plain.startsWith('{')) {
    try {
      const o = JSON.parse(plain);
      const source = String(o.s || '');
      const site = String(o.t || '');
      if (!site) return null;
      return { source, site, flag: String(o.f || ''), vod: String(o.v || ''), i: Number(o.i) || 0 };
    } catch {
      return null;
    }
  }

  const bar = plain.lastIndexOf('|');
  const head = bar >= 0 ? plain.slice(0, bar) : plain;
  const vod = bar >= 0 ? plain.slice(bar + 1) : '';
  const parts = head.split(':');
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  /* 老的两种形状里也没有项序号 —— 同样按"第 1 项"处理（`i: 0`） */
  if (parts.length === 2) return { source: '', site: parts[0], flag: parts[1], vod, i: 0 }; // 旧形状（没有源）
  return { source: parts[0], site: parts[1], flag: parts.slice(2).join(':'), vod, i: 0 };
}

/**
 * base64url → utf8。`Buffer` 对非法字符是**静默忽略**的（会解出乱码而不抛），所以这里自己兜一道：
 * 解不出可打印文本（含控制字符 / 空）就回空串，让上层的形状校验去拒 —— **不猜**。
 */
function b64urlDecode(s) {
  try {
    const out = Buffer.from(String(s || ''), 'base64url').toString('utf8');
    return /^[^\u0000-\u001f]+$/.test(out) ? out : '';
  } catch {
    return '';
  }
}

/**
 * 流端点的 Path：**只拼稳定坐标，不带任何时效 token**。
 *
 *   /api/emby/Items/{ItemId}/Stream/{token}/{文件名}
 *
 *   - `{token}` = base64url(版本 Id)（**整条 Id 原样编进来**：Id 自身已是 `catpaw:` + base64url，
 *     这里再编一层只为让路径段不含 `/`；两层都解得出，token 长一点无所谓）
 *     **必须是"解码后也不含 `/`"的编码**：客户端会把 Path 解码后取「最后一个 `/` 之后」当版本行的
 *     副标题 —— 明文 vod 里的 `…/vod/detail/id/8471.html` 就是这么把副标题变成 `8471.html` 的
 *     （六条线路全一样）。base64url 里没有 `/`，一劳永逸。
 *   - `{文件名}` = 该线路**定位到的那一集**的集名，源给的原始文件名（例：
 *     `[1.8GB]Lanterns.2026.S01E01.2160p.MAX.WEB-DL.H.265.DV.HDR.DDP5.1.Atmos.mkv【L 绿灯军团】`）
 *     —— 副标题显示的就是它。定位不到的线路退回「线路名.mkv」，总比 `8471.html` 有信息。
 *   - 季集号不放进来 —— Stream 路径里的 `ItemId` 解开就有。
 *
 * ⚠️ 客户端播放**并不读这个 Path**（实测它走 `/videos/{Id}/stream.{ext}`），这里纯粹是
 * "给读它的客户端 + 版本行副标题"用。
 */
function streamPath(itemId, src, fileName) {
  const token = Buffer.from(String(src), 'utf8').toString('base64url');
  const name = String(fileName || '').trim() || 'video.mkv';
  return `/api/emby/Items/${encodeURIComponent(itemId)}/Stream/${token}/${encodeURIComponent(name)}`;
}

/** 拆 Path 段里的 token（base64url → 版本 Id）—— 认不出回空串，上层据此报 400 */
function decodeSourceToken(token) {
  try {
    const s = Buffer.from(String(token || ''), 'base64url').toString('utf8');
    return s.startsWith('catpaw:') ? s : '';
  } catch {
    return '';
  }
}

/**
 * POST /Items/{ItemId}/PlaybackInfo —— 播放信息（客户端点播放前必来）
 *
 * 客户端从这里拿「有哪些版本」，再按各自的 `Path` 去拉流。所以这里**只给版本清单与稳定 Path**，
 * 真实播放地址一律留到 Stream 端点现取（会过期，放这里就会失效）。
 * 实现上直接复用 getItem（元数据 + 线路 + MediaSources 都在那儿），不重复一遍。
 */
/**
 * 「可播类型」：**集**（Episode）与**电影**（Movie）。剧/季是容器 —— 给了客户端会以为能播。
 *
 * **电影 / 剧集两套取法**（见 docs/adr/0022）：
 *   · 电影 —— `pick: 'items'`：每条线路的**每个播放项**各成一个版本（多个压制版本全都列出来），
 *     版本 Id 里带 `i`（第几项）；
 *   · 集   —— 按季集号定位**这一集**，版本 Id 里不带 `i`（缺省 0）。
 * 两套取法共用同一条播放链路（`Id` → `Path` → `PlaybackInfo` → 拉流），差别只在"取到哪一项"。
 */
const PLAYABLE_TYPES = new Set(['Episode', 'Movie']);
function isPlayable(type) {
  return PLAYABLE_TYPES.has(type);
}

/** Id 层面判断可播：集 = tv 带季集；电影 = movie 且不带季集（形状由 tmdb.parseItemId 保证） */
function isPlayableId(p) {
  if (!p) return false;
  return p.type === 'movie' ? p.season === null && p.episode === null : p.season !== null && p.episode !== null;
}

/**
 * 交给聚合层的**取法坐标**（电影/剧集两套取法，见 docs/adr/0022）：
 *   · 电影 → `{ pick: 'items' }`：每条线路的**每个播放项**各算一个可播目标（多条压制版本各自成版本）；
 *   · 集   → 照实传季集号：按集名里的集号定位**这一集**。
 */
function wantLocator(p) {
  return p.type === 'movie' ? { pick: 'items' } : { season: p.season, episode: p.episode };
}

/** 日志里"定位到哪"：集写季集号；电影写「按播放项」；其余如实写类型。 */
function locatorLabel(type, p) {
  if (type === 'Episode') return `S${p.season}E${p.episode}`;
  if (type === 'Movie') return '电影（按播放项）';
  return `（非可播类型：${type}）`;
}

async function getPlaybackInfo(itemId, requestedId, host = '', token = '') {
  const p = tmdb.parseItemId(itemId);
  if (!isPlayableId(p)) {
    return { status: 404, body: { error: '只有「集」和「电影」有播放信息' }, log: `Id 不是集/电影 → 404：${itemId}` };
  }

  const item = await getItem(itemId, requestedId, host);
  if (item.status !== 200) return item;

  const sources = (item.body.MediaSources || []).map((m) =>
    Object.assign({}, m, {
      /* RequiredHttpHeaders 留空：源要求的请求头由**本层**在 Stream 端点里带上，客户端只管拉 */
      RequiredHttpHeaders: {},
      /* 直连播放地址：**只在这里给**（真机详情里没有它 —— 见 `directStreamUrl` 的注释） */
      DirectStreamUrl: directStreamUrl({ itemId, host, token, src: m.Id, container: m.Container }),
    })
  );
  return {
    status: 200,
    body: { MediaSources: sources, PlaySessionId: crypto.randomBytes(16).toString('hex') },
    log:
      `id=${itemId} → ${sources.length} 个版本（Path 指向 Stream 端点）` +
      /* **0 个版本时把 getItem 的原因一并打出来** —— 否则日志只剩「0 个版本」，无从判断是聚合没命中、
       * 站源没详情、还是取数失败（排查时曾被这个问题卡住，只能另开脚本去打聚合）。 */
      (sources.length ? '' : `  ← ${item.log}`),
  };
}

/**
 * 拉流：解析出「该往哪儿拉」。两个渠道共用（路由见 routes.js，落响应共用 serveStream）：
 *   ① `/api/emby/Items/{ItemId}/Stream?src=…&vod=…`  —— 本面板写在 `MediaSource.Path` 里那条；
 *   ② `/api/emby/videos/{ItemId}/stream.{Container}?MediaSourceId=…` —— **客户端真正走的**那条：
 *      它只回传版本 Id（vod 已编码在 Id 里，见 catpawSourceId），不读 Path。
 *
 * 现取、不缓存：detail（快路径 site+vodId，拿**新鲜**的集 ID，它是时效 token）→ agg.play。
 * 返回 `{ status, stream: { url, headers, parse } }` —— 302 在路由层做（见 routes.js 的 serveStream）。
 *
 * `clientHost` = 客户端访问本面板用的 `Host` 头：本地部署的源回的播放地址是回环地址，
 * 302 前要用它换成"客户端够得着的那台机器"（见 `redirectUrl()`）。
 */
async function resolveStream(itemId, src, vodParam, requestedId, clientHost) {
  /* 有 UserId 就校验，没有也不拦（客户端拉流不保证带上它） */
  if (requestedId) {
    const denied = assertUser(requestedId);
    if (denied) return denied;
  }

  const p = tmdb.parseItemId(itemId);
  if (!isPlayableId(p)) {
    return { status: 404, body: { error: '只有「集」和「电影」能播' }, log: `Id 不是集/电影 → 404：${itemId}` };
  }

  const parsed = parseCatpawSourceId(src);
  if (!parsed) {
    return {
      status: 400,
      body: { error: '缺少或认不出 src（应为 catpaw:<base64url 的 源:站点:线路|vod>）', src: String(src || '') },
      log: `src 认不出 → 400：${src}`,
    };
  }
  /* 多源之前发出的版本 Id 里没有源 —— 没法回查，**如实报错让它从新的 PlaybackInfo 重取**
   * （客户端进播放页必先问 PlaybackInfo，所以它自会拿到带源的新 Id）。 */
  if (!parsed.source) {
    return {
      status: 400,
      body: { error: '这个版本 Id 是旧的（不带源信息），请重新进一次播放页获取版本列表' },
      log: `旧版 Id（无源）→ 400：${src}`,
    };
  }
  /* vod 有两个来源：① Path 那条渠道显式带 `vod=`；② 直连渠道（客户端只回传 MediaSourceId）——
   * 这时 vod 已经随 Id 一起回来了。显式参数优先，两个都没有才是真缺。
   * 旧版**明文** Id 照样解析（见 parseCatpawSourceId），但线路名里带 `#` 的那种救不回来 ——
   * `#` 之后的内容客户端根本没发出来，只能等它从新的 PlaybackInfo 重新取一次 Id。 */
  const vodId = String(vodParam || parsed.vod || '');
  if (!vodId) {
    return { status: 400, body: { error: '缺少 vod（站源条目 id）' }, log: '缺少 vod → 400' };
  }

  const where = `${parsed.source}/${parsed.site}`;

  /* ---- 快路径：版本列表里已经记下了这一集的播放 id，直接取地址 ----
   * 命中且这次能拿到地址就用它（省掉下面那次详情）；否则落回常规路径 ——
   * 备忘录只影响快慢，不影响对错（见 playHintOf 那段）。 */
  /* `i` = 该线路下的第几个播放项（电影多版本用；缺省 0 = 第 1 项，老 Id 天然落在这里） */
  const itemIndex = Number(parsed.i) || 0;
  const hinted = playHintOf(itemId, parsed.source, parsed.site, parsed.flag, vodId, itemIndex);
  if (hinted) {
    const pr0 = await agg.play({ source: parsed.source, site: parsed.site, flag: parsed.flag, episodeId: hinted });
    if (pr0.ok && (((pr0.play || {}).urls) || []).length) {
      return finishStream({ p, parsed, pr: pr0, clientHost, matchedBy: '列表备忘' });
    }
    console.log(
      `  ↻ emby 拉流快路径没成（${(pr0.error && pr0.error.code) || '源没给地址'}），改走"取详情"那条路`
    );
  }

  /* 与 `getItem` 那条链路用**同一套取法坐标**（`wantLocator`）：电影 = 该线路的全部播放项、
   * 集 = 这一集。否则 PlaybackInfo 给的版本和这里取到的会不是同一项。 */
  const hit = await agg.detail(Object.assign({ source: parsed.source, site: parsed.site, vodId }, wantLocator(p)));
  if (!hit.ok) {
    /* 照旧一律 502（"上游取不到数"）：换进程内直调后 code/message 才真的有意义，那就写进 body 与日志，
     * HTTP 状态码不动 —— 客户端侧的表现与改动前一致。 */
    return {
      status: 502,
      body: { error: `聚合取数失败（${hit.error.code}）：${hit.error.message}` },
      log: `聚合取数失败（${hit.error.code}：${hit.error.message}）`,
    };
  }
  const siteEntry = (hit.sites || []).find((e) => e && e.source === parsed.source && e.key === parsed.site);
  const det = siteEntry && siteEntry.detail;
  if (!det) {
    return {
      status: 404,
      body: { error: '源里没有这条绑定', source: parsed.source, site: parsed.site, vodId },
      log: `源里没有 ${where}|${vodId}`,
    };
  }
  /* ⚠️ 取集 ID 必须用**客户端指定的那条线路**的 `target`，不能用 `det.target` ——
   * `det.target` 只是"本站第一条定位到的线路"（见 agg 的 fetchDetail）。用错的后果：
   *   ① 客户端挑的那条线路这次没定位到（如 huban 的集名没有集号）→ 本该如实 404，
   *      却可能拿**别的线路**的集 ID 去播这条线路；
   *   ② 反过来，客户端的线路在列表里、`det.target` 也在，但两者不是同一条线路时，
   *      集 ID 与线路对不上（同一条 vod 里多半一样，属于"碰巧对"，不该靠）。
   * 版本列表与这里现在**同一口径**：`getItem` 只把有 `target` 的线路列成版本。 */
  const line = (det.lines || []).find((l) => l.flag === parsed.flag);
  if (!line) {
    return {
      status: 404,
      body: {
        error: `站源里没有这条线路「${parsed.flag}」（源可能改了线路名或少了这一条，重新进一次播放页取版本列表）`,
        source: parsed.source,
        site: parsed.site,
        flag: parsed.flag,
      },
      log: `站源里没有线路「${parsed.flag}」→ 404（源里现有：${(det.lines || []).map((l) => l.flag).join(' / ') || '无'}）`,
    };
  }
  /* 这个版本要播的目标：**电影 = 这条线路下的第 `itemIndex` 个播放项**（项序号来自 Id，缺省 0 = 第 1 项，
   * 老 Id 天然落在这里）；**剧集 = 定位到的这一集**。与 `getItem` 拼版本列表时**同一口径**，
   * 否则会出现"版本列出来了、点了 404"。 */
  const isMovie = p.type === 'movie';
  const item = isMovie ? (line.items || [])[itemIndex] || (line.items || [])[0] : line.target;
  if (!item) {
    const label = locatorLabel(isMovie ? 'Movie' : 'Episode', p);
    const what = isMovie ? '播放项' : `这一集（${label}）`;
    return {
      status: 404,
      body: { error: det.targetNote || `这条线路「${line.flag}」里没有可播的${what}` },
      log: `线路「${line.flag}」没有${what} → 404`,
    };
  }

  const pr = await agg.play({ source: parsed.source, site: parsed.site, flag: parsed.flag, episodeId: item.id });
  if (!pr.ok) {
    const e = pr.error || {};
    return {
      status: e.status || 502,
      body: { error: e.message || '取播放地址失败', code: e.code },
      log: `${where}/${parsed.flag} play 失败（${e.code}）`,
    };
  }

  return finishStream({ p, parsed, pr, clientHost, matchedBy: item.matchedBy });
}

/**
 * 拉流的**共同尾段**：拿到 `{urls, header, parse}` 之后怎么跳 ——
 * 回环地址改写、请求头提醒、日志口径都只此一处（快路径与常规路径共用，免得两边慢慢分叉）。
 */
function finishStream({ p, parsed, pr, clientHost, matchedBy }) {
  const play = pr.play || {};
  const url = (play.urls || [])[0] || '';
  const headers = play.header || {};
  if (!url) {
    return { status: 502, body: { error: '源没给出播放地址' }, log: 'urls 为空' };
  }
  if ((play.nonHttp || []).includes(url)) {
    return {
      status: 501,
      body: { error: '这条线路给的不是可直连地址（push:// 之类），暂不支持', url },
      log: `非直连地址（${url.slice(0, 12)}…）`,
    };
  }

  /* 一律 302（`play.mode` 与面板代理那条路已删，见上面 `redirectUrl()` 那段）。 */
  /* 这条站点的源是不是**本地部署**的（是的话，源回的地址得改写成客户端够得着的域名）；
   * 顺带拿走它的端口。`pr.sources` 是聚合层这次实际打的源清单（含 deployed/port）。 */
  const srcRow = (pr.sources || []).find((s) => s && s.id === parsed.source) || null;
  const red = redirectUrl(url, srcRow, clientHost);
  const reqHeaders = Object.keys(headers || {});
  /* 该线路要求请求头 → 302 后**客户端带不了**（头是源自己内嵌在 proxy URL 里的例外，那种 header 是空的）。
   * 如实记一行，别让它变成"点了播放没反应"的无头案。 */
  const headerNote = reqHeaders.length ? ` ⚠️ 该线路要求请求头 ${reqHeaders.join('/')}，302 后客户端带不了` : '';
  return {
    status: 200,
    /* 措辞按 **Emby 的类型**走：`p.type` 是 tmdb 的 `tv`/`movie`，直接喂 locatorLabel 会得到
     * 「非可播类型：tv」这种误导日志（早期一直这么打）。 */
    log:
      `${locatorLabel(p.type === 'movie' ? 'Movie' : 'Episode', p)} ${parsed.source}/${parsed.site}/${parsed.flag}` +
      ` target=${matchedBy} parse=${play.parse} → 302` +
      (red.rewrote ? ` 地址改写 ${srcRow.url} → 客户端域名(${clientHostName(clientHost)}:${srcRow.port})` : '') +
      (red.note ? `（${red.note}）` : '') +
      headerNote,
    stream: { url: red.url, headers, parse: play.parse },
  };
}

/** 条目公共字段拼装（BaseItemDto 最小公共集）；类型特有字段由调用方续写 */
/** 32 位 hex 的**稳定**哈希 —— `Etag` / `DisplayPreferencesId` / `PresentationUniqueKey` 用。
 * 必须稳定：客户端拿它们当缓存键，每次请求都变会让它反复失效。 */
function stableHash(s) {
  return crypto.createHash('md5').update(String(s)).digest('hex');
}

function baseItem(f) {
  const item = {
    Id: f.id,
    ServerId: serverId(),
    Name: f.name || '',
    Type: f.type,
    MediaType: 'Video',
    IsFolder: true,
    ProductionYear: Number(f.year) || 0,
    PremiereDate: f.premiereDate || '',
    Overview: f.overview || '',
    CommunityRating: Number(f.communityRating) || 0,
    ProviderIds: f.providerIds || {},
    UserData: emptyUserData(),
    /* ⚠️ **数组字段一律先铺成 `[]`，不整个省略**（下面对应有值的会覆盖）。
     * 实测定性：SenPlayer 曾打不开本层的详情，而换成真机形状就正常 —— 真机把标准字段都给全了。
     * 客户端的解码器若把某个数组声明成**非可选**，键缺失会让**整个响应解码失败**，
     * 表现成「网络错误 / 不存在该项目」；给空数组就不会。**标量同理**（见下面的 DateCreated）。 */
    Genres: [],
    GenreItems: [],
    People: [],
    Studios: [],
    ProductionLocations: [],
    Taglines: [],
    RemoteTrailers: [],
    Tags: [],
    BackdropImageTags: [],
    ImageTags: {},
    MediaStreams: [],
  };
  if (f.parentId) item.ParentId = f.parentId;
  /* ---- 真机 Emby 每个条目都带的「结构性字段」（按真机响应逐项补齐）----
   * 起因：SenPlayer 拿到那套薄字段就判定条目不可用（有线路也打不开），换真机形状立刻正常。
   * 所以**这些不是可有可无的装饰**。
   * 只放**能如实推导**的：布尔量是本地的事实（无章节/无锁定/不可删）；唯一键由条目 Id 派生
   * （它本就是 key，没有真假，且**必须稳定** —— 每次请求都变会让客户端缓存反复失效）；
   * 与**所选线路**相关的（Container / Size / Bitrate / MediaStreams / Path / FileName）
   * 在 getItem 拿到线路之后再补，这里给不了。
   * ⚠️ 真机有、但**本层不知道**的一律**不填**（口径：**不知道就空字段**），
   * 例如 `DateCreated`/`DateModified` 在拿不到发行日期时就是空的（见函数末尾）。 */
  item.SortName = item.Name;
  item.ForcedSortName = item.Name;
  item.PartCount = 1;
  item.Chapters = [];
  item.TagItems = [];
  item.LockData = false;
  item.LockedFields = [];
  item.CanDelete = false;
  item.CanDownload = false;
  item.LocalTrailerCount = 0;
  /* 真机**电影**条目两处（列表 + 详情）都带它 = 0；本层确实没有预告片/花絮这类附加内容，
   * 所以 0 是真话。（真机的**剧集**条目不给这个字段，给了也无害 —— 真机自己都不保证有。） */
  item.SpecialFeatureCount = 0;
  item.DisplayPreferencesId = stableHash('dp|' + f.id);
  item.PresentationUniqueKey = `p-catpaw-${item.Type}-${stableHash(f.id)}`;
  if (f.originalTitle !== undefined) item.OriginalTitle = f.originalTitle;
  if (f.genres !== undefined) item.Genres = f.genres;
  if (f.childCount !== undefined) item.ChildCount = f.childCount;
  /* 图片：给 tag 就等于承诺「图片端点取得到」—— 端点已实现（见 routes.js 的 Images），所以现在照给。
   * tag 自带 URL，所以多给几张（logo / 多张背景）不需要改端点。
   * **一律走 `tagAndRemember`**：发 tag 的同时把「Id|类型|索引 → 图片位置」记进本地索引 ——
   * URL 本来就在手边，这一步是零成本的；记下来之后客户端**不带 tag** 来要图时才有答案（见 routes.js）。 */
  if (f.posterUrl) {
    const primaryTag = tagAndRemember(f.id, 'Primary', 0, f.posterUrl);
    item.ImageTags = { Primary: primaryTag };
    /* ⚠️ 协议里 Primary 的 tag 有**两个**存放位置：`ImageTags.Primary` 和便捷字段 `PrimaryImageTag`。
     * 只填前者的话，**读便捷字段的客户端会认为"这张图没有 tag"**，于是裸请求 `Images/Primary`（不带 tag）。
     * 而 Backdrop 只有 `BackdropImageTags` 一处 —— 这正好解释了实测里那个怪现象：
     * 同一个客户端 **Backdrop 带 tag、Primary 不带 tag（实测 200 次裸请求全 404）**。
     * 两个都填，客户端才拿得到 tag、走解密快路径。`PrimaryImageItemId` 同理：图就在本条目上。 */
    item.PrimaryImageTag = primaryTag;
    item.PrimaryImageItemId = f.id;
    item.PrimaryImageAspectRatio = 0.6666667;
  }
  if (f.logoUrl) item.ImageTags = Object.assign({}, item.ImageTags, { Logo: tagAndRemember(f.id, 'Logo', 0, f.logoUrl) });
  const backs = (f.backdropUrls && f.backdropUrls.length ? f.backdropUrls : f.backdropUrl ? [f.backdropUrl] : [])
    .map((u, i) => tagAndRemember(f.id, 'Backdrop', i, u))
    .filter(Boolean);
  if (backs.length) item.BackdropImageTags = backs;

  /* `DateCreated` / `DateModified` 用 **TMDB 的发行日期**。
   * ⚠️ 语义：真机的这两个字段是**文件**的创建/修改时间，本层没有文件 —— 用"上映日期"近似。
   * 好处是客户端的「最近添加」会按**上映时间**排（比"首次见到"更有用）。
   * 拿不到发行日期（插件给的行只有 `year`、没有整日期）就**不给这两个字段** ——
   * 口径是"不知道就空字段"，宁缺勿编。
   * 实测佐证：**列表项一直没有这两个字段，而列表一直渲染正常** —— 所以缺它不会让客户端崩。 */
  const premiere = String(f.premiereDate || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(premiere)) {
    item.DateCreated = `${premiere}T00:00:00.0000000Z`;
    item.DateModified = item.DateCreated;
  }

  /* `Etag` 是**内容哈希**（客户端拿它判断"这条变没变"，所以必须**随内容变** ——
   * 内容变了 Etag 不变，客户端会一直吃旧缓存）。哈希里带上会被展示的元数据与图片 tag。 */
  item.Etag = stableHash(
    [f.id, item.Name, item.Overview, item.PremiereDate, item.RunTimeTicks, item.OfficialRating, item.PrimaryImageTag, (item.BackdropImageTags || []).join(',')].join('|')
  );
  return item;
}

/**
 * Emby 的 `UserItemDataDto`：本层没有观看记录，只回空进度。
 *
 * **字段与真机逐一对齐**：真机**条目**是
 * `{IsFavorite, PlayCount, PlaybackPositionTicks, Played}` —— 没有 `Key`
 * （早期多给了一个，已删掉：真机既然不给，客户端就不可能依赖它）。
 */
function emptyUserData() {
  return { IsFavorite: false, PlayCount: 0, PlaybackPositionTicks: 0, Played: false };
}

/**
 * 真机**库条目**的 `UserData` 比普通条目少一个 `PlayCount`（实测 25/25 都是三个字段）——
 * 所以库不该复用 `emptyUserData()`，否则形状与真机不同。
 */
function emptyViewUserData() {
  return { PlaybackPositionTicks: 0, IsFavorite: false, Played: false };
}

/**
 * Emby 的"从未修改/未知"零值 —— 真机库条目的 `DateModified` 25/25 全是它，照给（不是编的）。
 * **库的 `DateCreated` 也用它**：本层没有任何真实时间可用（库里没有"创建"这个动作，
 * TMDB 也没有对应实体），口径是"给个一看就知道是占位的值"，而它同时是合法时间
 * （`0000-00-00` 那种非法日期会让客户端的 DateTime 解析整条失败）。
 */
const ZERO_STAMP = '0001-01-01T00:00:00.0000000Z';

/* ------------------------------------------------------------------ 图片 */

/**
 * 图片 tag = `cpimg.<base64url(图片URL)>.<签名>`。
 *
 * **为什么把 URL 编进 tag**：客户端取图时**只回传 `Id` + `tag`，不回传 URL**；而条目 Id 是
 * `tmdb_{id}_{tv|movie}`，单靠它还原不出"插件给的那张图"（插件给的是完整 URL）。编进去就零额外调用，
 * 而且**详情**（TMDB 图床 URL）与**列表**（插件给的 URL）统一成同一种形状，端点不必分类讨论。
 *
 * **为什么要签名**：图片端点**必须豁免 token**（实测图片请求的凭证携带不统一，同批 8 条里 3 条啥都不带），
 * 那它就是一个"面板代为取任意 URL"的接口 —— 不签名等于把面板变成局域网/Tailscale 上的**开放代理（SSRF）**。
 * 签名绑 `Id|URL`：tag 既不能挪到别的条目上用，也造不出新的 URL。
 * 密钥 `imageKey` 首次用到时随机生成、落在 `data/settings/emby.json`（**不随任何 DTO 外发**）。
 */
function imageKey() {
  const s = settings.read('emby');
  if (s.imageKey) return s.imageKey;
  const key = crypto.randomBytes(32).toString('hex');
  settings.patch('emby', { imageKey: key });
  console.log('  ✔ emby 首次生成图片签名密钥 imageKey（已写入 settings/emby.json）');
  return key;
}

function imageSig(itemId, url) {
  return crypto.createHmac('sha256', imageKey()).update(`${itemId}|${url}`).digest('base64url').slice(0, 22);
}

function imageTag(itemId, url) {
  const u = String(url || '');
  if (!u) return '';
  return `cpimg.${Buffer.from(u, 'utf8').toString('base64url')}.${imageSig(itemId, u)}`;
}

/* ------------------------------------------- 图片索引（客户端不带 tag 时的答案） */

/**
 * 记一条「条目 Id|类型|索引 → 图片位置」，并把 tag 发出去。
 *
 * **这是出 tag 的唯一出口** —— 记账与发 tag 绑在一起，两者不可能漂移。
 *
 * 为什么必须有这张表（实测）：客户端（Lumenic）**从不回传 Primary 的 tag**，
 * 而 Emby 协议里 `Tag` 本就只是可选参数，所以裸请求是合规的。它启动时甚至**先**用自己
 * 缓存的条目 Id 要图、**后**才拉列表（时序：登录 → 4ms 后要图 → 213ms 后才拿到列表）。
 * ⇒ 只要图片位置只存在于 tag 里，这个客户端就永远取不到封面。
 *
 * **存的是「无头」值**：TMDB 图床的地址剥掉基地址只留相对路径（`tmdb.splitImageUrl`），
 * 取的时候再拼当前基地址 —— 这样用户把图床换成镜像，索引**立刻跟着变**，不用等 TTL、不用清缓存。
 * 别处的绝对地址原样存。
 */
function tagAndRemember(itemId, type, index, url) {
  const u = String(url || '');
  if (!u) return '';
  const key = `${itemId}|${String(type).toLowerCase()}|${Number(index) || 0}`;
  try {
    const cc = cache.cfg();
    cache.putImage(key, tmdb.splitImageUrl(u) || u, cc.imageTtlMs, cc.imageMaxBytes);
  } catch {
    /* 索引写失败不该影响出 tag —— 客户端带 tag 时照样能取到图 */
  }
  return imageTag(itemId, u);
}

/**
 * 图片索引查询：条目 Id + 类型 + 索引 → 完整图片 URL（查不到回 null）。
 *
 * 值是「相对路径」时用**当前**图床基地址拼回；含 `://` 的是绝对地址，原样返回。
 * 这个判据是无歧义的：TMDB 的相对路径（`w500/xx.jpg`）里不可能出现 `://`。
 */
function imageUrlFromIndex(itemId, type, index) {
  const key = `${itemId}|${String(type).toLowerCase()}|${Number(index) || 0}`;
  let v = null;
  try {
    v = cache.getImage(key);
  } catch {
    return null;
  }
  if (!v) return null;
  return v.includes('://') ? v : tmdb.joinImageUrl(v);
}

/** `imageTag()` 的逆：验签 + 只收 http(s) —— 认不出 / 验不过一律 null（不猜、不放行） */
function parseImageTag(itemId, tag) {
  const s = String(tag || '');
  if (!s.startsWith('cpimg.')) return null;
  const parts = s.split('.');
  if (parts.length !== 3) return null;

  let url;
  try {
    url = Buffer.from(parts[1], 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!/^https?:\/\//i.test(url)) return null;

  const want = imageSig(itemId, url);
  const got = parts[2];
  if (want.length !== got.length) return null;
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got)) ? url : null;
}

module.exports = {
  EMBY_VERSION,
  serverId,
  userId,
  buildUser,
  publicInfo,
  authenticate,
  tokenFrom,
  authorize,
  assertUser,
  getUser,
  getViews,
  getResume,
  recordPlayback,
  setHiddenFromResume,
  setPlayed,
  getStudios,
  getNextUp,
  getItemCounts,
  itemsWillReturnData,
  applyUserData,
  getItems,
  getLatest,
  getSeasons,
  getEpisodes,
  getItem,
  getSimilar,
  getPlaybackInfo,
  resolveStream,
  catpawSourceId,
  parseCatpawSourceId,
  streamPath,
  decodeSourceToken,
  baseItem,
  imageTag,
  parseImageTag,
  tagAndRemember,
  imageUrlFromIndex,
  parseClientHeader,
};
