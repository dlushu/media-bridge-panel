'use strict';
/**
 * 猫爪源模块 · 「配置中心」页：把**某个源**自带的 `/website` 嵌进来（iframe）。
 *
 * **每个运行中的源各有一页**（页 id = `website-<本地源id>`，见 registry.pages()），
 * 页内还有个源下拉 —— 免得为了换一个源还要跑回左侧导航点一下。
 *
 * **iframe 直接指向源自己的地址**：`http://<当前访问面板用的域名>:<源端口>/website` ——
 * 用哪个域名进的面板（局域网 IP / Tailscale IP / 域名）就用哪个域名，端口是源的端口。
 * 这样"看的是哪个源"从地址栏就看得见，也不用面板在中间记着（老实现走面板的同源代理
 * `/website?source=<源id>`，因为源的页面内部写的是绝对路径，只能靠面板记）。
 *
 * ⚠️ **两种访问方式会看不到**（如实写在页面上，不静默）：
 *   · 源端口没发布到宿主（docker-compose 里 9988-9998 那段）→ 浏览器连不上源；
 *   · 用 **https** 打开面板 → 浏览器会拦 http 的 iframe（混合内容）。
 * 这两种情况都退回面板的同源代理：`/website?source=<源id>`（服务端那条路由还在）。
 */
import { el } from '../../core/dom.js';
import { S } from '../../core/state.js';
import { switchPage } from '../../core/shell.js';
import { runningSources, websiteSourceOfPage, WEBSITE_PAGE_PREFIX } from '../../core/registry.js';

export function renderWebsite(v) {
  const list = runningSources();
  /* 当前页绑着哪个源；没有（老 id / 外部托管源）就退回第一个在跑的 */
  const picked = websiteSourceOfPage(S.page) || (list[0] && list[0].id) || '';
  const cur = list.find((x) => x.id === picked) || null;
  /* 本地源：用**访问面板的这个域名** + 源端口（`cur.run` 是 runner 的状态：有 port，没有 url）。
   * 没有本地源就退回托管源地址（外部源只能用它给的完整地址）。 */
  const base = cur ? `http://${location.hostname}:${cur.run.port}` : ((S.run && S.run.url) || '');
  const src = base ? base + '/website' : '';
  /* 兜底：面板的同源代理（见文件头那两种"直连看不到"的情况） */
  const proxied = cur ? `/website?source=${encodeURIComponent(cur.id)}` : '/website';

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
    el('a', { class: 'btn', href: src || proxied, target: '_blank', rel: 'noreferrer', text: '新窗口打开' }),
    el('span', { class: 'spacer' }),
    el('span', { class: 'note mono', text: (base || '?') + '/website' })
  );

  if (!base) {
    v.append(toolbar, el('div', { class: 'hint warn mg-x' }, '还没有运行中的源。请到「源托管 · 猫源地址」添加并运行，或在「聚合设置 · 源列表」填一个源地址。'));
    return;
  }

  v.append(toolbar, el('div', { class: 'frame-wrap' }, el('iframe', { class: 'embed', src, referrerpolicy: 'no-referrer' })));
}
