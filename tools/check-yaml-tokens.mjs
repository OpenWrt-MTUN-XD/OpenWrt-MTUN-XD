// 高亮器验收：抽 ui.js 里的真实 yamlTokens，逐条检查「着色类别」与「原文无损」。
import { readFileSync } from 'node:fs';

const src = readFileSync('D:/AI工作区/MTUN-XD/generator/app/ui.js', 'utf8');
const start = src.indexOf('function yamlTokens(line) {');
const end = src.indexOf('  /**', start);
if (start < 0 || end < 0) throw new Error('yamlTokens not found');
const yamlTokens = new Function(src.slice(start, end) + '\nreturn yamlTokens;')();

// [说明, 输入, 期望的 class 序列（不含 null 段）, 期望重建是否等于原文]
const cases = [
  ['空值 null', '    uuid: null', 'k,p,z', true],
  ['空值 ~', '    sni: ~', 'k,p,z', true],
  ['科学计数', '    ratio: 1.5e-6', 'k,p,n', true],
  ['字符串含 #', '    note: "a # b"', 'k,p,s', true],
  ['字符串转义', '    path: "a\\"b#c"', 'k,p,s', true],
  ['行内数组', '    list: [1, 2]', 'k,p,p,n,p,n,p', true],
  ['布尔 true', '    tls: true', 'k,p,b', true],
  ['布尔 false', '    tls: false', 'k,p,b', true],
  ['yes 当普通文本', '    flag: yes', 'k,p', true],
  ['- - 嵌套', '  - - nested', 'd,d', true],
  ['尖括号不转义', '    name: <script>alert(1)</script>', 'k,p', true],
  ['值 + 行内注释', '    port: 443 # 端口', 'k,p,n,c', true],
  ['字符串里的冒号', '    url: "https://example.com/a:b"', 'k,p,s', true],
  ['行内对象', '    value: {name: test, enabled: true}', 'k,p,p,k,p,p,k,p,b,p', true],
];

let bad = 0;
for (const [label, line, wantCls, wantSame] of cases) {
  let toks, err = null;
  try { toks = yamlTokens(line); } catch (e) { err = e; }
  if (err) { console.log('FAIL  ' + label + '  抛出: ' + err.message); bad++; continue; }
  const gotCls = toks.map(t => t[0]).filter(Boolean).join(',');
  const rebuilt = toks.map(t => t[1]).join('');
  const same = rebuilt === line;
  const ok = gotCls === wantCls && (same === wantSame);
  if (!ok) bad++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label);
  console.log('      类别: ' + gotCls + (gotCls === wantCls ? '' : '  (期望 ' + wantCls + ')'));
  if (!same) console.log('      重建: ' + JSON.stringify(rebuilt) + '  (期望 ' + JSON.stringify(line) + ')');
}

// 异常回退：yamlTokens 对垃圾输入必须抛错，renderPreview 必须 try/catch 兜底
let threw = false;
try { yamlTokens(null); } catch (e) { threw = true; }
const hasFallback = /try \{ toks = yamlTokens\(line\); \} catch \(e\) \{ toks = null; \}/.test(src);
console.log((threw ? 'PASS  ' : 'FAIL  ') + '异常输入抛错（交给上层回退）');
console.log((hasFallback ? 'PASS  ' : 'FAIL  ') + 'renderPreview 有 try/catch 原文回退');
if (!threw || !hasFallback) bad++;

// 安全：预览渲染不得使用 innerHTML
const rpStart = src.indexOf('function renderPreview(text) {');
const rpEnd = src.indexOf('  // ── 导入 ──', rpStart);
const rpBody = src.slice(rpStart, rpEnd);
const usesInnerHTML = /innerHTML/.test(rpBody);
console.log((usesInnerHTML ? 'FAIL  ' : 'PASS  ') + '预览渲染不使用 innerHTML');
if (usesInnerHTML) bad++;

console.log(bad === 0 ? 'ALL PASS' : bad + ' FAILED');
process.exit(bad === 0 ? 0 : 1);
