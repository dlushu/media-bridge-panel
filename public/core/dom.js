'use strict';
/**
 * DOM 小工具（与业务无关）
 *   $      —— 选择器
 *   el     —— 建节点（{class,text,html,onX} + 子节点）
 *   toast  —— 右下角提示
 *   fmtTime—— ISO 时间 → 本地可读
 */
export const $ = (sel, root = document) => root.querySelector(sel);

/** 建节点：属性里的 `on*` 走 addEventListener，其余走 setAttribute；子节点自动转文本 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(9)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

let toastTimer = null;
export function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), isErr ? 6000 : 2600);
}

/**
 * 模态框（添加源这类"填几个字段就提交"的操作一律用它，别在页面里摊开一行输入框）
 *
 *   modal({
 *     title: '添加猫源',
 *     body: [ ...节点 ],                       // 表单字段
 *     actions: [{ label, primary, onclick }],  // onclick 返回 false = **别关**（校验不过时用）
 *   }) → { root, close }
 *
 * 关闭方式：右上角 ✕、取消按钮、点遮罩、Esc。同一时刻只留一个（再开就把上一个关掉）。
 */
let currentModal = null;

export function modal({ title, body = [], actions = [] } = {}) {
  if (currentModal) currentModal.close();

  const close = () => {
    document.removeEventListener('keydown', onKey);
    mask.remove();
    if (currentModal && currentModal.root === mask) currentModal = null;
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };

  const box = el(
    'div',
    { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
    el(
      'div',
      { class: 'modal-head' },
      el('h3', { text: title || '' }),
      el('button', { class: 'modal-x', text: '✕', 'aria-label': '关闭', onclick: close })
    ),
    el('div', { class: 'modal-body' }, ...body.flat(9)),
    el(
      'div',
      { class: 'modal-actions' },
      ...actions.flat(9).map((a) =>
        el('button', {
          class: 'btn' + (a.primary ? ' primary' : ''),
          text: a.label,
          onclick: async () => {
            if (!a.onclick) return close();
            const keep = await a.onclick(); // 出错/校验不过时回 false → 窗口留着，输入不丢
            if (keep !== false) close();
          },
        })
      )
    )
  );
  const mask = el('div', { class: 'modal-mask' }, box);
  mask.addEventListener('click', (e) => {
    if (e.target === mask) close();
  }); // 点遮罩关闭（点框内不关）

  document.body.append(mask);
  document.addEventListener('keydown', onKey);
  /* 焦点给第一个可输入的控件（没有就不动），键盘用户不用先点一下 */
  const first = box.querySelector('input:not([type=checkbox]), select, textarea');
  if (first) setTimeout(() => first.focus(), 20);

  currentModal = { root: mask, close };
  return currentModal;
}

/** 带标题的代码块（接口文档、原始响应体都用它） */
export function codeBlock({ label, code }) {
  return el(
    'div',
    { class: 'code-block' },
    el('div', { class: 'code-head' }, el('span', { class: 'muted', text: label || '示例' })),
    el('pre', { class: 'json', text: code })
  );
}

/** ISO 时间 → 本地可读（账号列表里显示"最近登录"用） */
export function fmtTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso || '');
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
