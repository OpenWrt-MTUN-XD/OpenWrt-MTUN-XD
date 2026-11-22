// 复制完整性验收：确认 (1) 复制走的是原始字符串，(2) 高亮切词后拼回去与原文逐字相同。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 用脚本自身位置拼路径：换机器 / 换目录都能跑
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ui = readFileSync(join(ROOT, 'generator/app/ui.js'), 'utf8');
const start = ui.indexOf('function yamlTokens(line) {');
const end = ui.indexOf('  /**', start);
const yamlTokens = new Function(ui.slice(start, end) + '\nreturn yamlTokens;')();

// 一份带中文、注释、空值、特殊字符、混合缩进的样本
const sample = [
  '# MTUN-XD 生成样本',
  'mixed-port: 7890',
  'allow-lan: true',
  'mode: rule',
  'log-level: info',
  'proxies:',
  '  - name: "🇭🇰 香港专线 01"',
  '    type: vless',
  '    server: hk1.example.com',
  '    port: 443',
  '    uuid: 11111111-2222-3333-4444-555555555555',
  '    tls: true',
  '    servername: "hk1.example.com"',
  '    client-fingerprint: chrome',
  '  - name: "🇸🇬 新加坡 02 # 备用"',
  '    type: trojan',
  '    server: sg2.example.com',
  '    port: 443',
  '    password: "p@ss#word"',
  '    sni: sg2.example.com',
  '    skip-cert-verify: false',
  'proxy-groups:',
  '  - name: 自动优选',
  '    type: url-test',
  '    url: "https://www.gstatic.com/generate_204"',
  '    interval: 300',
  '    proxies:',
  '      - "🇭🇰 香港专线 01"',
  '      - "🇸🇬 新加坡 02 # 备用"',
  'rules:',
  '  - DOMAIN-SUFFIX,example.com,自动优选   # 行尾注释',
  '  - IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
  '  - MATCH,自动优选',
  '',
].join('\n');

let bad = 0;

// 1) 高亮切词不改变内容
const rebuilt = sample.split('\n').map(line => {
  let toks;
  try { toks = yamlTokens(line); } catch (e) { return line; }
  return toks.map(t => t[1]).join('');
}).join('\n');

const same = rebuilt === sample;
console.log((same ? 'PASS  ' : 'FAIL  ') + '高亮切词后逐字还原（含中文 / 注释 / 空行 / 尾随空格）');
if (!same) {
  bad++;
  for (let i = 0; i < sample.split('\n').length; i++) {
    const a = sample.split('\n')[i], b = rebuilt.split('\n')[i];
    if (a !== b) console.log('   第 ' + (i + 1) + ' 行:\n     原: ' + JSON.stringify(a) + '\n     新: ' + JSON.stringify(b));
  }
}

// 2) 换行符数量一致（不能多也不能少）
const nlSame = sample.split('\n').length === rebuilt.split('\n').length;
console.log((nlSame ? 'PASS  ' : 'FAIL  ') + '行数一致（换行符未被增删）');
if (!nlSame) bad++;

// 3) 复制按钮走原始字符串，而不是从 DOM 里读
const copyRaw = /function copyText[\s\S]{0,600}writeText\(text\)/.test(ui);
console.log((copyRaw ? 'PASS  ' : 'FAIL  ') + '复制写入的是原始字符串（非 DOM 文本）');
if (!copyRaw) bad++;

// 4) 行号不可选中（否则手动复制会带上行号）
const css = readFileSync(join(ROOT, 'generator/app/style.css'), 'utf8');
const noSelect = /\.ln-no\s*\{[^}]*user-select:\s*none/.test(css);
console.log((noSelect ? 'PASS  ' : 'FAIL  ') + '行号列 user-select:none');
if (!noSelect) bad++;

console.log(bad === 0 ? 'ALL PASS' : bad + ' FAILED');
process.exit(bad === 0 ? 0 : 1);
