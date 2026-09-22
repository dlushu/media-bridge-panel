'use strict';
/**
 * 首页插件 · 沙箱子进程（被 spawn 的那一份）
 *
 * 由 `spawn.js` 用
 *   node --permission --allow-fs-read=<sandbox.js> --allow-fs-read=<manifest.js> sandbox.js
 * 拉起：**只允许读这两个文件**，没有 fs 写、没有 net、没有 child_process / worker。
 * 所以插件里既读不到 `data/settings/emby.json`（拿不到 TMDB token），也发不出请求 ——
 * 它唯一的外部能力就是通过 IPC 请面板代做（`http` / `tmdb` / `storage` / `log`）。
 *
 * 一份进程只干一个 job（面板每次执行都新起一个）：job 之间天然不串味，
 * 卡死/崩溃直接 SIGKILL，不会带走面板。协议见 spawn.js 顶部注释。
 *
 * ⚠️ 权限模型挡的是「插件碰不到盘和网」，**不是**「插件在 vm 里出不来」：
 * vm 逃逸仍可能摸到本进程的 `process`，但那个进程什么权限都没有 —— 拿不到 fs、开不了 socket。
 */
const vm = require('vm');
const spec = require('./manifest.js');

const MAX_ITEMS_SERIALIZE = 2000; // 序列化前的粗保护，真正裁剪在面板侧（200 条）

/* ------------------------------------------------------------------ IPC */

let seq = 0;
const pending = new Map();
let finished = false;

/** 请面板代做一件事；失败时把错误还原成带 code/status/data 的 Error 抛回去 */
function rpc(call, args) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    try {
      process.send({ type: 'rpc', id, call, args });
    } catch (e) {
      pending.delete(id);
      reject(spec.fail('IPC_DOWN', '与面板的 IPC 通道断了：' + ((e && e.message) || e)));
    }
  });
}

/** 不等回执的调用（log / storage.set）：面板照样处理，只是不阻塞插件 */
function rpcVoid(call, args) {
  try {
    process.send({ type: 'rpc', id: ++seq, call, args });
  } catch {
    /* 通道断了就算了：这是尽力而为的旁路 */
  }
}

function rehydrate(error) {
  const e = new Error((error && error.message) || '宿主调用失败');
  if (error) {
    e.code = error.code;
    if (error.status !== undefined) e.status = error.status;
    if (error.data !== undefined) e.data = error.data;
  }
  return e;
}

function sendDone(msg) {
  if (finished) return;
  finished = true;
  try {
    process.send(msg, () => process.exit(0));
  } catch {
    process.exit(0);
  }
}

/* ------------------------------------------------------------- Catpaw */

/**
 * 建沙箱。只注入必要的东西；`Math`/`JSON`/`Date`/`Promise` 等内建由 vm 自带（不用宿主对象，
 * 免得凭空多一堆可扒的 `constructor` 链）。
 */
function createSandbox(pluginId, log, storage, env) {
  const imageBase = spec.str(env && env.tmdbImageBase).replace(/\/+$/, '');
  const Catpaw = {
    http: {
      get: (url, opts) => rpc('http.get', [url, opts || {}]),
      post: (url, body, opts) => rpc('http.post', [url, body, opts || {}]),
    },
    tmdb: {
      /** 任意 TMDB 路径 → 响应体本体（**不带 .data 包装**，注意区别）。**异步**，要 await */
      get: (api, opts) => rpc('tmdb.get', [api, opts || {}]),
      /**
       * 按面板设置的图床拼完整图片地址。**同步返回字符串**（不是 Promise，不用 await）——
       * 纯拼串，图床基地址随 job 下发，不必为此跑一次 RPC。
       */
      imageUrlOf: (size, filePath) => {
        const p = spec.str(filePath);
        if (!imageBase || !p) return '';
        return imageBase + '/' + spec.str(size) + (p.startsWith('/') ? p : '/' + p);
      },
    },
    storage: {
      /** 同步：读 job 里带下来的快照 */
      get: (key) => storage[spec.str(key)],
      /** 同步改本地快照 + 请面板落盘（插件不用 await） */
      set: (key, value) => {
        const k = spec.str(key);
        if (!k) return undefined;
        const del = value === undefined;
        if (del) delete storage[k];
        else storage[k] = value;
        rpcVoid('storage.set', [k, del ? null : value, del]);
        return value;
      },
    },
    log: (...args) => log(...args),
  };

  const sandbox = {
    Catpaw,
    console: { log: Catpaw.log, info: Catpaw.log, warn: Catpaw.log, error: Catpaw.log, debug: Catpaw.log },
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    HomePlugin: undefined, // 预声明：插件写了 'use strict' 也能 `HomePlugin = {…}`
  };
  return sandbox;
}

/** 把插件源码跑进 vm，返回归一化清单 + 可调用的 handler */
function load(pluginId, code, log, storage, env) {
  const sandbox = createSandbox(pluginId, log, storage, env);
  vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  try {
    vm.runInContext(code, sandbox, { filename: `${pluginId}/index.js`, timeout: spec.LOAD_TIMEOUT_MS });
  } catch (e) {
    if (e && (e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' || /Script execution timed out/i.test(String(e.message)))) {
      throw spec.fail('LOAD_TIMEOUT', `插件加载超时（${spec.LOAD_TIMEOUT_MS}ms，疑似顶层死循环）`);
    }
    throw spec.fail('SYNTAX', '插件无法加载：' + ((e && e.message) || e));
  }

  const manifest = spec.normalizeManifest(sandbox.HomePlugin);

  const handlers = {};
  for (const row of manifest.rows) {
    const fn = sandbox[row.functionName];
    if (typeof fn !== 'function') {
      throw spec.fail('BAD_MANIFEST', `rows.${row.id}: functionName「${row.functionName}」解析不到函数（须是顶层 function 声明）`);
    }
    handlers[row.functionName] = fn;
  }
  return { manifest, handlers };
}

/**
 * 返回值必须能过 IPC（结构化克隆）：JSON 一趟，顺便把函数/undefined 这类清掉。
 *
 * replacer 里专门拦 **Promise** —— 忘了 await 时 `JSON.stringify` 会把它变成 `{}`，
 * 面板侧只会当成"这个字段没给"而静默丢掉（`imageUrlOf` 曾经就这样让图片全没了）。
 * 宁可当场报错，也不要一个看起来正常、实际缺字段的返回值。
 */
function jsonSafe(v) {
  try {
    const s = JSON.stringify(v, (key, val) => {
      if (val && typeof val.then === 'function') {
        throw new Error(
          `字段「${key || '(根)'}」是 Promise —— 忘了 await？（Catpaw.http / Catpaw.tmdb.get 是异步的；Catpaw.tmdb.imageUrlOf 是同步的）`
        );
      }
      return val;
    });
    if (s === undefined) return { ok: false, error: 'handler 没有返回可序列化的值' };
    if (v && Array.isArray(v) && v.length > MAX_ITEMS_SERIALIZE) {
      return { ok: true, value: JSON.parse(s).slice(0, MAX_ITEMS_SERIALIZE) };
    }
    return { ok: true, value: JSON.parse(s) };
  } catch (e) {
    return { ok: false, error: 'handler 的返回值无法序列化：' + ((e && e.message) || e) };
  }
}

/* ----------------------------------------------------------------- job */

async function runJob(job) {
  const t0 = Date.now();
  const log = (...args) => rpcVoid('log', args);
  const storage = spec.isPlain(job.storage) ? Object.assign({}, job.storage) : {};

  let loaded;
  try {
    loaded = load(job.pluginId, job.code, log, storage, job.env);
  } catch (e) {
    return { type: 'done', ok: false, error: { code: e.code || 'BAD_MANIFEST', message: e.message }, ms: Date.now() - t0 };
  }

  if (job.mode === 'manifest') {
    return { type: 'done', ok: true, manifest: loaded.manifest, ms: Date.now() - t0 };
  }

  const row = loaded.manifest.rows.find((r) => r.id === job.rowId);
  if (!row) {
    return {
      type: 'done',
      ok: false,
      error: { code: 'NOT_FOUND', message: `行不存在：${job.pluginId}/${job.rowId}` },
      ms: Date.now() - t0,
    };
  }

  const params = spec.isPlain(job.params) ? job.params : {};
  /* **客户端的分页原样透传**：`StartIndex`/`Limit` 由 emby 层从请求里取出来塞进 job，
   * 沙箱不做任何切片 —— 取哪一页、要不要按页打上游，是插件的决定。 */
  const startIndex = Math.max(0, Number(job.startIndex) || 0);
  const limit = Math.max(0, Number(job.limit) || 0);
  const timeoutMs = Number(job.timeoutMs) > 0 ? Number(job.timeoutMs) : row.timeoutMs;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const ctx = { params, startIndex, limit, signal: ctrl.signal, log };

  try {
    /* 这里超时只是「放弃结果」；同步死循环连这个定时器都跑不到 —— 那种情况由面板 SIGKILL。
     * 两条一起才完整：平时给出干净的 TIMEOUT 文案，真卡死时面板硬杀。 */
    const timeoutReject = new Promise((_, reject) =>
      ctrl.signal.addEventListener('abort', () => reject(spec.fail('TIMEOUT', `插件执行超时（${timeoutMs}ms）`)))
    );
    const raw = await Promise.race([Promise.resolve().then(() => loaded.handlers[row.functionName](ctx)), timeoutReject]);

    const safe = jsonSafe(raw);
    if (!safe.ok) {
      return { type: 'done', ok: false, error: { code: 'BAD_RESULT', message: safe.error }, ms: Date.now() - t0 };
    }
    return { type: 'done', ok: true, items: safe.value, ms: Date.now() - t0 };
  } catch (e) {
    return {
      type: 'done',
      ok: false,
      error: { code: (e && e.code) || 'PLUGIN_ERROR', message: String((e && e.message) || e), status: e && e.status, data: e && e.data },
      ms: Date.now() - t0,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------------------------------------------- 入口 */

process.on('message', (m) => {
  if (!m || typeof m !== 'object') return;

  if (m.type === 'rpcResult') {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.value);
    else p.reject(rehydrate(m.error));
    return;
  }

  if (m.type === 'job') {
    runJob(m).then(sendDone, (e) =>
      sendDone({ type: 'done', ok: false, error: { code: (e && e.code) || 'SANDBOX', message: String((e && e.message) || e) } })
    );
  }
});

/* 插件把异步回调/定时器里搞炸了：报成这一行的失败，而不是让子进程静默死掉
 * （旧的面板内 vm 也是这个取向，行为对插件作者保持一致）。 */
function failWith(e) {
  sendDone({
    type: 'done',
    ok: false,
    error: { code: 'PLUGIN_ERROR', message: '插件在异步任务里出错：' + ((e && e.message) || e) },
  });
}
process.on('uncaughtException', failWith);
process.on('unhandledRejection', failWith);
process.on('disconnect', () => process.exit(0));
