'use strict';
/**
 * 面板鉴权（前端侧）：登录框、状态查询、退出、改密码。
 *
 * 会话是后端签发的 **HttpOnly cookie**，前端读不到也不该读 —— 所以这里不存任何 token，
 * 只做三件事：问后端当前登录状态、没登就弹登录框、登录成功就刷新整页。
 *
 * **不 import `core/api.js`**（那边反过来要 import 本文件的 `onUnauthorized`）——
 * 用原生 fetch 收发，避免模块循环。
 */

import { BRAND } from './branding.js'; // 登录页要显示面板名（名字只有那一处）

const $ = (sel) => document.querySelector(sel);

/** 后端默认密码（只用于界面提示，不参与任何校验） */
export const DEFAULT_PASSWORD = '123456';

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data: data || {} };
}

/** 问后端当前登录状态（**这个端点不需要登录**） */
export async function authStatus() {
  try {
    const res = await fetch('/api/auth/status');
    if (!res.ok) return { authed: false, isDefault: false, unknown: true };
    return Object.assign({ authed: false, isDefault: false }, await res.json());
  } catch {
    /* 后端都连不上：当作"未登录"，登录框里的报错会说明问题 */
    return { authed: false, isDefault: false, unreachable: true };
  }
}

/* ------------------------------------------------------------------ 登录框 */

let shown = null;

/**
 * 画登录框（整页遮罩）。同一个页面里只会有一个 —— 重复调用不叠。
 * `reason` 是登录框上显示的原因（会话过期 / 刚被拦下 / 密码改了）。
 */
export function renderLogin(reason) {
  if (shown) {
    if (reason) {
      const tip = shown.querySelector('.auth-tip');
      if (tip) tip.textContent = reason;
    }
    const inp = shown.querySelector('input');
    if (inp) inp.focus();
    return;
  }

  const input = document.createElement('input');
  input.type = 'password';
  input.placeholder = '面板密码';
  input.autocomplete = 'current-password';
  input.id = 'panelPassword';

  const tip = document.createElement('div');
  tip.className = 'note auth-tip';
  tip.textContent = reason || '';

  const hint = document.createElement('div');
  hint.className = 'note';
  hint.textContent = `默认密码 ${DEFAULT_PASSWORD}（登录后请到「面板设置」改掉）`;

  const btn = document.createElement('button');
  btn.className = 'btn primary';
  btn.textContent = '登录';

  const form = document.createElement('form');
  form.className = 'auth-form';
  form.append(input, btn);

  const card = document.createElement('div');
  card.className = 'auth-card';
  const h = document.createElement('h2');
  h.textContent = BRAND.panelName; // 名字读 core/branding.js（不摆图标）
  card.append(h, form, tip, hint);

  const mask = document.createElement('div');
  mask.className = 'auth-mask';
  mask.append(card);
  document.body.append(mask);
  shown = mask;
  setTimeout(() => input.focus(), 30);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!input.value) {
      tip.textContent = '请输入密码';
      return;
    }
    btn.disabled = true;
    btn.textContent = '登录中…';
    const r = await post('/api/auth/login', { password: input.value });
    btn.disabled = false;
    btn.textContent = '登录';
    if (r.ok) {
      location.reload(); // 拿全新状态重开一遍（cookie 已种下）
      return;
    }
    tip.textContent = (r.data && r.data.error) || '登录失败';
    input.select();
  });
}

/** 数据接口回 401 时被 `core/api.js` 调 —— 把登录框弹出来 */
export function onUnauthorized(reason) {
  renderLogin(reason || '会话已过期，请重新登录');
}

/**
 * 启动时先过这一关：登着 → true；没登 → 弹登录框并返回 false（调用方就别再拉数据了）。
 */
export async function ensureAuth() {
  const st = await authStatus();
  if (st.authed) return true;
  renderLogin(st.unreachable ? '连不上面板后端，请确认服务在跑' : '请输入面板密码');
  return false;
}

export async function logout() {
  await post('/api/auth/logout', {});
  location.reload();
}

/** 改密码（成功后后端会清掉当前 cookie —— 调用方负责回到登录页） */
export async function changePassword(oldPassword, newPassword) {
  const r = await post('/api/auth/password', { oldPassword, newPassword });
  if (!r.ok) throw new Error((r.data && r.data.error) || '修改失败');
  return true;
}
