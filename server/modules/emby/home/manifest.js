'use strict';
/**
 * 首页插件 · 规范（清单与参数的常量 + 校验）
 *
 * **面板侧与沙箱子进程共用的纯模块**：不碰 fs / net / settings，只做形状校验。
 * 之所以要共用，是因为两边都要用同一套规则：
 *   - 子进程：把插件代码跑进 vm，读出 `HomePlugin` 后按这里归一化；
 *   - 面板：子进程回报的清单**再验一遍**（子进程里跑着插件代码，不能无条件相信它的回报）。
 */
const ID_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/i;
const ROW_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/* 参数类型。早期还有一个 `page`（宿主转成数字塞进 ctx.page）—— 已删除：
 * 客户端翻页改成把 StartIndex/Limit 原样透传进 `ctx.startIndex`/`ctx.limit`，
 * 那个类型就只剩"数字参数"这一个含义，和 `count` 完全重复。 */
const PARAM_TYPES = ['input', 'enumeration', 'count', 'constant'];

const MAX_ROWS = 32;
const MAX_PARAMS_PER_ROW = 16;
/* 一个库在 Emby 协议里的「这是什么类型的库」—— 真机每个库都给这个字段
 * （实测：`movies` / `tvshows` / `playlists` / `boxsets`）。
 * 这里只认**能如实说清**的三个：影、剧、影剧混合（剩下两个是"播放列表/合集"，本项目没有这种东西）。
 * 不给 ⇒ 宿主按该行的 `type` 参数推；再推不出 ⇒ `mixed`（官方文档：null 就表示混合影剧）。 */
const COLLECTION_TYPES = ['movies', 'tvshows', 'mixed'];
/* 行可以声明它「接客户端的哪一类查询」—— 有些客户端要推荐**不用库 Id**，而是直接发一条
 * `SortBy` 描述（实测 Rex 首页第一发就是无 `ParentId` 的 `SortBy=IsFavoriteOrLiked,Random`，
 * 它喂的是首页顶部那块轮播图）。声明之后宿主会把那类查询路由到这一行；
 * **没有行声明就继续如实回空** —— 不猜、也不硬编码"第一行"。 */
const ROW_FEEDS = ['random'];
const LOAD_TIMEOUT_MS = 3000; // 顶层代码（含 HomePlugin 声明）的加载上限
const DEFAULT_RUN_TIMEOUT_MS = 15000;
const MAX_RUN_TIMEOUT_MS = 60000;

/** 带 code 的错误：面板据此映射 HTTP 状态码，子进程据此回报失败原因 */
function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

function normalizeParams(raw, where) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw fail('BAD_MANIFEST', `${where}: params 必须是数组`);
  if (raw.length > MAX_PARAMS_PER_ROW) throw fail('BAD_MANIFEST', `${where}: params 最多 ${MAX_PARAMS_PER_ROW} 个`);

  const seen = new Set();
  return raw.map((p, i) => {
    const at = `${where}.params[${i}]`;
    if (!isPlain(p)) throw fail('BAD_MANIFEST', `${at}: 必须是对象`);
    const name = str(p.name);
    if (!PARAM_NAME_RE.test(name)) throw fail('BAD_MANIFEST', `${at}: name 不合法（${name || '空'}）`);
    if (seen.has(name)) throw fail('BAD_MANIFEST', `${at}: 参数名重复：${name}`);
    seen.add(name);

    const type = str(p.type) || 'input';
    if (!PARAM_TYPES.includes(type)) {
      throw fail('BAD_MANIFEST', `${at}: type 只能是 ${PARAM_TYPES.join(' / ')}（收到 ${type}）`);
    }
    const out = {
      name,
      title: str(p.title) || name,
      type,
      value: p.value === undefined ? '' : p.value,
    };
    if (p.description !== undefined) out.description = str(p.description);
    if (type === 'enumeration') {
      const opts = Array.isArray(p.enumOptions) ? p.enumOptions : [];
      if (!opts.length) throw fail('BAD_MANIFEST', `${at}: enumeration 必须给 enumOptions`);
      out.enumOptions = opts.map((o) => ({ title: str(o && o.title), value: o && o.value }));
    }
    return out;
  });
}

/**
 * 校验 `HomePlugin` 并归一化。返回 `{ id, name, version, author, description, rows }`。
 * 归一化（而不是原样存）是为了让面板与将来的 emby 端点拿到的形状稳定。
 */
function normalizeManifest(raw) {
  if (!isPlain(raw)) throw fail('BAD_MANIFEST', '插件没有声明 HomePlugin（顶层 `HomePlugin = {…}`）');

  const id = str(raw.id);
  if (!ID_RE.test(id)) throw fail('BAD_MANIFEST', `id 不合法：${id || '(空)'}（只允许字母数字与 . _ -，3~64 位）`);

  const name = str(raw.name || raw.title);
  if (!name) throw fail('BAD_MANIFEST', '缺少 name（插件显示名）');

  const version = str(raw.version);
  if (!version) throw fail('BAD_MANIFEST', '缺少 version');

  if (!Array.isArray(raw.rows) || !raw.rows.length) throw fail('BAD_MANIFEST', 'rows 必须是非空数组');
  if (raw.rows.length > MAX_ROWS) throw fail('BAD_MANIFEST', `rows 最多 ${MAX_ROWS} 行`);

  const seen = new Set();
  const rows = raw.rows.map((r, i) => {
    const at = `rows[${i}]`;
    if (!isPlain(r)) throw fail('BAD_MANIFEST', `${at}: 必须是对象`);
    const rid = str(r.id);
    if (!ROW_ID_RE.test(rid)) throw fail('BAD_MANIFEST', `${at}: id 不合法（${rid || '空'}）`);
    if (seen.has(rid)) throw fail('BAD_MANIFEST', `${at}: 行 id 重复：${rid}`);
    seen.add(rid);

    const title = str(r.title);
    if (!title) throw fail('BAD_MANIFEST', `${at}: 缺少 title`);
    const functionName = str(r.functionName);
    if (!functionName) throw fail('BAD_MANIFEST', `${at}: 缺少 functionName`);

    const cacheDuration = Number(r.cacheDuration);
    const timeoutMs = Number(r.timeoutMs);

    /* `CollectionType` 是**行自己的声明**（这行给的是影、是剧、还是混合）—— 真实信息，不是编的。
     * 不声明就让宿主按该行当前的 `type` 参数推（见 `resolveCollectionType`）。 */
    const collectionType = str(r.collectionType).toLowerCase();
    if (collectionType && !COLLECTION_TYPES.includes(collectionType)) {
      throw fail('BAD_MANIFEST', `${at}: collectionType 只能是 ${COLLECTION_TYPES.join(' / ')}（收到 ${collectionType}）`);
    }

    /* `feed`：这一行接客户端哪一类"推荐查询"（见文件顶部 `ROW_FEEDS` 的说明）。 */
    const feed = str(r.feed).toLowerCase();
    if (feed && !ROW_FEEDS.includes(feed)) {
      throw fail('BAD_MANIFEST', `${at}: feed 只能是 ${ROW_FEEDS.join(' / ')}（收到 ${feed}）`);
    }

    return {
      id: rid,
      title,
      functionName,
      cacheDuration: Number.isFinite(cacheDuration) && cacheDuration > 0 ? cacheDuration : 0,
      timeoutMs:
        Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, MAX_RUN_TIMEOUT_MS) : DEFAULT_RUN_TIMEOUT_MS,
      params: normalizeParams(r.params, at),
      ...(collectionType ? { collectionType } : {}),
      ...(feed ? { feed } : {}),
    };
  });

  return {
    id,
    name,
    version,
    author: str(raw.author),
    description: str(raw.description),
    rows,
  };
}

module.exports = {
  ID_RE,
  ROW_ID_RE,
  PARAM_NAME_RE,
  PARAM_TYPES,
  COLLECTION_TYPES,
  ROW_FEEDS,
  MAX_ROWS,
  MAX_PARAMS_PER_ROW,
  LOAD_TIMEOUT_MS,
  DEFAULT_RUN_TIMEOUT_MS,
  MAX_RUN_TIMEOUT_MS,
  fail,
  isPlain,
  str,
  normalizeParams,
  normalizeManifest,
};
