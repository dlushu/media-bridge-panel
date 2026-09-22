'use strict';
/**
 * 面板鉴权（单密码门禁）
 *
 * 定位：**这是一道"门"，不是一套用户体系**。一个密码、一个共享会话，
 * 足以挡住"局域网里随手打开面板的人"，但——
 *   · 面板默认是 **http 明文**，密码在链路上也是明文（除非前面套了 https 反代）；
 *   · 没有多用户、没有权限分级、没有审计。
 * 因此：**不要把面板直接暴露到公网**（README 里也写了这句）。
 *
 * 凭证落在 `data/auth.json`（**不在 settings/ 里** —— 那个目录会被 `/api/modules/:id/settings`
 * 与「配置备份」原样导出，密码哈希和会话密钥不该走那条路）：
 *
 *   { "passwordHash": "scrypt$<salt>$<hash>", "secret": "<会话签名密钥>", "updatedAt": 123 }
 *
 * 三条设计选择：
 *   ① **密码只存 scrypt 哈希**，从不落明文（比对用 `timingSafeEqual`）；
 *   ② **会话是无状态签名 cookie**（`exp` + `pv` 两段签名）—— 面板重启不必重新登录，
 *      而 `pv` 是"密码哈希"的指纹，所以**改密码 = 旧会话立刻全失效**；
 *   ③ Emby 客户端那套端点（`/api/emby/*`）**必须放行** —— 它们有自己的 AccessToken 校验，
 *      面板门禁只管"面板自己的接口与被代理的源配置页"。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { DATA_DIR } = require('./paths');

const FILE = path.join(DATA_DIR, 'auth.json');
/** 默认密码：**首次使用时才写进 auth.json 的哈希**，之后随便改（README 里也提了这句） */
const DEFAULT_PASSWORD = '123456';
/** 新密码下限（默认密码 6 位，故下限取 6） */
const MIN_LEN = 6;
/** 会话有效期：30 天（面板是自用工具，无需频繁登录） */
const TTL_MS = 30 * 24 * 3600 * 1000;
const COOKIE = 'catpaw_panel';
/** 失败节流：连续 5 次 → 锁 60 秒（同一 IP） */
const MAX_FAILS = 5;
const LOCK_MS = 60 * 1000;

/* ---------------------------------------------------------------- 密码哈希 */

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, want] = parts;
  let got;
  try {
    got = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  } catch {
    return false;
  }
  const a = Buffer.from(got, 'hex');
  const b = Buffer.from(want, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------------------------------------------------------------- 落盘 */

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw && raw.passwordHash && raw.secret) {
      cache = { passwordHash: String(raw.passwordHash), secret: String(raw.secret), updatedAt: Number(raw.updatedAt) || 0 };
      return cache;
    }
  } catch {
    /* 没有 / 读坏了 → 下面按默认密码建一份 */
  }
  cache = { passwordHash: hashPassword(DEFAULT_PASSWORD), secret: crypto.randomBytes(32).toString('hex'), updatedAt: Date.now() };
  save(cache);
  console.log(`  🔑 面板鉴权：已初始化（默认密码 ${DEFAULT_PASSWORD} —— 请尽快在「面板设置」里改掉）`);
  return cache;
}

function save(next) {
  cache = next;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

/** 现在还在用默认密码吗（前端拿它显示提醒；不泄露密码本身） */
function isDefaultPassword() {
  return verifyPassword(DEFAULT_PASSWORD, load().passwordHash);
}

/** 改密码：先验旧的。返回 {ok} 或 {error} */
function setPassword(oldPw, newPw) {
  const cur = load();
  if (!verifyPassword(oldPw, cur.passwordHash)) return { error: '当前密码不对' };
  const next = String(newPw || '');
  if (next.length < MIN_LEN) return { error: `新密码至少 ${MIN_LEN} 位` };
  if (next === DEFAULT_PASSWORD) return { error: '新密码不能和默认密码一样' };
  if (verifyPassword(next, cur.passwordHash)) return { error: '新密码和当前密码一样' };
  save({ passwordHash: hashPassword(next), secret: cur.secret, updatedAt: Date.now() });
  return { ok: true };
}

/* ---------------------------------------------------------------- 会话 */

/** 密码哈希的指纹：进签名载荷 —— 一改密码，所有旧 cookie 立刻失效 */
function pvOf() {
  return crypto.createHash('sha256').update(load().passwordHash).digest('hex').slice(0, 16);
}

function sign(payload) {
  return crypto.createHmac('sha256', load().secret).update(payload).digest('base64url');
}

function issueToken() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + TTL_MS, pv: pvOf() }), 'utf8').toString('base64url');
  return payload + '.' + sign(payload);
}

function verifyToken(token) {
  const s = String(token || '');
  const dot = s.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = s.slice(0, dot);
  const mac = s.slice(dot + 1);
  const want = sign(payload);
  if (mac.length !== want.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return false;
  try {
    const o = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!o.exp || o.exp < Date.now()) return false;
    return o.pv === pvOf();
  } catch {
    return false;
  }
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** 当前请求带的面板会话有效吗 */
function isAuthed(req) {
  return verifyToken(parseCookies(req)[COOKIE]);
}

function cookieHeader(token, req) {
  /* 只在**确实是 https** 时加 Secure —— 面板通常跑在局域网 http 上，
   * 加了 Secure 浏览器会直接丢掉这个 cookie，变成"登录了还是被拦"。 */
  const https = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  const base = `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`;
  return token ? `${base}; Max-Age=${Math.floor(TTL_MS / 1000)}${https ? '; Secure' : ''}` : `${base}; Max-Age=0${https ? '; Secure' : ''}`;
}

/* ---------------------------------------------------------------- 门禁 */

/**
 * 门禁规则。**方向很关键**：`/api/emby/*` 下绝大多数是 **Emby 客户端打的协议端点**
 * （客户端带着自己的 AccessToken），但有少数几条是**面板自己的管理端点** ——
 * 它们混在同一个前缀下，必须挑出来拦住：
 *
 *   `/api/emby/accounts*`   账号管理（增删改面板给客户端用的账号）
 *   `/api/emby/home/*`      **首页插件**（上传/删除/改参数/逐行预览 —— 能传任意 JS 进来）
 *
 * 为什么不反过来列"哪些放行"：客户端协议面很宽（Users/Items/Shows/videos/Images/…，
 * 还有那个专门记 501 的 `ANY /api/emby/*rest` 通配），漏一个就是**客户端直接 401**；
 * 而"面板自己那几条"是有限的、由本项目维护 —— 所以**默认放行、只拦这几条**。
 *
 * ⚠️ 已移除两条：`/api/emby/tmdb/`（TMDB 设置与测试搬到 `/api/panel/tmdb/test`）
 * 与 `/api/emby/cache`（缓存跨两个库了，用量/清空搬到 `/api/panel/cache`）——
 * 而 `/api/panel/*` 本来就在下面那条"一律要登录"里，不必再列。
 */
const EMBY_PANEL_RE = [/^\/api\/emby\/accounts\b/, /^\/api\/emby\/home\//];

function needsAuth(pathname) {
  if (pathname.startsWith('/api/auth/')) return false; // 登录本身（还有 status/logout）
  if (pathname.startsWith('/api/emby/')) return EMBY_PANEL_RE.some((re) => re.test(pathname));
  return pathname.startsWith('/api/') || pathname.startsWith('/website');
}

const fails = new Map(); // ip → { n, until }

function clientIp(req) {
  return String((req.socket && req.socket.remoteAddress) || '');
}

/**
 * 拦一道：需要鉴权且没通过 → 返回一句给前端看的错误（调用方回 401）；通过 → null。
 * 顺带把"会话过期"的 cookie 清掉，免得浏览器一直带着一个再也用不了的旧 token。
 *
 * `force: true` = **不看 needsAuth 名单，一律要登录**。给"配置中心的兜底转发"用
 * （`modules/source/config-proxy.js`）：那些路径面板本来就不认识（`/full-config` 之类，
 * 没法写进名单），但转出去的是**源的接口** —— 不拦就等于把源无鉴权端到公网上。
 */
function guard(req, pathname, { force = false } = {}) {
  if (!force && !needsAuth(pathname)) return null;
  if (isAuthed(req)) return null;
  return '需要登录面板（浏览器里打开面板首页登录一次即可；接口调用请先登录拿 cookie）';
}

/** 登录尝试的节流（同一 IP 连续失败就锁一会儿）—— 返回剩余秒数，0 = 可以试 */
function lockedFor(ip) {
  const hit = fails.get(ip);
  if (!hit || !hit.until) return 0;
  const left = Math.ceil((hit.until - Date.now()) / 1000);
  if (left <= 0) {
    fails.delete(ip);
    return 0;
  }
  return left;
}

function noteFail(ip) {
  const hit = fails.get(ip) || { n: 0, until: 0 };
  hit.n += 1;
  if (hit.n >= MAX_FAILS) {
    hit.until = Date.now() + LOCK_MS;
    hit.n = 0;
  }
  fails.set(ip, hit);
  return hit.until ? Math.ceil(LOCK_MS / 1000) : 0;
}

function noteOk(ip) {
  fails.delete(ip);
}

/** 登录：对 → 回 token；错 → 回 {error}（带节流） */
function login(req, password) {
  const ip = clientIp(req);
  const lock = lockedFor(ip);
  if (lock) return { error: `试错太多次，请 ${lock} 秒后再试`, locked: lock };
  if (!verifyPassword(password, load().passwordHash)) {
    const locked = noteFail(ip);
    console.log(`  ✘ 面板登录失败（ip=${ip}）${locked ? ` —— 已锁定 ${locked} 秒` : ''}`);
    return { error: '密码不对' };
  }
  noteOk(ip);
  console.log(`  ✔ 面板登录成功（ip=${ip}）`);
  return { token: issueToken() };
}

module.exports = {
  DEFAULT_PASSWORD,
  MIN_LEN,
  needsAuth,
  guard,
  isAuthed,
  parseCookies,
  isDefaultPassword,
  setPassword,
  login,
  logout: () => ({ token: '' }),
  cookieHeader,
  issueToken,
  COOKIE,
};
