'use strict';
/**
 * 聚合层 · **进程内调用面**（面板自己用）
 *
 * 谁在用，两条路共用**同一套编排**（此前两处各写一份，易出现改动不同步）：
 *   ① 路由层 `POST /api/agg/detail` / `/api/agg/play` —— 给前端与外部用，仍走 HTTP；
 *   ② emby 层 —— `emby/service.js` 直接 `require('../agg/api')` 拿详情与播放地址。
 *
 * **为什么 emby 层不走 HTTP**：
 * emby 层原来打自己的 `http://127.0.0.1:<port>/api/agg/*`，而那条自调用**不带面板 cookie** ——
 * 面板门禁（`core/auth.js` 的 `needsAuth`：`/api/` 开头一律要登录）会把它挡成 **401**，
 * 于是每条详情都退化成"只回元数据"、播放链路也断（日志只写 `UPSTREAM_HTTP http://127.0.0.1:8099`，
 * 看不出是 401 —— 因为 401 发生在进路由之前，连一条 agg 请求日志都没有）。
 * 两层本来就在**同一个进程**里，「地址 + HTTP」那层壳除了多一次鉴权与一次 JSON 往返，没有任何价值。
 *
 * ⚠️ 模块间直连有两处，都是**同一个进程里的本地状态**，不是"地址 + HTTP"：
 *   ① emby → agg（本文件，原因见上）；
 *   ② agg → source（`require('../source/service').deployed()`）—— 本地部署的源就活在本进程里
 *      （`store` + `runner`），"读它的名字与当前端口"没有第二种拿法：写进配置会随重启过期。
 *   别的地方（source → agg 读配置、面板 → 外部聚合地址）仍走「地址 + HTTP」—— 那些地址
 *   **可以在别的机器上**。
 *
 * 约定：**不抛异常**，成败看 `ok`。失败一律 `{ ok:false, error:{ code, status, message } }` ——
 * `status` 是"同样的错在 HTTP 上该回几"，路由层直接照搬，emby 层则拿 code/message 写日志。
 * 站点身份是 `(source, site)` 这一对，任何按 key 对齐的地方都必须带上 source。
 */
const settings = require('../../core/settings');
const catpaw = require('../../core/catpaw');
const sourceService = require('../source/service');
const { aggregateSearch, aggregateDetail, playEpisode, selectSites } = require('./service');

/** 失败的统一形状（不抛异常：调用方可能是路由，也可能是 emby 层，各自决定怎么呈现） */
function fail(code, status, message) {
  return { ok: false, error: { code, status, message } };
}

/**
 * 聚合用哪些源 = **本地部署的源（自动，不需要配置）** + **自定义源（`agg.sources`，外部地址）**。
 *
 * 设计口径：部署的源不必再手动往聚合里加一遍 —— 名字就取**部署源自己的名字**
 * （否则会出现"聚合里叫 A、源页上叫 B"、看着像两个源）。所以清单每次现算：
 *   · 部署源的名字/端口都**当场问**（源改名、换端口立刻反映；存下来必然过期）
 *   · 自定义源照旧读配置（那是外部地址，面板不知道它后面是什么）
 * 前端「聚合 · 源列表」用 `deployed` 这个标记区分两类（部署的不可删、也没有地址可编辑）。
 */
function listSources() {
  const cfg = settings.read('agg');
  const custom = (cfg.sources || []).map((s) => ({
    id: s.id,
    url: s.url,
    name: s.name || '',
    enabled: s.enabled !== false,
    deployed: false,
  }));
  return sourceService.deployed().concat(custom);
}

/**
 * 拉所有**参与聚合**的源的站点清单；给每个站点打上 `source` / `sourceName`。
 * 单源失败只影响自己（回到 `sources[].ok/error`，它的站点就不出现在 `sites` 里）。
 * 返回 `{ sources, sites }`；`sources` 里不含站点数组（响应不必背两份）。
 */
async function loadSites() {
  const list = listSources();
  const rows = await Promise.all(
    list.map(async (s) => {
      const t0 = Date.now();
      const row = {
        id: s.id,
        url: s.url,
        name: s.name || '',
        enabled: s.enabled,
        deployed: !!s.deployed,
        /* 部署源的端口/运行态**要一起带上**（前端用它显示「:9988」、emby 层 302 时要拿它改写地址）。
         * 漏了的话前端那一遍探测回来就把端口冲掉了。 */
        port: s.port || null,
        status: s.status || '',
        running: !!s.running,
        ok: false,
        ms: 0,
        siteCount: 0,
        error: null,
      };
      let sites = [];
      if (!s.url) {
        /* 本地部署但没在跑（`deployed()` 只在运行时给 url）—— 如实说，别报成"请求超时" */
        row.error = s.deployed ? '这个源没在运行（去「源托管」启动它）' : '没有地址';
      } else {
        try {
          const r = await catpaw.fetchSites(s.url);
          sites = (r.sites || []).map((x) => Object.assign({}, x, { source: s.id, sourceName: s.name || s.url }));
          row.ok = true;
          row.siteCount = sites.length;
        } catch (e) {
          row.error = e && e.name === 'AbortError' ? '请求超时' : String((e && e.message) || e);
        }
      }
      row.ms = Date.now() - t0;
      return { row, sites };
    })
  );
  return {
    sources: rows.map((x) => x.row),
    /* 站点清单只收"启用的源"的；关掉的源整体不参与聚合（站点勾选不用逐个取消） */
    sites: rows.filter((x) => x.row.enabled).flatMap((x) => x.sites),
  };
}

/** 参与聚合的源（拉得到站点的那些）—— 用来把"源都不可用"和"没勾选站点"两种空区分开报 */
const liveSources = (sources) => (sources || []).filter((s) => s.ok);

/**
 * Emby **版本列表的线路过滤**（正则，**只匹配线路名** `line.flag`）—— 由 emby 层迁入。
 *
 * 为什么归聚合层：线路是聚合层产出的东西，过滤规则与它放在一处，才不会出现"配置在 A、生效在 B"。
 * `emby` 层不再读自己的设置，改成调这里（`emby/service.js` 的 `lineFilter()` 就一行转发）。
 *
 * ⚠️ 语义不变：**只影响"列出来的版本"，不影响播放**（`resolveStream` 按版本 Id 回查，不查这个列表）。
 * 规则写错时**不抛**（保存时已校验；这里是运行时兜底）：`re:null + invalid:true`，调用方按"不过滤"走并记日志。
 */
function lineFilter() {
  const raw = String((settings.read('agg') || {}).lineFilter || '').trim();
  if (!raw) return { raw: '', re: null, invalid: false };
  try {
    return { raw, re: new RegExp(raw, 'i'), invalid: false };
  } catch {
    return { raw, re: null, invalid: true };
  }
}

/**
 * 取影视详情（**内部含搜索**）。
 *
 * `opts`：`name`（影视名）/ `year`（消歧）/ `season` + `episode`（定位某一集）/
 * `keys`（限定站点 `{source,key}[]`）/ `source`+`site`+`vodId`（快路径：已知绑定就直查，跳过搜索）/
 * `minScore` + `maxItems`（打分阈值与"最多留几条"，不传就用 `agg.json` 里的设置）；
 * `extraK` / `extraAll`（接续补打：前 N 条没凑够时再往下试几条 / 匹配到底，不传读设置）。
 * **没有 `all`**：命中的站一律全取（见 service.aggregateDetail），
 * 但条数受 `maxItems` 限制（每多一条命中就要多打一次 `/detail` 取链，太慢）。
 * ⚠️ **不再有 TMDB 反查**：判据是 `match.js` 的打分（理由见那个文件顶部）。
 * 成功回 `{ok:true, sites, picked, stats, sources, elapsedMs}`（每站的成败在 `sites[].ok/error` 里）。
 */
async function detail(opts = {}) {
  const name = String(opts.name || '').trim();
  const source = String(opts.source || '').trim();
  const site = String(opts.site || '').trim();
  const vodId = String(opts.vodId || '').trim();
  if (!name && !(source && site && vodId)) {
    return fail('BAD_INPUT', 400, '请提供 name（影视名），或用 source + site + vodId 直接指定绑定');
  }

  const cfg = settings.read('agg');
  const { sources, sites } = await loadSites();
  if (!sources.length) return fail('NO_SOURCE', 400, '还没有聚合源：本地部署一个源，或到「聚合设置 → 源列表」填一个外部地址');

  const scoped = site
    ? sites.filter((x) => x.key === site && (!source || x.source === source))
    : selectSites(sites, cfg, opts.keys);
  if (!scoped.length) {
    return fail(
      'NO_SITE',
      400,
      site
        ? `没有可用的站源：${source ? source + ' / ' : ''}${site}`
        : '没有可用的站源：请到「站点与参数」页勾选参与聚合的站点'
    );
  }

  const out = await aggregateDetail(sources, scoped, {
    name,
    year: opts.year,
    source,
    site,
    vodId,
    season: opts.season,
    episode: opts.episode,
    timeoutMs: opts.timeoutMs,
    minScore: opts.minScore,
    maxItems: opts.maxItems,
    /* 接续补打（不传读设置）：前 N 条没凑够时最多再多试几条（`matchExtraK`）；
     * `extraAll` = 匹配到底（不看 K，一直往下打到凑够或名单打完） */
    extraK: opts.extraK,
    extraAll: opts.extraAll,
  });
  out.sources = sources;
  /* 打分的"一句话摘要"进日志：命中几条、扫了多少条、没进的都因为什么。
   * 没命中时这行就是唯一线索 —— 所以把各桶计数都写出来（web 上那三个输入框怎么调，看它）。 */
  const m = out.stats && out.stats.match;
  if (m) {
    const hit = Number(out.stats.sameName) || 0; // 命中的条目数（pick 为空时是 0）
    console.log(
      `  ${out.picked ? '✔' : '·'} agg 打分「${name}」：扫 ${m.scanned} 条 → 命中 ${m.matched}` +
        `（分数线 ${m.minScore || '关'}，上限 ${m.maxItems || '不封顶'}）` +
        `；没进：低分 ${m.belowLine} / 超上限 ${m.overCap} / 名字不过闸 ${m.rejected}` +
        `；同站同名 ${m.sameNameSameSite || 0} 条（照收，不去重）` +
        (out.picked ? `；代表 ${out.picked.source}/${out.picked.key} 分 ${out.picked.score}` : '')
        + (hit ? '' : ' → 结果为空')
    );
  }
  return Object.assign({ ok: true }, out);
}

/**
 * 取播放地址：`{source, site, flag, episodeId}`。
 * 成功回 `{ok:true, play:{urls, header, parse, nonHttp}}`；失败按原因给码
 * （`SITE_NOT_FOUND` / `FLAG_NOT_FOUND` / `NO_PLAY_URL` / …，见 service.playEpisode）。
 * 地址会过期：**每次播放都现取**，别缓存。
 */
async function play(opts = {}) {
  const source = String(opts.source || '').trim();
  const site = String(opts.site || '').trim();
  if (!site) return fail('BAD_INPUT', 400, '请提供 site（站点 key）');
  if (!source) return fail('BAD_INPUT', 400, '请提供 source（源 id）');

  const { sources, sites } = await loadSites();
  const out = await playEpisode(sources, sites, {
    source,
    site,
    flag: opts.flag,
    episodeId: opts.episodeId,
    timeoutMs: opts.timeoutMs,
  });
  out.sources = sources;
  return out;
}

module.exports = {
  fail,
  lineFilter,
  listSources,
  loadSites,
  liveSources,
  detail,
  play,
  aggregateSearch,
  selectSites,
};
