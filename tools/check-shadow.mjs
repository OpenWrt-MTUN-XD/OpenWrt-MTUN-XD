#!/usr/bin/env node
/**
 * 变量遮蔽检查 —— 防止「函数内 `var X` 撞掉模块级同名变量」这类只有点一下才暴露的 bug。
 *
 * 真实事故：apply.js 模块级 `var doc = root.document`，而 hasAdblock 那段在 apply() 里写了
 * `var doc = null` → `var` 提升后 `doc` 在函数开头是 undefined，`doc.getElementById` 抛
 * TypeError，页面表现就是「点『载入配置文件』毫无反应」。node --check、单测、shell 自检全绿。
 *
 * 判据：同一文件里，名字在 **2 空格缩进**（IIFE 顶层）声明过，又在更深缩进处再次用
 * var/let/const 声明 → 视为遮蔽。声明不要求出现在行首（`for (var i …)` 也算）。
 *
 * 用法：node tools/check-shadow.mjs [目录…]   默认 generator/app generator/deploy
 * 退出码：0 = 干净；1 = 有遮蔽（打印文件:行号与名字）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const roots = process.argv.slice(2);
if (!roots.length) roots.push('generator/app', 'generator/deploy');

const files = [];
function walk(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full);
    else if (name.endsWith('.js')) files.push(full);
  }
}
roots.forEach(walk);

// 声明语句：允许出现在行内（for (var i …)、if (x) { var y … }），后面接标识符
const DECL = /(?:^|[;{}()\s])(?:var|let|const)\s+([A-Za-z_$][\w$]*)(?=\s*[=;,):])/g;

function namesOf(line) {
  const out = [];
  if (/^\s*(\/\/|\*|\/\*)/.test(line)) return out;   // 注释行不看
  let m;
  DECL.lastIndex = 0;
  while ((m = DECL.exec(line)) !== null) {
    // 关键字 var/let/const 的起始列：前缀只吃了一个分隔符，所以 +1
    const kwStart = m.index + 1;
    out.push({ name: m[1], kwStart });
  }
  return out;
}

const hits = [];
for (const file of files) {
  let lines;
  try {
    lines = readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    continue;
  }
  const top = new Map();          // 名字 → 行号（2 空格缩进的顶层声明）
  const rows = lines.map((line, idx) => {
    const indent = (line.match(/^\s*/) || [''])[0].length;
    return namesOf(line).map((d) => ({ ...d, indent, line: idx + 1 }));
  });
  for (const ds of rows) {
    for (const d of ds) {
      // 顶层：声明就是这一行的第一条语句，且缩进是 2（IIFE 体内）
      if (d.indent === 2 && d.kwStart === 2 && !top.has(d.name)) top.set(d.name, d.line);
    }
  }
  for (const ds of rows) {
    for (const d of ds) {
      // 内层：缩进更深，或者声明不在行首（for (var i …)、内联函数里的 var …）
      const inner = d.indent > 2 || d.kwStart > d.indent;
      if (inner && top.has(d.name)) {
        hits.push(`${file}:${d.line}  内层 ${d.name} 遮蔽了第 ${top.get(d.name)} 行的模块级 ${d.name}`);
      }
    }
  }
}

if (hits.length) {
  console.error('✘ 发现变量遮蔽（内层声明会吞掉外层同名变量）：');
  for (const h of hits) console.error('  ' + h);
  process.exit(1);
}
console.log(`✔ 变量遮蔽检查通过（${files.length} 个文件）`);
