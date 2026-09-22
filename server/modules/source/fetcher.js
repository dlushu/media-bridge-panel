'use strict';
/**
 * 猫源下载器
 *
 * 猫源目录约定（与官方 Lampon/CatPawOpen 的 nodejs/dist 产物一致）：
 *   <base>/index.js             源服务本体（esbuild 打包，可被 node 直接执行）
 *   <base>/index.config.js      默认配置产物（module.exports.default）
 *   <base>/index.js.md5         上面两个文件的 md5，用于判断是否有更新
 *   <base>/index.config.js.md5
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* 对外自称读 core/branding.js（改名只改那一处）—— 源站那边只看得到这个 UA */
const BRAND = require('../../core/branding');
const UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ${BRAND.ua}`;
const REQUIRED_FILES = ['index.js'];
const ALL_FILES = ['index.js', 'index.config.js', 'index.js.md5', 'index.config.js.md5'];

function md5(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

/** 把用户填的地址标准化成以 / 结尾的基地址 */
function normalizeBaseUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) throw new Error('请填写猫源地址');
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  u = u.replace(/\/+$/, '');
  u = u.replace(/\/index\.js(\.md5)?$/i, '');
  u = u.replace(/\/index\.config\.js(\.md5)?$/i, '');
  return u + '/';
}

async function httpGet(url, { timeout = 40000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: res.ok, status: res.status, buf, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

function readLocalMd5(dir, name) {
  try {
    return fs.readFileSync(path.join(dir, name), 'utf8').trim().toLowerCase();
  } catch {
    return null;
  }
}

/** 只探测 md5 文件，用于快速判断远端是否更新 */
async function probeRemote(base) {
  const out = {};
  for (const name of ['index.js.md5', 'index.config.js.md5']) {
    try {
      const r = await httpGet(base + name, { timeout: 15000 });
      out[name] = r.ok ? r.buf.toString('utf8').trim().toLowerCase() : null;
    } catch {
      out[name] = null;
    }
  }
  return out;
}

/**
 * 下载/更新一个源到本地目录
 *
 * **下载后必校验**：拿到的 `index.js` 必须与官方的 `index.js.md5` 一致，不一致就**删掉下载的残留**
 * 并回报 `ok:false` —— 不留半成品、也不拿实际值去覆写 md5 假装成功（那样等于把校验作废）。
 * 该源因此用不了了（缺文件，运行前的 `verifyBundle` 会拦下），这正是想要的结果。
 *
 * @returns {{ok:boolean, changed:boolean, files:object, md5Mismatch:boolean, error?:string, removed?:string[]}}
 */
async function download(base, dir, { force = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });

  // 1. 先探测远端 markdown 校验值，判断要不要重复拉 6MB 的 bundle
  const remote = await probeRemote(base);
  const remoteIndexMd5 = remote['index.js.md5'];
  const localIndexMd5 = readLocalMd5(dir, 'index.js.md5');
  const hasLocal = fs.existsSync(path.join(dir, 'index.js'));

  if (!force && hasLocal && remoteIndexMd5 && localIndexMd5 && remoteIndexMd5 === localIndexMd5) {
    return { ok: true, changed: false, files: {}, md5Mismatch: false, remoteMd5: remote };
  }

  // 2. 下载主体文件
  const result = { ok: true, changed: false, files: {}, md5Mismatch: false, remoteMd5: remote };
  for (const name of ALL_FILES) {
    // md5 文件若探测阶段已拿到，直接落盘，省一次请求
    if (name.endsWith('.md5') && remote[name]) {
      fs.writeFileSync(path.join(dir, name), remote[name] + '\n');
      continue;
    }
    if (name.endsWith('.md5') && remote[name] === null && !fs.existsSync(path.join(dir, name))) {
      continue; // 远端没有这个文件也没有本地副本，跳过
    }
    const res = await httpGet(base + name);
    if (!res.ok) {
      if (REQUIRED_FILES.includes(name)) {
        throw new Error(`下载 ${name} 失败：HTTP ${res.status}，该地址可能不是有效的猫源（基地址：${base}）`);
      }
      continue;
    }
    const body = name.endsWith('.md5') ? res.buf.toString('utf8').trim() + '\n' : res.buf;
    fs.writeFileSync(path.join(dir, name), body);
    const st = fs.statSync(path.join(dir, name));
    result.files[name] = { size: st.size, md5: md5(res.buf), mtime: st.mtimeMs };
  }

  // 3. 校验：拿到的 index.js 必须与官方 md5 一致
  const actual = md5(fs.readFileSync(path.join(dir, 'index.js')));
  const expected = readLocalMd5(dir, 'index.js.md5');
  const bad = !expected
    ? '这个地址没有提供 index.js.md5，无法校验下载到的文件'
    : expected !== actual
      ? `下载到的 index.js 与官方 md5 不一致（实际 ${actual.slice(0, 12)}… / 官方 ${expected.slice(0, 12)}…）`
      : null;

  if (bad) {
    /* 用不了就把下载的残留删掉：留着也跑不起来（运行前 verifyBundle 会拦），
     * 还会以"本地有文件"的假象造成误判。删干净后该源明确地处于"未下载"状态，点「更新」即可重来。 */
    const removed = [];
    for (const name of ALL_FILES) {
      try {
        fs.rmSync(path.join(dir, name));
        removed.push(name);
      } catch {
        /* 本来就没有就算了 */
      }
    }
    return { ok: false, changed: false, files: result.files, md5Mismatch: true, removed, error: `源文件校验不通过：${bad}。已删除下载的残留，该源无法运行` };
  }

  result.changed = true;
  return result;
}

/** 从磁盘读取 index.js 的大小信息 */
function localFileInfo(dir, name) {
  try {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    return { name, size: st.size, mtime: st.mtimeMs, md5: readLocalMd5(dir, name + '.md5') || md5(fs.readFileSync(p)) };
  } catch {
    return null;
  }
}

/**
 * 运行前校验：本地文件是否与随包的 md5 一致 —— **校验不过就不该跑起来**。
 * （跑的是 6MB 的 bundle，且它能读到 runtime/ 里含 cookie/token 的东西；
 * 下载到一半、被手工改过、被别的东西覆盖，都不该静默运行。）
 *
 * 规则：
 *   - `index.js` 必查：它与 `index.js.md5` **必须都在且一致**；缺 md5 也算不过（没有 md5 就无从确认完整性）
 *   - `index.config.js` 那对：**存在就校验，缺失不拦** —— 它本地根本不被运行，且部分源远端本就不提供
 *
 * 只读，不修文件；返回 { ok, error, checked: [{name, ok, reason?}] }
 */
function verifyBundle(dir) {
  const checked = [];
  const fail = (name, reason) => {
    checked.push({ name, ok: false, reason });
    return { ok: false, error: `本地 ${name} ${reason}`, checked };
  };

  if (!fs.existsSync(path.join(dir, 'index.js'))) return fail('index.js', '不存在');
  const expected = readLocalMd5(dir, 'index.js.md5');
  if (!expected) return fail('index.js.md5', '缺失（无法确认 index.js 是否完整）');
  const actual = md5(fs.readFileSync(path.join(dir, 'index.js')));
  if (actual !== expected) {
    checked.push({ name: 'index.js', ok: false, reason: 'md5 不一致' });
    return { ok: false, error: `index.js 与 index.js.md5 不一致（本地 ${actual.slice(0, 12)}… / 期望 ${expected.slice(0, 12)}…）`, checked };
  }
  checked.push({ name: 'index.js', ok: true });

  /* config 那一对：两个都在才校验，缺任何一个都跳过（不是每个源都提供） */
  const cfg = path.join(dir, 'index.config.js');
  const cfgMd5 = readLocalMd5(dir, 'index.config.js.md5');
  if (fs.existsSync(cfg) && cfgMd5) {
    const cfgActual = md5(fs.readFileSync(cfg));
    if (cfgActual !== cfgMd5) {
      checked.push({ name: 'index.config.js', ok: false, reason: 'md5 不一致' });
      return { ok: false, error: `index.config.js 与 index.config.js.md5 不一致`, checked };
    }
    checked.push({ name: 'index.config.js', ok: true });
  } else {
    checked.push({ name: 'index.config.js', ok: true, reason: 'skipped（文件或 md5 缺失，本地运行不读它）' });
  }

  return { ok: true, error: null, checked, actual };
}

module.exports = {
  ALL_FILES,
  md5,
  normalizeBaseUrl,
  download,
  probeRemote,
  localFileInfo,
  verifyBundle,
  readLocalMd5,
};
