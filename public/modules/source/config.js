'use strict';
/**
 * 猫爪源模块 · 「配置中心」页：用同源代理把**某个源**自带的 /website 嵌进来（iframe）。
 *
 * **每个运行中的源各有一页**（页 id = `website-<本地源id>`，见 registry.pages()），
 * 页内还给了个源下拉 —— 免得为了换一个源还要跑回左侧导航点一下。
 *
 * 走面板的同源代理 `/website`：iframe 里的前端写的是**绝对路径**（`/website/api/…`），
 * 所以"看的是哪个源"由**面板记住**（首帧带 ?source=<源id>，见 source/routes.js），
 * 从 127.0.0.1 还是局域网/Tailscale IP 打开面板都能正常加载。
 */
import { el, copy } from '../../core/dom.js';
import { S } from '../../core/state.js';
import { renderPage, switchPage } from '../../core/shell.js';
import { runningSources, websiteSourceOfPage, WEBSITE_PAGE_PREFIX } from '../../core/registry.js';

export function renderWebsite(v) {
  const list = runningSources();
  /* 当前页绑着哪个源；没有（老 id / 外部托管源）就退回第一个在跑的 */
  const picked = websiteSourceOfPage(S.page) || (list[0] && list[0].id) || '';
  const cur = list.find((x) => x.id === picked) || null;
  /* 本地源这里要**自己拼**（`cur.run` 是 runner 的状态：有 port，没有 url）；没本地源才退回托管源地址 */
  const url = cur ? `http://127.0.0.1:${cur.run.port}` : ((S.run && S.run.url) || '');
  const src = cur ? `/website?source=${encodeURIComponent(cur.id)}` : '/website';

  const sel = el('select');
  if (!list.length) {
    sel.append(el('option', { value: '', text: '（没有运行中的本地源）' }));
  } else {
    for (const s of list) {
      sel.append(el('option', { value: s.id, selected: s.id === picked, text: `${s.name || s.url}（:${s.run.port}）` }));
    }
    sel.addEventListener('change', () => switchPage(WEBSITE_PAGE_PREFIX + sel.value));
  }

  const toolbar = el(
    'div',
    { class: 'toolbar pad-x pad-t' },
    el('span', { class: 'muted', text: '源：' }),
    sel,
    el('button', { class: 'btn', text: '重新加载', onclick: () => renderPage() }),
    el('a', { class: 'btn', href: src, target: '_blank', rel: 'noreferrer', text: '新窗口打开' }),
    el('button', { class: 'btn', text: '复制本页地址', onclick: () => copy(location.origin + src) }),
    el('span', { class: 'spacer' }),
    el('span', { class: 'note mono', text: (url || '?') + '/website' })
  );

  if (!url) {
    v.append(toolbar, el('div', { class: 'hint warn mg-x' }, '还没有运行中的源。请到「源托管 · 猫源地址」添加并运行，或在「聚合设置 · 源列表」填一个源地址。'));
    return;
  }

  v.append(
    toolbar,
    el('div', { class: 'frame-wrap' }, el('iframe', { class: 'embed', src, referrerpolicy: 'no-referrer' }))
  );
}
