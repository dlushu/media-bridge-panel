'use strict';
/**
 * 配置中心同源代理 —— `/website*` 与**兜底转发**都归这里。
 *
 * ## 为什么需要它
 * 每个源的配置中心本来就是**独立的一个页面**（源自己监听 127.0.0.1:9988/9989…），
 * 它的前端写的是**根路径**：约定前缀是 `/website/api/…`，但也有不守规矩的 ——
 * 实测 MiraPlay（Lmentor）全篇都带 `baseURL:"/website"`，**只有一处用裸 axios 打了 `/full-config`**，
 * 而 `/config`、`/check`、`/spider/**` 又是另一批根路径。面板是把它**同源代理**到面板域名下
 * 用 iframe 显示的（`/website?source=<本地源id>`），所以这些请求落在**面板**上：
 * 面板路由表里没有的那条就是 404。
 *
 * 以前的做法是"缺哪条补哪条"，追不上，而且**认不出来**：同一个 `/full-config` 404，
 * 在 L 的「站源」页表现成**整片空白**（那段加载外面没包 try/catch，第一句抛了表格就不填），
 * 在 L 的「弹幕」页表现成弹一句「加载爬虫列表失败」—— 肉眼根本看不出是同一个问题
 * （定位时正是绕了这么一圈）。所以现在分两条路：
 *
 *   ① `/website*`  —— 源的约定前缀，绝大多数请求走这条（`routes.js` 登记）；
 *   ② **兜底**     —— 面板自己的路由与 `public/` 静态**都没有**这个路径时，交给
 *                     "当前配置中心的那个源"，而不是直接 404（`server.js` 在静态之后调
 *                     `fallback()`）。以后源里再冒出新根路径，不用再动这里一行代码。
 *
 * ## 「当前是哪个源」为什么记在 cookie 里
 * 首帧的 iframe 地址带着 `?source=<本地源id>`，但**之后**源的前端发的根路径请求里
 * **不带任何源的信息**（那是它的产物里写死的），所以面板必须自己记住"这个浏览器在看哪个源"。
 * 原来是记在一个模块级变量里 —— 手机和电脑各开一个源的配置中心会**互相顶掉**（后开的赢），
 * 现已改成 cookie（`cp_wsrc`）：天然按客户端分开，谁也不用抢谁的。
 * 代价（如实说）：**同一个浏览器**同时开两个源的配置中心仍然只能认一个（cookie 是按浏览器存的）
 * —— 真要"同开多个"，得走子域名按 Host 分那套，不在这一版里。
 */
const store = require('./store');
const runner = require('./runner');
const service = require('./service');
const auth = require('../../core/auth');
const { sendError } = require('../../core/http');
const { forward } = require('../../core/upstream');

/** 「当前配置中心是哪个源」的 cookie 名 */
const WS_COOKIE = 'cp_wsrc';

/**
 * 这些扩展名**不兜底**：源的前端资源本来就都在 `/website/` 下（已被 ① 代理），
 * 兜它们只会把面板自己的静态 404（浏览器自动要的 `favicon.ico` 那类）变成一堆对源的请求，
 * 把日志和排查都搅浑。⚠️ `json` **不在**名单里 —— 那是数据，源真可能挂在根路径上。
 */
const ASSET_EXT = /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|html?)$/i;

/** id → 运行中的源（没在跑 / 认不出这个 id → null，**不猜**） */
function runById(id) {
  const want = String(id || '').trim();
  if (!want) return null;
  const st = runner.publicState(want);
  if (!(st.status === 'running' && st.port)) return null;
  const src = store.get(want);
  return {
    url: `http://127.0.0.1:${st.port}`,
    sourceId: want,
    name: (src && src.name) || want,
    origin: 'local',
  };
}

/** 记住"这个客户端在看哪个源"（value 为空 = 立刻过期，等同删掉） */
function remember(res, id) {
  const head =
    `${WS_COOKIE}=${id ? encodeURIComponent(id) : ''}; Path=/; HttpOnly; SameSite=Lax` +
    (id ? '' : '; Max-Age=0');
  const prev = res.getHeader('Set-Cookie');
  /* 同一个响应上可能已经有别的 cookie（登录那套）—— 拼成数组，别互相覆盖 */
  res.setHeader('Set-Cookie', prev ? [].concat(prev, head) : head);
}

function rememberedId(req) {
  return auth.parseCookies(req)[WS_COOKIE] || '';
}

/**
 * 配置中心（①② 共用）该打哪个源：`?source=` 优先（并顺手记住）→ 记住的那个 → 运行中的第一个源。
 * 最后那步退回是为了兼容"没带 source 直接开 `/website`"的老情形。
 */
function currentRun(req, query, res) {
  const want = String((query && query.get('source')) || '').trim();
  if (want) remember(res, want);
  const hit = runById(want || rememberedId(req));
  if (hit) return hit;
  return service.resolveRun();
}

/**
 * 配置中心这一头**回人话文本**而不是 JSON：它多半是在 iframe / 子请求里直接被浏览器
 * 或源自己的前端显示的，`{"error":…}` 那种给面板接口用（老的 `/website` 代理也是纯文本）。
 */
function textError(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(msg);
}

/** 把请求原样转给某个源；出错回 502 */
async function passthrough(req, res, run, target) {
  try {
    await forward(req, res, run.url, target, { timeout: 60000, raw: true });
    return true;
  } catch (e) {
    textError(res, 502, '配置中心代理失败：' + String((e && e.message) || e));
    return false;
  }
}

/**
 * ① `/website*`：配置中心同源代理（`source` 只是给面板自己看的路标，别带给源 —— 源不认这个参数）。
 */
async function handleWebsite(req, res, { pathname, query }) {
  const run = currentRun(req, query, res);
  if (!run.url) {
    return textError(res, 400, '还没有运行中的源（或未设置托管源），请先在「源托管」里添加并运行猫源。');
  }
  const q = new URLSearchParams(query ? query.toString() : '');
  q.delete('source');
  const qs = q.toString() ? '?' + q.toString() : '';
  return passthrough(req, res, run, pathname + qs);
}

/**
 * ② 兜底：面板自己的路由、`public/` 静态都没接住这个路径时调（`server.js`）。
 *
 * 返回 **true = 已经处理**（转发了 / 已回错），false = 别管它，让调用方照旧 404。
 * 只有这三种情况会返回 false：静态扩展名、**没人用配置中心**（记着的源不在跑）、
 * 或者源自己不认这条路径 —— 也就是说**面板在没人看配置中心时，行为跟以前一模一样**。
 */
async function fallback(req, res, { pathname, query }) {
  if (ASSET_EXT.test(pathname)) return false;
  const run = runById(rememberedId(req));
  if (!run) return false;

  /* 门禁：这条路径不在 `auth.needsAuth` 的名单里（那些名字面板并不认识，只能按"有 cookie 在用
   * 配置中心"来判断），但**转发的可是源的接口** —— 不登录就转，等于把源无鉴权端出去。所以显式再拦一道。 */
  const deny = auth.guard(req, pathname, { force: true });
  if (deny) {
    sendError(res, 401, deny);
    return true;
  }

  console.log(`  ↪ 配置中心兜底 ${req.method} ${pathname} → 源 ${run.name}`);
  const qs = query && query.toString() ? '?' + query.toString() : '';
  await passthrough(req, res, run, pathname + qs);
  return true;
}

module.exports = { WS_COOKIE, handleWebsite, fallback };
