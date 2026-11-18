/*!
 * iStoreOS-Mihomo-config 生成器 — Clash YAML 订阅解析适配层
 *
 * 依赖 app/vendor/js-yaml.min.js（UMD，加载后挂在全局 `jsyaml`）；本层只做一件事：
 * 把 js-yaml 的默认 schema 调成与 Python 侧 PyYAML 一致。
 * 注意：js-yaml 4 按 YAML 1.2 只把 `true`/`false` 当布尔，PyYAML 按 1.1 还认
 * `yes`/`no`/`on`/`off` —— 不统一的话 `udp: yes` 两边解析出的类型不同，配置就不一样。
 */
(function (root) {
  'use strict';

  var MH = (root.MH = root.MH || {});
  var jsyaml = root.jsyaml;
  if (!jsyaml || typeof jsyaml.load !== 'function') return;   // 没加载 vendor 就跳过

  // PyYAML resolver 的 bool 取值集合（与 YAML 1.1 规范不同：不含 y / n）
  var BOOL_RE = /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/;
  var TRUE_RE = /^(?:yes|Yes|YES|true|True|TRUE|on|On|ON)$/;

  var pyBool = new jsyaml.Type('tag:yaml.org,2002:bool', {
    kind: 'scalar',
    resolve: function (data) { return data !== null && BOOL_RE.test(data); },
    construct: function (data) { return TRUE_RE.test(data); }
  });

  var SCHEMA = jsyaml.DEFAULT_SCHEMA.extend({ implicit: [pyBool] });

  MH.yamlLoad = function (text) {
    return jsyaml.load(text, { schema: SCHEMA });
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
