/**
 * 产出路由器 kit 的输入树到 dist/（make-router-kit.mjs 读它）。
 *
 * 零构建：只把要发布的文件挑出来复制过去，顺带排除只用于开发的 tests/；打开
 * dist/index.html 与根目录 index.html 完全等价。dist/ 不再对外部署。
 *   bun scripts/build.mjs
 */
import { cp, mkdir, rm, readdir, stat, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

// 发布清单：显式列出，避免误把 tests/ 或 fixtures 带进产物
const INCLUDE = ['index.html', 'app', 'README.md', 'LICENSE'];

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

const copied = [];
const missing = [];
for (const name of INCLUDE) {
  const from = join(ROOT, name);
  if (!(await exists(from))) {
    missing.push(name);
    continue;
  }
  await cp(from, join(DIST, name), { recursive: true });
  copied.push(name);
}

// 必需文件缺了就直接失败：index.html 一旦被改名或误删，dist/ 会照样产出、kit 一片 404。
if (missing.includes('index.html') || missing.includes('app')) {
  throw new Error('必需文件缺失，未产出 dist/: ' + missing.filter((n) => n === 'index.html' || n === 'app').join(', '));
}
if (missing.length) console.warn('跳过不存在的可选文件: ' + missing.join(', '));

// 保险：dist 里不该出现的东西
const listing = await readdir(DIST);
const forbidden = listing.filter((n) => n === 'tests' || n === 'scripts' || n === 'node_modules');
if (forbidden.length) {
  throw new Error('dist 里出现了不该发布的目录: ' + forbidden.join(', '));
}

// ── 发布版把 HTML 注释剥掉 ────────────────────────────────────────────
// 注释留给维护，发出去的页面不该带着它们；只动 dist/ 里这份副本，仓库 index.html 不动。
// 注意：页面没有内联 <script>，也没有脚本靠注释当标记，所以 `<!-- … -->` 一刀切是安全的。
const distHtml = join(DIST, 'index.html');
const rawHtml = await readFile(distHtml, 'utf8');
const noComments = rawHtml.replace(/<!--[\s\S]*?-->/g, '');
if (noComments.length !== rawHtml.length) {
  await writeFile(distHtml, noComments);
  console.log(`dist/index.html 剥掉 HTML 注释：${rawHtml.length - noComments.length} 字符`);
}

// ⚠️ 自检：HTML 里引用的本地 js/css 必须真的在 dist/ 里，否则构建绿、部署后白屏。
const refs = [...noComments.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
const broken = [];
for (const ref of refs) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref) || ref.startsWith('/')) continue;
  const rel = ref.split('#')[0].split('?')[0];
  if (!rel) continue;
  if (!(await exists(join(DIST, rel)))) broken.push(ref);
}
if (broken.length) throw new Error('index.html 引用的文件不在 dist/ 里: ' + broken.join(', '));

console.log(`built dist/ ← ${copied.join(', ')}`);
