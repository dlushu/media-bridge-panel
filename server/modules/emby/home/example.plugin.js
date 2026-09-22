'use strict';
/**
 * 首页插件示例（TMDB）
 *
 * 一个文件 = 一个插件；一行 = 客户端上的一个媒体库，handler 就是这个库里的内容。
 * 这里 11 行分别演示：官方榜单（影/剧）、趋势（含影剧混合）、分类（影剧 genre id 不同）、
 * 播出平台（只有剧）、出品公司（只有电影）、片单（自由输入）、近一月地区（语言|国家）、
 * 随机推荐（同时给客户端首页轮播图供图）。
 *
 * 写自己的插件时记住三件事：
 *   · 这是**纯文本、不是模块**：不要 require / module.exports / export，
 *     顶层直接写 HomePlugin = {...} 与 function（面板按名字找 handler）；
 *   · 条目 id 用 TMDB 坐标 `tmdb_{id}_{movie|tv}` —— 客户端点进去时，面板靠它去找详情与播放资源；
 *   · `poster` / `backdrop` 要给完整 http(s) URL，不写就没图。
 *
 * 翻页：客户端把 StartIndex / Limit 原样透传进 `ctx`，由插件自己换算（见 `windowOf`）；
 * 想知道客户端语言，得自己声明一个 enumeration 参数让用户选（地区行就是这么做的）。
 */

/* ─────────────────────────── 参数小工具 ─────────────────────────── */

function enumOf(name, title, value, pairs) {
  return {
    name: name,
    title: title,
    type: 'enumeration',
    value: value,
    enumOptions: pairs.map(function (p) { return { title: p[0], value: p[1] }; }),
  };
}

/** 「电影 / 剧集」这个参数，几乎每行都要 */
function typeParam() {
  return enumOf('type', '类型', 'movie', [['电影', 'movie'], ['剧集', 'tv']]);
}

/** 分类：value = 该题材在**电影**下的 TMDB id（剧的那套见 `CATEGORY_IDS`） */
const CATEGORY_OPTIONS = [
  ['合家欢', '10751'], ['动画', '16'], ['喜剧', '35'], ['犯罪', '80'], ['纪录', '99'],
  ['剧情', '18'], ['悬疑', '9648'], ['西部', '37'], ['儿童', '10762'], ['科幻', '878'],
  ['动作', '28'], ['惊悚', '53'], ['真人秀', '10764'],
];

const NETWORK_OPTIONS = [
  ['Netflix', '213'], ['Disney+', '2739'], ['Apple TV+', '2552'], ['HBO Max', '3186'],
  ['Hulu', '453'], ['Prime Video', '1024'], ['Paramount+', '4330'],
];

const COMPANY_OPTIONS = [
  ['迪士尼', '2'], ['华纳兄弟', '174'], ['哥伦比亚影业', '5'], ['索尼影业', '34'],
  ['环球影业', '33'], ['派拉蒙影业', '4'], ['二十世纪影业', '25'], ['Marvel', '420'],
];

/** 地区：`语言|国家`（国家留空 = 只要语言）。TMDB 上"台剧/港剧/英剧"要靠**国家**才分得准。 */
const REGION_OPTIONS = [
  ['中国大陆', 'zh|'], ['台湾', 'zh|TW'], ['香港', 'zh|HK'],
  ['日本', 'ja|'], ['韩国', 'ko|'], ['泰国', 'th|'],
  ['欧美（英语）', 'en|'], ['英国', 'en|GB'],
];

/* ─────────────────────────── 清单 ─────────────────────────── */

/**
 * `collectionType`（可选）：这个库在客户端眼里是什么库 —— `movies` / `tvshows` / `mixed`。
 * 不写就按该行当前的 `type` 参数推（movie→movies、tv→tvshows），推不出来当混合库。所以：
 *
 *   · 有 `type` 参数的行（正在热映 / 趋势 / 备受欢迎 / 高分内容 / 分类）**不用写**：
 *     用户把参数切到"剧集"，库就该跟着变成剧库，写死了反而错；
 *   · 没有 `type` 参数、但内容类型确定的（播出平台 / 出品公司 / 两个地区行）**要写** ——
 *     只有插件作者知道 `with_networks` 筛的是剧；
 *   · 天生混装的（片单）写 `mixed`。
 *
 * 不写也没有对错，只是那个库会被当成"混合库"来展示。
 */
HomePlugin = {
  id: 'example.tmdb',
  name: '示例 · TMDB 榜单',
  version: '1.0.0',
  author: 'catpaw-panel',
  description: 'TMDB 榜单 / 分类 / 平台 / 公司 / 片单 / 近一月地区：演示枚举与自由输入参数、客户端翻页、genre 名单存储缓存、失败照实抛。',
  rows: [
    {
      id: 'now_playing',
      title: '正在热映',
      functionName: 'nowPlaying',
      cacheDuration: 1800,
      params: [
        enumOf('type', '类型', 'movie', [
          ['电影（正在上映）', 'movie'],
          ['剧集（近期播出）', 'tv'],
        ]),
      ],
    },
    {
      id: 'trending',
      title: '趋势',
      functionName: 'trending',
      cacheDuration: 1800,
      params: [
        enumOf('type', '类型', 'movie', [
          ['电影', 'movie'],
          ['剧集', 'tv'],
          ['全部（影 + 剧）', 'all'],
        ]),
        enumOf('window', '时间窗口', 'week', [
          ['今日', 'day'],
          ['本周', 'week'],
        ]),
      ],
    },
    {
      id: 'popular',
      title: '备受欢迎',
      functionName: 'popular',
      cacheDuration: 3600,
      params: [typeParam()],
    },
    {
      id: 'top_rated',
      title: '高分内容',
      functionName: 'topRated',
      cacheDuration: 3600,
      params: [typeParam()],
    },
    {
      /* 演示**参数联动**：影/剧的 TMDB genre id **不是同一套**（动作：影 28 / 剧 10759）。 */
      id: 'categories',
      title: '分类',
      functionName: 'categories',
      cacheDuration: 3600,
      params: [
        typeParam(),
        enumOf('with_genres', '分类', '10751', CATEGORY_OPTIONS),
        { name: 'pageSize', title: '本页条数', type: 'count', value: 20 },
      ],
    },
    {
      id: 'networks',
      title: '播出平台',
      functionName: 'networks',
      cacheDuration: 3600,
      /* `with_networks` 在 TMDB 那边**只筛剧**（下面 handler 走的也是 `discover/tv`）。
       * 这行没有 `type` 参数可推，所以要显式声明成剧库。 */
      collectionType: 'tvshows',
      params: [enumOf('with_networks', '播出平台', '213', NETWORK_OPTIONS)],
    },
    {
      id: 'companies',
      title: '出品公司',
      functionName: 'companies',
      cacheDuration: 3600,
      /* 同上，反过来：只有电影（`discover/movie`） */
      collectionType: 'movies',
      params: [enumOf('with_companies', '出品公司', '2', COMPANY_OPTIONS)],
    },
    {
      /* 演示 **`input` 参数**：整条 TMDB 片单地址或纯 id 都收。 */
      id: 'list',
      title: '片单',
      functionName: 'tmdbList',
      cacheDuration: 3600,
      /* 片单**天生影剧混装**（条目自带 `media_type`，见 `tmdbList`）—— 这个不能推，如实写 `mixed`。 */
      collectionType: 'mixed',
      params: [
        {
          name: 'url',
          title: '片单地址（或 id）',
          type: 'input',
          value: '8512095',
          description: 'TMDB 片单的完整地址，或直接填末尾那串数字 id。走官方 list 接口（不抓网页）。',
          placeholders: [
            { title: '2025 奥斯卡最佳影片提名', value: '8512095' },
          ],
        },
      ],
    },
    {
      id: 'regional_series',
      title: '近一月地区剧集',
      functionName: 'regionalSeries',
      cacheDuration: 3600,
      collectionType: 'tvshows',
      params: [enumOf('region', '地区', 'zh|', REGION_OPTIONS)],
    },
    {
      id: 'regional_variety',
      title: '近一月地区综艺',
      functionName: 'regionalVariety',
      cacheDuration: 3600,
      /* 综艺在 TMDB 里没有独立类型，只能当剧（`discover/tv` + genre 10764）—— 所以库是剧库。 */
      collectionType: 'tvshows',
      params: [enumOf('region', '地区', 'zh|', REGION_OPTIONS)],
    },
    {
      /* 「随机推荐」—— 这一行**同时给客户端首页的轮播图供图**。
       *
       * 它声明了 `feed: 'random'`：客户端那条"不要库 Id、只要推荐"的查询会被路由到这一行；
       * **不声明 `feed` 的行，那条查询继续回空** → 轮播图没素材。
       *
       * 它同时也是一行普通的库行（客户端里会多出一个「随机推荐」的库）。 */
      id: 'random_picks',
      title: '随机推荐',
      functionName: 'randomPicks',
      feed: 'random',
      /* 半小时：轮播图"每次进来略有不同"就够。一次刷新 = 2 次 TMDB 请求（影、剧各一页），
       * 缓存把这个数压到每半小时 2 次。 */
      cacheDuration: 1800,
      collectionType: 'mixed',
    },
  ],
};

/* ─────────────────────────── 工具 ─────────────────────────── */

/** TMDB 一页固定 20 条（上游的粒度）。 */
const TMDB_PAGE = 20;

/**
 * 这条件是影还是剧？
 * `trending/all/*` 的条目自带 `media_type`；单类型接口不带，就按参数兜底；
 * 两者都没有时按"有 name 的是剧"判（TMDB 的惯例）。
 */
function typeOf(m, fallback) {
  const t = m && m.media_type;
  if (t === 'movie' || t === 'tv') return t;
  if (fallback === 'movie' || fallback === 'tv') return fallback;
  return m && m.name ? 'tv' : 'movie';
}

/** `genre_ids`（数字）→ 本地化名字；名单没拿到就空数组 —— **不编名字** */
function idsToNames(ids, names) {
  if (!names || !Array.isArray(ids)) return [];
  const out = [];
  for (const id of ids) if (names[String(id)]) out.push(names[String(id)]);
  return out;
}

/**
 * TMDB 条目 → HomeItem。剧和影**各有一套字段名**（`name`/`first_air_date` vs `title`/`release_date`）。
 * 逐字段对应关系见指南「五 HomeItem 模型」。
 */
function toItem(m, type, names) {
  if (!m || !m.id) return null;
  const t = typeOf(m, type);
  const date = m.release_date || m.first_air_date || '';
  return {
    id: 'tmdb_' + m.id + '_' + t,
    type: t,
    title: m.title || m.name || '',
    originalTitle: m.original_title || m.original_name || '',
    year: Number(String(date).slice(0, 4)) || 0,
    overview: m.overview || '',
    rating: m.vote_average || 0,
    poster: m.poster_path ? Catpaw.tmdb.imageUrlOf('w500', m.poster_path) : '',
    backdrop: m.backdrop_path ? Catpaw.tmdb.imageUrlOf('w780', m.backdrop_path) : '',
    genres: idsToNames(m.genre_ids, names),
    providerIds: { Tmdb: String(m.id) },
  };
}

/**
 * 原始条目数组 → HomeItem[] —— **三处（分页 / 片单 / 随机）共用这一份**。
 * 丢两种：TMDB 没给 id 的，以及没标题的（`trending/all` 与片单里混着的 `person` 就是靠这条丢掉的）。
 */
function toItems(list, type, names) {
  const out = [];
  for (const raw of list || []) {
    const one = toItem(raw, type, names);
    if (one && one.title) out.push(one);
  }
  return out;
}

/** 上游页码（客户端窗口 → 上游第几页） */
function pageOf(ctx) {
  return Math.floor((ctx.startIndex || 0) / TMDB_PAGE) + 1;
}

/**
 * 客户端窗口（`startIndex`/`limit`）在上游**一页**里怎么切 —— 换算都在这儿，各行不必各写一遍。
 *
 * ⚠️ 只取上游一页：窗口跨页时可能凑不满 `limit`（例：`StartIndex=38&Limit=5` 只能给上游第 2 页
 * 剩下的 2 条）。`total` 是准的，客户端按**实际拿到的条数**往后推进，所以不影响翻页。
 * 想凑满就自己连着取几页 —— 那是插件自己的取舍（代价是多打上游）。
 */
function windowOf(items, ctx, total, fallbackSize) {
  const start = ctx.startIndex || 0;
  const size = ctx.limit > 0 ? ctx.limit : fallbackSize || TMDB_PAGE;
  const offset = start % TMDB_PAGE;
  return { items: items.slice(offset, offset + size), total: Number(total) || 0 };
}

/** 上游没有 `results` 时**照实抛**：面板记日志、客户端拿到失败 —— 不编空数据冒充"库里没内容" */
function resultsOf(body, api) {
  if (!body || !Array.isArray(body.results)) throw new Error('TMDB 没有回 results：' + api);
  return body.results;
}

function say(msg) {
  Catpaw.log(msg);
}

/** `N` 天前的 `YYYY-MM-DD`（"近一月"那两行用） */
function daysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  const p = function (x) { return String(x).padStart(2, '0'); };
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}

/**
 * 「打一个 TMDB 列表接口 → 给客户端要的那一页」—— 下面七行只差四样东西：
 * 打哪个 api、条目算影还是剧、额外的筛选参数、日志里叫什么。
 * `names` 传 `'movie'` / `'tv'` / `['movie','tv']`（影剧混合的那档要两份名单拼起来）。
 */
async function tmdbPage(ctx, one) {
  const page = pageOf(ctx);
  const body = await Catpaw.tmdb.get(one.api, { params: Object.assign({}, one.params || {}, { page: page }) });
  const list = resultsOf(body, one.api);
  say(one.label + ' ' + one.api + ' 第 ' + page + ' 页 → ' + list.length + ' 条 / 共 ' + body.total_results);
  const names = await genreNamesFor(one.names || one.type);
  return windowOf(toItems(list, one.type, names), ctx, body.total_results, one.fallbackSize);
}

/* ────────────── genre 名单（`Catpaw.storage` 缓存，所有行共用）────────────── */

/**
 * `genre_id → 本地化名字`，存一天。
 *
 * `discover/*` / `trending/*` 只回 `genre_ids`（数字），要显示"动作, 科幻"就得有这张名单，
 * 而它**几乎不变** —— 缓存起来，别每次都打上游。`Catpaw.storage` 是**同步**的（别 await）。
 * ⚠️ 名单带语言：换了 TMDB 语言，最多一天后才更新。
 */
async function genreNameMap(type) {
  const KEY = 'genreNames.' + type;
  const hit = Catpaw.storage.get(KEY);
  if (hit && hit.at && Date.now() - hit.at < 86400000 && hit.map) return hit.map;

  const body = await Catpaw.tmdb.get('genre/' + type + '/list');
  const map = {};
  for (const g of (body && body.genres) || []) map[String(g.id)] = g.name;

  if (Object.keys(map).length) Catpaw.storage.set(KEY, { at: Date.now(), map: map });
  say('genre 名单(' + type + ') 已刷新 → ' + Object.keys(map).length + ' 项');
  return map;
}

/** `'tv'` → 那份名单；`['movie','tv']` → 两份拼起来（混合档：一张表里两种 id 都要能查） */
async function genreNamesFor(what) {
  const types = Array.isArray(what) ? what : [what];
  let acc = {};
  for (const t of types) acc = Object.assign(acc, await genreNameMap(t));
  return acc;
}

/* ─────────────────────────── 各行 ─────────────────────────── */

/** 「正在热映」——电影与剧各有一条官方接口，用一个枚举参数切。 */
async function nowPlaying(ctx) {
  const type = ctx.params.type === 'tv' ? 'tv' : 'movie';
  return tmdbPage(ctx, { api: type === 'tv' ? 'tv/on_the_air' : 'movie/now_playing', type: type, label: 'now_playing' });
}

/** 「趋势」——`all` 那档是影剧混合，条目自带 `media_type`（见 `typeOf`）。 */
async function trending(ctx) {
  const type = ctx.params.type;
  const kind = type === 'tv' || type === 'all' ? type : 'movie';
  const win = ctx.params.window === 'day' ? 'day' : 'week';
  return tmdbPage(ctx, {
    api: 'trending/' + kind + '/' + win,
    type: kind === 'all' ? '' : kind, // 混合档不给兜底类型，全靠条目的 media_type
    names: kind === 'all' ? ['movie', 'tv'] : kind,
    label: 'trending ' + kind,
  });
}

/** 「备受欢迎」 */
async function popular(ctx) {
  const type = ctx.params.type === 'tv' ? 'tv' : 'movie';
  return tmdbPage(ctx, { api: type + '/popular', type: type, label: 'popular' });
}

/** 「高分内容」 */
async function topRated(ctx) {
  const type = ctx.params.type === 'tv' ? 'tv' : 'movie';
  return tmdbPage(ctx, { api: type + '/top_rated', type: type, label: 'top_rated' });
}

/**
 * 分类 id 的**影/剧对照**（`0` = 这一类没有这个题材）。
 * 绝大多数题材影剧同 id（下面第一段直接生成），特例写在第二段：
 * `动作/惊悚` 只有电影、`儿童/真人秀` 只有剧、`科幻` 在剧里是 10765（科幻奇幻）。
 */
const CATEGORY_IDS = Object.assign(
  Object.fromEntries(
    ['10751', '16', '35', '80', '99', '18', '9648', '37'].map(function (id) {
      return [id, { movie: Number(id), tv: Number(id) }];
    })
  ),
  {
    '10762': { movie: 0, tv: 10762 },
    '878': { movie: 878, tv: 10765 },
    '28': { movie: 28, tv: 0 },
    '53': { movie: 53, tv: 0 },
    '10764': { movie: 0, tv: 10764 },
  }
);

/**
 * 「分类」——**影和剧的 genre id 不是同一套**（同一句"动作"，电影 28、剧 10759）。
 * 对不上就**照实抛**（不悄悄换成别的题材 —— 那会让用户以为筛的是他要的）。
 */
async function categories(ctx) {
  const type = ctx.params.type === 'tv' ? 'tv' : 'movie';
  const key = String(ctx.params.with_genres || '');
  const pair = CATEGORY_IDS[key];
  if (!pair) throw new Error('未知分类 id：' + key);

  const gid = pair[type];
  if (!gid) {
    throw new Error('TMDB 的' + (type === 'tv' ? '剧集' : '电影') + '里没有这个分类（id=' + key + '），'
      + '请把「类型」换成另一个再试');
  }
  return tmdbPage(ctx, {
    api: 'discover/' + type,
    type: type,
    params: { with_genres: gid },
    fallbackSize: ctx.params.pageSize,
    label: 'categories ' + type + ' / genre=' + gid,
  });
}

/** 「播出平台」 */
async function networks(ctx) {
  const id = Number(ctx.params.with_networks) || 0;
  if (!id) throw new Error('播出平台必须是数字 id（当前："' + ctx.params.with_networks + '"）');
  return tmdbPage(ctx, { api: 'discover/tv', type: 'tv', params: { with_networks: id }, label: 'networks ' + id });
}

/** 「出品公司」——只有电影（`discover/movie`）。 */
async function companies(ctx) {
  const id = Number(ctx.params.with_companies) || 0;
  if (!id) throw new Error('出品公司必须是数字 id（当前："' + ctx.params.with_companies + '"）');
  return tmdbPage(ctx, { api: 'discover/movie', type: 'movie', params: { with_companies: id }, label: 'companies ' + id });
}

/**
 * 「片单」——收整条 TMDB 片单地址或纯数字 id。
 *
 * 走官方 `Catpaw.tmdb.get('list/{id}')` —— 不必去抓网页解析 HTML，字段也更全。
 * 片单接口**不分页**，所以这一行**回数组** —— 客户端会认为这段列表翻不动，符合实际。
 * （顺带演示"不回 total"的写法。）
 */
async function tmdbList(ctx) {
  const raw = String(ctx.params.url || '').trim();
  const hit = raw.match(/(\d+)\s*$/); // 整条 URL 或纯 id，取结尾那串数字
  if (!hit) throw new Error('片单地址里找不到 id："' + raw + '"');
  const id = hit[1];

  const body = await Catpaw.tmdb.get('list/' + id);
  /* 片单里 `media_type` 可能是 person —— **先按 media_type 滤一道**（只靠「有没有标题」不行：
   * 人物也有 name，会混成 `tmdb_x_tv` 这种胡说八道的条目） */
  const list = ((body && body.items) || []).filter(function (m) {
    return m && (m.media_type === 'movie' || m.media_type === 'tv');
  });
  const items = toItems(list, '', await genreNamesFor(['movie', 'tv']));

  say('list ' + id + '「' + ((body && body.name) || '') + '」→ ' + items.length + ' 条（原 ' + ((body && body.items) || []).length + ' 项，已滤非影剧）');
  return items;
}

/**
 * 「近一月地区剧集 / 综艺」——按**原始语言 + 国家**筛，再按首播时间卡"近一月"。
 *
 * 为什么要国家：TMDB 上"台剧 / 港剧 / 英剧"光看语言分不开（都是 zh / en），所以要用
 * `with_origin_country`。地区参数写成 `语言|国家`（见 `REGION_OPTIONS`），国家留空 = 只要语言。
 * 综艺在 TMDB 里**没有独立类型**，只能用 genre 10764（真人秀）近似 —— 数据源的边界，如实记着。
 */
async function regionalSeries(ctx) {
  return regionalFeed(ctx, '');
}

async function regionalVariety(ctx) {
  return regionalFeed(ctx, '10764');
}

async function regionalFeed(ctx, genreId) {
  const parts = String(ctx.params.region || 'zh|').split('|');
  const lang = parts[0] || 'zh';
  const country = parts[1] || '';

  const params = {
    with_original_language: lang,
    'first_air_date.gte': daysAgo(30),
    sort_by: 'popularity.desc',
  };
  if (country) params.with_origin_country = country;
  if (genreId) params.with_genres = genreId;

  return tmdbPage(ctx, {
    api: 'discover/tv',
    type: 'tv',
    params: params,
    label: 'regional ' + (genreId ? 'variety' : 'series') + ' ' + lang + '/' + (country || '*') + ' 近一月',
  });
}

/* ───────────────────────── 「随机推荐」（接客户端的推荐查询）───────────────────────── */

/**
 * TMDB **没有随机接口** —— 随机只能靠「随机取一页」。三条要记住：
 *
 *   1. `sort_by=random` / `random.desc` 是**假随机**：http 200，但排序被静默忽略
 *      （回的和 `popularity.desc` 一样），**不报错** —— 最容易上当;
 *   2. `page` 上限 **500**（超了回 400）;
 *   3. `page` 超过该查询的总页数时**不报错、回一个空页** —— 所以必须自己兜底。
 *
 * 做法：随机页 → 撞空页就退到一个小范围再随机一次 → 还空就用第 1 页。
 * 质量闸门（票数 ≥ 200、评分 ≥ 6）：随机到"没人看过 / 没评分"的片，摆在推荐位上没意义。
 */
const RANDOM_PAGE_MAX = 500;
/**
 * 每类各自的随机页上限：电影候选多（用官方上限 500），剧少得多（120 就够）。
 * 给剧也用 500 的话，多半会抽到空页，白打一次上游。
 */
const RANDOM_PAGE_MAX_BY_TYPE = { movie: RANDOM_PAGE_MAX, tv: 120 };
/** 退路范围：万一池子缩了（上限比实际总页数大），退回这里再随机一次 */
const RANDOM_PAGE_SAFE_MAX = 40;
const RANDOM_GATE = { 'vote_count.gte': 200, 'vote_average.gte': 6 };

/** 1..n 的随机整数 */
function randomInt(n) {
  return 1 + Math.floor(Math.random() * n);
}

/** 洗牌（Fisher–Yates）—— 原数组不动 */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

/** 随机取一页（影或剧），返回它那 20 条；撞空页按上面的退路重来 */
async function randomPageOf(type) {
  const caps = [RANDOM_PAGE_MAX_BY_TYPE[type] || RANDOM_PAGE_SAFE_MAX, RANDOM_PAGE_SAFE_MAX];
  for (const max of caps) {
    const page = randomInt(max);
    const body = await Catpaw.tmdb.get('discover/' + type, {
      params: Object.assign({ sort_by: 'popularity.desc', page: page }, RANDOM_GATE),
    });
    const list = (body && Array.isArray(body.results) && body.results) || [];
    if (list.length) {
      say('random ' + type + ' 取第 ' + page + ' 页（共 ' + (body.total_pages || '?') + ' 页）→ ' + list.length + ' 条');
      return list;
    }
    say('random ' + type + ' 第 ' + page + ' 页是空的（超出总页数），换个范围再来');
  }
  return [];
}

/**
 * 「随机推荐」—— 影、剧各随机一页，合并打乱后给客户端。
 *
 * 为什么两个都取：只取一种的话，轮播图会连着好几屏全是电影（或全是剧）；两批混起来更像"推荐"。
 * 代价是一次刷新 **2 次** TMDB 请求，靠行的 `cacheDuration`（本行 1800 秒）压住。
 *
 * ⚠️ **这一行不翻页**：每次请求本来就是一批新的随机结果，翻页只会拿到重复，
 * 所以**忽略 `StartIndex`**，只按 `Limit` 给。回的也是数组（不带 `total`）——
 * 客户端因此认为这一行翻不动，符合实际。
 */
async function randomPicks(ctx) {
  const [movieNames, tvNames, movies, tvs] = await Promise.all([
    genreNameMap('movie'),
    genreNameMap('tv'),
    randomPageOf('movie'),
    randomPageOf('tv'),
  ]);

  const items = toItems(movies, 'movie', movieNames).concat(toItems(tvs, 'tv', tvNames));

  /* 页内 20 条也要再洗一次：不洗的话"某页的前 N 条"顺序固定，规律看得出来 */
  const mixed = shuffle(items);
  const limit = ctx.limit > 0 ? Math.min(ctx.limit, mixed.length) : mixed.length;

  say('random_picks 影 ' + movies.length + ' / 剧 ' + tvs.length + ' → 洗牌后给 ' + limit + ' 条');
  return mixed.slice(0, limit);
}
