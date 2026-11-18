/*!
 * 取 mihomo 的 secret —— 全站只有这一份实现（apply.js 也用它）。
 *
 * 页面本身是公开的（mihomo 静态服务没有登录层），所以「有没有登录」只能从能不能拿到
 * secret 上看出来。来源按顺序试：
 *   0. 地址里带过来的 `?secret=` / `#secret=`（LuCI 嵌入专用），用完立刻从地址栏抹掉；
 *   1. `window.__MHSECRET`（应急口子，目前没人注）；
 *   2. `localStorage['mihomo-gen-secret']` —— 登录门过完写进来的。优先级比面板高是有意的：
 *      门按它校验过，写盘就得用同一把；用户改密码后门下回校验 401，gate.js 会清掉这个键。
 *   3. 面板的 localStorage（endpointList / selectedEndpoint，MetaCubeXD 的 useLocalStorage）。
 *
 * 都取不到就返回空串，调用方据此不显示「载入配置文件」；任何一步出错都当「取不到」。
 */
(function (root) {
  'use strict';

  // 登录门（app/gate.js）过完就写这个键；也可以手动塞一个当应急口子
  var MANUAL_KEY = 'mihomo-gen-secret';

  /**
   * 从面板里取那一把密码：主机名跟本页对得上的那条优先，其次当前选中的，最后才退到第一条
   * —— 不能写死取第一条，万一临时挂了第二条，「页面这台」的那条才是写盘 CGI 认的。
   */
  function fromPanel() {
    var ls = root.localStorage;
    if (!ls) return '';
    try {
      var manual = ls.getItem(MANUAL_KEY);
      if (manual) return manual;

      var list = JSON.parse(ls.getItem('endpointList') || '[]');
      if (!list || !list.length) return '';

      var selId = ls.getItem('selectedEndpoint') || '';
      var sel = null, mine = null, sameHost = null, i, ep;
      for (i = 0; i < list.length; i++) {
        ep = list[i];
        if (!ep) continue;
        if (ep.id === selId) sel = ep;
        if (ep.url) {
          try {
            var u = new URL(ep.url);
            // 先按 host（含端口）找 —— 同一台机器可能挂了好几个后端，只有 host 完全一样的
            // 才是「页面这一台」；再退到同主机名。
            if (!mine && u.host === root.location.host) mine = ep;
            if (!sameHost && u.hostname === root.location.hostname) sameHost = ep;
          } catch (e) { /* 忽略 */ }
        }
      }
      ep = mine || sameHost || sel || list[0];
      return (ep && ep.secret) || '';
    } catch (e) {
      return '';
    }
  }

  /**
   * 0. 地址里带过来的 `?secret=` / `#secret=`（LuCI 嵌进来时专用）。
   *
   * 因为 LuCI 在 80、生成器在 9090，跨源写不了 localStorage，上面两条都用不上，「载入配置文件」
   * 就永远不出现；所以由 LuCI 从 config.yaml 读出面板密码、写进 iframe 地址带过来。
   * 注意：能打开那个 LuCI 页的人本来就有路由器密码，安全性不打折；地址栏那一下用完
   * 立刻抹掉，结果记在闭包里（apply.js 会多次调 read()，第二次不能变成「没有」）。
   */
  var urlSecret = null;

  function fromUrl() {
    if (urlSecret !== null) return urlSecret;
    var loc = root.location;
    if (!loc) { urlSecret = ''; return urlSecret; }
    var m = /[?&]secret=([^&]+)/.exec(loc.search || '');
    var inHash = false;
    if (!m) {
      m = /[#&]secret=([^&]+)/.exec(loc.hash || '');
      inHash = !!m;
    }
    if (!m) { urlSecret = ''; return urlSecret; }
    try { urlSecret = decodeURIComponent(m[1]); } catch (e) { urlSecret = m[1]; }
    try {
      // 只摘掉 secret 这一个参数，别的查询串（?t=…）原样留着
      var rest = String(loc.search || '').replace(/^\?/, '')
        .split('&').filter(function (kv) { return kv && kv.indexOf('secret=') !== 0; });
      var search = rest.length ? '?' + rest.join('&') : '';
      root.history.replaceState(null, '', loc.pathname + search + (inHash ? '' : (loc.hash || '')));
    } catch (e) { /* 抹不掉也不影响这一趟 */ }
    return urlSecret;
  }

  function read() {
    var fromAddr = fromUrl();
    if (fromAddr) return fromAddr;
    var injected = root.__MHSECRET;
    if (typeof injected === 'string' && injected) return injected;
    return fromPanel();
  }

  /**
   * 丢掉地址栏那一下带进来的 secret（门验证失败时调）。注意：只清 localStorage 不够 ——
   * 地址栏那份缓存在闭包里，清完 read() 还是它，写盘会一直 401/403 且回落不到面板里那把好的。
   */
  function forget() {
    urlSecret = '';
  }

  root.MHSecret = { read: read, forget: forget };
})(typeof globalThis !== 'undefined' ? globalThis : this);
