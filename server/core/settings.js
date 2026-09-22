'use strict';
/**
 * 模块设置：一个模块一份文件  data/settings/<id>.json
 *
 * 模块通过 define(id, { defaults, validate }) 声明自己的默认值与校验；
 * core 不认识任何具体键，只负责「读 → 深合并默认值 → 校验 → 原子写」。
 */
const fs = require('fs');
const path = require('path');
const { SETTINGS_DIR, LEGACY_SETTINGS } = require('./paths');

const specs = new Map();

function define(id, spec) {
  if (!id) throw new Error('settings.define 需要模块 id');
  specs.set(id, spec || {});
  return specs.get(id);
}

function isPlain(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 深合并（数组整体替换） */
function deepMerge(a, b) {
  const out = isPlain(a) ? Object.assign({}, a) : {};
  for (const [k, v] of Object.entries(b || {})) {
    if (v === undefined) continue;
    out[k] = isPlain(v) && isPlain(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function defaultsOf(id) {
  const spec = specs.get(id);
  const d = spec && typeof spec.defaults === 'function' ? spec.defaults() : {};
  return JSON.parse(JSON.stringify(d || {}));
}

function fileOf(id) {
  return path.join(SETTINGS_DIR, id + '.json');
}

function read(id) {
  try {
    return deepMerge(defaultsOf(id), JSON.parse(fs.readFileSync(fileOf(id), 'utf8')));
  } catch {
    return defaultsOf(id);
  }
}

function write(id, obj) {
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  const file = fileOf(id);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
  return obj;
}

/** 局部更新：合并 → 校验 → 写盘 */
function patch(id, partial) {
  const next = deepMerge(read(id), partial || {});
  const spec = specs.get(id);
  const err = spec && typeof spec.validate === 'function' ? spec.validate(next) : null;
  if (err) {
    const e = new Error(err);
    e.code = 400;
    throw e;
  }
  return write(id, next);
}

/** 恢复默认：删文件即可 */
function reset(id) {
  try {
    fs.rmSync(fileOf(id), { force: true });
  } catch {
    /* ignore */
  }
  return read(id);
}

function has(id) {
  return specs.has(id);
}

function ids() {
  return Array.from(specs.keys());
}

/**
 * 旧版单文件 data/settings.json 自动搬迁（{ baseUrl, agg:{...} }）
 *   baseUrl（聚合消费的猫源地址）→ settings/agg.json .upstream.source
 *   agg.*                        → settings/agg.json 同名键
 * 搬完把旧文件改名留档，不静默丢弃。
 */
function migrateLegacy() {
  if (!fs.existsSync(LEGACY_SETTINGS)) return null;
  let old = {};
  try {
    old = JSON.parse(fs.readFileSync(LEGACY_SETTINGS, 'utf8'));
  } catch {
    old = {};
  }
  const agg = Object.assign({}, old.agg || {});
  agg.upstream = Object.assign({}, agg.upstream, { source: old.baseUrl || '' });
  if (!fs.existsSync(fileOf('agg'))) write('agg', deepMerge(defaultsOf('agg'), agg));
  fs.renameSync(LEGACY_SETTINGS, LEGACY_SETTINGS + '.migrated');
  return { to: 'data/settings/agg.json', backup: 'data/settings.json.migrated' };
}

module.exports = { define, read, write, patch, reset, has, ids, deepMerge, defaultsOf, fileOf, migrateLegacy };
