'use strict';
/**
 * 面板模块 · 「概览」页：**只看不改** —— 运行环境（版本 / Node / 数据与设置目录 / 当前地址）。
 *
 * 要动设置去同模块的「设置」页（备份还原 / 面板密码）。
 */
import { el, copy } from '../../core/dom.js';
import { api } from '../../core/api.js';

export function renderPanelOverview(v) {
  const card = el('div', { class: 'card' }, el('h3', { text: '运行环境' }));
  const body = el('div');
  card.append(body);
  v.append(card);

  api('/api/panel/info')
    .then((info) => {
      const rows = [
        ['面板版本', info.version],
        ['Node', info.node],
        ['数据目录', info.dataDir],
        ['设置目录', info.settingsDir],
        ['当前地址', location.origin],
      ];
      for (const [k, val] of rows) {
        body.append(el('div', { class: 'kv' }, el('span', { class: 'k', text: k }), el('span', { class: 'v', text: val || '-' })));
      }
      card.append(
        el(
          'div',
          { class: 'actions' },
          el('button', {
            class: 'btn mini',
            text: '复制这些路径',
            onclick: () => copy(rows.map(([k, val]) => `${k}: ${val}`).join('\n')),
          })
        )
      );
    })
    .catch((e) => body.append(el('div', { class: 'note err-note', text: '取运行环境失败：' + e.message })));
}
