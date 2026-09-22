'use strict';
/**
 * 首页插件 · 落盘（emby 模块私有）
 *
 *   data/emby/homepage/
 *     registry.json        插件清单：只放元数据与参数值，**不放代码**
 *     <插件id>/index.js     上传的插件原文（权限 600）
 *     <插件id>/storage.json 插件私有存储（Catpaw.storage；权限 600，可能含插件自己的 token）
 *
 * 目录放在 EMBY_DIR 下（emby 模块自己的数据），不新增 core/paths 常量。
 * 元数据不进 settings/emby.json，是为了让「启用 / 改参数」成为**单插件**操作 ——
 * settings 的数组是整体替换，多个插件并发保存会互相覆盖；顺带也不让插件内容混进配置备份。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EMBY_DIR } = require('../../../core/paths');

const HOMEPAGE_DIR = path.join(EMBY_DIR, 'homepage');
const REGISTRY_FILE = path.join(HOMEPAGE_DIR, 'registry.json');

/** 插件文件与存储都可能含凭证 → 一律 600 */
const FILE_MODE = 0o600;

/** 插件源码上限：FW 社区里最大的也就 140KB，1MB 绰绰有余 */
const MAX_CODE_BYTES = 1024 * 1024;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 原子写（tmp + rename），与 core/settings、source/store 同款 */
function writeJsonAtomic(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: FILE_MODE });
  fs.renameSync(tmp, file);
  return obj;
}

function readJson(file, dft) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return dft;
  }
}

const pluginDir = (id) => path.join(HOMEPAGE_DIR, id);
const pluginFile = (id) => path.join(pluginDir(id), 'index.js');
const storageFile = (id) => path.join(pluginDir(id), 'storage.json');

/** 清单（数组，按上传时间先后） */
function list() {
  const r = readJson(REGISTRY_FILE, []);
  return Array.isArray(r) ? r : [];
}

function get(id) {
  return list().find((x) => x && x.id === id) || null;
}

/** 新增或整条替换（按 id） */
function put(meta) {
  const all = list();
  const i = all.findIndex((x) => x && x.id === meta.id);
  if (i >= 0) all[i] = meta;
  else all.push(meta);
  writeJsonAtomic(REGISTRY_FILE, all);
  return meta;
}

/** 删除插件：先摘清单再删目录（目录删失败也要保证清单里没有它，否则会指向不存在文件） */
function remove(id) {
  const all = list();
  const i = all.findIndex((x) => x && x.id === id);
  if (i < 0) return false;
  all.splice(i, 1);
  writeJsonAtomic(REGISTRY_FILE, all);
  fs.rmSync(pluginDir(id), { recursive: true, force: true });
  return true;
}

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

/** 写插件源码（原子 + 600） */
function writeCode(id, text) {
  ensureDir(pluginDir(id));
  const file = pluginFile(id);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, { mode: FILE_MODE });
  fs.renameSync(tmp, file);
}

function readCode(id) {
  try {
    return fs.readFileSync(pluginFile(id), 'utf8');
  } catch {
    return null;
  }
}

/** 插件私有存储：整份读、整份写（不做单键落盘 —— 插件数据量小，整份写更不易写坏） */
function readStorage(id) {
  const v = readJson(storageFile(id), {});
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function writeStorage(id, obj) {
  return writeJsonAtomic(storageFile(id), obj);
}

module.exports = {
  HOMEPAGE_DIR,
  REGISTRY_FILE,
  MAX_CODE_BYTES,
  pluginDir,
  pluginFile,
  storageFile,
  list,
  get,
  put,
  remove,
  md5,
  writeCode,
  readCode,
  readStorage,
  writeStorage,
};
