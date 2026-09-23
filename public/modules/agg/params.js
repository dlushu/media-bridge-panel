'use strict';
/**
 * 聚合模块 · 「聚合参数」页（从「站点与参数」页拆出）：
 *   · **聚合参数**：单站超时 / 并发数 / 首次搜索先 POST `/init`
 *   · **打分设置**：分数线 `matchMinScore`（**0 = 不按分数线筛选**）/ 最多留几条命中 `matchMaxItems`
 *
 * 为什么单开一页：「站点与参数」是"每天勾选"的地方（几十上百个站点的表格），而这些旋钮是
 * "偶尔调一次"的；混在一页里既长又容易点错。编辑框也一并做宽，以免数值显示不全。
 *
 * 这两个设置是**默认值**：「聚合搜索」页上的同名输入框可以单次覆盖（改设置 = 改默认）。
 */
import { el, toast } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { S } from '../../core/state.js';
import { saveAggSettings } from '../../core/store.js';
import { switchPage } from '../../core/shell.js';

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

  /* ---- 聚合参数 ---- */
  const to = el('input', { type: 'number', class: 'w-lg', value: String(num(agg.timeoutMs, 5000)), min: '1000', step: '1000' });
  const cc = el('input', { type: 'number', class: 'w-xs', value: String(num(agg.concurrency, 8)), min: '1', max: '32' });
  const initCb = el('input', { type: 'checkbox', checked: agg.initFirst !== false });
  const saveBtn = el('button', { class: 'btn primary', text: '保存参数' });
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      await saveAggSettings({
        timeoutMs: Math.max(1000, Number(to.value) || 5000),
        concurrency: Math.max(1, Math.min(32, Number(cc.value) || 8)),
        initFirst: initCb.checked,
      });
      toast('聚合参数已保存');
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
      el('label', { class: 'chk' }, to, 'ms 单站超时'),
      el('label', { class: 'chk' }, cc, '并发数'),
      el('label', { class: 'chk', title: '有的站源要先 POST 一次 /init 才能搜；打开后按「源地址 + 站点」缓存，不是每次请求都打' }, initCb, '首次搜索先 POST /init'),
      saveBtn
    ),
  );

  /* ---- 打分设置 ---- */
  const minScore = el('input', { type: 'number', class: 'w-md', value: String(num(agg.matchMinScore, 0.85)), min: '0', max: '1', step: '0.05' });
  const maxItems = el('input', { type: 'number', class: 'w-md', value: String(num(agg.matchMaxItems, 3)), min: '1', max: '20' });
  /* 接续补打：前 N 条没凑够 N 条能用的（空壳 / 定位不到这一集）时，按分数继续往下打，
   * 最多再多试 K 条，**凑够 N 条就停**（想"一直打到底"就勾下面的开关）。 */
  const extraK = el('input', { type: 'number', class: 'w-md', value: String(num(agg.matchExtraK, 8)), min: '0', max: '10' });
  const extraAllCb = el('input', { type: 'checkbox', checked: agg.matchExtraAll === true });
  /* 「匹配到底」勾上时 K 就不生效了 —— 二者冲突，所以勾上时直接隐藏 K 那一格
   * （`title` 里也写了二者互斥）。 */
  const extraKLabel = el(
    'label',
    { class: 'chk', title: '前 N 条没凑够时，按分数继续往下打，最多再试这么多条；凑够 N 条就停。填 0 = 不往下补打' },
    extraK,
    '没凑够时再往下打几条'
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
    if (!(ek >= 0 && ek <= 10)) return toast('「没凑够时再往下打几条」填 0~10（0 = 不补打）', true);
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
      el('label', { class: 'chk', title: '想要几条"能用的"（有线路、且定位到你要的那一集）。每多一条，后面就多打一次站源 /detail' }, maxItems, '最多留几条命中'),
      extraKLabel,
      el('label', { class: 'chk', title: '不看"再往下打几条"，一直往下打到凑够或名单打完（每个候选都要打一次站源 /detail，可能慢）' }, extraAllCb, '匹配到底'),
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
        '"能用的"= 有线路、且定位到你要的那一集；前 N 条没凑够时按分数往下补打，最多试 N+K 条、凑够 N 条就停。',
    }),
    el(
      'div',
      { class: 'row' },
      el('button', { class: 'btn', text: '去聚合搜索（可单次覆盖这两项）', onclick: () => switchPage('agg-search') }),
      el('button', { class: 'btn', text: '去站点与参数（勾选哪些站参与）', onclick: () => switchPage('agg-sites') })
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

  v.append(card1, card2, card3);
}
