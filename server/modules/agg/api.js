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
const { request } = require('../../core/upstream');
const sourceService = require('../source/service');
const cache = require('./cache');
const siteStats = require('./site-stats');
const { aggregateSearch, aggregateDetail, playEpisode, selectSites, matchDefaults, ensureInit, detailTimeoutMs, lineFilter: serviceLineFilter } = require('./service');

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
          sites = (r.sites || []).map((x) =>
            Object.assign({}, x, {
              source: s.id,
              sourceName: s.name || s.url,
              /* 把**已记下的统计**带上（见 site-stats.js）：界面那一列「延迟」= `stat.home`（测速结果），
               * title 里的"最近一次真实搜索 / 取详情"= `stat.call.*`（顺手记账）。
               * 什么都没记过的站点这里是 null，界面显示 `—`（如实，不编）。 */
              stat: siteStats.view(s.id, x.key),
            })
          );
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
 * Emby **版本列表的线路过滤**（正则，**只匹配线路名** `line.flag`）。
 *
 * ⚠️ **实现已搬到 `service.js`**：它现在有两处用途、必须同一套判据 ——
 * emby 层拼版本列表时，与聚合层判断"这条详情对客户端有没有用"时（见 ADR-0025）。
 * 这里只转发，emby 层照旧调这个入口（`emby/service.js` 的 `lineFilter()` 一行转发）。
 */
const lineFilter = () => serviceLineFilter();

/* ============================================================
 * 详情快照 + 同键并发合并（表与库见 modules/agg/cache.js）
 *
 * 客户端点一次「播放」会连着问三遍同一件事（条目详情 → 播放信息① → 播放信息②），
 * 每遍都要「搜源 → 逐站取详情 → 定位到这一集」，实测 4~7 秒 —— 三次串行 ≈ 20 秒，
 * 其中两遍是白重算的。这里把那一步的结果存下来复用。
 * ============================================================ */

/** 正在跑的详情查询：同一个 key 的并发请求跟着同一趟走，不各打一次源站 */
const inflightDetail = new Map();

/**
 * 快照 key = 「问的是什么」+「当时按什么规则问」。
 *
 * 把**规则**（参与站点、源地址、分数线、最多留几条、补打设置、站点顺序、**线路过滤**）
 * 一起拼进去，是为了让「改了设置」这件事**天然换 key** —— 不必再写一套"设置变更后清缓存"
 * 的钩子，也不会读到按旧规则算出来的结论。
 *
 * ⚠️ **线路过滤进 key**（原先写的是"不进"，现已被 ADR-0025 取代）：它现在参与"这条详情
 * 对客户端有没有用"的判据（过滤后一条都列不出来 → 不算有用、也不存快照），所以规则一改
 * 就必须换成另一个 key。代价如实记着：**改规则后第一次请求要重算**（那一趟是秒级的）——
 * 换来的是不会命中一份"按旧规则判定为有用"的结论。
 */
function detailCacheKey({ name, year, season, episode, scoped, sources, cfg, opts }) {
  const m = matchDefaults(opts);
  const extraAll = opts.extraAll === undefined ? !!cfg.matchExtraAll : !!opts.extraAll;
  const pair = (x) => `${(x && x.source) || ''}/${(x && x.key) || ''}`;
  const dim = (v) => (v === undefined || v === null || v === '' ? '' : String(v));
  return [
    'aggdetail',
    String(name || ''),
    String(year || ''),
    dim(season),
    dim(episode),
    /* 参与站点（顺序无关 → 排序）+ 源地址（改了地址等于换了后端，旧快照不能再用） */
    scoped.map(pair).sort().join(','),
    (sources || []).map((s) => `${s.id}|${s.url || ''}`).sort().join(';'),
    /* 这几项直接决定"命中哪些站"，必须进 key */
    [m.minScore, m.maxItems, m.extraK, extraAll ? 1 : 0, (cfg.order || []).map(pair).join(',')].join('|'),
    /* 取详情的单站超时（秒）：它决定"这一次哪几条线路取得到"（超时的站那条就没了），
     * 与线路过滤同理 —— 改了规则就该重算，而不是命中一份按旧超时算出来的结论 */
    String(Math.round(detailTimeoutMs(cfg) / 1000)),
    /* 线路过滤的原文（正则）：它决定"这份详情对客户端有没有用"，必须进 key（见上） */
    String(cfg.lineFilter || '').trim(),
  ].join('\u0001');
}

/**
 * 什么样的结果才值得存快照。
 *
 * **判据：`stats.usable > 0`** —— 即"至少有一条**过滤后仍能被客户端列出来**的线路"
 *（有线路、过了线路过滤、且定位到这一集 / 有播放项；由 `service.aggregateDetail` 统计）。
 *
 * 这条判据改过两次，两次都是被实测推着走的：
 *   ① 原先还额外要求「没有站失败」「没有详情失败」，太严：这一趟是 **10 秒级**的活
 *      （实测中位 10.8s），启用站里只要有一个慢/抖一下整份就不存，于是客户端点一次播放
 *      连着问的那三遍（详情 → 播放信息① → 播放信息②）**全部重算**，一次播放要等 20~30 秒。
 *      放宽成"有站拿到详情就存"（`detailOk > 0`）。那次取舍的完整理由与代价见 ADR-0020。
 *   ② 现在再收一道：**过滤后一条都列不出来 = 对客户端没有用**（ADR-0025）。
 *      实测症状：某站的 4 条线路被 `/夸克原画/` 全滤掉，客户端 0 个版本，而这份"没用"的
 *      快照照样存了下来、在那个有效期内一直挡着（客户端反复点开都是 0 版本）。
 *
 * 代价**如实记着**：存下的可能是"缺某个源那几条线路"的半份结果，在那个有效期内点开都会缺它。
 * 所以不让这件事无声无息 —— 存快照那行日志会**点名**这次是哪个源没取到（见下面 `compute()` 里）。
 *
 * 仍然不存**负结果**（没命中、或全失败）：这两件事在返回值上不好区分，
 * 分不清就不缓存，每次如实去问（延续 ADR-0008）。
 */
function cacheableDetail(out) {
  return Number((out.stats || {}).usable) > 0;
}

/**
 * 取影视详情（**内部含搜索**）。
 *
 * `opts`：`name`（影视名）/ `year`（消歧）/ `season` + `episode`（定位某一集）/
 * `keys`（限定站点 `{source,key}[]`）/ `source`+`site`+`vodId`（快路径：已知绑定就直查，跳过搜索）/
 * `pick`（取法：`items` = 电影，列出每条线路的**全部播放项**；缺省 = 剧集，按季集号定位一条）/
 * `timeoutMs`（搜索那一步的单站超时，毫秒）/ `detailTimeoutMs`（**取详情**的单站超时，毫秒，
 * 不传读 `agg.detailTimeoutSec` —— 默认比搜索宽，理由见 service.searchTimeoutMs）/
 * `minScore` + `maxItems`（打分阈值与"最多留几条"，不传就用 `agg.json` 里的设置）；
 * `extraK` / `extraAll`（接续补打：前面一条能用的都没拿到时再往下试几条 / 匹配到底，不传读设置）。
 * **没有 `all`**：命中的站一律全取（见 service.aggregateDetail），
 * 但条数受 `maxItems` 限制（每多一条命中就要多打一次 `/detail` 取链，太慢）。
 * ⚠️ **不再有 TMDB 反查**：判据是 `match.js` 的打分（理由见那个文件顶部）。
 * 成功回 `{ok:true, sites, picked, stats, sources, elapsedMs}`（每站的成败在 `sites[].ok/error` 里）；
 * 走快照时多一个 `cached:true`，`elapsedMs` 是**当初算它那一次的耗时**。
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

  /* 只有「按名字搜」这条路才值得缓存（那 4~7 秒就在它身上）。
   * 带 `source + site + vodId` 的快路径只打一个站，而且它是 `resolveStream` 取**新鲜**集 ID 的那条路 ——
   * 缓存它会拿到过期的集 ID，所以那条路一律不缓存、也不做合并。 */
  const cacheKey =
    !site && !vodId && name ? detailCacheKey({ name, year: opts.year, season: opts.season, episode: opts.episode, scoped, sources, cfg, opts }) : '';

  if (cacheKey) {
    const snap = cache.getDetail(cacheKey);
    if (snap) {
      /* 源清单用**这次**读到的（站点/端口会变），其余照旧 —— 快照只省掉"打源站"那一段 */
      snap.sources = sources;
      snap.cached = true;
      console.log(
        `  · agg 详情走快照「${name}」→ ${(snap.sites || []).length} 站` +
          `（没打源站；当初算它花了 ${snap.elapsedMs || 0}ms）`
      );
      return Object.assign({ ok: true }, snap);
    }
  }

  /** 真正去打源站的那一趟（含写快照） */
  const compute = async () => {
    const out = await aggregateDetail(sources, scoped, {
      name,
      year: opts.year,
      source,
      site,
      vodId,
      season: opts.season,
      episode: opts.episode,
      /* 取法：`items` = 电影（每条线路列出全部播放项）；缺省 = 剧集（按季集号定位一条）。 */
      pick: opts.pick,
      timeoutMs: opts.timeoutMs,
      detailTimeoutMs: opts.detailTimeoutMs,
      minScore: opts.minScore,
      maxItems: opts.maxItems,
      /* 接续补打（不传读设置）：一条能用的都没拿到时最多再试几条（`matchExtraK`）；
       * `extraAll` = 匹配到底（不看 K，一直往下打到拿到一条或名单打完） */
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
          (out.picked ? `；代表 ${out.picked.source}/${out.picked.key} 分 ${out.picked.score}` : '') +
          (hit ? '' : ' → 结果为空')
      );
    }

    if (cacheKey) {
      if (!cacheableDetail(out)) {
        console.log(
          '  · agg 详情不存快照（没命中 / 没有任何站拿到详情 / **线路过滤后一条能用的都没有**）—— 下次仍如实去问'
        );
      } else if (cache.putDetail(cacheKey, out)) {
        /* **有站失败也照存**（见 `cacheableDetail`），所以这里必须点名缺了谁 ——
         * 否则"快照里少几条线路"跟"源里本来就没有"长得一模一样，事后无从分辨。 */
        const s = out.stats || {};
        const bad = (out.sites || []).filter((x) => x && x.ok === false).map((x) => x.name || x.key);
        const miss = [];
        if (bad.length) miss.push(`${bad.length} 个源没搜到（${bad.slice(0, 4).join(' / ')}${bad.length > 4 ? ' …' : ''}）`);
        if (Number(s.detailFailed)) miss.push(`${s.detailFailed} 条详情没取到`);
        console.log(
          `  ✔ agg 详情已存快照（${(out.sites || []).length} 站` +
            (miss.length ? `；⚠️ 但不完整：${miss.join('，')} —— 这份快照里没有它们的线路` : '') +
            `；有效期见「面板设置 → 缓存设置」）`
        );
      } else {
        console.log('  · agg 详情没存快照（「缓存设置 → 聚合详情」的有效期填了 0 = 不缓存）');
      }
    }
    return Object.assign({ ok: true }, out);
  };

  if (!cacheKey) return compute();

  /* 同键并发合并：同一时刻两个人点开同一部片，只打一趟源站 */
  const running = inflightDetail.get(cacheKey);
  if (running) {
    console.log(`  · agg 详情同键合并「${name}」—— 跟着同一趟源站查询走`);
    return running;
  }
  const p = compute();
  inflightDetail.set(cacheKey, p);
  try {
    return await p;
  } finally {
    inflightDetail.delete(cacheKey);
  }
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

/**
 * 测速用的**固定超时** —— **不读 `agg.timeoutSec`**（那个是给播放/搜索链路的，默认 5 秒）。
 * 拿 5 秒去测速，慢站会一律被记成"超时"，量到的是设置而不是站；15 秒够容下实测里最慢的
 * 几发搜索（冷回源 0.4~1s、个别站 5s+），也不至于让一轮测速拖太久。
 */
const SPEED_TEST_TIMEOUT_MS = 15000;

/**
 * 测速用的**探测词**（常见影视名）—— 每次**随机取一个**。
 *
 * 为什么要"一组 + 随机"而不是固定一个词：站里**没有**这个词时会回 404 或空列表
 * （实测 duoduo / huban：有词 200、无词 404），固定一个词等于给每个站预设了
 * "有没有结果"这个变量；随机取则长期看每个站都会被抽到有结果的词。
 * 选词口径：各站普遍收录的大众片，动画 / 国剧 / 老剧各占一些（避免整组都是同一类）。
 */
const PROBE_WORDS = [
  '斗破苍穹',
  '斗罗大陆',
  '庆余年',
  '甄嬛传',
  '西游记',
  '亮剑',
  '琅琊榜',
  '武林外传',
  '士兵突击',
  '狂飙',
  '三体',
  '人民的名义',
];

/** 随机取一个探测词；给了 `exclude` 就避开它（"换一个关键词再测"用它） */
function pickProbeWord(exclude) {
  const pool = PROBE_WORDS.filter((w) => w !== exclude);
  const list = pool.length ? pool : PROBE_WORDS;
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * **单站测速**：`POST {api}/search`（关键词随机取），量往返耗时并覆盖统计里的那一槽。
 *
 * 为什么是 `/search`：聚合真正走的就是它，只有它的数字对得上"用户会等多久"。
 * （`/home` 实测虽然普遍可用，但它返回的是**首页分类树** —— huban/duoduo 各 62KB / 208 个分类、
 * 盘搜类站是空壳 10ms —— 与搜索耗时背离：实测 duoduo 首页 2.0s / 搜索 0.4s、huban 1.4s / 0.1s，
 * 当"延迟"列会误导，所以不用它。）
 *
 * **失败换词再测一发**：非 200（404 / 5xx / 403 …）就换一个探测词重测；**两发都非 200 才算真失败**。
 * 这样"这站恰好没有那个词"不会被记成一次失败，而真的坏站（两发都失败）会如实标出来。
 *
 * **口径与业务刻意不同**（见 `site-stats.js` 顶部）：`200 = 成功`，**列表为空也算**
 * （它已经尽了搜索的义务）；非 200 记失败并记下状态码；超时 / 网络错记失败。
 *
 * `init` 走 `ensureInit()`（与业务同一个函数、同一份缓存）：测速顺带把"已初始化"标记做好，
 * 业务侧首次搜索不必再多打一次（`initFirst` 开关已删，见 service.js 的 ensureInit）。
 *
 * 失败不可怕：`ok:true` 只表示"这次测速动作本身完成了"，站点结论在返回的 `search` 里。
 * `routeMissing` —— 404 且文案是 `Route POST:… not found`（**源里这个站没实现 /search**，
 * 不是站坏了）；其余非 200 / 超时 = 上游真实的错（HTTP 404 / 500 / 403 / 超时）。
 */
async function probeSearch({ source, key, api, wd, timeoutMs } = {}) {
  const siteKey = String(key || '').trim();
  const sourceId = String(source || '').trim();
  if (!siteKey) return fail('BAD_INPUT', 400, '请提供站点 key');
  if (!sourceId) return fail('BAD_INPUT', 400, '请提供源 id');
  const row = listSources().find((s) => s.id === sourceId);
  if (!row || !row.url) return fail('NO_SOURCE', 400, `源 ${sourceId} 现在不可用（没在运行？）`);

  /* 站的接口前缀：调用方手上一般就有（站点清单里的 `api`），没带就问一次源自己的 /config */
  let apiPath = String(api || '').trim();
  if (!apiPath) {
    try {
      const r = await catpaw.fetchSites(row.url);
      const hit = (r.sites || []).find((x) => x.key === siteKey);
      apiPath = hit ? hit.api : '';
    } catch (e) {
      return fail('UPSTREAM_HTTP', 502, '取站点清单失败：' + String((e && e.message) || e));
    }
  }
  if (!apiPath || !apiPath.startsWith('/')) return fail('BAD_INPUT', 400, `认不出站点 ${siteKey} 的接口路径`);

  const timeout = Math.max(1000, Number(timeoutMs) || SPEED_TEST_TIMEOUT_MS);
  const initCalled = await ensureInit(row, { key: siteKey, api: apiPath }, timeout);

  /** 打一发搜索（`/init` 上面已经处理过，这里不再重复） */
  const callSearch = async (word) => {
    const t0 = Date.now();
    let status = 0;
    let ok = false;
    let error = '';
    let text = '';
    let body = null;
    try {
      const r = await request(row.url, apiPath + '/search', { method: 'POST', body: { wd: word, page: '1' }, timeout });
      status = r.status;
      ok = r.ok;
      text = String(r.text || '');
      body = r.json;
      if (!ok) error = 'HTTP ' + r.status;
    } catch (e) {
      error = e && e.name === 'AbortError' ? `超时(${timeout}ms)` : String((e && e.message) || e);
    }
    const list = (body && Array.isArray(body.list) && body.list) || [];
    return {
      wd: word,
      ms: Date.now() - t0,
      status,
      ok,
      error,
      count: list.length,
      /* 源的路由级 404：这个站没实现 /search（文案与上游 404 不同，实测可区分） */
      routeMissing: status === 404 && /Route POST:/i.test(text),
      timeout: /^超时/.test(error),
    };
  };

  /* 第一发用调用方给的词（缺省随机取一个），非 200 就**换一个词再测一发**（只重试一次） */
  const first = String(wd || '').trim() || pickProbeWord();
  const attempts = [await callSearch(first)];
  if (!attempts[0].ok) attempts.push(await callSearch(pickProbeWord(first)));

  const last = attempts[attempts.length - 1];
  const tries = attempts.length;
  siteStats.recordSpeed(sourceId, siteKey, Object.assign({}, last, { tries }));

  return {
    ok: true,
    source: sourceId,
    key: siteKey,
    name: row.name,
    timeoutMs: timeout,
    initCalled,
    search: Object.assign({}, last, { tries }),
    attempts,
    stat: siteStats.view(sourceId, siteKey),
  };
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
  probeSearch,
  SPEED_TEST_TIMEOUT_MS,
  PROBE_WORDS,
};
