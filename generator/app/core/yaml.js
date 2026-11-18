/*!
 * iStoreOS-Mihomo-config 生成器 — YAML 标量序列化
 *
 * 只做一件事：把任意值安全地变成一行 YAML。节点名 / 密码 / SNI / 路径全部来自订阅（不可信
 * 输入），不做转义的话一个带引号和换行的密码就能越出标量、往配置里注入规则。移植自 Python
 * 版的 yq / _g_scalar / _g_key / _g_emit / render_generic / _order_dump_keys，输出逐字节对齐。
 */
(function (root) {
  'use strict';

  var MH = (root.MH = root.MH || {});
  var pyStr = MH.pyStr;

  // 安全标量：以字母数字开头，之后只允许 `._/-`
  var PLAIN_OK = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
  // 安全键名：以字母数字开头，之后只允许 `._-`
  var KEY_OK = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  var YAML_WORDS = { true: 1, false: 1, null: 1, yes: 1, no: 1, on: 1, off: 1, none: 1, '~': 1 };
  // 会被 YAML 当数字读的字符串形态：最多一个小数点，可带正负号与指数。
  // 别图省事写成 ^[-+]?[0-9.]+$ —— 那个也匹配 "1.2.3.4"，server 会被引号包成 "1.2.3.4"。
  var NUM_LIKE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

  /**
   * Python 的 `yq()` —— 把任意值序列化成 YAML 双引号标量。JSON 的字符串字面量是 YAML 双
   * 引号标量的子集（换行变 `\n`、引号变 `\"`、控制字符变 `\uXXXX`），不会截断标量；
   * `JSON.stringify` 不转义非 ASCII，与 `json.dumps(..., ensure_ascii=False)` 一致。
   */
  function yq(s) {
    return JSON.stringify(s == null ? '' : pyStr(s));
  }

  /**
   * Python 的 `_g_scalar()` —— 只在会被 YAML 误读时才加引号，否则会输出一堆
   * `type: "anytls"`、`server: "b.com"` 这种和官网示例对不上的引号。
   */
  function gScalar(v) {
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return pyStr(v);
    if (v === null || v === undefined) return 'null';
    var s = pyStr(v);
    if (s && PLAIN_OK.test(s) && !YAML_WORDS[s.toLowerCase()] && !NUM_LIKE.test(s)) {
      return s;
    }
    return yq(s);
  }

  /** Python 的 `_g_key()` —— 键名同样是订阅来的不可信输入。 */
  function gKey(k) {
    k = pyStr(k);
    return KEY_OK.test(k) ? k : yq(k);
  }

  function isDict(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  /** Python 的 `_g_emit()` —— 递归输出映射 / 序列。 */
  function gEmit(out, lvl, key, val) {
    var pad = repeat('  ', lvl);
    key = gKey(key);
    if (isDict(val)) {
      var keys = Object.keys(val);
      // ⚠️ 空 map / 空数组要写成 `{}` / `[]`：只写 `key:` 在 YAML 里是 null，泛型透传时会把
      //    一个合法字段变成空值（内核可能因此拒收这个节点）。
      if (!keys.length) { out.push(pad + key + ': {}'); return; }
      out.push(pad + key + ':');
      for (var k in val) {
        if (!Object.prototype.hasOwnProperty.call(val, k)) continue;
        gEmit(out, lvl + 1, k, val[k]);
      }
    } else if (Array.isArray(val)) {
      if (!val.length) { out.push(pad + key + ': []'); return; }
      out.push(pad + key + ':');
      for (var i = 0; i < val.length; i++) {
        var item = val[i];
        if (isDict(item)) {
          var sub = [];
          for (var ik in item) {
            if (!Object.prototype.hasOwnProperty.call(item, ik)) continue;
            gEmit(sub, lvl + 1, ik, item[ik]);
          }
          if (sub.length) {
            sub[0] = repeat('  ', lvl + 1) + '- ' + sub[0].replace(/^\s+|\s+$/g, '');
            // ⚠️ 后面几行要缩进两格，跟 `- ` 后面那个键对齐；不补的话 YAML 直接报 bad indentation。
            for (var si = 1; si < sub.length; si++) sub[si] = '  ' + sub[si];
          }
          out.push.apply(out, sub);
        } else {
          out.push(repeat('  ', lvl + 1) + '- ' + gScalar(item));
        }
      }
    } else {
      out.push(pad + key + ': ' + gScalar(val));
    }
  }

  function repeat(s, n) {
    var r = '';
    for (var i = 0; i < n; i++) r += s;
    return r;
  }

  // ── 各协议字段的官方顺序（Meta-Docs）。未列出的键保持原相对顺序、追加在后 ──
  // 注意：这张表只对「没有手写渲染分支」的类型生效（只有 renderGeneric 会调 orderDumpKeys），
  // ss / ssr / trojan / vmess / vless / hysteria2 / hysteria / tuic / wireguard / snell /
  // http / socks5 / ssh 这 13 条在这儿是死数据。保留是当文档用，render.test.mjs 会拿它和基线比。
  // 注意：wireguard 这条仍是 Python 版的旧顺序，与 render.js 现在按官网发的顺序不一致；
  // 真要同步得连 tests/golden/fixtures.json 的 documented_order 一起改。
  var DOC_KEY_ORDER = {
    ss: ['name', 'type', 'server', 'port', 'cipher', 'password', 'udp',
      'plugin', 'plugin-opts', 'smux', 'client-fingerprint'],
    ssr: ['name', 'type', 'server', 'port', 'cipher', 'password', 'obfs', 'protocol',
      'obfs-param', 'protocol-param', 'udp'],
    trojan: ['name', 'type', 'server', 'port', 'password', 'udp', 'sni', 'alpn',
      'client-fingerprint', 'fingerprint', 'skip-cert-verify', 'ss-opts',
      'reality-opts', 'network', 'ws-opts', 'grpc-opts'],
    vmess: ['name', 'type', 'server', 'port', 'udp', 'uuid', 'alterId', 'cipher',
      'tls', 'servername', 'alpn', 'client-fingerprint', 'skip-cert-verify',
      'reality-opts', 'network', 'ws-opts', 'grpc-opts', 'h2-opts', 'http-opts'],
    vless: ['name', 'type', 'server', 'port', 'udp', 'uuid', 'flow', 'tls', 'servername',
      'alpn', 'client-fingerprint', 'skip-cert-verify', 'reality-opts', 'encryption',
      'network', 'ws-opts', 'grpc-opts', 'xhttp-opts'],
    hysteria2: ['name', 'type', 'server', 'port', 'ports', 'hop-interval', 'password',
      'up', 'down', 'bbr-profile', 'obfs', 'obfs-password',
      'obfs-min-packet-size', 'obfs-max-packet-size', 'sni',
      'skip-cert-verify', 'name-cert-verify', 'fingerprint', 'alpn'],
    hysteria: ['name', 'type', 'server', 'port', 'ports', 'auth-str', 'obfs', 'alpn',
      'protocol', 'up', 'down', 'sni', 'skip-cert-verify', 'name-cert-verify',
      'recv-window-conn', 'recv-window', 'disable-mtu-discovery',
      'fingerprint', 'fast-open'],
    tuic: ['name', 'type', 'server', 'port', 'token', 'uuid', 'password',
      'heartbeat-interval', 'alpn', 'disable-sni', 'reduce-rtt', 'request-timeout',
      'udp-relay-mode', 'congestion-controller', 'bbr-profile',
      'max-udp-relay-packet-size', 'fast-open', 'skip-cert-verify',
      'udp-over-stream', 'sni'],
    wireguard: ['name', 'type', 'private-key', 'server', 'port', 'ip', 'ipv6',
      'public-key', 'pre-shared-key', 'reserved', 'mtu', 'udp',
      'persistent-keepalive', 'amnezia-wg-option'],
    snell: ['name', 'type', 'server', 'port', 'psk', 'version', 'mode', 'udp', 'obfs-opts'],
    http: ['name', 'type', 'server', 'port', 'username', 'password', 'tls',
      'skip-cert-verify', 'sni', 'fingerprint'],
    socks5: ['name', 'type', 'server', 'port', 'username', 'password', 'tls',
      'fingerprint', 'skip-cert-verify', 'udp'],
    ssh: ['name', 'type', 'server', 'port', 'username', 'password', 'private-key',
      'private-key-passphrase'],
    // ── 以下类型没有手写渲染分支，走 render_generic 通用透传 ──
    anytls: ['name', 'type', 'server', 'port', 'password', 'client-fingerprint', 'udp',
      'client-metadata', 'idle-session-check-interval', 'idle-session-timeout',
      'min-idle-session', 'sni', 'alpn', 'skip-cert-verify', 'name-cert-verify',
      'shadow-tls-opts', 'restls-opts', 'jls-opts'],
    mieru: ['name', 'type', 'server', 'port', 'port-range', 'transport', 'username',
      'password', 'multiplexing', 'handshake-mode', 'traffic-pattern'],
    sudoku: ['name', 'type', 'server', 'port', 'key', 'aead-method', 'padding-min',
      'padding-max', 'table-type', 'custom-table', 'custom-tables', 'multiplex',
      'httpmask', 'enable-pure-downlink'],
    shadowquic: ['name', 'type', 'server', 'port', 'username', 'password', 'sni', 'alpn',
      'quic-versions', 'udp-over-stream', 'zero-rtt', 'keep-alive-interval',
      'congestion-controller', 'up', 'down', 'cwnd', 'bbr-profile',
      'max-datagram-frame-size', 'max-open-streams', 'recv-window-conn',
      'recv-window', 'disable-mtu-discovery'],
    trusttunnel: ['name', 'type', 'server', 'port', 'username', 'password',
      'client-fingerprint', 'health-check', 'udp', 'sni', 'alpn',
      'skip-cert-verify', 'name-cert-verify', 'quic',
      'congestion-controller', 'bbr-profile', 'max-connections',
      'min-streams', 'max-streams'],
    masque: ['name', 'type', 'server', 'port', 'private-key', 'public-key', 'ip', 'ipv6',
      'mtu', 'udp', 'ip-stack', 'sni', 'congestion-controller', 'bbr-profile'],
    openvpn: ['name', 'type', 'server', 'port', 'proto', 'username', 'password', 'cert',
      'key', 'tls-auth', 'key-direction', 'ca', 'tls-crypt', 'tls-crypt-v2'],
    tailscale: ['name', 'type', 'hostname', 'auth-key', 'control-url', 'state-dir',
      'ephemeral', 'udp', 'accept-routes', 'exit-node',
      'exit-node-allow-lan-access', 'dialer-proxy', 'interface-name',
      'routing-mark', 'ip-version'],
    zerotier: ['name', 'type', 'network', 'state-dir', 'identity-secret', 'planet', 'mtu',
      'physical-mtu', 'ip-stack', 'primary-port', 'secondary-port',
      'tcp-fallback-mode', 'tcp-fallback-relay', 'remote-trace-target',
      'remote-trace-level', 'low-bandwidth', 'encrypted-hello', 'orbit', 'udp',
      'remote-dns-resolve', 'dns'],
    easytier: ['name', 'type', 'network-name', 'network-secret', 'hostname', 'ipv4',
      'dhcp', 'peers', 'secure-mode', 'local-private-key', 'local-public-key',
      'listeners', 'no-listener', 'mapped-listeners', 'exit-nodes',
      'proxy-networks', 'instance-name', 'state-dir', 'udp', 'accept-dns',
      'enable-exit-node', 'enable-encryption', 'encryption-algorithm'],
    rematch: ['name', 'type', 'target-rematch-name', 'target-sub-rule']
  };

  /** Python 的 `_order_dump_keys()` —— 按键表重排，未列出的键追加在末尾。 */
  function orderDumpKeys(p) {
    var order = Object.prototype.hasOwnProperty.call(DOC_KEY_ORDER, p.type)
      ? DOC_KEY_ORDER[p.type] : null;
    if (!order) return p;
    var out = {};
    for (var i = 0; i < order.length; i++) {
      if (Object.prototype.hasOwnProperty.call(p, order[i])) out[order[i]] = p[order[i]];
    }
    for (var k in p) {
      if (!Object.prototype.hasOwnProperty.call(p, k)) continue;
      if (!Object.prototype.hasOwnProperty.call(out, k)) out[k] = p[k];
    }
    return out;
  }

  /**
   * Python 的 `render_generic()` —— 没有手写分支的类型按官方键序原样输出。Python 侧是
   * `raise ValueError`，一个不认识的节点就让整份配置生成失败；改成透传后 anytls / mieru /
   * tailscale 都能安全穿过。
   */
  function renderGeneric(node) {
    var d = orderDumpKeys(shallowCopy(node));
    delete d.remarks;
    var out = [];
    var name = d.name;
    delete d.name;
    if (!String(name == null ? '' : name).replace(/^\s+|\s+$/g, '')) {
      throw new Error('节点缺少 name（server=' + (d.server || '?') + '），无法渲染');
    }
    out.push('  - name: ' + yq(String(name)));
    for (var k in d) {
      if (!Object.prototype.hasOwnProperty.call(d, k)) continue;
      gEmit(out, 2, k, d[k]);
    }
    return out;
  }

  function shallowCopy(o) {
    var out = {};
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
    return out;
  }

  MH.yq = yq;
  MH.gScalar = gScalar;
  MH.gKey = gKey;
  MH.renderGeneric = renderGeneric;
  MH.DOC_KEY_ORDER = DOC_KEY_ORDER;
  MH.shallowCopy = shallowCopy;
})(typeof globalThis !== 'undefined' ? globalThis : this);
