import assert from 'node:assert/strict';
import worker from './index.js';

const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url: String(url), method: opts.method, redirect: opts.redirect });
  if (String(url).endsWith('/releases/latest')) {
    return new Response(null, { status: 302, headers: { location: 'https://github.com/MetaCubeX/mihomo/releases/tag/v1.2.3' } });
  }
  return new Response('{"assets":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
};
const env = { ASSETS: { fetch: async () => new Response('asset', { status: 200 }) } };

const cases = [
  ['/gh-api/repos/MetaCubeX/mihomo/releases/tags/v1.2.3', 200],
  ['/gh-api/repos/MetaCubeX/metacubexd/releases?per_page=10', 200],
  ['/gh-api/repos/evil/repo/releases/tags/v1', 403],
  ['/gh-api/repos/MetaCubeX/mihomo/contents/x', 403],
  ['/gh/MetaCubeX/mihomo/releases/download/v1.2.3/mihomo.gz', 200],
  ['/gh/MetaCubeX/metacubexd/releases/latest', 302],
  ['/gh/MetaCubeX/mihomo/archive/main.zip', 403],
  ['/gh/evil/repo/releases/download/v1/x', 403],
  ['/gh/MetaCubeX/mihomo/%2e%2e/evil/repo/releases/download/v1/x', 403],
  ['/static.txt', 200],
];

for (const [path, want] of cases) {
  const res = await worker.fetch(new Request('https://cf.example' + path), env);
  assert.equal(res.status, want, path);
}

const post = await worker.fetch(new Request('https://cf.example/static.txt', { method: 'POST' }), env);
assert.equal(post.status, 405);
assert.ok(calls.some((c) => c.redirect === 'manual'));
console.log('worker allowlist ok');
