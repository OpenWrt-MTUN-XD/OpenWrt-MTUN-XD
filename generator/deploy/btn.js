/*!
 * 面板左下角那个小绿点 —— 点它进配置生成器（相对路径跳 `./config/`，不涉及任何凭据）。
 *
 * 位置跟着面板左下角那个版本按钮（aria-label 形如 `UI v… · Core v…`）跑：点击区左上角 =
 * 按钮左上角 + 按钮边长/3 处（见 OFF_DIV）。
 *
 * 注意：找不到那个按钮就什么都不显示、没有兜底位置 —— 包括还没登录的时候（那时 aria-label 里
 * 没有内核版本号，匹配不到）；侧边栏展开时面板不渲染那个按钮，就把点藏起来，收起后直接亮出来。
 * 注意（改这个文件前先看）：① 量不到按钮时等最后一次位置变化后 500ms 再亮（防抖），别先画在
 * 别处；② 按钮瞬间量不到是正常的，藏起来就好；③ ResizeObserver 要盯按钮外面那个容器（侧边栏
 * 伸缩时按钮位置变、尺寸不变），并且等按钮出现之后再注册，不能盯 document.body。
 * 谁挂进来的：面板 /etc/mihomo/ui/config.js 末尾（deploy/generator.sh 追加）用 <script src> 引入。
 */
(function () {
  'use strict';

  /* ⚠️ 默认画。
   *
   * 为什么画：只映射了一个 9090 的机器进不了 uhttpd 上那排 LuCI 入口，绿点是那类机器上进生成器
   * 的唯一入口（生成器跟面板同源，跳一下 `./config/`）；LuCI「配置工具」那条照旧并存。
   * 注意：开关放在这个文件里而不是只靠 config.js 那行钩子 —— config.js 是浏览器缓存重灾区
   * （mihomo 只发 Last-Modified），而它每次引的都是 `btn.js?v=<时间戳>`，只有在这里收工才能
   * 「立刻没有点」；反过来老缓存里的钩子引到的也是这份新代码。
   * 调试：?dotdbg=1 看实时读数、?dotdrag=1 拖着调位置（读数里的 off= 就是偏移）。
   */
  // 嵌在别人页面里的面板不画这个点：LuCI 里「控制面板」那一页是把面板塞进 iframe 显示的，那边
  // 本来就有「配置工具」标签；只有直接开 9090 才画 —— 那正是只映射 9090 的机器唯一的门。
  // 注意：跨源也能这么比，只拿 `window.top` 这个引用做身份比较，不去碰它的内容。
  if (window.self !== window.top) return;

  var ID = 'mihomo-gen-dot';
  var BOX = 28;        // 点击区的边长，圆点是它正中的 12px
  // 点击区左上角相对版本按钮左上角的固定偏移。
  // 注意：偏移按按钮尺寸算，不是写死的像素 —— 按钮 36px 时就是 +12,+12，将来变大变小自己跟着走。
  var OFF_DIV = 3;
  var SETTLE = 500;    // 位置最后一次变化之后，再等这么久没动静才显形
  // ⚠️ 这里故意没有「一直找不到按钮就退到哪个角落」的兜底 —— 见 place() 末尾。

  var revealTimer = null;
  var revealed = false;
  var lastKey = null;
  var ro = null, roTarget = null;
  var appliedL = null, appliedT = null;   // 上次真正写进 style 的值

  function anchor() {
    // ⚠️ 匹配串是 "Core v"，这是故意的 —— 版本按钮的 aria-label 有两种形态：
    //      连上后端了：`UI v1.273.1 · Core v1.19.32` → 命中
    //      没连上 / 还没登录：`UI v1.273.1 · Core `（内核版本空）→ 不命中，绿点干脆不显示
    //    用「有没有内核版本号」判断连没连上，比另外探测登录状态可靠；别放宽成 "UI v"。
    // ⚠️ 不能直接 querySelector 拿第一个：不同宽度/布局下可能渲染出不止一个匹配元素，拿错就贴到
    //    别的元素上。取最靠下的那个 —— 侧边栏底部那个版本按钮才是要贴的目标。
    var all = document.querySelectorAll('[aria-label*="Core v"]');
    var best = null, bestTop = -Infinity;
    for (var i = 0; i < all.length; i++) {
      var r = all[i].getBoundingClientRect();
      if (!r.width || !r.height) continue;      // 还没排好版的不算
      if (r.top > bestTop) { bestTop = r.top; best = all[i]; }
    }
    return best;
  }

  // ── 调试模式（正常访问完全不会有）──────────────────────────────
  //   ?dotdbg  = 右下角把量到的数字写出来
  //   ?dotdrag = 再加上「能拖着点走」；读数里的 off= 就是它相对锚点的偏移。
  var DRAG = location.search.indexOf('dotdrag') !== -1;
  var DBG = DRAG || location.search.indexOf('dotdbg') !== -1;   // dotdrag 也带读数
  var dragging = false, dragMoved = false, frozen = false;

  function dbg(a) {
    if (!DBG || !document.body) return;
    var n = document.querySelectorAll('[aria-label*="Core v"]').length;
    var t = anchor();
    var r = t ? t.getBoundingClientRect() : null;
    var d = a.getBoundingClientRect();
    var el = document.getElementById(ID + '-dbg');
    if (!el) {
      el = document.createElement('div');
      el.id = ID + '-dbg';
      el.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:2147483647;' +
        'background:#000;color:#0f0;font:11px/1.5 monospace;padding:6px 8px;border:1px solid #0f0';
      document.body.appendChild(el);
    }
    el.textContent = 'local=' + (isLocalBackend() ? '1' : '0') + ' wp=' + String(_wp) +
      ' matches=' + n +
      '  anchor=' + (r ? Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) : 'none') +
      '  dot=' + Math.round(d.left) + ',' + Math.round(d.top) +
      '  off=' + (r ? (Math.round(d.left - r.left) >= 0 ? '+' : '') + Math.round(d.left - r.left) + ',' + (Math.round(d.top - r.top) >= 0 ? '+' : '') + Math.round(d.top - r.top) : '-') +
      '  vp=' + window.innerWidth + 'x' + window.innerHeight + '  dpr=' + window.devicePixelRatio +
      (DRAG ? '   【可拖动】' : '');
  }

  function makeDraggable(a) {
    var sx = 0, sy = 0, sl = 0, st = 0;
    a.addEventListener('pointerdown', function (e) {
      dragging = true;
      dragMoved = false;
      var r = a.getBoundingClientRect();
      sl = r.left; st = r.top; sx = e.clientX; sy = e.clientY;
      try { a.setPointerCapture(e.pointerId); } catch (err) { /* 无所谓 */ }
      e.preventDefault();
    });
    a.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 2) dragMoved = true;
      a.style.left = (sl + e.clientX - sx) + 'px';
      a.style.top = (st + e.clientY - sy) + 'px';
      a.style.bottom = 'auto';
      dbg(a);
    });
    function end(e) {
      dragging = false;
      // 真拖过（不是点一下）就冻住 —— 位置留着给人看，读数也留着给人抄（见 place）
      if (dragMoved) frozen = true;
      try { a.releasePointerCapture(e.pointerId); } catch (err) { /* 无所谓 */ }
    }
    a.addEventListener('pointerup', end);
    a.addEventListener('pointercancel', end);
  }

  function reveal(a) {
    if (revealed) return;
    revealed = true;
    a.style.opacity = '1';
    a.style.pointerEvents = 'auto';   // 显形了才接点击
    a.setAttribute('tabindex', '0');  // 显形前也不该被 Tab 停到
  }

  // 盯住按钮外面那个容器 —— 侧边栏伸缩时它宽度变，我们每帧都能收到通知
  function watch(el) {
    if (!window.ResizeObserver) return;
    var target = el.parentElement;
    if (!target || target === roTarget) return;
    if (ro) ro.disconnect();
    roTarget = target;
    ro = new ResizeObserver(function () {
      var a = document.getElementById(ID);
      if (a) place(a);
    });
    ro.observe(target);
  }

  // 面板连的是不是本机这台？—— 「打开面板用的地址」跟「已连接的后端」对得上才算。
  // 面板里可以挂好几个后端，正看着别人时绿点不该出现：生成器是本机的 `/ui/config/`（写盘 CGI
  // 也在本机），点了会把本机的配置换掉。
  // 端点列表和选中项都在 localStorage 里（MetaCubeXD 的 endpointList / selectedEndpoint）。
  // ⚠️ 比的是 host（带端口）—— 同一个主机名不同端口就是不同的后端。
  var _epKey = null, _epLocal = false;
  function isLocalBackend() {
    try {
      var raw = localStorage.getItem('endpointList') + '|' + localStorage.getItem('selectedEndpoint');
      if (raw !== _epKey) {                       // 变了才算一次，别每 150ms 都解析
        _epKey = raw;
        _epLocal = false;
        var list = JSON.parse(localStorage.getItem('endpointList') || '[]');
        var selId = localStorage.getItem('selectedEndpoint') || '';
        for (var i = 0; i < list.length; i++) {
          var ep = list[i];
          if (ep && ep.id === selId && ep.url) {
            try { _epLocal = (new URL(ep.url).host === location.host); } catch (e) { _epLocal = false; }
            break;
          }
        }
      }
      return _epLocal;
    } catch (e) { return false; }
  }

  // ⚠️ 只有写盘口够得着的地方才显示绿点：绿点点开就是生成器，而生成器唯一的出口是「载入配置文件」，
  //    写盘口够不着时那个按钮根本不显示，绿点就成了「点了也没用的门」。典型是直接从 9090 进面板
  //    那种机器（面板由内核发，uhttpd 那个口没露出去）。
  //    判据跟 apply.js 的 findCgi 同一套：① 本页 origin 的 /cgi-bin/mihomo-apply 回 405；
  //    ② 兜底同主机的协议默认口（http → 80，https 不试 443）。
  //    ⚠️ 这段逻辑是刻意复制的，不能直接调 apply.js 的 probeCgi：绿点跑在面板页面里，
  //       那里根本没有加载 apply.js（两套 bundle 完全独立）。改判据时**两边一起改**。
  //    ⚠️ 只探一次（`_wp` 记着），探完之前不亮 —— 最坏等 2.5 秒。
  var _wp = null;   // null=没探完 / true / false
  var _wpTimer = null;
  var _wpTries = 0;    // 连续失败次数：只在启动阶段兜 3 次（约 20 秒），之后不再空转轮询

  /** 探失败先缓存 3 秒再重试：写盘口可能只是那一刻忙 / 隧道刚起，不能整页生命周期都不再亮。 */
  function rememberWritePort(ok) {
    _wp = ok;
    if (_wpTimer) { clearTimeout(_wpTimer); _wpTimer = null; }
    if (ok) { _wpTries = 0; return; }
    // ⚠️ 必须有上限：写盘口真不存在时（只装面板 / 远程面板），无限重试等于每 8 秒打两次
    //    /cgi-bin/mihomo-apply，一直到页面关掉。3 次≈20 秒足够覆盖「uhttpd 刚起」那种抖动。
    if (++_wpTries > 3) return;
    {
      _wpTimer = setTimeout(function () {
        _wpTimer = null;
        if (_wp === false) {
          _wp = null;
          var el = document.getElementById(ID);
          if (el) place(el);
        }
      }, 3000);
    }
  }

  // 探一次写盘口（只认 405）。⚠️ 每次探测都要有自己的 AbortController / 计时器：共用第一个的话，
  // 第一条很快回 404 时计时器已被清掉，第二条石沉大海（端口被过滤）就永远不返回，绿点一直不亮。
  function probeWritePort(url, cb) {
    var opt = { method: 'GET', cache: 'no-store' };
    var ac = window.AbortController ? new AbortController() : null;
    var done = false;
    var timer = ac ? setTimeout(function () { try { ac.abort(); } catch (e) { /* 无所谓 */ } }, 2500) : null;
    if (ac) opt.signal = ac.signal;
    function fin(ok) {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      cb(ok);
    }
    fetch(url, opt).then(function (r) { fin(r.status === 405); }, function () { fin(false); });
  }

  var _wpProbing = false;

  function writePortOk(cb) {
    if (_wp !== null) { cb(_wp); return; }
    if (_wpProbing) return;          // 已有一次在飞，别叠加
    _wpProbing = true;
    var done = function (ok) { _wpProbing = false; rememberWritePort(ok); cb(ok); };
    if (!window.fetch) { _wpProbing = false; rememberWritePort(false); cb(false); return; }   // 老浏览器：生成器那边也不干活，就一起不显示
    var origin = (location.protocol || 'http:') + '//' + location.host;
    probeWritePort(origin + '/cgi-bin/mihomo-apply', function (ok) {
      if (ok) { done(true); return; }
      if (location.protocol === 'https:') { done(false); return; }
      // ② 同主机的默认口（http → 80）：给「面板直开 9090、写盘 CGI 在 uhttpd 80」那种兜底。
      //    ⚠️ 同样只认 405（uhttpd 在、CGI 没装时回 404），跟 apply.js 那边同一套判据。
      probeWritePort((location.protocol || 'http:') + '//' + location.hostname + '/cgi-bin/mihomo-apply',
        function (ok2) { done(ok2); });
    });
  }

  function place(a) {
    // ⚠️ 调试模式下正拖着、以及拖完之后都别跟人家抢：只判断 dragging 的话，手一松下一个 150ms
    //    轮询就把点写回去、读数也变回原值，等于白拖。frozen 一置上就冻在那儿，直到刷新页面。
    if (dragging || frozen) return;

    // ⚠️ 连的不是本机 → 一颗点都不亮，也不去探写盘口（远程面板探了也没用）
    if (!isLocalBackend()) { a.style.display = 'none'; return; }

    // ⚠️ 还没探完（或失败后重置）→ 先藏起来并发起一次探测；探测回调会再调 place
    if (_wp === null) {
      a.style.display = 'none';
      writePortOk(function () { var el = document.getElementById(ID); if (el) place(el); });
      return;
    }
    // ⚠️ 写盘口够不着 → 一颗点都不亮
    if (_wp !== true) { a.style.display = 'none'; return; }
    var t = anchor();

    if (t) {
      var r = t.getBoundingClientRect();
      // ⚠️ 防御：按钮正在被拆掉、或者还没排好版时 rect 会是全 0（或在屏幕外），照公式算就是
      //    left:-14px，点会飞到屏幕左上角外面去 —— 这种情况一律当它不存在，藏起来。
      if (!r.width || !r.height || r.left < 0 || r.top < 0) {
        a.style.display = 'none';
        return;
      }

      // ⚠️ 只在真的变了才写 style —— 外面那个 150ms 轮询会一直调这里，否则每 150ms 触发一次样式重算。
      // ⚠️ 偏移按按钮尺寸现算（见 OFF_DIV）：36px 的按钮 → +12,+12。
      var L = Math.round(r.left + r.width / OFF_DIV) + 'px';
      var T = Math.round(r.top + r.height / OFF_DIV) + 'px';
      if (L !== appliedL || T !== appliedT) {
        a.style.left = L;
        a.style.top = T;
        a.style.bottom = 'auto';   // 跟 left/top 一起写，别每帧都写（会白触发样式重算）
        appliedL = L;
        appliedT = T;
      }
      a.style.display = 'block';
      watch(t);
      dbg(a);

      if (revealed) return;

      // ⚠️ 用**防抖**，不要用「连续两次量到一样」：面板的布局中途会短暂稳定一下，
      //    那种判断会被骗过 —— 先显形、紧接着面板再动，看着还是飘。
      var key = Math.round(r.left) + ',' + Math.round(r.top) + ',' +
                Math.round(r.width) + ',' + Math.round(r.height);
      if (key !== lastKey) {
        lastKey = key;
        clearTimeout(revealTimer);
        revealTimer = setTimeout(function () { reveal(a); }, SETTLE);
      }
      return;
    }

    // 量不到那个按钮 —— 一律藏起来。三种情况都是：面板还没渲染完 / 侧边栏展开、首次打开还没登录、
    // 这个布局就是没有那个按钮（手机底部导航）。
    // ⚠️ 没有「到点退到左下角」的兜底，那正是「首次打开、没登录时绿点歪的」的来源：那时
    //    localStorage 里还没有任何记忆，3 秒一到就跑到左下角去了。点的定义就是「正对那个版本
    //    按钮」，找不到锚点就不该有它出现的位置。
    a.style.display = 'none';
    dbg(a);
  }

  function add() {
    if (!document.body) return;

    var a = document.getElementById(ID);
    if (!a) {
      // ⚠️ 面板可能把整个 body 换掉 ⇒ 这里会再建一颗。状态变量是模块级的，
      //    不清就会沿用上一颗的 `revealed=true` ⇒ 新点永远停在 opacity:0（看不见）。
      revealed = false;
      lastKey = null;
      appliedL = appliedT = null;
      dragging = false;
      dragMoved = false;
      frozen = false;
      // ⚠️ 刻意不用 <a href>：是 <a> 的话鼠标停上去浏览器的状态栏会把链接地址显示出来（CSS 关不掉）。
      //    用普通元素自己处理点击就什么都不显示，代价是不能中键/右键新开标签页。
      a = document.createElement('div');
      a.id = ID;
      // 不设 title —— 不要悬停提示。
      // role/tabindex/aria-label 是给键盘和屏幕阅读器的，都不会显示出来。
      a.setAttribute('role', 'link');
      a.setAttribute('tabindex', '-1');   // 显形时（reveal）才置 0
      a.setAttribute('aria-label', '配置生成器');
      a.style.cssText = [
        'position:fixed', 'z-index:2147483000', 'cursor:pointer',
        'width:' + BOX + 'px', 'height:' + BOX + 'px', 'border-radius:50%',
        'display:flex', 'align-items:center', 'justify-content:center',
        'text-decoration:none', '-webkit-tap-highlight-color:transparent',
        // 先藏着，等位置稳了再亮（见 place）。
        // ⚠️ 同时关掉命中：显形之前它虽然看不见，但 28×28 的点击区仍然压在那个版本按钮上，
        //    点「版本信息」会误跳生成器。reveal 时才放开。
        'opacity:0', 'pointer-events:none',
        // ⚠️ 只给 opacity 过渡，**left/top 不要过渡** —— 上面每帧都会跟着按钮走，
        //    再叠一个过渡就成了「慢半拍地追过去」，正是用户说的那个「找位置的动作」。
        'transition:opacity .15s ease'
      ].join(';');

      // 点它 → 跳进生成器。
      //
      // ⚠️ 用相对路径：生成器就挂在面板同一个静态目录下的 `config/`（面板在 `/ui/`，所以是
      //    `/ui/config/`）。面板可能被内网 IP、公网域名、NAT 隧道好几种地址访问到，谁开着面板、
      //    点下去就跳到这个地址下的生成器，永远对得上；任何指向别的端口的跳转都可能在公网下点不开。
      // ⚠️ 页面本身是公开的 —— 这里不是一道门，也当不了门。真正的门是「没登录就没有载入配置文件按钮」
      //    （app/apply.js）和写盘接口认 secret（deploy/mihomo-apply）。
      function go() {
        // ⚠️ 给登录门留个记号：这一趟是从面板点过来的，门据此放行（面板密码同源现成，验过就进，
        //    不再要工具密码）。直接输地址打开的人没有这个记号 → 一样要工具密码。
        //    sessionStorage 是每个标签页的：点绿点是同标签页跳转，记号跟着走；书签另开就没有。
        try { sessionStorage.setItem('mihomo-gen-from-panel', '1'); } catch (e) { /* 存不下就多输一次密码 */ }
        // ⚠️ 生成器的明暗跟着面板走：面板用的是 daisyUI 主题名（sunset / nord / …），生成器只认
        //    light / dark，所以在这一页（主题已生效）读实际明暗，换算好再带过去（app/theme-hint.js）。
        try {
          var mode = panelTheme();
          if (mode) sessionStorage.setItem('mihomo-gen-theme', mode);
        } catch (e) { /* 存不下就按系统 / 宿主走 */ }
        location.assign('./config/');
      }

      /** 面板当前是深色还是浅色 —— 优先看 CSS 的 color-scheme，退到背景亮度。 */
      function panelTheme() {
        try {
          var cs = getComputedStyle(document.documentElement).colorScheme || '';
          if (/dark/i.test(cs)) return 'dark';
          if (/light/i.test(cs)) return 'light';
        } catch (e) { /* 老浏览器没有 colorScheme */ }
        try {
          // ⚠️ body 常常是透明的（底色画在 html 或某个铺满的容器上）—— 透明时往上一级看，
          //    别把 rgba(0,0,0,0) 当成黑色。
          var bg = getComputedStyle(document.body).backgroundColor || '';
          if (!bg || /rgba?\([^)]*,\s*0\s*\)$/.test(bg) || bg === 'transparent') {
            bg = getComputedStyle(document.documentElement).backgroundColor || '';
          }
          var m = /rgb\((\d+),\s*(\d+),\s*(\d+)/.exec(bg);
          if (m) {
            return (0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3]) < 128 ? 'dark' : 'light';
          }
        } catch (e) { /* 读不到就交给生成器按系统走 */ }
        return '';
      }
      a.addEventListener('click', function (e) {
        // 调试模式下拖完手一松也会触发 click —— 别让它跳走
        if (dragMoved) { e.preventDefault(); e.stopPropagation(); dragMoved = false; return; }
        go();
      });
      if (DRAG) { a.style.cursor = 'grab'; makeDraggable(a); }
      a.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
      });

      var dot = document.createElement('span');
      dot.style.cssText = [
        'display:block', 'width:12px', 'height:12px', 'border-radius:50%',
        'background:#22c55e', 'box-shadow:0 0 0 4px rgba(34,197,94,.22)',
        'transition:transform .15s, box-shadow .15s'
      ].join(';');
      a.appendChild(dot);

      a.addEventListener('mouseenter', function () {
        dot.style.transform = 'scale(1.3)';
        dot.style.boxShadow = '0 0 0 6px rgba(34,197,94,.30)';
      });
      a.addEventListener('mouseleave', function () {
        dot.style.transform = '';
        dot.style.boxShadow = '0 0 0 4px rgba(34,197,94,.22)';
      });

      document.body.appendChild(a);
    }

    place(a);
  }

  // 写盘口通不通 —— 探完之前点不亮（见 writePortOk）
  writePortOk(function () { add(); });

  // config.js 是在 <head> 里跑的，那时还没有 <body>，所以得等 DOM。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', add);
  } else {
    add();
  }

  window.addEventListener('resize', add);
  window.addEventListener('hashchange', add);   // 面板是 hash 路由，切页会重新排布

  // ⚠️ 光靠上面两个不够：面板是加载完之后才把侧边栏宽度定下来的（还会记住上次
  //    是收起还是展开），要补几次延时对位，等它稳定。
  [0, 80, 150, 250, 400, 600, 800, 1000, 1300, 1700, 2200, 3000]
    .forEach(function (t) { setTimeout(add, t); });

  // ⚠️ 还得有个轮询兜底，而且必须一直在量，不能「显示出来就不管了」：
  //    · 侧边栏收起时那个按钮是重新插进来的，而它外面那个容器在展开时整个从 DOM 里消失了 ——
  //      ResizeObserver 盯着的节点被摘掉，之后就再也收不到通知。
  //    · 面板把侧边栏最终排完版之前量到的位置是过时的；一旦停止测量，错位就永远留在那儿。
  //    place() 里只在值真变了才写 style，所以 150ms 一次的开销就是一个 querySelector + 一次 rect。
  setInterval(function () {
    var a = document.getElementById(ID);
    if (a) place(a);
  }, 150);

  // 保险：body 被换掉就补回来。
  // ⚠️ 只看 <html> 的直接子节点，不能开 subtree —— 面板是个实时仪表盘，下面的数字每秒都在变。
  new MutationObserver(add).observe(document.documentElement, { childList: true });
})();
