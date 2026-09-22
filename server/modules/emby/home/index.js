'use strict';
/**
 * 首页插件 · 宿主（面板侧）
 *
 * 职责：上传校验与落盘、清单管理、按行执行（缓存 / 单飞 / 超时）、条目归一化。
 * **插件代码不在面板进程里执行** —— 一律丢给 `spawn.js` 起的沙箱子进程（见那里的权限说明）。
 * 面板只做两件事：调度，以及把子进程回报的东西**再验一遍**（子进程里跑着插件，不能无条件相信）。
 *
 * **定位**：这里是「首页数据」的唯一生产者 —— 给客户端**哪些行、每行里有哪些条目、每个条目的 Id 长什么样**
 * 都由行决定；emby 层只做端点映射与翻译（把行变成媒体库 / 列表 / 推荐，见 emby-compat.md）。
 * 已接的消费端：`Views`（每个启用的行 = 一个媒体库）、`Items?ParentId=`（跑那一行）、
 * `Items/Latest`（VidHub 首页全靠它，顺序由行决定）、「推荐」查询（`SortBy` 含 `IsFavoriteOrLiked`
 * → 路由到声明了 `feed: 'random'` 的行，喂首页轮播图）。
 * **不归这里**：详情 / 搜索 / 季集 / 播放 —— 那些是"按坐标取已知的东西"，由 emby 层自己反查
 * （TMDB / 聚合），不走首页插件。
 * 其余候选端点照旧按铁律：**等客户端日志暴露请求 → 确认需要 → 才接线**。
 *
 * 对外还暴露 7 个面板自用端点（上传 / 清单 / 预览等，见 routes.js）。
 *
 * 两条与项目一致的取向：
 *   ① 插件失败**不编假数据**：照实回 `{ok:false, error}`，那一行不写缓存；
 *   ② 缓存的是**结果**不是**代码**：每次执行都重新读盘 + 重新起沙箱，插件的历史值走 Catpaw.storage。
 */
const fs = require('fs');
const path = require('path');
const spawn = require('./spawn');
const store = require('./store');
const spec = require('./manifest');

/** 单行返回条数上限（防止插件返回巨大的数组把内存吃满） */
const MAX_ITEMS = 200;
/** 缓存条目上限，超了做一次最简单的修剪（本项目规模不需要 LRU） */
const CACHE_SOFT_MAX = 300;

/** 结果缓存：key = 插件id:行id:参数JSON；只缓存成功结果 */
const cache = new Map();
/** 单飞：同 key 的并发请求共享一个 Promise，避免同时打上游 */
const flying = new Map();

function clearCache(pluginId) {
  const prefix = pluginId ? pluginId + ':' : '';
  for (const k of cache.keys()) if (!pluginId || k.startsWith(prefix)) cache.delete(k);
  for (const k of flying.keys()) if (!pluginId || k.startsWith(prefix)) flying.delete(k);
}

/** 沙箱回报的失败 → 带 code 的 Error（路由据此映射状态码） */
function throwFrom(error, fallbackCode) {
  const e = new Error((error && error.message) || '沙箱未返回结果');
  e.code = (error && error.code) || fallbackCode || 'SANDBOX';
  if (error && error.status !== undefined) e.status = error.status;
  if (error && error.data !== undefined) e.data = error.data;
  return e;
}

/* ------------------------------------------------ 媒体库 Id（Views 端点用） */

/**
 * 首页插件的一行 → Emby 的一个媒体库（`Users/{id}/Views` 里的 `CollectionFolder`）。
 *
 * Id = `catpawhome_` + base64url(`<插件id>|<行id>`)：
 *   - **稳定**：插件行不变则 Id 不变 —— 客户端拿它当主键缓存，飘了「已看」就丢；
 *   - **必须整体编码**：插件 id 与行 id 都允许 `.`/`_`/`-`，用分隔符硬拼根本没法可靠反解；
 *     而 base64url 的字符集只有 `[A-Za-z0-9_-]`，URL 安全（不会像 `#` 那样被客户端当锚点吃掉 ——
 *     同 `service.catpawSourceId` 那次的教训）；
 *   - 与 `tmdb_*` 前缀天然不冲突：`tmdb.parseItemId` 认不出它，所以它只属于 Views。
 */
const VIEW_PREFIX = 'catpawhome_';

function viewId(pluginId, rowId) {
  return VIEW_PREFIX + Buffer.from(`${pluginId}|${rowId}`, 'utf8').toString('base64url');
}

/** viewId() 的逆 —— 与它挨着放（改格式时一眼看到要一起改）；认不出返回 null */
function parseViewId(id) {
  const s = spec.str(id);
  if (!s.startsWith(VIEW_PREFIX)) return null;
  let payload;
  try {
    payload = Buffer.from(s.slice(VIEW_PREFIX.length), 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const i = payload.indexOf('|');
  if (i <= 0 || i === payload.length - 1) return null;
  const pluginId = payload.slice(0, i);
  const rowId = payload.slice(i + 1);
  if (!spec.ID_RE.test(pluginId) || !spec.ROW_ID_RE.test(rowId)) return null;
  return { pluginId, rowId };
}

/**
 * 一个库在 Emby 协议里的 `CollectionType`（真机**每个库都给**这个字段：`movies`/`tvshows`/…）。
 *
 * 顺序：**行自己声明的** → 按该行当前的 `type` 参数推（`movie`→`movies` / `tv`→`tvshows`）→ `mixed`。
 *
 * 为什么声明优先：`regional_series` 这类行没有 `type` 参数，但它在 TMDB 那边就是剧 ——
 * 只有插件作者说得准。而按参数推的那档永远跟内容一致（用户把参数切到"剧集"，库就变 `tvshows`）。
 * 都推不出就 `mixed`：官方文档写明 null 就表示混合影剧、按通用方式展示；这里交付的本来就是混合内容。
 */
function resolveCollectionType(row, saved) {
  if (row.collectionType) return row.collectionType;
  const v = String(mergeParamValues(row.params, saved).type || '').toLowerCase();
  if (v === 'movie') return 'movies';
  if (v === 'tv') return 'tvshows';
  return 'mixed';
}

/**
 * 所有「启用的」插件行 —— Views 每个行做一个库。
 * 用 registry 的快照（不加载插件代码、不起沙箱）：Views 是高频端点，没必要为它跑沙箱。
 */
function enabledRows() {
  const out = [];
  for (const p of store.list()) {
    if (!p || !p.enabled) continue;
    for (const row of p.rows || []) {
      out.push({
        pluginId: p.id,
        rowId: row.id,
        title: row.title,
        pluginName: p.name,
        collectionType: resolveCollectionType(row, (p.params || {})[row.id]),
      });
    }
  }
  return out;
}

/**
 * 找**声明接某个 `feed` 的行**（第一个命中的），没找到回 `null`。
 *
 * 用来把客户端"不要库 Id、只要推荐"的查询（见 `service.feedOfQuery`）路由到插件指定的那一行。
 * **返回 null 就让调用方如实回空** —— 绝不"随便挑一行顶上"：挑错了等于用内容撒谎，
 * 而且哪个插件接哪条查询只有插件作者知道（清单里的 `feed` 就是他的声明）。
 */
function rowByFeed(feed) {
  const want = spec.str(feed);
  if (!want) return null;
  for (const p of store.list()) {
    if (!p || !p.enabled) continue;
    for (const row of p.rows || []) {
      if (row.feed === want) return { pluginId: p.id, rowId: row.id, title: row.title };
    }
  }
  return null;
}

/**
 * 只读地看一眼某一行**已经在内存缓存里**的结果（没有就 `null`）—— **绝不触发上游**。
 *
 * 给 `Views` 的库封面用（见 `service.homeViewItem`）：封面只能从"这一行已经拿到过的条目"里取，
 * 而**专门为封面去打一次上游是不行的** —— 那份代价随行数线性增长，属于已明确排除的做法。
 * 所以这里只认缓存：客户端逛过一次之后才有封面，面板刚重启的那一次没有。
 *
 * 缓存键带 `startIndex`/`limit`（见 `runRow`），翻页是不同的键 —— 所以**按前缀扫**、取最新放进来的那条：
 * 对"取一张封面"来说第几页都行。
 */
function peekRowItems(pluginId, rowId) {
  const prefix = `${pluginId}:${rowId}:`;
  const now = Date.now();
  let best = null;
  let bestAt = -1;
  for (const [k, v] of cache) {
    if (!k.startsWith(prefix)) continue;
    if (!v || v.expiresAt <= now || !v.result || !v.result.ok) continue;
    if ((v.storedAt || 0) > bestAt) {
      bestAt = v.storedAt || 0;
      best = v;
    }
  }
  return best ? best.result.items || [] : null;
}

/* ----------------------------------------------------------- 列表查询路由 */

/**
 * 把一条 Emby 列表查询路由到某个插件行 —— **列表数据由首页模块决定，emby 层只调这一个口子**。
 *
 * 现在只认 `ParentId=<catpawhome_…>`（= 本模块发给客户端的某个媒体库，见 `viewId`）；
 * 其余查询回 `null` =「不归本模块管」，由 emby 层如实回空。
 * 以后要认 `Filters` / `SortBy` 那几类固定行，**改这里就行**，调用方（emby 层）不用动。
 *
 * **分页是原样透传的**：客户端的 `StartIndex` / `Limit` 直接进 `ctx`（见「九、分页」），
 * 取哪一页、要不要按页打上游由**插件**决定；emby 层与这里都**不切片**。
 *
 * @returns {Promise<{items:object[], total:number, pluginId:string, rowId:string, cached:boolean}|null>}
 *          插件行取数失败时**抛错**（调用方照实回失败码，不编空数据）
 */
async function listByQuery(query) {
  const get = (k) => (query && typeof query.get === 'function' ? query.get(k) || '' : '');
  const parsed = parseViewId(get('ParentId'));
  if (!parsed) return null;

  const paging = { startIndex: Number(get('StartIndex')) || 0, limit: Number(get('Limit')) || 0 };
  const r = await runRow(parsed.pluginId, parsed.rowId, null, paging);
  if (!r.ok) {
    const info = r.error || {};
    const e = spec.fail(info.code || 'PLUGIN_ERROR', info.message || '插件行取数失败');
    if (info.status !== undefined) e.status = info.status;
    if (info.data !== undefined) e.data = info.data;
    throw e;
  }
  return {
    items: r.items || [],
    total: r.total,
    pluginId: parsed.pluginId,
    rowId: parsed.rowId,
    cached: !!r.cached,
  };
}

/* ------------------------------------------------------------- 条目归一化 */

/**
 * 一个 HomeItem。**只保留规范里列出的字段，其余一律丢弃**（含原型上的东西）——
 * 这样将来映射到 Emby BaseItemDto 时形状是可控的。
 * 缺 id / title / 合法 type 的条目直接丢。
 *
 * 这一步刻意留在面板侧：输入虽来自子进程，但子进程里跑着插件代码，不该由它决定进缓存什么。
 */
function normalizeItem(it) {
  if (!spec.isPlain(it)) return null;
  const id = spec.str(it.id);
  const title = spec.str(it.title);
  const type = spec.str(it.type).toLowerCase();
  if (!id || !title) return null;
  if (type !== 'movie' && type !== 'tv') return null;

  const out = { id, type, title };
  if (it.originalTitle !== undefined) out.originalTitle = spec.str(it.originalTitle);
  const year = Number(it.year);
  if (Number.isFinite(year) && year > 0) out.year = Math.trunc(year);
  if (it.overview !== undefined) out.overview = spec.str(it.overview);
  const rating = Number(it.rating);
  if (Number.isFinite(rating) && rating > 0) out.rating = rating;
  const poster = httpUrl(it.poster);
  if (poster) out.poster = poster;
  const backdrop = httpUrl(it.backdrop);
  if (backdrop) out.backdrop = backdrop;
  if (Array.isArray(it.genres)) {
    const g = it.genres.map(spec.str).filter(Boolean);
    if (g.length) out.genres = g.slice(0, 20);
  }
  if (spec.isPlain(it.providerIds)) {
    const p = {};
    for (const [k, v] of Object.entries(it.providerIds)) {
      const s = spec.str(v);
      if (s && k) p[spec.str(k)] = s;
    }
    if (Object.keys(p).length) out.providerIds = p;
  }
  if (spec.isPlain(it.catpaw)) {
    const site = spec.str(it.catpaw.site);
    const vodId = spec.str(it.catpaw.vodId);
    if (site || vodId) out.catpaw = { site, vodId };
  }
  return out;
}

const httpUrl = (v) => {
  const s = spec.str(v);
  return /^https?:\/\//i.test(s) ? s : '';
};

/** 归一化一整行：接受数组或 `{items:[…]}`；按 id 去重；超过上限的计入 dropped */
function normalizeItems(raw) {
  const list = spec.isPlain(raw) && Array.isArray(raw.items) ? raw.items : raw;
  if (!Array.isArray(list)) throw spec.fail('BAD_RESULT', 'handler 必须返回数组（或 {items:[…]}）');

  const items = [];
  const seen = new Set();
  let dropped = 0;
  let dup = 0;
  for (const it of list) {
    const n = normalizeItem(it);
    if (!n) {
      dropped++;
      continue;
    }
    if (seen.has(n.id)) {
      dup++;
      continue;
    }
    if (items.length >= MAX_ITEMS) {
      dropped++;
      continue;
    }
    seen.add(n.id);
    items.push(n);
  }
  return { items, dropped, dup };
}

/* --------------------------------------------------------------- 参数值 */

/** 声明默认值 ← 已保存值 ← 本次临时覆盖；count 顺带转数字 */
function mergeParamValues(decls, saved, overrides) {
  const out = {};
  for (const p of decls || []) {
    let v = p.value;
    if (saved && Object.prototype.hasOwnProperty.call(saved, p.name)) v = saved[p.name];
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, p.name)) v = overrides[p.name];
    if (p.type === 'count') v = Number(v) || Number(p.value) || 0;
    out[p.name] = v;
  }
  return out;
}

/** 只留清单里声明过的 row / param，值按类型转一下（防止面板 POST 任意键进 registry） */
function sanitizeParams(input, rows) {
  const out = {};
  if (!spec.isPlain(input)) return out;
  for (const row of rows || []) {
    const src = input[row.id];
    if (!spec.isPlain(src)) continue;
    const vals = {};
    for (const p of row.params || []) {
      if (!Object.prototype.hasOwnProperty.call(src, p.name)) continue;
      vals[p.name] = p.type === 'count' ? Number(src[p.name]) || 0 : spec.str(src[p.name]);
    }
    if (Object.keys(vals).length) out[row.id] = vals;
  }
  return out;
}

/** 覆盖更新时保留「还在新清单里」的已保存参数值 */
function mergeParams(existing, manifest) {
  const old = (existing && existing.params) || {};
  const out = {};
  for (const row of manifest.rows) {
    const src = old[row.id];
    if (!spec.isPlain(src)) continue;
    const vals = {};
    for (const p of row.params) {
      if (Object.prototype.hasOwnProperty.call(src, p.name)) vals[p.name] = src[p.name];
    }
    if (Object.keys(vals).length) out[row.id] = vals;
  }
  return out;
}

/* --------------------------------------------------------------- 对外形状 */

/** 对外的插件形状（不含文件路径，也不含任何源码） */
function publicPlugin(m) {
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    /* 内置示例：面板据此显示「内置」并**不提供删除入口**（服务端也拦，见 removePlugin） */
    builtin: isBuiltin(m.id),
    author: m.author || '',
    description: m.description || '',
    fileName: m.fileName || '',
    size: m.size || 0,
    md5: m.md5 || '',
    enabled: !!m.enabled,
    params: m.params || {},
    rows: m.rows || [],
    uploadedAt: m.uploadedAt || '',
    updatedAt: m.updatedAt || '',
  };
}

/* ----------------------------------------------------------------- 管理 */

function listPlugins() {
  return store.list().map(publicPlugin);
}

function getPlugin(id) {
  const m = store.get(id);
  return m ? publicPlugin(m) : null;
}

/**
 * 上传（新增或覆盖）。顺序刻意是「先让沙箱加载校验，再决定要不要写盘」——
 * 非法插件绝不能留下半份文件。
 * @returns {Promise<{ unchanged:boolean, created:boolean, plugin:object }>}
 */
async function install({ code, fileName = '', overwrite = false, builtin = false } = {}) {
  const buf = Buffer.from(String(code === undefined || code === null ? '' : code), 'utf8');
  if (!buf.length) throw spec.fail('EMPTY', '插件内容为空');
  if (buf.length > store.MAX_CODE_BYTES) {
    throw spec.fail('TOO_LARGE', `插件源码 ${buf.length} 字节，超过上限 ${store.MAX_CODE_BYTES} 字节（1MB）`);
  }
  const text = buf.toString('utf8');
  const hash = store.md5(buf);

  /* 面板这侧**不执行**插件：把代码交给沙箱子进程，拿回清单。
   * 占位 id「(校验)」不落盘（storage 写入有 ID_RE 守卫），插件顶层读 storage 会拿到空对象。 */
  let done;
  try {
    done = await spawn.runJob({
      pluginId: '(校验)',
      code: text,
      mode: 'manifest',
      timeoutMs: spec.LOAD_TIMEOUT_MS,
      storage: {},
    });
  } catch (e) {
    /* 面板硬杀（顶层同步死循环）在语义上等于加载超时，报成 400 而不是 500 */
    if (e && e.code === 'TIMEOUT') {
      throw spec.fail('LOAD_TIMEOUT', `插件加载超时（${spec.LOAD_TIMEOUT_MS}ms，疑似顶层死循环）`);
    }
    throw e;
  }
  if (!done.ok) throw throwFrom(done.error, 'BAD_MANIFEST');

  /* 子进程回报的清单**再验一遍**（它是从跑着插件的进程里出来的） */
  const manifest = spec.normalizeManifest(done.manifest);

  /* 内置示例的 id 是**保留**的：随包那份由 `ensureBuiltin()` 负责装，
   * 用户不能拿它当上传目标 —— 否则"默认那份"就被顶掉了，而它本该永远在。 */
  if (isBuiltin(manifest.id) && !builtin) {
    throw spec.fail(
      'RESERVED',
      `「${BUILTIN_ID}」是内置示例的保留 id（随面板发行、删不掉），不能上传覆盖 —— 请改一个 id 再传`
    );
  }

  const existing = store.get(manifest.id);
  if (existing && existing.md5 === hash) {
    return { unchanged: true, created: false, plugin: publicPlugin(existing) };
  }
  if (existing && !overwrite) {
    const e = spec.fail('EXISTS', `插件 id「${manifest.id}」已存在（v${existing.version}）；要更新请带 overwrite`);
    e.existing = publicPlugin(existing);
    throw e;
  }

  store.writeCode(manifest.id, text);

  const now = new Date().toISOString();
  const meta = Object.assign({}, manifest, {
    fileName: path.basename(spec.str(fileName)) || 'index.js',
    size: buf.length,
    md5: hash,
    enabled: existing ? !!existing.enabled : true,
    params: mergeParams(existing, manifest),
    uploadedAt: existing ? existing.uploadedAt || now : now,
    updatedAt: now,
  });
  store.put(meta);
  clearCache(manifest.id);
  return { unchanged: false, created: !existing, plugin: publicPlugin(meta) };
}

/** 改 enabled / name / params（改代码走重新上传） */
function updatePlugin(id, patch = {}) {
  const meta = store.get(id);
  if (!meta) throw spec.fail('NOT_FOUND', '插件不存在：' + id);

  const next = Object.assign({}, meta);
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.name !== undefined) {
    const name = spec.str(patch.name);
    if (!name) throw spec.fail('BAD_INPUT', 'name 不能为空');
    next.name = name;
  }
  if (patch.params !== undefined) {
    /* 按行深合并再净化：只提交某一行时**不能把其它行已保存的值抹掉**
     * （sanitizeParams 是「只留声明过的键」，直接吃 patch 会把未声明的行全丢掉）。 */
    const merged = Object.assign({}, next.params);
    for (const [rid, vals] of Object.entries(spec.isPlain(patch.params) ? patch.params : {})) {
      merged[rid] = Object.assign({}, spec.isPlain(merged[rid]) ? merged[rid] : {}, spec.isPlain(vals) ? vals : {});
    }
    next.params = sanitizeParams(merged, next.rows);
  }
  next.updatedAt = new Date().toISOString();

  store.put(next);
  clearCache(id);
  return publicPlugin(next);
}

function removePlugin(id) {
  /* 内置示例删不掉：它随面板发行，开机又会装回来 —— 与其"删了又冒出来"让人困惑，不如直接拒绝 */
  if (isBuiltin(id)) {
    throw spec.fail(
      'BUILTIN',
      `内置示例（${BUILTIN_ID}）不能删除：它随面板发行，重启会自动装回来。要停用它请关掉「启用」开关`
    );
  }
  if (!store.remove(id)) return false;
  clearCache(id);
  return true;
}

/* ----------------------------------------------------------------- 执行 */

/** 跑一行 —— 起一个沙箱子进程；沙箱自身的故障（起不来 / 被杀 / 异常退出）也算这一行失败 */
async function executeRow(id, code, row, params, paging) {
  /* 报的耗时是**面板这边的墙钟**（含起子进程 ~40ms 与 IPC），不是子进程自报的 handler 耗时 ——
   * 前者才是「点一下运行要等多久」，也让缓存命中/未命中的差别看得见。 */
  const t0 = Date.now();
  let done;
  try {
    done = await spawn.runJob({
      pluginId: id,
      code,
      mode: 'run',
      rowId: row.id,
      params,
      /* 分页**原样透传**（emby 层取出来的 StartIndex/Limit）；沙箱不切片 */
      startIndex: paging.startIndex,
      limit: paging.limit,
      timeoutMs: row.timeoutMs,
      storage: store.readStorage(id),
    });
  } catch (e) {
    return { ok: false, error: { code: (e && e.code) || 'SANDBOX', message: String((e && e.message) || e) }, ms: Date.now() - t0 };
  }

  const ms = Date.now() - t0;
  if (!done.ok) {
    return { ok: false, error: done.error || { code: 'SANDBOX', message: '沙箱未返回结果' }, ms };
  }

  try {
    /* 插件可以回 `{ items, total }`（`total` → `TotalRecordCount`，翻页要靠它）；
     * 只回数组也行 —— 那时 total 就是本页条数（如实：插件没说自己总共有多少）。 */
    const raw = done.items;
    const declared = spec.isPlain(raw) ? Number(raw.total) : NaN;
    const n = normalizeItems(raw);
    const total = Number.isFinite(declared) && declared > 0 ? declared : n.items.length;
    return { ok: true, items: n.items, total, dropped: n.dropped, dup: n.dup, ms };
  } catch (e) {
    return { ok: false, error: { code: (e && e.code) || 'BAD_RESULT', message: String((e && e.message) || e) }, ms };
  }
}

/**
 * 跑一行。任何执行失败都以 `{ ok:false, error }` 返回（HTTP 仍 200），与 /api/panel/tmdb/test 同一取向。
 * 插件不存在 / 行不存在 / 文件缺失 → **抛错**（由路由映射 404），那是调用方的问题不是插件的问题。
 *
 * `paging = { startIndex, limit }`：由调用方从客户端请求里取出来原样透传（面板预览不传 = 都不限）。
 * ⚠️ **它必须进缓存键** —— 同一行的第 1 页和第 2 页是两个不同的结果，混了就会串页。
 */
async function runRow(id, rowId, overrides, paging) {
  const meta = store.get(id);
  if (!meta) throw spec.fail('NOT_FOUND', '插件不存在：' + id);
  const code = store.readCode(id);
  if (code === null) throw spec.fail('NOT_FOUND', `插件文件缺失（请重新上传）：${id}/index.js`);

  const row = (meta.rows || []).find((r) => r.id === rowId);
  if (!row) throw spec.fail('NOT_FOUND', `行不存在：${id}/${rowId}`);

  const page = {
    startIndex: Math.max(0, Number(paging && paging.startIndex) || 0),
    limit: Math.max(0, Number(paging && paging.limit) || 0),
  };
  const params = mergeParamValues(row.params, (meta.params || {})[rowId], overrides);
  const key = `${id}:${rowId}:${JSON.stringify(params)}:${page.startIndex}:${page.limit}`;
  const now = Date.now();

  const hit = cache.get(key);
  /* 命中缓存：耗时报 0（记的是**这一次请求**等了多久），而不是当初那次跑了多久 */
  if (hit && hit.expiresAt > now) return Object.assign({}, hit.result, { cached: true, ms: 0, params });

  const inflight = flying.get(key);
  if (inflight) {
    const r = await inflight;
    return Object.assign({}, r, { cached: false, shared: true, params });
  }

  const task = executeRow(id, code, row, params, page);
  flying.set(key, task);
  let out;
  try {
    out = await task;
  } finally {
    flying.delete(key);
  }

  /* 成功才缓存；cacheDuration = 0 全程不缓存。存的是结果本身，params 每次现算（别串味） */
  if (out.ok && row.cacheDuration > 0) {
    cache.set(key, { result: out, expiresAt: Date.now() + row.cacheDuration * 1000, storedAt: Date.now() });
    if (cache.size > CACHE_SOFT_MAX) {
      for (const [k, v] of cache) {
        if (cache.size <= CACHE_SOFT_MAX / 2) break;
        if (v.expiresAt <= Date.now()) cache.delete(k);
      }
    }
  }
  return Object.assign({}, out, { cached: false, params });
}

/** 随包发行的插件开发文档（`GET /api/emby/home/skill` 发它） */
const SKILL_FILE = 'plugin-dev.skill.md';

/** 参考插件源码（给面板「下载示例」；读文本，**不 require** —— 它顶层是裸赋值） */
function exampleCode() {
  return fs.readFileSync(path.join(__dirname, 'example.plugin.js'), 'utf8');
}

/**
 * 插件开发文档（给面板「下载开发文档」）。
 *
 * 随包发行的**面向用户**那份（SKILL.md 格式，带 frontmatter，可以直接丢进
 * agents 的 skills 目录让 AI 照着写插件）。与 `example.plugin.js` 并列存放，
 * 所以跟示例一样**随代码更新**，不需要另做发布流程。
 */
function skillDoc() {
  return fs.readFileSync(path.join(__dirname, SKILL_FILE), 'utf8');
}

/* ------------------------------------------------------- 内置示例（不可删除） */

/**
 * 内置示例的**保留 id** —— 必须与 `example.plugin.js` 里的 `id` 一致
 * （`ensureBuiltin()` 会校验，不一致就当发布事故报出来）。
 */
const BUILTIN_ID = 'example.tmdb';
const BUILTIN_FILE = 'example.plugin.js';

const isBuiltin = (id) => String(id) === BUILTIN_ID;

/**
 * 确保内置示例在位（面板启动时调，见 `server.js` 的 `embyModule.autostart()`）。
 *
 * 内置示例就是**随包发布的 `example.plugin.js`**：它要始终出现在插件列表里，而且**删不掉**。
 * 实现上**不是"虚拟条目"**，而是**开机时按 md5 同步进 data 目录**（跟源文件那套 md5 校验一个思路）：
 *
 *   · 没装过            → 装上
 *   · 装过、内容不一样   → **覆盖更新**（面板升级带来的新示例就靠这条生效；
 *                         `install` 会**保留**已启用的状态与已保存参数）
 *   · 内容一致          → 跳过（别每次重启都写盘、也别把运行中的缓存白清一遍）
 *
 * 为什么这么做：`listPlugins()` / `enabledRows()` 都是**同步**读 registry 的
 * （`Views` 每次现读）。走"同步进 registry"这条路，宿主里**不用为内置条目特判**；
 * 代价只是 data 目录里多一份副本 —— 而那份副本**每次开机都会与随包文件对齐**，不会悄悄过期。
 */
async function ensureBuiltin() {
  const code = exampleCode();
  const hash = store.md5(Buffer.from(code, 'utf8'));
  const existing = store.get(BUILTIN_ID);
  if (existing && existing.md5 === hash) return { unchanged: true, plugin: publicPlugin(existing) };

  const out = await install({ code, fileName: BUILTIN_FILE, overwrite: true, builtin: true });
  if (!out.plugin || out.plugin.id !== BUILTIN_ID) {
    throw spec.fail(
      'BAD_MANIFEST',
      `内置示例的 id 应该是「${BUILTIN_ID}」，实际是「${(out.plugin && out.plugin.id) || '(空)'}」—— 请检查 ${BUILTIN_FILE}`
    );
  }
  return out;
}

module.exports = {
  BUILTIN_ID,
  isBuiltin,
  ensureBuiltin,
  MAX_ITEMS,
  viewId,
  parseViewId,
  enabledRows,
  peekRowItems,
  rowByFeed,
  listByQuery,
  listPlugins,
  getPlugin,
  install,
  updatePlugin,
  removePlugin,
  runRow,
  exampleCode,
  skillDoc,
  clearCache,
};
