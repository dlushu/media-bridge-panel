'use strict';
/**
 * 片名清洗 + 打分 —— 聚合层判定"这条是不是目标作品"的**唯一判据**。
 *
 * ## 设计取舍：为什么不用 TMDB 反查
 * 早期实现为"名字完全相等，否则将候选名交给 TMDB 反查 tmdbId"。失败点在输入侧：
 * 源标题通常含更新话术与画质标注（如「斗破苍穹年番4更211[2025][动漫]」「…4K臻彩中字【1GB/集】更211集」），
 * 这种名字直接用于检索无法命中 ⇒ 同名 0、回退 0 ⇒ 不返回任何线路（Emby 中表现为"条目在、点开没版本"）。
 * 同一部片在别的源里叫「斗破苍穹年番」时却能命中 —— 差别只在名字是否含噪声。
 * 因此**不猜、不外求**：先清洗名字（`cleanTitle`），再用一套**可解释的分数**判定同一部片。
 *
 * ## 分怎么算（三项加权，缺的项**不进分母**）
 *   名字 0.7 · 季集 0.2 · 年份 0.1
 *   分数 = Σ(权重 × 分项分) / Σ(有权重的分项)，只统计**拿得到值**的项。
 * ⚠️ 缺项不进分母是刻意的：源里常常没有季集/年份信息，若按"缺=0"算，一个名字完全对上的条目
 * 也会被拉到 0.7 以下，那就只能把阈值调到很低 —— 等于没有阈值。见 docs/emby-compat.md。
 *
 * ## 两道闸门（顺序很重要）
 *   ① **名字硬拒**（`nameScore` 的 reject）：清洗后**没有公共主干**、或相似度 < 0.5 → 直接出局。
 *      这是拦「斗破苍穹4：逃亡」「斗破苍穹之少年归来」那种"看着像、不是同一部"的真闸门。
 *   ② **分数线**（`select` 的 minScore）：可关（填 0）—— 关掉就是"按分数排名取前 N 条"。
 * ⚠️ 分数只有 0~1，**列表里谁排前面**看分数；"进不进版本列表"看①+②。
 *
 * ## 拿不到的东西（别在这里指望）
 * 源 `/search` 的条目**只有** `vod_id / vod_name / vod_pic / vod_remarks` —— **没有类型、没有年份**。
 * 所以"电影/剧"这种**类型硬拒在搜索阶段做不了**（协议里连 `/detail` 都没类型字段）；
 * 年份只能从**标题里的四位数字**猜（`[2025]`、`(2026)`、`斗破苍穹2018`），猜不到就当没有这项信号。
 */

const { normName } = require('../../core/catpaw');

/* ---------------------------------------------------------------- 词表 */

/**
 * **噪声**：直接删掉，删了不影响"这是哪部片"。分四类，都用词表/正则写明（不用"看着像就删"的启发式）。
 */
/**
 * **更新话术**（`更211` / `更新至211集` / `全24集` / `共12集`）：既要从"干净名字"里删掉，
 * 又是给季集分用的信号 —— 所以**只在这里定义一次**，清洗与打分共用，避免两边各写一份慢慢跑偏
 * （已知案例：`更211` 少了"集"字，清洗侧没删、打分侧没抽，条目被判成"相似 0.53"出局）。
 */
const EP_MARK_RE = /(?:更新至|更|全|共)\s*(\d+)\s*(?:集|话|期)?/g;

/**
 * **单集条目**（`斗破苍穹第166集`、`斗破苍穹EP14`）：一条 = 一集。它不是"这部片"，
 * 但当请求正是那一集时可用（见 `episodeScore`）。⚠️ 必须单独认出来：这种标题清洗后
 * 和片名**一模一样**，不认的话它会拿满分把"整部片"挤出前 N（已知案例：`第166集/第165集` 顶掉整部片）。
 */
const SINGLE_EP_RE = /第\s*(\d+)\s*(?:集|话|期)|ep\s*(\d+)/gi;

/** **体积/码率标注**（`1GB/集`、`800MB`、`4.2G`）—— 网盘分享标题里很常见，不是片名的一部分 */
const SIZE_RE = /[\d.]+\s*(?:TB|GB|MB|KB)(?:\s*\/?\s*集)?|[\d.]+\s*(?:G|M)\s*\/\s*集/gi;

const NOISE_RE = [
  EP_MARK_RE,
  SINGLE_EP_RE,
  SIZE_RE,
  /已?\s*完结/g,
  /连载中?/g,
  /周更/g,
  /* 画质/字幕/语言这类 */
  /\d{3,4}\s*[pPkK]/g,
  /\b(?:4K|8K|2K|HD|FHD|UHD|MAX|HDR|BluRay|WEB-?DL)\b/gi,
  /(?:超清|高清|蓝光|原画|臻彩|高码|中字|字幕|内嵌|外挂|双语|国语|粤语|多音轨)/g,
  /* 分类/形态后缀（"国漫""动漫"这种不是片名的一部分）。
   * ⚠️ **"特别篇/剧场版/电影版"绝不能进这张表**：它们是**区分作品的词** ——
   * 剥掉之后「斗破苍穹特别篇」清洗成「斗破苍穹」→ 判成**完全相同**拿 1.0 排到第一，
   * 而它内容只有 2 集特别篇 ⇒ 正是"**同名反而匹配错**"的典型来源。
   * 只剥"同一部片的发布形态"（抢先/偷跑/重制/修复/加更）与"这一条属于哪个大类"（动漫/国漫/动画/电视剧）。 */
  /(?:动漫|国漫|动画|电视剧|抢先版|偷跑|重制版?|修复版?|加更版?)/g,
  /* 网盘名（有时写进标题，更多时候在 vod_remarks） */
  /(?:夸克|百度|UC|迅雷|阿里|天翼|移动|光鸭|123|115|115网盘)/g,
  /* 空格类分隔符 —— 清理完再统一压掉 */
  /[·・,，。:：;；!！?？'"“”‘’\-_—~～、/\\|+*&#@%$^]+/g,
];

/**
 * **括号段**：里面的内容命中噪声 / 只是年份 / 只是符号 → 整段删；
 * 否则**保留**（`（上）`、`（第一部）` 这种是片名的一部分，删了会把两部片认成同一部）。
 */
function stripBrackets(s) {
  return String(s || '').replace(/[（(【\[]\s*([^）)】\]]*?)\s*[）)】\]]/g, (m, inner) => {
    const t = String(inner || '').trim();
    if (!t) return '';
    if (/^\d{4}$/.test(t)) return '\u0001' + t + '\u0001'; // 年份：留着给打分抽，但不进"干净名字"
    if (isNoiseOnly(t)) return '';
    return t;
  });
}

/** 这段文字去掉噪声后还剩下东西吗（剩下=不是纯噪声） */
function isNoiseOnly(s) {
  let t = String(s || '');
  for (const re of NOISE_RE) t = t.replace(re, '');
  return !t.replace(/[\s\d]+/g, '');
}

/**
 * 清洗后的"主干"（给名字分用；`\u0001` 里包的是年份，会在这里被剥掉）。
 * 最后一步把**非中英数字**的符号一律去掉 —— 源很喜欢在名字前面挂 emoji/图标
 * （`🎬斗破苍穹(2017)`、`🗄斗破苍穹年番…`），不清掉就变成"相似 0.82"被分数线挡在门外。
 */
function cleanTitle(raw) {
  let s = stripBrackets(normNameForClean(raw));
  s = s.replace(/\u0001\d{4}\u0001/g, '');
  for (const re of NOISE_RE) s = s.replace(re, '');
  return s.replace(/[^\u4e00-\u9fffa-zA-Z0-9]+/g, '').trim();
}

/* 清洗阶段要保留括号结构，所以先做一次"温和"归一（去空格、去大部分标点），而不是直接用 normName */
function normNameForClean(raw) {
  return String(raw || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[：:；;，,。！!？?]/g, '');
}

/**
 * **受控限定词**：允许"目标名 + 这些"仍然算同一部（`斗破苍穹` + `年番`）。
 * ⚠️ 只列**季/续作**性质、且**不会指另一部作品**的词。像"剧场版/外传/特别篇/Q版"这类
 * **可能是另一部作品**，一律不列 —— 它们会走相似度那条路，够不上阈值就出局。
 */
const QUALIFIER_RE = /^(?:年番|新番|第[一二三四五六七八九十百\d]+季|season\d+|\d+季|\d{4}|\d+)+$/;

/* ---------------------------------------------------------------- 提取信号 */

/** 从名字与简介里抽：主干、年份、季号、更新到第几集 */
function extractSignals(vodName, vodRemarks) {
  const raw = String(vodName || '');
  const rem = String(vodRemarks || '');
  const both = raw + ' ' + rem;

  let year = null;
  const ym = raw.match(/[（(【\[]\s*(\d{4})\s*[）)】\]]/) || raw.match(/(?:^|[^\d])((?:19|20)\d{2})(?:[^\d]|$)/);
  if (ym) year = Number(ym[1]);

  let season = null;
  const sm =
    raw.match(/第\s*([一二三四五六七八九十百\d]+)\s*季/) || raw.match(/season\s*(\d+)/i) || raw.match(/(?:^|\D)(\d+)\s*季/);
  if (sm) {
    const n = cnNum(sm[1]);
    if (Number.isFinite(n) && n > 0 && n < 100) season = n;
  }

  let latestEp = 0;
  const em = new RegExp(EP_MARK_RE.source, 'g');
  let m;
  while ((m = em.exec(both))) latestEp = Math.max(latestEp, Number(m[1]) || 0);

  let singleEp = 0;
  const sm2 = new RegExp(SINGLE_EP_RE.source, SINGLE_EP_RE.flags);
  while ((m = sm2.exec(raw))) singleEp = Number(m[1] || m[2]) || singleEp;

  return { clean: cleanTitle(raw), year, season, latestEp, singleEp };
}

/** 中文数字（够用即可：一二三…十、十一、二十…一百） */
function cnNum(s) {
  const t = String(s || '').trim();
  if (/^\d+$/.test(t)) return Number(t);
  const d = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (t === '十') return 10;
  let n = 0;
  const parts = t.split('十');
  if (parts.length === 2) {
    n = (parts[0] ? d[parts[0]] || 0 : 1) * 10 + (parts[1] ? d[parts[1]] || 0 : 0);
    return n || null;
  }
  for (const ch of t) {
    if (!d[ch]) return null;
    n = n * 10 + d[ch];
  }
  return n || null;
}

/* ---------------------------------------------------------------- 三个分项 */

/** 最长公共子序列（名字都短，DP 够用；不引第三方库） */
function lcsLen(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n || !m) return 0;
  let prev = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    const cur = new Array(m + 1).fill(0);
    for (let j = 1; j <= m; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[m];
}

/**
 * 名字分（0~1）。`reject: true` = **出局**（不是"分低"，是"根本不是一部片"）。
 * 分档：完全相同 1.0 › 主干同名 + 受控限定词 0.95 › 相似度（0.5~1）
 */
function nameScore(wantName, candidateName) {
  const w = normName(wantName);
  const c = normName(cleanTitle(candidateName));
  if (!w) return { score: 0, why: '目标名为空', reject: true };
  if (!c) return { score: 0, why: '候选名清不出主干', reject: true };
  if (c === w) return { score: 1, why: '同名' };
  if (c.startsWith(w) && QUALIFIER_RE.test(c.slice(w.length))) return { score: 0.95, why: '主干同名+限定词' };
  if (w.startsWith(c) && QUALIFIER_RE.test(w.slice(c.length))) return { score: 0.95, why: '候选名是主干+限定词' };

  const lcs = lcsLen(w, c);
  if (lcs < 2 || lcs < 0.5 * Math.min(w.length, c.length)) {
    return { score: 0, why: `无公共主干（LCS=${lcs}）`, reject: true };
  }
  const sim = (2 * lcs) / (w.length + c.length);
  if (sim < 0.5) return { score: sim, why: `相似度过低 ${sim.toFixed(2)}`, reject: true };
  return { score: sim, why: `相似 ${sim.toFixed(2)}（LCS=${lcs}）` };
}

/** 季集分（拿不到 → null，表示"这项没信号"，不进分母） */
function episodeScore(want, sig) {
  const parts = [];
  /* 单集条目（`斗破苍穹第166集`）：只有请求的正是那一集才算能用。
   * 为什么必须单独判：这种标题清洗后**和片名一模一样**，不判的话它会拿满分把
   * "整部片"的条目挤出前 N（实测：`斗破苍穹第166集/第165集` 三条把虎斑/木偶的
   * `斗破苍穹年番` 全顶掉，而它们各自只有一集，S5E211 一条都定位不到）。 */
  if (sig.singleEp) {
    const want_ = Number(want.episode) || 0;
    parts.push(
      want_ && want_ === sig.singleEp
        ? { score: 1, why: `单集条目，正是 E${sig.singleEp}` }
        : { score: 0, why: `单集条目（第 ${sig.singleEp} 集）` }
    );
  }
  if (want.episode && sig.latestEp) {
    parts.push(
      want.episode <= sig.latestEp
        ? { score: 1, why: `已更到 ${sig.latestEp} ≥ E${want.episode}` }
        : { score: 0, why: `只更到 ${sig.latestEp}（要 E${want.episode}）` }
    );
  }
  if (want.season && sig.season) {
    parts.push(
      want.season === sig.season
        ? { score: 1, why: `S${sig.season} 一致` }
        : { score: 0, why: `季不同（标题 S${sig.season} ≠ S${want.season}）` }
    );
  }
  if (!parts.length) return null;
  return { score: parts.reduce((a, x) => a + x.score, 0) / parts.length, why: parts.map((x) => x.why).join('；') };
}

/** 年份分（拿不到 → null）。差 1 年算 0.6（跨年首播常见），差 ≥2 年不给分 */
function yearScore(wantYear, sig) {
  const w = Number.parseInt(wantYear, 10);
  if (!Number.isFinite(w) || w <= 0 || !sig.year) return null;
  const d = Math.abs(sig.year - w);
  if (d === 0) return { score: 1, why: `年份一致 ${w}` };
  if (d === 1) return { score: 0.6, why: `年份差 1 年（${sig.year} vs ${w}）` };
  return { score: 0, why: `年份差 ${d} 年（${sig.year} vs ${w}）` };
}

/* ---------------------------------------------------------------- 总分与挑选 */

/* 权重写在这里一处。名字是大头；季集是"能不能定位到这一集"的信号；年份最弱 ——
 * 刻意压低（斗破苍穹 S1 是 2017、年番 S5 是 2025，硬比年份会误杀）。 */
const W = { name: 0.7, ep: 0.2, year: 0.1 };

/**
 * 把 `want` 的数字项归一化成数字。
 *
 * **调用方可能给字符串**：网页输入框的 `input.value` 就是字符串，所以 `season: "1"` 会原样传到这里，
 * 而判季号用的是**严格相等**（`want.season === sig.season`）—— `"1" === 1` 为 false，
 * 于是所有条目都被判成"季不同"、季集分归 0、总分掉到 0.739 被分数线淘汰
 * （实测：网页上填了「季」就一条都不命中）。
 * 归一化放在判据入口一次，网页 / 客户端 / 外部接口都不会再踩；空值与非数字一律当作"没这个信号"，
 * 与"源里没有季集信息"走同一条路（缺项不进分母）。
 */
function normWant(want) {
  const w = Object.assign({}, want || {});
  for (const k of ['season', 'episode']) {
    const v = w[k];
    if (v === undefined || v === null || v === '') {
      delete w[k];
      continue;
    }
    const n = Number(v);
    if (Number.isFinite(n)) w[k] = n;
    else delete w[k];
  }
  return w;
}

/**
 * 给一个条目打分。`want`：`{ name, year, season, episode }`。
 * 返回 `{ score, rejected, reason, parts, signals }` —— `parts` 里逐项写着"为什么是这个分"，
 * 面板上要显示它（可解释性是这套算法的前提，别把理由丢掉）。
 */
function scoreItem(want, item) {
  const sig = extractSignals(item && item.vod_name, item && item.vod_remarks);
  const name = nameScore(want && want.name, item && item.vod_name);
  if (name.reject) {
    return { score: 0, rejected: true, reason: name.why, parts: { name }, signals: sig };
  }
  const parts = { name };
  const ep = episodeScore(want || {}, sig);
  if (ep) parts.ep = ep;
  const year = yearScore(want && want.year, sig);
  if (year) parts.year = year;

  let num = W.name * name.score;
  let den = W.name;
  if (parts.ep) {
    num += W.ep * parts.ep.score;
    den += W.ep;
  }
  if (parts.year) {
    num += W.year * parts.year.score;
    den += W.year;
  }
  const score = den ? num / den : 0;
  return {
    score,
    rejected: false,
    reason: Object.entries(parts)
      .map(([k, v]) => `${k}:${v.score.toFixed(2)}(${v.why})`)
      .join(' + '),
    parts,
    signals: sig,
  };
}

/**
 * 从一堆条目里挑出目标作品，**命中/失败分成两桶**（失败项也要可见）。
 *
 * `minScore` = 0（或空）→ **不做分数线筛选**，只按分数排名取前 `maxItems` 条；
 * `minScore` > 0 → 先卡分数线，再取前 `maxItems`。
 * `maxItems` = 0 → 不封顶。
 * 返回的条目都带 `score` / `reason` / `parts` / `signals`，顺序 = 分数降序（同分保持输入顺序）。
 */
function select(items, want, { minScore = 0, maxItems = 0, unmatchedMax = 20 } = {}) {
  const min = Number(minScore) > 0 ? Number(minScore) : 0;
  const cap = Number(maxItems) > 0 ? Math.floor(Number(maxItems)) : 0;
  /* 判据入口统一把 want 的数字项转成数字（调用方可能给字符串，见 normWant） */
  const w = normWant(want);

  const scored = (items || []).map((it) => ({ item: it, m: scoreItem(w, it) }));

  /* ⚠️ **不做"同站同名只留一条"那种去重**（该做法已否决）：
   * 理由是"去重会把该留的挑掉" —— 同名的几条各有自己的 `vod_id`，谁真能播只有取过 detail 才知道，
   * 按分数猜一条留、把别的丢掉，就会出现"**同名反而匹配错**"。所以：**源给了几条就算几条**，
   * 只数一下（`counts.sameNameSameSite`，用于展示"这个站挂了多少条同名"），不排除任何一条。 */
  const alive = scored.filter((x) => !x.m.rejected).sort((a, b) => b.m.score - a.m.score);
  const passed = min > 0 ? alive.filter((x) => x.m.score >= min) : alive;

  const hitList = cap > 0 ? passed.slice(0, cap) : passed;
  const overCap = passed.slice(hitList.length).map((x) => ({
    item: x.item,
    score: x.m.score,
    reason: min > 0 ? `分数 ${x.m.score.toFixed(2)} 排名在 ${cap} 名之后` : `按分数排名超出前 ${cap} 条`,
  }));
  const belowLine = min > 0 ? alive.filter((x) => x.m.score < min).map((x) => ({
    item: x.item,
    score: x.m.score,
    reason: `分数 ${x.m.score.toFixed(2)} < 分数线 ${min}`,
  })) : [];
  const rejected = scored.filter((x) => x.m.rejected).map((x) => ({ item: x.item, score: 0, reason: x.m.reason }));

  /* `all` = **每一条**都带上分数与去留（调用方要把它写回响应里的每个条目，web 才能逐条显示
   * "命中 0.95 / 没进 0.72（为什么）"）。`unmatched` 只是它的**截断版**（回传给前端展示用），
   * 两者别混：`all` 不设上限，是内存里的一份标注。 */
  const reasonOf = new Map();
  for (const x of overCap.concat(belowLine, rejected)) reasonOf.set(x.item, x.reason);
  const hitSet = new Set(hitList.map((x) => x.item));
  const all = scored.map((x) => ({
    item: x.item,
    score: x.m.score,
    hit: hitSet.has(x.item),
    reason: hitSet.has(x.item) ? x.m.reason : reasonOf.get(x.item) || '',
  }));

  return {
    matched: hitList.map((x) => ({ item: x.item, score: x.m.score, reason: x.m.reason, parts: x.m.parts, signals: x.m.signals })),
    unmatched: overCap.concat(belowLine, rejected).slice(0, Math.max(0, Number(unmatchedMax) || 0)),
    /* `ranked` = **过了硬闸门、按分数降序的全部条目**（不截断）。给"接续补打"用：
     * 前 N 条取详情一条都没命中时，按这个顺序继续往下打。见 `service.aggregateDetail`。 */
    ranked: alive.map((x) => ({ item: x.item, score: x.m.score, reason: x.m.reason })),
    all,
    counts: {
      scanned: scored.length,
      matched: hitList.length,
      overCap: overCap.length,
      belowLine: belowLine.length,
      /* 只是**数一下**"同一个站里有多少条同名"（用于展示这个站挂了多少条），**不排除任何一条** */
      sameNameSameSite: sameNameSameSiteCount(scored),
      rejected: rejected.length,
      minScore: min,
      maxItems: cap,
    },
  };
}

/**
 * 同一个站里"主干同名"的**条数**（只统计，不排除）—— `[{site, key, source}]` 里出现 >1 次就算同名。
 * ⚠️ 它**不参与筛选**：同名几条各有自己的 `vod_id`，谁能播要取过 detail 才知道，
 * 按分数猜着丢一条正是"同名反而匹配错"的来源（去重做法已明确否决）。
 */
function sameNameSameSiteCount(scored) {
  const seen = new Map();
  let extra = 0;
  for (const x of scored) {
    if (x.m.rejected) continue;
    const it = x.item || {};
    const k = [it.source || '', it.siteKey || it.site || '', normName(cleanTitle(it.vod_name))].join('\u0001');
    if (seen.has(k)) extra += 1;
    else seen.set(k, 1);
  }
  return extra;
}

module.exports = { cleanTitle, extractSignals, nameScore, episodeScore, yearScore, scoreItem, select, normWant, W, QUALIFIER_RE };
