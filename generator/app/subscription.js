/*!
 * iStoreOS-Mihomo-config 生成器 — 机场订阅一次性拉取
 *
 * 两跳编排：
 *   hop1 direct → 强制 WAN 直连，绕开 TUN / fake-ip
 *   hop2 tun    → 经本机 mihomo 的本地端口；没有端口时靠 TUN 接管
 *
 * 只有 hop1 拿不到内容（非 2xx / 网络失败 / 空正文）才自动走 hop2。
 * hop1 一旦 200，绝不再发第二次请求。
 * 不保存 URL、不定时刷新、不托管订阅。
 */
(function (root) {
  'use strict';

  var PAGE_DOC = root.document;
  if (!PAGE_DOC) return;

  var CGI_PATH = '/cgi-bin/mihomo-sub';
  var HOP_TIMEOUT = 45000;
  var TEMP_NOTE_MS = 8000;
  var inFlight = false;
  var hintText = '';
  var noteTimer = null;
  var lastUrl = '';
  var retryBtn = null;

  function toast(msg, kind) {
    if (root.MH && root.MH.ui && root.MH.ui.toast) root.MH.ui.toast(msg, kind);
    else if (root.console && root.console.log) root.console.log('[sub] ' + msg);
  }

  function rememberHint() {
    var el = PAGE_DOC.getElementById('sub-note');
    hintText = el ? el.textContent : '';
  }

  function showNote(msg) {
    var el = PAGE_DOC.getElementById('sub-note');
    if (!el) return;
    el.textContent = msg;
    if (noteTimer) root.clearTimeout(noteTimer);
    noteTimer = root.setTimeout(function () {
      var cur = PAGE_DOC.getElementById('sub-note');
      if (cur) cur.textContent = hintText;
    }, TEMP_NOTE_MS);
  }

  function removeRetry() {
    if (retryBtn && retryBtn.parentNode) retryBtn.parentNode.removeChild(retryBtn);
    retryBtn = null;
  }

  function showRetry() {
    removeRetry();
    var note = PAGE_DOC.getElementById('sub-note');
    if (!note) return;
    var btn = PAGE_DOC.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.id = 'sub-retry';
    btn.textContent = '经 mihomo 再试一次';
    btn.style.marginLeft = '8px';
    btn.addEventListener('click', function () {
      removeRetry();
      startFetch(true);
    });
    note.parentNode.insertBefore(btn, note.nextSibling);
    retryBtn = btn;
  }

  function readSecret() {
    return (root.MHSecret && root.MHSecret.read) ? root.MHSecret.read() : '';
  }

  function probe(url) {
    var AC = root.AbortController;
    if (!AC) return Promise.resolve(false);
    var ac = new AC();
    var timer = root.setTimeout(function () { ac.abort(); }, 2500);
    return root.fetch(url, { method: 'GET', cache: 'no-store', signal: ac.signal })
      .then(function (r) { root.clearTimeout(timer); return r.status === 405; },
            function () { root.clearTimeout(timer); return false; });
  }

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

  function nodeCount() {
    var st = root.MH && root.MH.ui && root.MH.ui.state;
    return (st && Array.isArray(st.nodes)) ? st.nodes.length : 0;
  }

  function routeLabel(route) {
    if (route === 'direct') return '直连';
    if (route === 'tun-port') return '经 mihomo（端口）';
    return '经 mihomo（TUN）';
  }

  function reasonMessage(status, text, reason) {
    var msg = String(text || '').trim();
    if (reason === 'no-secret') return 'mihomo 配置里没有 secret，订阅接口不可用';
    if (reason === 'bad-secret') return '面板密码不对，无法拉取订阅';
    if (reason === 'no-auth') return '还没从面板登录';
    if (reason === 'ssrf') return '不支持内网或本机地址';
    if (reason === 'no-space') return '路由器临时空间不足';
    if (reason === 'direct-unavailable') return '直连不可用（DNS 解析或 WAN 接口取不到），只能经 mihomo';
    if (reason === 'no-curl') return '路由器没有 curl，请先安装 curl 和 ca-bundle';
    if (status === 401) return '还没从面板登录';
    if (status === 403) return msg || '订阅接口拒绝访问';
    if (status === 413) return msg || '订阅内容超过 4 MiB';
    if (status === 504) return '订阅拉取超时';
    if (status === 507) return '路由器临时空间不足';
    if (status === 502) return msg || '订阅拉取失败';
    if (!status) return msg || '订阅拉取失败';
    return msg || ('订阅拉取失败（HTTP ' + status + '）');
  }

  function fetchHop(endpoint, url, route, secret) {
    // uhttpd 不传自定义 X-Sub-Route 头，因此 route 同时放进 query。
    var sep = endpoint.indexOf('?') === -1 ? '?' : '&';
    var hopUrl = endpoint + sep + 'route=' + encodeURIComponent(route);
    var AC = root.AbortController;
    var ac = AC ? new AC() : null;
    var timer = ac ? root.setTimeout(function () { ac.abort(); }, HOP_TIMEOUT) : null;

    return root.fetch(hopUrl, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8',
        'Authorization': 'Bearer ' + secret,
        'X-Sub-Route': route
      },
      body: url,
      signal: ac ? ac.signal : undefined
    }).then(function (r) {
      return r.text().then(function (text) {
        if (timer) root.clearTimeout(timer);
        return {
          ok: r.ok,
          status: r.status,
          text: text,
          route: (r.headers && r.headers.get && r.headers.get('X-Sub-Route')) || (route === 'direct' ? 'direct' : 'tun-plain'),
          upstream: (r.headers && r.headers.get && r.headers.get('X-Sub-Upstream')) || '',
          reason: (r.headers && r.headers.get && r.headers.get('X-Sub-Reason')) || ''
        };
      });
    }).catch(function (e) {
      if (timer) root.clearTimeout(timer);
      if (e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')))) {
        return { ok: false, status: 0, timeout: true, text: '', route: route, reason: '' };
      }
      return { ok: false, status: 0, error: String(e && e.message || e), text: '', route: route, reason: '' };
    });
  }

  function parserReason(text) {
    if (root.MH.placeholderHint) {
      var ph = root.MH.placeholderHint(text);
      if (ph) return ph;
    }
    if (root.MH.formatHint) {
      var fh = root.MH.formatHint(text);
      if (fh) return fh;
    }
    if (root.MH.yamlError) {
      var ye = root.MH.yamlError();
      if (ye) return 'Clash YAML 格式有误：' + ye;
    }
    return '没有可导入的有效节点';
  }

  function importAndNote(text, res, directStatus, input) {
    var before = nodeCount();
    var ok = root.MH.ui.importText(text, '订阅');
    var after = nodeCount();
    var route = routeLabel(res.route);
    var prefix = (directStatus != null && directStatus > 0)
      ? '直连失败（HTTP ' + directStatus + '），经 mihomo 拉取'
      : (res.route === 'direct' ? '直连拉取' : '经 mihomo 拉取');

    if (ok && after > before) {
      input.value = '';
      showNote(prefix + '成功，已新增 ' + (after - before) + ' 个节点。');
    } else if (ok && after === before) {
      showNote(prefix + '，没有新增节点（订阅里这些节点都已存在）。');
    } else {
      var reason = parserReason(text);
      showNote(prefix + '，但没有可导入的节点：' + reason);
      showRetry();
    }
  }

  function startFetch(forceTun) {
    var input = PAGE_DOC.getElementById('sub-url');
    var btn = PAGE_DOC.getElementById('sub-fetch');
    if (!input || !btn || btn.disabled || inFlight) return;

    var url = forceTun ? lastUrl : String(input.value || '').trim();
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

    removeRetry();
    lastUrl = url;
    var label = btn.textContent;
    inFlight = true;
    btn.disabled = true;
    btn.textContent = '拉取中…';
    showNote(forceTun ? '正在经 mihomo 拉取…' : '正在直连拉取…');

    var before = nodeCount();

    function done() {
      inFlight = false;
      btn.disabled = false;
      btn.textContent = label;
    }

    function finishHop(res, directStatus) {
      if (!res.ok || !res.text) return false;
      if (input) input.value = '';
      importAndNote(res.text, res, directStatus, input);
      return true;
    }

    findCgi().then(function (endpoint) {
      if (!endpoint) throw new Error('够不着订阅拉取接口 —— 从 LuCI 的「配置工具」页进入，或把路由器 80 端口映射出来');

      function hop(route) {
        return fetchHop(endpoint, url, route, secret);
      }

      if (forceTun) {
        return hop('tun').then(function (res) {
          done();
          if (!res.ok || !res.text) {
            var msg = reasonMessage(res.status, res.text, res.reason);
            showNote('经 mihomo 拉取失败（' + (res.timeout ? '超时' : 'HTTP ' + (res.status || 0)) + '）：' + msg);
            toast(msg, 'err');
            return;
          }
          importAndNote(res.text, res, null, input);
        });
      }

      return hop('direct').then(function (res1) {
        if (res1.ok && res1.text) {
          // 200 已拿到正文：绝不再发第二次请求。
          done();
          if (input) input.value = '';
          importAndNote(res1.text, res1, null, input);
          return;
        }

        var directStatus = res1.timeout ? 0 : res1.status;
        showNote('直连失败（HTTP ' + (directStatus || 0) + '），改经 mihomo 拉取…');
        return hop('tun').then(function (res2) {
          done();
          if (res2.ok && res2.text) {
            if (input) input.value = '';
            importAndNote(res2.text, res2, directStatus, input);
            return;
          }
          var reason = reasonMessage(res2.status, res2.text, res2.reason);
          showNote('直连失败（HTTP ' + (directStatus || 0) + '），经 mihomo 也失败（HTTP ' + (res2.status || 0) + '）：' + reason);
          toast(reason, 'err');
        });
      });
    }).catch(function (e) {
      done();
      var msg = (e && e.message) ? e.message : '订阅拉取失败';
      showNote(msg);
      toast(msg, 'err');
    });
  }

  function boot() {
    rememberHint();
    var btn = PAGE_DOC.getElementById('sub-fetch');
    var input = PAGE_DOC.getElementById('sub-url');
    if (btn) btn.addEventListener('click', function () { startFetch(false); });
    if (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          startFetch(false);
        }
      });
    }
  }

  if (PAGE_DOC.readyState === 'loading') PAGE_DOC.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);
