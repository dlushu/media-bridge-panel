#!/usr/bin/env node
'use strict';
/**
 * 文风检查：扫描代码注释与文档，报告不符合规范的写法。
 *
 * 规则来源见 CONTRIBUTING.md 的「文档与注释的书写规范」。设计目标是**可判定**：
 * 只检查能机械化识别的写法，主观判断仍交给评审。CI 在每次 PR 上运行本脚本。
 *
 * 说明：Markdown 里**围栏代码块内**的内容按"原样保留的实证"处理，不参与符号/日期/人称这三条
 * 规则（日志样例、响应片段、命令行输出都属于这一类）；叙述类规则在块内仍然生效。
 *
 * 用法：
 *   node tools/check-style.js          # 检查整个仓库
 *   node tools/check-style.js src/a.js # 只检查指定文件
 *
 * 退出码：0 = 通过；1 = 有命中。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** 不参与检查的目录 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'data',
  '.codebuddy',
  // 容器相关文件不属于项目源码（见 .gitignore），不参与文风检查
  'docker',
]);

/**
 * 不参与检查的文件：
 *   · 规则本身 —— 本脚本的规则表里必然包含被禁用的字面量；
 *   · CONTRIBUTING.md —— 它是在"描述"这些写法（含正反示例）。
 */
const SKIP_FILES = new Set(['tools/check-style.js', 'CONTRIBUTING.md']);

/** 参与检查的扩展名 */
const EXTS = new Set(['.js', '.mjs', '.cjs', '.md', '.yml', '.yaml', '.sh', '.html', '.css', '.json']);

/**
 * 规则表。
 *   scope  'comment' 只看出现在注释里的位置（代码文件按行首判断）；'all' 看全文
 *   only   只在这些路径前缀下生效（未给出则全部生效）
 *   except 在这些路径前缀下不生效
 */
const RULES = [
  {
    id: 'first-person',
    label: '第一人称叙述（我 / 我们 / 咱们）',
    re: /(^|[^\w])(我|我们|咱们|俺)([^\w]|$)/,
    scope: 'all',
  },
  {
    id: 'second-person',
    label: '第二人称叙述（开发者文档与注释中不使用"你"）',
    re: /(^|[^\w])你([^\w]|$)/,
    // scope 为 'comment'：**界面文案不受此限** —— 按钮、提示、title 这些直接面向使用者的文字，
    // 用"你"是正常中文产品语气。本规则只约束注释与开发者文档。
    scope: 'comment',
    except: ['README.md'],
  },
  {
    id: 'private-context',
    label: '私人语境（使用者 / 原话 / 他要求 / 拍板）',
    re: /(使用者|原话|他要求|他说|他报|他点名|他定|拍板)/,
    scope: 'all',
  },
  {
    id: 'self-judgement',
    label: '自我评价或情绪（自作主张 / 走眼了 / 说错了 / 真凶 / 要命）',
    re: /(自作主张|走眼了|说错了|真凶|要命|坑了我|我的锅|白写|认栽|被否掉)/,
    scope: 'all',
  },
  {
    id: 'colloquial',
    label: '口语化表达（说白了 / 老实说 / 完蛋 / 别指望 / 吃光）',
    re: /(说白了|老实说|完蛋|卧槽|别指望|吃光|藏起来)/,
    scope: 'all',
  },
  {
    id: 'dated-in-comment',
    label: '注释里的日期流水账（版本历史应写入 CHANGELOG，决策应写入 ADR）',
    re: /20\d\d-\d\d-\d\d/,
    scope: 'comment',
    except: ['CHANGELOG.md', 'docs/adr/'],
  },
  {
    id: 'doc-symbol',
    label: '文档与注释里的符号（✔ ✘ ✅ ❌；命令行输出不受此限）',
    re: /[✔✘✅❌]/,
    scope: 'comment',
  },
];

/** 代码文件里判断某行是否为注释 */
function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('<!--') || t.startsWith('#');
}

/** 收集待检查文件 */
function collect(targets) {
  if (targets.length) return targets.map((p) => path.resolve(p));
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (EXTS.has(path.extname(entry.name))) {
        out.push(full);
      }
    }
  })(ROOT);
  return out.filter((f) => !SKIP_FILES.has(path.relative(ROOT, f)));
}

const inScope = (file, rule) => {
  if (rule.only && !rule.only.some((p) => file.startsWith(p))) return false;
  if (rule.except && rule.except.some((p) => file.startsWith(p))) return false;
  return true;
};

function main() {
  const files = collect(process.argv.slice(2));
  const hits = [];
  const counts = new Map(RULES.map((r) => [r.id, 0]));
  let warnCount = 0;

  for (const abs of files) {
    const rel = path.relative(ROOT, abs);
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    // 文档类文件整体按注释对待（符号类规则适用于它）
    const isDoc = path.extname(abs) === '.md' || rel.startsWith('docs/') || rel.startsWith('.github/');
    warnCount += (text.match(/⚠️/g) || []).length;

    const lines = text.split('\n');
    // 围栏代码块内的行：**原样保留的实证**（日志样例、响应片段、命令行输出），
    // 因此 `scope: 'comment'` 的规则（符号 / 日期 / 人称）在块内不生效；
    // 叙述类规则（scope: 'all'）仍然生效 —— 代码块里也不该出现第一人称或私人语境。
    const fenced = [];
    let fence = false;
    for (const line of lines) {
      fenced.push(fence);
      if (/^\s*```/.test(line)) fence = !fence;
    }

    lines.forEach((line, i) => {
      // 行内代码（`...`）与围栏代码块同理：里面是逐字引用的令牌（字段名、命令、日志行、响应取值），
      // 不参与"符号 / 日期 / 人称"这三条判断。
      const trimmed = isDoc ? line.replace(/`[^`]*`/g, '``') : line;
      for (const rule of RULES) {
        if (!inScope(rel, rule)) continue;
        if (rule.scope === 'comment' && isDoc && fenced[i]) continue;
        if (rule.scope === 'comment' && !isDoc && !isCommentLine(line)) continue;
        if (rule.re.test(rule.scope === 'comment' && isDoc ? trimmed : line)) {
          counts.set(rule.id, counts.get(rule.id) + 1);
          hits.push({ rel, line: i + 1, rule, text: line.trim().slice(0, 118) });
        }
      }
    });
  }

  if (hits.length) {
    for (const h of hits) {
      console.log(`${h.rel}:${h.line}  [${h.rule.id}] ${h.text}`);
    }
    console.log('');
  }
  console.log('按规则统计：');
  for (const r of RULES) console.log(`  ${String(counts.get(r.id)).padStart(4)}  ${r.label}`);
  console.log(`\n提示（不计入失败）：⚠️ 共 ${warnCount} 处 —— 该标记仅用于"照做会出错"的位置。`);

  if (hits.length) {
    console.log(`\n✘ 共 ${hits.length} 处不符合规范，规则见 CONTRIBUTING.md。`);
    process.exit(1);
  }
  console.log('\n✔ 未发现不符合规范的写法。');
}

main();
