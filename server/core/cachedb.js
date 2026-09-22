'use strict';
/**
 * 通用本地缓存（Node 内置 `node:sqlite`，零依赖）—— **所有缓存表的唯一设施**
 *
 * 由 `modules/emby/cache.js` 抽出：缓存不再只归 emby 用，
 * TMDB 元数据缓存与「名字 → 搜索结果」索引要被 emby **和**聚合层共用，
 * 而依赖是单向的 `emby → agg → core` —— agg 不能去读 emby 的东西。
 * 所以「开库 / TTL / 按字节 LRU 淘汰 / 统计 / 清空」这套通用能力放在 core，
 * 各有各策略的调用方（`core/tmdb.js`、`modules/emby/cache.js`、`modules/agg/cache.js`）各自建一个 store。
 *
 * —— 淘汰策略：TTL + 字节上限 + LRU，三者各管一件事 ——
 *   · TTL（按时间）管**正确性** —— 元数据会变（评分、简介、海报更换）
 *   · 字节上限管**空间** —— 片库上不封顶，不设限会一直涨
 *   · 两者都不管「冷热」—— 所以按 `used_at` 做 LRU，把冷门挤出去
 * **上限必须按字节不能按条数**：实测 lean 响应 1.9KB、rich 119KB，**差 60 倍**，按条数根本算不准。
 *
 * ⚠️ **一个文件一个 store、一个 store 一个句柄**（同 label 重复 create 会拿到同一个实例）：
 * 同一进程里两个句柄指向同一个库，在 WAL 下会互相锁。
 *
 * ⚠️ 这里存的一律是**可丢弃**数据：删库 = 重新抓一遍。所以 `clearAll()`（面板「清空缓存」）
 * 可以放心清 - 但**别把不可再生的东西塞进来**（曾经的 `view_seen`「库首次出现时刻」就因为
 * 丢了会让所有库的 `DateCreated` 跳到今天，而被刻意排除在清空之外；那张表已随
 * 「库 DateCreated 改成占位值」一起删除）。
 */
const fs = require('fs');
const path = require('path');

const settings = require('./settings');

/** 读命中时**最多每小时**刷一次 used_at：LRU 需要"最近用过"这个信息，但每次读都写库
 * 会把缓存变成写放大源（尤其图片索引，一次列表渲染就是几十次读）。一小时粒度足够。 */
const USED_REFRESH_MS = 60 * 60 * 1000;

/**
 * 「名字 → TMDB 搜索结果」的固定口径（不进面板设置：它不是用户要调的旋钮）。
 * 6 小时 = 原来内存 Map 的值，**故意不拉长** —— 这张表将来还要喂 emby 的搜索端点
 * （用户搜"斗破"想看的是"现在有哪些"），结果集敏感、越新越好。
 * 只存**有结果**的成功响应（负结果不存：存了会让新上线的别名条目永远看不见）。
 */
const NAME_TTL_MS = 6 * 60 * 60 * 1000;
const NAME_MAX_BYTES = 2 * 1024 * 1024;

/** 面板可改的默认值（「面板设置 → 缓存设置」）。**只有这一处**，core/tmdb.js 与 emby/cache.js 都从这里取 */
const DEFAULTS = {
  tmdbTtlDays: 30,
  tmdbMaxMB: 200,
  imageTtlDays: 90,
  imageMaxMB: 5,
  /** 聚合详情缓存（`detail_cache`，见 agg/cache.js）：**按分钟**，因为它是秒级~分钟级的短缓存。
   *  0 = 不缓存（与上面「天数 0 = 不缓存」同一口径）；勾了「长期有效」时这个数不看。
   *  `detailMaxMB` = 总字节上限，**可调**（「面板设置 → 缓存设置」，0 = 不限）。
   *  默认 32MB 是实测值：一条快照含全站的线路与选集，而每个选集 ID 就是 600~720 字符的 token
   *  （且那条详情里存了两份：站源原始响应 + 解析结果），实测几十~几百 KB 一条。 */
  detailTtlMinutes: 60,
  detailNeverExpire: false,
  detailMaxMB: 32,
};

/**
 * 「长期有效」用的 TTL：写 `expires_at = now + 这个数`（约 100 年）。
 * 不写 0/Infinity —— `enforce()` 判的是 `expires_at <= now`，0 等于"写完即过期"，
 * 而 Infinity 落库会变成 NULL/精度问题，所以给一个够远的有限值。
 */
const NEVER_TTL_MS = 100 * 365 * 86400000;

/**
 * 当前缓存策略（毫秒/字节），读**面板设置**的 `cache.*`（由 emby 设置迁入：
 * 缓存统一在「面板设置」管，见 panel/index.js 的 fields）。
 * ⚠️ 两个 0 的语义**不一样**：天数 0 = 不缓存（写完即过期）；上限 0 = **不限**（见 enforce）。
 */
function cfg() {
  const c = (settings.read('panel') || {}).cache || {};
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  const detailMinutes = num(c.detailTtlMinutes, DEFAULTS.detailTtlMinutes);
  return {
    tmdbTtlMs: num(c.tmdbTtlDays, DEFAULTS.tmdbTtlDays) * 86400000,
    tmdbMaxBytes: num(c.tmdbMaxMB, DEFAULTS.tmdbMaxMB) * 1024 * 1024,
    imageTtlMs: num(c.imageTtlDays, DEFAULTS.imageTtlDays) * 86400000,
    imageMaxBytes: num(c.imageMaxMB, DEFAULTS.imageMaxMB) * 1024 * 1024,
    /* 「长期有效」勾了就无视分钟数（`detailNeverExpire` 是布尔，不是数字） */
    detailTtlMs: c.detailNeverExpire ? NEVER_TTL_MS : detailMinutes * 60000,
    detailMaxBytes: num(c.detailMaxMB, DEFAULTS.detailMaxMB) * 1024 * 1024,
  };
}

/** 各表的字节上限来自哪个设置的哪一项（sweepAll 用） */
const TABLE_CAP = {
  tmdb_cache: (c) => c.tmdbMaxBytes,
  image_index: (c) => c.imageMaxBytes,
  name_index: () => NAME_MAX_BYTES,
  detail_cache: (c) => c.detailMaxBytes,
};

/** 已建的 store（label → store）：面板的「用量 / 清空 / 设置变更后扫一遍」靠它一把抓 */
const stores = new Map();

/**
 * 建一个 store（同 label 幂等）。`tables` 里的每张表都是「key → value + TTL + LRU」的同一种形状。
 */
function createStore({ label, dir, file, tables }) {
  const existing = stores.get(label);
  if (existing) return existing;
  if (!label || !dir || !file || !Array.isArray(tables) || !tables.length) {
    throw new Error('createStore 需要 label / dir / file / tables');
  }

  const filePath = path.join(dir, file);
  let db = null;

  /** 打开（首次会建库建表）；老 Node 上给一句人话报错 */
  function open() {
    if (db) return db;

    let DatabaseSync;
    try {
      ({ DatabaseSync } = require('node:sqlite'));
    } catch {
      throw new Error(`本面板需要 Node ≥ 22.13 才能使用内置 sqlite（当前 ${process.version}），请升级 Node 后重启`);
    }

    fs.mkdirSync(dir, { recursive: true });
    db = new DatabaseSync(filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* 平台不支持就算了，不因此起不来 */
    }

    /* 与 `emby.db`（账号，DELETE journal）相反，缓存**用 WAL**：高写入负载要读写并发；
     * `synchronous = NORMAL` 少一次 fsync/事务 —— 掉电最多丢最近几条缓存，无所谓。 */
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA busy_timeout = 5000;');

    for (const t of tables) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ${t} (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          bytes      INTEGER NOT NULL,   -- 为「按字节淘汰」记账；SQLite 不能对 TEXT 求和
          created_at INTEGER NOT NULL,
          used_at    INTEGER NOT NULL,   -- LRU 依据；读命中时按 USED_REFRESH_MS 节流刷新
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ${t}_expires ON ${t}(expires_at);
      `);
    }
    return db;
  }

  /** 读一条；过期视为不存在（顺手删掉，免得越积越多）。命中且久未刷新则刷 `used_at` */
  function get(table, key) {
    const d = open();
    const now = Date.now();
    const row = d.prepare(`SELECT value, used_at, expires_at FROM ${table} WHERE key = ?`).get(String(key));
    if (!row) return null;
    if (row.expires_at <= now) {
      d.prepare(`DELETE FROM ${table} WHERE key = ?`).run(String(key));
      return null;
    }
    if (now - row.used_at > USED_REFRESH_MS) {
      d.prepare(`UPDATE ${table} SET used_at = ? WHERE key = ?`).run(now, String(key));
    }
    return row.value;
  }

  /** 某表的总字节数 */
  function totalBytes(table) {
    return open().prepare(`SELECT COALESCE(SUM(bytes), 0) AS b FROM ${table}`).get().b;
  }

  /**
   * 淘汰：先清过期，再按 `used_at` 从旧到新删到上限以内。
   * `maxBytes <= 0` = 不限（只清过期）。
   */
  function enforce(table, maxBytes) {
    const d = open();
    d.prepare(`DELETE FROM ${table} WHERE expires_at <= ?`).run(Date.now());

    const cap = Number(maxBytes) || 0;
    if (cap <= 0) return;
    let total = totalBytes(table);
    if (total <= cap) return;

    /* 只在上限被突破时才全表排序 —— 日常写入不会走到这里 */
    const rows = d.prepare(`SELECT key, bytes FROM ${table} ORDER BY used_at ASC`).all();
    const del = d.prepare(`DELETE FROM ${table} WHERE key = ?`);
    for (const r of rows) {
      if (total <= cap) break;
      del.run(r.key);
      total -= r.bytes;
    }
  }

  /**
   * 写一条（已存在则覆盖，并把 created_at 一起刷新 —— 「重新拿到过」即视为新数据）。
   * 写完按 `maxBytes` 做一次淘汰。
   */
  function put(table, key, value, ttlMs, maxBytes) {
    const d = open();
    const now = Date.now();
    const text = String(value);
    d.prepare(
      `INSERT INTO ${table} (key, value, bytes, created_at, used_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value, bytes = excluded.bytes, created_at = excluded.created_at,
         used_at = excluded.used_at, expires_at = excluded.expires_at`
    ).run(String(key), text, Buffer.byteLength(text, 'utf8'), now, now, now + Math.max(0, Number(ttlMs) || 0));
    enforce(table, maxBytes);
  }

  /** 各表各占多少（条数 + 字节）；面板据此显示「已用 x / 上限 y」 */
  function stats() {
    const d = open();
    const out = {};
    for (const t of tables) {
      const rows = d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
      out[t] = { rows, bytes: totalBytes(t) };
    }
    return out;
  }

  /** 清空本 store 的全部表（删的都是**可丢弃**数据；账号在别的库，永远不动） */
  function clear() {
    const d = open();
    for (const t of tables) d.exec(`DELETE FROM ${t}`);
    d.exec('VACUUM;');
  }

  /** 按给定上限扫一遍（`{ 表名: 字节上限 }`，缺的跳过） */
  function sweep(limits) {
    const l = limits || {};
    for (const t of Object.keys(l)) {
      if (tables.includes(t)) enforce(t, l[t]);
    }
  }

  const store = { label, path: filePath, tables, open, get, put, enforce, totalBytes, stats, clear, sweep };
  stores.set(label, store);
  return store;
}

/** 已建的 store（面板层用；顺序即创建顺序） */
function listStores() {
  return [...stores.values()];
}

/** 所有 store、所有表的用量：`{ <label>: { path, tables: { <table>: {rows, bytes} } } }` */
function statsAll() {
  const out = {};
  for (const s of stores.values()) out[s.label] = { path: s.path, tables: s.stats() };
  return out;
}

/** 清空**所有**缓存（面板「清空缓存」按钮 = 这一个入口，不散在各模块里） */
function clearAll() {
  for (const s of stores.values()) s.clear();
}

/**
 * 按**当前设置**把所有表扫到各自上限以内（设置改小后立刻落实，
 * 否则面板上会显示「已用 60MB / 上限 10MB」，看着像坏了）。
 */
function sweepAll(limits) {
  const c = limits || cfg();
  for (const s of stores.values()) {
    for (const t of s.tables) {
      const cap = TABLE_CAP[t] ? TABLE_CAP[t](c) : 0;
      if (cap) s.enforce(t, cap);
    }
  }
}

module.exports = {
  USED_REFRESH_MS,
  NAME_TTL_MS,
  NAME_MAX_BYTES,
  NEVER_TTL_MS,
  DEFAULTS,
  cfg,
  createStore,
  listStores,
  statsAll,
  clearAll,
  sweepAll,
};
