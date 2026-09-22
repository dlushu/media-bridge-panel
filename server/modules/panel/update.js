'use strict';
/**
 * 面板自身更新（决策与理由见 docs/adr/0019-self-update-from-release.md）。
 *
 * 只做三件事：查最新版本、把某个 Release 版本装到数据卷、请求监督者重启。
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

/** 查最新 Release 的版本号（带 60 秒缓存；失败不缓存） */
async function resolveLatest({ force = false } = {}) {
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
  checkCache = { at: now, value: v };
  return v;
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
    error: null,
  };

  try {
    const latest = await resolveLatest({ force });
    out.latest = latest;
    out.hasUpdate = compareVersion(latest, current) > 0;
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
  isManaged,
  listInstalled,
  APP_ROOT,
};
