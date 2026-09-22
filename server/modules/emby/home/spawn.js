'use strict';
/**
 * 首页插件 · 沙箱宿主（面板侧）
 *
 * 每次执行**新起一个子进程**跑 `sandbox.js`，并在这个进程里代做插件碰不到的事：
 *   http / tmdb  → 面板有网，插件没有
 *   storage      → 面板有盘，插件没有（插件侧 `get` 读快照、`set` 同步改快照 + 通知这里落盘）
 *   log          → 面板控制台
 *
 * 权限（`--permission`）：只允许读 `sandbox.js` 与 `manifest.js` 两个文件，
 * 其余一律拒绝 —— fs 写、net、child_process、worker 全没有。
 * 这是「插件读不到 data/settings/emby.json（TMDB token）」的实际保证。
 *
 * 超时是**两层**：子进程内部到点放弃结果并回报 TIMEOUT（文案干净）；
 * 面板这边再按 timeoutMs + GRACE 硬 SIGKILL —— 同步死循环连内部定时器都跑不到，
 * 只有硬杀能收场（旧的面板内 vm 做不到这点）。
 *
 * IPC 协议：
 *   面板 → 子进程  { type:'job', mode:'manifest'|'run', pluginId, code, rowId?, params?, timeoutMs, storage }
 *   面板 → 子进程  { type:'rpcResult', id, ok:true, value } | { type:'rpcResult', id, ok:false, error }
 *   子进程 → 面板  { type:'rpc', id, call, args }
 *   子进程 → 面板  { type:'done', ok:true, manifest?|items?, ms } | { type:'done', ok:false, error, ms }
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const tmdb = require('../tmdb');
const store = require('./store');
const spec = require('./manifest');

/** 硬杀比子进程自己的超时多留一点，让「干净超时」先有机会发生 */
const HARD_GRACE_MS = 2000;
const HTTP_TIMEOUT_MS = 15000;
const STORAGE_VALUE_MAX = 512 * 1024;
const STORAGE_TOTAL_MAX = 2 * 1024 * 1024;

/* 面板自己都是被软链指着的路径时，`--allow-fs-read` 必须给真实路径（macOS 的 /tmp 就是软链，
 * 拿软链路径去 allow 会匹配不上，子进程连自己都加载不了）。 */
function realFile(p) {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

const SANDBOX_FILE = realFile(path.join(__dirname, 'sandbox.js'));
const MANIFEST_FILE = realFile(path.join(__dirname, 'manifest.js'));

/* Node 23.5 之前这个开关叫 --experimental-permission。不假设版本，先试 --permission，
 * 真的不被认识（child 报 bad option）再换名字并记住 —— 两个都不行就明确报错，
 * **不会**静默降级成"没有权限模型也照跑"。 */
const FLAG_CANDIDATES = ['--permission', '--experimental-permission'];
let flagIndex = 0;

/* ------------------------------------------------------------------ HTTP */

/** `Catpaw.http.*` 的实现（面板侧）：非 2xx **抛错**（err.status / err.data），成功回 `{status, headers, data}` */
async function httpRequest(url, opts = {}) {
  const u0 = spec.str(url);
  if (!/^https?:\/\//i.test(u0)) throw spec.fail('BAD_URL', '只允许 http(s) 地址：' + (u0 || '(空)'));

  let u = u0;
  if (spec.isPlain(opts.params)) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.params)) {
      if (v === undefined || v === null || v === '') continue;
      qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) u += (u.includes('?') ? '&' : '?') + s;
  }

  const method = String(opts.method || 'GET').toUpperCase();
  const hasBody = opts.body !== undefined && opts.body !== null;
  const payload = hasBody ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined;
  const headers = Object.assign({}, spec.isPlain(opts.headers) ? opts.headers : {});
  if (hasBody && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }

  const timeout = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : HTTP_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);

  let res;
  try {
    res = await fetch(u, { method, headers, body: payload, signal: ctrl.signal, redirect: 'follow' });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') throw spec.fail('TIMEOUT', `请求超时（${timeout}ms）：${u}`);
    throw spec.fail('NETWORK', `连不上：${((e && e.message) || e)}（${u}）`);
  }
  clearTimeout(timer);

  const text = await res.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON：原样给文本 */
  }
  const out = { status: res.status, headers: Object.fromEntries(res.headers.entries()), data };
  if (!res.ok) {
    const e = spec.fail('HTTP_' + res.status, `请求失败 HTTP ${res.status}：${u}`);
    e.status = res.status;
    e.data = data;
    throw e;
  }
  return out;
}

/* ------------------------------------------------------------------ RPC */

/** 面板代做的能力清单；这里就是「插件能对外做什么」的全部 */
function dispatch(call, args, ctx) {
  switch (call) {
    case 'http.get':
      return httpRequest(args[0], Object.assign({}, args[1], { method: 'GET' }));
    case 'http.post':
      return httpRequest(args[0], Object.assign({}, args[2], { method: 'POST', body: args[1] }));
    case 'tmdb.get':
      return tmdb.get(args[0], args[1]);
    case 'storage.set':
      return storageSet(ctx, args[0], args[1], args[2] === true);
    case 'log':
      console.log(`      [home:${ctx.pluginId}]`, ...(Array.isArray(args) ? args : [args]));
      return null;
    default:
      throw spec.fail('BAD_CALL', '未知的宿主调用：' + call);
  }
}

/** 插件侧 `Catpaw.storage.set`：改快照 + 整份落盘（面板是唯一的写盘方，不会和子进程抢文件） */
function storageSet(ctx, key, value, del) {
  const k = spec.str(key);
  if (!k) return null;
  if (del) {
    delete ctx.storage[k];
  } else {
    const size = byteLen(value);
    if (size > STORAGE_VALUE_MAX) {
      console.log(`  ✘ home 插件 storage 写入超限已忽略：${ctx.pluginId} 键「${k}」${size} 字节`);
      return null;
    }
    ctx.storage[k] = value;
  }
  if (byteLen(ctx.storage) > STORAGE_TOTAL_MAX) {
    console.log(`  ✘ home 插件 storage 总量超限已忽略：${ctx.pluginId}（>${STORAGE_TOTAL_MAX} 字节）`);
    delete ctx.storage[k];
    return null;
  }
  /* 「(校验)」这类面板内部用的占位 id 不落盘（它不是一个真插件） */
  if (spec.ID_RE.test(ctx.pluginId)) store.writeStorage(ctx.pluginId, ctx.storage);
  return del ? null : value;
}

function byteLen(v) {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? 0 : Buffer.byteLength(s);
  } catch {
    return STORAGE_TOTAL_MAX + 1; // 序列化不了 = 当超限拒掉
  }
}

/** 错误 → 能过 IPC 的纯对象 */
function errToJson(e) {
  return {
    code: (e && e.code) || 'RPC_ERROR',
    message: String((e && e.message) || e),
    status: e && e.status,
    data: e && e.data,
  };
}

/* --------------------------------------------------------------- 起进程 */

function launch(flag, job) {
  return new Promise((resolve, reject) => {
    const args = [
      flag,
      `--allow-fs-read=${SANDBOX_FILE}`,
      `--allow-fs-read=${MANIFEST_FILE}`,
      SANDBOX_FILE,
    ];

    let child;
    try {
      child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    } catch (e) {
      const err = new Error('无法启动沙箱子进程：' + ((e && e.message) || e));
      err.code = 'SANDBOX';
      return reject(err);
    }

    const timeoutMs = Number(job.timeoutMs) > 0 ? Number(job.timeoutMs) : spec.DEFAULT_RUN_TIMEOUT_MS;
    let stderr = '';
    let settled = false;
    let hardTimer = null;

    const ctx = {
      pluginId: job.pluginId,
      storage: spec.isPlain(job.storage) ? Object.assign({}, job.storage) : {},
    };

    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经没了 */
      }
      fn(v);
    };

    child.stdout.on('data', () => {}); // 子进程不该往 stdout 写东西；有也忽略（协议走 IPC）
    child.stderr.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });

    child.on('error', (e) => {
      const err = new Error('沙箱子进程启动失败：' + ((e && e.message) || e));
      err.code = 'SANDBOX';
      finish(reject, err);
    });

    child.on('exit', (code, signal) => {
      if (signal === 'SIGKILL' && settled) return;
      const tail = stderr.trim().split('\n').filter(Boolean).pop() || '';
      const err = new Error(
        `沙箱子进程异常退出（code=${code} signal=${signal || '-'}）${tail ? '：' + tail : ''}`
      );
      err.code = /bad option|Unknown option/i.test(stderr) ? 'FLAG_UNSUPPORTED' : 'CHILD_EXIT';
      err.stderr = stderr;
      finish(reject, err);
    });

    child.on('message', (m) => {
      if (!m || typeof m !== 'object') return;

      if (m.type === 'rpc') {
        Promise.resolve()
          .then(() => dispatch(m.call, m.args, ctx))
          .then(
            (value) => ({ type: 'rpcResult', id: m.id, ok: true, value: value === undefined ? null : value }),
            (e) => ({ type: 'rpcResult', id: m.id, ok: false, error: errToJson(e) })
          )
          .then((reply) => {
            if (settled) return;
            try {
              child.send(reply);
            } catch {
              /* 子进程已经走了 */
            }
          });
        return;
      }

      if (m.type === 'done') finish(resolve, m);
    });

    /* 硬杀兜底：子进程内部超时会先回报 TIMEOUT，这条只在它连定时器都跑不到时生效 */
    hardTimer = setTimeout(() => {
      const err = new Error(`插件执行超时（${timeoutMs}ms，同步卡死已终止子进程）`);
      err.code = 'TIMEOUT';
      finish(reject, err);
    }, timeoutMs + HARD_GRACE_MS);

    try {
      /* env：拼图用的图床基地址随 job 下发（`Catpaw.tmdb.imageUrlOf` 在沙箱里**同步**拼串，
       * 不走 RPC —— 见 sandbox.js 里的说明）。 */
      child.send(Object.assign({ type: 'job' }, job, { env: { tmdbImageBase: tmdb.imageBase() } }));
    } catch (e) {
      const err = new Error('下发 job 失败：' + ((e && e.message) || e));
      err.code = 'SANDBOX';
      finish(reject, err);
    }
  });
}

/**
 * 跑一个 job，返回子进程的 `done` 消息。
 * 失败一律 **抛错**（err.code 见上）；调用方决定是回 4xx 还是包成 `{ok:false}`。
 */
async function runJob(job) {
  for (;;) {
    try {
      return await launch(FLAG_CANDIDATES[flagIndex], job);
    } catch (e) {
      /* 这个 Node 不认识这个开关名 → 换下一个；换完还不行就照实报错，不静默降级 */
      if (e && e.code === 'FLAG_UNSUPPORTED' && flagIndex < FLAG_CANDIDATES.length - 1) {
        console.log(`  ↻ 沙箱：本机 Node 不认识 ${FLAG_CANDIDATES[flagIndex]}，改用 ${FLAG_CANDIDATES[flagIndex + 1]}`);
        flagIndex++;
        continue;
      }
      if (e && e.code === 'FLAG_UNSUPPORTED') {
        const err = new Error(
          `当前 Node（${process.version}）不支持权限模型沙箱（${FLAG_CANDIDATES.join(' / ')} 都不认）—— 首页插件需要 Node 20+`
        );
        err.code = 'SANDBOX';
        throw err;
      }
      throw e;
    }
  }
}

module.exports = {
  SANDBOX_FILE,
  MANIFEST_FILE,
  HARD_GRACE_MS,
  httpRequest,
  runJob,
};
