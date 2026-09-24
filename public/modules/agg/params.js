'use strict';
/**
 * 聚合模块 · 「聚合参数」页（从「站点与参数」页拆出）：
 *   · **聚合参数**：单站超时 `timeoutSec`（秒）/ 取详情超时 `detailTimeoutSec`（秒）/ 并发数
 *   · **打分设置**：分数线 `matchMinScore`（**0 = 不按分数线筛选**）/ 最多留几条命中 `matchMaxItems`
 *   · **线路过滤**：`lineFilter`
 *   · **运行时流程与耗时**：把上面这些旋钮翻译成"跑一次会发生什么、大概等多久"，
 *     数字**跟着输入框实时算**（见文件末尾的 `runtimeLines`）
 *
 * 为什么单开一页：「站点与参数」是"每天勾选"的地方（几十上百个站点的表格），而这些旋钮是
 * "偶尔调一次"的；混在一页里既长又容易点错。编辑框也一并做宽，以免数值显示不全。
 *
 * 这些设置是**默认值**：「聚合搜索」页上的同名输入框可以单次覆盖（改设置 = 改默认）。
 * 时间一律用**秒**（搜索默认 5 秒、取详情默认 10 秒，`agg.json` 里存的也是秒）。
 */
import { el, toast } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { S } from '../../core/state.js';
import { saveAggSettings } from '../../core/store.js';

export async function renderAggParams(v) {
  /* **本页一律现读 `/api/modules/agg/settings`**（权威），不用 `S.settings.agg` ——
   * 那份是启动时 `/api/settings` 给的"旧版投影"，漏一个键就会表现为"保存完刷新，编辑框还是空的"
   * （`lineFilter` 曾因漏投影而丢失）。读不到再退回手上那份。 */
  try {
    const r = await api('/api/modules/agg/settings');
    S.settings = Object.assign(S.settings || {}, { agg: r.settings });
  } catch (e) {
    if (!S.settings || !S.settings.agg) {
      v.append(el('div', { class: 'hint warn', text: '读取聚合设置失败：' + e.message }));
      return;
    }
  }
  const agg = S.settings.agg || {};
  const num = (v2, d) => (v2 === undefined || v2 === null ? d : v2);

  /* ---- 聚合参数 + 站点测速 ----
   * `initFirst` 已删：有的源不 init 就搜不出来，"要不要 init"由源的性质决定（现在恒开，
   * 而且测速每轮都会把全站 init 一遍，见 server/modules/agg/service.js 的 ensureInit）。
   * 两个超时都是**秒**：搜索那一项也管播放与首次 `/init`；详情单独一项、默认更宽。 */
  const to = el('input', { type: 'number', class: 'w-xs', value: String(num(agg.timeoutSec, 5)), min: '1', max: '60' });
  const dto = el('input', { type: 'number', class: 'w-xs', value: String(num(agg.detailTimeoutSec, 10)), min: '1', max: '120' });
  const cc = el('input', { type: 'number', class: 'w-xs', value: String(num(agg.concurrency, 8)), min: '1', max: '32' });
  const stAuto = el('input', { type: 'checkbox', checked: agg.speedTestAuto !== false });
  const stHours = el('input', { type: 'number', class: 'w-xs', value: String(num(agg.speedTestHours, 6)), min: '1', max: '168' });
  const saveBtn = el('button', { class: 'btn primary', text: '保存参数' });
  saveBtn.addEventListener('click', async () => {
    const sec = Number(to.value);
    const dsec = Number(dto.value);
    const h = Number(stHours.value);
    if (!(sec >= 1 && sec <= 60)) return toast('单站超时填 1~60 秒', true);
    if (!(dsec >= 1 && dsec <= 120)) return toast('取详情超时填 1~120 秒', true);
    if (!(h >= 1 && h <= 168)) return toast('测速间隔填 1~168 小时', true);
    saveBtn.disabled = true;
    try {
      await saveAggSettings({
        timeoutSec: sec,
        detailTimeoutSec: dsec,
        concurrency: Math.max(1, Math.min(32, Number(cc.value) || 8)),
        speedTestAuto: stAuto.checked,
        speedTestHours: h,
      });
      toast(stAuto.checked ? `聚合参数已保存（每 ${h} 小时自动测速）` : '聚合参数已保存（自动测速已关）');
    } catch (e) {
      toast('保存失败：' + e.message, true);
    } finally {
      saveBtn.disabled = false;
    }
  });
  const card1 = el(
    'div',
    { class: 'card' },
    el('h3', { text: '聚合参数' }),
    el(
      'div',
      { class: 'row' },
      el('label', { class: 'chk', title: '搜索 / 播放（以及首次 /init）的单站超时，单位秒。慢站设太小会被一律判成超时' }, to, '秒 单站超时'),
      el(
        'label',
        {
          class: 'chk',
          title:
            '取详情（POST /detail）的单站超时，单位秒。比搜索更宽 —— 剧集动辄几十上百集，' +
            '响应体大、上游拼装慢，与搜索共用一个超时会大量"定位不到"',
        },
        dto,
        '秒 取详情超时'
      ),
      el('label', { class: 'chk' }, cc, '并发数'),
      el('label', { class: 'chk', title: '每站打一发 POST /search（片名从常见影视名里随机取、非 200 换一个再测一发），结果写进「站点与参数」页那一列「延迟」' }, stAuto, '自动测速（全部站点）'),
      el('label', { class: 'chk', title: '多久测一轮，1~168 小时；改完从现在重新计时' }, stHours, '小时'),
      saveBtn
    ),
    el('div', {
      class: 'note',
      text:
        '「单站超时」= 搜索 / 播放 / 首次 `/init` 的单站上限；「取详情超时」= 取详情 `POST /detail` 的单站上限，' +
        '**单独一项、默认更宽**（剧集的目录大，跟搜索共用一个超时会大量"定位不到"）。',
    })
  );

  /* ---- 打分设置 ---- */
  const minScore = el('input', { type: 'number', class: 'w-md', value: String(num(agg.matchMinScore, 0.85)), min: '0', max: '1', step: '0.05' });
  const maxItems = el('input', { type: 'number', class: 'w-md', value: String(num(agg.matchMaxItems, 8)), min: '1', max: '20' });
  /* 接续补打：前 N 条**一条能用的都没拿到**（空壳 / 定位不到这一集）时，按分数继续往下打，
   * 最多再试 K 条，**第一批拿到能用的就不再发第二批**（想"一直打到底"就勾下面的开关）。
   * **默认 K = 0（不补打）**：实测它容易变成最贵的一段（一批按 N 条并发打 `/detail`），
   * 而换来的可用条目常常是 0；想要兜底就把它填上。 */
  const extraK = el('input', { type: 'number', class: 'w-md', value: String(num(agg.matchExtraK, 0)), min: '0', max: '10' });
  const extraAllCb = el('input', { type: 'checkbox', checked: agg.matchExtraAll === true });
  /* 「匹配到底」勾上时 K 就不生效了 —— 二者冲突，所以勾上时直接隐藏 K 那一格
   * （`title` 里也写了二者互斥）。 */
  const extraKLabel = el(
    'label',
    { class: 'chk', title: '前 N 条一条能用的都没拿到时，按分数继续往下打，最多再试这么多条；第一批拿到能用的就不再往下打。填 0 = 不补打' },
    extraK,
    '一条都没拿到时再往下打几条'
  );
  const syncExtra = () => extraKLabel.classList.toggle('hidden', extraAllCb.checked);
  extraAllCb.addEventListener('change', syncExtra);
  syncExtra();
  const save2 = el('button', { class: 'btn primary', text: '保存打分设置' });
  save2.addEventListener('click', async () => {
    const ms = Number(minScore.value);
    const mi = Number(maxItems.value);
    const ek = Number(extraK.value);
    if (!(ms >= 0 && ms <= 1)) return toast('分数线填 0~1（填 0 = 不过滤分数线）', true);
    if (!(mi >= 1 && mi <= 20)) return toast('最多留几条填 1~20', true);
    if (!(ek >= 0 && ek <= 10)) return toast('「一条都没拿到时再往下打几条」填 0~10（0 = 不补打）', true);
    save2.disabled = true;
    try {
      await saveAggSettings({ matchMinScore: ms, matchMaxItems: mi, matchExtraK: ek, matchExtraAll: extraAllCb.checked });
      toast('打分设置已保存');
    } catch (e) {
      toast('保存失败：' + e.message, true);
    } finally {
      save2.disabled = false;
    }
  });
  const card2 = el(
    'div',
    { class: 'card' },
    el('h3', { text: '打分设置' }),
    el(
      'div',
      { class: 'row' },
      el('label', { class: 'chk', title: '打分 ≥ 它的才算命中。填 0 = 不过滤分数线（只按分数排名取前 N 条）' }, minScore, '分数线'),
      el('label', { class: 'chk', title: '阶段一要取几条（有线路、且定位到你要的那一集）。每多取一条就多打一次站源 /detail' }, maxItems, '最多留几条命中'),
      extraKLabel,
      el('label', { class: 'chk', title: '不看"再往下打几条"，一直往下打到拿到一条能用的或名单打完（每个候选都要打一次站源 /detail，可能慢）' }, extraAllCb, '匹配到底'),
      save2
    ),
    el('div', {
      class: 'note',
      text:
        '分数线填 0 = 不过滤分数线（只按分数排名取前 N 条）。打分口径：名字 0.7 · 季集 0.2 · 年份 0.1（缺的项不计），名字像不上的直接出局。',
    }),
    el('div', {
      class: 'note',
      text:
        '"能用的"= 有线路、且定位到你要的那一集；前 N 条一条能用的都没拿到时，才按分数往下补打（最多再试 K 条）。',
    }),
    el(
      'div',
      { class: 'row' },
    )
  );

  /* ---- 线路过滤 ----
   * 从「Emby → 连接设置」搬来 —— 线路是聚合层产出的东西，过滤规则与聚合设置放在一起更合理。
   * ⚠️ 页面文案**不提 Emby**（聚合设置页只描述聚合层自身的事，不涉及 emby 层）：
   * 这里描述成"过滤**聚合产出的线路**"——谁是消费方（版本清单 / 线路清单）不在这页交代。 */
  const lineFilter = el('input', {
    type: 'text',
    value: String(num(agg.lineFilter, '')),
    placeholder: '正则，匹配线路名；留空 = 不过滤。例：夸克原画|百度原画',
    spellcheck: 'false',
  });
  const save3 = el('button', { class: 'btn primary', text: '保存线路过滤' });
  save3.addEventListener('click', async () => {
    save3.disabled = true;
    try {
      await saveAggSettings({ lineFilter: lineFilter.value.trim() });
      toast(lineFilter.value.trim() ? '线路过滤已保存：只列匹配的线路' : '线路过滤已清空（不过滤）');
    } catch (e) {
      toast('保存失败：' + e.message, true);
    } finally {
      save3.disabled = false;
    }
  });
  const card3 = el(
    'div',
    { class: 'card' },
    el('h3', { text: '线路过滤' }),
    /* 输入框**直接放 .row 里**（不是塞进 .chk）：正则可以很长，要占满剩余宽度（见 style.css 的 .row > input） */
    el('div', { class: 'row' }, lineFilter, save3),
    el('div', { class: 'note', text: '正则，只匹配线路名；留空 = 不过滤。例：夸克原画|百度原画' })
  );

  /* ---- 运行时流程与耗时（按上面的参数**实时**算）----
   * 这是给用户看的：把三个卡片的旋钮翻译成"跑一次会发生什么、大概等多久"。
   * 全部现读输入框（不必保存），改一个数字它就跟着变 —— 见 `runtimeLines`。 */
  const noteLine = (text) => el('div', { class: 'note', text });

  /**
   * 估算"一次聚合（含取详情）最坏要等多久"。
   * 数字全部来自**当前输入框**与设置里的启用站点数，所以它总是和"保存下去会怎样"一致。
   *
   * 口径：给的都是**上限**（最慢那一发全撞超时），同时说明正常量级 ——
   * 只报上限会把人吓到，只报"一般 2 秒"又是骗人（实测确实有 15 秒级的站）。
   */
  const runtimeLines = () => {
    const siteN = (agg.enabled || []).length;
    const C = Math.max(1, Number(cc.value) || 8);
    const S1 = Math.max(1, Number(to.value) || 5);
    const D = Math.max(1, Number(dto.value) || 10);
    const N = Math.max(1, Number(maxItems.value) || 3);
    const K = Math.max(0, Number(extraK.value) || 0);
    const all = extraAllCb.checked;
    const ms = Number(minScore.value);
    const lf = String(lineFilter.value || '').trim();

    const batches = siteN ? Math.ceil(siteN / C) : 0;
    const searchWorst = batches * S1;
    /* 补打每批 `N` 条并发，最多再试 `K` 条 → 最多 ⌈K/N⌉ 批，每批 ≈ 一次详情超时 */
    const extraRounds = all ? null : Math.ceil(K / N);
    const extraWorst = all ? null : extraRounds * D;

    const out = [noteLine('下面的数字跟着上面的输入框实时变（不用保存）；标"最坏"的是上限，实测通常远小于它。')];

    out.push(
      noteLine(
        siteN
          ? `① 聚合搜索：${C} 并发 → ${siteN} 个启用站分 ${batches} 批，每站一发 POST /search（第一次还会先 POST /init，已初始化过的源跳过）`
          : '① 聚合搜索：还没勾选参与聚合的站点（去「站点与参数」勾）—— 现在聚合搜索会直接报错'
      ),
      noteLine(
        siteN
          ? `单站超时 ${S1} 秒 → 最坏 ≈ ${batches} × ${S1}s = ${searchWorst}s；实测一般 0.3~2 秒`
          : `勾好站点后：并发 ${C}、单站超时 ${S1} 秒`
      ),
      noteLine('最近一次测速失败的站直接跳过：不发请求、也不等它')
    );

    out.push(
      noteLine('② 打分筛选（本地算，毫秒级、不打上游）'),
      noteLine(
        `命中门槛：${ms === 0 ? '不看分数线（只按分数排名取前 N 条）' : `分数线 ${ms}`} · 最多留 ${N} 条命中` +
          ' —— 每多留一条，后面就多打一次详情'
      ),
      noteLine('每条按 名字 0.7 · 季集 0.2 · 年份 0.1 打分（缺的项不计），名字像不上的直接出局')
    );

    out.push(
      noteLine('③ 取详情：命中的站每站一发 POST /detail（代表 + 它的变体各一发），并发打'),
      noteLine(`单站超时 ${D} 秒 → 阶段一最坏 ≈ ${D}s（等最慢的那一发）；剧集按「季/集」在集名里定位`),
      noteLine('目录越大这一发越慢 —— 所以详情单独一档超时，别把它压到跟搜索一样')
    );

    out.push(
      noteLine('④ 兜底补打：③ 里**一条能用的都没拿到**时才按分数往下补打（有版本就不打）'),
      noteLine(
        all
          ? '勾了「匹配到底」：不看 K，一直往下打到拿到一条或名单打完 —— 没有上限（可能很慢）'
          : K === 0
            ? '「再往下打几条」= 0：不补打（默认）—— 前面一条都没拿到就是没有'
            : `最多再试 ${K} 条，每批 ${N} 条并发；第一批拿到就不再打 → 最坏再加 ≈ ${extraRounds} × ${D}s = ${extraWorst}s`
      )
    );

    out.push(
      noteLine('⑤ 线路过滤' + (lf ? `：/${lf}/ 生效中（只匹配线路名）` : '：没设规则（所有线路都算）')),
      noteLine('过滤后一条线路都不剩的详情"不算能用"：不占 ④ 的名额，也不存快照')
    );

    out.push(
      noteLine(
        all
          ? `最坏总耗时 ≈ 搜索 ${searchWorst}s + 详情 ${D}s + 补打（无上限）`
          : `最坏总耗时 ≈ 搜索 ${searchWorst}s + 详情 ${D}s + 补打 ${extraWorst || 0}s ≈ ${searchWorst + D + (extraWorst || 0)}s`
      ),
      noteLine('（补打只在 ③ 一条都没拿到时才会发生；正常几秒，体感主要由 ③ 决定 —— 最慢的那一发）')
    );
    return out;
  };

  const runtimeHost = el('div', {});
  const paintRuntime = () => {
    runtimeHost.textContent = '';
    for (const node of runtimeLines()) runtimeHost.append(node);
  };
  /* 改任何一个旋钮都立刻重算（不必保存）—— 这几个输入框也是「运行时说明」的输入 */
  for (const inp of [to, dto, cc, minScore, maxItems, extraK, extraAllCb, lineFilter]) {
    inp.addEventListener('input', paintRuntime);
    inp.addEventListener('change', paintRuntime);
  }
  paintRuntime();
  const card4 = el(
    'div',
    { class: 'card' },
    el('h3', { text: '运行时流程与耗时（按上面的参数估算）' }),
    runtimeHost
  );

  v.append(card1, card2, card3, card4);
}
