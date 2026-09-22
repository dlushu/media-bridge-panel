'use strict';
/**
 * emby 层的**请求日志**（原先的 `monitor.js` 已删）
 *
 * 记录口径：**每个请求都记一行，不做筛选** —— 正常与失败都记，不判断"哪条值得看"。
 *   · 2xx → 一行成功记录（含条目列表 / 详情 / 图片 / 拉流 302·代理 / 握手 / 登录…）；
 *   · ≥400 → 一行失败记录（401 没带 token / 404 认不出的 Id / 502 上游挂了 / 504 超时）；
 *   · 未实现端点（501 通配）→ 一行失败记录。
 *
 * 每一条都带**客户端标记**与 **query 摘要** —— 没有这两样等于没记：
 * "哪个客户端要了什么、拿到了什么"全靠它们（排查 SenPlayer 问题时，正是因为分不清请求来源才补上的）。
 *
 * ⚠️ **量靠别处压，不靠这里筛**：
 *   · 面板「面板设置 → 日志」是**固定 500 条的环形缓冲**（`core/logbus.js`）—— 再多也只会覆盖最老的，
 *     内存有硬上限；想留更多就把 `panel.logMax` 调大；
 *   · 页面上的「全部 / 警告以上 / 仅错误」过滤是**看的时候再筛**，不影响记录。
 *   所以这里**不判断哪条重要**。
 *
 * 两条查看路径（见 docs/emby-compat.md「二」）：
 *   · 面板「面板设置 → 日志」—— 内存里最近 N 条；
 *   · `docker logs` —— 长期留档，docker 的 json-file 自带轮转（10MB × 3）。
 */

/** query 摘要总长上限 / 单个值上限 */
const QUERY_MAX = 300;
const QUERY_VALUE_MAX = 60;
/** 501 那行里 query 的长度上限（它要保留"客户端到底要什么"，所以给得比摘要宽） */
const MISSING_QS_MAX = 400;
/** 超长且几乎不含诊断信息的参数：只留名字 */
const QUERY_NOISE = /^(fields|enableimagetypes|enabletotalrecordcount|enableimages|imagehelimit)$/i;
/** 敏感参数：值掩码。⚠️ **按子串匹配**（不带 `^…$`）—— 客户端塞在 query 里的凭据名字五花八门：
 * `X-Emby-Token` / `api_key` / `access_token` / `authorization`…，精确匹配会漏掉它们。
 * （已实测：精确匹配会漏掉 `?X-Emby-Token=…` 这类写法，旧的 `monitor.js` 同样漏。） */
const SENSITIVE_KEY = /(pw|pwd|password|pass|token|secret|api[-_]?key|authorization|credential)/i;

/** 501 的累计序号（给响应体里的 `logSeq`，便于"这一条请求对应日志里哪一行"） */
let seq = 0;

/**
 * 「这条请求是谁发的」—— 取值优先 `x-emby-authorization` 的 `Client=`（那才是 Emby 客户端的自称），
 * 退而用 `user-agent`（**图片请求常常什么凭证都不带**，只有 UA 可认）。
 */
function clientTag(req) {
  const h = (req && req.headers) || {};
  const auth = String(h['x-emby-authorization'] || '');
  const client = (auth.match(/Client="([^"]*)"/i) || [])[1] || '';
  const version = (auth.match(/Version="([^"]*)"/i) || [])[1] || '';
  if (client) return ` [${client}${version ? '/' + version : ''}]`;
  const ua = String(h['user-agent'] || '').trim();
  return ` [${ua ? ua.slice(0, 32) : '无标识'}]`;
}

/**
 * query 摘要（失败行用）。
 *
 * 为什么失败行需要它：只看「HTTP 502」不知道**是哪个请求**挂的 —— `ParentId` 是谁、第几页、
 * 哪个 `MediaSourceId`，全在 query 里。规则：敏感参数掩码；`Fields`/`EnableImageTypes` 这类
 * 超长又没诊断价值的压成 `…`；单值截断 60、总长封顶 300；**顺序保持客户端原样**。
 * 返回值**带前导空格**（拼进结果行读作 `… → HTTP 502 ?ParentId=…`）。
 */
function queryBrief(query) {
  if (!query || typeof query.entries !== 'function') return '';
  const parts = [];
  for (const [k, v] of query.entries()) {
    if (SENSITIVE_KEY.test(k)) {
      parts.push(`${k}=***`);
      continue;
    }
    if (QUERY_NOISE.test(k)) {
      parts.push(`${k}=…`);
      continue;
    }
    const s = String(v);
    parts.push(`${k}=${s.length > QUERY_VALUE_MAX ? s.slice(0, QUERY_VALUE_MAX) + '…' : s}`);
  }
  if (!parts.length) return '';
  const out = '?' + parts.join('&');
  return ' ' + (out.length > QUERY_MAX ? out.slice(0, QUERY_MAX) + '…' : out);
}

/**
 * **每个请求**打一行结果日志（2xx 记为成功、≥400 记为失败）—— 不做筛选，见文件头。
 *
 * @param {object} req           原始请求（取客户端标记）
 * @param {string} label         形如 `条目列表 Users/…/Items`（打在 `emby` 后面）
 * @param {{status:number, log?:string}} out   service 的返回
 * @param {string} [extra]       附在状态码后面的补充（通常是 `q + ' items=3'`）
 * @returns {boolean}            是不是成功（调用方一般不用管）
 */
function logResult(req, label, out, extra) {
  const status = Number(out && out.status) || 0;
  const ok = status > 0 && status < 400;
  console.log(`  ${ok ? '✔' : '✘'} emby ${label} → HTTP ${status}${extra || ''}  ${(out && out.log) || ''}${clientTag(req)}`);
  return ok;
}

/**
 * 「这个端点回了多少条」——**只给日志用**。
 * 成功时数 `body[key]`（如 `Items` / `MediaSources`）；失败或不是数组时给 `-`
 * （**不假装是 0** —— 失败行上写 `items=0` 会让人以为"查到了但是空的"）。
 */
function countOf(out, key) {
  const v = out && out.body && key ? out.body[key] : out && out.body;
  const ok = out && Number(out.status) < 400;
  return `${key || 'items'}=${ok && Array.isArray(v) ? v.length : '-'}`;
}

/** 请求体摘要的长度上限（未实现端点的日志用） */
const BODY_BRIEF_MAX = 300;

/**
 * 请求体摘要（**只给未实现端点的日志用**）。
 *
 * 为什么需要它：通配路由会把 POST 的 body 读下来，但原先**读完即丢**——
 * 于是「客户端到底报了什么」完全看不见（播放进度那三条 `POST /Sessions/Playing*` 就是这样，
 * 只有一个路径名，连条目 Id 和位置都无从得知）。
 *
 * 三条约束：
 *   · **掩码**：沿用 query 那套 `SENSITIVE_KEY`，键名像 `api_key`/`token`/`password` 的值一律 `***`；
 *   · **压平**：嵌套对象与数组只报形状（`{…}` / `[N 项]`），否则一条日志能到几 KB（`NowPlayingQueue` 这种）；
 *   · **截断**：整体封顶 `BODY_BRIEF_MAX`。不是 JSON 的（半截、二进制）走原文掩码那条路。
 *
 * 返回**不带前缀**（调用方自己拼 `body=`）；空 body 返回 `''`。
 */
function bodyBrief(body) {
  if (body === null || body === undefined || body === '') return '';
  let text = Buffer.isBuffer(body) ? body.toString('utf8') : typeof body === 'string' ? body : JSON.stringify(body);
  text = String(text || '').trim();
  if (!text) return '';

  let out = text;
  try {
    const o = JSON.parse(text);
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      const flat = {};
      for (const [k, v] of Object.entries(o)) {
        if (SENSITIVE_KEY.test(k)) flat[k] = '***';
        else if (Array.isArray(v)) flat[k] = `[${v.length} 项]`;
        else if (v && typeof v === 'object') flat[k] = '{…}';
        else flat[k] = v;
      }
      out = JSON.stringify(flat);
    }
  } catch {
    /* 不是 JSON：按原文，用"键名: 值"的粗略掩码兜一层 */
    out = text.replace(
      /("?[A-Za-z0-9_-]*(?:pw|pwd|pass|token|secret|api[-_]?key|authorization|credential)[A-Za-z0-9_-]*"?\s*[:=]\s*)"?[^",&\s}]+/gi,
      '$1***'
    );
  }
  return out.length > BODY_BRIEF_MAX ? out.slice(0, BODY_BRIEF_MAX) + '…' : out;
}

/**
 * 未实现端点：**一行**（原来在 `monitor.js` 里要印发 path + ua/ip + headers + body，现在只留一行 ——
 * 那几行既是噪音也是内存占用的大头）。
 *
 * query **保留**（截断到 400 字符）：这是判断"客户端到底要什么"的唯一线索，
 * 删了就只剩一个路径名（`Fields=` 里往往写着它想要哪些字段）。返回序号（响应体里的 `logSeq`）。
 *
 * **body 也保留一份摘要**（掩码 + 压平 + 限长，见 `bodyBrief`）：POST 端点没有 query，
 * 不看 body 就完全不知道客户端报了什么（播放进度的 `ItemId` / `PositionTicks` 全在 body 里）。
 *
 * ⚠️ **敏感参数必须掩码**：客户端把 token 塞在 query 里是常态（`?api_key=` / `?X-Emby-Token=`），
 * 原样打出来就是把凭据写进日志 —— 已实测该路径会漏出 `X-Emby-Token`（旧 `monitor.js` 同样漏）。
 */
function logMissing(req, { pathname, query, body }) {
  seq += 1;
  const shown = maskQuery(query && typeof query.toString === 'function' ? query.toString() : '');
  const b = bodyBrief(body);
  console.log(`  ✘ emby 未实现#${seq} ${req.method} ${pathname}${shown ? '?' + shown : ''}${b ? ' body=' + b : ''}${clientTag(req)}`);
  return seq;
}

/** query 原文 → 敏感参数值掩码后的文字（`?api_key=***&X-Emby-Token=***`）；顺带截断 */
function maskQuery(qs) {
  if (!qs) return '';
  const masked = String(qs)
    .split('&')
    .map((kv) => {
      const i = kv.indexOf('=');
      if (i < 0) return kv;
      return SENSITIVE_KEY.test(kv.slice(0, i)) ? kv.slice(0, i) + '=***' : kv;
    })
    .join('&');
  return masked.length > MISSING_QS_MAX ? masked.slice(0, MISSING_QS_MAX) + '…' : masked;
}

module.exports = { clientTag, queryBrief, logResult, countOf, logMissing, bodyBrief };
