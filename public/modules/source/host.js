'use strict';
/**
 * 猫爪源模块 · 「猫源地址」页：添加/更新/运行本地猫源，以及每个源行的运行控制。
 *
 * 文案面向**用户**（不写 require/start(config)/DEV_HTTP_PORT 这类实现细节）——
 * 那些是开发者的口径，写在代码注释与 README 里就够了。
 */
import { el, toast, modal, fmtTime } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { S } from '../../core/state.js';
import { loadAll } from '../../core/boot.js';

/* 源进程状态 → 中文（这个页和「配置中心」页都用得上，先放这里） */
const statusText = { stopped: '已停止', starting: '启动中', running: '运行中', stopping: '停止中', error: '异常' };

export function renderSourceBundle(v) {
  const card = el('div', { class: 'card' }, el('h3', { text: '本地猫源' }));
  card.append(el('div', { class: 'actions' }, el('button', { class: 'btn primary', text: '＋ 添加猫源', onclick: openAdd })));

  if (!S.sources.length) {
    card.append(el('div', { class: 'muted', text: '还没有本地猫源。点「添加猫源」填一个可下载 index.js 的地址，面板会下载好并帮你跑起来。' }));
  } else {
    for (const s of S.sources) {
      const st = (s.run && s.run.status) || 'stopped';
      const isHost = S.base && S.base.origin === 'local' && S.base.sourceId === s.id;

      /* 「开机自启」在列表里**看得见、点得动**（以前只在添加时选一次，之后没处看也没处改） */
      const auto = el('input', { type: 'checkbox', checked: !!s.autostart });
      auto.addEventListener('change', async () => {
        try {
          await api('/api/sources/' + s.id, { method: 'PATCH', body: { autostart: auto.checked } });
          s.autostart = auto.checked;
          toast((auto.checked ? '已设为开机自启：' : '已取消开机自启：') + (s.name || s.url));
        } catch (e) {
          auto.checked = !auto.checked;
          toast('保存失败：' + e.message, true);
        }
      });

      card.append(
        el(
          'div',
          { class: 'file-row' },
          el('span', { class: 'dot ' + st }),
          el('span', { class: 'name', text: (s.name || s.url) + (isHost ? '（聚合在用）' : '') }),
          el('span', { class: 'note', text: (statusText[st] || st) + (s.run && s.run.port ? ` :${s.run.port}` : '') }),
          el('label', { class: 'chk', title: '面板/路由器重启后自动把这个源跑起来' }, auto, '开机自启'),
          st === 'running'
            ? el('button', { class: 'btn mini', text: '停止', onclick: () => localAction(s.id, 'stop') })
            : el('button', { class: 'btn mini primary', text: '运行', onclick: () => localAction(s.id, 'start') }),
          el('button', { class: 'btn mini', text: '更新', onclick: () => localAction(s.id, 'update') }),
          el('button', {
            class: 'btn mini danger',
            text: '删除',
            onclick: async () => {
              if (!confirm(`删除本地源 ${s.name || s.url}？（含下载文件与运行数据）`)) return;
              await api('/api/sources/' + s.id, { method: 'DELETE' });
              S.sources = S.sources.filter((x) => x.id !== s.id);
              await loadAll();
              toast('已删除');
            },
          })
        )
      );
      /* 起不来就把原因写在行下面（里面已经带了子进程最后的输出），不必再去翻日志 */
      if (s.run && s.run.error) card.append(el('div', { class: 'note err-note', text: '⚠️ ' + s.run.error }));
    }
  }

  v.append(
    el(
      'div',
      { class: 'hint' },
      '填一个能下载 index.js 的地址就行：面板会下载、校验，然后帮你把它跑起来。跑起来后左侧会多出属于它的「配置中心」；想让它参与聚合搜索，再去「聚合设置 · 源列表」加一次地址。',
      el('br'),
      '源起不来的原因会直接写在那一行下面。'
    ),
    card,
    autoUpdateCard()
  );
}

/**
 * 「自动更新」卡：勾选 + 间隔小时（**默认 12**）+ 上次检查结果 + 「立即检查」。
 *
 * 状态一律现读 `/api/sources/auto-update`（后端那份是权威；设置存 `source.json`，
 * 读的是 `/api/modules/source/settings` —— 不走启动时那份投影，原因见 agg 模块的同名注释）。
 * 定时器的行为（开机后先等 2 分钟、跑完才排下一次、失败下轮再试）都写在 `source/auto-update.js` 顶部。
 */
function autoUpdateCard() {
  const card = el('div', { class: 'card' }, el('h3', { text: '自动更新' }));
  const cb = el('input', { type: 'checkbox' });
  const hours = el('input', { type: 'number', class: 'w-sm', value: '12', min: '1', max: '168' });
  const saveBtn = el('button', { class: 'btn primary', text: '保存' });
  const runBtn = el('button', { class: 'btn', text: '立即检查' });
  const info = el('div', { class: 'note', text: '正在读取…' });

  const summary = (st) => {
    const r = st.results || [];
    const changed = r.filter((x) => x.changed);
    const bad = r.filter((x) => !x.ok);
    if (!st.lastRunAt) return '还没检查过。';
    return (
      `上次检查 ${fmtTime(st.lastRunAt)}：${r.length} 个源` +
      (changed.length ? `，${changed.length} 个有新版（${changed.map((x) => x.name).join('、')}）` : '，都是最新') +
      (bad.length ? `；${bad.length} 个失败：${bad.map((x) => x.name + ' ' + x.error).join('；')}` : '')
    );
  };

  const paint = (st) => {
    cb.checked = !!st.enabled;
    hours.value = String(st.hours || 12);
    info.textContent = st.enabled
      ? `${summary(st)}${st.nextRunAt ? ` 下次：${fmtTime(st.nextRunAt)}。` : ''}`
      : `${summary(st)}自动更新已关闭。`;
  };

  const load = async () => {
    try {
      paint(await api('/api/sources/auto-update'));
    } catch (e) {
      info.textContent = '读取自动更新状态失败：' + e.message;
    }
  };

  saveBtn.addEventListener('click', async () => {
    const h = Number(hours.value);
    if (!(h >= 1 && h <= 168)) return toast('间隔填 1~168 小时', true);
    saveBtn.disabled = true;
    try {
      await api('/api/modules/source/settings', {
        method: 'PUT',
        body: { settings: { autoUpdate: cb.checked, autoUpdateHours: h } },
      });
      toast(cb.checked ? `已开启自动更新：每 ${h} 小时检查一次` : '已关闭自动更新');
      await load();
    } catch (e) {
      toast('保存失败：' + e.message, true);
    } finally {
      saveBtn.disabled = false;
    }
  });

  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    runBtn.textContent = '检查中…';
    try {
      const r = await api('/api/sources/auto-update/run', { method: 'POST' });
      paint(r);
      const changed = (r.results || []).filter((x) => x.changed);
      toast(changed.length ? `有新版：${changed.map((x) => x.name).join('、')}` : '检查完成，都是最新');
      /* 真的换了文件（可能还重启了源）→ 把上面的源列表也刷新一下，别让人看着旧状态 */
      if (changed.length) await loadAll();
    } catch (e) {
      toast('检查失败：' + e.message, true);
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = '立即检查';
    }
  });

  card.append(
    el(
      'div',
      { class: 'row' },
      el('label', { class: 'chk', title: '每隔一段时间检查本地猫源有没有新版（比对官网 index.js.md5），有就下载并重启' }, cb, '自动更新'),
      el('label', { class: 'chk', title: '多久检查一次，1~168 小时' }, hours, '小时'),
      saveBtn,
      runBtn
    ),
    info,
    el('div', {
      class: 'note',
      text:
        '每隔这么久给每个本地猫源探一次远端文件（只比对 md5，没变就不下载）；有新版会下载、校验，该源正在运行时会自动重启。' +
        '开着面板后先等 2 分钟才跑第一次。单个源失败只会记进日志，下一轮再试。',
    })
  );

  load();
  return card;
}

/** 「添加猫源」模态框（填地址 → 下载校验 → 落到本地并托管） */
function openAdd() {
  const urlInput = el('input', { type: 'text', placeholder: '可下载 index.js 的猫源地址，如 https://example.com/cat/index.js', spellcheck: 'false' });
  const nameInput = el('input', { type: 'text', placeholder: '备注名（可选，多个源时方便区分）' });
  const autoCb = el('input', { type: 'checkbox', checked: true });
  const tip = el('div', { class: 'note' });

  modal({
    title: '添加猫源',
    body: [
      el('div', { class: 'field' }, el('label', { text: '猫源地址' }), urlInput),
      el('div', { class: 'field' }, el('label', { text: '备注名' }), nameInput),
      el('label', { class: 'chk' }, autoCb, '开机自启（面板重启后自动运行）'),
      tip,
    ],
    actions: [
      { label: '取消' },
      {
        label: '下载并托管',
        primary: true,
        onclick: async () => {
          const url = urlInput.value.trim();
          if (!url) {
            tip.textContent = '请填写可下载 index.js 的猫源地址';
            urlInput.focus();
            return false;
          }
          tip.textContent = '正在下载并校验…（大源要十几秒）';
          try {
            const r = await api('/api/sources', { method: 'POST', body: { url, name: nameInput.value.trim(), autostart: autoCb.checked } });
            toast(`已添加猫源：${r.source.name || url}`);
            await loadAll();
          } catch (e) {
            tip.textContent = '添加失败：' + e.message;
            return false; // 窗口留着，地址不用重填
          }
        },
      },
    ],
  });
}

/** 本地托管源的 运行 / 停止 / 更新（源行上的按钮）；改完要重拉全局数据 */
async function localAction(id, kind) {
  try {
    if (kind === 'update') {
      toast('检查更新中…');
      const r = await api(`/api/sources/${id}/update`, { method: 'POST', body: {} });
      /* 下载后校验不过：残留已被删掉，这个源起不来 —— 如实显示，不假装成功 */
      if (r.ok === false || r.md5Mismatch) {
        toast(r.error || '源文件校验不通过（下载的残留已删除，该源无法运行）', true);
      } else {
        toast(r.changed ? '已更新源文件' + (r.restarted ? ' 并重启' : '') : '已是最新（md5 未变）');
      }
    } else {
      const r = await api(`/api/sources/${id}/${kind}`, { method: 'POST', body: {} });
      /* 启动是**立刻返回**的（端口就绪的等待移到后台），所以按真实状态说话 ——
       * 不能一口咬定「已启动」：起不来的源 25 秒后会翻成「异常」并写明原因（5 秒轮询会自动刷出来）。 */
      const st = (r && r.run && r.run.status) || '';
      toast(kind === 'start' ? (st === 'running' ? '已启动' : '正在启动…（就绪后状态会自动刷新）') : '已停止');
    }
    await loadAll();
  } catch (e) {
    toast(e.message, true);
  }
}
