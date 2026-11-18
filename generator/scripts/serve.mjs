/**
 * 本地静态服务器，只给开发/自测用：http 打开可顺带验证相对路径与 CORS 行为。
 *   bun scripts/serve.mjs [port]
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    // 目录穿越防护：必须用 relative() 判断，不能用 startsWith(ROOT) —— 字符串前缀比对
    // 会把 `../<仓库名>-evil/x` 当成在 ROOT 里放行。
    const file = normalize(join(ROOT, path));
    const rel = relative(ROOT, file);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const info = await stat(file);
    if (!info.isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch (e) {
    res.writeHead(404).end('not found');
  }
});

server.listen(PORT, () => {
  console.log(`iStoreOS-Mihomo-config生成器 → http://localhost:${PORT}/`);
});
