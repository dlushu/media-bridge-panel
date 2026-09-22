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

const SCHEMA_VERSION = 2;

/* scrypt 参数：N=16384 单次约几十毫秒，登录是低频动作，够用。
 * maxmem 必须显式给（默认 32MiB），否则调大 N 会直接抛 memory limit exceeded。 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

let db = null;

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
  `);
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
};
