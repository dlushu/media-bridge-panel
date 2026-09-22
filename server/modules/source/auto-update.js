'use strict';
/**
 * 猫源「自动更新」
 *
 * 目标：部署的猫源支持自动更新 —— 可勾选开关、可设置间隔，默认 12 小时。
 * 做的事：每隔 N 小时（默认 12）给**每个本地托管源**探一次远端 `index.js.md5`；
 * 变了就下载 + 校验 —— 走的就是手动点「更新」那条路（`fetcher.download`），
 * 校验通过且该源**正在运行**时重启它（与手动更新一致，见 routes.js 的 update 路由）。
 *
 * 几条既定口径（页面上/日志里都说得出来）：
 *   · **默认关**（`autoUpdate: false`）：自动重启会打断正在播放的请求，让人自己勾；
 *   · 间隔默认 **12 小时**，取值 1~168（一周），存 `data/settings/source.json`；
 *   · **开机后第一次**在 `BOOT_DELAY_MS`（2 分钟）后才跑 —— 等面板自己先稳下来；
 *   · **单飞**：上一次没跑完不重入（手动点「立即检查」撞上定时那次会回 409）；
 *   · 某个源失败**只记日志**，不中断、不改设置，下一轮再试（源站抖动是常态）；
 *   · 校验不通过时 `fetcher.download` 已经把残留删掉了（该源变成"未下载"），
 *     这里**照原样记下来**、不去"帮"它恢复 —— 手动更新时也是这个行为。
 *
 * ⚠️ 想省一次 6MB 下载靠的是 `fetcher.download` 自己：它先探 md5，一样就直接返回 `changed:false`，
 * 所以"每 12 小时探一次"的实际开销是每个源两个小请求。
 */
const settings = require('../../core/settings');
const store = require('./store');
const fetcher = require('./fetcher');
const runner = require('./runner');

const DEFAULTS = { enabled: false, hours: 12 };
const BOOT_DELAY_MS = 2 * 60 * 1000;

let timer = null;
let running = false;
let booted = false;

const st = {
  lastRunAt: 0,
  lastReason: '',
  results: [],
  nextRunAt: 0,
};

/** 当前配置（带兜底：设置文件里没有/写坏了也不会把定时器搞成 NaN） */
function cfg() {
  const s = settings.read('source') || {};
  const hours = Math.min(168, Math.max(1, Number(s.autoUpdateHours) || DEFAULTS.hours));
  return { enabled: s.autoUpdate === true, hours };
}

function clearTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
  st.nextRunAt = 0;
}

/** 排下一次（先清旧的：改设置/手动跑之后都从现在重新计时） */
function schedule(delayMs) {
  clearTimer();
  if (!cfg().enabled) return;
  st.nextRunAt = Date.now() + delayMs;
  timer = setTimeout(() => {
    timer = null;
    runNow({ reason: 'timer' }).catch((e) => console.log('  ✘ 猫源自动更新失败（已拦截）：' + ((e && e.message) || e)));
  }, delayMs);
  /* 别让一个定时器把进程吊着不退出（面板本来常驻，这只是"退出时别等它"） */
  if (timer.unref) timer.unref();
}

/** 给前端看的快照 */
function state() {
  const { enabled, hours } = cfg();
  return {
    enabled,
    hours,
    bootDelayMs: BOOT_DELAY_MS,
    running,
    lastRunAt: st.lastRunAt || null,
    lastReason: st.lastReason || '',
    nextRunAt: st.nextRunAt || null,
    results: st.results,
  };
}

/**
 * 跑一轮检查。
 * @param {{reason?: 'timer'|'manual'|'boot'}} opts
 * @returns {{ok:boolean, busy?:boolean, error?:string, results?:Array}}
 */
async function runNow({ reason = 'manual' } = {}) {
  if (running) return { ok: false, busy: true, error: '上一次检查还没跑完' };
  const { enabled, hours } = cfg();
  if (!enabled && reason !== 'manual') return { ok: true, results: [] };

  running = true;
  st.lastReason = reason;
  const results = [];
  try {
    const srcs = store.list();
    for (const raw of srcs) {
      const src = Object.assign({}, raw, { dir: store.sourceDir(raw.id), runtimeDir: store.runtimeDir(raw.id) });
      const one = { id: raw.id, name: raw.name || raw.url, ok: true, changed: false, restarted: false, error: null };
      try {
        // eslint-disable-next-line no-await-in-loop
        const dl = await fetcher.download(src.url, src.dir);
        if (!dl.ok) {
          one.ok = false;
          one.error = dl.error || '下载/校验失败';
        } else if (dl.changed) {
          one.changed = true;
          store.update(raw.id, {});
          if (runner.publicState(raw.id).status === 'running') {
            // eslint-disable-next-line no-await-in-loop
            await runner.restart(src, src);
            one.restarted = true;
          }
        }
      } catch (e) {
        one.ok = false;
        one.error = (e && e.message) || String(e);
      }
      results.push(one);
    }
  } finally {
    running = false;
  }

  st.lastRunAt = Date.now();
  st.results = results;

  const changed = results.filter((r) => r.changed);
  const bad = results.filter((r) => !r.ok);
  if (results.length || reason === 'manual') {
    console.log(
      `  ${changed.length ? '↻' : '·'} 猫源自动更新：检查 ${results.length} 个源 → ` +
        (changed.length
          ? `${changed.length} 个有新版（${changed.map((r) => r.name + (r.restarted ? ' 已重启' : '')).join('、')}）`
          : '都是最新') +
        (bad.length ? `；${bad.length} 个失败：${bad.map((r) => r.name + ' ' + r.error).join('；')}` : '')
    );
  }

  /* 跑完才排下一次（单飞 + 间隔以"跑完"为起点，不会因为一次慢检查堆起来） */
  schedule(hours * 3600 * 1000);
  return { ok: true, results };
}

/** 设置变了就按新配置重排（「保存」→ core 调 onSettingsChange） */
function apply() {
  const { enabled, hours } = cfg();
  if (!enabled) {
    clearTimer();
    if (booted) console.log('  · 猫源自动更新：已关闭（下次不再检查）');
    return;
  }
  schedule(hours * 3600 * 1000);
  if (booted) console.log(`  ↻ 猫源自动更新：已开启，每 ${hours} 小时检查一次（从现在重新计时）`);
}

/** 开机调用一次：默认关就什么都不做、也不刷日志 */
function start() {
  booted = true;
  const { enabled, hours } = cfg();
  if (!enabled) return;
  console.log(
    `  ↻ 猫源自动更新：每 ${hours} 小时检查一次（${Math.round(BOOT_DELAY_MS / 60000)} 分钟后先跑一次）`
  );
  schedule(BOOT_DELAY_MS);
}

module.exports = { DEFAULTS, BOOT_DELAY_MS, cfg, state, runNow, apply, start };
