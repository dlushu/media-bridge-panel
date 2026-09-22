'use strict';
/**
 * TMDB · **emby 专有那一层**（协议与配置在 `core/tmdb.js`）
 *
 * 这里只留 emby 才关心的东西：
 *   `lookup` / `lookupSeason`（按 tmdb id 反查并归一化成条目）、rich DTO 用的字段拼装、
 *   `itemId` / `parseItemId`（Emby 条目 Id 的派生与解析）、
 *   `splitImageUrl` / `joinImageUrl`（图片索引存的"无头"相对路径）、`httpStatusOf`。
 *
 * 配置、通用请求**与响应缓存**都在 core：TMDB 设置归**面板层**
 * （`data/settings/panel.json` 的 `tmdb.*`），元数据缓存落 `data/cache/tmdb.db`
 * （见 `core/tmdb.js` 与 `core/cachedb.js`）。读配置只有一条路：`core/tmdb.js` 的 `current()`。
 * ⚠️ 这里**不再有缓存相关的实现**（连注入都没有了）：缓存与配置一样是共享物，
 * 留在 emby 会让聚合层反向依赖它。
 */
const tmdbCore = require('../../core/tmdb');

/** 元数据请求的超时（`/configuration` 的连通性测试另有 core 的 10s 默认） */
const TIMEOUT_MS = 10000;
const OVERVIEW_LIMIT = 400; // 列表/占位用：短一点够画卡片
const OVERVIEW_LIMIT_RICH = 2000; // 详情页用：简介本来就该放全

/**
 * `rich` 时一次带回来的子资源（TMDB 的 `append_to_response`）—— **一次请求全拿到，不多打**。
 * `release_dates`（电影分级）与 `content_ratings`（剧分级）是**分开的两个接口**，传错会 400，所以按类型给。
 */
const RICH_APPEND = { movie: 'credits,external_ids,keywords,videos,images,recommendations,release_dates', tv: 'credits,external_ids,keywords,videos,images,recommendations,content_ratings' };

/** 分级：电影在 release_dates、剧在 content_ratings；优先美国，没有就取第一个有值的 */
function certificationOf(kind, j) {
  const rows = kind === 'movie' ? ((j.release_dates || {}).results || []) : ((j.content_ratings || {}).results || []);
  const pick = (row) => (kind === 'movie' ? ((row.release_dates || [])[0] || {}).certification : row.rating);
  const us = rows.find((row) => row && row.iso_3166_1 === 'US' && pick(row));
  const any = rows.find((row) => row && pick(row));
  return String(pick(us || any || {}) || '');
}

/** 关键词：电影是 `keywords.keywords[]`，剧是 `keywords.results[]`（TMDB 两处字段形状不一致） */
function keywordsOf(kind, j) {
  const k = j.keywords || {};
  const rows = kind === 'movie' ? k.keywords || [] : k.results || [];
  return rows.map((x) => x && x.name).filter(Boolean);
}

/** 图片列表里挑一张：优先语言匹配，其次"无语言"（多数背景图没标语言），再退第一张 */
function pickImage(rows, lang) {
  const list = (rows || []).filter((x) => x && x.file_path);
  const base = String(lang || '').split('-')[0].toLowerCase();
  return (
    (list.find((x) => String(x.iso_639_1 || '').toLowerCase() === base) || list.find((x) => !x.iso_639_1) || list[0] || {}).file_path || ''
  );
}

const stripSlash = (s) => String(s || '').replace(/\/+$/, '');

/**
 * 失败原因 → 该回给客户端的 HTTP 状态码。
 *
 * 上游给过状态码就**照搬**（401/403/404/429/5xx…）—— 让客户端看到的就是真实失败原因；
 * 上游没给（网络层）才由本层归类：超时 504、连不上 502。
 */
function httpStatusOf(error) {
  const e = error || {};
  if (e.status) return e.status;
  if (e.code === 'TIMEOUT') return 504;
  if (e.code === 'NO_TOKEN') return 500; // 面板还没配 token，不是客户端的问题
  if (e.code === 'BAD_ID') return 400;
  return 502;
}

/**
 * Emby 条目的 Id：只由「tmdb 坐标」派生，**不含源信息**。
 *
 * 客户端拿到它当主键回查（详情 / 季集 / 图片 / 播放都只带 Id），所以它必须稳定：
 * 掺进"哪次搜索、哪个站点"就会因为源变动而变 Id，客户端缓存的「已看」会全丢。
 * 带 type 是因为 TMDB 里 tv 95350 与 movie 95350 是两条不同数据。
 *
 * 传了 season 就是季：`tmdb_95350_tv_s1`；再传 episode 就是集：`tmdb_95350_tv_s1_e3`
 * （电影分不了季，季分不了集 —— 层级只能一级一级往下走）。
 */
function itemId(type, tmdbId, season, episode) {
  const kind = type === 'movie' ? 'movie' : 'tv';
  const base = `tmdb_${Number(tmdbId)}_${kind}`;
  if (kind !== 'tv' || season === undefined || season === null) return base;
  const s = `${base}_s${Number(season)}`;
  if (episode === undefined || episode === null) return s;
  return `${s}_e${Number(episode)}`;
}

/**
 * itemId() 的逆 —— 必须与它互逆，所以紧挨着放（改格式时一眼能看到要一起改）。
 * `tmdb_{id}_{tv|movie}[_s{n}][_e{m}]` → { type, tmdbId, season, episode }；无则 null。
 * 认不出来 / 电影带季号 / 有集号却没有季号 / 号不是数字 → null。
 */
function parseItemId(id) {
  const m = /^tmdb_(\d+)_(movie|tv)(?:_s(\d+))?(?:_e(\d+))?$/i.exec(String(id || '').trim());
  if (!m) return null;
  const type = m[2].toLowerCase();
  if (m[3] !== undefined && type !== 'tv') return null;
  if (m[4] !== undefined && m[3] === undefined) return null; // 集号必须挂在季号下
  const season = m[3] === undefined ? null : Number(m[3]);
  const episode = m[4] === undefined ? null : Number(m[4]);
  if (season !== null && !Number.isFinite(season)) return null;
  if (episode !== null && !Number.isFinite(episode)) return null;
  return { type, tmdbId: Number(m[1]), season, episode };
}

const ISO_SUFFIX = 'T00:00:00.0000000Z';

/** TMDB 只给 YYYY-MM-DD，Emby 的 PremiereDate 要完整时间 */
function isoDate(d) {
  const s = String(d || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s + ISO_SUFFIX : '';
}

/* ------------------------------------------------------------------ 响应缓存
 * **已搬到 core**：`isMetaPath` / `cacheKey` / `requestCached` 现在住在
 * `core/tmdb.js`，落 `data/cache/tmdb.db`。为什么搬：那张表与「名字 → 搜索结果」索引
 * 是同一类东西（TMDB 数据），而名字索引 agg 也要用 —— 缓存留在 emby 就会让 agg 反向依赖它。
 * 这里只留一个别名，`lookup()` / `lookupSeason()` 的调用点不变。 */
const requestCached = tmdbCore.requestCached;

/**
 * 反查一个 tmdb id —— 单一实现，`test()` 与 Emby 各端点都走这里。
 * 不抛异常：{ ok: true, item } 或 { ok: false, error: {code,status?,message} }
 *
 * withSeasons：把剧的 seasons[] 一并归一化挂到 item.seasons（季列表端点用）。
 * 默认关 —— 否则整包季数组会跟着条目一起回给客户端，纯噪声。
 */
async function lookup({ type = 'tv', tmdbId, cfg, withSeasons = false, rich = false } = {}) {
  const c = cfg || tmdbCore.current();
  const kind = type === 'movie' ? 'movie' : 'tv';
  const id = Number.parseInt(tmdbId, 10);
  if (!c.token) return { ok: false, error: { code: 'NO_TOKEN', message: '还没填 v4 API Read Access Token' } };
  if (!id) return { ok: false, error: { code: 'BAD_ID', message: 'tmdb id 不合法：' + tmdbId } };

  const headers = { Authorization: 'Bearer ' + c.token, Accept: 'application/json' };
  const qs = [`language=${encodeURIComponent(c.language)}`];
  if (rich) {
    qs.push(`append_to_response=${RICH_APPEND[kind]}`);
    /* ⚠️ TMDB 的坑：一旦同时给了 `language` 和 `images`，它会把 images **按语言过滤** ——
     * logo 一定带语言标记、背景图大多不带，结果**两边都空**。必须显式把"无语言"那批要回来。
     * （实测依据：TMDB 文档里 `include_image_language: ["null","en"]` 的例子，不给就 0 张背景。） */
    qs.push(`include_image_language=${encodeURIComponent('null,' + String(c.language).split('-')[0])}`);
  }

  let r;
  try {
    r = await requestCached(c.apiBase, `/${kind}/${id}?${qs.join('&')}`, { headers, timeout: TIMEOUT_MS });
  } catch (e) {
    return { ok: false, error: tmdbCore.classify(e) };
  }
  if (r.status === 401 || r.status === 403) {
    return { ok: false, error: { code: 'INVALID_TOKEN', status: r.status, message: `Token 无效或无权限（HTTP ${r.status}）` } };
  }
  if (r.status === 404) {
    return { ok: false, error: { code: 'NOT_FOUND', status: 404, message: `TMDB 里没有这个 ${kind} id=${id}` } };
  }
  if (!r.ok) {
    return { ok: false, error: { code: 'UPSTREAM_HTTP', status: r.status, message: 'TMDB 返回 HTTP ' + r.status } };
  }

  const j = r.json || {};
  const date = j.first_air_date || j.release_date || '';
  const item = {
    tmdbId: j.id || id,
    mediaType: kind,
    title: j.name || j.title || '',
    originalTitle: j.original_name || j.original_title || '',
    year: date ? String(date).slice(0, 4) : '',
    premiereDate: isoDate(date),
    overview: String(j.overview || '').slice(0, rich ? OVERVIEW_LIMIT_RICH : OVERVIEW_LIMIT),
    posterPath: j.poster_path || '',
    backdropPath: j.backdrop_path || '',
    genres: (j.genres || []).map((g) => g && g.name).filter(Boolean),
    /* 类型带 TMDB 的 id：给客户端做 `GenreItems` 用（能进入该类型）—— 早期只返回名字，因此点不进去 */
    genreItems: (j.genres || []).filter(Boolean).map((g) => ({ id: String(g.id), name: g.name })),
    seasonCount: Number(j.number_of_seasons) || 0,
    communityRating: Number(j.vote_average) || 0,
  };

  /* `rich`：详情页要的那一批（标语/时长/分级/演职/公司/关键词/预告/图集/相似），
   * 全部来自**同一次请求**的 append 结果，不额外打 TMDB。 */
  if (rich) {
    const imgs = j.images || {};
    const vids = (j.videos || {}).results || [];
    const credits = j.credits || {};
    const ext = j.external_ids || {};

    item.tagline = String(j.tagline || '');
    item.status = String(j.status || '');
    item.homepage = String(j.homepage || '');
    item.runtimeMinutes = kind === 'movie' ? Number(j.runtime) || 0 : Number((j.episode_run_time || [])[0]) || 0;
    item.certification = certificationOf(kind, j);
    /* ⚠️ 公司 **id 必须留着**：真机的 `Studios[]` 是 `NameLongIdPair`
     * （`{Id, Name}`，Id 是**数字**）；早期实现只留 name、把 id 丢了 —— 客户端模型里
     * `Id` 若是非可选，缺键会让**整个响应解码失败**。 */
    item.productionCompanies = (j.production_companies || [])
      .map((x) => x && { id: Number(x.id) || 0, name: String(x.name || '') })
      .filter((x) => x && x.name);
    item.productionCountries = (j.production_countries || []).map((x) => x && x.name).filter(Boolean);
    item.keywords = keywordsOf(kind, j);
    item.externalIds = { imdb: ext.imdb_id || '', tvdb: ext.tvdb_id ? String(ext.tvdb_id) : '', wikidata: ext.wikidata_id || '' };

    /* 演职人员：演员取前 20（按 order），幕后只要导演/编剧 —— 客户端的那条横滑就靠它 */
    item.cast = (credits.cast || [])
      .slice()
      .sort((a, b) => (Number(a && a.order) || 0) - (Number(b && b.order) || 0))
      .slice(0, 20)
      .map((p) => ({ tmdbPersonId: p && p.id, name: (p && p.name) || '', role: (p && p.character) || '', profilePath: (p && p.profile_path) || '' }))
      .filter((p) => p.name);
    item.crew = (credits.crew || [])
      .filter((p) => p && ['Director', 'Writer', 'Screenplay', 'Story'].includes(p.job))
      .slice(0, 20)
      .map((p) => ({ tmdbPersonId: p.id, name: p.name || '', job: p.job || '', profilePath: p.profile_path || '' }))
      .filter((p) => p.name);

    item.trailers = vids
      .filter((v) => v && v.site === 'YouTube' && v.key && /Trailer|Teaser/i.test(String(v.type || '')))
      .slice(0, 5)
      .map((v) => ({ name: v.name || '预告片', url: 'https://www.youtube.com/watch?v=' + v.key }));

    item.logoPath = pickImage(imgs.logos, c.language);
    item.backdropPaths = (imgs.backdrops || []).map((b) => b && b.file_path).filter(Boolean).slice(0, 8);

    /* 相似推荐：`/Similar` 端点直接用这一份（同一个接口就有，不用再打一次） */
    item.recommendations = (((j.recommendations || {}).results) || [])
      .slice(0, 20)
      .map((x) => {
        const d = String(x.release_date || x.first_air_date || '');
        return {
          tmdbId: x.id,
          type: kind,
          title: x.title || x.name || '',
          year: d ? d.slice(0, 4) : '',
          overview: String(x.overview || '').slice(0, OVERVIEW_LIMIT),
          posterPath: x.poster_path || '',
          backdropPath: x.backdrop_path || '',
          communityRating: Number(x.vote_average) || 0,
        };
      })
      .filter((x) => x.tmdbId && x.title);
  }

  /* TMDB 的 seasons[] 字段：air_date / episode_count / id / name / overview / poster_path / season_number / vote_average
   * 注意 name 是本地化文案（zh-CN 下特别篇叫「特别篇」）→ 判特别篇只能看 season_number，不能认 name。 */
  if (withSeasons) {
    item.seasons = (j.seasons || []).map((s) => {
      const air = String(s.air_date || '');
      const num = Number(s.season_number);
      return {
        seasonNumber: Number.isFinite(num) ? num : null,
        name: s.name || '',
        overview: String(s.overview || '').slice(0, OVERVIEW_LIMIT),
        posterPath: s.poster_path || '',
        episodeCount: Number(s.episode_count) || 0,
        year: air ? air.slice(0, 4) : '',
        premiereDate: isoDate(air),
        rating: Number(s.vote_average) || 0,
      };
    });
  }

  return { ok: true, item };
}

/**
 * 反查某一季的分集 —— `GET /tv/{id}/season/{n}`（season 端点，与 lookup 是两个不同接口）。
 *
 * 取分集**只能走这个接口**：剧的 `/tv/{id}` 只给 seasons[] 汇总，没有 episodes[]。
 * 与 lookup() 同一取向：不抛异常，{ ok: true, item } 或 { ok: false, error }。
 */
async function lookupSeason({ tmdbId, season, cfg } = {}) {
  const c = cfg || tmdbCore.current();
  const id = Number.parseInt(tmdbId, 10);
  const n = Number.parseInt(season, 10);
  if (!c.token) return { ok: false, error: { code: 'NO_TOKEN', message: '还没填 v4 API Read Access Token' } };
  if (!id) return { ok: false, error: { code: 'BAD_ID', message: 'tmdb id 不合法：' + tmdbId } };
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: { code: 'BAD_ID', message: '季号不合法：' + season } };

  const headers = { Authorization: 'Bearer ' + c.token, Accept: 'application/json' };
  let r;
  try {
    r = await requestCached(c.apiBase, `/tv/${id}/season/${n}?language=${encodeURIComponent(c.language)}`, {
      headers,
      timeout: TIMEOUT_MS,
    });
  } catch (e) {
    return { ok: false, error: tmdbCore.classify(e) };
  }
  if (r.status === 401 || r.status === 403) {
    return { ok: false, error: { code: 'INVALID_TOKEN', status: r.status, message: `Token 无效或无权限（HTTP ${r.status}）` } };
  }
  if (r.status === 404) {
    return { ok: false, error: { code: 'NOT_FOUND', status: 404, message: `TMDB 里没有这一季：tv ${id} S${n}` } };
  }
  if (!r.ok) {
    return { ok: false, error: { code: 'UPSTREAM_HTTP', status: r.status, message: 'TMDB 返回 HTTP ' + r.status } };
  }

  const j = r.json || {};
  /* TMDB 的 episode：air_date / episode_number / name / overview / runtime / still_path / vote_average
   * runtime 可能是 null（未定档），此时不编时长。 */
  const episodes = (j.episodes || []).map((e) => {
    const air = String(e.air_date || '');
    const num = Number(e.episode_number);
    const runtime = Number(e.runtime);
    return {
      episodeNumber: Number.isFinite(num) ? num : null,
      name: e.name || '',
      overview: String(e.overview || '').slice(0, OVERVIEW_LIMIT),
      year: air ? air.slice(0, 4) : '',
      premiereDate: isoDate(air),
      stillPath: e.still_path || '',
      rating: Number(e.vote_average) || 0,
      runtimeMinutes: Number.isFinite(runtime) && runtime > 0 ? runtime : 0,
    };
  });

  const seasonNumber = Number(j.season_number);
  return {
    ok: true,
    item: {
      tmdbId: Number(j.id) || id,
      seasonNumber: Number.isFinite(seasonNumber) ? seasonNumber : n,
      name: j.name || '',
      overview: String(j.overview || '').slice(0, OVERVIEW_LIMIT),
      posterPath: j.poster_path || '',
      episodes,
    },
  };
}

/**
 * 通用 GET —— 给「首页插件」的 `Catpaw.tmdb.get(api, {params})` 用。
 *
 * 与 lookup()/lookupSeason() 的区别：那两条是**固定路径 + 归一化输出**（给 emby 端点用）；
 * 这条是**任意路径 + 原样返回响应体**（给插件自由取 TMDB 榜单用），不解析、不裁剪。
 *
 * 契约：成功 → 解析后的响应体**本体**（不是 `{data}` 包装）；失败 → **抛错**
 * （`err.code` / `err.status` / `err.data`，与 `Catpaw.http` 同一套）。
 * `language` 默认取面板设置，插件可用 `params.language` 覆盖。
 */
async function get(api, opts = {}) {
  /* 缓存归 core：插件问同一部片的元数据照样吃缓存；
   * 榜单/搜索这类非元数据路径由 core 的 `isMetaPath` 挡掉。这里不再注入任何东西。 */
  return tmdbCore.get(api, opts);
}

/**
 * 按当前设置（含自定义镜像）拼一张 TMDB 图片地址。规则在 `core/tmdb.js`。
 *
 * ⚠️ 那份"拼串规则"在**沙箱子进程**里还有一份等价的（`home/sandbox.js` 里 `Catpaw.tmdb.imageUrlOf`）——
 * 那边不能 require core（子进程没有 fs/settings），只能拿 `spawn.js` 下发的 `imageBase` 自己拼。
 * **改规则时两处一起改**，否则插件拼出来的图和详情/季集拼出来的会不一致。
 */
function imageUrlOf(size, filePath) {
  return tmdbCore.imageUrlOf(size, filePath);
}

/**
 * 当前生效的图片基地址（留空即官方，见 core 的 effective）。
 *
 * 首页插件拼图要用它，所以**随 job 下发给沙箱**（见 home/spawn.js）——
 * 拼串是纯本地计算，没必要为它跑一次 RPC（曾经做成 RPC，导致 `Catpaw.tmdb.imageUrlOf`
 * 变成 Promise，插件同步取用时静默拿到 `{}`，表现为图片全部缺失）。
 */
function imageBase() {
  return tmdbCore.imageBase();
}

/**
 * 图片 URL → **无头相对路径**。只有当它确实在「当前图床基地址」或「官方基地址」之下时才拆，
 * 否则回 null（表示这是别处的绝对地址，原样存）。
 *
 * **为什么要拆**：图片索引是落库的。若存完整 URL，用户把图床基地址换成镜像后，
 * 库里那批老地址就全指向旧图床了 —— 要等 TTL 过期才自愈。存相对路径、取时再拼当前基地址，
 * **换镜像立刻生效，不用清缓存**。
 *
 * 同时认官方基地址：插件可能把 `https://image.tmdb.org/t/p` 写死在自己代码里，而面板配的是镜像 ——
 * 那种也该跟着镜像走。
 */
function splitImageUrl(url) {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return null;
  for (const b of new Set([stripSlash(imageBase()), stripSlash(tmdbCore.DEFAULT_IMAGE_BASE)])) {
    if (b && u.startsWith(b + '/')) return u.slice(b.length + 1);
  }
  return null;
}

/** `splitImageUrl` 的逆：用**当前**图床基地址把相对路径拼回完整 URL */
function joinImageUrl(rel) {
  return stripSlash(imageBase()) + '/' + String(rel || '').replace(/^\/+/, '');
}

module.exports = {
  httpStatusOf,
  itemId,
  parseItemId,
  lookup,
  lookupSeason,
  get,
  imageBase,
  imageUrlOf,
  splitImageUrl,
  joinImageUrl,
};
