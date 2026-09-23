'use strict';
/**
 * 聚合层服务：一个请求并发打**多个源**的多个站源 /search，按站点顺序拼接
 *
 * 协议细节（$$$ / # / $ / push://）留在本层，消费方拿到的是「(源, 站点) → 原样输出」。
 *
 * **多源**：站点身份是 `(source, key)` 这一对 ——
 *   站点 key 只在**各自源内**唯一，两个源都有 `nodejs_muou` 是常事，所以任何
 *   "按 key 对齐/去重/排序"的地方都必须带上 source（否则会静默互相覆盖）。
 *   对外形状里 source 与 key 是**两个字段**；只有内部做 Map 键时才拼成一个复合键。
 */
const settings = require('../../core/settings');
const { request } = require('../../core/upstream');
const { normName } = require('../../core/catpaw');
const match = require('./match'); // 片名清洗 + 打分（"这是不是目标作品"的唯一判据）

/** 内部复合键：`源 + \\u0001 + 站点key`（用控制字符分隔，配置里不可能出现，零歧义） */
const sid = (source, key) => String(source || '') + '\u0001' + String(key || '');

/** 源清单 → id 查表；找不到就抛（说明站点清单与源清单不一致） */
function sourceMap(sources) {
  const m = new Map();
  for (const s of sources || []) m.set(s.id, s);
  return m;
}

function needSource(byId, id) {
  const s = byId.get(id);
  if (!s) throw new Error(`源清单里没有 ${id}（可能已被删除，刷新一下站点清单）`);
  return s;
}

/** 打分参数：调用方给的优先，没给就读 `agg.json`（web 上那三个输入框的默认值就是它） */
function matchDefaults(opts) {
  const cfg = settings.read('agg') || {};
  const o = opts || {};
  const num = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));
  return {
    minScore: num(o.minScore, num(cfg.matchMinScore, 0.85)),
    maxItems: num(o.maxItems, num(cfg.matchMaxItems, 3)),
    unmatchedMax: num(o.unmatchedMax, 20),
    extraK: num(o.extraK, num(cfg.matchExtraK, 3)),
  };
}

const round3 = (n) => Math.round(Number(n || 0) * 1000) / 1000;

/** 「首次搜索先 POST /init」的缓存：按「源地址 + 站点 key」 */
const initialized = new Set();

async function ensureInit(source, site, timeoutMs) {
  if (!settings.read('agg').initFirst) return false;
  const k = source.url + '|' + site.key;
  if (initialized.has(k)) return false;
  initialized.add(k);
  try {
    await request(source.url, site.api + '/init', { method: 'POST', body: {}, timeout: Math.min(timeoutMs, 8000) });
    return true;
  } catch {
    initialized.delete(k); // 失败下次重试
    return false;
  }
}

async function searchSite(source, site, wd, page, timeoutMs) {
  const t0 = Date.now();
  const r = {
    source: source.id, // 多源：结果里必须带上是哪个源
    key: site.key,
    name: site.name,
    api: site.api,
    group: site.group,
    page: null,
    total: null,
    ok: false,
    ms: 0,
    count: 0,
    list: [],
    error: null,
    noResultBy: null, // 有值 = "无结果"是由站源的哪种表达推出来的（如 http-404），见 searchSite
    response: null, // 站源 /search 的原样响应体
    responseStatus: null,
    request: { method: 'POST', url: source.url + site.api + '/search', body: { wd, page: String(page) } },
    initRequest: { method: 'POST', url: source.url + site.api + '/init', body: {} },
    initCalled: false,
  };
  try {
    r.initCalled = await ensureInit(source, site, timeoutMs);
    const res = await request(source.url, site.api + '/search', { method: 'POST', body: { wd, page }, timeout: timeoutMs });
    r.responseStatus = res.status;

    /* 站源表达「没搜到」的方式**不止一种**，这里把两种都归成**无结果**（`ok: true` + 空列表）：
     *   ① 规范的：HTTP 200 + `list` 为空；
     *   ② **HTTP 404** —— 一部分站就是这么表达的（实测：同一部片，`nodejs_wogg`
     *      回 200 空、`nodejs_muou` / `nodejs_huban` 回 404；而拿站里**确实有**的片名去搜它们
     *      又是 200，说明站没坏，404 就是它的"没有"）。
     * 不归的话，404 会被当成"站点故障"一路记进 `sites.*.error` 与面板日志（`搜了 3 站…：HTTP 404`），
     * 把"源里没这部片"误报成"出错"。
     * **但仍然留痕**：`responseStatus` 与 `noResultBy` 都记着，想区分"真的站点故障"还有据可查
     * （站点若真下线，多站会一起哑，而不会只有"没搜到"这一个码）。 */
    if (res.status === 404) {
      r.ok = true;
      r.noResultBy = 'http-404';
      r.response = res.json && typeof res.json === 'object' ? res.json : null;
    } else {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = res.json;
      if (!j || typeof j !== 'object') throw new Error('返回不是 JSON');
      r.response = j;
      r.list = j.list || [];
      r.count = r.list.length;
      r.page = j.page;
      r.total = j.total;
      r.ok = true;
    }
  } catch (e) {
    r.error = e && e.name === 'AbortError' ? `超时(${timeoutMs}ms)` : String((e && e.message) || e);
  }
  r.ms = Date.now() - t0;
  return r;
}

/**
 * 并发池：一次请求打多个源的多个站源，单站/单源失败不影响整体。
 * `sites` 里每一项都必须带 `source`（源 id）—— 由调用方（routes / agg.sites）打好。
 * 返回的 `sites` 是**数组**（每项带 source），不再是「key → entry」的映射：
 * 多源下同名 key 会撞，映射形状没法表达"两条不同的站点"。
 */
/**
 * 并发搜多个站的 `/search`，**并顺手打分**（打分是这一步的职责）。
 *
 * `want`：`{ name, year, season, episode }` —— 打分要的"目标片"。`name` 缺省用 `wd`。
 * `matchOptions`：`{ minScore, maxItems, unmatchedMax }` —— 缺省读 `agg.json` 的设置
 *   （`matchMinScore` / `matchMaxItems`）。`minScore = 0` 就是**不做分数线筛选**、只按分数排名取前 N。
 *
 * 打分口径与两道闸门见 `match.js` 顶部。结果里：
 *   · 每个条目多出 `score` / `matched` / `matchReason`（web 要显示"为什么它进了/没进"）；
 *   · 顶层多出 `matched` / `unmatched`（失败也回，带原因）+ `stats.match`（各桶计数）。
 */
async function aggregateSearch(sources, sites, { wd, page = '1', timeoutMs, concurrency, want, matchOptions } = {}) {
  if (!wd || !String(wd).trim()) throw new Error('请提供搜索关键字 wd');
  const cfg = settings.read('agg');
  const t = Math.max(1000, Number(timeoutMs) || cfg.timeoutMs || 5000);
  const c = Math.max(1, Math.min(32, Number(concurrency) || cfg.concurrency || 8));
  const byId = sourceMap(sources);
  const queue = (sites || []).slice();
  const results = [];
  const t0 = Date.now();
  let cursor = 0;

  await Promise.all(
    new Array(Math.min(c, queue.length || 1)).fill(0).map(async () => {
      for (;;) {
        const i = cursor++;
        if (i >= queue.length) return;
        const site = queue[i];
        // eslint-disable-next-line no-await-in-loop
        const r = await searchSite(needSource(byId, site.source), site, String(wd).trim(), String(page), t);
        results.push(r);
      }
    })
  );

  /* 按 `(源, 站点)` 对齐回 queue 顺序 —— **不能只按 key**（跨源同名会取错） */
  const ordered = queue.map((site) => results.find((r) => r.source === site.source && r.key === site.key)).filter(Boolean);

  const outSites = [];
  const nameCount = new Map();
  let totalItems = 0;
  for (const r of ordered) {
    /* `sourceName` 一起给：多源下同名站点是常事（两个源都叫"木偶"），前端分组标题只显示站名时
     * 根本分不清是哪个源的。 */
    const owner = byId.get(r.source);
    const entry = {
      source: r.source,
      sourceName: (owner && owner.name) || '',
      key: r.key,
      name: r.name,
      api: r.api,
      ok: r.ok,
      ms: r.ms,
    };
    if (r.ok) {
      entry.data = r.response != null ? r.response : { page: r.page, total: r.total, list: r.list };
      if (r.noResultBy) entry.noResultBy = r.noResultBy; // "无结果"是哪来的（如 http-404），诊断用
      totalItems += r.count;
      for (const it of r.list || []) {
        const n = normName(it.vod_name);
        nameCount.set(n, (nameCount.get(n) || 0) + 1);
      }
    } else {
      entry.error = r.error;
      if (r.responseStatus && r.responseStatus !== 200) entry.http = r.responseStatus;
    }
    outSites.push(entry);
  }
  let duplicatedItems = 0;
  for (const n of nameCount.values()) if (n > 1) duplicatedItems += n;

  /* ---- 打分：**把各站的条目摊平，一次算完**（跨站排序 / 同站去重 / 卡 N 都得全局看）----
   * 条目上挂 `source` / `siteKey` / `siteName` 是为了让打分器知道"这是哪个站的"
   * （同站同名要去重，跨站不能），返回给前端的失败项也因此能自己说明来处。 */
  const flat = [];
  for (const e of outSites) {
    for (const it of (e.data && e.data.list) || []) {
      it.source = e.source;
      it.siteKey = e.key;
      it.siteName = e.name;
      it.sourceName = e.sourceName || '';
      flat.push(it);
    }
  }
  const picked = match.select(flat, { name: (want && want.name) || wd, ...(want || {}) }, matchDefaults(matchOptions));
  /* 每条都写回分数与去留（`all` 不截断）—— web 上逐条显示"命中/没进 + 为什么"靠的就是这两个字段 */
  for (const a of picked.all) {
    a.item.score = round3(a.score);
    a.item.matched = !!a.hit;
    a.item.matchReason = a.reason;
  }

  return {
    wd: String(wd).trim(),
    page: String(page),
    elapsedMs: Date.now() - t0,
    sites: outSites,
    /* 命中的条目（≤ N，按分数降序）与没进的（带原因，供 web 展示；上限 `unmatchedMax`） */
    matched: picked.matched.map((m) => m.item),
    unmatched: picked.unmatched.map((u) => u.item),
    /* 内部用：过关的全量排名（`aggregateDetail` 的"接续补打"要按它往下走）。
     * ⚠️ 它是**同一批条目对象的引用**，别直接回给前端（响应会大一倍）—— 路由里 `delete out.ranked`。 */
    ranked: (picked.ranked || []).map((x) => x.item),
    match: picked.counts,
    stats: {
      requested: queue.length,
      ok: ordered.filter((r) => r.ok).length,
      failed: ordered.filter((r) => !r.ok).length,
      empty: ordered.filter((r) => r.ok && r.count === 0).length,
      totalItems,
      duplicatedItems,
      timeoutMs: t,
      concurrency: c,
      sources: new Set(queue.map((s) => s.source)).size,
    },
  };
}

/**
 * **一条条目（一个 `vod_id`）取回来的详情能不能用** —— 这是"凑够 N 条"里那"一条"的判据：
 *   · 必须有线路；
 *   · 剧集（`need === true`，即请求带了集号）：**至少要有一条线路定位到了这一集** ——
 *     只有线路、却定位不到这一集的那种，Emby 那边会因为"点了必然 404"把它过滤掉
 *     （`emby/service.js` 的 `if (!targets.length) continue`），等于白打一次 `/detail`
 *     （实测：`斗破苍穹年番` 那条 10 条线路里有 6 条能定位、虎斑那条 0 条）；
 *   · 电影（`need === 'item'`）：**至少要有一条线路带播放项**（同一条理由）。
 *
 * ⚠️ 计数单位是**条目**，不是站点、也不是线路：一个站可以有多条条目（代表 + 变体），
 * 每一条都可能是"能用"的那一条（实测就是靠变体才拿到 E211 的）。
 */
function detailUsable(d, need) {
  const lines = (d && d.lines) || [];
  if (!lines.length) return false;
  if (need === 'item') return lines.some((l) => (l.items || []).length > 0);
  return !need || lines.some((l) => l.target);
}

/* ============================================================
 * 详情 / 播放：把站源协议（$$$ / # / $、url 字符串或数组、parse）
 * 全留在本层，对外只给「线路 → 选集」和「归一化后的播放地址」。
 * ============================================================ */

/** 站点清单里按 `(source, key)` 找站点（play/detail 只要这两个就能反查该站 api 前缀） */
function siteByKey(sites, source, key) {
  const s = String(source || '').trim();
  const k = String(key || '').trim();
  return (sites || []).find((x) => x.source === s && x.key === k) || null;
}

/**
 * 参与聚合的站点：按 keys 白名单过滤，再按 order 排序。
 * **顺序就是 picked 的优先级**（同名时先取排前面的站）—— search / detail 共用这一处。
 * `keys` / `cfg.enabled` / `cfg.order` 里都是 `{source, key}` 对象（多源下不能只比 key）。
 */
function selectSites(sites, cfg = {}, keys) {
  const wanted = Array.isArray(keys) && keys.length ? keys : cfg.enabled || [];
  const order = cfg.order || [];
  const wantedSet = new Set(wanted.map((x) => sid(x && x.source, x && x.key)));
  const orderIdx = new Map(order.map((x, i) => [sid(x && x.source, x && x.key), i]));
  return (sites || [])
    .filter((x) => wantedSet.has(sid(x.source, x.key)))
    .sort((a, b) => {
      const ia = orderIdx.has(sid(a.source, a.key)) ? orderIdx.get(sid(a.source, a.key)) : 9999;
      const ib = orderIdx.has(sid(b.source, b.key)) ? orderIdx.get(sid(b.source, b.key)) : 9999;
      return ia - ib;
    });
}

/** 按要求过滤站点：`keys` 白名单（`{source,key}[]`）/ `source + site` 单点 */
function pickSites(sites, { keys, site, source } = {}) {
  if (site) return (sites || []).filter((s) => s.key === site && (source === undefined || s.source === source));
  if (Array.isArray(keys) && keys.length) {
    const set = new Set(keys.map((x) => sid(x && x.source, x && x.key)));
    return (sites || []).filter((s) => set.has(sid(s.source, s.key)));
  }
  return sites || [];
}

/**
 * 拆 `vod_play_from` / `vod_play_url`：
 *   vod_play_from 用 `$$$` 分线路名；vod_play_url 用 `$$$` 分线路、`#` 分集、`$` 分「集名 / 集ID」。
 * 返回 [{ flag, episodes:[{name,id,index}], episodeCount }]；没有 id 的段不算一集（脏数据过滤）。
 */
function parseLines(vodPlayFrom, vodPlayUrl) {
  const flags = String(vodPlayFrom || '').split('$$$');
  const groups = String(vodPlayUrl || '').split('$$$');
  const out = [];
  flags.forEach((rawFlag, i) => {
    const flag = rawFlag.trim();
    if (!flag) return;
    const episodes = String(groups[i] || '')
      .split('#')
      .map((seg, idx) => {
        const pos = seg.indexOf('$');
        const name = (pos >= 0 ? seg.slice(0, pos) : seg).trim();
        const id = (pos >= 0 ? seg.slice(pos + 1) : '').trim();
        return { name: name || `第${idx + 1}集`, id, index: idx + 1 };
      })
      .filter((e) => e.id);
    out.push({ flag, episodes, episodeCount: episodes.length });
  });
  return out;
}

/**
 * 从集名解析季/集号 —— **只认明确写法**，解析不出就是解析不出（不猜）：
 *   「第2季第3集」「S01E03」→ {season, episode}
 *   「第3集」「03集」「3」    → {season:null, episode}
 */
function parseEpisodeTitle(raw) {
  const s = String(raw || '');
  let m = /第\s*(\d+)\s*季\s*第?\s*(\d+)\s*[集话期章]?/.exec(s) || /S(\d{1,2})\s*E(\d{1,3})/i.exec(s);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  m = /第?\s*(\d+)\s*[集话期章]/.exec(s);
  if (m) return { season: null, episode: Number(m[1]) };
  m = /^\s*(\d+)\s*$/.exec(s);
  if (m) return { season: null, episode: Number(m[1]) };
  /* 前缀式纯集号：`211 4K.mp4` / `180x.mp4` —— 常见于「年番」这类扁平编号条目。
   * 先剥掉 `[1.2GB]` 方括号段与【】段（体积/站点标注不是集号），再取第一个独立数字；
   * 后面必须跟空白/结尾/`x` —— 挡掉 `4K`（4 后面是 K）与 `2160p`（2160 后面是 p）这类规格数字。 */
  const clean = s.replace(/\[[^\]]*\]/g, ' ').replace(/【[^】]*】/g, ' ');
  m = /(?:^|\s)(\d{1,4})(?=\s|$|x)/i.exec(clean);
  if (m) return { season: null, episode: Number(m[1]) };
  return null;
}

/**
 * 在线路里定位「第 season 季第 episode 集」 —— 命中必须能说出**凭什么命中**（matchedBy）：
 *   title    集名里明确写了「第X季第Y集」/「SxEy」且完全匹配（**季优先**）
 *   episode  季没出结果 → 集名里只写了集号（第3集 / 03 / `211 4K.mp4`），**任何季都认**
 *            （原口径只认第 1 季 —— 「年番」类扁平编号在 TMDB 算第 5 季时整条链路定位不到，
 *             见 S5E211 实测）
 *   number   数字兜底：剔掉带 S 的规范段与体积标注后，第一个数字 === episode
 * 都对不上 → null（调用方如实说明，不猜）。
 */
/**
 * 从**集名**里读源自己标注的规格 —— **只认明确写法，读不出就是空**（不猜、不推断）。
 * 例：`[1.8GB]Lanterns.2026.S01E01.2160p.MAX.WEB-DL.H.265.DV.HDR.DDP5.1.Atmos.mkv【L 绿灯军团】`
 *   → { container:'mkv', sizeBytes:1932735283, width:3840, height:2160, videoCodec:'hevc',
 *       videoRange:'DOVI', audioCodec:'eac3', channelLayout:'5.1', channels:6, atmos:true }
 *
 * 用途：消费方要拿它填 Emby 的 MediaSource / MediaStreams（客户端据此决定能不能直连播放）。
 * 注意这是**源标的元信息**，精度有限（尤其体积是近似值），缺失一律给空值而不是补默认值。
 *
 * 覆盖字段（源标题里能读到的都读）：容器 / 体积 / 分辨率 / 视频编码 / 档位 / 位深 /
 * 帧率 / 动态范围 / 音频编码 / 声道布局 / Atmos。**帧率、位深、Profile 这类只在源明确写了才有**
 * （`60fps`、`10bit`、`Main10`）—— 想要"一定有"就得真去探测文件（ffprobe），本项目**不做**探测
 * （源是远程流，为元数据去读它的头部是另一条链路的事，见 docs）。
 */
function parseEpisodeMeta(raw) {
  const s = String(raw || '');
  const out = {
    container: '',
    sizeBytes: 0,
    width: 0,
    height: 0,
    videoCodec: '',
    videoProfile: '',
    bitDepth: 0,
    frameRate: 0,
    videoRange: '',
    audioCodec: '',
    channelLayout: '',
    channels: 0,
    atmos: false,
  };

  const ext = /\.(mkv|mp4|avi|ts|m2ts|flv|mov|webm|rmvb)\b/i.exec(s);
  if (ext) out.container = ext[1].toLowerCase();

  const size = /\[?\s*(\d+(?:\.\d+)?)\s*(GB|G|MB|M)\s*\]?/i.exec(s);
  if (size) {
    const n = Number(size[1]);
    out.sizeBytes = Math.round(n * (/^G/i.test(size[2]) ? 1024 ** 3 : 1024 ** 2));
  }

  const res = /\b(8K|4K|2160p|1080p|720p|480p)\b/i.exec(s);
  const size4k = { '8k': [7680, 4320], '4k': [3840, 2160], '2160p': [3840, 2160], '1080p': [1920, 1080], '720p': [1280, 720], '480p': [854, 480] };
  if (res) {
    const wh = size4k[res[1].toLowerCase()];
    if (wh) {
      out.width = wh[0];
      out.height = wh[1];
    }
  }

  if (/\b(h\.?265|hevc|x265)\b/i.test(s)) out.videoCodec = 'hevc';
  else if (/\b(h\.?264|avc|x264)\b/i.test(s)) out.videoCodec = 'h264';
  else if (/\bav1\b/i.test(s)) out.videoCodec = 'av1';

  /* 编码档位：只认 `Main10` / `Main 10` / `High 10` 这三个明确写法（裸的 `main` 太泛，不认） */
  if (/\bmain\s?10\b/i.test(s)) out.videoProfile = 'Main 10';
  else if (/\bhigh\s?10\b/i.test(s)) out.videoProfile = 'High 10';

  /* 位深：`10bit` / `10-bit` / `8 bit`（写成 `Main10` 不算，那是档位不是位深） */
  const bits = /\b(\d{1,2})\s*-?\s?bit\b/i.exec(s);
  if (bits) out.bitDepth = Number(bits[1]);

  /* 帧率：只认带单位的写法（`60fps` / `23.976fps`）—— 裸的 `23.976` 不认，那串数字太容易误伤 */
  const fps = /\b(\d{2,3}(?:\.\d+)?)\s*fps\b/i.exec(s);
  if (fps) out.frameRate = Number(fps[1]);

  /* 注意 `DDP5.1` 这种写法：`ddp` 后面紧跟数字，用 \b 词边界匹配不到 → 必须用前瞻 */
  if (/\b(eac3|e-ac-3|dd\+|ddp)(?=[.\d\s]|$)/i.test(s)) out.audioCodec = 'eac3';
  else if (/\b(truehd|dts-?hd)\b/i.test(s)) out.audioCodec = 'truehd';
  else if (/\bdts\b/i.test(s)) out.audioCodec = 'dts';
  else if (/\bac3\b/i.test(s)) out.audioCodec = 'ac3';
  else if (/\baac\b/i.test(s)) out.audioCodec = 'aac';
  else if (/\bflac\b/i.test(s)) out.audioCodec = 'flac';

  /* 声道布局（`5.1` / `7.1` / `2.0`）：**只看后面是不是分隔符**，不看前面 ——
   * `DDP5.1` 的 `5.1` 前面紧贴字母，要求"前面也是分隔符"会漏；而 `H.265` 里的 `2.6` 由前瞻挡掉
   * （后面是 `5`，不是分隔符）。5.1 → 6 声道、7.1 → 8、2.0 → 2。 */
  const ch = /([1-8]\.[0-9])(?=[.\s\])\-]|$)/.exec(s);
  if (ch) {
    out.channelLayout = ch[1];
    const parts = ch[1].split('.');
    out.channels = Number(parts[0]) + (parts[1] === '1' ? 1 : 0);
  }
  if (/\batmos\b/i.test(s)) out.atmos = true;

  /* 动态范围（客户端拿它决定能不能直连解码）：Dolby Vision > HDR10+ > HDR10 > HDR > HLG。
   * 分细是为了让消费方填 `ExtendedVideoType`（只有 DolbyVision 一个值时说不出 HDR10/HLG 的区别）。 */
  if (/\b(dv|dovi|dolby\s*vision)\b/i.test(s)) out.videoRange = 'DOVI';
  else if (/\bhdr10\s*\+|\bhdr10plus\b/i.test(s)) out.videoRange = 'HDR10+';
  else if (/\bhdr10\b/i.test(s)) out.videoRange = 'HDR10';
  else if (/\bhdr\b/i.test(s)) out.videoRange = 'HDR';
  else if (/\bhlg\b/i.test(s)) out.videoRange = 'HLG';

  return out;
}

/**
 * 「数字兜底」用的清洗：剔掉**带 S 的规范段**与**体积标注**后，
 * 取剩下部分里的**第一个数字**。
 *   · 带 S 的数字不算集号：\`S05\`、\`S01E210\`、\`第5季\`（「不匹配带 s 的数字」）；
 *   · 体积不算：\`1.2GB\` / \`394.0MB\`（「不匹配后面带 GB 的数字」）。
 * 例：\`玩偶|4K · [1.2GB]208 4K.mp4【D 斗破】\` → \`玩偶|4K · 208 4K.mp4\` → 208
 *     \`玩偶|4K · [1.2GB]S01E210.mkv【豆粕苍穹】\` → \`玩偶|4K · .mkv\` → null（刻意不把 210 当集号）
 * 规格数字与扩展名数字同样排除：\`4K\`、\`1080p\`、\`1080i\`、\`2160p\`，
 * 以及 \`.mp4\` 里的 4、\`x264\` 里的 264 —— 数字两侧紧邻字母的都不算集号，唯一例外是后缀 \`x\`。
 *     例：\`玩偶|4K · [1.2GB]S01E210.mkv\` 清洗后剩 \`玩偶|4K · .mkv\` → 4 后面是 K → 跳过 → null；
 *         \`4K.mp4\` → 4 后是 K、mp4 的 4 前是 p → 全跳过 → null（实测已知的错配）。
 * 小数规格也排除：\`AAC5.1\` / \`DD5.1\` 里的 5、1 都不算集号（实测已知的第二类错配）。
 */
function looseEpisodeNumber(raw) {
  let s = String(raw || '');
  s = s.replace(/\[[^\]]*\]/g, ' ').replace(/【[^】]*】/g, ' ');
  s = s.replace(/S\s*\d{1,2}\s*E\s*\d{1,3}/gi, ' ');
  s = s.replace(/S\s*\d{1,2}(?!\d)/gi, ' ');
  s = s.replace(/第\s*\d+\s*[季部]/g, ' ');
  s = s.replace(/\d+(?:\.\d+)?\s*(?:GB|MB|KB|TB|B)(?![\w])/gi, ' ');
  /* 规格数字与扩展名里的数字都排除：
   * 数字**两侧紧邻字母**的都不算集号 —— 后紧跟的是 \`4K\`/\`1080p\`/\`1080i\`/\`2160p\`，
   * 前紧邻的是扩展名 \`.mp4\` 的那个 4、编码 \`x264\` 的 264。
   * 唯一放行后缀 \`x\`（源自己的 \`180x.mp4\` 写法）。 */
  const re = /\d{1,4}/g;
  let m;
  while ((m = re.exec(s))) {
    const prev = m.index > 0 ? s[m.index - 1] : '';
    const next = s[m.index + m[0].length] || '';
    const badPrev = /[A-Za-z]/.test(prev);
    const badNext = /[A-Za-z]/.test(next) && next !== 'x' && next !== 'X';
    /* 小数规格也不算：\`AAC5.1\` / \`DD5.1\` 这类声道标注里的数字，
     * 会让 E1 误命中（实测：非夸克线路 \`斗破苍穹.S05E044.2160p...AAC5.1.mp4\` 被 E1 命中）。
     * 判据：数字与小数点夹着数字（\`5.1\` 两侧的数字都算）；\`01.mp4\` 不受影响（点号后是 m，不是数字）。 */
    const inDecimal =
      (next === '.' && /\d/.test(s[m.index + m[0].length + 1] || '')) ||
      (prev === '.' && /\d/.test(s[m.index - 2] || ''));
    if (!badPrev && !badNext && !inDecimal) return Number(m[0]);
  }
  return null;
}

function locateEpisode(lines, season, episode) {
  const s = Number(season);
  const e = Number(episode);
  const hit = (line, ep, matchedBy) => ({ flag: line.flag, name: ep.name, id: ep.id, index: ep.index, matchedBy });

  /* ① 季优先（取代原来「季集必须同时命中」+「纯集号只认第 1 季」的口径）：
   * 集名里标了显式季号的 → 只在季号 === s 的集里匹配集号。 */
  for (const line of lines) {
    for (const ep of line.episodes) {
      const t = parseEpisodeTitle(ep.name);
      if (t && t.season === s && t.episode === e) return hit(line, ep, 'title');
    }
  }
  /* ② 季没出结果 → 直接匹配集：集名里只写了集号（第3集 / 03 / `211 4K.mp4`），
   * **任何季都认** —— 「斗破苍穹年番」在源里是扁平编号 01~211，在 TMDB 里却是第 5 季，
   * 原来非第 1 季一律定位不到。代价如实记着：扁平编号到底对应哪一季是猜的（按年番=最新季理解）。 */
  for (const line of lines) {
    for (const ep of line.episodes) {
      const t = parseEpisodeTitle(ep.name);
      if (t && t.season === null && t.episode === e) return hit(line, ep, 'episode');
    }
  }
  /* ③ 数字兜底：② 也没中 → 剔掉带 S 的规范段与体积标注后，
   * 集名里第一个数字 === e 就算命中（`[1.2GB]2.mp4` → 2）。
   * **取代原来的「按选集序号（该行第 N 个）兜底」** —— 那个必然错：某行列表从 208 开始时，
   * 请求 E1 会拿到 `208 4K.mp4`、请求 E3 会拿到 `210 4K.mp4`（实测已知的错配）。 */
  for (const line of lines) {
    for (const ep of line.episodes) {
      if (looseEpisodeNumber(ep.name) === e) return hit(line, ep, 'number');
    }
  }
  return null;
}

/** 变体的标注后缀：取名字里**括号段的内容**拼一句（`蜘蛛侠（臻彩）` → `臻彩`，多个用空格连）。 */
function variantLabel(fullName) {
  const parts = [];
  String(fullName || '').replace(/[（(【\[]\s*([^）)】\]]*?)\s*[）)】\]]/g, (m, inner) => {
    const t = String(inner || '').trim();
    if (t) parts.push(t);
    return m;
  });
  return parts.join(' ');
}

/**
 * 取一个站的 /detail 并拆成规范化结构（source = 它所属的源）。
 *
 * `pick` 决定"什么算可播目标"（电影/剧集两套取法，见 docs/adr/0022）：
 *   · 缺省 `''`  —— **剧集**取法：按传进来的季集号定位，每条线路的 `line.target` 是**这一集**；
 *   · `'items'` —— **电影**取法：**每条线路的每个播放项**各成一个目标（`line.items[]`），不按集号匹配。
 */
async function fetchDetail(source, site, vodId, timeoutMs, season, episode, pick) {
  /* 站点字段统一叫 `key`（与 searchSite / 对外形状一致）—— 曾用名 `site`，与 search 混用会使消费方读不到 key */
  const r0 = { source: source.id, key: site.key, name: site.name, api: site.api, ok: false, ms: 0, data: null, detail: null, error: null };
  const t0 = Date.now();
  try {
    const res = await request(source.url, site.api + '/detail', { method: 'POST', body: { id: vodId }, timeout: timeoutMs });
    r0.ms = Date.now() - t0;
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = res.json;
    if (!j || typeof j !== 'object') throw new Error('返回不是 JSON');
    r0.data = j;
    const it = (j.list || [])[0];
    /* msearch:xxx 这类 id：detail 返回 {}，是**如实**的空，不是失败 */
    if (!it) {
      r0.ok = true;
      r0.detail = null;
      r0.error = '站源 detail 返回空（`msearch:` 这类跳搜索的 id 本来就没有详情）';
      return r0;
    }
    const lines = parseLines(it.vod_play_from, it.vod_play_url);
    r0.ok = true;
    r0.detail = {
      vodId: String(it.vod_id || vodId),
      name: String(it.vod_name || ''),
      year: String(it.vod_year || ''),
      area: String(it.vod_area || ''),
      pic: String(it.vod_pic || ''),
      content: String(it.vod_content || ''),
      remarks: String(it.vod_remarks || ''),
      lines,
      lineCount: lines.length,
    };
    /* 传了**集号**就定位（**季号可选**）：每条线路各自定位（不同线路的集名/顺序可能不同），
     * 并把集名里源标的规格（容器/分辨率/编码/体积）解析出来挂在各自 target 上 ——
     * 消费方（如 emby 层）要用它填 MediaSource / MediaStreams。
     * ⚠️ 原实现要求 season 与 episode **都给**才算，只填集号就一律"没定位到"（实测：同一部片、
     * 同一个条目，填了季 6 条定位到、不填季 0 条）—— 而源里的集名常常只有集号
     * （`[842.5MB]211 4K.mp4`），前端填写时也往往只填集。定位规则本身**不依赖季号**
     * （见 `locateEpisode` 的 ②③），所以这里放开。 */
    if (pick === 'items') {
      /* ---- 电影取法：**每条线路的每个播放项**都是一个可播目标 ----
       * 为什么不能借季集号定位（曾经的写法）：电影文件名里没有集号（只有 `[5.0GB]` / `2026` / `1080p` /
       * `X265` 这类规格），而 `locateEpisode` 的三条路全是"按集名里的集号匹配" —— 实测 20 部电影里
       * 19 部一条都定位不到（源里有 4~20 条线路，`target` 却全空）⇒ 客户端版本列表恒为 0 条。
       * 电影在协议里本来就是「一条线路 + 若干播放项」（`vod_play_url` 里 `#` 分隔的那些），
       * 取每一项都是**确定的**（不是猜），所以这里全列出来，由客户端自己挑压制版本。
       * `line.target` 仍保留 = 第 1 项：诊断字段与既有消费方都不用改。 */
      let empty = 0;
      for (const line of lines) {
        const items = (line.episodes || []).map((ep) =>
          Object.assign(
            { flag: line.flag, name: ep.name, id: ep.id, index: ep.index, matchedBy: 'item' },
            parseEpisodeMeta(ep.name)
          )
        );
        if (!items.length) {
          empty += 1;
          continue;
        }
        line.items = items;
        line.target = items[0];
      }
      r0.detail.pick = 'items';
      r0.detail.target = (lines.find((l) => l.target) || {}).target || null;
      if (empty) r0.detail.targetNote = `${empty} 条线路里没有播放项（源里那几条是空壳）`;
      return r0;
    }
    if (episode !== undefined && episode !== null) {
      const want = { episode: Number(episode) };
      if (season !== undefined && season !== null) want.season = Number(season);
      const targets = lines.map((line) => {
        const t = locateEpisode([line], want.season, want.episode);
        return t ? Object.assign(t, want, parseEpisodeMeta(t.name)) : null;
      });
      lines.forEach((line, i) => {
        if (targets[i]) line.target = targets[i];
      });
      const first = targets.findIndex(Boolean);
      r0.detail.target = first >= 0 ? targets[first] : null;
      if (first < 0) {
        r0.detail.targetNote =
          `线路里定位不到 ${want.season !== undefined ? 'S' + want.season : ''}E${want.episode}` +
          '（集名里找不到这个集号，或第 1 季的序号不对）';
      } else if (targets.some((t) => !t)) {
        r0.detail.targetNote = `${targets.filter((t) => !t).length} 条线路里没定位到这一集（各自的 target 为空）`;
      }
    }
    return r0;
  } catch (e) {
    r0.ms = Date.now() - t0;
    r0.error = e && e.name === 'AbortError' ? `超时(${timeoutMs}ms)` : String((e && e.message) || e);
    return r0;
  }
}

/**
 * 详情主流程：**内部含搜索**（调用方只给影视名）。
 *
 *   name + year + 季集        → 并发搜各站 → **打分挑片**（`match.js`）→ 命中项取 detail
 *   source + site + vodId     → 快路径，跳过搜索（emby 层已缓存绑定时用）
 *
 * **筛选在"搜索"那一步就做完了**（`aggregateSearch` 里调 `match.select`），这里只是拿筛好的条目去取
 * 线路 —— 所以 Emby 那条链与 web 的聚合搜索**共用同一套判据与阈值**，不存在"两处判断不一致"。
 *
 * 返回里每站独立、不去重（与 /api/agg/search 同风格，`sites` 也是**数组**、每项带 source）；
 * 一条都没命中 → picked:null，`stats.match` 里写着"扫了多少条、各桶为什么没进"。
 *
 * ⚠️ **已去掉 picked 挑选：命中即全取**（原为"默认只取 picked 那一站，省时间"）。
 * `picked` 字段仍然返回 —— 但它只是"分最高的那条"**代表值**，不再用来筛掉别的站。
 * `maxItems`（默认 3）是上限：命中越多，"取链"的上游请求就越多，太慢。
 */
async function aggregateDetail(sources, sites, opts = {}) {
  const cfg = settings.read('agg');
  const byId = sourceMap(sources);
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || cfg.timeoutMs || 5000);
  const t0 = Date.now();
  const out = {
    name: String(opts.name || ''),
    year: String(opts.year || ''),
    searched: false,
    picked: null,
    sites: [],
    stats: { searched: 0, sameName: 0, variants: 0, detailOk: 0, detailFailed: 0, timeoutMs, sources: 0 },
  };

  const season = opts.season === undefined || opts.season === null || opts.season === '' ? null : Number(opts.season);
  const episode = opts.episode === undefined || opts.episode === null || opts.episode === '' ? null : Number(opts.episode);
  /* 取法：`items` = 电影（每条线路列出**全部播放项**），缺省 = 剧集（按季集号定位一条）。
   * 两者互斥地决定"什么算可播目标"，判据与理由见 `fetchDetail` 顶部。 */
  const pick = opts.pick === 'items' ? 'items' : '';

  /* ---- 快路径：已知绑定（source + site + vodId），跳过搜索 ---- */
  if (opts.site && opts.vodId) {
    const s = siteByKey(sites, opts.source, opts.site);
    if (!s) {
      out.sites = [{ source: opts.source, key: opts.site, name: '', ok: false, error: `站点清单里没有 ${opts.source} / ${opts.site}` }];
      out.elapsedMs = Date.now() - t0;
      return out;
    }
    const r = await fetchDetail(needSource(byId, s.source), s, opts.vodId, timeoutMs, season, episode, pick);
    out.sites = [r];
    out.picked = { source: s.source, key: s.key, vodId: opts.vodId, matchedBy: 'given', sameNameCount: 1 };
    if (r.ok) out.stats.detailOk += 1; else out.stats.detailFailed += 1;
    out.stats.sources = 1;
    out.elapsedMs = Date.now() - t0;
    return out;
  }

  /* ---- 正常路径：先搜（**搜索那一步已经把分打好了**），再按命中项取 detail ---- */
  const searchSites = pickSites(sites, opts);
  const search = await aggregateSearch(sources, searchSites, {
    wd: opts.name,
    page: '1',
    timeoutMs,
    /* 打分要"目标是哪部片"：名字 + 年份 + 季集，全交给 match.js（筛选逻辑就在搜索这一步，
     * 所以 detail 只是"拿已经筛好的链"，不再自己判一遍）。 */
    want: { name: opts.name, year: opts.year, season, episode },
    matchOptions: { minScore: opts.minScore, maxItems: opts.maxItems },
  });
  out.searched = true;
  out.stats.searched = searchSites.length;
  out.stats.sources = search.stats.sources;
  out.stats.match = search.match;
  out.stats.sameName = (search.matched || []).length; // 老字段名：命中的条目数

  for (const e of search.sites || []) {
    if (!e.ok) out.sites.push({ source: e.source, key: e.key, name: e.name, api: e.api, ok: false, ms: e.ms, error: e.error || '搜索失败' });
  }
  /* 没命中 → 如实说（把"搜了但没一条够格"也带上，调用方/日志一眼能分清是没搜到还是没匹配上） */
  const picked = (search.matched || [])[0] || null;
  if (!picked) {
    for (const e of search.sites || []) {
      if (out.sites.some((x) => x.source === e.source && x.key === e.key)) continue;
      const item = { source: e.source, key: e.key, name: e.name, api: e.api, ok: e.ok, ms: e.ms, sameNameCount: 0 };
      if (e.noResultBy) item.noResultBy = e.noResultBy;
      out.sites.push(item);
    }
    out.elapsedMs = Date.now() - t0;
    return out;
  }

  /* 要收的条目 = **每个站分数最高的那条当代表** + **同站其余命中当"变体"**（各自独立条目，各有自己的
   * `vod_id`）—— 变体分别取 detail，一条失败不影响代表。
   * 跨站不复用代表：不同站就是不同线路，那正是版本列表的意义（打分里的去重只去"同站同名"）。 */
  const bySite = new Map();
  const pushItem = (it, variant) => {
    const k = sid(it.source, it.siteKey);
    if (!bySite.has(k)) bySite.set(k, []);
    bySite.get(k).push({ item: it, variant });
  };
  const repOfSite = new Set();
  for (const it of search.matched || []) {
    const k = sid(it.source, it.siteKey);
    if (repOfSite.has(k)) pushItem(it, true);
    else {
      repOfSite.add(k);
      pushItem(it, false);
    }
  }
  out.stats.variants = (search.matched || []).length - repOfSite.size;

  /* 命中的站**全部取 detail**（不再只取 picked 那一站）。
   * 顺序按 `agg.order` 的优先级排 —— 否则并发搜索"谁先回来谁在前"，客户端版本列表每次刷新顺序都在跳
   * （同一条线路位置换来换去，找不着）。order 里没有的排到最后。 */
  const orderIdx = new Map((settings.read('agg').order || []).map((x, i) => [sid(x && x.source, x && x.key), i]));
  const wanted = Array.from(bySite.keys()).sort((a, b) => {
    const ia = orderIdx.has(a) ? orderIdx.get(a) : 9999;
    const ib = orderIdx.has(b) ? orderIdx.get(b) : 9999;
    return ia - ib;
  });
  /* 接续补打要用的两本账（判据见下面那段说明）：
   *   `attempted`  = 已经打过 `/detail` 的条目（`vod_id`）—— 补打时别再打一遍；
   *   `usableItems`= 其中**能用**的条数（`detailUsable`）—— 目标是凑够 `maxItems` 条。 */
  const needTarget = episode !== null && episode !== undefined;
  out.stats.needTarget = needTarget;
  /* "这条详情能不能用"的判据跟着取法走：电影看**有没有播放项**，剧集看**有没有定位到这一集** */
  const usableNeed = pick === 'items' ? 'item' : needTarget;
  const attempted = new Set();
  let usableItems = 0;

  const done = new Map();
  await Promise.all(
    wanted.map(async (composite) => {
      const s = siteByKey(sites, ...composite.split('\u0001'));
      const list = bySite.get(composite) || [];
      if (!s || !list.length) return;
      const src = needSource(byId, s.source);
      /* 代表条目：`picked` 落在本站就用它（完全同名、年份优先），否则退本站第一条同名。 */
      const sameList = list.filter((x) => !x.variant).map((x) => x.item);
      const rep = (picked && sid(picked.source, picked.siteKey) === composite ? picked : null) || sameList[0] || (list[0] && list[0].item);
      if (!rep) return;
      // eslint-disable-next-line no-await-in-loop
      const repR = await fetchDetail(src, s, rep.vod_id, timeoutMs, season, episode, pick);
      repR.sameNameCount = sameList.length;
      repR.variantCount = list.length - sameList.length;
      if (repR.ok) out.stats.detailOk += 1; else out.stats.detailFailed += 1;
      attempted.add(String(rep.vod_id || ''));
      if (detailUsable(repR.detail, usableNeed)) usableItems += 1;

      /* 变体**各自**取详情，挂在该站的 `variants[]`（代表仍占 `detail`，不重复塞一遍 ——
       * 免得多变体时把最大的那块 `lines` 在响应里序列化两遍）。取不到的**如实不带**，不猜。 */
      const rest = list.filter((x) => x.variant);
      if (rest.length) {
        const vs = await Promise.all(
          rest.map(async (x) => {
            // eslint-disable-next-line no-await-in-loop
            const r = await fetchDetail(src, s, x.item.vod_id, timeoutMs, season, episode, pick);
            if (r.ok) out.stats.detailOk += 1; else out.stats.detailFailed += 1;
            attempted.add(String(x.item.vod_id || ''));
            if (detailUsable(r.detail, usableNeed)) usableItems += 1;
            if (!r.detail) return null;
            return {
              variant: true,
              /* 版本行副标题：优先取括号里那截（`蜘蛛侠（臻彩）` → `臻彩`）；
               * 括号是空的（`斗破苍穹2018`、`斗破苍穹年番4更211`）就用**清洗后的主干**——
               * 不然同一站的多条变体在客户端里全叫同一个名字，分不出谁是谁。 */
              label: variantLabel(x.item.vod_name) || match.cleanTitle(x.item.vod_name) || String(x.item.vod_name || ''),
              vodName: String(x.item.vod_name || ''),
              vodId: r.detail.vodId,
              detail: r.detail,
            };
          })
        );
        const kept = vs.filter(Boolean);
        if (kept.length) repR.variants = kept;
      }
      done.set(composite, repR);
    })
  );

  /* ---- 接续补打：**最多试 N+K 条，凑够 N 条就算完** ----
   * 口径（**取代了上一版的"命中即止"**）：N = 最多留几条命中（`matchMaxItems`），
   * 想要的是 **N 条能用的**；前 N 条没凑够就按分数继续往下打，**最多再多试 K 条**（`matchExtraK`），
   * **凑够 N 条就立刻停**。勾了 **「匹配到底」**（`matchExtraAll`）= 不看 K，一直往下打到凑够或名单打完。
   *
   * 为什么要它：命中 ≠ 能播 —— 实测（玩偶/虎斑/木偶）里前 N 条可能全是空壳、或定位不到这一集，
   * 那样版本列表就少几条甚至为空；而真正有这一集的条目排在 N 名之外（被 `maxItems` 截掉了）。
   * 代价：最坏多打 K 次站源 `/detail`（顺序打、凑够即止，所以前 N 条都够用时是 0 次）。
   */
  const cfgNow = settings.read('agg');
  const extraAll = !!(opts.extraAll === undefined ? cfgNow.matchExtraAll : opts.extraAll);
  const extraK = Math.max(0, Number(opts.extraK === undefined ? cfgNow.matchExtraK : opts.extraK) || 0);
  /* 目标 = "凑够 `maxItems` 条能用的"；最多试 `maxItems + K` 条（匹配到底则不限条数） */
  const targetN = Math.max(1, Number((search.match || {}).maxItems) || 1);
  const attemptCap = extraAll ? Infinity : targetN + extraK;
  out.stats.targetN = targetN;
  out.stats.matchUsable = usableItems;
  if (usableItems < targetN && (extraAll || extraK > 0)) {
    const rest = (search.ranked || []).filter((x) => !attempted.has(String(x.vod_id || '')));
    let extraN = 0;
    let extraUsable = 0;
    for (const cand of rest) {
      /* 试过的条数封顶：`attempted` 里既有阶段一打过的、也有本阶段打过的 */
      if (attempted.size >= attemptCap) break;
      const site0 = siteByKey(sites, cand.source, cand.siteKey);
      if (!site0) continue;
      extraN += 1;
      attempted.add(String(cand.vod_id || ''));
      out.stats.extraTried = extraN;
      // eslint-disable-next-line no-await-in-loop
      const r2 = await fetchDetail(needSource(byId, site0.source), site0, cand.vod_id, timeoutMs, season, episode, pick);
      if (r2.ok) out.stats.detailOk += 1;
      else out.stats.detailFailed += 1;
      if (!r2.detail) continue;
      const composite2 = sid(cand.source, cand.siteKey);
      if (done.has(composite2)) {
        const base = done.get(composite2);
        base.variants = (base.variants || []).concat([
          {
            variant: true,
            label: variantLabel(cand.vod_name) || match.cleanTitle(cand.vod_name) || String(cand.vod_name || ''),
            vodName: String(cand.vod_name || ''),
            vodId: r2.detail.vodId,
            detail: r2.detail,
          },
        ]);
        base.variantCount = (base.variantCount || 0) + 1;
      } else {
        r2.sameNameCount = 1;
        r2.variantCount = 0;
        done.set(composite2, r2);
        if (!wanted.includes(composite2)) wanted.push(composite2);
      }
      if (detailUsable(r2.detail, usableNeed)) {
        usableItems += 1;
        extraUsable += 1;
        out.stats.usableExtra = extraUsable;
        /* 补打命中的那条当"代表"（emby 层拿它填 ProviderIds —— 那是"真正能播的那个绑定"）。
         * 只取**第一条**能用的（它分最高），再往下的即使能用也只进版本列表。 */
        if (!out.pickedFromExtra) out.pickedFromExtra = cand;
        if (usableItems >= targetN) break; // 凑够 N 条就算完
      }
    }
    out.stats.extraHit = extraUsable;
    console.log(
      `  ${extraUsable ? '↻' : '·'} agg 接续补打：前 ${(search.matched || []).length} 条里能用` +
        ` ${out.stats.matchUsable}/${targetN} 条 → 往下打了 ${extraN} 条` +
        `${extraAll ? '（匹配到底）' : `（上限 ${extraK}）`}，` +
        (usableItems >= targetN
          ? `凑够 ${usableItems}/${targetN} 条（阶段一 ${out.stats.matchUsable} + 补打 ${extraUsable}）`
          : `共有 ${usableItems}/${targetN} 条能用，仍未凑够（如实为空）`)
    );
  }

  /* 上面是**并发**完成的（谁先回来谁在前）—— 不稳。这里按 `wanted`（即 `order` 优先级）重排：
   * 消费方拿到的站点/版本顺序才是确定的；其余项（搜索失败、没同名的站）原样跟在后面。 */
  const ordered = [];
  for (const composite of wanted) if (done.has(composite)) ordered.push(done.get(composite));
  for (const x of out.sites) if (!done.has(sid(x.source, x.key))) ordered.push(x);
  out.sites = ordered;

  const pickedFinal = out.pickedFromExtra || picked;
  delete out.pickedFromExtra;
  out.picked = {
    source: pickedFinal.source,
    key: pickedFinal.siteKey,
    vodId: String(pickedFinal.vod_id || ''),
    /* `picked` = **分数最高的那条**（跨站），它是"代表值"：emby 层拿它填 ProviderIds/老字段。
     * 现在只有一种来源 —— 打分（`match.js`），所以带上分数与理由，别让人再去猜。 */
    matchedBy: out.stats.extraHit ? 'score+extra' : 'score',
    score: round3(pickedFinal.score),
    matchReason: pickedFinal.matchReason || '',
    /* 该站一共命中几条（1 条代表 + N 条变体）。诊断用：以前这里只算"完全同名"的条数，
     * 在 `bySite`（代表+变体混装）上直接 `.length` 会把变体也算进去（已知的错误来源）。 */
    sameNameCount: (bySite.get(sid(pickedFinal.source, pickedFinal.siteKey)) || []).length || (out.stats.extraHit ? 1 : 0),
  };
  out.elapsedMs = Date.now() - t0;
  return out;
}

/** play.url 既可能是字符串，也可能是「扁平数组 [名, 链接, 名, 链接…]」→ 统一成 urls[] */
function normalizeUrls(url) {
  if (!url) return [];
  if (Array.isArray(url)) {
    const odd = url.filter((_, i) => i % 2 === 1).map((x) => String(x || '')).filter(Boolean);
    if (odd.length) return odd;
    return url.map((x) => String(x || '')).filter(Boolean);
  }
  const s = String(url).trim();
  return s ? [s] : [];
}

const NON_HTTP_URL = /^(push|magnet|ed2k|thunder|ftp|rtmp):/i;

/**
 * 播放：`{source, site, flag, episodeId}` → 站源 `POST {api}/play {flag, id}` → 归一化。
 * 站点 api 前缀由 `(source, site)` 反查（调用方不用带），地址会过期，**每次播放都现取、不缓存**。
 */
async function playEpisode(sources, sites, opts = {}) {
  const cfg = settings.read('agg');
  const byId = sourceMap(sources);
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || cfg.timeoutMs || 5000);
  const t0 = Date.now();
  const site = siteByKey(sites, opts.source, opts.site);
  const done = (payload) => Object.assign({ source: opts.source, site: opts.site, flag: opts.flag, elapsedMs: Date.now() - t0 }, payload);

  if (!site) {
    return done({ ok: false, error: { code: 'SITE_NOT_FOUND', status: 404, message: `站点清单里没有 ${opts.source} / ${opts.site}（源可能换了站，重新走一次 detail 绑定即可）` } });
  }
  if (!opts.flag) return done({ ok: false, error: { code: 'FLAG_NOT_FOUND', status: 404, message: '缺少线路名 flag' } });
  if (!opts.episodeId) return done({ ok: false, error: { code: 'BAD_REQUEST', status: 400, message: '缺少集 ID episodeId' } });

  let res;
  try {
    res = await request(needSource(byId, site.source).url, site.api + '/play', { method: 'POST', body: { flag: opts.flag, id: opts.episodeId }, timeout: timeoutMs });
  } catch (e) {
    return done({ ok: false, error: { code: 'NETWORK', status: 502, message: e && e.name === 'AbortError' ? `超时(${timeoutMs}ms)` : '连不上源：' + ((e && e.message) || '') } });
  }
  if (!res.ok) {
    return done({ ok: false, error: { code: 'UPSTREAM_HTTP', status: res.status, message: '源返回 HTTP ' + res.status } });
  }

  const j = res.json || {};
  const urls = normalizeUrls(j.url);
  if (!urls.length) {
    return done({ ok: false, data: j, error: { code: 'NO_PLAY_URL', status: 502, message: '源没给出播放地址（网盘类线路要解析，可能首次不完整）' } });
  }
  return done({
    ok: true,
    siteName: site.name,
    api: site.api,
    data: j,
    play: {
      urls,
      header: j.header && typeof j.header === 'object' ? j.header : {},
      parse: Number(j.parse) || 0,
      nonHttp: urls.filter((u) => NON_HTTP_URL.test(u)), // push:// 之类原样透传，交给调用方决定
    },
  });
}

module.exports = {
  aggregateSearch,
  searchSite,
  normName,
  sid,
  sourceMap,
  siteByKey,
  selectSites,
  parseLines,
  parseEpisodeTitle,
  parseEpisodeMeta,
  locateEpisode,
  matchDefaults,
  normalizeUrls,
  fetchDetail,
  aggregateDetail,
  playEpisode,
};
