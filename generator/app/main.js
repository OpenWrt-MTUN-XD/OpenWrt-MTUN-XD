/*!
 * iStoreOS-Mihomo-config 生成器 — 启动入口
 * 只负责等 DOM 就绪后调用 ui.init()，逻辑都在 ui.js 里。
 */
(function (root) {
  'use strict';

  function boot() {
    if (root.MH && root.MH.ui && typeof root.MH.ui.init === 'function') {
      root.MH.ui.init();
    }
  }

  var doc = root.document;
  if (!doc) return;

  // 有登录门就先过门再启动界面（门见 app/gate.js）；公开站 / file:// 上探到「不是 mihomo
  // 发的页面」会立刻放行 —— 那里既没有 secret 也没有写盘通路。
  function start() {
    if (root.MHGate && typeof root.MHGate.run === 'function') root.MHGate.run(boot);
    else boot();
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
