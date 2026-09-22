'use strict';
/**
 * Emby 模块 · 「首页插件」页
 *
 * 在面板上传单文件 JS 插件，插件按「行（rows）」产出首页条目；本页负责
 * 上传 / 启用 / 改参数 / 逐行预览 / 删除。
 *
 * **已接客户端端点**：每个启用的行 = 一个「媒体库」（`Views`），库内容走
 * `Items?ParentId=` 与 `Items/Latest?ParentId=`，库封面与条目图片都出；声明了 `feed: 'random'`
 * 的行还会接客户端首页轮播图那条「推荐」查询。
 *
 * 注意：上传必须**绕开 core/api.js**（它是纯 JSON 封装）—— 插件是裸文本，
 * 用 FileReader/`file.text()` 读出来后直接 fetch 发 `text/javascript`。
 */
import { el, toast, fmtTime, codeBlock } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { S } from '../../core/state.js';
import { renderPage } from '../../core/shell.js';

const MAX_BYTES = 1024 * 1024;

/** 行结果的展示（复用聚合搜索那套 .agg-list / .agg-item / .agg-pic 样式） */
function renderItems(items) {
  return el(
    'div',
    { class: 'agg-list' },
    ...items.map((it) =>
      el(
        'div',
        { class: 'agg-item' },
        it.poster
          ? el('img', { class: 'agg-pic', src: it.poster, loading: 'lazy', alt: '' })
          : el('span', { class: 'agg-pic empty' }),
        el(
          'div',
          { class: 'agg-body' },
          el(
            'div',
            { class: 'agg-name' },
            it.title,
            it.year ? el('span', { class: 'muted', text: ` (${it.year})` }) : null
          ),
          el('div', {
            class: 'note',
            text:
              [it.type === 'tv' ? '剧集' : '电影', it.rating ? `★ ${it.rating}` : '', it.id]
                .filter(Boolean)
                .join(' · '),
          }),
          it.overview ? el('div', { class: 'note', text: it.overview }) : null
        )
      )
    )
  );
}

function renderRunResult(box, r) {
  box.textContent = '';
  if (!r) return;

  if (!r.ok) {
    box.append(
      el('div', {
        class: 'hint warn',
        text: `执行失败：${(r.error && r.error.code) || 'ERROR'} ${(r.error && r.error.message) || ''}`,
      })
    );
    return;
  }

  const meta = [
    `${r.items.length} 条`,
    r.dropped ? `丢弃 ${r.dropped}` : '',
    r.dup ? `去重 ${r.dup}` : '',
    r.cached ? '命中缓存' : r.shared ? '合并了并发请求' : '实际执行',
    `${r.ms}ms`,
  ]
    .filter(Boolean)
    .join(' · ');

  box.append(el('div', { class: 'note', text: meta }));
  box.append(
    r.items.length
      ? renderItems(r.items)
      : el('div', { class: 'muted', text: '这一行没有返回任何条目（空是如实结果，不是错误）' })
  );
  box.append(codeBlock({ label: '原始 JSON', code: JSON.stringify(r, null, 2) }));
}

/** 一行：标题 + 参数输入 + 运行 + 结果 */
function rowBlock(p, row, box) {
  const runBtn = el('button', { class: 'btn mini primary', text: '运行' });

  /* 参数输入控件：input / enumeration / count 可见；page / constant 不显示（宿主注入 / 隐藏常量） */
  const inputs = {};
  const paramRow = el('div', { class: 'row' });
  for (const d of row.params || []) {
    if (d.type === 'page' || d.type === 'constant') continue;
    const saved = (p.params && p.params[row.id] && p.params[row.id][d.name]) ?? d.value ?? '';
    let input;
    if (d.type === 'enumeration') {
      input = el('select');
      for (const o of d.enumOptions || []) {
        input.append(el('option', { value: o.value, text: o.title || String(o.value) }));
      }
      input.value = String(saved);
    } else {
      input = el(
        'input',
        d.type === 'count'
          ? { type: 'number', value: String(saved), class: 'w-sm' }
          : { type: 'text', value: String(saved), spellcheck: 'false' }
      );
    }
    inputs[d.name] = input;
    paramRow.append(el('label', { class: 'chk' }, el('span', { text: d.title || d.name }), input));
  }

  const saveBtn =
    Object.keys(inputs).length || (row.params || []).some((d) => d.type === 'page' || d.type === 'constant')
      ? el('button', { class: 'btn mini', text: '保存参数' })
      : null;

  const currentParams = () => {
    const out = {};
    for (const [k, node] of Object.entries(inputs)) out[k] = node.value;
    return out;
  };

  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        const r = await api('/api/emby/home/plugins/' + encodeURIComponent(p.id), {
          method: 'PUT',
          body: { params: { [row.id]: currentParams() } },
        });
        const i = S.emby.homePlugins.findIndex((x) => x.id === p.id);
        if (i >= 0) S.emby.homePlugins[i] = r.plugin;
        Object.assign(p, r.plugin);
        toast(`已保存参数：${p.id} / ${row.title}`);
      } catch (e) {
        toast('保存参数失败：' + e.message, true);
      } finally {
        saveBtn.disabled = false;
      }
    });
  }

  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    runBtn.innerHTML = '<span class="spinner"></span> 运行中…';
    box.textContent = '';
    try {
      const r = await api(
        `/api/emby/home/plugins/${encodeURIComponent(p.id)}/rows/${encodeURIComponent(row.id)}/run`,
        { method: 'POST', body: { params: currentParams() } }
      );
      S.emby.homeRun[p.id + '/' + row.id] = r;
      renderRunResult(box, r);
      toast(r.ok ? `${row.title}：${r.items.length} 条（${r.ms}ms）` : `${row.title} 执行失败`, !r.ok);
    } catch (e) {
      box.textContent = '';
      box.append(el('div', { class: 'hint warn', text: '执行请求失败：' + e.message }));
      toast('执行失败：' + e.message, true);
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = '运行';
    }
  });

  const head = el(
    'div',
    { class: 'site-head' },
    el('span', { class: 'name strong', text: row.title }),
    el('span', { class: 'chip', text: row.id }),
    el('span', {
      class: 'note',
      text: row.cacheDuration ? `缓存 ${row.cacheDuration}s` : '不缓存',
    }),
    el('span', { class: 'spacer' }),
    saveBtn,
    runBtn
  );

  /* 结果容器：把上次结果重绘出来，切页回来还在 */
  const cached = S.emby.homeRun[p.id + '/' + row.id];
  if (cached) renderRunResult(box, cached);

  return el('div', { class: 'site-group' }, head, paramRow, box);
}

/** 一张插件卡 */
function pluginCard(p) {
  const toggle = el('input', { type: 'checkbox', class: 'switch' });
  toggle.checked = !!p.enabled;
  toggle.addEventListener('change', async () => {
    toggle.disabled = true;
    try {
      const r = await api('/api/emby/home/plugins/' + encodeURIComponent(p.id), {
        method: 'PUT',
        body: { enabled: toggle.checked },
      });
      const i = S.emby.homePlugins.findIndex((x) => x.id === p.id);
      if (i >= 0) S.emby.homePlugins[i] = r.plugin;
      toast(`${p.id}：${r.plugin.enabled ? '已启用' : '已停用'}`);
    } catch (e) {
      toast('切换失败：' + e.message, true);
      toggle.checked = !toggle.checked;
    } finally {
      toggle.disabled = false;
    }
  });

  /* 内置示例不给删除入口（服务端也会拦 —— 见 home.removePlugin）：
   * 它随面板发行，删了重启又会装回来，给个按钮只会让人白点一次 */
  const delBtn = p.builtin
    ? null
    : el('button', {
        class: 'btn mini danger',
        text: '删除',
        onclick: async () => {
          if (!confirm(`删除首页插件 ${p.name}（${p.id}）？代码与它的私有存储都会被删掉。`)) return;
          try {
            await api('/api/emby/home/plugins/' + encodeURIComponent(p.id), { method: 'DELETE' });
            S.emby.homePlugins = null;
            toast('已删除：' + p.id);
            renderPage();
          } catch (e) {
            toast('删除失败：' + e.message, true);
          }
        },
      });

  return el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'row' },
      el('label', { class: 'chk' }, toggle, p.enabled ? '已启用' : '已停用'),
      el('span', { class: 'strong', text: p.name }),
      el('span', { class: 'chip', text: 'v' + p.version }),
      p.builtin ? el('span', { class: 'chip', text: '内置', title: '随面板发行：不能删除，开机自动与随包版本对齐（已保存参数与启用状态会保留）' }) : null,
      el('span', { class: 'note', text: p.id }),
      p.author ? el('span', { class: 'note', text: '· ' + p.author }) : null,
      el('span', { class: 'spacer' }),
      delBtn
    ),
    el('div', {
      class: 'note',
      text:
        (p.description ? p.description + ' —— ' : '') +
        `${p.rows.length} 行 · ${p.fileName} · ${(p.size / 1024).toFixed(1)}KB · md5 ${String(p.md5).slice(0, 8)} · 更新于 ${fmtTime(p.updatedAt)}`,
    }),
    ...p.rows.map((row) => rowBlock(p, row, el('div')))
  );
}

export async function renderEmbyHome(v) {
  if (!S.emby.homePlugins) {
    v.append(el('div', { class: 'muted', text: '正在读取首页插件…' }));
    try {
      S.emby.homePlugins = (await api('/api/emby/home/plugins')).plugins || [];
    } catch (e) {
      v.textContent = '';
      v.append(el('div', { class: 'hint warn', text: '读取首页插件失败：' + e.message }));
      return;
    }
    v.textContent = '';
  }
  const plugins = S.emby.homePlugins;

  /* ---- 上传卡 ---- */
  const fileInput = el('input', { type: 'file', accept: '.js,text/javascript,application/javascript' });
  const overwrite = el('input', { type: 'checkbox' });
  const upBtn = el('button', { class: 'btn primary', text: '上传插件' });
  const upOut = el('div', { class: 'hint' });

  upBtn.addEventListener('click', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return toast('先选一个 .js 插件文件', true);
    if (file.size > MAX_BYTES) return toast('插件源码超过 1MB', true);

    upBtn.disabled = true;
    upBtn.innerHTML = '<span class="spinner"></span> 上传中…';
    try {
      const text = await file.text();
      const qs = new URLSearchParams({ filename: file.name });
      if (overwrite.checked) qs.set('overwrite', '1');
      /* 原生 fetch：插件是裸文本，core/api.js 只发 JSON，这里用不上 */
      const res = await fetch('/api/emby/home/plugins?' + qs.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'text/javascript; charset=utf-8' },
        body: text,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = (data && data.error) || 'HTTP ' + res.status;
        upOut.className = 'hint warn';
        upOut.style.margin = '10px 0 0';
        upOut.textContent = '上传被拒：' + msg + (data && data.code ? `（${data.code}）` : '');
        toast('上传被拒：' + msg, true);
        return;
      }
      S.emby.homePlugins = null;
      toast(
        data.unchanged
          ? `内容未变，已跳过：${data.plugin.id}`
          : `${data.created ? '已上传' : '已覆盖'}：${data.plugin.id} v${data.plugin.version}（${data.plugin.rows.length} 行）`
      );
      renderPage();
    } catch (e) {
      upOut.className = 'hint warn';
      upOut.textContent = '上传失败：' + e.message;
      toast('上传失败：' + e.message, true);
    } finally {
      upBtn.disabled = false;
      upBtn.textContent = '上传插件';
    }
  });

  const uploadCard = el(
    'div',
    { class: 'card' },
    el('h3', { text: '上传首页插件' }),
    el('p', {
      class: 'note',
      text: '上传一个单文件 JS 插件（≤1MB）。怎么写看「下载开发文档」，想照着抄就点「下载示例」。',
    }),
    el(
      'div',
      { class: 'row' },
      fileInput,
      el('label', { class: 'chk' }, overwrite, '覆盖同 id 插件'),
      upBtn,
      el('a', {
        class: 'btn mini',
        href: '/api/emby/home/example',
        download: 'example.plugin.js',
        text: '下载示例',
      }),
      el('a', {
        class: 'btn mini',
        href: '/api/emby/home/skill',
        download: 'catpaw-home-plugin.skill.md',
        title: '插件开发文档（可直接丢给 AI 用）',
        text: '下载开发文档',
      })
    ),
    upOut,
    el('div', {
      class: 'note',
      text:
        '同名插件要勾「覆盖」才能更新（已启用状态与已填参数会保留）。' +
        '启用后，它声明的每一行都会变成客户端首页里的一个媒体库；客户端可能要重启或清缓存才会刷新列表。',
    })
  );

  v.append(uploadCard);
  v.append(
    plugins.length
      ? el('div', null, ...plugins.map(pluginCard))
      : el('div', { class: 'muted', text: '还没有插件 —— 先在上面传一个，或点「下载示例」拿一份参考实现。' })
  );
}
