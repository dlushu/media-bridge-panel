'use strict';
/**
 * 面板自身更新（决策与理由见 docs/adr/0019-self-update-from-release.md）。
 *
 * 做四件事：查最新版本、把某个 Release 版本装到数据卷、请求监督者重启、
 * 启动成功后**清掉当前版本之外的所有版本目录**（更新即完整替换，
 * 见 docs/adr/0021-update-replaces-app-dir.md）。
 * 查版本结果缓存 60 秒，避免频繁刷新把 GitHub API 打满。
 *
 * ⚠️ **目录布局、包名、校验文件格式必须与容器的引导脚本（`docker/entrypoint.js`）保持一致** ——
 *    两者是同一份约定的两端（一边负责首次安装，一边负责后续更新），改动必须同步。
 *
 * 运行方式与能否自更新：只有在"由引导脚本托管的进程"里才允许自更新
 * （引导脚本会给子进程带上 `MB_SUPERVISED=1`）。直接跑源码、或用别的方式启动时如实拒绝，
 * 因为此时没有监督者来把新版本拉起来。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { DATA_DIR } = require('../../core/paths');
const pkg = require('../../../package.json');

/** 应用代码安装根目录（与 docker/entrypoint.js 的 APP_ROOT 一致） */
const APP_ROOT = path.join(DATA_DIR, 'app');
const CURRENT_FILE = path.join(APP_ROOT, 'current.json');
const RESTART_FILE = path.join(APP_ROOT, '.restart');

const REPO = String(process.env.APP_REPO || 'dlushu/media-bridge-panel').trim();

/** 解包后必须存在的文件；缺任何一个都视为坏包（与引导脚本同一份清单） */
const REQUIRED = ['server.js', 'package.json', 'server/core/paths.js', 'public/index.html'];

const CHECK_TTL_MS = 60 * 1000;

/** 启动成功后隔多久执行"清旧版本"（见 `pruneOnBoot`）：留一小段窗口，万一这一版起来就出问题，旧目录还在 */
const PRUNE_DELAY_MS = 15 * 1000;

/* ------------------------------------------------------------------ 基础 */

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * 原子写：先写临时文件再改名，避免读到半个文件。改名失败时退回直接写 ——
 * 部分文件系统（网络盘、某些共享挂载）会拒绝改名，此时放弃原子性也要能继续。
 */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  const text = JSON.stringify(value, null, 2);
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.writeFileSync(file, text);
    fs.rmSync(tmp, { force: true });
    console.log(`  ⚠ 原子改名失败，已直接写入 ${file}：${(e && e.message) || e}`);
  }
}

const isValidVersion = (v) => /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(String(v || ''));

function compareVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** 磁盘上已安装的版本（升序） */
function listInstalled() {
  let names = [];
  try {
    names = fs.readdirSync(APP_ROOT);
  } catch {
    return [];
  }
  return names
    .filter((n) => isValidVersion(n))
    .filter((n) => fs.existsSync(path.join(APP_ROOT, n, 'server.js')))
    .sort(compareVersion);
}

/** 正在运行的代码目录（本文件位于 <应用目录>/server/modules/panel/） */
function runningDir() {
  return path.resolve(__dirname, '..', '..', '..');
}

/**
 * 是否处于"可自更新"的运行方式：由引导脚本托管（`MB_SUPERVISED=1`）、
 * 且当前代码确实装在数据卷的 app/ 下。两个条件缺一不可 —— 没有监督者时，
 * 换掉代码也无人把新版本拉起来。
 *
 * 比较前先取真实路径（realpath）：Node 解析入口模块时会解开符号链接，
 * 而 DATA_DIR 可能是个链接（例如 macOS 上 /tmp → /private/tmp，或某些卷的挂载方式），
 * 直接比较字符串会把"其实就是同一处"判成不同。
 */
function realOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function isManaged() {
  if (String(process.env.MB_SUPERVISED || '') !== '1') return false;
  const root = realOrSelf(APP_ROOT);
  const run = realOrSelf(runningDir());
  return run === root || run.startsWith(root + path.sep);
}

/* ------------------------------------------------ 只保留当前版本（清旧版本） */

/**
 * 白名单：**绝不能删**的三个版本。
 *
 *   ① 正在运行的这一版（`package.json` 的 version）—— 它就是这个进程自己的代码目录；
 *      静态文件是**每个请求从磁盘读**的（`core/http.js` 的 serveStatic），删了页面立刻 404；
 *   ② `current.json` 记的那一版 —— 正常与 ① 相同；万一不同，它才是监督者下次要拉起的那个；
 *   ③ `APP_VERSION` 指定的那一版 —— 删了引导脚本每次启动都会重新下载，网络不通时直接起不来。
 */
function protectedVersions() {
  const keep = new Set();
  const running = String(pkg.version || '').trim();
  if (running) keep.add(running);
  const cur = readJson(CURRENT_FILE);
  if (cur && cur.version) keep.add(String(cur.version));
  const want = String(process.env.APP_VERSION || '').trim().replace(/^v/, '');
  if (want) keep.add(want);
  return keep;
}

/**
 * 清掉当前版本之外的一切：旧版本目录 + `install()` 失败留下的 `.staging-*` 暂存目录。
 *
 * ⚠️ **只删"版本目录"与暂存目录**：`current.json`（当前版本记录）与 `.restart`（重启协议）
 * 同样住在 `app/` 下，必须留着 —— 所以这里绝不清空整个 `app/`，而是按名字逐个判断。
 *
 * best-effort：删不掉只记一行日志，绝不让调用方失败（一个删不掉的旧目录不该影响启动）。
 */
function pruneVersions() {
  const keep = protectedVersions();
  const out = { kept: [...keep], removed: [], failed: [] };
  let names = [];
  try {
    names = fs.readdirSync(APP_ROOT);
  } catch {
    return out; // 目录还不存在：没什么可清的
  }
  for (const n of names) {
    const isStaging = n.startsWith('.staging-');
    const isVersion = isValidVersion(n);
    if (!isStaging && !isVersion) continue; // current.json / .restart 等协议文件，跳过
    if (isVersion && keep.has(n)) continue;
    try {
      fs.rmSync(path.join(APP_ROOT, n), { recursive: true, force: true });
      out.removed.push(n);
    } catch (e) {
      out.failed.push({ name: n, error: (e && e.message) || String(e) });
    }
  }
  return out;
}

/**
 * 启动成功后调一次（`server.js` 的监听回调里）——**每次启动都跑**。
 *
 * 为什么每次启动都跑、而不是只在更新后跑：
 *   · 清理是**新版本自己**做的，旧版本（还没有这段代码）不需要任何配合，
 *     所以第一次更新就能把历史版本收干净；
 *   · 每次启动都跑 ⇒ "`app/` 里只有当前版本"在任何时刻都成立，不依赖"正好发生过一次更新"。
 *
 * 为什么延迟 `PRUNE_DELAY_MS` 再动手：这一版虽然已经起来了，但那几秒内若立刻出问题，
 * 旧目录还在（本地唯一的退路）。非受管运行方式（直接跑源码）返回 null、什么都不做 ——
 * 那种情况下数据目录里的 `app/` 不该被动。
 */
function pruneOnBoot({ delayMs = PRUNE_DELAY_MS } = {}) {
  if (!isManaged()) return null;
  const timer = setTimeout(() => {
    try {
      const r = pruneVersions();
      if (r.removed.length) {
        console.log(`  · 更新：已清掉旧版本 ${r.removed.join(' / ')}（只留 ${r.kept.join(' / ')}）`);
      }
      for (const f of r.failed) {
        console.log(`  ⚠ 更新：旧版本 ${f.name} 清理失败（不影响运行）：${f.error}`);
      }
    } catch (e) {
      console.log(`  ⚠ 更新：清理旧版本失败（不影响运行）：${(e && e.message) || e}`);
    }
  }, Math.max(0, Number(delayMs) || 0));
  timer.unref(); // 一个清理定时器不该把进程吊住
  return timer;
}

/* ------------------------------------------------------------------ 查版本 */

let checkCache = { at: 0, value: null };

function renderTemplate(tpl, { version, name }) {
  return String(tpl)
    .replace(/\{repo\}/g, REPO)
    .replace(/\{version\}/g, version)
    .replace(/\{tag\}/g, `v${version}`)
    .replace(/\{name\}/g, name);
}

/** 该版本包的下载地址：默认走 GitHub Release 资产，`APP_SOURCE_URL` 可覆盖（镜像/代理/本地路径） */
function sourceUrlOf(version, name = `media-bridge-panel-${version}.tar.gz`) {
  const tpl = String(process.env.APP_SOURCE_URL || '').trim();
  return tpl ? renderTemplate(tpl, { version, name }) : `https://github.com/${REPO}/releases/download/v${version}/${name}`;
}

function checksumUrlOf(version, name) {
  const tpl = String(process.env.APP_CHECKSUM_URL || '').trim();
  const src = sourceUrlOf(version, name);
  return tpl ? renderTemplate(tpl, { version, name }) : `${src}.sha256`;
}

/** 更新说明最多回给前端多少字符（Release 说明一般几 KB；上限只为挡住某个版本写了超长正文） */
const NOTES_MAX = 20000;

/**
 * 清掉 Release 说明里的两段**模板套话**（由 `.github/workflows/release.yml` 拼上去，不是 CHANGELOG 正文）：
 * 开头那句"发布说明摘自 …"、结尾 `---` 之后的"面板「设置 → 版本与更新」…"。
 *
 * 两个锚点都按**完整前缀**匹配，匹配不到就**原样保留** —— 宁可多显示一句套话，也不猜着切正文。
 */
function cleanNotes(body) {
  let s = String(body || '').replace(/\r\n/g, '\n').trim();
  s = s.replace(/^发布说明摘自 [^\n]*\n+/, '');
  s = s.replace(/\n+---\n面板「设置 → 版本与更新」[\s\S]*$/, '');
  s = s.trim();
  if (s.length > NOTES_MAX) s = s.slice(0, NOTES_MAX) + '\n…（更新说明过长已截断，完整内容见 Release 页面）';
  return s;
}

/**
 * 查最新 Release 的**版本号 + 更新说明**（带 60 秒缓存；失败不缓存）。
 *
 * 更新说明取 Release 的 `body` —— 发布工作流把 CHANGELOG 里该版本那一节整段放进去
 * （见 `.github/workflows/release.yml` 的"摘出发布说明"一步），所以面板里显示的就是"这次改了什么"。
 * 另带 `html_url`（Release 页面）与 `published_at`（发布时间）。
 */
async function resolveLatestInfo({ force = false } = {}) {
  const now = Date.now();
  if (!force && checkCache.value && now - checkCache.at < CHECK_TTL_MS) return checkCache.value;
  const url = `https://api.github.com/repos/${REPO}/releases/latest`;
  const res = await fetch(url, {
    headers: { 'user-agent': 'media-bridge-panel', accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`查询最新版本失败：HTTP ${res.status}`);
  const data = await res.json();
  const v = String(data.tag_name || '').replace(/^v/, '');
  if (!isValidVersion(v)) throw new Error(`最新 Release 的 tag 不是版本号：${data.tag_name}`);
  const info = {
    version: v,
    notes: cleanNotes(data.body),
    notesUrl: String(data.html_url || `https://github.com/${REPO}/releases/tag/v${v}`),
    publishedAt: String(data.published_at || ''),
  };
  checkCache = { at: now, value: info };
  return info;
}

/** 只要版本号（`install()` 那条路用） */
async function resolveLatest(opts) {
  return (await resolveLatestInfo(opts)).version;
}

/* ------------------------------------------------------------------ 安装 */

async function fetchBytes(url, { what }) {
  if (!/^https?:\/\//i.test(url)) {
    const p = url.replace(/^file:\/\//, '');
    if (!fs.existsSync(p)) throw new Error(`${what} 不存在：${p}`);
    return fs.readFileSync(p);
  }
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'media-bridge-panel' },
  });
  if (!res.ok) throw new Error(`${what} 下载失败：HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function parseChecksum(text) {
  const m = String(text).match(/\b([0-9a-fA-F]{64})\b/);
  if (!m) throw new Error('校验文件里找不到 sha256 值');
  return m[1].toLowerCase();
}

function extractTarGz(file, destDir) {
  try {
    execFileSync('tar', ['-xzf', file, '-C', destDir], { stdio: 'pipe' });
  } catch (e) {
    const msg = String((e && e.stderr) || (e && e.message) || '');
    throw new Error(`解包失败：${msg.trim().split('\n').slice(-1)[0]}`);
  }
}

function verifyPackage(dir, version) {
  for (const rel of REQUIRED) {
    if (!fs.existsSync(path.join(dir, rel))) throw new Error(`包里缺少必需文件：${rel}`);
  }
  const p = readJson(path.join(dir, 'package.json'));
  if (!p || String(p.version) !== String(version)) {
    throw new Error(`包内版本(${(p && p.version) || '未知'})与请求版本(${version})不一致`);
  }
}

/**
 * 安装某个版本到 `app/<版本>/`：下载 → 校验 sha256 → 解到暂存目录 → 检查必需文件 →
 * 原子改名 → 写 current.json。任何一步失败都清理暂存目录，**不动正在运行的版本**。
 */
async function install(version) {
  if (!isValidVersion(version)) throw new Error(`版本号不合法：${version}`);

  const finalDir = path.join(APP_ROOT, version);
  if (fs.existsSync(path.join(finalDir, 'server.js'))) {
    console.log(`  · 更新：版本 ${version} 已在磁盘上，直接切换`);
    writeJsonAtomic(CURRENT_FILE, { version, installedAt: new Date().toISOString(), source: 'existing' });
    return { version, downloaded: false };
  }

  const name = `media-bridge-panel-${version}.tar.gz`;
  const srcUrl = sourceUrlOf(version, name);
  const sumUrl = checksumUrlOf(version, name);
  console.log(`  · 更新：下载 ${version} ← ${srcUrl}`);

  const tarball = await fetchBytes(srcUrl, { what: `版本包 ${name}` });
  const expect = parseChecksum((await fetchBytes(sumUrl, { what: `校验文件 ${name}.sha256` })).toString('utf8'));
  const actual = crypto.createHash('sha256').update(tarball).digest('hex');
  if (actual !== expect) throw new Error(`sha256 校验不通过（期望 ${expect.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…），已放弃安装`);

  fs.mkdirSync(APP_ROOT, { recursive: true });
  const staging = path.join(APP_ROOT, `.staging-${version}-${process.pid}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  const tmpTar = path.join(os.tmpdir(), name);
  try {
    fs.writeFileSync(tmpTar, tarball);
    extractTarGz(tmpTar, staging);
    verifyPackage(staging, version);
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(staging, finalDir);
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw e;
  } finally {
    fs.rmSync(tmpTar, { force: true });
  }

  writeJsonAtomic(CURRENT_FILE, { version, installedAt: new Date().toISOString(), source: srcUrl });
  console.log(`  ✔ 更新：已安装 ${version} → ${finalDir}`);
  return { version, downloaded: true };
}

/**
 * 请求监督者把面板重启到某个版本：写 `app/.restart` 标记，然后给自己发 SIGTERM
 * 走正常的关闭流程（停掉托管的源子进程、关监听），退出后由监督者拉起新版本。
 *
 * 延迟一小段时间再发信号，是为了让本次 HTTP 响应先写回客户端。
 */
function requestRestart(to) {
  fs.mkdirSync(APP_ROOT, { recursive: true });
  writeJsonAtomic(RESTART_FILE, { to, reason: 'update', at: new Date().toISOString() });
  setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500);
}

/* ------------------------------------------------------------------ 对外 */

/**
 * 仓库地址 —— 面板界面上要引用它（「设置 → 关于」的链接、Release 链接）。
 * **唯一来源就是这里**（`APP_REPO` 环境变量可覆盖，改名/换仓库只改一处）。
 * 单独一个函数是为了让调用方不必为了拿个链接去跑一次 `status()`（那个会打 GitHub）。
 */
function repoInfo() {
  return { repo: REPO, repoUrl: `https://github.com/${REPO}` };
}

async function status({ force = false } = {}) {
  const current = String(pkg.version || '');
  const installed = listInstalled();
  const lower = installed.filter((v) => compareVersion(v, current) < 0);
  const out = {
    managed: isManaged(),
    current,
    latest: null,
    hasUpdate: false,
    repo: REPO,
    source: String(process.env.APP_SOURCE_URL || '').trim() || `https://github.com/${REPO}/releases/download/v{version}/{name}`,
    appRoot: APP_ROOT,
    runningDir: runningDir(),
    installed,
    previous: lower.length ? lower[lower.length - 1] : null,
    /* 更新说明：前端只在"有新版本"时展示（内容来自 Release 的 body，见 resolveLatestInfo） */
    notes: '',
    notesUrl: '',
    publishedAt: '',
    error: null,
  };

  try {
    const info = await resolveLatestInfo({ force });
    out.latest = info.version;
    out.hasUpdate = compareVersion(info.version, current) > 0;
    out.notes = info.notes;
    out.notesUrl = info.notesUrl;
    out.publishedAt = info.publishedAt;
  } catch (e) {
    out.error = (e && e.message) || String(e);
  }
  return out;
}

module.exports = {
  status,
  install,
  requestRestart,
  resolveLatest,
  resolveLatestInfo,
  isManaged,
  listInstalled,
  repoInfo,
  /* 清理：`pruneOnBoot` 是 `server.js` 启动成功后调的那个；`pruneVersions` 供排障与自测直接调用 */
  pruneVersions,
  pruneOnBoot,
  APP_ROOT,
};
