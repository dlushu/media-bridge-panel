'use strict';
/**
 * 猫源宿主引导 —— 面板 spawn 的是**这个文件**（cwd = 源码包目录），而不是 `node index.js`。
 *
 * 它做的是 CatPawOpen App 内嵌 node 运行时做的同一件事：
 *     require 源码包 → 按约定调 `start(config)` → 收到 SIGTERM 调 `stop()`
 *
 * 约定（实测自上游 douer 引擎与 Lmentor 源码包，两边完全一致）：
 *   1. **宿主全局 `catServerFactory`**：源码包把它直接交给 fastify
 *      （`fastify({serverFactory:catServerFactory,…})`，**裸标识符**）。
 *      宿主不声明 = ReferenceError，所以这里必须先声明。
 *      值给 `undefined` 等价于 fastify 默认（node 自带 http server）——
 *      也就是 `npm start` 直接跑源码包的效果；App 传的是它自己的 server。
 *   2. **端口 `DEV_HTTP_PORT`**：宿主指定，优先级最高
 *      （上游写法：`let l = (u && process.env.DEV_HTTP_PORT) ? process.env.DEV_HTTP_PORT : c`，
 *      不给就用包里的默认端口 —— douer 2333 / Lmentor 9988 —— 且端口被占会 +1）。
 *   3. **数据目录 `NODE_PATH`**：源码包把 db / 日志 / 弹幕配置都写在它下面。
 *   4. **配置 = `index.config.js` 的 default 导出**：就是 `start()` 的参数；
 *      包在首次启动时用它初始化 db（之后以 db 为准）。
 *   5. **生命周期**：`module.exports = { start, stop }`。
 *
 * 两种形态都认，不必让用户区分：
 *   - 「宿主调用型」（douer / Lmentor 这一支）：导出 `start`/`stop`，等宿主来调 —— 下面这套就是为它写的
 *   - 「自启动型」：require 阶段自己读 `PORT` 就 `listen`，可能没有 `start` ——
 *     所以 require 之后**先看目标端口有没有人应答**，有人应答就不再调 `start()`（免得起两份）
 *
 * 起不来（`start()` 抛错 / 什么都没监听）时**照实把错抛出去**：进程非 0 退出、错误进子进程输出，
 * 面板会把最后几行原样显示给用户。
 */
const fs = require('fs');
const net = require('net');
const path = require('path');

const DIR = process.cwd();
/** 端口：面板给的是 DEV_HTTP_PORT（宿主约定），PORT 兜底兼容自启动型 */
const PORT = Number(process.env.DEV_HTTP_PORT || process.env.PORT || 0);
/** 等自启动型源码包把端口拉起来的宽限时间（`listen()` 是异步生效的，所以得轮询一小会儿） */
const AUTOSTART_GRACE_MS = 1200;
/** 轮询间隔 */
const POLL_MS = 100;

/** 宿主全局：值给 undefined = 用 node 默认 http server（fastify 的默认行为） */
if (!Object.prototype.hasOwnProperty.call(globalThis, 'catServerFactory')) {
  globalThis.catServerFactory = undefined;
}

/** 源码包导出的模块（SIGTERM 时要用它调 stop()） */
let mod = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 目标端口有没有人在监听（TCP 连得上就算，不关心它答什么） */
function portOpen(port, timeout = 700) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (ok) => {
      s.removeAllListeners();
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeout);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

async function alreadyListening(port, ms = AUTOSTART_GRACE_MS) {
  const deadline = Date.now() + ms;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    if (await portOpen(port)) return true;
    if (Date.now() >= deadline) return false;
    // eslint-disable-next-line no-await-in-loop
    await sleep(POLL_MS);
  }
}

/** 配置 = index.config.js 的 default（缺失/读坏都不拦：包自己会用默认值初始化） */
function loadConfig() {
  const p = path.join(DIR, 'index.config.js');
  if (!fs.existsSync(p)) {
    console.log('[host] 没有 index.config.js，start() 传空配置');
    return {};
  }
  try {
    const m = require(p);
    const cfg = (m && m.default) || m || {};
    console.log(`[host] 读到 index.config.js（${Object.keys(cfg).length} 项）`);
    return cfg;
  } catch (e) {
    console.error(`[host] index.config.js 读取失败，按空配置继续：${e && e.message}`);
    return {};
  }
}

function shutdown(sig) {
  console.log(`[host] 收到 ${sig}，调用 stop()…`);
  Promise.resolve()
    .then(() => (mod && typeof mod.stop === 'function' ? mod.stop() : undefined))
    .then(() => {
      console.log('[host] stop() 完成');
      process.exit(0);
    })
    .catch((e) => {
      console.error(`[host] stop() 出错：${(e && (e.message || e)) || e}`);
      process.exit(0);
    });
  /* 包里的 stop() 可能挂住（它们自己也不一定写对）—— 面板那边还有 SIGKILL 兜底，这里给个上限 */
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

(async () => {
  const config = loadConfig();
  try {
    mod = require(path.join(DIR, 'index.js'));
  } catch (e) {
    console.error(`[host] require index.js 失败：${(e && (e.stack || e.message)) || e}`);
    process.exit(1);
  }

  const keys = Object.keys(mod || {});
  console.log(`[host] 源码包导出：${keys.length ? keys.join(',') : '（无）'}`);

  if (typeof mod.start !== 'function') {
    console.log('[host] 没有 start() —— 按「自启动型」对待，等它自己监听端口');
    return;
  }
  if (PORT && (await alreadyListening(PORT))) {
    console.log(`[host] :${PORT} 已经在监听（自启动型源码包），不再调 start()`);
    return;
  }

  console.log(`[host] 调用 start(config)…（DEV_HTTP_PORT=${process.env.DEV_HTTP_PORT || '-'}）`);
  await mod.start(config);
  console.log('[host] start(config) 已返回');
})().catch((e) => {
  console.error(`[host] 启动失败：${(e && (e.stack || e.message)) || e}`);
  process.exit(1);
});
