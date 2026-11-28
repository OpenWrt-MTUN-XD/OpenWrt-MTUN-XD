/*!
 * iStoreOS-Mihomo-config 生成器 — 机场订阅一次性拉取
 *
 * 只做「手动点一次、拉一次」：不保存 URL、不定时刷新、不托管订阅。
 * 浏览器直接 fetch 机场通常没有 CORS，所以由路由器上的 mihomo-sub CGI 代拉，
 * 前端拿到原文后仍交给 ui.importText()，解析/去重/大小限制全部复用现有导入链。
 */
(function (root) {
  'use strict';

  var PAGE_DOC = root.document;
  if (!PAGE_DOC) return;

  var CGI_PATH = '/cgi-bin/mihomo-sub';
  var MAX_WAIT = 60000;

  function toast(msg, kind) {
    if (root.MH && root.MH.ui && root.MH.ui.toast) root.MH.ui.toast(msg, kind);
    else if (root.console && root.console.log) root.console.log('[sub] ' + msg);
  }

  function note(msg) {
    var el = PAGE_DOC.getElementById('sub-note');
    if (el) el.textContent = msg;
  }

  function readSecret() {
    return (root.MHSecret && root.MHSecret.read) ? root.MHSecret.read() : '';
  }

  /**
   * 探测订阅 CGI。GET 只认 405：uhttpd 在但 CGI 没装时回 404/302，
   * 不能把“有响应”当成“接口可用”。
   */
  function probe(url) {
    var AC = root.AbortController;
    if (!AC) return Promise.resolve(false);
    var ac = new AC();
    var timer = root.setTimeout(function () { ac.abort(); }, 2500);
    return root.fetch(url, { method: 'GET', cache: 'no-store', signal: ac.signal })
      .then(function (r) { root.clearTimeout(timer); return r.status === 405; },
            function () { root.clearTimeout(timer); return false; });
  }

  /**
   * 和 apply.js 同一套顺序：先本页 origin，再同主机协议默认口（只对 http 页面）。
   * 页面在 9090、CGI 在 80 的布局靠第二步兜底。
   */
  function findCgi() {
    var loc = root.location;
    var proto = loc.protocol || 'http:';
    var same = proto + '//' + loc.host + CGI_PATH;
    return probe(same).then(function (ok) {
      if (ok) return same;
      if (proto === 'https:') return null;
      var fallback = 'http://' + loc.hostname + CGI_PATH;
      return probe(fallback).then(function (ok2) { return ok2 ? fallback : null; });
    });
  }

  function errorText(status, text) {
    var msg = String(text || '').trim();
    if (status === 401) return '还没从面板登录，无法拉取订阅';
    if (status === 403) return '面板密码不对，无法拉取订阅';
    if (status === 413) return msg || '订阅内容超过 10 MiB';
    if (status === 502) return msg || '订阅拉取失败';
    return msg || ('订阅拉取失败（HTTP ' + status + '）');
  }

  function startFetch() {
    var input = PAGE_DOC.getElementById('sub-url');
    var btn = PAGE_DOC.getElementById('sub-fetch');
    if (!input || !btn || btn.disabled) return;

    var url = String(input.value || '').trim();
    if (!url) {
      toast('请先填写机场订阅地址', 'err');
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      toast('订阅地址只支持 http/https', 'err');
      return;
    }

    var secret = readSecret();
    if (!secret) {
      toast('还没从面板登录，无法拉取订阅', 'err');
      return;
    }

    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '拉取中…';
    note('正在拉取订阅…');

    function done() {
      btn.disabled = false;
      btn.textContent = label;
    }

    findCgi().then(function (endpoint) {
      if (!endpoint) {
        throw new Error('够不着订阅拉取接口 —— 从 LuCI 的「配置工具」页进入，或把路由器 80 端口映射出来');
      }

      var AC = root.AbortController;
      var ac = AC ? new AC() : null;
      var timer = ac ? root.setTimeout(function () { ac.abort(); }, MAX_WAIT) : null;

      return root.fetch(endpoint, {
        method: 'POST',
        cache: 'no-store',
        headers: {
          'Content-Type': 'text/plain;charset=utf-8',
          'Authorization': 'Bearer ' + secret
        },
        body: url,
        signal: ac ? ac.signal : undefined
      }).then(function (r) {
        return r.text().then(function (text) {
          if (timer) root.clearTimeout(timer);
          return { ok: r.ok, status: r.status, text: text };
        });
      }).then(function (res) {
        done();
        if (!res.ok) throw new Error(errorText(res.status, res.text));
        if (!res.text) throw new Error('订阅返回空内容');
        if (!root.MH || !root.MH.ui || typeof root.MH.ui.importText !== 'function') {
          throw new Error('导入模块未加载');
        }
        var ph = root.MH.placeholderHint ? root.MH.placeholderHint(res.text) : '';
        if (ph) {
          note(ph);
          toast(ph, 'err');
          return;
        }
        var ok = root.MH.ui.importText(res.text, '订阅');
        note(ok ? '订阅已拉取并导入。' : '订阅已拉取，但没有导入有效节点。');
      }).catch(function (e) {
        done();
        if (timer) root.clearTimeout(timer);
        if (e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')))) {
          note('订阅拉取超时。');
          toast('订阅拉取超时（60 秒）', 'err');
          return;
        }
        var msg = (e && e.message) ? e.message : '订阅拉取失败';
        note(msg);
        toast(msg, 'err');
      });
    }).catch(function (e) {
      done();
      note(e.message || '订阅拉取失败');
      toast(e.message || '订阅拉取失败', 'err');
    });
  }

  function boot() {
    var btn = PAGE_DOC.getElementById('sub-fetch');
    var input = PAGE_DOC.getElementById('sub-url');
    if (btn) btn.addEventListener('click', startFetch);
    if (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          startFetch();
        }
      });
    }
  }

  if (PAGE_DOC.readyState === 'loading') PAGE_DOC.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);
