'use strict';
/**
 * Emby 模块 · 「连接设置」页：**两张卡片** ——
 *   ① 服务器名（握手时对外自称的名字，客户端「服务器列表」里显示的就是它）
 *   ② 账号管理（客户端登录用的多个账号，存 sqlite）
 *   （原先的「播放设置」卡已整张撤掉：拉流一律 302、没有可选项；**线路过滤搬到
 *    「聚合设置 → 聚合参数」**了 —— 线路是聚合层产出的东西，设置跟着它走。）
 *
 * 不在这里显示的三样：
 *   · **聚合地址** —— emby 层与聚合层同进程，直接进程内调用（`agg/api.js`），
 *     既没得填也没得改（走 HTTP 会撞面板门禁，见那个文件顶部）；
 *   · **TMDB 设置** —— 搬到「面板设置 → 设置」：那是 emby 与聚合层**共享**的配置，
 *     而依赖是单向的，聚合层读不到 emby 的东西（见 `core/tmdb.js`）；
 *   · **缓存设置** —— 也搬到「面板设置」：缓存跨两个库
 *     （core 的 `data/cache/tmdb.db` + 这里的 `data/emby/cache.db`），用量/清空/淘汰
 *     得一把抓两个，放在面板层才不会"面板管一半、模块管一半"。
 */
import { el, toast, modal, fmtTime, copy } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { S } from '../../core/state.js';
import { renderPage } from '../../core/shell.js';
import { BRAND } from '../../core/branding.js';

/**
 * Emby 层是「消费层」：它**进程内**调聚合层（`server/modules/agg/api.js`），
 * 所以「聚合地址」既不是可改设置、也不该在页面上占一张卡。
 * 其余设置读写走通用端点 /api/modules/emby/settings。
 */
export async function renderEmbySetup(v) {
  if (!S.emby.settings) {
    v.append(el('div', { class: 'muted', text: '正在读取 Emby 模块设置…' }));
    try {
      S.emby.settings = (await api('/api/modules/emby/settings')).settings;
    } catch (e) {
      v.textContent = '';
      v.append(el('div', { class: 'hint warn', text: '读取 Emby 设置失败：' + e.message }));
      return;
    }
    v.textContent = '';
  }

  /* ---- 账号管理：Emby 客户端登录用的多个账号（存 sqlite，密码只有 scrypt 哈希） ---- */
  let accounts = S.emby.accounts;
  let accErr = '';
  if (!accounts) {
    try {
      accounts = (await api('/api/emby/accounts')).accounts || [];
      S.emby.accounts = accounts;
    } catch (e) {
      accounts = [];
      accErr = e.message; // 老 Node 上没有内置 sqlite 时会走到这（db.js 会给一句人话报错）
    }
  }

  async function afterAccountChange(msg) {
    S.emby.accounts = null; // 让下一次渲染重新拉
    toast(msg);
    renderPage();
  }

  function accountRow(a) {
    const when = a.lastLoginAt ? '最近登录 ' + fmtTime(a.lastLoginAt) + (a.lastClient ? ' · ' + a.lastClient : '') : '还没登录过';
    const row = el(
      'div',
      { class: 'file-row' },
      el('span', { class: 'dot running' }),
      el('span', { class: 'name', text: a.username }),
      el('span', { class: 'note', text: when })
    );

    const pw = el('input', { type: 'password', autocomplete: 'new-password', placeholder: '新密码（≥6 位）', style: 'display:none' });
    const editBtn = el('button', { class: 'btn mini', text: '改密' });
    const saveBtn = el('button', { class: 'btn mini primary', text: '保存', style: 'display:none' });
    const cancelBtn = el('button', { class: 'btn mini', text: '取消', style: 'display:none' });
    const editing = (on) => {
      for (const n of [pw, saveBtn, cancelBtn]) n.style.display = on ? '' : 'none';
      editBtn.style.display = on ? 'none' : '';
    };
    editBtn.addEventListener('click', () => editing(true));
    cancelBtn.addEventListener('click', () => {
      pw.value = '';
      editing(false);
    });
    saveBtn.addEventListener('click', async () => {
      if (pw.value.length < 6) return toast('密码至少 6 位', true);
      saveBtn.disabled = true;
      try {
        await api('/api/emby/accounts/' + a.id, { method: 'PUT', body: { password: pw.value } });
        await afterAccountChange('已改密：' + a.username + '（该账号客户端需重新登录）');
      } catch (e) {
        toast('改密失败：' + e.message, true);
        saveBtn.disabled = false;
      }
    });
    const delBtn = el('button', {
      class: 'btn mini danger',
      text: '删除',
      onclick: async () => {
        if (!confirm(`删除账号 ${a.username}？该账号的客户端会立刻失效。`)) return;
        try {
          await api('/api/emby/accounts/' + a.id, { method: 'DELETE' });
          await afterAccountChange('已删除账号：' + a.username);
        } catch (e) {
          toast('删除失败：' + e.message, true);
        }
      },
    });
    row.append(pw, editBtn, saveBtn, cancelBtn, delBtn);
    return row;
  }

/** 「添加账号」模态框 —— 和「猫源地址」页的添加一个形态：填完提交，校验不过不关窗 */
  function openAddAccount() {
    const name = el('input', { type: 'text', spellcheck: 'false', placeholder: '用户名（客户端里填这个）' });
    const pass = el('input', { type: 'password', autocomplete: 'new-password', placeholder: '密码（≥6 位）' });
    const show = el('input', { type: 'checkbox' });
    show.addEventListener('change', () => {
      pass.type = show.checked ? 'text' : 'password';
    });
    const tip = el('div', { class: 'note' });

    modal({
      title: '添加 Emby 账号',
      body: [
        el('div', { class: 'field' }, el('label', { text: '用户名' }), name),
        el('div', { class: 'field' }, el('label', { text: '密码' }), pass),
        el('label', { class: 'chk' }, show, '显示密码'),
        tip,
      ],
      actions: [
        { label: '取消' },
        {
          label: '添加账号',
          primary: true,
          onclick: async () => {
            const username = name.value.trim();
            if (!username) {
              tip.textContent = '请填写用户名';
              return false;
            }
            if (pass.value.length < 6) {
              tip.textContent = '密码至少 6 位';
              return false;
            }
            try {
              await api('/api/emby/accounts', { method: 'POST', body: { username, password: pass.value } });
            } catch (e) {
              tip.textContent = '添加失败：' + e.message;
              return false; // 窗口留着，用户名不用重填
            }
            await afterAccountChange('已添加账号：' + username);
          },
        },
      ],
    });
  }

  const accountCard = el(
    'div',
    { class: 'card' },
    el('h3', { text: '账号管理' }),
    el('p', {
      class: 'note',
      text: '客户端登录用这里的账号，可以加多个。密码忘了找不回来（只能删掉重建）；改密或删号之后，那些客户端要重新登录一次。',
    }),
    el('div', { class: 'actions' }, el('button', { class: 'btn primary', text: '＋ 添加账号', onclick: openAddAccount })),
    ...(accounts.length ? accounts.map(accountRow) : [el('div', { class: accErr ? 'hint warn' : 'muted', text: accErr ? '读取账号失败：' + accErr : '还没有账号 —— 客户端登录会返回 401，点上面的「＋ 添加账号」加一个。' })]),
  );

  /* ---- 播放设置那张卡**整张挪走了** ----
   * · **线路过滤**（正则，只匹配线路名）→ 搬到「聚合设置 → 聚合参数」：线路是聚合层产出的东西，
   *   过滤规则与它放在一起才不会"配置在 A、生效在 B"；
   *   老值由 server.js 启动时从 `emby.json` 的 `play.filter` 搬一次到 `agg.json` 的 `lineFilter`。
   * · 「拉流方式」也早已没有可选项（**一律 302**，面板不扛流量，见 service.redirectUrl）。
   * 所以这一页现在只剩两张卡：服务器名 / 账号管理。 */

  /* ---- 缓存设置**不在这里**了（搬到「面板设置 → 缓存设置」）----
   * 缓存现在跨两个库（core 的 tmdb.db 与 emby 的 cache.db），用量/清空/淘汰要一把抓两个，
   * 所以设置与按钮都归面板层。 */

  /* ---- 服务器名：握手时对外自称的名字（客户端「服务器列表」里显示的就是它）---- */
  const nameInput = el('input', {
    type: 'text',
    value: S.emby.settings.serverName || '',
    spellcheck: 'false',
    placeholder: `默认 ${BRAND.embyServerName}`,
  });
  const nameBtn = el('button', { class: 'btn primary', text: '保存' });
  nameBtn.addEventListener('click', async () => {
    nameBtn.disabled = true;
    try {
      const r = await api('/api/modules/emby/settings', {
        method: 'PUT',
        body: { settings: { serverName: nameInput.value.trim() } },
      });
      S.emby.settings = r.settings;
      toast('已保存：' + (nameInput.value.trim() || `${BRAND.embyServerName}（默认）`));
      renderPage();
    } catch (e) {
      toast('保存失败：' + e.message, true);
    } finally {
      nameBtn.disabled = false;
    }
  });
  const serverNameCard = el(
    'div',
    { class: 'card' },
    el('h3', { text: '服务器名' }),
    el('div', {
      class: 'note',
      text: `客户端里显示的服务器名。留空用默认的「${BRAND.embyServerName}」；改完客户端可能要重连一次才更新。`,
    }),
    el('div', { class: 'row' }, nameInput, nameBtn)
  );

  /* ---- 客户端怎么连：把要填的地址写在这一页（README 那份是给还没进来的人看的）----
   * 只显示**主机**（协议+主机+端口，就是这个页面的地址），不列别的网卡、不加别的后缀 ——
   * 它一定通（否则这页都打不开）。客户端会自己去打 `/emby/...`，面板两种前缀都收
   * （`/emby/**` 会被归一成 `/api/emby/**`，见 server.js 顶部那段）。 */
  const connectUrl = (() => {
    const u = new URL(location.href);
    return u.origin;
  })();
  const connectCard = el(
    'div',
    { class: 'card' },
    el('h3', { text: '客户端怎么连' }),
    el('p', {
      class: 'note',
      text: 'Emby 客户端「添加服务器 / 添加媒体服务器」时，地址填这个；账号密码用下面「账号管理」里建的那个，服务器名见再下面那张卡。',
    }),
    el(
      'div',
      { class: 'row' },
      el('code', { text: connectUrl }),
      el('button', { class: 'btn mini', text: '复制', onclick: () => copy(connectUrl) })
    ),
    el('p', {
      class: 'note',
      text: '就填主机（客户端自己会补 `/emby`，面板两种都收）。如果哪个客户端死活连不上，把地址换成它后面加 `/api/emby` 再试。另外 9988-9998 是「源托管」里那些源实例用的，客户端不用管。',
    })
  );

  v.append(connectCard, serverNameCard, accountCard);
}

