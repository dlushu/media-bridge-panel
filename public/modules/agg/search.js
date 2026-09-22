'use strict';
/**
 * 聚合模块 · 「聚合搜索」页：一个关键字并发打多源多站，结果按站点顺序拼接（不去重）。
 * 两种结果显示：合并视图（renderMerged）与分站诊断（renderBySite）。
 *
 * **打分匹配**：搜索这一步就给每条结果打分（口径见 `server/modules/agg/match.js`）：
 *   · 搜索行里带**季 / 集 / 年份**（都是"要哪一部"的坐标，与关键字一样属于搜索参数）；
 *   · 每条结果上标 `命中 0.95` / `没进 0.72（为什么）`，命中的左边有一道高亮；
 *   · 「这条的版本」→ 拿 `source+site+vodId` 走快路径调 `detail`，**弹窗**显示客户端会看到什么
 *     （线路 N · 定位到这一集 M、逐条线路的定位情况）。
 *     弹窗里**逐条标出「线路过滤」与「定位」的结论**，并在没填集号时明说"没做定位"、
 *     给一个「按第 1 项重查」（电影在客户端就是按第 1 项取的）—— 早先那句"不会进客户端的版本列表"
 *     在没填集号时并不成立，会让用户误以为"拿不到版本"。
 *
 * 布局上的取舍：搜索参数与按钮同一行；打分旋钮另起一行；
 * 结果里**命中的排前面、长列表折叠**；不单列"匹配失败"卡片（合并视图里每条都写着"没进 + 原因"）；
 * 版本详情**弹窗**显示，而不是追加到页面最底部（追加在最底部时不易发现）。
 */
import { el, toast, modal, codeBlock } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { S } from '../../core/state.js';
import { ensureAggSites, ensureAggSources } from '../../core/store.js';
import { switchPage, renderPage } from '../../core/shell.js';

/** 一个站超过这么多条就先折叠，点「展开」再看（一个站挂上百条同名很常见） */
const FOLD_AT = 12;

export function renderAgg(v) {
  const agg = (S.settings && S.settings.agg) || { enabled: [], timeoutMs: 12000, concurrency: 8 };

  const wdInput = el('input', { type: 'text', placeholder: '搜索关键字，例如：斗破苍穹', value: S.aggKeyword, spellcheck: 'false' });
  wdInput.addEventListener('input', () => (S.aggKeyword = wdInput.value));
  wdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') run();
  });
  const pageInput = el('input', { type: 'number', class: 'w-xs', value: S.aggPage, min: '1' });
  pageInput.addEventListener('input', () => (S.aggPage = pageInput.value));
  const useAllCb = el('input', { type: 'checkbox', checked: S.aggUseAll });
  useAllCb.addEventListener('change', () => {
    S.aggUseAll = useAllCb.checked;
    renderPage();
  });

  /* ---- 打分用的输入（默认值取「聚合设置」里那两个；页面上改只影响这一次请求）---- */
  const defaults = { minScore: agg.matchMinScore === undefined ? 0.85 : agg.matchMinScore, maxItems: agg.matchMaxItems === undefined ? 3 : agg.matchMaxItems };
  /* 宽度档位见 style.css 的 `.chk > input.w-*`：季/集/年份只要小框（w-xs），
   * 分数与条数要能看全 `0.85` / `15` 这种值（w-md）—— 编辑框太小时数值显示不全。 */
  const numInput = (key, fallback, min, max, title, cls) => {
    const cur = S[key] === undefined || S[key] === null ? fallback : S[key];
    const inp = el('input', { type: 'number', class: cls || 'w-sm', value: String(cur), min: String(min), max: String(max), title: title || '' });
    inp.addEventListener('input', () => (S[key] = inp.value));
    return inp;
  };
  const seasonInput = numInput('aggSeason', '', 0, 99, '打分用：源里的集名大多是扁平集号，通常只填「集」就够', 'w-xs');
  const episodeInput = numInput('aggEpisode', '', 0, 9999, '打分用：想让这一集"能定位到"就必须填它（客户端是按 TMDB 的季集号来要片子的）', 'w-xs');
  const yearInput = numInput('aggYear', '', 1900, 2100, '打分用：年份权重最低（0.1），填错也不会一票否决', 'w-xs');
  const minScoreInput = numInput(
    'aggMinScore',
    defaults.minScore,
    0,
    1,
    '打分 ≥ 它的才算命中。填 0 = 不过滤分数线（只按分数排名取前 N 条）。权重：名字 0.7 · 季集 0.2 · 年份 0.1（缺的项不计）',
    'w-md'
  );
  const maxItemsInput = numInput('aggMaxItems', defaults.maxItems, 1, 20, '最多留几条命中（想要几条能用的）。每多留一条，后面要多打一次站源 /detail 取链（多 = 慢）', 'w-md');

  const num = (inp) => (inp.value === '' ? undefined : inp.value);

  async function run() {
    const wd = wdInput.value.trim();
    if (!wd) return toast('请输入关键字', true);
    /* 源清单是**「源列表」页负责拉的** —— 直接打开/刷新本页时它是空的，
     * 早先这里一句"还没有源"就挡住了页面（刷新后无法搜索）。
     * `/api/agg/sources` 不探测、几毫秒，补一次就行。 */
    if (!(S.aggSources || []).length) {
      try {
        await ensureAggSources();
      } catch (e) {
        return toast('拿源清单失败：' + e.message, true);
      }
    }
    if (!(S.aggSources || []).length) return toast('还没有源：先部署一个猫源，或到「聚合 · 源列表」填一个外部地址', true);
    if (S.aggUseAll) await ensureAggSites();
    const keys = S.aggUseAll ? S.aggSites.filter((s) => s.searchable).map((s) => ({ source: s.source, key: s.key })) : null;
    if (!S.aggUseAll && !agg.enabled.length) return toast('没有勾选参与聚合的站点，请去「聚合 · 站点与参数」勾选', true);
    if (S.aggUseAll && !keys.length) return toast('拿不到可搜索站点列表，请先在「聚合 · 站点与参数」刷新', true);
    S.aggBusy = true;
    S.aggResult = { loading: true, wd, keyCount: keys ? keys.length : agg.enabled.length };
    renderPage();
    try {
      const r = await api('/api/agg/search', {
        method: 'POST',
        body: {
          wd,
          page: pageInput.value || '1',
          keys: keys || undefined,
          /* 空字符串 = 没给（后端读设置里的默认值）。只有"最低分填 0"是**有意义的**：
           * 那表示不按分数线筛，只按分数排名取前 N 条。 */
          season: num(seasonInput),
          episode: num(episodeInput),
          year: num(yearInput),
          minScore: num(minScoreInput),
          maxItems: num(maxItemsInput),
        },
      });
      S.aggResult = r;
    } catch (e) {
      S.aggResult = { error: e.message, wd };
    } finally {
      S.aggBusy = false;
      renderPage();
    }
  }

  /**
   * 「这条的版本」：拿 `source+site+vodId` 走**快路径**调 `/api/agg/detail`（跳过搜索），
   * 结果**弹窗**显示 —— 而不是追加到页面最底部（追加在最底部时不易发现）。
   * 看到的形状就是 **Emby 客户端点开这条时拿到的**那份（同一条链）。
   *
   * 季/集就取搜索行里填的那两个；**没填集号时不做定位**（弹窗里会明说，并给「按第 1 项重查」——
   * 电影在客户端那边就是按第 1 项取的；不写清这一点，用户会看到"没定位到"而误以为没有版本）。
   * 同时把「线路过滤」（`agg.json` 的 `lineFilter`，只匹配线路名）的结果也标出来：过滤**只作用在
   * 客户端那侧的版本列表**，弹窗给的是原始线路 —— 所以必须标出来，否则看着像"过滤没生效"。
   */
  async function showItemVersions(m, se, ep) {
    const useSeason = se === undefined ? num(seasonInput) : se;
    const useEpisode = ep === undefined ? num(episodeInput) : ep;
    try {
      /* 过滤规则与详情一起拿（两个请求并发；规则读的是模块端点 —— 权威那份） */
      const [d, st] = await Promise.all([
        api('/api/agg/detail', {
          method: 'POST',
          body: { source: m.source, site: m.siteKey, vodId: m.vod_id, season: useSeason, episode: useEpisode },
        }),
        api('/api/modules/agg/settings').catch(() => null),
      ]);
      const raw = String(((st && st.settings) || {}).lineFilter || '').trim();
      let re = null;
      try {
        if (raw) re = new RegExp(raw, 'i');
      } catch {
        re = null; // 规则坏了 → 按"不过滤"显示（后端运行时也是这个兜底）
      }
      openVersionsModal(`${m.siteName || m.siteKey} · ${m.vod_name || ''}`, d, {
        asked: useEpisode !== undefined && useEpisode !== null && useEpisode !== '',
        filterRaw: raw,
        filterRe: re,
        onRetryFirst: () => showItemVersions(m, 1, 1),
      });
    } catch (e) {
      toast('取版本失败：' + e.message, true);
    }
  }

  /* 搜索行：**关键字 + 季/集/年份 + 页 + 按钮**全是"这次要搜什么"的参数，摆在一起。
   * （季集年份曾是按钮下面单独一行；它们与关键字同属搜索参数，放在搜索按钮之前更贴合语义。） */
  const searchRow = el(
    'div',
    { class: 'toolbar' },
    wdInput,
    el('label', { class: 'chk', title: seasonInput.getAttribute('title') }, seasonInput, '季'),
    el('label', { class: 'chk', title: episodeInput.getAttribute('title') }, episodeInput, '集'),
    el('label', { class: 'chk', title: yearInput.getAttribute('title') }, yearInput, '年份'),
    el('button', { class: 'btn primary', text: S.aggBusy ? '聚合中…' : '聚合搜索', disabled: S.aggBusy, onclick: run })
  );

  /* 打分旋钮与范围：低频，另起一行 */
  const optRow = el(
    'div',
    { class: 'toolbar' },
    el('label', { class: 'chk', title: minScoreInput.getAttribute('title') }, minScoreInput, '最低分'),
    el('span', { class: 'note', text: '0 = 不过滤分数线' }),
    el('label', { class: 'chk', title: maxItemsInput.getAttribute('title') }, maxItemsInput, '最多几条'),
    el('label', { class: 'chk' }, pageInput, '页'),
    el('label', { class: 'chk', title: '忽略勾选，改用「站点与参数」里标了"可搜索"的全部站点' }, useAllCb, '全量站点'),
    el('span', { class: 'spacer' }),
    el('button', { class: 'btn mini', text: '站点与参数', onclick: () => switchPage('agg-sites') })
  );

  if (!S.aggResult) {
    v.append(searchRow, optRow, el('div', { class: 'muted', text: '输入关键字开始聚合搜索。季/集/年份用来给结果打分（想让某一集能定位到，就把集号填上）。' }));
    return;
  }
  if (S.aggResult.loading) {
    v.append(searchRow, optRow, el('div', { class: 'muted', text: `正在并发搜索 ${S.aggResult.keyCount || agg.enabled.length} 个站源…` }));
    return;
  }
  if (S.aggResult.error) {
    v.append(searchRow, optRow, el('div', { class: 'hint warn', text: '聚合失败：' + S.aggResult.error }));
    return;
  }

  const r = S.aggResult;
  const stats = r.stats;
  const missed = r.match ? Math.max(0, r.match.scanned - r.match.matched) : 0;
  const missTitle = r.match
    ? `没进的原因：低分 ${r.match.belowLine} · 超上限 ${r.match.overCap} · 名字不过闸 ${r.match.rejected}` +
      `（分数线 ${r.match.minScore || '关'}，上限 ${r.match.maxItems || '不封顶'}；同站同名 ${r.match.sameNameSameSite || 0} 条照收）`
    : '';
  const bar = el(
    'div',
    { class: 'toolbar' },
    el('span', { class: 'badge', text: `${stats.ok}站 / ${stats.totalItems || 0}条` }),
    r.match ? el('span', { class: 'badge ok', text: `命中 ${r.match.matched}`, title: '会被用来取版本的那几条（≤ 最多几条）' }) : null,
    missed ? el('span', { class: 'badge', title: missTitle, text: `没进 ${missed}` }) : null,
    stats.failed ? el('span', { class: 'badge err', text: `${stats.failed}站失败` }) : null,
    el('span', { class: 'badge', text: `${r.elapsedMs} ms` }),
    el('span', { class: 'spacer' }),
    el('button', { class: 'btn mini' + (S.aggView === 'merged' ? ' active' : ''), text: '合并视图', onclick: () => { S.aggView = 'merged'; renderPage(); } }),
    el('button', { class: 'btn mini' + (S.aggView === 'sites' ? ' active' : ''), text: '分站诊断', onclick: () => { S.aggView = 'sites'; renderPage(); } })
  );

  v.append(searchRow, optRow, bar);
  if (S.aggView === 'merged') renderMerged(v, r, showItemVersions);
  else renderBySite(v, r);
}

/**
 * 版本弹窗：`detail` 的返回里，每站「线路 N · 定位到这一集 M」+ 逐条线路的定位情况。
 *
 * `opts`：
 *   · `asked`     —— 这次请求**有没有带集号**。没带就**没做定位**，此时不能说"不会进客户端的版本列表"
 *                    （该说法不成立：客户端对电影是按"第 1 项"取的）。
 *   · `filterRaw` / `filterRe` —— 「线路过滤」规则（只匹配线路名）。**过滤只在客户端那侧生效**
 *                    （`emby/service.js` 拼版本列表时），弹窗给的是原始线路 ⇒ 得逐条标出来。
 *   · `onRetryFirst` —— 「按第 1 项重查」的回调（电影用）。
 */
function openVersionsModal(title, d, opts = {}) {
  const sites = d.sites || [];
  const body = [];
  if (!sites.length) {
    body.push(el('div', { class: 'muted', text: '这次没有站点返回（条目取不到 / 站点失败，看面板日志）。' }));
  }
  /* 没填集号：把"为什么全是没定位到"和"怎么重查"先说清楚 */
  if (!opts.asked) {
    body.push(
      el(
        'div',
        { class: 'hint' },
        '⚠️ 这次没填「集」，所以没做定位 —— 下面每条线路都会显示"没定位到"，那不代表客户端也拿不到。',
        el('br'),
        '电影在客户端那边是按「第 1 项」取的，点下面那个按钮就能照客户端的方式重查；剧集请把集号填上。',
        el('br'),
        opts.onRetryFirst
          ? el('button', { class: 'btn mini primary ml-sm', text: '按第 1 项重查（电影）', onclick: () => opts.onRetryFirst() })
          : null
      )
    );
  }
  if (opts.filterRaw) {
    body.push(
      el('div', {
        class: 'note',
        text:
          `线路过滤 /${opts.filterRaw}/ 生效中：只有匹配的线路会进客户端的版本列表。` +
          '这份弹窗显示的是原始线路（不过滤），下面每条会标出它"进不进"。',
      })
    );
  }
  for (const s of sites) {
    const box = el('div', { class: 'site-group' });
    const entries = [];
    if (s.detail) entries.push({ label: '', det: s.detail });
    for (const v of s.variants || []) if (v && v.detail) entries.push({ label: v.label || '', det: v.detail });
    const allLines = entries.reduce((a, e) => a.concat(e.det.lines || []), []);
    const kept = allLines.filter((l) => !opts.filterRe || opts.filterRe.test(String(l.flag || '')));
    const tgtAll = kept.filter((l) => l.target).length;

    box.append(
      el(
        'div',
        { class: 'site-head' },
        el('span', { class: 'dot ' + (s.detail ? 'running' : 'error') }),
        el('span', { class: 'chip tag', text: (s.sourceName ? s.sourceName + ' · ' : '') + (s.name || s.key) }),
        s.detail
          ? opts.asked
            ? el('span', { class: 'badge' + (tgtAll ? ' ok' : ''), text: `进客户端版本列表 ${tgtAll} 条线路` })
            : el('span', { class: 'badge', text: `线路 ${allLines.length}（没填集号，未定位）` })
          : el('span', { class: 'badge err', text: s.error || '这条没取到详情' })
      )
    );
    for (const e of entries) {
      if (e.label) box.append(el('div', { class: 'note', text: `变体 · ${e.label}` }));
      const lines = e.det.lines || [];
      if (!lines.length) {
        if (!e.label) box.append(el('div', { class: 'muted', text: '这条没有线路（`lines: []`）。' }));
        continue;
      }
      for (const l of lines) {
        const dropped = !!opts.filterRe && !opts.filterRe.test(String(l.flag || ''));
        const inList = !dropped && !!l.target;
        let why;
        if (l.target) {
          why = `✔ 定位到：${l.target.name}（${l.target.matchedBy || ''}）` +
            (dropped ? ` —— 但线路名不匹配 /${opts.filterRaw}/，不会进客户端的版本列表` : '');
        } else if (dropped) {
          why = `✘ 线路名不匹配 /${opts.filterRaw}/ —— 不会进客户端的版本列表`;
        } else if (!opts.asked) {
          why = '· 这次没填「集」→ 没做定位（点上面的「按第 1 项重查」看客户端那侧的结果）';
        } else {
          why = '✘ 这一集在这条线路里没定位到（不会进客户端的版本列表）';
        }
        box.append(
          el(
            'div',
            { class: 'agg-item' + (inList ? ' matched' : '') },
            el(
              'div',
              { class: 'agg-body' },
              el('div', { class: 'agg-name' }, l.flag || '-', el('span', { class: 'badge ml-sm', text: `${(l.episodes || []).length} 集` })),
              el('div', { class: 'note', text: why })
            )
          )
        );
      }
    }
    body.push(box);
  }
  body.push(el('div', { class: 'note', text: '这份就是 Emby 客户端点开该条目时拿到的形状（detail → 线路 → 定位到这一集）。' }));
  modal({ title: '版本 · ' + title, body, actions: [{ label: '关闭', primary: true }] });
}

function aggNorm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[·・.,，。:：;；!！?？'"“”‘’()（）\[\]【】《》\-_—~～、/\\|+*&#@%$^]/g, '');
}

/** 跨站点统计同名条目数量（仅用于提示，不做合并） */
function aggDupMap(r) {
  const m = new Map();
  for (const entry of r.sites || []) {
    for (const it of (entry.data && entry.data.list) || []) {
      const n = aggNorm(it.vod_name);
      m.set(n, (m.get(n) || 0) + 1);
    }
  }
  return m;
}

function renderMerged(v, r, onVersions) {
  const sites = r.sites || [];
  if (!sites.length) {
    v.append(el('div', { class: 'muted', text: '没有任何站点返回结果。' }));
    return;
  }
  const dupMap = aggDupMap(r);
  v.append(el('div', { class: 'sec-title', text: `结果 · 按 ${sites.length} 个站源分组（命中的排前面，未去重）` }));

  for (const s of sites) {
    const raw = (s.data && s.data.list) || [];
    /* **命中的排前面**（同分保持源里的顺序）—— 一个站挂上百条同名时，
     * 先看到"会被用到的那几条"比看源顺序有用得多（否则长列表显得杂乱）。 */
    const list = raw
      .map((it, i) => ({ it, i }))
      .sort((a, b) => (b.it.matched ? 1 : 0) - (a.it.matched ? 1 : 0) || (b.it.score || 0) - (a.it.score || 0) || a.i - b.i)
      .map((x) => x.it);
    const hitN = raw.filter((x) => x.matched).length;
    const box = el('div', { class: 'site-group' });
    box.append(
      el(
        'div',
        { class: 'site-head' },
        el('span', { class: 'dot ' + (s.ok ? 'running' : 'error') }),
        el('span', { class: 'chip tag', text: (s.sourceName ? s.sourceName + ' · ' : '') + (s.name || s.key) }),
        el('span', { class: 'badge' + (s.ok ? ' ok' : ' err'), text: s.ok ? `${list.length} 条${hitN ? ` · 命中 ${hitN}` : ''} · ${s.ms}ms` : s.error || '失败' }),
        s.http ? el('span', { class: 'badge', text: 'HTTP ' + s.http }) : null
      )
    );

    if (!list.length) {
      box.append(el('div', { class: 'note', text: s.ok ? '无结果' : '请求失败' }));
      v.append(box);
      continue;
    }

    const ul = el('div', { class: 'agg-list' });
    const shown = S.aggFold && S.aggFold[sid(s.source, s.key)] ? list.length : Math.min(list.length, FOLD_AT);
    for (const m of list.slice(0, shown)) {
      const dupN = dupMap.get(aggNorm(m.vod_name)) || 1;
      ul.append(
        el(
          'div',
          { class: 'agg-item' + (m.matched ? ' matched' : '') },
          m.vod_pic
            ? el('img', { class: 'agg-pic', src: m.vod_pic, loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() })
            : el('div', { class: 'agg-pic empty' }),
          el(
            'div',
            { class: 'agg-body' },
            el(
              'div',
              { class: 'agg-name' },
              m.vod_name || '-',
              dupN > 1 ? el('span', { class: 'badge ml-sm', text: `同名 ×${dupN}` }) : null,
              m.score !== undefined
                ? el('span', { class: 'badge ml-sm' + (m.matched ? ' ok' : ''), text: (m.matched ? '命中 ' : '没进 ') + Number(m.score).toFixed(2), title: m.matchReason || '' })
                : null
            ),
            m.vod_remarks ? el('div', { class: 'note', text: m.vod_remarks }) : null,
            /* 没进的写明原因（**合并视图里就能看到，所以不单列一张"匹配失败"卡片**，避免重复） */
            m.score !== undefined && !m.matched ? el('div', { class: 'note', text: '没进原因：' + (m.matchReason || '') }) : null,
            el(
              'div',
              { class: 'agg-sources' },
              el('button', { class: 'chip', text: '原始条目', onclick: (e) => toggleRaw(e.target, m) }),
              m.source && m.vod_id
                ? el('button', { class: 'chip', text: '这条的版本', onclick: () => onVersions(m) })
                : null
            )
          )
        )
      );
    }
    if (list.length > shown) {
      ul.append(
        el('button', {
          class: 'chip',
          text: `展开其余 ${list.length - shown} 条（大多是没进的同名片源）`,
          onclick: () => {
            S.aggFold = Object.assign({}, S.aggFold, { [sid(s.source, s.key)]: true });
            renderPage();
          },
        })
      );
    }
    box.append(ul);
    v.append(box);
  }
}

/** 折叠用的复合键（与后端一致的 `source + \\u0001 + key`） */
function sid(source, key) {
  return `${source}\u0001${key}`;
}

/** 折叠显示「原响应里的这一条」（原封不动） */
function toggleRaw(btn, obj) {
  const parent = btn.closest('.agg-item');
  const old = parent.querySelector('.raw-json');
  if (old) {
    old.remove();
    btn.classList.remove('active');
    return;
  }
  btn.classList.add('active');
  parent.querySelector('.agg-body').append(el('pre', { class: 'json raw-json', text: JSON.stringify(obj, null, 2) }));
}

/** 分站诊断：每站一行成败 + 发出去的请求（**不回显响应体** —— 要看内容去「合并视图」） */
function renderBySite(v, r) {
  const sites = r.sites || [];
  const fallbackBase = (S.base && S.base.url) || '';
  v.append(el('div', { class: 'sec-title', text: `分站诊断（${sites.length} 个站源）` }));

  for (const s of sites) {
    /* 请求里打的**是该条目所属源**的地址（多源下不能拿"托管源"的地址去拼别的源） */
    const src = (S.aggSources || []).find((x) => x.id === s.source);
    const baseUrl = (src && src.url) || fallbackBase;
    const box = el('div', { class: 'site-group' });
    box.append(
      el(
        'div',
        { class: 'site-head' },
        el('span', { class: 'dot ' + (s.ok ? 'running' : 'error') }),
        el('span', { class: 'chip tag', text: (s.sourceName ? s.sourceName + ' · ' : '') + (s.name || s.key) }),
        el('span', { class: 'badge mono', text: `${s.source}/${s.key}` }),
        el('span', { class: 'badge mono', text: s.api || '' }),
        el('span', { class: 'badge' + (s.ok ? ' ok' : ' err'), text: s.ok ? `${((s.data && s.data.list) || []).length} 条 · ${s.ms}ms` : s.error || '失败' }),
        s.http ? el('span', { class: 'badge', text: 'HTTP ' + s.http }) : null
      )
    );
    box.append(
      codeBlock({
        label: '请求（每站首次搜索前还会先 POST {api}/init，已缓存则跳过）',
        code: JSON.stringify(
          {
            method: 'POST',
            url: baseUrl + (s.api || '') + '/search',
            /* 站源只认 `wd` + `page`（协议就这两个参数）；季集/年份/阈值那些是**面板自己打分**用的，
             * 不会带给站源 —— 打错了会以为"源不支持"，所以这里照实写清楚。 */
            body: { wd: r.wd, page: r.page },
            panelMatch: r.match
              ? { 分数线: r.match.minScore || '不筛选', 最多: r.match.maxItems || '不封顶', 命中: r.match.matched, 未命中: Math.max(0, r.match.scanned - r.match.matched) }
              : null,
          },
          null,
          2
        ),
      })
    );
    v.append(box);
  }
}
