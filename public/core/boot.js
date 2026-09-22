'use strict';
/**
 * 启动与轮询：拉全局数据 → 画壳 → 定时刷新运行状态。
 * 依赖 shell / api，所以放最后一块 —— 页渲染函数要先 `registerPages()` 过。
 */
import { $, el } from './dom.js';
import { api } from './api.js';
import { ensureAuth } from './auth.js';
import { S } from './state.js';
import { applyHash, applyNavState, closeNavIfNarrow, collapseNav, onHashChange, renderPage, switchModule, switchPage, toggleNav } from './shell.js';

export async function init() {
  applyNavState(); // 先定侧栏形态，别等数据回来才闪一下
  /* 面板门禁：没登录就把登录框铺上，后面一步都不做（拉了也是 401） */
  if (!(await ensureAuth())) return;
  applyHash(); // 地址栏里有页就按它来（刷新后停在同一页），下面的 renderPage 会用上
  window.addEventListener('hashchange', onHashChange); // 前进/后退切页
  $('#navToggle').addEventListener('click', toggleNav);
  $('#navScrim').addEventListener('click', collapseNav);
  $('#nav').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-module]');
    if (!b) return;
    switchModule(b.dataset.module);
    closeNavIfNarrow(); // 窄屏是抽屉，选完就该收起来
  });
  $('#subnav').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-page]');
    if (b) switchPage(b.dataset.page);
  });
  await loadAll();
  setInterval(poll, 5000);
}

export async function loadAll() {
  try {
    const { settings, base } = await api('/api/settings');
    S.settings = settings;
    S.base = base;
    S.apiError = null;
  } catch (e) {
    S.apiError = e.message;
    S.settings = null;
    S.base = null;
  }
  try {
    const { sources } = await api('/api/sources');
    S.sources = sources;
  } catch {
    S.sources = [];
  }
  // 运行中的源（配置中心 / 接口测试的目标）
  try {
    const r = await api('/api/run');
    S.run = r.run;
  } catch {
    S.run = null;
  }
  // 聚合托管源的探测结果
  try {
    if (S.base && S.base.url) {
      const { probe } = await api('/api/base/probe', { method: 'POST', body: { url: S.base.url } });
      S.probe = probe;
    } else {
      S.probe = null;
    }
  } catch {
    /* ignore */
  }

  if (S.apiError) {
    renderError();
    return;
  }
  $('#empty').classList.add('hidden');
  $('#workspace').classList.remove('hidden');
  renderPage();
}

function renderError() {
  const box = $('#empty');
  box.classList.remove('hidden');
  box.textContent = '';
  $('#workspace').classList.add('hidden');
  box.append(
    el(
      'div',
      { class: 'empty-inner' },
      el('div', { class: 'empty-icon', text: '⚠️' }),
      el('h2', { text: '连接不到后端服务' }),
      el('p', {
        class: 'muted',
        html: `当前页面地址：<code>${location.origin}</code><br>接口错误：<code>${String(S.apiError).replace(/[<>&]/g, '')}</code><br><br>请先启动后端：<code>npm start</code>，再用它启动后打印的地址打开面板。`,
      }),
      el('button', { class: 'btn primary', text: '重试连接', onclick: () => loadAll() })
    )
  );
}

export async function poll() {
  /* 运行中的源：换了个源就整页重画（「配置中心」「接口测试」都依赖它）。
   * 不请求 ?probe=1 了 —— 那份探测结果原来只喂顶栏状态，顶栏去掉后没人读，
   * 每 5 秒白打一次源的 /check。 */
  try {
    const r = await api('/api/run');
    const prevUrl = (S.run && S.run.url) || '';
    S.run = r.run;
    if (prevUrl !== ((S.run && S.run.url) || '')) {
      renderPage();
      return;
    }
  } catch {
    /* ignore */
  }
  // 本地托管源状态：保持 S.sources 新鲜；**状态变了就重画** ——
  // 源从「启动中」翻成「运行中/异常」必须看得见（以前只更新 S.sources、不重画，得手动切页才刷新）
  if (S.sources.length) {
    try {
      const sig = (list) => (list || []).map((x) => x.id + ':' + ((x.run && x.run.status) || '-')).join(',');
      const { sources } = await api('/api/sources');
      const changed = sig(sources) !== sig(S.sources);
      S.sources = sources;
      // ⚠️ 正在输入时不重画 —— 一重画就把用户填了一半的输入框刷掉了（源页面就有个「添加」表单）
      const el = document.activeElement;
      const typing = !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
      if (changed && !typing) renderPage();
    } catch {
      /* ignore */
    }
  }
}
