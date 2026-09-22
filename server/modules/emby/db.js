'use strict';
/**
 * Emby 层的本地库（Node 内置 `node:sqlite`，零依赖）
 *
 * 放「客户端登录账号」这类**模块私有的持久数据**：
 *   accounts —— 用户名 + scrypt 密码哈希 + 最近登录；密码**不再明文**存设置文件里。
 *
 * 为什么不放进 settings：settings 是「配置」（有 defaults/validate/fields 与通用读写端点），
 * 而账号是用户数据（要增删改、要哈希、以后还会挂进度与收藏）—— 两件事混在一起会互相拖累。
 *
 * 惰性开库：只有真正用到账号时才建文件，避免「设置还没定义完就碰库」的顺序耦合。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { EMBY_DIR, EMBY_DB } = require('../../core/paths');

const SCHEMA_VERSION = 4;

/* scrypt 参数：N=16384 单次约几十毫秒，登录是低频动作，够用。
 * maxmem 必须显式给（默认 32MiB），否则调大 N 会直接抛 memory limit exceeded。 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

let db = null;

/**
 * 表里有没有这一列（`pragma_table_info` 查一眼）—— **加列迁移的幂等判据**。
 * 见 `open()` 里 3 → 4 那次：`CREATE TABLE IF NOT EXISTS` 对**已存在的表**不会补列。
 */
function hasColumn(table, column) {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM pragma_table_info(?) WHERE name = ?').get(String(table), String(column)).n > 0
  );
}

/** 打开（首次会建库建表并 chmod）；老 Node 上给一句人话报错 */
function open() {
  if (db) return db;

  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    throw new Error(`本面板需要 Node ≥ 22.13 才能使用内置 sqlite（当前 ${process.version}），请升级 Node 后重启`);
  }

  fs.mkdirSync(EMBY_DIR, { recursive: true });
  db = new DatabaseSync(EMBY_DB);
  try {
    fs.chmodSync(EMBY_DB, 0o600); // 含密码哈希，别让同机其它用户读
  } catch {
    /* 平台不支持就算了，不因此起不来 */
  }

  /* journal_mode 保持默认（DELETE）：不产生 -wal/-shm，文件级拷贝/备份不会漏数据；
   * 本库写入量极小，不需要 WAL 的并发收益。 */
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS accounts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL,            -- 显示名，保留原大小写
      username_lc   TEXT NOT NULL UNIQUE,     -- NFKC + 小写，登录与查重用
      password_hash TEXT NOT NULL,            -- scrypt$N$r$p$klen$salt$hash
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      last_login_at TEXT,
      last_client   TEXT
    );
    /* 登录发出去的 AccessToken —— 客户端靠它证明自己的身份，见 service.authorize。
     * 用 CREATE IF NOT EXISTS 就够，从 v1 升上来不需要搬数据（新表而已）。 */
    CREATE TABLE IF NOT EXISTS sessions (
      token        TEXT PRIMARY KEY,
      account_id   INTEGER NOT NULL,
      client       TEXT,                      -- 登录时的 Client / Device（日志与面板排查用）
      device_id    TEXT,
      created_at   TEXT NOT NULL,
      last_seen_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
    /* 播放进度 —— 客户端 POST /Sessions/Playing* 上报的东西落在这里。
     *
     * 一行 = 「一个账号 + 一条**可播条目**（电影 / 集）」的最后状态，**覆盖写**：
     * 客户端每 10 秒一次心跳（实测 SenPlayer），append 会让库随播放时长线性增长，所以主键就是这两列。
     * 关联键用 account_id —— **不是 user_id**：user_id = md5(serverId + 用户名)，
     * serverId 丢一次或改个用户名就全变（见 service.userId）。
     * series_id / season / episode 是集的坐标（NextUp 要用）；电影为空。 */
    CREATE TABLE IF NOT EXISTS playback (
      account_id     INTEGER NOT NULL,
      item_id        TEXT    NOT NULL,
      position_ticks INTEGER NOT NULL DEFAULT 0,
      runtime_ticks  INTEGER NOT NULL DEFAULT 0,   -- 判"看完"用；客户端心跳里带
      played         INTEGER NOT NULL DEFAULT 0,
      play_count     INTEGER NOT NULL DEFAULT 0,   -- 看完才加一（与真机不同，见 docs/playback-progress.md §4.2）
      series_id      TEXT,
      season         INTEGER,
      episode        INTEGER,
      updated_at     TEXT    NOT NULL,
      hidden         INTEGER NOT NULL DEFAULT 0,   -- 「从继续观看里移除」（客户端 HideFromResume）；重新开始播放时清掉
      PRIMARY KEY (account_id, item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_playback_recent ON playback(account_id, played, updated_at DESC);
  `);

  /* 3 → 4：`playback` 加 `hidden`（客户端 `POST …/HideFromResume`）。
   * ⚠️ 老库的表**已经建过**，上面那句 `CREATE TABLE IF NOT EXISTS` 不会补列 —— 必须显式 ALTER。
   * 幂等：列已在就跳过（每次开库都会走到这里，重复 ALTER 会直接报错）。 */
  if (!hasColumn('playback', 'hidden')) {
    db.exec('ALTER TABLE playback ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;');
  }

  db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run('schema_version', String(SCHEMA_VERSION));

  /* 进程退出时收尾；server.js 的 shutdown 只停源，没有库钩子 */
  process.on('exit', () => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  });
  return db;
}

/** 归一化用户名：登录、查重、派生 UserId 都用它，避免「登录成功但取资料 404」 */
function normName(name) {
  return String(name === undefined || name === null ? '' : name).trim().normalize('NFKC').toLowerCase();
}

/* ------------------------------------------------------------------ 密码 */

/** 生成 scrypt 哈希串（参数自描述，便于以后换算法） */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keylen, salt.toString('base64url'), dk.toString('base64url')].join('$');
}

/** 校验密码；任何异常（格式坏、算法不认、参数越界）一律 false */
function verifyPassword(password, stored) {
  try {
    const [tag, n, r, p, keylen, saltB64, hashB64] = String(stored || '').split('$');
    if (tag !== 'scrypt') return false;
    const want = Buffer.from(hashB64, 'base64url');
    const dk = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64url'), Number(keylen), {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT.maxmem,
    });
    if (dk.length !== want.length) return false; // timingSafeEqual 长度不等会抛
    return crypto.timingSafeEqual(dk, want);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ 迁移 */

/**
 * 老的单账号（设置文件里的 `account.{username,password}`，明文）搬进库。两条**独立**规则：
 *   ① 导入：仅当表为空、且设置里用户名与密码都非空 —— 事务内插入（哈希明文），失败不动明文；
 *   ② 清明文：只要设置里还有残留就清掉（**无条件**）。
 * 只靠 ① 会漏：从旧备份还原出带明文的设置时导入会跳过、明文却永远留着。
 * 顺序（先 COMMIT 再清）保证中途挂掉也能自愈。
 */
function migrateLegacy() {
  const d = open();
  const settings = require('../../core/settings');
  const s = settings.read('emby');
  const legacy = (s && s.account) || {};
  const username = String(legacy.username || '').trim();
  const password = String(legacy.password || '');
  if (!username && !password) return;

  const empty = d.prepare('SELECT COUNT(*) AS n FROM accounts').get().n === 0;
  if (empty && username && password) {
    d.exec('BEGIN IMMEDIATE');
    try {
      insertAccount(username, password);
      d.exec('COMMIT');
      d.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run('legacy_migrated_at', new Date().toISOString());
      console.log(`  ↻ emby 账号迁移：1 个（${username}）—— 密码已改为 scrypt 哈希，设置文件里的明文已清除`);
    } catch (e) {
      d.exec('ROLLBACK');
      console.log(`  ✘ emby 账号迁移失败（明文保留，下次启动会重试）：${(e && e.message) || e}`);
      return; // 失败就别清明文
    }
  }
  settings.patch('emby', { account: { username: '', password: '' } });
}

/* ------------------------------------------------------------------ 账号读写 */

let migrated = false;

function ensure() {
  const d = open();
  if (!migrated) {
    migrateLegacy();
    migrated = true;
  }
  return d;
}

/** 列表（**绝不 SELECT password_hash**） */
function listAccounts() {
  return ensure()
    .prepare('SELECT id, username, created_at, updated_at, last_login_at, last_client FROM accounts ORDER BY id')
    .all();
}

/** 含 hash 的整行，仅登录校验用 */
function findAccountByName(name) {
  const lc = normName(name);
  if (!lc) return null;
  return ensure().prepare('SELECT * FROM accounts WHERE username_lc = ?').get(lc) || null;
}

function getAccount(id) {
  return ensure().prepare('SELECT * FROM accounts WHERE id = ?').get(Number(id)) || null;
}

/** 内部写入用：不触发迁移（否则迁移里的插入会绕回 ensure → migrate，递归） */
function insertAccount(username, password) {
  const d = open();
  const now = new Date().toISOString();
  const r = d
    .prepare('INSERT INTO accounts (username, username_lc, password_hash, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run(String(username).trim(), normName(username), hashPassword(password), now, now);
  return Number(r.lastInsertRowid);
}

function addAccount(username, password) {
  return getAccount(insertAccount(username, password));
}

function updateAccount(id, patch) {
  const d = ensure();
  const acc = getAccount(id);
  if (!acc) return null;
  const sets = [];
  const args = [];
  if (patch && patch.username !== undefined) {
    sets.push('username = ?', 'username_lc = ?');
    args.push(String(patch.username).trim(), normName(patch.username));
  }
  if (patch && patch.password) {
    sets.push('password_hash = ?');
    args.push(hashPassword(patch.password));
  }
  sets.push('updated_at = ?');
  args.push(new Date().toISOString(), Number(id));
  d.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  /* 改密 = 踢下线：该账号已发出去的 token 全部作废，客户端必须重新登录。
   * （与文档里"改密后该账号客户端需重登"的说法一致，现在是真强制。） */
  if (patch && patch.password) removeSessionsOfAccount(id);
  return getAccount(id);
}

function removeAccount(id) {
  removeSessionsOfAccount(id);
  /* 进度按账号存（`account_id`）—— 账号没了，那些行就成了没人认领的数据，一起删掉 */
  removePlaybackOfAccount(id);
  return ensure().prepare('DELETE FROM accounts WHERE id = ?').run(Number(id)).changes > 0;
}

/** 登录成功时记一笔（面板列表里要显示"最近登录"） */
function touchLogin(id, client) {
  ensure()
    .prepare('UPDATE accounts SET last_login_at = ?, last_client = ? WHERE id = ?')
    .run(new Date().toISOString(), String(client || '').slice(0, 200), Number(id));
}

function countAccounts() {
  return ensure().prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
}

/* ------------------------------------------------------------------ 会话（AccessToken） */

const TOUCH_INTERVAL_MS = 60000; // last_seen_at 的写库节流：拉流时每个 Range 请求都来一遍，不必那么勤

function createSession(token, accountId, { client = '', deviceId = '' } = {}) {
  ensure()
    .prepare('INSERT INTO sessions (token, account_id, client, device_id, created_at, last_seen_at) VALUES (?,?,?,?,?,?)')
    .run(String(token), Number(accountId), String(client || '').slice(0, 200), String(deviceId || '').slice(0, 200), new Date().toISOString(), new Date().toISOString());
  return token;
}

/** 查 token → 会话（带上账号信息）；查不到返回 null */
function findSession(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  return (
    ensure()
      .prepare(
        `SELECT s.token, s.account_id, s.client, s.device_id, s.created_at, s.last_seen_at, a.username
         FROM sessions s JOIN accounts a ON a.id = s.account_id
         WHERE s.token = ?`
      )
      .get(t) || null
  );
}

/** 记一次活跃（节流：距上次不足一分钟就不写） */
function touchSession(token, seenAt = Date.now()) {
  const s = findSession(token);
  if (!s) return false;
  const last = Date.parse(s.last_seen_at || s.created_at || '');
  if (Number.isFinite(last) && seenAt - last < TOUCH_INTERVAL_MS) return true;
  ensure().prepare('UPDATE sessions SET last_seen_at = ? WHERE token = ?').run(new Date(seenAt).toISOString(), s.token);
  return true;
}

function removeSession(token) {
  return ensure().prepare('DELETE FROM sessions WHERE token = ?').run(String(token || '')).changes > 0;
}

function removeSessionsOfAccount(accountId) {
  return ensure().prepare('DELETE FROM sessions WHERE account_id = ?').run(Number(accountId)).changes;
}

function countSessions() {
  return ensure().prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
}

/* ------------------------------------------------------------------ 播放进度 */

function getPlayback(accountId, itemId) {
  if (!accountId || !itemId) return null;
  return ensure().prepare('SELECT * FROM playback WHERE account_id = ? AND item_id = ?').get(Number(accountId), String(itemId)) || null;
}

/**
 * 覆盖写一条进度（**不 append** —— 心跳每 10 秒一条）。终值由调用方算好，这里只写。
 *
 * `runtime_ticks` / `series_id` / `season` / `episode` 特意做了兜底：客户端的心跳**不是每条都带
 * `RunTimeTicks`**（实测 SenPlayer 只有部分心跳带），一次丢它就再也判不了"看完"，所以用已有的顶住。
 */
function upsertPlayback(accountId, itemId, p = {}) {
  ensure()
    .prepare(
      `INSERT INTO playback (account_id, item_id, position_ticks, runtime_ticks, played, play_count, series_id, season, episode, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(account_id, item_id) DO UPDATE SET
         position_ticks = excluded.position_ticks,
         runtime_ticks  = CASE WHEN excluded.runtime_ticks > 0 THEN excluded.runtime_ticks ELSE playback.runtime_ticks END,
         played         = excluded.played,
         play_count     = excluded.play_count,
         series_id      = COALESCE(excluded.series_id, playback.series_id),
         season         = COALESCE(excluded.season, playback.season),
         episode        = COALESCE(excluded.episode, playback.episode),
         updated_at     = excluded.updated_at`
    )
    .run(
      Number(accountId),
      String(itemId),
      Math.max(0, Number(p.positionTicks) || 0),
      Math.max(0, Number(p.runtimeTicks) || 0),
      p.played ? 1 : 0,
      Math.max(0, Number(p.playCount) || 0),
      p.seriesId || null,
      Number.isFinite(p.season) ? p.season : null,
      Number.isFinite(p.episode) ? p.episode : null,
      new Date().toISOString()
    );
  return getPlayback(accountId, itemId);
}

/**
 * 「继续观看」：有位置、还没看完、**没被隐藏**，最近看的在前。
 *
 * `hidden = 0` 来自客户端 `HideFromResume?Hide=true`（见 `setHidden`）—— 只影响这一条查询：
 * 「已看」（`listPlayed`）与「接下来看」（`listRecentBySeries`）不因隐藏而改变。
 */
function listResume(accountId, limit = 20) {
  return ensure()
    .prepare(
      'SELECT * FROM playback WHERE account_id = ? AND played = 0 AND position_ticks > 0 AND hidden = 0 ORDER BY updated_at DESC LIMIT ?'
    )
    .all(Number(accountId), Math.max(1, Number(limit) || 20));
}

/**
 * 隐藏 / 恢复「继续观看」里的一条（客户端 `POST …/HideFromResume?Hide=true|false`）。
 *
 * 三种情况：
 *   · 库里**已有**这一行 → 只翻 `hidden` 列；
 *   · 库里**没有**这一行、且这次是**隐藏** → 插一行**占位**（位置 0、未看、`hidden=1`，坐标用传进来的）。
 *     为什么要占位：客户端"移除"的常常是「接着看」里那条**还没看过**的下一集（库里本来没有它的行），
 *     不记下来的话下次拉列表它又回来了（实测 SenPlayer：移除了却还在）。
 *     另一头由「重新开始播放自动取消隐藏」保着 —— 占位不会把以后真看时的显示挡住。
 *   · 没有行、且这次是**恢复** → 无事可做（本来就不在列表里）。
 *
 * 返回改到 / 插入的行数，调用方按 0 行记一句日志。
 */
function setHidden(accountId, itemId, hide, coords = {}) {
  const acc = Number(accountId);
  const id = String(itemId);
  const changed = ensure()
    .prepare('UPDATE playback SET hidden = ? WHERE account_id = ? AND item_id = ?')
    .run(hide ? 1 : 0, acc, id).changes;
  if (changed || !hide) return changed;
  return ensure()
    .prepare(
      `INSERT INTO playback (account_id, item_id, position_ticks, runtime_ticks, played, play_count, series_id, season, episode, updated_at, hidden)
       VALUES (?,?,0,0,0,0,?,?,?,?,1)`
    )
    .run(
      acc,
      id,
      coords.seriesId || null,
      Number.isFinite(coords.season) ? coords.season : null,
      Number.isFinite(coords.episode) ? coords.episode : null,
      new Date().toISOString()
    ).changes;
}

/** 「已看」（`Filters=IsPlayed`）：看完的，最近看的在前 */
function listPlayed(accountId, limit = 50) {
  return ensure()
    .prepare('SELECT * FROM playback WHERE account_id = ? AND played = 1 ORDER BY updated_at DESC LIMIT ?')
    .all(Number(accountId), Math.max(1, Number(limit) || 50));
}

/**
 * 每部剧**最近**看的那一条（`Shows/NextUp` 用）：同 `series_id` 只留最新一条，按时间倒序。
 *
 * **排除被隐藏的行**：一是隐藏的占位行（位置 0、没看过）不该成为"最近观看"；
 * 二是"把正在追的那一集移出「继续观看」"就该让这部剧让位（真机实测：隐藏后那条从 `Resume` 消失）。
 */
function listRecentBySeries(accountId) {
  const rows = ensure()
    .prepare('SELECT * FROM playback WHERE account_id = ? AND series_id IS NOT NULL AND hidden = 0 ORDER BY updated_at DESC')
    .all(Number(accountId));
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(r.series_id)) continue;
    seen.add(r.series_id);
    out.push(r);
  }
  return out;
}

function removePlaybackOfAccount(accountId) {
  return ensure().prepare('DELETE FROM playback WHERE account_id = ?').run(Number(accountId)).changes;
}

/**
 * 面板/接口返回用的安全视图 —— **只此一处**做字段映射，避免哪天不小心把 `password_hash` 回给前端。
 * 所有对外的账号响应都必须过它。
 */
function publicAccount(acc) {
  if (!acc) return null;
  return {
    id: acc.id,
    username: acc.username,
    createdAt: acc.created_at,
    updatedAt: acc.updated_at,
    lastLoginAt: acc.last_login_at,
    lastClient: acc.last_client,
  };
}

module.exports = {
  normName,
  hashPassword,
  verifyPassword,
  listAccounts,
  findAccountByName,
  getAccount,
  addAccount,
  updateAccount,
  removeAccount,
  touchLogin,
  countAccounts,
  publicAccount,
  createSession,
  findSession,
  touchSession,
  removeSession,
  removeSessionsOfAccount,
  countSessions,
  getPlayback,
  upsertPlayback,
  setHidden,
  listResume,
  listPlayed,
  listRecentBySeries,
  removePlaybackOfAccount,
};
