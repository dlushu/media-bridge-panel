'use strict';
/**
 * 源进程管理：spawn 宿主引导 `host-boot.js`（cwd = 源码包目录），探测监听端口，健康检查
 *
 * **面板就是宿主** —— 等价于 CatPawOpen App 内嵌的 node 运行时，而不是
 * "看源码包脸色、指望它自己起来"：
 *   1. 跑的是面板的 `host-boot.js`，由它 `require` 源码包 → 调 `start(config)`
 *      （`config` = `index.config.js` 的 default 导出），退出时调 `stop()`。详见该文件头部
 *   2. 端口走 **`DEV_HTTP_PORT`**（宿主约定，源码包优先认它），同时给 `PORT` 兼容「自启动型」包
 *   3. 数据目录 = `process.env.NODE_PATH`（源码包的 db / 日志 / 弹幕配置都落在这里）
 *   4. 成功判据只有一条：**目标端口真的能连上**（面板每 500ms 探一次，最多 25 秒）
 *
 * 所以「导出 start/stop 等宿主调用」这种形态**是支持的**（那是上游 douer / Lmentor 的标准做法），
 * 不用它自启动。两种形态都能跑：宿主调用型由面板调 `start()`；自启动型（读了 PORT 就 listen）
 * 由 host-boot 先探端口、认出它已经起来，不重复调 `start()`。
 *
 * 起不来（`start()` 抛错、什么都没监听）时**如实报错**，并把子进程最后几行输出一起给出 ——
 * 让用户/源作者看到真正的原因，而不是一句"运行中"。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const http = require('http');

const fetcher = require('./fetcher');

const DEFAULT_PORT = 9988;
/** 等端口就绪的上限；超了就判定"起不来"（不再乐观地标 running） */
const WAIT_PORT_MS = 25000;
/** 留多少行子进程输出（起不来时给用户看，省得去翻日志） */
const TAIL_MAX = 12;

/** id -> state */
const states = new Map();

function blankState(id) {
  return {
    id,
    status: 'stopped', // stopped | starting | running | stopping | error
    pid: null,
    port: null,
    startedAt: null,
    exitedAt: null,
    exitCode: null,
    error: null,
    proc: null,
    manualStop: false,
    /** 这是面板主动杀的（超时没监听）—— 退出回调别用它自己的文案覆盖上面写好的原因 */
    deliberateKill: false,
    /** 这一轮是否真的监听过端口（判据是 checkAlive 通了或嗅到了 listening 行）—— 用来区分"起来了又停"和"完全没起来" */
    listened: false,
    /** 这次失败是不是「启动阶段就没起来」（这类原因已经写成一段完整说明，别被通用文案覆盖） */
    startupFailure: false,
    /** 子进程输出最后几行 */
    tail: [],
  };
}

function getState(id) {
  if (!states.has(id)) states.set(id, blankState(id));
  return states.get(id);
}

/**
 * 试绑这个地址看端口空不空。
 *
 * ⚠️ **必须显式绑 `0.0.0.0`**（实测）：早期实现里 `host === '0.0.0.0'` 时传的是
 * `undefined`（想表达"所有网卡"），但 Node 会去绑 `::`；在 macOS 上 `::` 跟**已经被别的进程占着的
 * IPv4 `*:port`** 并不冲突 —— 于是"空"是假的，面板会把一个占用中的端口发给源码包。
 * 而源码包（douer / Lmentor）恰恰都绑 `0.0.0.0`，所以按它们的口径试绑才对得上。
 * （实测：`0.0.0.0` 会 EADDRINUSE，`undefined`/`::`/`127.0.0.1` 都不会。）
 */
function isFree(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', () => resolve(false));
    srv.listen({ port, host }, () => srv.close(() => resolve(true)));
  });
}

async function findFreePort(preferred = DEFAULT_PORT, host = '0.0.0.0') {
  const start = Number(preferred) > 0 ? Number(preferred) : DEFAULT_PORT;
  for (let p = start; p < start + 200; p++) {
    // eslint-disable-next-line no-await-in-loop
    if (await isFree(p, host)) return p;
  }
  throw new Error('找不到可用端口');
}

/** 从 stdout/stderr 里解析源实际监听的端口（源码包被占用时会自己 +1，得跟着认） */
function sniffPort(st, line) {
  /* 只认源码包**自己那台服务**的成功日志，两种都见得到：
   *   - 自启动型：`… listening on http://127.0.0.1:9280`
   *   - 宿主调用型：`Server listening on http://0.0.0.0:2333`（douer）/ `服务器启动成功: http://…:19099`（Lmentor）
   * ⚠️ 别把 `Server running on http://0.0.0.0:9321` 也算进来：那是源码包**内部拉起**的辅助服务
   *   （Lmentor 的 danmu_api 就打印这个），认错了会把面板代理指到辅助服务上。 */
  const m = line.match(/(?:listening on|服务器启动成功[:：])\s*https?:\/\/[^:/\s]+:(\d+)/i);
  if (!m) return;
  const port = Number(m[1]);
  if (!port) return;
  /* 打印了 listening 行 = 它确实监听了（哪怕端口与面板分配的一致，也说明起得来） */
  st.listened = true;
  if (st.port === port) return;
  st.port = port;
  if (st.status === 'starting') {
    st.status = 'running';
    st.startedAt = st.startedAt || Date.now();
  }
}

function checkAlive(port, timeout = 1500) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/check', timeout },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve({ run: res.statusCode === 200 });
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

/**
 * 「起不来」的统一说明。面板这边已经把宿主该做的都做了（require 源码包 + 调 start(config) +
 * 给 DEV_HTTP_PORT/NODE_PATH），所以没起来基本落在源码包自己身上：start() 抛错、start() 是空实现、
 * 或者包依赖 App 才有的东西（Dart 桥 / 私有全局）。把**子进程最后的输出**一起给出 —— 那才是真正的原因。
 */
function startupProblem(st, head) {
  return (
    head +
    '面板是照「宿主」的方式起的：require 源码包 → 调 start(config)，端口给的是 DEV_HTTP_PORT，' +
    '数据目录给的是 NODE_PATH（和 CatPawOpen App 一样；`start`/`stop` 这种写法是支持的）。' +
    '所以问题在源码包这边，常见是：start() 里抛了错、start() 是空实现、' +
    '或者它依赖只有 App 才有的东西（Dart 桥之类的宿主私有能力）。' +
    (st.tail && st.tail.length ? ` 子进程最后的输出：${st.tail.slice(-3).join(' ⏎ ')}` : ' 子进程没有任何输出。')
  );
}

/**
 * 判定「启动阶段就没起来」并落地原因。成功过 / 被手动停 / 已由别人处理 → 一律不动。
 *
 * ⚠️ 这条一定要覆盖**"进程自己干净退出（code=0）但始终没监听"**：以前走的是通用分支
 * （`code === 0 → stopped`），界面上表现为**源点了运行、一秒后变「已停止」，一个字的解释都没有**。
 * 起不来就如实说，别静默。
 */
function failStartup(st, head) {
  if (st.listened || st.manualStop || st.deliberateKill) return false;
  st.status = 'error';
  st.startupFailure = true;
  st.error = startupProblem(st, head);
  return true;
}

async function start(source, opts = {}) {
  const id = source.id;
  const st = getState(id);
  if (st.proc || st.status === 'starting' || st.status === 'running') {
    throw new Error('该源已在运行');
  }

  const dir = source.dir;
  const runtime = source.runtimeDir;
  fs.mkdirSync(runtime, { recursive: true });
  if (!fs.existsSync(path.join(dir, 'index.js'))) {
    throw new Error('本地缺少 index.js，请先更新源文件');
  }

  /* 跑之前先校验文件完整性：md5 对不上（下载到一半 / 被改过 / 被别的东西覆盖）就**拒绝启动** ——
   * 何况它会以 node 跑起来并读到 runtime/ 里含 cookie/token 的东西。详见 fetcher.verifyBundle
   * 这里**只读不删**：删文件是「更新」那条路的事（下载后校验不过才删残留），
   * 启动这条只负责拒绝 + 告诉人怎么办（重新更新，或者直接把这个源删掉）。 */
  const verify = fetcher.verifyBundle(dir);
  if (!verify.ok) {
    throw new Error(`源文件校验不通过，无法启动：${verify.error}。可点「更新」重新下载，或直接删除这个源`);
  }
  console.log(`  ✔ 源文件校验通过（index.js md5=${String(verify.actual).slice(0, 8)}…，${verify.checked.length} 项）`);

  const host = opts.host || source.host || '0.0.0.0';
  const wantPort = opts.port || source.port || 0;
  const port = await findFreePort(wantPort || DEFAULT_PORT, host);

  /* 环境变量（宿主约定，见 host-boot.js 头部）：
   *   NODE_PATH      源码包的数据目录（db / 日志 / 弹幕配置）
   *   DEV_HTTP_PORT  **宿主约定的端口**，源码包优先认它（douer/Lmentor 都是）
   *   PORT/HOST      兼容「自启动型」源码包（它们读 PORT）
   * ⚠️ `CATVOD_DISABLE_AUTOSTART` 要清掉：那是「别自启动」的开关，清了才好在两种形态下都跑起来
   *   （自启动型自己起来，宿主调用型由 host-boot 调 start）。 */
  const env = Object.assign({}, process.env, {
    NODE_PATH: runtime,
    PORT: String(port),
    DEV_HTTP_PORT: String(port),
    HOST: host,
    DEV_HTTP_HOST: host,
  });
  delete env.CATVOD_DISABLE_AUTOSTART;

  st.status = 'starting';
  st.error = null;
  st.exitCode = null;
  st.exitedAt = null;
  st.port = port;
  st.manualStop = false;
  st.deliberateKill = false;
  st.listened = false;
  st.startupFailure = false;
  st.tail = [];
  st.startedAt = Date.now();

  /* 跑的是**面板的宿主引导**（cwd 还是源码包目录，源码包内的相对路径照旧有效），
   * 由它 require 源码包并调 start(config)。以前是直接 `node index.js` —— 那样只有"自启动型"包能跑，
   * 而 douer/Lmentor 这一支（上游主流）是等宿主来调 start() 的，会一直起不来。 */
  const boot = path.join(__dirname, 'host-boot.js');
  const proc = spawn(process.execPath, [boot], {
    cwd: dir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  st.proc = proc;
  st.pid = proc.pid;

  /* 子进程输出：**既用来嗅探端口，也留最后几行** ——
   * 起不来时那是唯一能说明原因的线索（以前是"嗅探完就丢"，于是用户只能看到一句"启动中/异常"）。 */
  const sniff = (d) => {
    for (const line of d.toString().split('\n')) {
      sniffPort(st, line);
      const t = line.trim();
      if (t) st.tail = st.tail.concat(t.slice(0, 300)).slice(-TAIL_MAX);
    }
  };
  proc.stdout.on('data', sniff);
  proc.stderr.on('data', sniff);

  proc.on('error', (err) => {
    st.error = String(err && err.message);
    st.status = 'error';
  });

  proc.on('exit', (code, signal) => {
    const wasManual = st.manualStop;
    const deliberate = st.deliberateKill;
    st.proc = null;
    st.pid = null;
    st.exitCode = code;
    st.exitedAt = Date.now();
    if (wasManual) {
      st.status = 'stopped';
    } else if (deliberate) {
      /* 面板因"超时没监听"主动杀的 —— 状态与原因调用方已经写好了，别覆盖成"异常退出" */
    } else if (failStartup(st, `源码包进程启动后就退出了（exitCode=${code} signal=${signal || '-'}），始终没监听端口。`)) {
      /* 刚起来就退 —— 和"超时没监听"是同一类问题，一句话说清（含子进程输出） */
    } else if (code === 0) {
      st.status = 'stopped';
    } else {
      st.status = 'error';
      st.error = `进程异常退出 code=${code} signal=${signal || '-'}`;
    }
  });

  /* stdio 到 'close' 才排空 —— 上面（'exit' 里）写好的"起不来"原因在这里用**完整输出**重写一遍，
   * 免得界面上那句「子进程没有任何输出」实际是还没来得及读。
   * ⚠️ 但不包括"因超时没监听而主动杀的"那种：那时原因已经写全了（带"25 秒内没监听"），
   *    用 `exitCode=null` 去覆盖反而把关键信息弄丢。 */
  proc.on('close', () => {
    if (st.startupFailure && !st.listened && !st.deliberateKill && !st.manualStop) {
      st.error = startupProblem(st, `源码包进程启动后就退出了（exitCode=${st.exitCode}），始终没监听端口。`);
    }
  });

  /* 端口就绪的等待**放后台跑**，不挂在这次请求上：
   * 以前 `await` 到底 —— 于是 `POST /start` 要**阻塞最多 25 秒**，界面上表现为"点了运行没反应"。
   * 现在立刻回 `starting`；前端每 5 秒的轮询会把状态翻成 running/error（面板日志也记一行结果）。
   * 例外：`opts.awaitReady`（自启用，见 source/index.js）—— 那时要**等它真监听上**再起下一个源，
   * 否则第二个源选端口时第一个还没绑定，两个源会拿到同一个端口。 */
  const ready = waitReady(id);
  if (opts.awaitReady) await ready;
  return publicState(id);
}

/**
 * 等端口就绪（最多 `WAIT_PORT_MS`）—— **后台任务**，由 `start()` 触发、不 await。
 * 结束后更新状态并往面板日志写一行（成功/失败都写，失败带原因与子进程输出）。
 */
async function waitReady(id) {
  const st = getState(id);
  const deadline = Date.now() + WAIT_PORT_MS;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const alive = await checkAlive(st.port, 800);
    if (alive) {
      st.listened = true;
      st.status = 'running';
      st.startedAt = st.startedAt || Date.now();
      break;
    }
    if (!st.proc) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 500));
  }

  /* 期间被别人停了/杀了 / 已经起不来并写好原因了 → 别覆盖人家的状态 */
  if (st.status !== 'starting') {
    if (st.status === 'running') console.log(`  ✔ 源就绪：${id} :${st.port}`);
    else if (st.status === 'error') console.log(`  ✘ 源起不来：${id} — ${st.error}`);
    return;
  }

  /* 兜底：进程没了但退出回调没来得及定性（正常路径已由 exit/close 处理） */
  if (!st.proc) {
    failStartup(st, `源码包进程启动后就退出了（exitCode=${st.exitCode}），始终没监听端口。`);
    console.log(`  ✘ 源起不来：${id} — ${st.error}`);
    return;
  }

  /* ⚠️ **不能乐观地报 running**。
   * 以前这里写的是 `st.status = st.proc ? 'running' : 'error'` —— 只要进程还活着就算运行中，
   * 于是"起来了但根本不监听"的包在界面上显示「运行中 · :9989」，实际连都连不上，
   * 排查只能靠猜。现在：**没监听到端口就是跑不起来**，如实报错。
   * 把进程杀掉（它不会监听了，留着只占一个进程和一个端口），并把**子进程最后的输出**一并给出。 */
  st.deliberateKill = true;
  try {
    st.proc.kill('SIGKILL');
  } catch {
    /* 已经退了就算了 */
  }
  st.status = 'error';
  st.startupFailure = true;
  st.error = startupProblem(st, `源码包没在 ${WAIT_PORT_MS / 1000} 秒内监听端口（面板给的是 DEV_HTTP_PORT=${st.port || DEFAULT_PORT}）。`);
  console.log(`  ✘ 源起不来：${id} — ${st.error}`);
}

async function stop(id) {
  const st = getState(id);
  if (!st.proc) {
    st.status = st.status === 'error' ? 'error' : 'stopped';
    return publicState(id);
  }
  st.manualStop = true;
  st.status = 'stopping';
  const proc = st.proc;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    proc.once('exit', finish);
    try {
      proc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      if (proc.exitCode === null) {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }, 2500);
    setTimeout(finish, 5000);
  });
  st.status = st.proc ? 'running' : 'stopped';
  return publicState(id);
}

async function restart(source, opts) {
  await stop(source.id);
  await new Promise((r) => setTimeout(r, 400));
  return start(source, opts);
}

async function stopAll() {
  const ids = Array.from(states.keys());
  await Promise.all(
    ids.map((id) =>
      stop(id).catch(() => {
        /* ignore */
      })
    )
  );
}

async function status(id, { alive = true } = {}) {
  const out = publicState(id);
  if (alive && out.status === 'running' && out.port) {
    const r = await checkAlive(out.port, 1200);
    out.alive = !!r && r.run !== false;
  }
  return out;
}

function publicState(id) {
  const st = getState(id);
  return {
    id,
    status: st.status,
    pid: st.pid,
    port: st.port,
    startedAt: st.startedAt,
    exitedAt: st.exitedAt,
    exitCode: st.exitCode,
    error: st.error,
    /* 子进程最后几行输出 —— 起不来时界面直接显示它，不必去翻面板日志 */
    tail: (st.tail || []).slice(-6),
  };
}

module.exports = {
  DEFAULT_PORT,
  start,
  stop,
  restart,
  stopAll,
  status,
  publicState,
  findFreePort,
};
