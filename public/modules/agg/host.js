'use strict';
/**
 * 聚合模块 · 「源列表」页：聚合用哪几个源。
 *
 * 两类源**并排显示，但来源完全不同**：
 *   · **本地部署的源**（「源托管」里那些）—— **自动就在这里**，名字取部署源自己的名字，
 *     地址是它当前跑着的端口（后端每次现算）。所以本页**没有"添加部署源"这回事**：
 *     要加就先去部署一个源，它会自己出现在这里。
 *   · **自定义源**（面板够不到的外部地址）—— 手填地址加进来，可删、可停用。
 * 以前是靠"添加时从下拉里挑一个本地部署的"把地址**填进配置**，两边各存一份：
 * 名字对不上、端口一变就指向旧端口。现在那份不复存在。
 *
 * 渲染是**两段**的：先用源清单（读本机状态，几毫秒）把页面画出来，各源的 /config 探测放后台跑
 * （源连不上要等它超时，十几秒），探测回来只补状态那一列 —— 不重画整页，
 * 免得把正在填的地址/名字冲掉。
 */
import { el, toast, modal } from '../../core/dom.js';
import { S } from '../../core/state.js';
import { ensureAggSites, ensureAggSources, saveAggSettings, sourcesForDisplay, customSources } from '../../core/store.js';
import { renderPage } from '../../core/shell.js';

/** 「添加聚合源」模态框：**手填一个外部地址**（本地部署的源自动就在列表里，不用在这儿加） */
function openAddSource() {
  const urlInput = el('input', { type: 'text', spellcheck: 'false', placeholder: 'http://192.168.1.100:9988' });
  const nameInput = el('input', { type: 'text', spellcheck: 'false', placeholder: '名字（可选、不可重复，如 主力 / 备用）' });
  /* **类型**：面板名不再带"猫源"之后，要让用户一眼知道**该填什么源** ——
   * 现在只有一种，所以是个只有一个选项的下拉；将来接第二种源时，这里长第二项，不用改结构。 */
  const typeSel = el('select', { title: '要加的源是什么类型（决定它能提供哪些能力）' });
  typeSel.append(el('option', { value: 'catpaw', text: '猫源（CatPawOpen）—— 填能下载 index.js 的地址，如 http://ip:9988' }));
  const tip = el('div', { class: 'note' });

  modal({
    title: '添加聚合源（外部地址）',
    body: [
      el('div', { class: 'field' }, el('label', { text: '类型' }), typeSel),
      el('div', { class: 'field' }, el('label', { text: '源地址' }), urlInput),
      el('div', { class: 'field' }, el('label', { text: '名字' }), nameInput),
      el('div', {
        class: 'note',
        text: '类型目前只有「猫源」这一种：填能下载 index.js 的地址（如 http://ip:9988）。本地部署的源不用在这里加 —— 它们已经在下面的列表里了（名字就是源名）。',
      }),
      tip,
    ],
    actions: [
      { label: '取消' },
      {
        label: '添加',
        primary: true,
        onclick: async () => {
          const url = urlInput.value.trim();
          if (!url) {
            tip.textContent = '请填一个源地址（猫源：能下载 index.js 的地址）';
            return false;
          }
          const list = sourcesForDisplay();
          if (list.some((x) => x.url === url)) {
            tip.textContent = '这个地址已经在列表里了';
            return false;
          }
          /* 名字可以留空（界面上退回显示 url），填了就得唯一 —— 重名会让源列表分不清谁是谁。
             后端 validate 也会拦（这条只是早点给反馈，不必等一次往返）。 */
          const name = nameInput.value.trim();
          if (name && list.some((x) => String(x.name || '').trim().toLowerCase() === name.toLowerCase())) {
            tip.textContent = '这个名字已经被别的源用了，换一个或留空';
            return false;
          }
          const id = 's' + Date.now().toString(36).slice(-4);
          /* 只把**自定义**那些存回去：部署源不落盘（它们的地址每次现算） */
          const next = customSources().concat([{ id, url, name, enabled: true }]);
          try {
            await saveAggSettings({ sources: next }, { reload: true });
            toast('已添加聚合源：' + (name || url));
            renderPage();
          } catch (e) {
            tip.textContent = '添加失败：' + e.message;
            return false;
          }
        },
      },
    ],
  });
}

/** 源状态文案：还没有探测结果就是「探测中…」 */
function statusOf(s) {
  if (s.ok) return `正常 · ${s.siteCount} 站点 · ${s.ms}ms`;
  if (s.error) return '失败：' + s.error;
  return '探测中…';
}

/** 状态点：探测中/停用都灰着，别把"还没探测"误报成失败 */
function dotOf(s) {
  if (s.ok) return 'running';
  if (s.error) return 'error';
  return 'stopped';
}

/** 状态文字前面的那一小段「在哪儿」：部署源给端口（它的 127.0.0.1 地址对用户没有意义，
 *  真正对外用的是「面板域名 + 这个端口」，见 emby 层 302 时那次改写），自定义源给地址。 */
function whereOf(s) {
  if (s.deployed) return s.port ? `:${s.port} · ` : '';
  return s.name ? s.url + ' · ' : '';
}

export async function renderAggHost(v) {
  /* 先把源清单拿到手（读本机状态，几毫秒），页面就能立刻画出来 ——
     注意连**部署源在不在跑**都是这一步拿到的，所以"没在跑"的源第一遍就能显示出来。
     各源 /config 的探测在后半段异步跑 —— 慢的是它，不是这一步。 */
  try {
    await ensureAggSources();
  } catch {
    /* 拿不到就先按空清单画，下面的探测会再试一次 */
  }
  const sources = sourcesForDisplay();
  const rows = new Map(); // 源 id → { dot, status }：探测回来只改这两个节点

  const card = el('div', { class: 'card' }, el('h3', { text: '聚合源（聚合的数据来源）' }));

  /* 添加走**模态框**（手填外部地址 + 名字）。按钮放在**列表上方**，
   * 与「源托管 · 猫源地址」页保持一致（两页一个上一个下，看着乱）。 */
  card.append(
    el(
      'div',
      { class: 'actions' },
      el('button', { class: 'btn primary', text: '＋ 添加外部源', onclick: () => openAddSource() })
    )
  );

  if (!sources.length) {
    card.append(
      el('div', { class: 'muted', text: '还没有源 —— 到「源托管 · 猫源地址」部署一个（会自动出现在这里），或者点上面的「添加外部源」填一个地址。' })
    );
  }
  for (const s of sources) {
    const on = s.enabled !== false;
    const dot = el('span', { class: 'dot ' + dotOf(s) });
    const status = el('span', { class: 'note', text: whereOf(s) + statusOf(s) });
    rows.set(s.id, { dot, status });

    /* 部署的源：**没有"参与聚合"开关、也没有删除** —— 它归「源托管」管
     * （要停用就停那个源，要剔除它的站点就去「站点与参数」取消勾选）。
     * 自定义源：开关 + 删除，与以前一样。 */
    const controls = [];
    if (s.deployed) {
      /* 没在运行时**不另挂标记** —— 状态列那一句「失败：这个源没在运行（去…启动它）」已经说清了，
       * 再挂一个徽章是同一件事说两遍。 */
      controls.push(el('span', { class: 'badge', text: '本地部署' }));
    } else {
      const chk = el('input', { type: 'checkbox', checked: on });
      chk.addEventListener('change', async () => {
        const next = customSources().map((x) => Object.assign({}, x, { enabled: x.id === s.id ? chk.checked : x.enabled }));
        try {
          await saveAggSettings({ sources: next }, { reload: true });
          toast((chk.checked ? '已启用' : '已停用') + '：' + (s.name || s.url));
          renderPage();
        } catch (e) {
          toast('保存失败：' + e.message, true);
          chk.checked = !chk.checked;
        }
      });
      controls.push(el('label', { class: 'chk' }, chk, '参与聚合'));
      controls.push(
        el('button', {
          class: 'btn mini danger',
          text: '删除',
          onclick: async () => {
            if (!confirm(`从聚合源里删除 ${s.name || s.url}？不影响本地托管的源本身。`)) return;
            const next = customSources().filter((x) => x.id !== s.id);
            const cfg = (S.settings && S.settings.agg) || {};
            try {
              await saveAggSettings(
                {
                  sources: next,
                  enabled: (cfg.enabled || []).filter((x) => x.source !== s.id),
                  order: (cfg.order || []).filter((x) => x.source !== s.id),
                },
                { reload: true }
              );
              toast('已删除：' + (s.name || s.url));
              renderPage();
            } catch (e) {
              toast('删除失败：' + e.message, true);
            }
          },
        })
      );
    }
    card.append(
      el('div', { class: 'file-row' }, dot, el('span', { class: 'name', text: s.name || s.url }), status, ...controls)
    );
  }

  const probed = !!S.aggLoadedFor; // 已有探测结果 → 上面画的就是最新的，不用再等
  const notice = probed ? null : el('div', { class: 'hint', text: '正在探测各源…（连不上的要等超时，下面的清单可以先看）' });

  /* ⚠️ 用原生 `append` 时**别把 null 传进去**（会渲染出字面的 "null"）—— 没探测时才挂这条提示 */
  if (notice) v.append(notice);
  v.append(card);

  if (probed) return;

  /* 后台探测。失败也不整页报错 —— 每个源自己的状态列会写出失败原因 */
  try {
    await ensureAggSites();
  } catch (e) {
    if (!notice.isConnected) return;
    notice.className = 'hint warn';
    notice.textContent = '探测失败：' + e.message;
    return;
  }
  if (!notice.isConnected) return; // 已经翻到别的页了，别往脱离文档的节点里写
  notice.remove();
  for (const s of S.aggSources || []) {
    const r = rows.get(s.id);
    if (!r) continue;
    r.dot.className = 'dot ' + dotOf(s);
    r.status.textContent = whereOf(s) + statusOf(s);
  }
}

