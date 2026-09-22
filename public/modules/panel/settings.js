'use strict';
/**
 * 面板模块 · 「设置」页：面板自己的设置（跟「概览」分开 —— 概览只看环境，这里动设置）。
 *
 *   · 版本与更新     面板自身按 Release 更新，安装后重启应用进程生效（GET|POST /api/panel/update，
 *                    恢复判据是 /api/meta 的 version 变化；见 docs/adr/0019）
 *   · 配置备份与还原 导出直接下载 .json；还原选一个 .json 文件（GET /api/panel/backup · POST /api/panel/restore）
 *   · TMDB 设置      **共享配置**：emby 层（元数据反查）与聚合层（同名失败时按名字反查）都用它
 *                    存 `panel.json` 的 `tmdb.*`，自检端点 `/api/panel/tmdb/test`（见 core/tmdb.js）
 *   · 缓存设置       **跨两个库**的用量与清空（`data/cache/tmdb.db` + `data/emby/cache.db`），
 *                    端点 `GET|DELETE /api/panel/cache`，策略存 `panel.json` 的 `cache.*`（见 core/cachedb.js）
 *   · 面板密码        改密码（见 core/auth.js）+ 退出登录
 */
import { el, toast, fmtTime } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { S } from '../../core/state.js';
import { authStatus, changePassword, logout } from '../../core/auth.js';
import { loadAll } from '../../core/boot.js';
import { renderPage } from '../../core/shell.js';

/* -------------------------------------------------------------- 版本与更新 */

/** 重启后的轮询节奏：间隔与总时限。重启时段内请求会被拒绝，属预期，不按错误处理。 */
const UPDATE_POLL_MS = 2000;
const UPDATE_POLL_LIMIT_MS = 60000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 等面板重启完成：轮询 `/api/meta`，直到版本号与重启前不同。
 *
 * 返回新版本号；超过时限仍未取到则返回 null。请求失败一律继续等 —— 应用进程重启的那几秒
 * 连接会被拒绝，只有"能取到响应且版本已变"才算真的起来了。`/api/meta` 的 `version` 取自
 * 运行中的 `package.json`，因此它同时是"新版本是否真的在跑"的判据，而不是只看进程存活。
 */
async function waitRestart(prevVersion) {
  const deadline = Date.now() + UPDATE_POLL_LIMIT_MS;
  while (Date.now() < deadline) {
    await sleep(UPDATE_POLL_MS);
    let meta = null;
    try {
      meta = await api('/api/meta');
    } catch {
      continue; // 面板还没起来
    }
    const v = meta && meta.version;
    if (v && v !== prevVersion) return v;
  }
  return null;
}

/**
 * 版本与更新卡。面板自身按 Release 安装新版本、重启应用进程生效（见 docs/adr/0019）。
 *
 * 数据来自 `GET /api/panel/update`，安装走 `POST /api/panel/update`。非受管运行方式
 * （直接跑源码、或进程不是由容器的监督者拉起）如实拒绝自更新：那种情况下没有可写回的
 * 安装目录，也没有重启后拉起新版本的监督者。
 *
 * 打开页面即查一次（摘要要如实显示"最新版本"只能来自这次请求），之后由「检查更新」手动触发。
 */
function updateCard() {
  /* 三行摘要先占「未知」：请求整体失败时仍有可读的摘要，不留空白 */
  const cur = el('span', { class: 'v', text: '未知' });
  const latest = el('span', { class: 'v', text: '未知' });
  const mode = el('span', { class: 'v', text: '未知' });
  const check = el('button', { class: 'btn', text: '检查更新' });
  const install = el('button', { class: 'btn primary hidden' });
  const result = el('div', { class: 'hint' });
  const versions = el('div', { class: 'note' });
  let last = null; // 最近一次 GET /api/panel/update 的结果

  const showResult = (cls, lines) => {
    result.className = cls;
    result.replaceChildren(...lines.map((t) => el('div', { text: t })));
  };

  const paint = (r) => {
    last = r;
    cur.textContent = r.current || '未知';
    latest.textContent = r.latest || '未知';
    mode.textContent = r.managed ? '受管（由容器引导）' : '非受管';
    const inst = Array.isArray(r.installed) ? r.installed : [];
    versions.textContent =
      (inst.length ? `已安装：${inst.join(' / ')}` : '已安装：未知') + (r.previous ? ` · 上一版：${r.previous}` : '');

    const hasNew = !!(r.hasUpdate && r.latest);
    install.classList.toggle('hidden', !hasNew);
    install.disabled = !r.managed; // 非受管时不给按，避免按下去才报错
    if (hasNew) install.textContent = `更新到 ${r.latest}`;

    const lines = [];
    let cls = 'hint';
    if (!r.managed) {
      cls = 'hint warn';
      lines.push('当前不是由容器引导的运行方式，面板不能自更新。');
    } else if (hasNew) {
      lines.push(`有新版本 ${r.latest}（当前 ${r.current}）。`);
    } else if (!r.error) {
      lines.push(`已是最新（${r.current || '未知'}）。`);
    }
    if (r.error) {
      /* 排障信息原样带出，不吞 */
      cls = 'hint warn';
      lines.push('检查更新失败：' + r.error);
    }
    showResult(cls, lines);
  };

  const load = async (loud) => {
    check.disabled = true;
    check.innerHTML = '<span class="spinner"></span> 检查中…';
    try {
      paint(await api('/api/panel/update'));
    } catch (e) {
      showResult('hint warn', ['检查更新失败：' + e.message]);
      if (loud) toast('检查更新失败：' + e.message, true);
    } finally {
      check.disabled = false;
      check.textContent = '检查更新';
    }
  };

  check.addEventListener('click', () => load(true));

  install.addEventListener('click', async () => {
    const target = (last && last.latest) || '';
    if (!target) return;
    if (
      !confirm(
        `更新到 ${target}？\n\n面板会下载并安装这个版本，然后重启应用进程（容器不停）。\n重启期间页面会短暂打不开，通常几秒内恢复。`
      )
    ) {
      return;
    }
    const prev = (last && last.current) || '';
    check.disabled = true;
    install.disabled = true;
    showResult('hint', [`正在安装 ${target}…`]);
    try {
      const r = await api('/api/panel/update', { method: 'POST', body: { version: target } });
      const ver = r.installed || target;
      toast(`已安装 ${ver}，面板正在重启`);
      showResult('hint', [`已安装 ${ver}，面板正在重启，页面会在几秒后自动恢复。`]);
      const now = await waitRestart(prev);
      if (now) {
        toast(`已更新到 ${now}`);
        showResult('hint', [`已更新到 ${now}，正在刷新页面…`]);
        setTimeout(() => location.reload(), 1500); // 留出看提示的时间，再取新版本的前端资源
        return;
      }
      const timeoutMsg = `面板未在 ${UPDATE_POLL_LIMIT_MS / 1000} 秒内恢复，请查看容器日志。`;
      showResult('hint warn', [timeoutMsg]);
      toast(timeoutMsg, true);
    } catch (e) {
      showResult('hint warn', ['更新失败：' + e.message]);
      toast('更新失败：' + e.message, true);
    }
    check.disabled = false;
    install.disabled = false;
  });

  const card = el(
    'div',
    { class: 'card' },
    el('h3', { text: '版本与更新' }),
    el('p', {
      class: 'note',
      text: '面板可以从 Release 安装新版本，安装后应用进程会重启（容器不停）。更新只由你手动触发，不会在后台自动进行。',
    }),
    el('div', { class: 'kv' }, el('span', { class: 'k', text: '当前版本' }), cur),
    el('div', { class: 'kv' }, el('span', { class: 'k', text: '最新版本' }), latest),
    el('div', { class: 'kv' }, el('span', { class: 'k', text: '运行方式' }), mode),
    el('div', { class: 'row' }, check, install),
    result,
    versions
  );
  load(false);
  return card;
}

/* -------------------------------------------------------------- 备份与还原 */

function backupCard() {
  const out = el('div', { class: 'note' });
  const exportBtn = el('button', { class: 'btn primary', text: '导出备份' });
  const pickBtn = el('button', { class: 'btn', text: '选择文件还原' });
  const picked = el('span', { class: 'note' });
  /* 隐藏的 file input：点「选择文件还原」时打开系统选文件框 */
  const fileInput = el('input', { type: 'file', accept: '.json,application/json', class: 'hidden' });

  function fileName(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `catpaw-panel-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
  }

  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    try {
      const b = await api('/api/panel/backup');
      const text = JSON.stringify(b, null, 2);
      const name = fileName(new Date());
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = el('a', { href: url, download: name });
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      const mods = Object.keys(b.settings || {});
      out.className = 'note';
      out.textContent = `已导出 ${name}（${mods.length} 个模块设置）· ${fmtTime(b.exportedAt)}`;
      toast('已导出 ' + name);
    } catch (e) {
      out.className = 'note err-note';
      out.textContent = '导出失败：' + e.message;
    } finally {
      exportBtn.disabled = false;
    }
  });

  pickBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = ''; // 允许重复选同一个文件
    if (!file) return;
    picked.textContent = '已选择：' + file.name;

    let parsed = null;
    try {
      parsed = JSON.parse(await file.text());
    } catch (e) {
      out.className = 'note err-note';
      out.textContent = '这个文件不是备份 JSON：' + e.message;
      return;
    }
    const mods = Object.keys((parsed && parsed.settings) || {});
    if (!mods.length) {
      out.className = 'note err-note';
      out.textContent = '这个文件里没有面板设置';
      return;
    }
    /* 覆盖当前设置、不可撤销 —— 先把"覆盖哪些"说清楚再确认 */
    if (!confirm(`用「${file.name}」覆盖当前设置？\n\n会被覆盖：${mods.join(' / ')}\n（源列表不受影响）`)) return;

    pickBtn.disabled = true;
    try {
      await api('/api/panel/restore', { method: 'POST', body: parsed });
      /* loadAll 会重画这一页（把当前 DOM 换掉），所以结果用 toast 说 —— 写在页面里会被冲掉 */
      toast('已还原：' + mods.join(' / '));
      await loadAll(); // 让界面上的设置立刻跟上（不然显示的还是旧值）
    } catch (e) {
      out.className = 'note err-note';
      out.textContent = '还原失败：' + e.message;
    } finally {
      pickBtn.disabled = false;
    }
  });

  return el(
    'div',
    { class: 'card' },
    el('h3', { text: '配置备份与还原' }),
    el('p', { class: 'note', text: '备份包含你在面板里改过的全部设置。还原会用备份里的值覆盖当前设置，建议先导出一份放着。' }),
    el('div', { class: 'toolbar' }, exportBtn, pickBtn, picked, fileInput),
    out
  );
}

/* ------------------------------------------------------------------ TMDB 设置 */

/**
 * TMDB 测试失败的「大类」—— 一眼分清是**网不通**还是**没配对**。
 * 错误码由后端给（`core/tmdb.js` 的 classify / test）。
 */
function tmdbErrKind(err) {
  const code = (err && err.code) || '';
  if (code === 'TIMEOUT' || code === 'NETWORK') return '网络错误';
  if (code === 'UPSTREAM_HTTP' && Number(err.status) >= 500) return '上游故障';
  return '配置错误';
}

/** 大类 → 一句人话（先说该去看哪儿） */
const TMDB_ERR_HINT = {
  网络错误: '面板连不上 TMDB（网络不通，或者基地址填错了）。',
  上游故障: 'TMDB 自己回错了（5xx），跟面板设置无关，过会儿再试。',
  配置错误: 'Token 或基地址不对，看下面的码与说明。',
};

/** 渲染 TMDB 测试结果（不回显 token） */
function paintTmdbTest(box, r) {
  box.classList.toggle('warn', !r.ok);
  box.textContent = '';
  if (!r.ok) {
    const kind = tmdbErrKind(r.error);
    box.append(
      el(
        'div',
        { class: 'kv' },
        el('span', { class: 'k', text: '失败类型' }),
        el('span', { class: 'v', text: kind + ' —— ' + (TMDB_ERR_HINT[kind] || '') })
      ),
      `✘ ${r.error.code}：${r.error.message}`,
      el('br'),
      `基地址 ${r.apiBase} · Token ${r.tokenSet ? `已填（${r.tokenLength} 字符）` : '未填'}`
    );
    return;
  }
  const it = r.item;
  const title = it.title + (it.year ? `（${it.year}）` : '');
  box.append(
    el(
      'div',
      { class: 'kv' },
      el('span', { class: 'k', text: '反查结果' }),
      el('span', {
        class: 'v',
        text: title + (it.originalTitle && it.originalTitle !== it.title ? ' · ' + it.originalTitle : ''),
      })
    ),
    el('div', { class: 'kv' }, el('span', { class: 'k', text: '鉴权 / 耗时' }), el('span', { class: 'v', text: `HTTP ${r.auth.status} · ${r.elapsedMs}ms · ${r.language}` })),
    el('div', { class: 'kv' }, el('span', { class: 'k', text: '图片基地址' }), el('span', { class: 'v', text: `${r.imageBase}　（TMDB 官方给的是 ${r.images.secureBaseUrl || '-'}）` }))
  );
  if (it.poster) box.append(el('img', { src: it.poster, alt: 'poster', class: 'poster-sm' }));
  if (it.overview) box.append(el('div', { class: 'note', text: it.overview }));
}

function tmdbCard() {
  const t = (S.panel.settings || {}).tmdb || {};
  const tokInput = el('input', {
    type: 'password',
    value: t.token || '',
    autocomplete: 'new-password',
    placeholder: 'v4 API Read Access Token（Bearer）',
  });
  const showTok = el('input', { type: 'checkbox' });
  showTok.addEventListener('change', () => {
    tokInput.type = showTok.checked ? 'text' : 'password';
  });
  const apiInput = el('input', {
    type: 'text',
    value: t.apiBase || '',
    spellcheck: 'false',
    placeholder: '留空 = 官方 https://api.themoviedb.org/3',
  });
  const imgInput = el('input', {
    type: 'text',
    value: t.imageBase || '',
    spellcheck: 'false',
    placeholder: '留空 = 官方 https://image.tmdb.org/t/p',
  });
  const langInput = el('input', { type: 'text', value: t.language || '', spellcheck: 'false', placeholder: 'zh-CN' });
  const save = el('button', { class: 'btn primary', text: '保存' });
  const test = el('button', { class: 'btn', text: '测试' });
  const out = el('div', { class: 'hint' });

  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const r = await api('/api/modules/panel/settings', {
        method: 'PUT',
        body: {
          settings: {
            tmdb: {
              token: tokInput.value.trim(),
              apiBase: apiInput.value.trim(),
              imageBase: imgInput.value.trim(),
              language: langInput.value.trim(),
            },
          },
        },
      });
      S.panel.settings = r.settings;
      toast('TMDB 设置已保存');
      renderPage();
    } catch (e) {
      toast('保存失败：' + e.message, true);
    } finally {
      save.disabled = false;
    }
  });

  test.addEventListener('click', async () => {
    test.disabled = true;
    test.innerHTML = '<span class="spinner"></span> 测试中…';
    try {
      /* 用界面上当前的输入值，不必先保存；探测对象固定为日志里客户端要过的 tmdb 95350（剧集） */
      const r = await api('/api/panel/tmdb/test', {
        method: 'POST',
        body: {
          token: tokInput.value.trim(),
          apiBase: apiInput.value,
          imageBase: imgInput.value,
          language: langInput.value,
          tmdbId: 95350,
          type: 'tv',
        },
      });
      S.panel.tmdbTest = r;
      paintTmdbTest(out, r);
      toast(r.ok ? `TMDB 正常：${r.item.title}（${r.elapsedMs}ms）` : '测试失败：' + tmdbErrKind(r.error), !r.ok);
    } catch (e) {
      toast('测试失败：' + e.message, true);
    } finally {
      test.disabled = false;
      test.textContent = '测试';
    }
  });

  if (S.panel.tmdbTest) paintTmdbTest(out, S.panel.tmdbTest);

  return el(
    'div',
    { class: 'card' },
    el('h3', { text: 'TMDB 设置' }),
    el('p', {
      class: 'note',
      text:
        '元数据来自 TMDB：填一个 v4 Read Access Token（不填就没有元数据）。直连不通时可以把基地址换成镜像；Token 以明文存在面板里，别外传。' +
        '这份设置是共享的：Emby 层按 tmdb id 取元数据、聚合层在同名失败时按名字反查 tmdb id，都用它。',
    }),
    el('div', { class: 'row' }, tokInput, el('label', { class: 'chk' }, showTok, '显示'), save, test),
    el('div', { class: 'row' }, apiInput, imgInput, el('div', { class: 'field narrow' }, langInput)),
    out
  );
}

/** 设置要异步读一次，所以先占位再把卡换进去（页面本身是同步渲染的） */
async function tmdbSection(v) {
  const holder = el('div');
  v.append(holder);
  const placeholder = () =>
    el('div', { class: 'card' }, el('h3', { text: 'TMDB 设置' }), el('div', { class: 'muted', text: '正在读取面板设置…' }));
  holder.append(placeholder());
  try {
    if (!S.panel.settings) S.panel.settings = (await api('/api/modules/panel/settings')).settings;
  } catch (e) {
    holder.replaceChildren(
      el('div', { class: 'card' }, el('h3', { text: 'TMDB 设置' }), el('div', { class: 'hint warn', text: '读取面板设置失败：' + e.message }))
    );
    return;
  }
  holder.replaceChildren(tmdbCard());
}

/* ------------------------------------------------------------------ 缓存设置 */

/** 字节数 → 人话（用量显示用） */
function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}

/**
 * 缓存设置（从「Emby → 连接设置」搬来）。
 *
 * 为什么归面板：缓存现在跨**两个库** —— core 的 `data/cache/tmdb.db`（TMDB 元数据 + 名字索引，
 * agg 与 emby 共用）与 `data/emby/cache.db`（图片索引，emby 自用）。用量显示、清空、上限
 * 一把抓两个才可能不出错，所以设置、按钮、端点在面板层（`GET|DELETE /api/panel/cache`）。
 */
function cacheCard() {
  const c = (S.panel.settings || {}).cache || {};
  /* 这几个是**默认值**，改了就落盘；留空/非数字由后端兜底回默认 */
  const cnum = (key, dflt) =>
    el('input', { type: 'text', value: String(c[key] === undefined || c[key] === null ? dflt : c[key]), class: 'w-sm' });
  const cTtlDays = cnum('tmdbTtlDays', 30);
  const cTtlMB = cnum('tmdbMaxMB', 200);
  const cImgDays = cnum('imageTtlDays', 90);
  const cImgMB = cnum('imageMaxMB', 5);
  const cDetMin = cnum('detailTtlMinutes', 60);
  const cDetForever = el('input', { type: 'checkbox' });
  cDetForever.checked = !!c.detailNeverExpire;
  const out = el('div', { class: 'hint', text: '正在读取用量…' });
  const save = el('button', { class: 'btn primary', text: '保存' });
  const clear = el('button', { class: 'btn', text: '清空缓存' });

  /** 聚合详情的有效期显示：勾了长期有效就说长期有效，填 0 就说不缓存 */
  const fmtDetailTtl = (r) => {
    const d = r.detail || {};
    if (d.ttlForever) return '长期有效';
    const min = Math.round(Number(d.ttlMs || 0) / 60000);
    return min > 0 ? `${min} 分钟` : '不缓存';
  };

  const paint = (r) => {
    const d = r.detail || { rows: 0, bytes: 0, maxBytes: 0 };
    out.textContent = '';
    out.append(
      `元数据 ${r.tmdb.rows} 条 / ${fmtBytes(r.tmdb.bytes)}（上限 ${fmtBytes(r.tmdb.maxBytes)}）` +
        ` · 名字索引 ${r.names.rows} 条 / ${fmtBytes(r.names.bytes)}（上限 ${fmtBytes(r.names.maxBytes)}）` +
        ` · 图片索引 ${r.image.rows} 条 / ${fmtBytes(r.image.bytes)}（上限 ${fmtBytes(r.image.maxBytes)}）` +
        ` · 聚合详情 ${d.rows} 条 / ${fmtBytes(d.bytes)}（上限 ${fmtBytes(d.maxBytes)}，当期有效期 ${fmtDetailTtl(r)}）`
    );
  };
  const load = async () => {
    try {
      paint(await api('/api/panel/cache'));
    } catch (e) {
      out.textContent = '读取用量失败：' + e.message;
    }
  };
  load();

  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const r = await api('/api/modules/panel/settings', {
        method: 'PUT',
        body: {
          settings: {
            cache: {
              tmdbTtlDays: Number(cTtlDays.value),
              tmdbMaxMB: Number(cTtlMB.value),
              imageTtlDays: Number(cImgDays.value),
              imageMaxMB: Number(cImgMB.value),
              /* 留空**不要**当成 0 —— 这个字段的 0 是"不缓存"，留空的意思是"用默认值"，
               * 所以留空发 undefined（JSON 会把它丢掉，后端按默认值算）。 */
              detailTtlMinutes: cDetMin.value.trim() === '' ? undefined : Number(cDetMin.value),
              detailNeverExpire: cDetForever.checked,
            },
          },
        },
      });
      S.panel.settings = r.settings;
      toast('缓存设置已保存');
      await load(); // 上限调小后这里能立刻看到淘汰结果（后端在设置变更时会扫一遍）
    } catch (e) {
      toast('保存失败：' + e.message, true);
    } finally {
      save.disabled = false;
    }
  });

  clear.addEventListener('click', async () => {
    if (
      !confirm(
        '清空本地缓存？\n\nTMDB 元数据、名字索引、图片索引、聚合详情快照都会重来（下次浏览会重新请求 TMDB，下一次点开会重新搜源）。\n账号在另一个库里，不受影响、不用重新登录。'
      )
    ) {
      return;
    }
    clear.disabled = true;
    try {
      paint(await api('/api/panel/cache', { method: 'DELETE' }));
      toast('缓存已清空');
    } catch (e) {
      toast('清空失败：' + e.message, true);
    } finally {
      clear.disabled = false;
    }
  });

  return el(
    'div',
    { class: 'card' },
    el('h3', { text: '缓存设置' }),
    el('p', {
      class: 'note',
      text:
        '缓存 TMDB 元数据、名字索引（聚合层按名字反查 tmdb id 用）与图片索引，用来少打上游、也让客户端出得了封面；' +
        '另有一层「聚合详情」快照：把「这部片在源里有哪些线路、这一集定位到哪一条」存起来（客户端点一次播放会连问三遍同一件事，' +
        '靠它省掉后两遍）。清空不影响账号，也不用重新登录。',
    }),
    el('p', {
      class: 'note',
      text:
        '天数 / 分钟数填 0 = 不缓存；上限填 0 = 不限（不淘汰）。两个 0 意思不一样，别当成一回事。' +
        '「聚合详情」勾了长期有效就不按分钟数过期（改了站点勾选 / 分数线这类设置会立刻换一份新的，不会读到旧结论）。',
    }),
    el(
      'div',
      { class: 'row' },
      el('span', { class: 'muted', text: '元数据' }),
      cTtlDays,
      el('span', { class: 'muted', text: '天 · 上限' }),
      cTtlMB,
      el('span', { class: 'muted', text: 'MB' }),
      el('span', { class: 'muted', text: '｜ 图片索引' }),
      cImgDays,
      el('span', { class: 'muted', text: '天 · 上限' }),
      cImgMB,
      el('span', { class: 'muted', text: 'MB' })
    ),
    el(
      'div',
      { class: 'row' },
      el('span', { class: 'muted', text: '聚合详情（线路 + 定位）' }),
      cDetMin,
      el('span', { class: 'muted', text: '分钟' }),
      el('label', { class: 'chk' }, cDetForever, '长期有效'),
      save,
      clear
    ),
    out
  );
}

/** 同 TMDB 卡：设置要异步读一次，先占位再把卡换进去 */
async function cacheSection(v) {
  const holder = el('div');
  v.append(holder);
  holder.append(el('div', { class: 'card' }, el('h3', { text: '缓存设置' }), el('div', { class: 'muted', text: '正在读取面板设置…' })));
  try {
    if (!S.panel.settings) S.panel.settings = (await api('/api/modules/panel/settings')).settings;
  } catch (e) {
    holder.replaceChildren(
      el('div', { class: 'card' }, el('h3', { text: '缓存设置' }), el('div', { class: 'hint warn', text: '读取面板设置失败：' + e.message }))
    );
    return;
  }
  holder.replaceChildren(cacheCard());
}

/* ------------------------------------------------------------------ 面板密码 */

function passwordCard() {
  const oldInput = el('input', { type: 'password', autocomplete: 'current-password', placeholder: '当前密码' });
  const newInput = el('input', { type: 'password', autocomplete: 'new-password', placeholder: '新密码（至少 6 位）' });
  const againInput = el('input', { type: 'password', autocomplete: 'new-password', placeholder: '再输一次' });
  const btn = el('button', { class: 'btn primary', text: '修改密码' });
  const warn = el('div', { class: 'note err-note hidden' });

  btn.addEventListener('click', async () => {
    warn.classList.add('hidden');
    const show = (m) => {
      warn.textContent = m;
      warn.classList.remove('hidden');
    };
    if (!oldInput.value || !newInput.value) return show('请填写当前密码与新密码');
    if (newInput.value !== againInput.value) return show('两次输入的新密码不一致');
    if (newInput.value.length < 6) return show('新密码至少 6 位');
    btn.disabled = true;
    try {
      await changePassword(oldInput.value, newInput.value);
      /* 改完旧登录就失效了 —— 明确回到登录页 */
      toast('密码已修改，请用新密码重新登录');
      setTimeout(() => location.reload(), 800);
    } catch (e) {
      show(e.message);
      btn.disabled = false;
    }
  });

  return el(
    'div',
    { class: 'card' },
    el('h3', { text: '面板密码' }),
    el('p', { class: 'note', text: '登录这个面板要用的密码。改完之后要重新登录（浏览器里 30 天不用再输）。' }),
    el('div', { class: 'row' }, oldInput, newInput, againInput, btn),
    warn
  );
}

export function renderPanelSettings(v) {
  const first = updateCard();
  v.append(first, backupCard(), passwordCard());
  /* TMDB 卡与缓存卡都要异步读一次设置，各自往 v 末尾插，不挡上面的卡。
   * ⚠️ 两张卡共用一个 `S.panel.settings`：`cacheSection` 在 `tmdbSection` 之后跑，
   * 那时设置已经读回来了（若没读到它会自己再读一次），不会出现"缓存卡拿着空设置"的情况。 */
  tmdbSection(v);
  cacheSection(v).then(() =>
    v.append(el('div', { class: 'actions' }, el('button', { class: 'btn', text: '退出登录', onclick: () => logout() })))
  );

  /* 还在用默认密码 → 页顶插一条警告（翻到页面底部才看见就太晚了） */
  authStatus().then((st) => {
    if (!st.isDefault) return;
    v.insertBefore(
      el(
        'div',
        { class: 'hint warn' },
        '⚠️ 面板还在用默认密码 ',
        el('code', { text: '123456' }),
        ' —— 任何人打开这个地址都能进。就在下面改掉。'
      ),
      first
    );
  });
}
