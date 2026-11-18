/*!
 * 生成器用哪套明暗 —— 三个来源，优先级从高到低：
 *   ① 宿主在地址上给的 `?theme=light|dark`（LuCI「配置工具」页带，父页才是权威）
 *   ② 从面板绿点过来时 btn.js 写进 sessionStorage 的记号（面板主题名先换算成 light/dark）
 *   ③ 系统 prefers-color-scheme
 *
 * 注意：`noframe=1`（嵌在 LuCI 里）不认 ②，同源 sessionStorage 里上一趟的记号会盖住宿主选择。
 * 注意：本脚本在 `<head>` 里、gate.js 之前加载，必须自包含：不依赖 MH、不碰 DOM。
 * 注意：文件名不能叫 theme.js —— kit 把 app/ 平铺进 `/ui/config/`，会覆盖面板自己的
 *       theme.js，MHTheme 整个没了，主题只能退回系统。
 */
(function (root) {
  'use strict';

  var KEY = 'mihomo-gen-theme';

  /** 宿主 / 面板给的明暗；没有就返回空串。 */
  function hint() {
    var loc = root.location;
    var search = String((loc && loc.search) || '');
    var m = /[?&]theme=(light|dark)(?:&|$)/.exec(search);
    if (m) return m[1];
    if (/[?&]noframe(?:&|=|$)/.test(search)) return '';
    try {
      var v = root.sessionStorage.getItem(KEY);
      if (v === 'dark' || v === 'light') return v;
    } catch (e) { /* 隐私模式 / 被禁用：按系统走 */ }
    return '';
  }

  /** 系统的明暗（拿不到 media query 就当浅色）。 */
  function system() {
    return root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark' : 'light';
  }

  root.MHTheme = { hint: hint, system: system, KEY: KEY };
})(typeof globalThis !== 'undefined' ? globalThis : this);
