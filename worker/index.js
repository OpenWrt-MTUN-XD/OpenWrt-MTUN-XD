// Cloudflare Worker: proxy GitHub release metadata and assets through the CF edge.
//
// Only MetaCubeX release metadata/assets are allowed. Static assets in dist/ remain
// the fallback for every other path.
const ALLOW = new Set([
  'MetaCubeX/mihomo',
  'MetaCubeX/metacubexd',
  'MetaCubeX/meta-rules-dat',
]);

function allowed(kind, path) {
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false;
  }
  const seg = decoded.split('/').filter(Boolean);
  if (seg.some((s) => s === '.' || s === '..')) return false;

  if (kind === 'api') {
    // /gh-api/repos/<owner>/<repo>/releases...
    return seg[0] === 'repos' &&
      seg.length >= 4 &&
      seg[3] === 'releases' &&
      ALLOW.has(seg[1] + '/' + seg[2]);
  }

  // /gh/<owner>/<repo>/releases/latest or .../releases/download/...
  return seg.length >= 4 &&
    seg[2] === 'releases' &&
    (seg[3] === 'latest' || seg[3] === 'download') &&
    ALLOW.has(seg[0] + '/' + seg[1]);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('method not allowed', { status: 405 });
    }

    let kind = '';
    let rest = '';
    if (url.pathname.startsWith('/gh-api/')) {
      kind = 'api';
      rest = url.pathname.slice('/gh-api'.length) + url.search;
    } else if (url.pathname.startsWith('/gh/')) {
      kind = 'asset';
      rest = url.pathname.slice('/gh'.length) + url.search;
    } else {
      return env.ASSETS.fetch(request);
    }

    const path = rest.split('?')[0];
    if (!allowed(kind, path)) return new Response('forbidden', { status: 403 });

    const latest = kind === 'asset' && /\/releases\/latest$/.test(path);
    const origin = kind === 'api' ? 'https://api.github.com' : 'https://github.com';
    const ttl = kind === 'api' ? 300 : (latest ? 60 : 86400);

    try {
      const upstream = await fetch(origin + rest, {
        method: request.method,
        redirect: latest ? 'manual' : 'follow',
        headers: {
          'user-agent': 'MTUN-XD',
          ...(kind === 'api' ? { accept: 'application/vnd.github+json' } : {}),
        },
        cf: { cacheEverything: true, cacheTtl: ttl },
      });
      const headers = new Headers(upstream.headers);
      headers.set('access-control-allow-origin', '*');
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    } catch {
      return new Response('bad gateway', { status: 502 });
    }
  },
};
