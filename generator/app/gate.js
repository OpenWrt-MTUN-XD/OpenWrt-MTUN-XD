/*!
 * 登录门 —— 两把钥匙、分两级：
 *   · LuCI「配置工具」页用 iframe 打开并带 `#tool=<pw>`（跨源留不了记号）：直通。
 *   · 从面板点绿点过来（同源 sessionStorage 有 FROM_PANEL_KEY，面板密码现成）：直通，不用工具密码。
 *   · 只输工具密码：进，但没有「载入配置文件」（apply.js 按 localStorage 有没有 secret 决定）。
 *   · 工具密码 + 有效面板密码：进，有「载入配置文件」。只有面板密码：不开门。
 *     例外是门上故意连错 3 次工具密码 → rotateOnWrong() 作废旧钥匙并放行。
 *
 * 注意：门上只显示工具密码一个框，面板密码框 hidden、值从面板 localStorage 自动带入；
 * 过期就清掉并按「只有工具密码」放行，绝不把人挡在门外。
 * 注意：不是 mihomo 发的页面（本地静态服务器 / file://）直接放行 —— 那里没有 /version 路由。
 * 注意：门内只能放哈希，不能写明文（静态文件全公开）；它是分发门槛，不是安全防线。
 * 注意：换的是工具密码（分发那把），不是面板密码；认证要手里的面板密码，外人换不掉。
 */
(function (root) {
  'use strict';

  var KEY = 'mihomo-gen-secret';      // 面板那把（跟 app/secret.js 的应急口子同一个键）

  // ── 工具密码 ────────────────────────────────────────────────────────
  // 页面里只放它的 SHA-256 —— 公开也没关系：12 位随机，哈希反推不出原文。
  // 哈希有两个来源，运行时优先 toolhash.txt（单独文件，每次 no-store 现拉）：
  //   ① `$G/toolhash.txt`：换密码要能立刻生效，而 gate.js 带 `?v=` 缓存，改它浏览器不一定马上看见。
  //   ② 下面的常量：装机时注进来的兜底，文件拿不到时用。
  // ⚠️ 这里是**占位**，不是任何人的密码哈希：安装器（deploy/generator.sh）铺页面时会把这一行
  //    改成本机 toolhash.txt 的值。留占位时门拒绝使用兜底 —— 否则「知道上游源码里那串哈希的人」
  //    就能在 toolhash.txt 拉不到的情况下进门。
  var TOOL_HASH = '0000000000000000000000000000000000000000000000000000000000000000';
  var TOOL_HASH_URL = './toolhash.txt';   // ⚠️ 相对路径：跟 index.html 同目录
  var TOOL_KEY = 'mihomo-gen-tool';   // 记住「这台过了工具密码」，省得每次都输

  var toolHash = '';   // 运行时从 toolhash.txt 读到的那个

  // 工具密码连错几次才当「故意输错」（= 换密码的紧急开关）：3 次 —— 错一次就换的话，
  // 机主手滑打错一个字符就把发出去的钥匙作废了。只算本次打开页面里的连续次数，输对或
  // 刷新就清零。
  var WRONG_LIMIT = 3;
  var wrongTries = 0;

  /** 当前该用哪个哈希 —— 读到文件就用文件的，读不到退回装机时注的那个常量。 */
  function currentHash() {
    if (toolHash) return toolHash;
    // 全 0 = 还没来得及跑安装器：不给兜底，宁可提示「去跑 mtun-xd tool」
    return /^0+$/.test(TOOL_HASH) ? '' : TOOL_HASH;
  }

  /** 带超时的 fetch：探路 / 校验 / 拉哈希都不允许无限挂住（挂住 = 界面永不初始化）。 */
  function fetchT(url, opts, ms) {
    if (!root.AbortController) return root.fetch(url, opts);
    var ac = new root.AbortController();
    var timer = root.setTimeout(function () { ac.abort(); }, ms || 2500);
    opts = opts || {};
    opts.signal = ac.signal;
    return root.fetch(url, opts).then(function (r) {
      root.clearTimeout(timer);
      return r;
    }, function (e) {
      root.clearTimeout(timer);
      throw e;
    });
  }

  /** 现拉一次 toolhash.txt（`no-store`）；拉不到就用兜底常量，别把门整个卡死。 */
  function loadToolHash() {
    if (!root.fetch) return Promise.resolve();
    return fetchT(TOOL_HASH_URL, { cache: 'no-store' }, 2500)
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (t) {
        t = (t || '').trim();
        if (/^[0-9a-f]{64}$/.test(t)) toolHash = t;
      }, function () { /* 拿不到就用兜底那份 */ });
  }

  // 绿点（deploy/btn.js）点下去时在同源 sessionStorage 留的记号：这一趟是从面板点过来的，
  // 有它就不用工具密码（面板密码同源现成）。它是每个标签页的：点绿点是同标签页跳转，
  // 书签另开标签页就没有。
  var FROM_PANEL_KEY = 'mihomo-gen-from-panel';

  var doc = root.document;

  // ── 先把主题定下来，否则门会先按浅色画一遍 ──────────────────────────
  // 本脚本在 <head> 里跑，而 ui.js 的 applyTheme() 要等过完门才跑，中间 <html> 上没有
  // data-theme；这里只按系统明暗先定一下，嵌在 LuCI 里时宿主随后会覆盖（主题不存档）。
  (function applyThemeEarly() {
    if (!doc || !doc.documentElement) return;
    // 宿主 / 面板 / 系统三选一，规则全在 app/theme-hint.js 里（别在这儿再写一份）
    var theme = (root.MHTheme && root.MHTheme.hint())
      || (root.MHTheme ? root.MHTheme.system() : 'light');
    doc.documentElement.setAttribute('data-theme', theme);
  })();

  var passed = false;          // 过了门就一路放行，后面再调 run 不用等
  // 可信入口（面板绿点 / LuCI 配置工具页）才有「载入配置文件」；直接打开只给下载。
  var trustedEntry = false;
  var waiting = [];      // 等门的回调（main.js 和 apply.js 各调一次 run）
  var probing = null;    // 探路只发一次
  var hashReady = null;  // toolhash.txt 只拉一次

  function $(id) { return doc ? doc.getElementById(id) : null; }

  // ── 防抖显形 ────────────────────────────────────────────────────────
  // 卡片默认 hidden，只有两种情况亮出来：① 真要他输密码；② 超过 REVEAL_MS 还没结果。
  // 注意：2500ms 是给隧道留的余量 —— 悄悄校验要打 /version，往返可能超过 400ms，计时器
  // 先到再收回就是卡片闪一下；真断网时最多多等两秒看到「验证中…」。
  var REVEAL_MS = 2500;
  var revealTimer = null;

  function reveal() {
    // 注意：id 是 `gate-form`（`gate-box` 是 class）—— 名字拿错卡片永远不显形，表现为一片空白。
    var box = $('gate-form');
    if (box) box.hidden = false;
    // 按钮出厂 disabled（防脚本未就绪就提交）；卡片显形时得放开，别让人对着点不动的「进入」干等。
    var ok = $('gate-ok');
    if (ok) ok.disabled = false;
  }
  function armReveal() {
    if (revealTimer === null) revealTimer = root.setTimeout(reveal, REVEAL_MS);
  }
  function disarmReveal() {
    if (revealTimer !== null) {
      root.clearTimeout(revealTimer);
      revealTimer = null;
    }
  }

  /**
   * 这台是不是 mihomo 在发页面？
   * 判据只有一条：/version 认不认这个路由 —— 没带密钥答 401/403、带了答 200，别处一律 404
   * 或连不上。注意：只看状态码、不带密钥，不能当登录校验用。
   */
  function servesMihomo() {
    return fetchT(root.location.origin + '/version', { cache: 'no-store' }, 2500)
      .then(function (res) {
        return !!(res.ok || res.status === 401 || res.status === 403);
      }, function () {
        return false;
      });
  }

  /** 拿面板那把去问 mihomo：200 = 对；401 / 403 = 错；其它状态当异常报出去。 */
  /** fetch 失败时的中文说明：超时单独成句，其它用原始消息。 */
  function fetchErrText(e) {
    var msg = String((e && e.message) || e || '');
    if ((e && e.name === 'AbortError') || /abort/i.test(msg)) return '面板接口没响应（4 秒超时）';
    return msg;
  }

  function verify(secret) {
    return fetchT(root.location.origin + '/version', {
      cache: 'no-store',
      headers: { Authorization: 'Bearer ' + secret }
    }, 4000).then(function (res) {
      if (res.ok) return true;
      if (res.status === 401 || res.status === 403) return false;
      throw new Error('HTTP ' + res.status);
    });
  }

  function remember(secret) {
    try { root.localStorage.setItem(KEY, secret); } catch (e) { /* 存不下也不影响这一趟 */ }
  }

  /** 是不是工具密码 —— 本地算哈希比对，不联网。注意：靠 app/vendor/sha256.js
   *  （`crypto.subtle` 在 http 下不存在，别换）。 */
  function isTool(pw) {
    if (!currentHash() || !pw) return false;
    if (!root.MHSha256 || !root.MHSha256.hex) return false;
    return root.MHSha256.hex(pw) === currentHash();
  }

  /** 页面缺 sha256.js（套件没铺全）—— 这时不管输什么都进不去，得说清是文件缺了不是密码错。 */
  function shaReady() {
    return !!(root.MHSha256 && root.MHSha256.hex);
  }

  function readTool() {
    try { return root.localStorage.getItem(TOOL_KEY) || ''; } catch (e) { return ''; }
  }

  function rememberTool(pw) {
    try { root.localStorage.setItem(TOOL_KEY, pw); } catch (e) { /* 存不下只是下次要再输 */ }
  }

  /**
   * 从 LuCI 嵌进来的那一趟：LuCI 本来就能读 /etc/mihomo-toolpass，把明文写进 iframe 的
   * `#tool=<pw>` 带过来（跨源留不了 FROM_PANEL_KEY 那种同源记号）。
   * 注意：能打开那个 LuCI 页的人本来就知道路由器密码，安全性不打折；读完把 hash 抹掉，
   * 别留在地址栏 / 历史里。
   */
  function takeToolFromHash() {
    var m = /(?:^|[#&])tool=([^&]+)/.exec((root.location && root.location.hash) || '');
    if (!m) return '';
    var pw = '';
    try { pw = decodeURIComponent(m[1]); } catch (e) { pw = m[1]; }
    try {
      root.history.replaceState(null, '', root.location.pathname + root.location.search);
    } catch (e) { /* 换不掉就算了，不影响这一趟 */ }
    return pw;
  }

  /**
   * 只清我们自己那个键（secret.js 的应急口子）。面板的 endpointList / selectedEndpoint
   * 一个字都不能动，那是人家面板的登录状态；清自己这个是为了让过期的旧密码别把面板里的
   * 新密码一直挡在后面。
   */
  function forget() {
    try {
      if (root.localStorage.getItem(KEY) !== null) root.localStorage.removeItem(KEY);
    } catch (e) { /* 忽略 */ }
    // 地址栏带进来的那一把（secret.js 的闭包缓存）也要作废，不然它会一直挡着面板里那把有效的。
    if (root.MHSecret && typeof root.MHSecret.forget === 'function') root.MHSecret.forget();
  }

  /** 开门：放行所有等着的回调（只开一次）。 */
  function open() {
    disarmReveal();      // 过了门就别让卡片再冒出来
    passed = true;
    setBusy(false);
    wrongTries = 0;      // 进来了就重新数（下次再连错 3 次才是新的一次「换密码」）
    var err = $('gate-err');   // 抹掉上一次那条红字，免得它跟着卡片再冒出来
    if (err) { err.textContent = ''; err.hidden = true; }
    var gate = $('gate');
    if (gate) gate.hidden = true;
    var q = waiting;
    waiting = [];
    for (var i = 0; i < q.length; i++) q[i]();
  }

  // ── 卡片上的那几个控件 ─────────────────────────────────────────────
  function setBusy(on) {
    var ids = ['gate-tool', 'gate-ok'], i;
    for (i = 0; i < ids.length; i++) {
      var el = $(ids[i]);
      if (el) el.disabled = on;
    }
    var desc = $('gate-desc');
    if (desc && on) desc.textContent = '验证中…';
  }

  /**
   * 切到「等你输密码」：err 有内容就连红字一起显示；prefill 里有什么就替你把哪个框填上
   * （从绿点/面板进来时面板那把已存在 localStorage，直接填好，你只要补另一把）。
   */
  function ask(err, prefill) {
    disarmReveal();      // 该他输密码了，防抖那个计时器没用了
    reveal();
    setBusy(false);
    var desc = $('gate-desc');
    if (desc) desc.textContent = '输入密码';
    var box = $('gate-err');
    if (box) {
      box.textContent = err || '';
      box.hidden = !err;
    }
    var t = $('gate-tool');
    if (t && prefill && prefill.tool) t.value = prefill.tool;
    // ⚠️ 只显示「工具密码」这一格，光标永远落它身上
    if (t) {
      t.focus();
      if (t.value) t.select();
    }
  }

  /**
   * 用户敲的那两格：工具密码不对就不开门（门只认它）；面板密码留空 → 进但没有 secret，
   * 「载入配置文件」不出现；填了就必须对（填错也不开门）；两个都对 → 写 secret 后放行。
   */
  function tryInput(toolPw, panelPw) {
    // 工具密码不对不一定是输错了，也可能是故意的：在门上连错 WRONG_LIMIT 次 = 作废当前
    // 这把工具密码。前两次老老实实报错（不然手滑一次就把发出去的钥匙作废了）。
    // 注意：换得动的前提是手里有面板密码，别人乱输换不掉，不是 DoS 洞；到了次数就不再
    // 往回数，后面每次错都再试一次，免得「差一次」的状态被刷新洗掉。
    if (!shaReady()) {
      ask('页面缺少 sha256.js（套件没铺全），在路由器上跑 mtun-xd setup 补齐');
      return;
    }
    if (!currentHash()) {
      ask('还没设置密码：在路由器上跑 mtun-xd tool 设一个');
      return;
    }
    if (!isTool(toolPw)) {
      wrongTries++;
      if (wrongTries >= WRONG_LIMIT) { rotateOnWrong(); return; }
      ask('密码不对');
      return;
    }
    wrongTries = 0;                       // 输对了就清零
    if (!panelPw) {                       // 只有半把钥匙：能用工具，碰不到机器
      rememberTool(toolPw);
      open();
      return;
    }
    setBusy(true);
    verify(panelPw).then(function (good) {
      if (!good) {
        // 面板那把过期/不对 —— 绝不能把人挡在门外：那格是自动带进来的，用户看不见也改不了。
        // 清掉它，按「只有工具密码」放行（能用工具，只是没有「载入配置文件」）。
        forget();
        rememberTool(toolPw);
        open();
        // 不弹提示、静默放行 —— 表现是「进去了，但没有『载入配置文件』」，去面板登一次就带对了。
        return;
      }
      rememberTool(toolPw);
      remember(panelPw);
      open();
    }, function (e) {
      ask('够不着面板接口：' + fetchErrText(e));
    });
  }

  /** 悄悄过一遍：把面板 localStorage 里现成的那把拿去问 mihomo，失败就清掉并退回「问密码」
   *  （顺手预填已经知道的那把）。 */
  function tryPanel(secret) {
    setBusy(true);
    verify(secret).then(function (good) {
      if (good) {
        remember(secret);
        open();
        return;
      }
      forget();          // 错的/过期的先清掉，免得它挡着面板里那把新的
      ask('密码不对', { tool: readTool() });
    }, function (e) {
      ask('够不着面板接口：' + fetchErrText(e));
    });
  }

  // 「输错就换」那把紧急开关也挂在生成器那边（连点页面标题 3 次），见 app/ui.js 的
  // bindSecretRotate()。注意：别只挪回门里 —— 门在两把钥匙都记着时是悄悄放行的、根本不弹框。

  /**
   * 工具密码连错 3 次 → 当作「作废当前工具密码」的紧急开关（门上和生成器里都能按，
   * 两处通向同一个动作）。
   *
   * 注意：认证靠手里存着的面板密码（写盘口认的就是它），没有它换不动、老实报「工具密码
   * 不对」—— 这也正好堵死了别人乱输的 DoS。换成了就直接放行，这是维护场景「只要有面板
   * 密码就放行」的例外，「门只认工具密码」那句别当成漏洞再修一次。
   */
  function rotateOnWrong() {
    var old = (root.MHSecret && root.MHSecret.read) ? root.MHSecret.read() : '';
    if (!old || !root.MHApply || typeof root.MHApply.rotate !== 'function') {
      // 手里没有面板密码（或 apply.js 没加载）→ 换不动，就当普通输错。
      // 注意：不要退回去「用面板密码放行」，那跟「只有面板密码不开门」直接冲突。
      ask('密码不对');
      return;
    }
    setBusy(true);
    root.MHApply.rotate(old).then(function (text) {
      var m = /^rotated[ \t]+(\S+)/m.exec(text || '');
      if (!m) throw new Error('回话看不懂');
      // 新钥匙记在本机（下次自动带上）并直接放行 —— 手里有面板密码就等于机主本人。
      try { root.localStorage.setItem(TOOL_KEY, m[1]); } catch (e) { /* 存不下也不影响这一趟 */ }
      // 内存里的哈希也换掉：万一这页后面还要再验一次（比如重开面板），不用刷新就认新密码。
      if (root.MHSha256 && root.MHSha256.hex) toolHash = root.MHSha256.hex(m[1]);
      var t = $('gate-tool');
      if (t) t.value = '';
      open();
    }, function () {
      // 换失败（够不着写盘口 / 认证不过）→ 就是「工具密码不对」，不放行
      ask('密码不对');
    });
  }

  function bindUI() {
    var form = $('gate-form');
    if (!form) return;
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var t = $('gate-tool');
      tryInput(t ? t.value : '', '');
    });
  }

  /**
   * 过门之后才跑 next()。可以调多次（main.js 启动界面、apply.js 显形按钮），只有第一次
   * 走流程，其余排队等开门 —— 不然会白问两遍 /version。
   */
  function run(next) {
    if (typeof next !== 'function') return;
    if (passed) { next(); return; }
    waiting.push(next);
    if (waiting.length > 1) return;   // 第一个已经在走流程了

    armReveal();   // 卡住了才亮卡片；顺利的话这一趟根本看不见它

    Promise.all([probing, hashReady]).then(function (r) {
      var isMihomo = r[0];
      if (!isMihomo) {
        // 不是 mihomo 发的页面（本地静态服务器 / file://）—— 没部署东西，直接放行。
        open();
        return;
      }

      var secret = (root.MHSecret && root.MHSecret.read) ? root.MHSecret.read() : '';
      var tool = readTool();
      var fromPanel = false;
      try { fromPanel = root.sessionStorage.getItem(FROM_PANEL_KEY) === '1'; } catch (e) { /* 忽略 */ }

      // ⓪ 从 LuCI 的「配置工具」进来的：工具密码由 LuCI 读 /etc/mihomo-toolpass 后写进 iframe
      //    的 `#tool=`（跨源，留不了记号）。验一下就用，效果同手输：进得去，但没有面板密码
      //    就没有「载入配置文件」。
      var fromLu = takeToolFromHash();
      if (fromLu && isTool(fromLu)) { trustedEntry = true; rememberTool(fromLu); open(); return; }

      // ① 从绿点过来的（面板点那一下留了记号）→ 面板密码同源现成，验过直接进，不用工具密码。
      if (fromPanel && secret) { trustedEntry = true; tryPanel(secret); return; }

      // ② 两把都在手上（本机记过工具密码 + 面板登过）→ 也悄悄过
      if (secret && isTool(tool)) { trustedEntry = true; tryPanel(secret); return; }

      // ③ 剩下的（本机没记过工具密码）→ 问；已经知道的那把替你填好
      ask('', { tool: tool, panel: secret });
    }, function () {
      open();   // 探路都炸了（fetch 不可用之类）→ 放行，别把整个工具锁死
    });
  }

  /**
   * 能不能显示「载入配置文件」：只看「是不是可信入口」，与手输/自动无关。
   *   · 面板绿点 / LuCI「配置工具」页（#tool=）→ 能；
   *   · 直接打开本页（无论手输工具密码还是本机记住了它）→ 不能，只给下载。
   * 这是产品决定：写盘权限只给「从套件自己那两个入口进来」的人。
   */
  function canLoad() {
    return trustedEntry;
  }

  root.MHGate = { run: run, canLoad: canLoad };

  if (!doc) return;
  // 探路开场就发（脚本在 <head> 里，比正文脚本早），等正文解析完基本已经有结果了。
  probing = servesMihomo();
  // 工具密码的哈希也早点拉：换过工具密码之后，**必须用新的那份**才不会误判
  hashReady = loadToolHash();

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', bindUI);
  else bindUI();
})(typeof globalThis !== 'undefined' ? globalThis : this);
