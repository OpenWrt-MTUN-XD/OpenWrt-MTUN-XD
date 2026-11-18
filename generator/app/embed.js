/*!
 * 生成器嵌在宿主里时的记号：`?noframe=1` 给 body 加 `headerless`，唯一使用者是
 * LuCI 的「配置工具」页（服务 → MTUN-XD，用 iframe 加载本页）。
 *
 * 注意：页头已删，这个 class 只表示「在宿主里」——ui.js 靠它不跟随系统明暗
 * （宿主用 `?theme=` 指定，跟系统变会盖掉宿主的明确选择），别当「藏页头」的开关用。
 * 注意：`?embed=1` + `mcx:*` postMessage 那套集成已撤（套件不改面板），别再往回加。
 */
(function (root) {
  'use strict';

  var doc = root.document;
  if (!doc) return;

  var search = String(root.location.search || '');
  var inFrame = root.self !== root.top;
  var noFrame = /[?&]noframe(?:&|=|$)/.test(search);
  if (!inFrame || !noFrame) return;

  function boot() {
    if (doc.body) doc.body.classList.add('headerless');
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);
