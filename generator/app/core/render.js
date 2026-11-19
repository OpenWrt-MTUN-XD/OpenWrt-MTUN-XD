/*!
 * iStoreOS-Mihomo-config 生成器 — 节点 → YAML
 *
 * 逐字段移植自 Python 版的 `_to_internal` / `proxy_to_yaml` / `_alpn_list` / `_kv_pairs` /
 * `_get_flag` / `_b64url_nopad`。字段顺序统一对齐 mihomo 官方文档（Meta-Docs），任意节点
 * 拿出来都能和文档示例逐行对上。
 * 注意：mihomo 对不认识的键既不报错也不告警，写错等于静默丢配置 —— 别凭直觉「顺手改对」。
 */
(function (root) {
  'use strict';

  var MH = (root.MH = root.MH || {});
  var yq = MH.yq, gScalar = MH.gScalar, gKey = MH.gKey;
  var pyStr = MH.pyStr, truthy = MH.truthy;
  var renderGeneric = MH.renderGeneric;
  var b64urlNopad = MH.b64urlNopad;

  // 节点 → YAML 渲染（ip-version 是所有出站通用的 BasicOption 字段，含 ssh）
  // mihomo 的出站都嵌了 BasicOption，因此都支持 ip-version。
  var IPVERSION_TYPES = ['ss', 'ssr', 'trojan', 'vmess', 'vless', 'hysteria2',
    'hysteria', 'tuic', 'wireguard', 'snell', 'http',
    'socks5', 'shadowtls', 'ssh', 'anytls'];

  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  /**
   * 证书固定指纹（`fingerprint`）的清洗 —— 必须是 SHA-256。
   *
   * 注意：mihomo 的 `ca.NewFingerprintVerifier`（v1.19.32 源码）去掉冒号后按 hex 解，长度不是
   * 32 字节就直接报错、整份配置拒载 —— 截断的 `pinSHA256=deadbeef` 能让整台机器起不来。
   * 所以合法（64 位 hex，允许带冒号）就输出规范化的 hex，不合法就这一条不写（节点保留，只是
   * 不做证书固定）；别把它跟 `client-fingerprint`（uTLS 浏览器指纹）搞混。
   */
  function certFingerprint(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return '';
    // 两种来源：Clash 的 64 位 hex，或 hysteria2 链接里的 base64（pinSHA256）
    if (!/^[0-9a-fA-F]{64}$/.test(s.replace(/:/g, ''))) {
      var m = /^[A-Za-z0-9+/]{43}=?$|^[A-Za-z0-9_-]{43}$/.test(s) ? b64ToHex(s) : '';
      if (m) return m;
    }
    var hex = s.replace(/:/g, '').replace(/^\s+|\s+$/g, '').toLowerCase();
    return /^[0-9a-f]{64}$/.test(hex) ? hex : '';
  }

  /** base64（标准或 url-safe，允许无 padding）→ 小写 hex；解不出 32 字节就返回空串。 */
  function b64ToHex(s) {
    try {
      var norm = String(s).replace(/-/g, '+').replace(/_/g, '/');
      while (norm.length % 4) norm += '=';
      var bin = root.atob ? root.atob(norm) : '';
      if (bin.length !== 32) return '';
      var out = '';
      for (var i = 0; i < bin.length; i++) {
        out += ('0' + bin.charCodeAt(i).toString(16)).slice(-2);
      }
      return out;
    } catch (e) {
      return '';
    }
  }

  function get(p, k, d) {
    return has(p, k) ? p[k] : d;
  }

  /** Python 的 `_alpn_list` —— alpn 在链接里是 "h2,h3" 串，在 Clash YAML 里是列表。 */
  function alpnList(v) {
    var items = Array.isArray(v) ? v : String(v).split(',');
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var s = String(items[i]).trim();
      if (s) out.push(s);
    }
    return out;
  }

  /**
   * Python 的 `_kv_pairs` —— 把「键值表」归一成 [[k, v], ...]（http-opts.headers 用）。三种
   * 来源都要吃：Clash YAML 里是 dict，vmess 分享链接里可能是 dict 或 "Host: a.com|X-Foo: bar"
   * 这种串；空值返回空列表。
   */
  function kvPairs(v) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      var out = [];
      for (var k in v) {
        if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
        out.push([String(k).trim(), String(v[k]).trim()]);   // 键值两边都 strip
      }
      return out;
    }
    var res = [];
    var parts = String(v == null ? '' : v).split(/[|\n]+/);
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (part.indexOf(':') !== -1) {
        var at = part.indexOf(':');
        var key = part.slice(0, at).trim();
        if (key) res.push([key, part.slice(at + 1).trim()]);
      }
    }
    return res;
  }

  /**
   * Python 的 `_get_flag` —— 同一个布尔设置在不同来源里的键名不一样：链接解析出来是
   * allow_insecure / skip_cert_verify，Clash YAML 里是 skip-cert-verify；只认一个名字就会
   * 静默丢掉另一个来源的设置。
   */
  function getFlag(p) {
    for (var i = 1; i < arguments.length; i++) {
      if (truthy(p[arguments[i]])) return true;
    }
    return false;
  }

  /** Python 的 `_has_ip_version` —— 渲染出来的行里是不是已经有 ip-version 了。 */
  function hasIpVersion(lines) {
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].replace(/^\s+/, '').indexOf('ip-version:') === 0) return true;
    }
    return false;
  }

  /**
   * Python 的 `_to_internal` —— 把「类解析器」那套键名归一（手写渲染分支认的名字）。
   * 订阅读进来的 YAML 节点用的是 mihomo 原生键（network / skip-cert-verify …），不归一就会
   * 出现「节点写着 network: ws，渲染成 network: tcp」这种静默丢配置。
   */
  function toInternal(p) {
    var q = MH.shallowCopy(p);
    if (!has(q, 'net') && has(q, 'network')) q.net = q.network;
    if (!has(q, 'fp') && has(q, 'client-fingerprint')) q.fp = q['client-fingerprint'];
    // 原生 YAML 的 vmess / vless 用 `servername`，链接解析器产出的是 `sni`
    if (!has(q, 'sni') && has(q, 'servername')) q.sni = q.servername;
    if (!has(q, 'allow_insecure') && has(q, 'skip-cert-verify')) q.allow_insecure = q['skip-cert-verify'];
    // hysteria / hysteria2 / tuic 三个分支读的是 insecure，不是 allow_insecure
    if (!has(q, 'insecure') && has(q, 'skip-cert-verify')) q.insecure = q['skip-cert-verify'];
    if (!has(q, 'private_key') && has(q, 'private-key')) q.private_key = q['private-key'];
    if (!has(q, 'public_key') && has(q, 'public-key')) q.public_key = q['public-key'];
    // vless 的 TLS 判定读的是 security（类解析器那套），原生 YAML 写的是 tls: true
    if (!has(q, 'security') && truthy(q.tls)) q.security = 'tls';

    var ro = q['reality-opts'];
    if (ro !== null && typeof ro === 'object' && !Array.isArray(ro)) {
      if (truthy(ro['public-key']) && !truthy(q.pbk)) q.pbk = ro['public-key'];
      if (truthy(ro['short-id']) && !truthy(q.sid)) q.sid = ro['short-id'];
      if (truthy(ro['support-x25519mlkem768']) && !truthy(q.spx)) q.spx = 'true';
    }
    if (truthy(q.pbk)) q.pbk = b64urlNopad(q.pbk);

    // 原生 ws-opts / grpc-opts 是嵌套的，渲染分支读的是扁平键
    var ws = q['ws-opts'];
    if (ws !== null && typeof ws === 'object' && !Array.isArray(ws)) {
      if (truthy(ws.path) && !truthy(q.path)) q.path = ws.path;
      var hdrs = ws.headers || {};
      if (hdrs !== null && typeof hdrs === 'object' && !Array.isArray(hdrs) &&
        !truthy(q.host)) {
        // 两种大小写都见过：官方示例是 `Host`，有些订阅写 `host`
        if (truthy(hdrs.Host)) q.host = hdrs.Host;
        else if (truthy(hdrs.host)) q.host = hdrs.host;
      }
    }
    // vless 还有另一个老写法：顶层的 `ws-headers`（map[string]string）
    var wsh = q['ws-headers'];
    if (wsh !== null && typeof wsh === 'object' && !Array.isArray(wsh) && !truthy(q.host)) {
      if (truthy(wsh.Host)) q.host = wsh.Host;
      else if (truthy(wsh.host)) q.host = wsh.host;
    }
    var gr = q['grpc-opts'];
    if (gr !== null && typeof gr === 'object' && !Array.isArray(gr) &&
      truthy(gr['grpc-service-name']) && !truthy(q.grpc_service)) {
      q.grpc_service = gr['grpc-service-name'];
    }

    // ── 原生 YAML 里剩下几个嵌套的 opts，渲染分支读的是扁平键 ──────────
    // 不拆开的话订阅里这些设置会被静默丢掉（mihomo 对不认识的键不报错）。
    var so = q['ss-opts'];
    if (so !== null && typeof so === 'object' && !Array.isArray(so)) {
      if (!has(q, 'ss_method') && truthy(so.method)) q.ss_method = so.method;
      if (!has(q, 'ss_password') && truthy(so.password)) q.ss_password = so.password;
    }
    // vmess 的 h2-opts（host 是 []string）
    var h2o = q['h2-opts'];
    if (h2o !== null && typeof h2o === 'object' && !Array.isArray(h2o)) {
      if (!truthy(q.h2_host) && truthy(h2o.host)) {
        q.h2_host = Array.isArray(h2o.host) ? h2o.host.join(',') : h2o.host;
      }
      if (!truthy(q.h2_path) && truthy(h2o.path)) q.h2_path = h2o.path;
    }
    // vmess 的 http-opts
    var ho = q['http-opts'];
    if (ho !== null && typeof ho === 'object' && !Array.isArray(ho)) {
      if (!truthy(q.http_method) && truthy(ho.method)) q.http_method = ho.method;
      if (!truthy(q.path) && truthy(ho.path)) {
        q.path = Array.isArray(ho.path) ? ho.path[0] : ho.path;
      }
      if (!truthy(q.http_headers) && truthy(ho.headers)) q.http_headers = ho.headers;
    }
    // vless 的 xhttp-opts
    var xo = q['xhttp-opts'];
    if (xo !== null && typeof xo === 'object' && !Array.isArray(xo)) {
      if (!truthy(q.xhttp_path) && truthy(xo.path)) q.xhttp_path = xo.path;
      if (!truthy(q.xhttp_host) && truthy(xo.host)) q.xhttp_host = xo.host;
      if (!truthy(q.xhttp_mode) && truthy(xo.mode)) q.xhttp_mode = xo.mode;
    }

    // 剩下这些只有 Clash YAML 来源才有（链接解析器已经直接产出下划线名）；
    // 不归一的话手写分支读不到，订阅里带的设置就被静默丢掉。
    var KEBAB = [
      ['aid', 'alterId'],                       // vmess（原生 YAML 是 camelCase）
      ['allowed_ips', 'allowed-ips'],           // wireguard
      ['ip_stack', 'ip-stack'],                 // wireguard
      ['dialer_proxy', 'dialer-proxy'],         // 通用字段
      ['remote_dns_resolve', 'remote-dns-resolve'],
      ['name_cert_verify', 'name-cert-verify'], // hysteria / hysteria2（还有别的类型，先只给它们用）
      ['udp_over_tcp', 'udp-over-tcp'],         // ss
      ['udp_over_tcp_version', 'udp-over-tcp-version'],
      ['plugin_opts', 'plugin-opts'],           // ss（Clash YAML 里是 kebab-case）
      ['obfs_opts', 'obfs-opts'],               // snell
      ['obfsparam', 'obfs-param'],              // ssr
      ['protoparam', 'protocol-param'],         // ssr
      ['hop_interval', 'hop-interval'],         // hysteria2
      ['bbr_profile', 'bbr-profile'],           // hysteria2 / tuic
      ['obfs_password', 'obfs-password'],       // hysteria2
      ['auth_str', 'auth-str'],                 // hysteria
      ['fast_open', 'fast-open'],               // hysteria / tuic
      ['heartbeat', 'heartbeat-interval'],      // tuic
      ['disable_sni', 'disable-sni'],           // tuic
      ['reduce_rtt', 'reduce-rtt'],             // tuic
      ['request_timeout', 'request-timeout'],   // tuic
      ['udp_relay_mode', 'udp-relay-mode'],     // tuic
      ['congestion', 'congestion-controller'],  // tuic
      ['max_udp', 'max-udp-relay-packet-size'], // tuic
      ['udp_over_stream', 'udp-over-stream'],   // tuic
      ['psk', 'pre-shared-key'],                // wireguard（snell 本来就是 psk）
      ['amnezia', 'amnezia-wg-option']          // wireguard
    ];
    for (var ki = 0; ki < KEBAB.length; ki++) {
      if (!has(q, KEBAB[ki][0]) && has(q, KEBAB[ki][1])) q[KEBAB[ki][0]] = q[KEBAB[ki][1]];
    }
    // persistent-keepalive：链接解析器产出的是 keepalive
    if (!has(q, 'keepalive') && has(q, 'persistent-keepalive')) q.keepalive = q['persistent-keepalive'];
    // TUIC v4 用 token（YAML 里通常不写 version）—— 渲染分支是按 version===4 判断的，
    // 不推断的话 token 会被当成"没有凭据"，写成 uuid:"" / password:""。
    if (q.type === 'tuic' && truthy(q.token) && !truthy(q.uuid) && !truthy(q.password) && !has(q, 'version')) {
      q.version = 4;
    }
    // ss 的密码在 YAML 里就叫 password，渲染分支读的也是它；udp-over-tcp 的布尔
    // 在 YAML 里可能是 true，直接照原样写出去即可。
    return q;
  }

  /** Python 的 `proxy_to_yaml(p, dual=True)` —— 返回行数组。 */
  function proxyToYaml(node, dual) {
    if (dual === undefined) dual = true;
    var raw = node;                 // 通用透传要用原始字典：它按 mihomo 原生键输出
    var p = toInternal(node);       // 手写分支用归一后的
    var L = [];
    var I = function (level, text) { L.push(new Array(level * 2 + 1).join(' ') + text); };
    var t = p.type;

    if (t === 'ss') {
      I(1, '- name: ' + yq(p.name));
      I(2, 'type: ss');
      I(2, 'server: ' + gScalar(p.server));
      I(2, 'port: ' + pyStr(p.port));
      I(2, 'cipher: ' + gScalar(get(p, 'method', get(p, 'cipher', 'aes-256-gcm'))));
      I(2, 'password: ' + yq(get(p, 'password', '')));
      I(2, 'udp: true');
      // 官网 ss 示例：udp → udp-over-tcp → udp-over-tcp-version → ip-version → plugin。
      // 不写这两个键，订阅里开了 UDP over TCP 的节点会静默降级。
      if (truthy(p.udp_over_tcp)) {
        I(2, 'udp-over-tcp: true');
      }
      if (truthy(p.udp_over_tcp_version)) {
        I(2, 'udp-over-tcp-version: ' + gScalar(p.udp_over_tcp_version));
      }
      if (truthy(p.plugin)) I(2, 'plugin: ' + gScalar(p.plugin));
      if (truthy(p.plugin_opts)) {
        I(2, 'plugin-opts:');
        var po = p.plugin_opts;
        for (var pk in po) {
          if (!Object.prototype.hasOwnProperty.call(po, pk)) continue;
          var pv = po[pk], pv2;
          // ⚠️ 原生 YAML 的 plugin-opts 值是**真布尔 / 数字**；一律走 yq() 会变成
          //    `"True"` 这种字符串，内核按 bool 解就报错（整份拒载）。
          if (typeof pv === 'boolean') pv2 = pv ? 'true' : 'false';
          else if (typeof pv === 'number') pv2 = pyStr(pv);
          else if (pv === 'true' || pv === 'false') pv2 = pv;
          else if (/^\d+$/.test(String(pv))) pv2 = pv;
          else pv2 = yq(pv);
          I(3, gKey(pk) + ': ' + pv2);
        }
      }
      if (truthy(p.smux) && truthy(p.smux.enabled)) {
        I(2, 'smux:');
        I(3, 'enabled: true');
        if (truthy(p.smux.protocol)) I(3, 'protocol: ' + gScalar(p.smux.protocol));
      }
      // tls / sni 不是 ss 的字段：ss 是明文流加密，压根没有 TLS 握手层 —— 写了 mihomo 不报错
      // 也不告警，纯装饰，还容易让人误以为这条节点做了 TLS。client-fingerprint 反而是真字段
      // （shadow-tls / v2ray-plugin 会用到）。
      var ssFp = p.client_fp || p['client-fingerprint'];
      if (truthy(ssFp)) I(2, 'client-fingerprint: ' + gScalar(ssFp));

    } else if (t === 'ssr') {
      I(1, '- name: ' + yq(p.name));
      I(2, 'type: ssr');
      I(2, 'server: ' + gScalar(p.server));
      I(2, 'port: ' + pyStr(p.port));
      I(2, 'cipher: ' + gScalar(get(p, 'method', get(p, 'cipher', 'aes-256-cfb'))));
      I(2, 'password: ' + yq(get(p, 'password', '')));
      I(2, 'obfs: ' + gScalar(get(p, 'obfs', 'plain')));
      I(2, 'protocol: ' + gScalar(get(p, 'protocol', 'origin')));
      if (truthy(p.obfsparam)) I(2, 'obfs-param: ' + yq(p.obfsparam));
      if (truthy(p.protoparam)) I(2, 'protocol-param: ' + yq(p.protoparam));
      I(2, 'udp: true');

    } else if (t === 'trojan') {
      I(1, '- name: ' + yq(p.name));
      I(2, 'type: trojan');
      I(2, 'server: ' + gScalar(p.server));
      I(2, 'port: ' + pyStr(p.port));
      I(2, 'password: ' + yq(get(p, 'password', '')));
      I(2, 'udp: true');
      var tlsSec = get(p, 'security', 'tls');
      if (truthy(tlsSec) && tlsSec !== 'none') {
        // mihomo 的 trojan 没有 tls / flow 字段（trojan 自带 TLS），写了会被静默忽略。
        if (truthy(p.sni)) I(2, 'sni: ' + yq(p.sni));
        if (truthy(p.alpn)) {
          I(2, 'alpn:');
          var tl = alpnList(p.alpn);
          for (var i1 = 0; i1 < tl.length; i1++) I(3, '- ' + gScalar(tl[i1]));
        }
        if (truthy(p.fp)) I(2, 'client-fingerprint: ' + gScalar(p.fp));
        // ⚠️ trojan 官网示例里 client-fingerprint 在**前**、fingerprint 在**后**，
        // 跟 vmess / vless 的顺序正好相反（官网自己这两处就不一致）。
        if (certFingerprint(p.fingerprint)) I(2, 'fingerprint: ' + gScalar(certFingerprint(p.fingerprint)));
        if (truthy(p.allow_insecure)) I(2, 'skip-cert-verify: true');
        // 官方 trojan 模板：ss-opts 排在 reality-opts 之前
        if (truthy(p.ss_method)) {
          I(2, 'ss-opts:');
          I(3, 'enabled: true');
          I(3, 'method: ' + gScalar(p.ss_method));
          if (truthy(p.ss_password)) I(3, 'password: ' + yq(p.ss_password));
        }
        if (truthy(p.pbk)) {
          I(2, 'reality-opts:');
          I(3, 'public-key: ' + gScalar(p.pbk));
          if (truthy(p.sid)) I(3, 'short-id: ' + gScalar(p.sid));
          if (truthy(p.spx)) I(3, 'support-x25519mlkem768: ' + (String(p.spx).toLowerCase() === 'true' ? 'true' : 'false'));
        }
      }
      I(2, 'network: ' + gScalar(get(p, 'network', 'tcp')));
      if (p.network === 'ws') {
        if (truthy(p.host) || truthy(p.path)) {
          I(2, 'ws-opts:');
          if (truthy(p.path)) I(3, 'path: ' + yq(p.path));
          if (truthy(p.host)) { I(3, 'headers:'); I(4, 'Host: ' + gScalar(p.host)); }
        }
      }
      if (p.network === 'grpc' && truthy(p.grpc_service)) {
        I(2, 'grpc-opts:');
        I(3, 'grpc-service-name: ' + yq(p.grpc_service));
      }

    } else if (t === 'vmess') {
      I(1, '- name: ' + yq(p.name));
      I(2, 'type: vmess');
      I(2, 'server: ' + gScalar(p.server));
      I(2, 'port: ' + pyStr(p.port));
      I(2, 'udp: true');
      I(2, 'uuid: ' + gScalar(get(p, 'uuid', '')));
      I(2, 'alterId: ' + pyStr(get(p, 'aid', 0)));
      I(2, 'cipher: ' + gScalar(get(p, 'method', get(p, 'cipher', 'auto'))));
      var tlsV = get(p, 'tls', 'none');
      if (truthy(tlsV) && tlsV !== 'none') {
        I(2, 'tls: true');
        if (truthy(p.sni) || truthy(p.servername)) {
          I(2, 'servername: ' + yq(p.sni || p.servername));
        }
        if (truthy(p.alpn)) {
          I(2, 'alpn:');
          var vl = alpnList(p.alpn);
          for (var i2 = 0; i2 < vl.length; i2++) I(3, '- ' + gScalar(vl[i2]));
        }
        // 官网 vmess 示例：alpn → fingerprint → client-fingerprint → skip-cert-verify。
        // fingerprint 是「证书固定」，和 client-fingerprint（uTLS 指纹）不是一回事。
        if (certFingerprint(p.fingerprint)) I(2, 'fingerprint: ' + gScalar(certFingerprint(p.fingerprint)));
        if (truthy(p.fp)) I(2, 'client-fingerprint: ' + gScalar(p.fp));
        // vless / vmess 也要读 skip-cert-verify：解析器产出的是 allow_insecure，不读的话
        // 自签证书节点的这个设置会被静默丢掉。
        if (truthy(p.allow_insecure)) I(2, 'skip-cert-verify: true');
        if (truthy(p.pbk)) {
          I(2, 'reality-opts:');
          I(3, 'public-key: ' + gScalar(p.pbk));
          if (truthy(p.sid)) I(3, 'short-id: ' + gScalar(p.sid));
        }
      } else {
        I(2, 'tls: false');
      }
      I(2, 'network: ' + gScalar(get(p, 'net', 'tcp')));
      if (p.net === 'ws') {
        // host 是可选的 —— 绝大多数订阅的 ws 节点只给 path 不给 host；以 host 为前置条件
        // 会让这类节点的 path 整段丢弃、实际去连 "/"。
        I(2, 'ws-opts:');
        I(3, 'path: ' + yq(p.path || '/'));
        if (truthy(p.host)) { I(3, 'headers:'); I(4, 'Host: ' + gScalar(p.host)); }
      }
      if (p.net === 'grpc' && truthy(p.grpc_service)) {
        I(2, 'grpc-opts:');
        I(3, 'grpc-service-name: ' + yq(p.grpc_service));
      }
      if (p.net === 'h2') {
        if (truthy(p.h2_host) || truthy(p.h2_path)) {
          I(2, 'h2-opts:');
          if (truthy(p.h2_host)) {
            I(3, 'host:');
            var h2p = String(p.h2_host).split(',');
            for (var i3 = 0; i3 < h2p.length; i3++) I(4, '- ' + gScalar(h2p[i3].trim()));
          }
          if (truthy(p.h2_path)) I(3, 'path: ' + yq(p.h2_path));
        }
      }
      if (p.net === 'http') {
        I(2, 'http-opts:');
        I(3, 'method: ' + gScalar(get(p, 'http_method', 'GET')));
        if (truthy(p.path)) I(3, 'path: ' + yq(get(p, 'path', '/')));
        // 官方 HTTPOptions 是 method / path / headers 三个字段，headers 不能漏。
        var hdrs = kvPairs(p.http_headers);
        if (hdrs.length) {
          I(3, 'headers:');
          for (var i4 = 0; i4 < hdrs.length; i4++) {
            I(4, gKey(hdrs[i4][0]) + ': ' + gScalar(hdrs[i4][1]));
          }
        }
      }

    } else if (t === 'vless') {
      I(1, '- name: ' + yq(p.name));
      I(2, 'type: vless');
      I(2, 'server: ' + gScalar(p.server));
      I(2, 'port: ' + pyStr(p.port));
      I(2, 'udp: true');
      I(2, 'uuid: ' + gScalar(get(p, 'uuid', '')));
      var tlsOn = truthy(p.pbk) || truthy(truthy(p.security) && p.security !== 'none');
      if (tlsOn && truthy(p.flow)) I(2, 'flow: ' + gScalar(p.flow));
      if (tlsOn) {
        I(2, 'tls: true');
        if (truthy(p.sni)) I(2, 'servername: ' + yq(p.sni));
        if (truthy(p.alpn)) {
          I(2, 'alpn:');
          var ll = alpnList(p.alpn);
          for (var i5 = 0; i5 < ll.length; i5++) I(3, '- ' + gScalar(ll[i5]));
        }
        // 官网 vless 示例和 vmess 一样：alpn → fingerprint → client-fingerprint → skip-cert-verify
        if (certFingerprint(p.fingerprint)) I(2, 'fingerprint: ' + gScalar(certFingerprint(p.fingerprint)));
        if (truthy(p.fp)) I(2, 'client-fingerprint: ' + gScalar(p.fp));
        if (truthy(p.allow_insecure)) I(2, 'skip-cert-verify: true');
        if (truthy(p.pbk)) {
          I(2, 'reality-opts:');
          I(3, 'public-key: ' + gScalar(p.pbk));
          if (truthy(p.sid)) I(3, 'short-id: ' + gScalar(p.sid));
          if (truthy(p.spx)) I(3, 'support-x25519mlkem768: ' + (String(p.spx).toLowerCase() === 'true' ? 'true' : 'false'));
        }
        if (truthy(p.encryption)) I(2, 'encryption: ' + yq(p.encryption));
      }
      I(2, 'network: ' + gScalar(get(p, 'net', 'tcp')));
      if (p.net === 'ws') {
        I(2, 'ws-opts:');
        I(3, 'path: ' + yq(p.path || '/'));
        if (truthy(p.host)) { I(3, 'headers:'); I(4, 'Host: ' + gScalar(p.host)); }
      }
      if (p.net === 'grpc' && truthy(p.grpc_service)) {
        I(2, 'grpc-opts:');
        I(3, 'grpc-service-name: ' + yq(p.grpc_service));
      }
      if (p.net === 'h2') {
        if (truthy(p.h2_host) || truthy(p.h2_path)) {
          I(2, 'h2-opts:');
          if (truthy(p.h2_host)) {
            I(3, 'host:');
            var vh2 = String(p.h2_host).split(',');
            for (var i5b = 0; i5b < vh2.length; i5b++) I(4, '- ' + gScalar(vh2[i5b].trim()));
          }
          if (truthy(p.h2_path)) I(3, 'path: ' + yq(p.h2_path));
        }
      }
      if (p.net === 'http') {
        I(2, 'http-opts:');
        I(3, 'method: ' + gScalar(get(p, 'http_method', 'GET')));
        if (truthy(p.path)) I(3, 'path: ' + yq(get(p, 'path', '/')));
        var vhdrs = kvPairs(p.http_headers);
        if (vhdrs.length) {
          I(3, 'headers:');
          for (var i5c = 0; i5c < vhdrs.length; i5c++) {
            I(4, gKey(vhdrs[i5c][0]) + ': ' + gScalar(vhdrs[i5c][1]));
          }
        }
      }
      if (p.net === 'xhttp') {
        I(2, 'xhttp-opts:');
        if (truthy(p.xhttp_path)) I(3, 'path: ' + yq(get(p, 'xhttp_path', '/')));
        if (truthy(p.xhttp_host)) I(3, 'host: ' + gScalar(p.xhttp_host));
        if (truthy(p.xhttp_mode)) I(3, 'mode: ' + gScalar(p.xhttp_mode));
      }

    } else if (t === 'hysteria2') {
      I(1, '- name: ' + yq(p.name));
      I(2, 'type: hysteria2');
      I(2, 'server: ' + gScalar(p.server));
      // ⚠️ 原生 YAML 可以只写 `ports:` 不写 `port:`（内核认），别输出 `port: None`。
      if (truthy(p.port)) I(2, 'port: ' + pyStr(p.port));
      if (truthy(p.ports)) I(2, 'ports: ' + gScalar(p.ports));
      if (truthy(p.hop_interval)) I(2, 'hop-interval: ' + gScalar(p.hop_interval));
      I(2, 'password: ' + yq(get(p, 'password', '')));
      if (truthy(p.up)) I(2, 'up: ' + gScalar(p.up));
      if (truthy(p.down)) I(2, 'down: ' + gScalar(p.down));
      // 官方 hysteria2 模板：bbr-profile 排在 obfs 之前
      if (truthy(p.bbr_profile)) I(2, 'bbr-profile: ' + yq(p.bbr_profile));
      if (truthy(p.obfs)) I(2, 'obfs: ' + gScalar(p.obfs));
      if (truthy(p.obfs_password)) I(2, 'obfs-password: ' + yq(p.obfs_password));
      if (truthy(p.sni)) I(2, 'sni: ' + yq(p.sni));
      // 官方模板里 skip-cert-verify 是可选行，只在为真时出现（写 false 是噪音）
      if (truthy(p.insecure)) I(2, 'skip-cert-verify: true');
      // 官网 hysteria2 示例里紧跟 skip-cert-verify 的是 name-cert-verify
      if (truthy(p.name_cert_verify)) I(2, 'name-cert-verify: ' + gScalar(p.name_cert_verify));
      // 官方示例顺序：sni → skip-cert-verify → name-cert-verify → fingerprint → alpn。
      // fingerprint 就是证书固定（pinSHA256 落到这里）。
      if (certFingerprint(p.fingerprint)) I(2, 'fingerprint: ' + yq(certFingerprint(p.fingerprint)));
      if (truthy(p.alpn)) {
        I(2, 'alpn:');
        var hl = alpnList(p.alpn);
        for (var i6 = 0; i6 < hl.length; i6++) I(3, '- ' + gScalar(hl[i6]));
      }
      // 注意：hysteria2 没有 fast-open（Hysteria2Option 里没有这个字段）。

    } else if (t === 'hysteria') {
      I(1, '- name: ' + yq(p.name));
      I(2, 'type: hysteria');
      I(2, 'server: ' + gScalar(p.server));
      I(2, 'port: ' + pyStr(p.port));
      I(2, 'auth-str: ' + yq(get(p, 'auth_str', '')));
      // 官方 hysteria 模板：obfs / alpn 紧跟 auth-str，排在 protocol 之前
      if (truthy(p.obfs)) I(2, 'obfs: ' + gScalar(p.obfs));
      if (truthy(p.alpn)) {
        // mihomo 的 hysteria ALPN 是 []string —— 写成标量会直接报
        // "'alpn' is not a slice" 拒绝加载整份配置。
        I(2, 'alpn:');
        var yl = alpnList(p.alpn);
        for (var i7 = 0; i7 < yl.length; i7++) I(3, '- ' + gScalar(yl[i7]));
      }
      I(2, 'protocol: ' + gScalar(get(p, 'protocol', 'udp')));
      if (truthy(p.up)) I(2, 'up: ' + gScalar(p.up));
      if (truthy(p.down)) I(2, 'down: ' + gScalar(p.down));
      if (truthy(p.sni)) I(2, 'sni: ' + gScalar(p.sni));
      if (truthy(p.insecure)) I(2, 'skip-cert-verify: true');
      // 官网 hysteria 示例：sni → skip-cert-verify → name-cert-verify → … → fingerprint
      if (truthy(p.name_cert_verify)) I(2, 'name-cert-verify: ' + gScalar(p.name_cert_verify));
      if (certFingerprint(p.fingerprint)) I(2, 'fingerprint: ' + yq(certFingerprint(p.fingerprint)));
      // hysteria 有 fast-open（官方示例里排在最后），hysteria2 没有
      if (truthy(p.fast_open)) I(2, 'fast-open: true');

    } else if (t === 'tuic') {
      I(1, '- name: ' + yq(p.name));
      I(2, 'type: tuic');
      I(2, 'server: ' + gScalar(p.server));
      I(2, 'port: ' + pyStr(p.port));
      // ⚠️ Number()：YAML 里写成 "4"（字符串）也算 v4，不然 token 会丢
      if (truthy(p.token) && Number(p.version) === 4) {
        I(2, 'token: ' + yq(p.token));
      } else {
        I(2, 'uuid: ' + gScalar(get(p, 'uuid', '')));
        I(2, 'password: ' + yq(get(p, 'password', '')));
      }
      // 官方 tuic 模板顺序：heartbeat-interval / alpn 紧接凭据，
      // 然后 disable-sni → congestion-controller → bbr-profile → 最后 sni
      if (truthy(p.heartbeat)) I(2, 'heartbeat-interval: ' + gScalar(p.heartbeat));
      if (truthy(p.alpn)) {
        var ta = Array.isArray(p.alpn) ? p.alpn : String(p.alpn).split(',');
        var taOut = [];
        for (var i8 = 0; i8 < ta.length; i8++) {
          if (String(ta[i8]).trim()) taOut.push(gScalar(String(ta[i8]).trim()));
        }
        I(2, 'alpn: [' + taOut.join(', ') + ']');
      }
      if (truthy(p.disable_sni)) I(2, 'disable-sni: true');
      if (truthy(p.reduce_rtt)) I(2, 'reduce-rtt: true');
      if (truthy(p.request_timeout)) I(2, 'request-timeout: ' + gScalar(p.request_timeout));
      if (truthy(p.udp_relay_mode)) I(2, 'udp-relay-mode: ' + gScalar(p.udp_relay_mode));
      if (truthy(p.congestion)) I(2, 'congestion-controller: ' + gScalar(p.congestion));
      if (truthy(p.bbr_profile)) I(2, 'bbr-profile: ' + yq(p.bbr_profile));
      if (truthy(p.max_udp)) I(2, 'max-udp-relay-packet-size: ' + gScalar(p.max_udp));
      if (truthy(p.fast_open)) I(2, 'fast-open: true');
      if (truthy(p.insecure)) I(2, 'skip-cert-verify: true');
      if (truthy(p.udp_over_stream)) I(2, 'udp-over-stream: true');
      if (truthy(p.sni)) I(2, 'sni: ' + yq(p.sni));

    } else if (t === 'wireguard') {
      I(1, '- name: ' + yq(p.name));
      I(2, 'type: wireguard');
      I(2, 'private-key: ' + yq(get(p, 'private_key', '')));
      I(2, 'server: ' + gScalar(p.server));
      I(2, 'port: ' + pyStr(p.port));
      if (truthy(p.ip)) I(2, 'ip: ' + gScalar(p.ip));
      if (truthy(p.ipv6)) I(2, 'ipv6: ' + gScalar(p.ipv6));
      I(2, 'public-key: ' + yq(get(p, 'public_key', '')));
      // allowed-ips 官网排在 public-key 之后、pre-shared-key 之前
      if (truthy(p.allowed_ips)) {
        I(2, 'allowed-ips: [' + alpnList(p.allowed_ips).map(gScalar).join(', ') + ']');
      }
      if (truthy(p.psk)) I(2, 'pre-shared-key: ' + yq(p.psk));
      if (truthy(p.reserved)) {
        // mihomo 的 reserved 是 []uint8，必须是列表。链接里的形态是 "1,2,3"，
        // 直接当标量写出去会变成字符串（类型不对），用 _g_scalar 还会被加引号。
        var res = Array.isArray(p.reserved) ? p.reserved : String(p.reserved).split(',');
        var resOut = [];
        for (var i9 = 0; i9 < res.length; i9++) {
          var rv = String(res[i9]).trim();
          if (rv === '') continue;
          // ⚠️ 这里**不能**用 gScalar：它会给数字加引号，而 mihomo 的 reserved 是 []uint8，
          //    `"1"` 进 uint8 会被拒 → 整份配置加载失败（wg 节点连累所有节点）。
          var rn = Number(rv);
          if (!isFinite(rn) || rn < 0 || rn > 255) continue;
          resOut.push(String(Math.floor(rn)));
        }
        if (resOut.length) I(2, 'reserved: [' + resOut.join(', ') + ']');
      }
      // ⚠️ 官网 wg 示例的顺序是 persistent-keepalive → ip-stack → udp → mtu，
      // 别写成 mtu → udp → persistent-keepalive（见 README 差异表）。
      if (truthy(p.keepalive)) I(2, 'persistent-keepalive: ' + gScalar(p.keepalive));
      if (truthy(p.ip_stack) && typeof p.ip_stack === 'object' && !Array.isArray(p.ip_stack)) {
        I(2, 'ip-stack:');
        if (truthy(p.ip_stack.mode)) I(3, 'mode: ' + gScalar(p.ip_stack.mode));
        if (truthy(p.ip_stack['congestion-controller'])) {
          I(3, 'congestion-controller: ' + gScalar(p.ip_stack['congestion-controller']));
        }
      }
      I(2, 'udp: true');
      if (truthy(p.mtu)) I(2, 'mtu: ' + gScalar(p.mtu));
      if (truthy(p.dialer_proxy)) I(2, 'dialer-proxy: ' + gScalar(p.dialer_proxy));
      if (truthy(p.remote_dns_resolve)) I(2, 'remote-dns-resolve: true');
      // dns 是列表（官方形态 dns: [ 1.1.1.1, 8.8.8.8 ]），只在 remote-dns-resolve 为真时生效
      if (truthy(p.dns)) {
        I(2, 'dns: [' + alpnList(p.dns).map(gScalar).join(', ') + ']');
      }
      if (truthy(p.amnezia)) {
        I(2, 'amnezia-wg-option:');
        for (var ak in p.amnezia) {
          if (!Object.prototype.hasOwnProperty.call(p.amnezia, ak)) continue;
          if (truthy(p.amnezia[ak])) I(3, gKey(ak) + ': ' + gScalar(p.amnezia[ak]));
        }
      }

    } else if (t === 'snell') {
      I(1, '- name: ' + yq(p.name));
      I(2, 'type: snell');
      I(2, 'server: ' + gScalar(p.server));
      I(2, 'port: ' + pyStr(p.port));
      I(2, 'psk: ' + yq(get(p, 'psk', '')));
      if (truthy(p.version)) I(2, 'version: ' + gScalar(p.version));
      // Snell v6（mihomo 1.19.34 起）多了个**顶层** `mode`（default / unshaped / unsafe-raw）；
      // 而且 v6 不再走 simple-obfs 那一层：带 tls / http 的 obfs 会被内核直接拒载
      // （adapter/outbound/snell.go: "version 6 does not support obfs mode"）。
      // 所以 v6 只写 mode、不写 obfs-opts；旧版本照旧。
      var snVer = Number(get(p, 'version', 0));
      if (snVer === 6 && truthy(p.mode)) I(2, 'mode: ' + gScalar(p.mode));
      // 官网 snell 示例里 udp / reuse / client-fingerprint 都排在 version 之后、obfs-opts
      // 之前；不输出的话订阅里带的设置会直接丢。
      if (truthy(p.udp)) I(2, 'udp: true');
      if (truthy(p.reuse)) I(2, 'reuse: true');
      var snFp = p.fp || p['client-fingerprint'];
      if (truthy(snFp)) I(2, 'client-fingerprint: ' + gScalar(snFp));
      if (snVer !== 6) {
        // obfs-opts 的子键随 mode 不同而不同：http 只要 mode+host，shadow-tls 还要
        // password/version/alpn，restls 要 version-hint，jls 要 username/password。
        var snO = (p.obfs_opts !== null && typeof p.obfs_opts === 'object' &&
          !Array.isArray(p.obfs_opts)) ? p.obfs_opts : null;
        var snMode = snO ? get(snO, 'mode', p.obfs) : p.obfs;
        if (truthy(snMode)) {
          I(2, 'obfs-opts:');
          I(3, 'mode: ' + gScalar(snMode));
          var snHost = snO ? get(snO, 'host', p.obfs_host) : p.obfs_host;
          if (truthy(snHost)) I(3, 'host: ' + gScalar(snHost));
          if (snO) {
            var SN_KEYS = ['username', 'password', 'version', 'version-hint', 'alpn'];
            for (var sk = 0; sk < SN_KEYS.length; sk++) {
              if (!truthy(snO[SN_KEYS[sk]])) continue;
              if (SN_KEYS[sk] === 'alpn') {
                var sa = alpnList(snO.alpn);
                I(3, 'alpn: [' + sa.map(gScalar).join(', ') + ']');
              } else {
                I(3, SN_KEYS[sk] + ': ' + gScalar(snO[SN_KEYS[sk]]));
              }
            }
          } else {
            // 链接来源：解析器把它们拍平成了 password / version 等键
            if (truthy(p.obfs_password)) I(3, 'password: ' + yq(p.obfs_password));
            if (truthy(p.obfs_version)) I(3, 'version: ' + gScalar(p.obfs_version));
          }
        }
      }

    } else if (t === 'http') {
      I(1, '- name: ' + yq(p.name));
      I(2, 'type: http');
      I(2, 'server: ' + gScalar(p.server));
      I(2, 'port: ' + pyStr(p.port));
      if (truthy(p.username)) I(2, 'username: ' + yq(p.username));
      if (truthy(p.password)) I(2, 'password: ' + yq(p.password));
      if (truthy(p.tls)) {
        I(2, 'tls: true');
        if (getFlag(p, 'skip_cert_verify', 'allow_insecure', 'insecure', 'skip-cert-verify')) {
          I(2, 'skip-cert-verify: true');
        }
        if (truthy(p.sni)) I(2, 'sni: ' + yq(p.sni));
        if (certFingerprint(p.fingerprint)) I(2, 'fingerprint: ' + gScalar(certFingerprint(p.fingerprint)));
      }

    } else if (t === 'socks5') {
      I(1, '- name: ' + yq(p.name));
      I(2, 'type: socks5');
      I(2, 'server: ' + gScalar(p.server));
      I(2, 'port: ' + pyStr(p.port));
      if (truthy(p.username)) I(2, 'username: ' + yq(p.username));
      if (truthy(p.password)) I(2, 'password: ' + yq(p.password));
      if (truthy(p.tls)) I(2, 'tls: true');
      // 官方 socks.md 示例顺序：tls → fingerprint → skip-cert-verify → udp。
      if (certFingerprint(p.fingerprint)) I(2, 'fingerprint: ' + gScalar(certFingerprint(p.fingerprint)));
      if (getFlag(p, 'skip_cert_verify', 'allow_insecure', 'insecure', 'skip-cert-verify')) {
        I(2, 'skip-cert-verify: true');
      }
      I(2, 'udp: true');

    } else if (t === 'ssh') {
      I(1, '- name: ' + yq(p.name));
      I(2, 'type: ssh');
      I(2, 'server: ' + gScalar(p.server));
      I(2, 'port: ' + pyStr(p.port));
      I(2, 'username: ' + yq(get(p, 'username', '')));
      // 只用私钥的节点不写空 password（mihomo 会当成空口令去认证，噪音且容易误判）
      if (truthy(get(p, 'password', ''))) I(2, 'password: ' + yq(p.password));
      // 键名两种写法都吃：链接解析器给 private_key，Clash YAML 给 private-key。
      var sshPk = p.private_key || p['private-key'];
      if (truthy(sshPk)) I(2, 'private-key: ' + yq(sshPk));
      var sshPkp = p.private_key_passphrase || p['private-key-passphrase'];
      if (truthy(sshPkp)) I(2, 'private-key-passphrase: ' + yq(sshPkp));

    } else if (t === 'shadowtls') {
      I(1, '- name: ' + yq(p.name));
      I(2, 'type: ss');
      I(2, 'server: ' + gScalar(p.server));
      I(2, 'port: ' + pyStr(p.port));
      I(2, 'cipher: chacha20-ietf-poly1305');
      I(2, 'password: ' + yq(get(p, 'password', '')));
      I(2, 'plugin: shadow-tls');
      I(2, 'plugin-opts:');
      I(3, 'host: ' + yq(get(p, 'host', 'cloud.tencent.com')));
      I(3, 'password: ' + yq(get(p, 'password', '')));
      I(3, 'version: ' + gScalar(get(p, 'version', 2)));
      // shadow-tls 的 uTLS 指纹走的是 ss 层的 client-fingerprint，不是 plugin-opts
      // 里的 fingerprint —— 真实字段是 ShadowTLSOption.ClientFingerprint。
      var stFp = p.fp || p['client-fp'] || p['client-fingerprint'];
      if (truthy(stFp)) I(2, 'client-fingerprint: ' + gScalar(stFp));

    } else {
      // 没手写分支的类型：通用透传（用原始字典，保持 mihomo 原生键名）
      L = renderGeneric(raw);
    }

    if (dual && IPVERSION_TYPES.indexOf(t) !== -1 && !hasIpVersion(L)) {
      // 节点自带 ip-version 就沿用（订阅里可能是 ipv4 / ipv6-prefer），没有才补默认的 dual；
      // render_generic 已经把自带那条写过了，所以要判重。官网 ss 示例把 ip-version 排在 plugin 之前。
      var idx = L.length;
      if (t === 'ss' || t === 'shadowtls') {
        for (var i10 = 0; i10 < L.length; i10++) {
          if (L[i10].replace(/^\s+/, '').indexOf('plugin:') === 0) { idx = i10; break; }
        }
      }
      L.splice(idx, 0, '    ip-version: ' + gScalar(get(p, 'ip-version', undefined) || 'dual'));
    }
    return L;
  }

  MH.proxyToYaml = proxyToYaml;
})(typeof globalThis !== 'undefined' ? globalThis : this);
