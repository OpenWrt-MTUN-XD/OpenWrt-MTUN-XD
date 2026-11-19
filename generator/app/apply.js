/*!
 * iStoreOS-Mihomo-config 生成器 — 「载入配置文件」
 *
 * 点了之后把最近一次生成的配置 POST 给路由器上的 CGI，由它替换 /etc/mihomo/config.yaml 并让
 * mihomo 重载（见 deploy/mihomo-apply）；mihomo 的 API 不能写文件。
 *
 * 注意：只有两条直接写盘的路 —— ① 本页自己的 origin（隧道 / DNAT 都把那个口映射到 uhttpd 80）；
 * ② 同一主机的协议默认口，只对 http 页面。够不着就直接报错并说清下一步，「信箱」已删。
 * 注意：只写文件、不做热载到内存（PUT /configs 只改内存、重启回滚）；按钮只在拿到 secret 且探到
 * 写盘口通时才显示，只认 secret.js 选出来的那一把，不做多密码轮询。
 */
(function (root) {
  'use strict';

  var doc = root.document;
  if (!doc) return;

  function toast(msg, kind) {
    if (root.MH && root.MH.ui && root.MH.ui.toast) root.MH.ui.toast(msg, kind);
    else if (root.console && root.console.log) root.console.log('[apply] ' + msg);
  }

  /**
   * 取 mihomo 的 secret，取不到返回空串 —— 调用方据此决定不显示按钮。
   * 实现在 secret.js 里（<head> 先加载），这里只转发，保证只有一份实现。
   */
  function readSecret() {
    return (root.MHSecret && root.MHSecret.read) ? root.MHSecret.read() : '';
  }

  // 写盘口怎么找（顺序很要紧，命中就不试后面的）：
  //   ① 本页自己的 origin —— 隧道 / DNAT 都把那个口映射到机器上的 uhttpd 80。
  //   ② 同一主机的协议默认口（http → 80），给「页面开在 9090、CGI 在 80」那种布局兜底。
  // 注意：不再有写死的 58080 —— 页面跟写盘口现在天生同源，留着只会多等一次 2.5 秒超时。
  var CGI_PATH = '/cgi-bin/mihomo-apply';

  function cgiUrl(base, port) {
    return base + (port ? ':' + port : '') + CGI_PATH;
  }

  /**
   * 同源那条的探测只认 405：写盘 CGI 对任何非 POST 都回 `405 only POST`，是这条路真通到
   * 写盘口的铁证。注意：不能用「有响应就算」的松判据 —— 页面开在 :9090 时同源打的是内核
   * 自己的 API，它对 /cgi-bin/mihomo-apply 回 404，必须排掉才能落到协议默认口那条。
   */
  function probeCgi(url) {
    var AC = root.AbortController;
    if (!AC) return Promise.resolve(false);
    var ac = new AC();
    var timer = setTimeout(function () { ac.abort(); }, 2500);
    return root.fetch(url, { method: 'GET', cache: 'no-store', signal: ac.signal })
      .then(function (r) { clearTimeout(timer); return r.status === 405; },
            function () { clearTimeout(timer); return false; });
  }

  /**
   * 找出写盘 CGI 在哪个端口。不能写死端口（各台 uhttpd 露出来的口不一样），探不到就返回
   * null，调用方据此报错。注意：串行探、别并发 —— 两个口都通时会白写两次。
   */
  function findCgi(base) {
    var loc = root.location;
    // ① 先试本页自己的 origin（端口就是地址栏那个，隧道 / 映射成多少都行），且不缓存探测
    //    结果：口子可能随映射或换网变化。页面由 uhttpd 发时这条必中。
    var sameOrigin = (loc.protocol || 'http:') + '//' + loc.host + CGI_PATH;
    return probeCgi(sameOrigin).then(function (ok) {
      if (ok) return sameOrigin;

      // ② 同一主机的协议默认口，只对 http 页面有意义（页面在 9090、CGI 在 80）。https 页面
      //    不试这一档：等于去试 443，白等 2.5 秒；真在 443 上页面本身也就开在 443，① 已命中。
      if (loc.protocol === 'https:') return null;
      // 这里也用严判 405：uhttpd 在、但 CGI 没装时它回 404/302，松判据会把按钮显示出来、点了必然失败。
      return probeCgi(cgiUrl(base, 0)).then(function (ok2) {
        return ok2 ? cgiUrl(base, 0) : null;
      });
    });
  }

  /**
   * 写盘。密码只用面板里那一把（见 secret.js）：一台面板管一台，不试别的、也不弹框问，
   * 密码不对就直接报错。
   */
  /**
   * 载入成功后瞄一眼广告清单拉没拉下来（只在本页同源能问到内核时才查）。清单走 jsDelivr
   * （约 4 MB），首次要几秒到几十秒，所以轮询几次再下结论，免得一上来读到 ruleCount=0 就误报。
   */
  function checkAdblock(secret, tries) {
    if (!root.fetch || !root.location || !root.location.origin) return;
    var left = tries == null ? 6 : tries;
    root.fetch(root.location.origin + '/providers/rules', {
      cache: 'no-store',
      headers: { Authorization: 'Bearer ' + secret }
    }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (j) {
      if (!j) return;                       // 同源不是内核（页面在 uhttpd 上）→ 跳过
      var p = j.providers && j.providers.adblock;
      if (p && p.ruleCount > 0) return;     // 拉下来了
      if (left > 1) { root.setTimeout(function () { checkAdblock(secret, left - 1); }, 5000); return; }
      toast('广告清单还没拉下来（内核 ruleCount = 0）—— 过几分钟再看一次', 'err');
    }, function () { /* 问不到就跳过 */ });
  }

  function writeFile(cfg, yaml) {
    // A-3′：按钮级防重复 —— 双击/回车上屏都只发一次写盘请求
    var btn = doc.getElementById('apply-btn');
    if (btn && btn.disabled) return;
    var label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '载入中…'; }
    function done() {
      if (btn) { btn.disabled = false; btn.textContent = label; }
    }

    function post(secret) {
      // A-1′：写盘要跑 mihomo -t（最长 25s）再重载，必须给超时；否则慢机上页面永远停在「正在载入…」
      var ac = root.AbortController ? new root.AbortController() : null;
      var timer = ac ? root.setTimeout(function () { ac.abort(); }, 60000) : null;
      root.fetch(cfg.url, {
        method: 'POST',
        // 带 Authorization 就不是简单请求，浏览器会先发 OPTIONS 预检；CGI 那边已把
        // Authorization 列进 Allow-Headers，否则会被拦掉。
        headers: {
          'Content-Type': 'text/plain;charset=utf-8',
          'Authorization': 'Bearer ' + secret
        },
        body: yaml,
        signal: ac ? ac.signal : undefined
      }).then(function (r) {
        // 超时要一直管到 body 读完：CGI 是一次性输出，但「头到了、body 卡住」也该有上限
        return r.text().then(function (text) {
          if (timer) root.clearTimeout(timer);
          return { ok: r.ok, status: r.status, text: text };
        });
      }).then(function (res) {
        done();
        // ⚠️ 提示里带上**写到哪台机器** —— 页面所在的那台，先把这事说清楚免得误伤。
        if (res.ok) {
          // CGI 回的是 `ok <字节数> (reload: api (地址) | restart | none)`，**none 是失败**：
          // 文件写进去了但内核一个字节都没吃上，这时不能说「已载入配置文件」。
          var m = /reload:\s*([^\s)]+)/.exec(res.text || '');
          if (m && m[1] === 'none') {
            toast('只写进了文件，内核没吃上 —— 重启内核才生效：/etc/init.d/mihomo restart', 'err');
            return;
          }
          if (!m) {
            // A-2′：没拿到 reload 字段（CGI 改版 / 老格式）→ 跟 none 同级谨慎，别谎报成功
            toast('配置已写入，但没拿到内核重载结果 —— 到路由器上确认一下是否已生效', 'err');
            return;
          }
          toast('已载入配置文件（' + root.location.hostname + '）', 'ok');
          // 只在**这份配置里真有 adblock 规则集**时才去盯它 —— 否则用户没勾广告拦截，30 秒后会
          // 莫名收到一条「广告清单还没拉下来（ruleCount = 0）」的红字。
          if (cfg.hasAdblock) checkAdblock(secret);
          return;
        }

        if (res.status === 401 || res.status === 403) {
          toast('载入失败：密码不对（' + res.status + '）—— 面板里这台的密码填对了没', 'err');
          return;
        }

        var msg = res.text;
        try { msg = JSON.parse(res.text).message || msg; } catch (e) { /* 不是 JSON 就用原文 */ }
        toast('载入失败：' + (msg || res.status), 'err');
      }).catch(function (e) {
        done();
        if (timer) root.clearTimeout(timer);
        if (e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')))) {
          toast('等不到写盘回执（60 秒）—— 到路由器上看 /etc/mihomo/config.yaml 是否已更新', 'err');
          return;
        }
        toast('载入失败：连不上写盘接口', 'err');
      });
    }

    post(cfg.secret);
  }

  /**
   * 只换 secret —— 「输错就换」那把紧急开关。
   *
   * 注意：浏览器手里没有当前 config.yaml（`GET /configs` 只吐 general），所以换密码只能让路由器
   * 上的 CGI 去改：`POST …/mihomo-apply?rotate=1` 只动 `secret:` 那一行。
   * 注意：认证用**旧的那把**（调用时机正是面板密码不对）；手里没有旧的那把就换不动 —— 这正是
   * 别人乱输也换不掉的原因，别当缺陷删掉。够不着写盘口就直接失败，不走要等 cron 的信箱。
   */
  function rotate(oldSecret) {
    var d = derive();
    if (!d.base) return Promise.reject(new Error('没有可用的地址'));
    return findCgi(d.base).then(function (url) {
      // ⚠️ 把试过哪些口写进报错里 —— 这条链是**静默**跑的，出问题时只有这几个字能帮你定位
      if (!url) throw new Error('够不着写盘接口（按序试过：本页 origin / 协议默认口）');
      // 这条链在「工具密码连错 3 次」时跑，门是 setBusy(true) 状态：POST 挂住会让门永远
      // 停在「校验中」，所以同样给 60s 上限。
      var ac = root.AbortController ? new root.AbortController() : null;
      var timer = ac ? root.setTimeout(function () { ac.abort(); }, 60000) : null;
      return root.fetch(url + '?rotate=1', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + oldSecret },
        body: '',
        signal: ac ? ac.signal : undefined
      }).then(function (r) {
        return r.text().then(function (text) {
          if (timer) root.clearTimeout(timer);
          if (!r.ok) {
            throw new Error('HTTP ' + r.status + ' ' + (text || '').trim().slice(0, 40) + ' @ ' + url);
          }
          return text;
        });
      });
    });
  }

  function apply(cfg, url) {
    // B-2：双击的第二下在这里就挡掉 —— 否则会多弹一条「正在载入…」
    var btn = doc.getElementById('apply-btn');
    if (btn && btn.disabled) return;
    var yaml = (root.MH && root.MH.ui && root.MH.ui.getGenerated)
      ? root.MH.ui.getGenerated() : '';
    if (!yaml) { toast('还没有可载入的配置，先生成一次', 'err'); return; }
    // url 是开页面时探好的（探不通压根不显示按钮）；万一那之后口子没了，writeFile 的报错会说出原因。
    if (!url) { toast('够不着写盘口', 'err'); return; }

    toast('正在载入…', 'ok');
    cfg.url = url;
    // 这份配置到底有没有广告清单（决定载入后要不要盯 ruleCount）：生成器勾了「广告拦截」
    // 才会写 `rule-providers: / adblock:`。
    // 用 YAML 解析判断「有没有 rule-providers.adblock」，不再猜文本形态。
    // 2/4 空格缩进、flow 写法、字段顺序怎么变都不会静默失效（tab 缩进本身就是非法 YAML）。
    try {
      // ⚠️ 变量名不能叫 doc —— 模块级的 doc 是 document，函数里再 var doc 会把它遮蔽掉，
      //    apply() 开头的 doc.getElementById 直接抛 TypeError，表现就是「点载入没反应」。
      var yamlDoc = null;
      if (root.MH && typeof root.MH.yamlLoad === 'function') yamlDoc = root.MH.yamlLoad(yaml);
      else if (root.jsyaml && typeof root.jsyaml.load === 'function') yamlDoc = root.jsyaml.load(yaml);
      cfg.hasAdblock = !!(yamlDoc && yamlDoc['rule-providers'] && yamlDoc['rule-providers'].adblock);
    } catch (e) {
      cfg.hasAdblock = false;   // 解析不了就不盯 ruleCount，不影响写盘
    }
    writeFile(cfg, yaml);
  }

  /**
   * 写盘接口不写死 —— 从「本页是怎么被访问到的」推出来：同一台主机（端口另探，见 findCgi），
   * 协议跟着本页走，免得 https 页面去调 http 被当成混合内容拦掉。
   * 注意：「监听地址」这里一个字都不碰，固定走出厂默认 127.0.0.1，要改自己在框里填。
   */
  function derive() {
    var loc = root.location;
    var host = loc && loc.hostname;
    if (!host) return {};
    return { base: (loc.protocol || 'http:') + '//' + host };
  }

  function install(cfg, url) {
    var btn = doc.getElementById('apply-btn');
    if (!btn) return;
    if (!url) {
      // 够不着写盘口 ⇒ 根本不显示「载入配置文件」（信箱已撤，按了也没用），但必须说一句为什么。
      var tip = doc.createElement('span');
      tip.style.cssText = 'font-size:13px; line-height:1.6; color:#8a93a0;';
      tip.textContent = '这台够不着写盘口 —— 从 LuCI 的「配置工具」页进（那页走的就是 80），'
        + '或者把这台的 80 端口映射/转发出来';
      btn.parentNode.insertBefore(tip, btn);
      return;
    }
    btn.hidden = false;
    btn.textContent = '载入配置文件';
    btn.addEventListener('click', function () { apply(cfg, url); });
  }

  function boot() {
    if (!root.fetch) return;

    var secret = readSecret();
    if (!secret) {
      // 没登录（面板里没有、也没过登录门）→ 不装「载入配置文件」，但要说明为什么：
      // 隐私模式禁 localStorage、或 secret.js 四路全空时会走到这里，静默消失太像坏了。
      if (root.console && root.console.log) {
        root.console.log('[apply] 拿不到 secret —— 不显示「载入配置文件」（这是有意的）');
      }
      var b0 = doc.getElementById('apply-btn');
      if (b0) {
        var t0 = doc.createElement('span');
        t0.style.cssText = 'font-size:13px; line-height:1.6; color:#8a93a0;';
        t0.textContent = '没拿到面板密码，所以没有「载入配置文件」——'
          + '到面板登录一次，或从面板绿点重新进入本页。';
        b0.parentNode.insertBefore(t0, b0);
      }
      return;
    }

    var gate = root.MHGate;
    if (gate && typeof gate.canLoad === 'function' && !gate.canLoad()) {
      // 只有面板密码（门上一把钥匙）→ 允许生成/下载，不给写盘
      var b = doc.getElementById('apply-btn');
      if (b) {
        var tip = doc.createElement('span');
        tip.style.cssText = 'font-size:13px; line-height:1.6; color:#8a93a0;';
        tip.textContent = '当前是「只下载」权限：可以生成、复制、下载配置；要直接载入路由器，'
          + '请从 LuCI 的「配置工具」页或面板绿点进入。';
        b.parentNode.insertBefore(tip, b);
      }
      return;
    }

    var d = derive();
    if (!d.base) return;

    // 先探一下写盘口通不通再决定显不显示按钮：信箱撤了，够不着时按了也没用，那就别显示（附原因）。
    var cfg = { secret: secret };
    findCgi(d.base).then(function (url) { install(cfg, url); });
  }

  // 给登录门用：它那个「输错就换」的紧急开关要通过这里走（端口探测那套只写一份）。
  root.MHApply = { rotate: rotate };

  // 过完登录门再跑：门会把校验通过的 secret 写进 localStorage，否则独立打开时按钮永远不出现。
  function start() {
    if (root.MHGate && typeof root.MHGate.run === 'function') root.MHGate.run(boot);
    else boot();
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();
})(typeof globalThis !== 'undefined' ? globalThis : this);
