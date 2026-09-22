'use strict';
/**
 * HTTP 基础设施：JSON 响应、请求体读取、静态文件服务
 * 只依赖 Node 内置模块；不含任何业务逻辑。
 */
const fs = require('fs');
const path = require('path');
const { PUBLIC_DIR } = require('./paths');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function sendError(res, code, message) {
  if (res.headersSent) return res.end();
  return sendJson(res, code, { error: message });
}

/** 原样回写上游响应（二进制安全） */
function sendBuffer(res, code, buf, contentType) {
  res.writeHead(code, {
    'Content-Type': contentType || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

/** 读原始请求体（二进制安全） */
function readRawBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 读请求体并解析 JSON（空 body → {}） */
async function readBody(req, limit = 8 * 1024 * 1024) {
  const raw = (await readRawBody(req, limit)).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const e = new Error('请求体不是合法 JSON');
    e.code = 400;
    throw e;
  }
}

/**
 * 静态文件：public/ 下的全部文件（含子目录 core/ modules/ docs/ styles/）
 *
 * 返回 **true = 已经处理完**（200/304 都算）；**false = public/ 里没有这个文件、而且一个字节都没写**。
 * 为什么不在这里直接回 404：面板前面还有一层"配置中心兜底"—— 源的配置中心前端
 * 写死了根路径（`/full-config` 那类），那些请求会落到**面板任意根路径**上，得让调用方
 * （`server.js`）先问一次猫源层，接不住才 404。见 `modules/source/config-proxy.js` 顶部。
 */
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const full = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  let stat = null;
  try {
    stat = fs.statSync(full);
  } catch {
    stat = null;
  }
  if (!full.startsWith(PUBLIC_DIR) || !stat || stat.isDirectory()) return false;

  /* 缓存策略：**`no-cache`（要回来校验，不是"不缓存"）+ `ETag`**。
   * 为什么不能什么都不写：那样浏览器会**启发式缓存** —— 改了 CSS/JS 刷新还是旧的
   * （曾两次遇到：日志页的提示语、样式表的选择器，缓存住后都得重启浏览器才生效）。
   * 为什么也不写 `max-age`：面板是"改完刷新即见"的自用场景，缓存住就等于改了看不见。
   * `no-cache` + `ETag` 两头都要：**没变就 304（省流量），变了立刻生效**。 */
  const etag = `"${stat.size}-${Math.round(stat.mtimeMs)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
    res.end();
    return true;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    ETag: etag,
    'Last-Modified': new Date(stat.mtimeMs).toUTCString(),
  });
  fs.createReadStream(full).pipe(res);
  return true;
}

/** 谁都没接住时的 404（`serveStatic` 不再自己回 404，改由 server.js 在兜底之后调这里） */
function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  return res.end('Not Found');
}

module.exports = { MIME, sendJson, sendError, sendBuffer, readRawBody, readBody, serveStatic, notFound };
