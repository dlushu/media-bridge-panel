'use strict';
/**
 * 面板日志总线：把进程里所有 `console` 输出**再存一份到内存**，给面板「面板设置 → 日志」页看。
 *
 * **为什么包一层 `console`**（而不是挨个改调用点）：一处改动即抓到**全部**输出 —— 本项目自身的、
 * 第三方库的、Node 自己的警告。⚠️ 但**原函数照常先调用**：`docker logs` 那条路完全不受影响
 * （它才是长期留档的地方，见 docs/emby-compat.md「二」）。
 *
 * **为什么只在内存里、不落盘**：落盘就要自己实现"限大小 + 滚动删除"，而 docker 的 `json-file`
 * 驱动（`max-size 10m` × 3）**已经在做这件事**了；再写一份日志文件 = 磁盘多一份要维护的东西、
 * 还可能写满。代价是**重启后清空** —— 这是刻意的：不做持久化，就没有"半截日志文件"这种麻烦。
 *
 * **"跑久了会不会有问题"—— 三条硬约束**：
 *   ① 固定**条数**上限（默认 500，面板设置 `panel.logMax` 可调），满了**覆盖最老的**，
 *      写入是**下标回绕**（O(1)，不搬数组）；
 *   ② 单条**截断** 1000 字符；
 *   ③ 多行的值**按行拆**成多条（UI 与过滤都按行，也免得一条巨长日志把缓冲占满）。
 *   ⇒ 内存占用有硬上限（≈ 条数 × 1KB），跑多久都不涨；磁盘**零增长**。
 *
 * ⚠️ 本模块**只用保存下来的原函数**打日志（`originals`），绝不能再走 `console` ——
 * 否则自己套自己、无限递归。
 */

/** 单条最长字符数（超了截断） */
const MAX_TEXT = 1000;
/** 默认条数上限 */
const DEFAULT_MAX = 500;
/** `list()` 不给 limit 时最多回多少条（首次加载用；增量拉取由 `since` 决定） */
const DEFAULT_LIST = 200;

/** 原函数（install 时存下来） */
const originals = { log: null, info: null, warn: null, error: null };

let limit = DEFAULT_MAX;
let buf = new Array(limit);
let pos = 0; // 下一个写入位置（回绕）
let count = 0; // 当前有效条数（≤ limit）
/** 累计写入条数 —— **单调递增，任何情况下都不重置**：前端拿它当增量游标，重置会让它以为"日志倒退了" */
let seq = 0;
let installed = false;

/** 把任意值变成一行文字（对象尽量 JSON，环状/取不到就退化成 String） */
function fmt(v) {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack || String(v);
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      /* 环状引用等 → 退化 */
    }
  }
  return String(v);
}

/** 写入一条（多行值按行拆） */
function push(level, text) {
  const lines = String(text).split('\n');
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line) continue;
    seq++;
    buf[pos] = { seq, t: Date.now(), level, text: line.length > MAX_TEXT ? line.slice(0, MAX_TEXT) + '…' : line };
    pos = (pos + 1) % limit;
    if (count < limit) count++;
  }
}

/** `seq` → 环形下标。调用方保证落在缓冲范围内（`seq - count + 1 … seq`） */
function at(s) {
  const back = seq - s; // 0 = 最新
  return buf[(pos - 1 - back + limit * 2) % limit];
}

/**
 * 装上钩子。**启动时调一次**（见 `server.js`，必须在「加载模块」之前 —— 否则模块的启动日志会漏）。
 * 重复调用无副作用（幂等）；`opts.max` 给定条数上限。
 */
function install(opts) {
  if (installed) return;
  installed = true;
  resize((opts && opts.max) || DEFAULT_MAX);

  for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = (originals[level] = console[level].bind(console));
    console[level] = function patched(...args) {
      orig(...args); // ① 原样透传 —— `docker logs` 不受影响
      try {
        push(level, args.map(fmt).join(' '));
      } catch {
        /* 记日志失败绝不能影响业务 */
      }
    };
  }
}

/**
 * 取日志（给 `/api/logs`）。
 *
 * - `since`：只回**序号大于它**的（前端增量拉取的游标）；不给就回最后 `limit` 条
 * - `limit`：最多回多少条（默认 200，硬顶到缓冲容量）
 * - 返回里的 `missed`：`since` 之后、能拿到的最老一条之前**被覆盖掉**的条数（>0 说明前端漏了，
 *   界面该提示"有 N 条已被覆盖"）；`lastSeq` 是下一次该带的游标。
 */
function list(opts) {
  const o = opts || {};
  const since = Math.max(0, Number(o.since) || 0);
  const want = Math.max(1, Math.min(Number(o.limit) || DEFAULT_LIST, limit));

  const first = seq - count + 1; // 缓冲里最老那条的 seq（空缓冲时 = seq+1）
  let from = since > 0 ? Math.max(first, since + 1) : Math.max(first, seq - want + 1);
  if (seq - from + 1 > want) from = seq - want + 1; // 最多回 want 条

  const items = [];
  for (let s = from; s <= seq; s++) {
    const e = at(s);
    if (e) items.push(e);
  }
  return {
    items,
    lastSeq: seq,
    max: limit,
    total: count,
    /* since 之后拿不到的条数（被容量覆盖掉的）—— 只在增量拉取时有意义 */
    missed: since > 0 ? Math.max(0, from - 1 - since) : 0,
  };
}

/**
 * 改条数上限（面板设置改动后调，见 `panel` 模块的 `onSettingsChange`）。
 * **会清空现有缓冲，但不重置 `seq`** —— 否则前端的游标会以为"日志倒退了"。
 */
function resize(n) {
  limit = Math.max(1, Math.floor(Number(n) || DEFAULT_MAX));
  buf = new Array(limit);
  pos = 0;
  count = 0;
}

/** 清空缓冲（面板「清空」按钮）。同样**不动 `seq`** */
function clear() {
  resize(limit);
}

/** 只给面板「概览」用：当前条数 / 上限 */
function stats() {
  return { total: count, max: limit, seq };
}

module.exports = { install, list, clear, resize, stats, DEFAULT_MAX, MAX_TEXT };
