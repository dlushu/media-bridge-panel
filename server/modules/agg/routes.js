'use strict';
/**
 * 聚合层路由（**多源**）：
 *   GET  /api/agg/sources 源清单（**不探测**：本地部署的源 + 自定义地址，读文件/进程状态，几毫秒）
 *   GET  /api/agg/sites   源清单 + 站点清单（每个源并发拉自己的 /config）
 *   POST /api/agg/search  按片名并发搜**多个源的多个站源**，并**顺手打分**：
 *                         `{wd, page?, year?, season?, episode?, minScore?, maxItems?, keys?}` →
 *                         出参里每个条目带 `score`/`matched`/`matchReason`，顶层给 `matched` 与
 *                         `unmatched`（**失败也回，带原因**）+ `match` 计数。打分口径见 `match.js`。
 *   POST /api/agg/detail  取某部影视的详情：**内部含搜索**（或 `source+site+vodId` 快路径），
 *                         把站源协议（`$$$` / `#` / `$`）拆成「线路 → 选集」，需要时可定位某一集
 *   POST /api/agg/play    按 `{source, site, flag, episodeId}` 取播放地址（归一化 url / header / parse）
 *
 * 源清单 = **本地部署的源（自动）** + 设置里的**自定义地址**（见 api.listSources）。
 * 部署源不需要在聚合里配一遍：名字取部署源自己的名字，地址每次现算（端口会变）。
 * 站点身份是 `(source, key)` 这一对：key 只在各自源内唯一，跨源同名是常事 ——
 * 所以入参/出参里 source 与 key 是**两个字段**，绝不用裸 key 对齐。
 *
 * ⚠️ 本层**不直接 require source 层**（那件事在 `./api.js` 里做，只有它需要"部署源现在在哪个端口"）：
 * 这里只管 HTTP：解 body → 调 api → 按 `error.status` 决定状态码。
 * emby 层走的是同一个 api（见 api.js 的说明）。
 */
const settings = require('../../core/settings');
const { sendJson, sendError, readBody } = require('../../core/http');
const api = require('./api');
const { aggregateSearch, selectSites } = require('./service');

/**
 * 一次性搬迁（项目未发布，不做兼容分支）：把多源之前的两样东西搬成新形状。
 *   ① `upstream.source`（**单个**猫源地址）→ `sources[0]`（地址本身有价值，不能丢）
 *   ② `enabled` / `order` 里的**裸站点 key** → 丢弃（"它属于哪个源"无从得知，提示重新勾选）
 * 不搬 ② 的话，新的 validate 会一直拒掉后续保存（旧非法项还留在数组里）。
 * 只在启动注册路由时跑一次；干净了就什么也不做。
 */
function migrateLegacy() {
  const cfg = settings.read('agg');
  const isPair = (x) => !!x && typeof x === 'object' && x.source && x.key;
  const next = Object.assign({}, cfg);
  const notes = [];

  const old = cfg.upstream && cfg.upstream.source;
  if (old && !(cfg.sources || []).length) {
    next.sources = [{ id: 's1', url: String(old), name: /^https?:\/\/(127\.0\.0\.1|localhost)/i.test(old) ? '本地源' : '', enabled: true }];
    notes.push(`猫源地址 ${old} → 源列表 s1`);
  }
  if (next.upstream !== undefined) delete next.upstream; // 旧字段整体去掉（已被 sources 取代）

  if (['enabled', 'order'].some((k) => (cfg[k] || []).some((x) => !isPair(x)))) {
    next.enabled = [];
    next.order = [];
    notes.push('旧的裸站点 key 已丢弃（请重新勾选站点）');
  }

  if (!notes.length) return;
  settings.write('agg', next);
  console.log('  ↻ agg 设置搬迁：' + notes.join('；'));
}

/** api 的失败形状（`{ok:false, error:{code,status,message}}`）→ HTTP */
function fail(res, out) {
  const e = out.error || {};
  return sendError(res, e.status || 400, e.message || '聚合层调用失败');
}

module.exports = function routes(r) {
  migrateLegacy();

  /**
   * GET /api/agg/sources —— **不探测的源清单**（前端"先渲染、后台探测"的第一遍）。
   * 与 `/api/agg/sites` 同形状，只是没有 `ok/ms/siteCount/error`（那是探测结果）。
   * 单列这一条是因为源清单是**本机状态**（读文件 + 问进程），几毫秒就回来；
   * 而探测要挨个打源的 `/config`，连不上的源得等超时。
   */
  r.add('GET', '/api/agg/sources', (req, res) => sendJson(res, 200, { sources: api.listSources() }));

  r.add('GET', '/api/agg/sites', async (req, res) => {
    const cfg = settings.read('agg');
    const { sources, sites } = await api.loadSites();
    const bad = sources.filter((s) => !s.ok);
    if (sources.length) {
      console.log(
        `  ✔ agg 站点清单 → ${sources.length} 个源 · ${sites.length} 个站点` +
          (bad.length ? `（${bad.length} 个源取不到：${bad.map((s) => s.id + ' ' + s.error).join('；')}）` : '')
      );
    }
    return sendJson(res, 200, {
      sources,
      sites,
      agg: {
        enabled: cfg.enabled || [],
        order: cfg.order || [],
        timeoutMs: cfg.timeoutMs,
        concurrency: cfg.concurrency,
        initFirst: cfg.initFirst,
        /* 打分默认值一起给：web「聚合搜索」页的"最低分/最多取几条"输入框就是拿它预填的
         * （页面里改只影响这一次请求；要改默认值去「聚合设置」页） */
        matchMinScore: cfg.matchMinScore,
        matchMaxItems: cfg.matchMaxItems,
      },
    });
  });

  r.add('POST', '/api/agg/search', async (req, res) => {
    const body = await readBody(req);
    if (!body || !String(body.wd || '').trim()) return sendError(res, 400, '请提供搜索关键字 wd');

    const cfg = settings.read('agg');
    const { sources, sites } = await api.loadSites();
    if (!sources.length) return sendError(res, 400, '还没有聚合源：本地部署一个源，或到「聚合设置 → 源列表」填一个外部地址');
    const picked = selectSites(sites, cfg, body.keys);
    if (!picked.length) {
      if (!api.liveSources(sources).length) {
        return sendError(res, 400, '所有聚合源都取不到站点：' + sources.map((s) => `${s.id} ${s.error || '未知错误'}`).join('；'));
      }
      return sendError(res, 400, '没有可聚合的站源：请到「站点与参数」页勾选参与聚合的站点');
    }

    const out = await aggregateSearch(sources, picked, {
      wd: body.wd,
      page: body.page || '1',
      timeoutMs: body.timeoutMs,
      concurrency: body.concurrency,
      /* 打分：`year` / `season` / `episode` 是"目标是哪部片"的信号（web 上填季集就是给它用），
       * `minScore` / `maxItems` 不传就用 `agg.json` 里的设置。`minScore: 0` = 不按分数线筛选。 */
      want: { name: body.name || body.wd, year: body.year, season: body.season, episode: body.episode },
      matchOptions: { minScore: body.minScore, maxItems: body.maxItems, unmatchedMax: body.unmatchedMax },
    });
    /* `ranked` 是"过关全量的排名"，只给聚合层内部（detail 的接续补打）用；
     * 回给前端等于把同一批条目再序列化一遍（响应大一倍），这里删掉。 */
    delete out.ranked;
    return sendJson(res, 200, out);
  });

  /**
   * POST /api/agg/detail —— 取影视详情（**内部含搜索**）
   *
   * body：name（影视名，必填）/ year（消歧）/ season + episode（定位某一集）/
   *       keys（限定站点，`{source,key}[]`）/ `source`+`site`+`vodId`（快路径：已知绑定就直查，跳过搜索）/
   *       minScore + maxItems（打分阈值与"最多留几条"，不传读设置）
   *       —— **没有 `all` 了：命中的站一律全取**（见 service.aggregateDetail）
   *       判据是 `match.js` 的打分（不再有 TMDB 反查）
   * 一律 200（每站的成败在 `sites[].ok` / `error` 里）—— 与 search 同一风格；
   * 只有"调用方搞错了"（没给 name、没配源、没勾站点）才 400。
   */
  r.add('POST', '/api/agg/detail', async (req, res) => {
    const out = await api.detail((await readBody(req)) || {});
    if (!out.ok) return fail(res, out);
    return sendJson(res, 200, out);
  });

  /**
   * POST /api/agg/play —— 取播放地址
   *
   * body：source（源 id，必填）/ site（站点 key，必填）/ flag（线路名，必填）/ episodeId（集 ID，必填）
   * 成功 200 `{ok:true, play:{urls, header, parse, nonHttp}}`；
   * 失败按原因给码（SITE_NOT_FOUND 404 / FLAG_NOT_FOUND 404 / NO_PLAY_URL 502 / …）。
   * 地址会过期：**每次播放都现取**，别缓存。
   */
  r.add('POST', '/api/agg/play', async (req, res) => {
    const out = await api.play((await readBody(req)) || {});
    return sendJson(res, out.ok ? 200 : (out.error && out.error.status) || 502, out);
  });
};
