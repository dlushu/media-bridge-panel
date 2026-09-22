#!/usr/bin/env node
'use strict';
/**
 * 语法检查：对仓库里每个 `.js` 跑一遍 `node --check`。
 *
 * 为什么不直接一行 shell：前端 `public/**` 是无构建的原生 ES module，而 `package.json`
 * 没有声明 `"type": "module"`，因此 `node --check public/app.js` 会按 CommonJS 解析、
 * 因 `import` 语句报错。本脚本对这部分文件先复制成 `.mjs` 再检查。
 *
 * 用法：node tools/check-syntax.js
 * 退出码：0 = 全部通过；1 = 有文件语法错误。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'data',
  '.codebuddy',
  // 容器与部署文件不属于项目源码（见 .gitignore）
  'docker',
]);

/** 前端为 ES module（相对仓库根的路径前缀） */
const ESM_PREFIX = 'public' + path.sep;

function collect(dir = ROOT, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collect(full, out);
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

function check(file) {
  const rel = path.relative(ROOT, file);
  const isEsm = rel.startsWith(ESM_PREFIX);
  let target = file;
  let tmp = '';
  if (isEsm) {
    tmp = path.join(os.tmpdir(), `mb-syntax-${process.pid}.mjs`);
    fs.copyFileSync(file, tmp);
    target = tmp;
  }
  const r = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
  if (tmp) fs.unlinkSync(tmp);
  return { rel, ok: r.status === 0, err: (r.stderr || '').trim() };
}

const files = collect().sort();
const failed = [];
for (const f of files) {
  const r = check(f);
  if (!r.ok) failed.push(r);
}

console.log(`检查 ${files.length} 个文件（ES module：public/ 下的文件按 .mjs 解析）`);
if (failed.length) {
  for (const f of failed) console.log(`\n✘ ${f.rel}\n${f.err}`);
  console.log(`\n✘ ${failed.length} 个文件语法错误。`);
  process.exit(1);
}
console.log('✔ 语法检查通过。');
