#!/usr/bin/env node
/**
 * 变量遮蔽检查 —— 防止「函数内 `var X` 撞掉模块级同名变量」这类只有点一下才暴露的 bug。
 *
 * 真实事故：apply.js 模块级 `var doc = root.document`，而 hasAdblock 那段在 apply() 里写了
 * `var doc = null` → `var` 提升后 `doc` 在函数开头是 undefined，`doc.getElementById` 抛
 * TypeError，页面表现就是「点『载入配置文件』毫无反应」。node --check、单测、shell 自检全绿。
 *
 * 判据：同一文件里，某个名字在 **2 空格缩进**（IIFE 顶层）声明过，又在更深缩进处再次
 * 用 var/let/const 声明 → 视为遮蔽。
 *
 * 用法：node tools/check-shadow.mjs [目录]    默认 generator/app
 * 退出码：0 = 干净；1 = 有遮蔽（打印文件:行号与名字）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] || 'generator/app';
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (name.endsWith('.js')) files.push(full);
  }
})(root);

const DECL = /^(\s*)(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*[=;,]/;
const hits = [];

for (const file of files) {
  let lines;
  try {
    lines = readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    continue;
  }
  const top = new Map();      // 名字 → 行号（2 空格缩进的声明）
  for (let i = 0; i < lines.length; i++) {
    const m = DECL.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const name = m[2];
    if (indent === 2) {
      if (!top.has(name)) top.set(name, i + 1);
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const m = DECL.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const name = m[2];
    if (indent > 2 && top.has(name)) {
      hits.push(`${file}:${i + 1}  内层 ${m[0].trim()} 遮蔽了第 ${top.get(name)} 行的模块级 ${name}`);
    }
  }
}

if (hits.length) {
  console.error('✘ 发现变量遮蔽（内层声明会吞掉外层同名变量）：');
  for (const h of hits) console.error('  ' + h);
  process.exit(1);
}
console.log(`✔ 变量遮蔽检查通过（${files.length} 个文件）`);
