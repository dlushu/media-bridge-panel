'use strict';
/**
 * 面板配置备份 / 还原（原「导出」模块的能力）
 *
 * 只备份「配置」：settings/<模块>.json + 源清单。
 * 不含 index.js（6MB 级产物，可重新下载）与 runtime/（源自己的凭证缓存，含 cookie/token，不导出）。
 */
const fs = require('fs');
const { SETTINGS_DIR, SOURCES_FILE } = require('../../core/paths');
const settings = require('../../core/settings');
const registry = require('../../core/registry');

function exportAll() {
  const out = {
    service: 'catpaw-panel',
    exportedAt: new Date().toISOString(),
    settingsDir: SETTINGS_DIR,
    settings: {},
    sources: [],
  };
  for (const id of settings.ids()) out.settings[id] = settings.read(id);
  try {
    out.sources = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8')).sources || [];
  } catch {
    out.sources = [];
  }
  return out;
}

function restore(bundle) {
  const restored = [];
  for (const [id, val] of Object.entries((bundle && bundle.settings) || {})) {
    if (!settings.has(id) || !val || typeof val !== 'object') continue;
    settings.write(id, val);
    restored.push('settings/' + id + '.json');
    /* 还原完要**像 PUT /api/modules/:id/settings 那样跑一遍变更钩子**，否则"文件改了、进程里还是旧值"。
     * 已知边界：panel.logMax 还原成 812 之后，内存里的日志缓冲上限仍是 500。 */
    const mod = registry.get(id);
    if (mod && typeof mod.onSettingsChange === 'function') {
      try {
        mod.onSettingsChange(settings.read(id), id);
      } catch {
        /* 收尾失败不影响还原本身（与 PUT 那条路一致） */
      }
    }
  }
  return {
    ok: true,
    restored,
    // 源清单不自动覆盖：本机托管源的目录/进程状态与清单强相关，误覆盖会造成孤儿目录
    note: restored.length
      ? '源清单未覆盖（如需迁移请手动编辑 data/sources.json）；进程里的设置已按新值生效'
      : '没有可还原的模块设置',
  };
}

module.exports = { exportAll, restore };
