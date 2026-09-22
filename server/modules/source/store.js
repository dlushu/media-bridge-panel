'use strict';
/**
 * 源仓库：负责 data/sources.json 的读写，以及每个源的本地目录管理
 *
 * 路径统一来自 core/paths，本文件被搬到哪一层都不会算错目录。
 */
const fs = require('fs');
const path = require('path');

const { DATA_DIR, SOURCES_DIR, SOURCES_FILE: DB_FILE } = require('../../core/paths');

function ensureDirs() {
  fs.mkdirSync(SOURCES_DIR, { recursive: true });
}

function readDb() {
  ensureDirs();
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!Array.isArray(db.sources)) db.sources = [];
    return db;
  } catch {
    return { sources: [] };
  }
}

function writeDb(db) {
  ensureDirs();
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function newId() {
  return 'src_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function sourceDir(id) {
  return path.join(SOURCES_DIR, id);
}

function runtimeDir(id) {
  return path.join(sourceDir(id), 'runtime');
}

function list() {
  return readDb().sources;
}

function get(id) {
  return readDb().sources.find((s) => s.id === id) || null;
}

function create(meta) {
  const db = readDb();
  const src = Object.assign(
    {
      id: newId(),
      name: '',
      url: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      port: 0,
      autostart: false,
      files: {},
    },
    meta
  );
  db.sources.push(src);
  writeDb(db);
  fs.mkdirSync(sourceDir(src.id), { recursive: true });
  fs.mkdirSync(runtimeDir(src.id), { recursive: true });
  return src;
}

function update(id, patch) {
  const db = readDb();
  const i = db.sources.findIndex((s) => s.id === id);
  if (i < 0) return null;
  db.sources[i] = Object.assign({}, db.sources[i], patch, { updatedAt: Date.now() });
  writeDb(db);
  return db.sources[i];
}

function remove(id) {
  const db = readDb();
  const i = db.sources.findIndex((s) => s.id === id);
  if (i < 0) return false;
  const [src] = db.sources.splice(i, 1);
  writeDb(db);
  try {
    fs.rmSync(sourceDir(src.id), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  return true;
}

module.exports = {
  DATA_DIR,
  SOURCES_DIR,
  DB_FILE,
  ensureDirs,
  list,
  get,
  create,
  update,
  remove,
  sourceDir,
  runtimeDir,
};
