'use strict';
/**
 * 聚合模块自己的设置（data/settings/agg.json）
 *
 *   sources          **自定义**聚合源（外部地址）：{ id, url, name, enabled }
 *                    —— 站点身份是 (source, key) 这一对。**本地部署的源不在这里**：
 *                       它们自动进聚合（名字取部署源自己的名字、地址每次现算），
 *                       见 source/service.js 的 `deployed()` 与 agg/api.js 的 `listSources()`。
 *                       所以这份清单只剩"面板够不到、得手填地址"的那一半。
 *                       `name` 可以留空（显示时退回 url），填了就**必须各不相同**（见 validate）
 *   enabled / order 参与聚合与排序的**站点**：{ source, key }（原来只存裸 key，多源下会撞）
 *   timeoutMs / concurrency / initFirst  聚合参数（全局，不分源）
 *   lineFilter       **Emby 版本列表的线路过滤**（正则，只匹配线路名）：由 emby 层迁入
 *                    （线路就是聚合层产出的东西，过滤规则随它放在一处）
 *   matchExtraK      **接续补打**（"凑够 N 条"口径）：
 *                    前 `matchMaxItems` 条取详情后**没凑够 N 条能用的**（空壳 / 定位不到这一集）时，
 *                    按分数继续往下打，**最多再试 K 条，凑够 N 条就停**；0 = 不往下补打
 *   matchExtraAll    **匹配到底**（开关）：不看 `matchExtraK`，一直往下打到凑够 N 条
 *                    或名单打完（可能很慢 —— 每个候选都要打一次站源 `/detail`）
 *   matchMinScore / matchMaxItems  **打分匹配**：见 `match.js` 顶部
 *                       `matchMinScore` = 分数线，**填 0 = 不按分数线筛选**（只按分数排名取前 N 条）
 *                       `matchMaxItems` = 最多留几条命中（= 想要的"能用的"条数 N）；每多留一条就多打一次站源 `/detail`
 */
module.exports = {
  defaults: () => ({
    sources: [],
    enabled: [],
    order: [],
    timeoutMs: 5000,
    concurrency: 8,
    initFirst: true,
    matchMinScore: 0.85,
    matchMaxItems: 3,
    matchExtraK: 8,
    matchExtraAll: false,
    lineFilter: '',
  }),

  /** 供前端「聚合设置」页自动生成表单 */
  fields: [
    { key: 'timeoutMs', label: '单站超时(ms)', type: 'number', min: 1000, max: 60000 },
    { key: 'concurrency', label: '并发数', type: 'number', min: 1, max: 32 },
    { key: 'initFirst', label: '首次搜索先 POST /init', type: 'bool' },
    { key: 'matchMinScore', label: '打分分数线(0~1，0=不筛选)', type: 'number', min: 0, max: 1, step: 0.05 },
    { key: 'matchMaxItems', label: '最多留几条命中', type: 'number', min: 1, max: 20 },
    { key: 'matchExtraK', label: '没凑够时再往下打几条', type: 'number', min: 0, max: 10 },
    { key: 'matchExtraAll', label: '匹配到底(不看 K，直到凑够)', type: 'bool' },
    { key: 'lineFilter', label: '线路过滤(正则，匹配线路名)', type: 'text', placeholder: '留空 = 不过滤。例：夸克' },
  ],

  validate: (o) => {
    if (!(Number(o.timeoutMs) >= 1000)) return 'timeoutMs 不能小于 1000';
    if (!(Number(o.concurrency) >= 1 && Number(o.concurrency) <= 32)) return 'concurrency 取值 1~32';
    /* 打分匹配的两个旋钮。`matchMinScore` 允许 0 —— 那是"不按分数线筛选"的合法值，
     * 所以判据是 0 ≤ x ≤ 1 而不是 x > 0（写成 x>0 会挡回"故意关闭分数线"的那次保存）。 */
    if (o.matchMinScore != null && !(Number(o.matchMinScore) >= 0 && Number(o.matchMinScore) <= 1)) {
      return 'matchMinScore 取值 0~1（0 = 不按分数线筛选）';
    }
    if (o.matchMaxItems != null && !(Number(o.matchMaxItems) >= 1 && Number(o.matchMaxItems) <= 20)) {
      return 'matchMaxItems 取值 1~20';
    }
    /* 线路过滤的正则**在保存时就校验**（规则写错了不该等到播放时才失败；运行时另有兜底，见 api.lineFilter）。
     * 这段校验由 `emby/index.js` 迁入 —— 设置跟着它新家走。 */
    if (o.lineFilter !== undefined && o.lineFilter !== null && String(o.lineFilter).trim()) {
      try {
        new RegExp(String(o.lineFilter).trim());
      } catch (e) {
        return '线路过滤不是合法正则：' + ((e && e.message) || e);
      }
    }
    /* `matchExtraK` 允许 0 = 不往下补打（见 service.aggregateDetail 那段） */
    if (o.matchExtraK != null && !(Number(o.matchExtraK) >= 0 && Number(o.matchExtraK) <= 10)) {
      return 'matchExtraK 取值 0~10（0 = 不补打）';
    }
    if (!Array.isArray(o.sources)) return 'sources 必须是数组';
    const ids = new Set();
    const names = new Set(); // 名字用来区分源，重了在界面上就分不清哪个是哪个
    for (const s of o.sources) {
      if (!s || typeof s !== 'object') return 'sources 的每一项必须是对象';
      if (!s.id || typeof s.id !== 'string') return 'sources[].id 必填（短标识，如 s1）';
      if (!s.url || typeof s.url !== 'string') return `源 ${s.id} 缺少 url`;
      if (ids.has(s.id)) return `源 id 重复：${s.id}`;
      ids.add(s.id);
      if (s.name != null && typeof s.name !== 'string') return `源 ${s.id} 的 name 必须是字符串`;
      const nm = String(s.name || '').trim();
      if (nm) {
        const key = nm.toLowerCase();
        if (names.has(key)) return `源名字重复：${nm}（名字可以留空，填了就得各不相同）`;
        names.add(key);
      }
    }
    for (const [name, arr] of [['enabled', o.enabled], ['order', o.order]]) {
      if (!Array.isArray(arr)) return `${name} 必须是数组`;
      for (const it of arr) {
        if (!it || typeof it !== 'object' || !it.source || !it.key) {
          return `${name} 的每一项必须是 { source, key }`;
        }
      }
    }
    return null;
  },
};
