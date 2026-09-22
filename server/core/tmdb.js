'use strict';
/**
 * TMDB 协议客户端（**core 层，无状态**）
 *
 * 只做三件事：**配置合并**、**发请求**、**拼图片地址**。业务归各模块：
 *   · emby 层（`modules/emby/tmdb.js`）在它之上做 rich DTO / itemId / 响应缓存；
 *   · 聚合层（`modules/agg/api.js`）用它做「站源条目名 → TMDB id」的反查（同名失败时的回退）。
 *
 * **为什么放在 core**：TMDB 配置原来归 emby 层，但聚合层现在也要用 ——
 * 而依赖是单向的 `emby → agg → source`，agg 不能去读 emby 的配置/客户端。放 core 后各层都能用，
 * 且 core 里放协议客户端有先例（`core/catpaw.js` 就是猫爪源协议层）。
 *
 * **配置放哪**：`data/settings/panel.json` 的 `tmdb.*`（面板是最底下的宿主层，agg/emby 读它
 * 不算反向依赖；UI 在「面板设置」页）。读取只此一处：`current()`。
 * core 自己不认识「panel」是谁 —— 只是"共享配置恰好放在那儿"，真要再挪只改 `current()`。
 *
 * **缓存也归这一层**（自 emby 层迁入）：
 *   · 元数据响应（按 id 取那一条）→ `data/cache/tmdb.db` 的 `tmdb_cache`
 *   · `search()` 的「名字 → 搜索结果」→ 同库的 `name_index`
 * 后者给 emby 的搜索端点（`Items?SearchTerm=`）用 ⇒ 缓存不能留在 emby 那层的小文件里。
 * ⚠️ **聚合层不再用 `search()`**：挑片判据换成本地打分（`agg/match.js`），
 * 所以这张表现在只服务 emby 的搜索端点。通用设施（TTL + 字节 LRU + 统计 + 清空）见 `core/cachedb.js`。
 * ⚠️ `test()`（连通性自检）**一律绕缓存** —— 它存在的意义就是测"当下"通不通。
 */
const upstream = require('./upstream');
const settings = require('./settings');
const cachedb = require('./cachedb');
const { CACHE_DIR } = require('./paths');

/** TMDB 的缓存库：元数据响应 + 名字索引（图片索引不在这里 —— 那是 emby 自用，见 emby/cache.js） */
const store = cachedb.createStore({ label: 'tmdb', dir: CACHE_DIR, file: 'tmdb.db', tables: ['tmdb_cache', 'name_index'] });

const DEFAULT_API_BASE = 'https://api.themoviedb.org/3';
const DEFAULT_IMAGE_BASE = 'https://image.tmdb.org/t/p';
const DEFAULT_LANGUAGE = 'zh-CN';
const TIMEOUT_MS = 10000;

/** `test()` 的默认探测对象：日志里 Emby 客户端真实要过的 `AnyProviderIdEquals=tmdb.95350` */
const DEFAULT_PROBE = { tmdbId: 95350, type: 'tv' };

function defaults() {
  return {
    token: '',
    apiBase: DEFAULT_API_BASE,
    imageBase: DEFAULT_IMAGE_BASE,
    language: DEFAULT_LANGUAGE,
  };
}

const stripSlash = (s) => String(s || '').replace(/\/+$/, '');
const pick = (v) => (v === undefined || v === null ? '' : String(v).trim());

/**
 * 合并「已保存设置」与「前端传来的当前输入框值」。
 *   基地址：body 里带了这个键就算数（空串 = 用官方）
 *   token / language：空串视为没改，回落已保存值（免得只想测连通性却被空密码框搞失败）
 */
function effective(body, saved) {
  const b = body || {};
  const s = saved || {};
  const hasKey = (k) => Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined && b[k] !== null;

  const base = (k, official) => {
    if (hasKey(k)) {
      const v = pick(b[k]);
      if (v) return stripSlash(v);
      return official; // 显式清空 → 官方
    }
    return stripSlash(pick(s[k])) || official;
  };

  const fallback = (k, dft) => (hasKey(k) && pick(b[k]) ? pick(b[k]) : pick(s[k]) || dft);

  return {
    token: fallback('token', ''),
    apiBase: base('apiBase', DEFAULT_API_BASE),
    imageBase: base('imageBase', DEFAULT_IMAGE_BASE),
    language: fallback('language', DEFAULT_LANGUAGE),
  };
}

/**
 * 当前生效的 TMDB 配置（**读写 TMDB 配置的唯一入口**）。
 * `over` 可传界面上没保存的当前值（测试按钮用）；不传就是落盘的那份。
 */
function current(over) {
  const saved = (settings.read('panel') || {}).tmdb || {};
  return effective(over || {}, saved);
}

/** 拼图片地址（`poster_path` 以 / 开头） */
function imageUrl(imageBase, size, filePath) {
  return filePath ? `${imageBase}/${size}${filePath}` : '';
}

/** 拿当前配置拼一张图片地址（emby 详情/季集与首页插件都用它） */
function imageUrlOf(size, filePath) {
  return imageUrl(current().imageBase, size, filePath);
}

/** 当前生效的图片基地址（首页插件拼图要用，随 job 下发给沙箱见 home/spawn.js） */
function imageBase() {
  return current().imageBase;
}

/** 网络层异常 → 可读的错误对象 */
function classify(e) {
  if (e && (e.name === 'AbortError' || /abort/i.test(e.message || ''))) {
    return { code: 'TIMEOUT', message: `请求超时（${TIMEOUT_MS}ms）` };
  }
  const cause = (e && e.cause && (e.cause.code || e.cause.message)) || '';
  return {
    code: 'NETWORK',
    message: '连不上 TMDB' + (cause ? `：${cause}` : ''),
    detail: (e && e.message) || '',
  };
}

/** 拼 query（跳过空值；没给 language 就补当前配置的） */
function buildTarget(path, params, language) {
  const p = String(path || '').replace(/^\/+/, '');
  if (!p) return '';
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    qs.set(k, String(v));
  }
  if (!qs.has('language') && language) qs.set('language', language);
  const s = qs.toString();
  return `/${p}${p.includes('?') ? '&' : '?'}${s}`;
}

/* ------------------------------------------------------------ 响应缓存 */

/**
 * **只缓存"元数据类"路径** —— 判据是**请求的性质**，不是"谁问的"：
 *   会缓存：`/movie/{数字}`、`/tv/{数字}`、`/tv/{数字}/season/{数字}`
 *   不缓存：榜单/搜索/发现（`/trending/*`、`/movie/top_rated`、`/discover`、`/search`…）
 *   不缓存：`/configuration`（连通性测试 —— 它存在的意义就是测**当下**通不通，缓存即失去意义）
 *
 * 所以插件经 `Catpaw.tmdb.get` 问同一部片的元数据也享受缓存，而榜单仍归模块自己管
 * （插件已有 `cacheDuration`）。
 * ⚠️ 「数字」这个约束很关键：`/movie/top_rated` 也长得像 `/movie/xxx`，只有限定纯数字才不会把它卷进来。
 */
const META_PATH_RE = /^\/(?:movie|tv)\/\d+(?:\/season\/\d+)?$/;

function isMetaPath(target) {
  return META_PATH_RE.test(String(target || '').split('?')[0]);
}

/**
 * 缓存键 = 路径 + **排序后**的 query。
 * 排序是为了让「同一请求、参数顺序不同」也命中同一条 —— `lookup()` 手拼 qs，
 * 而插件经 `get()` 走 `URLSearchParams`，顺序本来就不一致，不归一化会白存两份。
 *
 * ⚠️ **不含 apiBase**：换镜像取的还是同一份 TMDB 数据，缓存应当继续有效。
 * 语言与 `append_to_response` 都在 query 里，所以 lean / rich 天然是两个键。
 */
function cacheKey(target) {
  const s = String(target || '');
  const i = s.indexOf('?');
  if (i < 0) return s;
  const p = new URLSearchParams(s.slice(i + 1));
  const pairs = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return s.slice(0, i) + '?' + new URLSearchParams(pairs).toString();
}

/**
 * 发请求，**网络类失败立即重试一次**。
 *
 * 为什么需要：经过代理的网络里，TMDB 链路可能不稳定（实测握手阶段即被中断）——
 * 一次搜索要连打多个名字，全撞上坏窗口的概率不低，表现就是"搜什么都空"。
 * 失败**不缓存**（见 requestCached），所以重试是唯一能压住这种抖动的动作。
 * 只重试网络/超时；401/404 这类**确定性失败**重试没有意义。
 */
async function requestWithRetry(apiBase, target, opts) {
  try {
    return await upstream.request(apiBase, target, opts);
  } catch (e) {
    const info = classify(e);
    console.log(`  ↻ tmdb ${info.code}，立即重试一次：${target}`);
    return upstream.request(apiBase, target, opts);
  }
}

/**
 * `upstream.request` 的缓存包装 —— **TMDB 元数据的唯一出口**（lookup / lookupSeason / get 共用）。
 * 返回形状与 `upstream.request` 一致，调用方无需知道自己吃的是缓存。
 *
 * **只缓存成功响应**：401/404/5xx/超时一律不写。否则一次网络抖动会把"404"钉在缓存里，
 * 用户改了 token 还是错的 —— 失败本来就该重试。
 */
async function requestCached(apiBase, target, opts) {
  const useCache = isMetaPath(target);
  const key = useCache ? cacheKey(target) : '';

  if (useCache) {
    const hit = store.get('tmdb_cache', key);
    if (hit !== null) {
      let json = null;
      try {
        json = JSON.parse(hit);
      } catch {
        /* 理论上不会发生；真坏了就当没缓存，走网络 */
      }
      if (json) return { status: 200, ok: true, text: hit, json, cached: true };
    }
  }

  const r = await requestWithRetry(apiBase, target, opts);
  if (useCache && r.ok && r.json) {
    try {
      const cc = cachedb.cfg();
      store.put('tmdb_cache', key, r.text, cc.tmdbTtlMs, cc.tmdbMaxBytes);
    } catch {
      /* 缓存写失败不该影响取数本身 */
    }
  }
  return r;
}

/**
 * 任意 TMDB GET —— **成功回响应体本体**（不是 `{data}` 包装），**失败抛错**
 * （`err.code` / `err.status` / `err.data`，与 `Catpaw.http` 同一套）。
 *
 * `opts.noCache`：绕缓存直连上游（连通性自检用；别的调用方不用管缓存，那是这一层的事）。
 */
async function get(api, { params = {}, cfg, timeoutMs, noCache } = {}) {
  const c = cfg || current();
  if (!c.token) {
    const e = new Error('面板还没配 TMDB Token（面板设置 → TMDB）');
    e.code = 'NO_TOKEN';
    throw e;
  }
  const target = buildTarget(api, params, c.language);
  if (!target) {
    const e = new Error('TMDB 路径不能为空');
    e.code = 'BAD_ID';
    throw e;
  }

  const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : TIMEOUT_MS;
  const send = noCache ? requestWithRetry : requestCached;
  let r;
  try {
    r = await send(c.apiBase, target, {
      headers: { Authorization: 'Bearer ' + c.token, Accept: 'application/json' },
      timeout,
    });
  } catch (e) {
    const info = classify(e);
    const err = new Error(info.message);
    err.code = info.code;
    if (info.detail) err.detail = info.detail;
    throw err;
  }
  if (!r.ok) {
    const err = new Error(`TMDB 返回 HTTP ${r.status}（${target}）`);
    err.status = r.status;
    err.data = r.json;
    err.code = r.status === 401 || r.status === 403 ? 'INVALID_TOKEN' : r.status === 404 ? 'NOT_FOUND' : 'UPSTREAM_HTTP';
    throw err;
  }
  return r.json;
}

/* ------------------------------------------------------------------ 搜索 */

/**
 * 「名字 → TMDB 搜索结果」缓存（`name_index` 表）。
 *
 * 为什么**落盘**（由进程内 Map 改为落盘）：
 *   · 一次搜索要连打多个名字，而**面板重启就全丢**（dev 模式 `--watch` 频繁重启）
 *     —— 于是刚查过的名字马上又打一遍，正好撞上 TMDB 的抖动窗口；
 *   · 走同一个 `search()` 的调用方共用这张表（core 这层缓存对它自动生效）。
 * 存的是**整条搜索结果**（不是只留 id）：判定只需要 id，但搜索端点要拿它渲染列表。
 * **只存"有结果的成功响应"**：负结果（空数组）不存 —— 存了会让新上线的别名条目永远看不见；
 * 失败也照旧不缓存（下次重试）。
 */
function nameCacheGet(key) {
  const hit = store.get('name_index', key);
  if (hit === null) return null;
  try {
    const rows = JSON.parse(hit);
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null; // 理论不会发生；真坏了当没缓存
  }
}

function nameCachePut(key, rows) {
  try {
    store.put('name_index', key, JSON.stringify(rows), cachedb.NAME_TTL_MS, cachedb.NAME_MAX_BYTES);
  } catch {
    /* 缓存写失败不该影响取数本身 */
  }
}

/**
 * TMDB 搜索：`search/tv` 或 `search/movie`。返回 `results[]`（原始条目，含 `id`/`name`/`title`），
 * 查不到回 `[]`；**失败照实抛**（调用方决定是否降级）。
 *
 * ⚠️ TMDB 的搜索是**模糊**的：`斗破苍穹年番` 会回 `斗破苍穹`（79481）。这正是回退要利用的性质，
 * 但也意味着**判据不能只看"有没有结果"** —— 必须要求返回里**含目标 id**，且**类型分开搜**
 * （目标是剧只搜 tv，否则电影版会被搜出来）。
 */
async function search(kind, name, { cfg, timeoutMs } = {}) {
  const k = kind === 'movie' ? 'movie' : 'tv';
  const q = String(name || '').trim();
  if (!q) return [];
  const c = cfg || current();
  const key = `${k}|${c.language}|${q}`;
  const cached = nameCacheGet(key);
  if (cached) return cached;

  const body = await get(`search/${k}`, { params: { query: q, include_adult: 'false' }, cfg: c, timeoutMs });
  const rows = (body && body.results) || [];
  if (rows.length) nameCachePut(key, rows);
  return rows;
}

/* ------------------------------------------------------------------ 连通性测试 */

/**
 * 测一份 TMDB 配置通不通（面板「TMDB 设置 → 测试」）。
 * 永远返回对象（不抛），成败看 `ok` / `error.code`；**绝不回显 token 本身**。
 *
 * 两步都要**绕过缓存**：`/configuration` 存在的意义就是测"当下"通不通，
 * 探测对象那条也一样 —— 拿缓存里的旧响应报"正常"无法反映当下状态。
 */
async function test(body, saved) {
  const t0 = Date.now();
  const cfg = effective(body || {}, saved || {});
  const type = (body && body.type) === 'movie' ? 'movie' : 'tv';
  const probeId = Number.parseInt((body && body.tmdbId) || DEFAULT_PROBE.tmdbId, 10) || DEFAULT_PROBE.tmdbId;

  const out = {
    ok: false,
    apiBase: cfg.apiBase,
    imageBase: cfg.imageBase,
    language: cfg.language,
    tokenSet: !!cfg.token,
    tokenLength: cfg.token.length,
    probe: { tmdbId: probeId, type },
    elapsedMs: 0,
  };
  const done = (err) => {
    if (err) out.error = err;
    out.elapsedMs = Date.now() - t0;
    return out;
  };

  if (!cfg.token) return done({ code: 'NO_TOKEN', message: '还没填 v4 API Read Access Token' });

  /** `get()` 抛出来的码 → 给用户看的那句（测试按钮就靠它说清"哪一步不对"） */
  const friendly = (e, step) => {
    const code = e.code || 'NETWORK';
    if (code === 'INVALID_TOKEN') return { code, status: e.status, message: `Token 无效或无权限（HTTP ${e.status}）` };
    if (code === 'UPSTREAM_HTTP') return { code, status: e.status, message: `TMDB 返回 HTTP ${e.status}` };
    if (code === 'NOT_FOUND') return { code, status: e.status, message: `${step} 不存在（HTTP 404）` };
    return { code, status: e.status, message: e.message || '连不上 TMDB' };
  };

  /* ① 验 token：/configuration 只需鉴权、不依赖具体条目 */
  let conf;
  try {
    conf = await get('configuration', { cfg, noCache: true });
  } catch (e) {
    out.auth = { status: e.status || 0, ok: false };
    return done(friendly(e, '/configuration'));
  }
  /* `get()` 成功就是 200；这里只为了把状态码回显给用户 */
  out.auth = { status: 200, ok: true };
  const imgs = (conf && conf.images) || {};
  out.images = { secureBaseUrl: imgs.secure_base_url || '', baseUrl: imgs.base_url || '' };

  /* ② 真反查一个 id：证明「按 tmdb id 拿元数据」这条路通 */
  let j;
  try {
    j = await get(`${type}/${probeId}`, { cfg, noCache: true });
  } catch (e) {
    return done(friendly(e, `/${type}/${probeId}`));
  }
  out.item = {
    tmdbId: Number(j && j.id) || probeId,
    title: String((j && (j.name || j.title)) || ''),
    originalTitle: String((j && (j.original_name || j.original_title)) || ''),
    year: String((j && (j.first_air_date || j.release_date)) || '').slice(0, 4),
    overview: String((j && j.overview) || ''),
    poster: imageUrl(cfg.imageBase, 'w500', j && j.poster_path),
    backdrop: imageUrl(cfg.imageBase, 'w780', j && j.backdrop_path),
  };
  out.ok = true;
  return done(null);
}

module.exports = {
  DEFAULT_API_BASE,
  DEFAULT_IMAGE_BASE,
  DEFAULT_LANGUAGE,
  DEFAULT_PROBE,
  TIMEOUT_MS,
  defaults,
  effective,
  current,
  imageUrl,
  imageUrlOf,
  imageBase,
  classify,
  /* 缓存（落 data/cache/tmdb.db；通用设施见 core/cachedb.js） */
  store,
  isMetaPath,
  cacheKey,
  requestCached,
  requestWithRetry,
  get,
  search,
  test,
};
