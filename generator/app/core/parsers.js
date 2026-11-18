/*!
 * iStoreOS-Mihomo-config 生成器 — 节点解析
 *
 * 移植自 Python 版的 `ProxyParser` / `parse_any_input` / `clean_name` / `host_ok` /
 * `dedupe_names` / `extract_domains` 等。
 * 注意：输出的字典键名是内部风格（method / fp / net / aid / allow_insecure …），与订阅 YAML
 * 里 mihomo 原生键名不同；渲染器两套都认（render.js 的 `_to_internal` 与通用透传），
 * 所以别在解析阶段做归一，那会让两边输出不一致。
 */
(function (root) {
  'use strict';

  var MH = (root.MH = root.MH || {});
  var urlDec = MH.urlDec;
  var parseQslDict = MH.parseQslDict;
  var b64Decode = MH.b64Decode;
  var b64DecodeSafe = MH.b64DecodeSafe;
  var looksLikeB64 = MH.looksLikeB64;
  var sInt = MH.sInt;
  var sBool = MH.sBool;
  var isIp = MH.isIp;
  var isIpv6 = MH.isIpv6;
  var truthy = MH.truthy;

  // ── 小工具 ──────────────────────────────────────────────────
  /** 按第一个分隔符切成两段（Python 的 `s.split(ch, 1)`）。 */
  function splitOnce(s, ch) {
    var at = s.indexOf(ch);
    if (at === -1) return [s, ''];
    return [s.slice(0, at), s.slice(at + ch.length)];
  }

  /** 按最后一个分隔符切成两段（Python 的 `s.rsplit(ch, 1)`）。 */
  function rSplitOnce(s, ch) {
    var at = s.lastIndexOf(ch);
    if (at === -1) return [s, ''];
    return [s.slice(0, at), s.slice(at + ch.length)];
  }

  /** Python 的 `dict.get(k, default)`。 */
  function get(p, k, d) {
    return Object.prototype.hasOwnProperty.call(p, k) ? p[k] : d;
  }

  /**
   * 从 query 参数字典里取值 —— parseQslDict 已经解码过一次，这里不能再 unquote；写成
   * `urlDec(get(params, ...))` 会把 `%2520` 解两次，path / SNI / 密码都会静默变形。
   */
  function qget(p, k, d) { return get(p, k, d); }

  /** Python 的 `str.splitlines()` 的常见子集。 */
  var LINE_BREAK = new RegExp(String.raw`\r\n|[\n\r\v\f\u001c\u001d\u001e\u0085\u2028\u2029]`);

  /**
   * 从 `host[:port][/path]` 解析 (host, port)。
   *
   * sing-box / Clash 导出的链接常写成 `host:33222/?query#tag`，`?` 切掉后剩 `host:33222/`，
   * 直接 rpartition(':') 会得到 port=`33222/`，int() 失败回退成默认端口 —— 端口被静默改掉。
   * 这里只剥尾随的斜杠，带真实路径的（`host/sub`）保持原样交给 host_ok。
   * 注意：端口那格必须是纯数字，不是的话连 host 一起原样返回，不能退回默认端口 —— 否则
   * `host:2096/sub/ALL` 会把路径从 host 里抹掉，hostOk 拦不住，静默冒出个连不上的假节点。
   */
  function splitHostPort(hostport, defaultPort) {
    if (defaultPort === undefined) defaultPort = 443;
    hostport = String(hostport == null ? '' : hostport).replace(/\/+$/, '').trim();
    if (hostport.charAt(0) === '[') {
      var idx = hostport.indexOf(']');
      if (idx !== -1) {
        var host = hostport.slice(1, idx);
        var rest = hostport.slice(idx + 1);
        if (rest.charAt(0) === ':') {
          if (/^[0-9]+$/.test(rest.slice(1))) {
            var p6 = parseInt(rest.slice(1), 10);
            if (!(p6 >= 1 && p6 <= 65535)) return [hostport, defaultPort];
            return [host, p6];
          }
          return [hostport, defaultPort];
        }
        return [host, defaultPort];
      }
    }
    if (hostport.indexOf(':') !== -1) {
      var parts = rSplitOnce(hostport, ':');
      if (!/^[0-9]+$/.test(parts[1])) return [hostport, defaultPort];
      var pn = parseInt(parts[1], 10);
      // 端口必须是 1-65535：0 / 99999 这类越界值不能原样带走（内核按 uint16 解析，
      // 会把整份配置判成非法）。返回原串交给 hostOk 拒掉整个节点。
      if (!(pn >= 1 && pn <= 65535)) return [hostport, defaultPort];
      return [parts[0], pn];
    }
    return [hostport, defaultPort];
  }

  /**
   * 清洗节点名：去掉控制字符（含换行）、双引号与逗号，截断到 128 个码点。
   *
   * 逗号必须去掉：名字会写进 `MATCH,{name}` 这类规则行，含逗号会被解析成多个字段。换行 /
   * 控制字符必须去掉：否则名字会越出 YAML 标量，足以往 rules 里注入任意条目。
   */
  function cleanName(name, fallback) {
    var s = String(name == null ? '' : name).replace(/^\s+|\s+$/g, '');
    s = s.replace(/[\u0000-\u001f\u007f]/g, '');
    // ⚠️ `#` 也要去掉：规则行是 `- MATCH,<名字>`，名字里一旦出现 " #"，
    //    YAML 会把它当注释截掉 ⇒ 规则指向一个不存在的节点，内核整份拒载。
    // ⚠️ `:` 同样必须去掉：`- MATCH,US: 1x` 会被 YAML 解析成 **map**
    //    （{"MATCH,US": "1x"}），mihomo 的 rules []string 反序列化失败 ⇒ 整份拒载。
    s = s.replace(/"/g, '').replace(/,/g, ' ').replace(/#/g, '').replace(/:/g, ' ')
      .replace(/^\s+|\s+$/g, '');
    s = s.replace(/\s{2,}/g, ' ');
    s = Array.from(s).slice(0, 128).join('');   // Python 按码点截断，不是 UTF-16 码元
    // ⚠️ 内置动作 / 组名不能当节点名：叫 REJECT 的节点会让 `MATCH,REJECT` 拒掉所有流量，
    //    叫 DIRECT 的会静默变成直连。加个后缀区分开。
    if (/^(DIRECT|REJECT|PASS|COMPATIBLE|GLOBAL|智能选择)$/i.test(s)) s += '（节点）';
    return s || fallback;
  }

  /**
   * server 是不是一个说得通的地址。不加这道闸，输入里混进一行
   * `https://example.com/sub?token=x` 会被当成「主机就是 example.com/sub」收下，生成假节点。
   */
  function hostOk(server) {
    var s = String(server == null ? '' : server).trim();
    if (!s) return false;
    // ⚠️ 引号 / 反引号也拒：server 会被写进 fake-ip-filter 的 `- '<server>'`，
    //    一个单引号就能把 YAML 标量截断（`- 'foo'bar.com'` ⇒ 整份配置解析失败）。
    if (/[/\\?#@ \t\r\n'"`]/.test(s)) return false;
    if (/^[0-9]+$/.test(s)) return false;   // 纯数字既不是 IP 也不是域名
    // 域名里不可能有冒号；只有 IPv6 字面量能带。splitHostPort 在端口那格不是
    // 数字时会把整串原样返回（比如 `1.2.3.4:abc`），靠这条兜住。
    if (s.indexOf(':') !== -1 && !isIpv6(s)) return false;
    return true;
  }

  /**
   * 面板密码会写进 YAML 的 secret 字段，剔除空白 / 引号 / 控制字符 / 反斜杠。
   * 注意：反斜杠也要剔 —— 它会被 YAML 双引号标量转义，而写盘 CGI 用 sed 读那一行、不解
   * 转义，拿到的密码和浏览器的对不上，永远 403。
   */
  function cleanSecret(s) {
    return String(s == null ? '' : s).replace(/[\s"'\\\u0000-\u001f\u007f]/g, '');
  }

  /**
   * external-controller 的监听地址。只剔除空白与控制字符，**不猜地址本身** ——
   * IP、0.0.0.0、域名都是合法值。清完是空串就交给调用方回落到出厂值。
   */
  function cleanListen(s) {
    s = String(s == null ? '' : s).replace(/[\s\u0000-\u001f\u007f]/g, '');
    if (!s) return s;
    // ⚠️ 这一格**只放地址**。宿主 / 老版本可能把端口也带进来（`1.2.3.4:9090`、
    //    `[::1]:9090`）—— 不剥掉的话引擎会再拼一次端口，变成 `[1.2.3.4:9090]:9090`
    //    或 `[::1]:9090:9090`，内核解析监听地址失败、整份配置拒载。
    var m;
    if (s.charAt(0) === '[') {
      m = /^\[([^\]]+)\](?::[0-9]+)?$/.exec(s);
      return m ? m[1] : s;
    }
    // IPv4 / 域名 + 一个端口；裸 IPv6（多个冒号）不碰
    m = /^([^:]+):[0-9]+$/.exec(s);
    return m ? m[1] : s;
  }

  /** 同名节点加 `(2)` `(3)` 后缀 —— proxy-groups / MATCH 是按名字引用节点的。 */
  function dedupeNames(proxies) {
    var seen = Object.create(null);
    for (var i = 0; i < proxies.length; i++) {
      var p = proxies[i];
      var base = p.name;
      var n = base;
      var k = 2;
      while (seen[n]) { n = base + ' (' + k + ')'; k += 1; }
      seen[n] = true;
      p.name = n;
    }
    return proxies;
  }

  /** 节点里的域名 server（不含 IP），去重 —— fake-ip 模式下要放行它们。 */
  function extractDomains(proxies) {
    var domains = [];
    for (var i = 0; i < proxies.length; i++) {
      var host = String((proxies[i] && proxies[i].server) || '').trim();
      if (!host || isIp(host)) continue;
      if (domains.indexOf(host) === -1) domains.push(host);
    }
    return domains;
  }

  // ── 稳定序列化（去重键用）──────────────────────────────────
  /** Python `json.dumps(obj, sort_keys=True, ensure_ascii=False, default=str)`。 */
  function stableJson(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return isFinite(v) ? String(v) : 'null';
    if (typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) {
      var items = [];
      for (var i = 0; i < v.length; i++) items.push(stableJson(v[i]));
      return '[' + items.join(', ') + ']';
    }
    if (typeof v === 'object') {
      var keys = Object.keys(v).sort();
      var parts = [];
      for (var j = 0; j < keys.length; j++) {
        parts.push(JSON.stringify(keys[j]) + ': ' + stableJson(v[keys[j]]));
      }
      return '{' + parts.join(', ') + '}';
    }
    return JSON.stringify(String(v));
  }

  // ── 各协议解析 ──────────────────────────────────────────────
  function splitHashAndQuery(u, prefixLen) {
    var raw = u.slice(prefixLen);
    var remark = '';
    if (raw.indexOf('#') !== -1) {
      var h = splitOnce(raw, '#');
      raw = h[0];
      remark = urlDec(h[1]);
    }
    var params = {};
    if (raw.indexOf('?') !== -1) {
      var q = splitOnce(raw, '?');
      raw = q[0];
      params = parseQslDict(q[1]);
    }
    return { raw: raw, remark: remark, params: params };
  }

  function parseSs(u) {
    u = u.trim();
    if (u.indexOf('ss://') !== 0) return null;
    var s = splitHashAndQuery(u, 5);
    var raw = s.raw, remark = s.remark, params = s.params;
    var method, password, sp;
    if (raw.indexOf('@') !== -1) {
      var at = splitOnce(raw, '@');
      var mp = at[0];
      sp = at[1];
      var decoded = b64Decode(mp);
      if (decoded && decoded.indexOf(':') !== -1) {
        var d = splitOnce(decoded, ':');
        method = d[0]; password = d[1];
      } else if (mp.indexOf(':') !== -1) {
        var m2 = splitOnce(mp, ':');
        method = m2[0]; password = m2[1];
      } else {
        return null;
      }
    } else {
      var dec = b64Decode(raw);
      if (!dec || dec.indexOf('@') === -1) return null;
      var parts = splitOnce(dec, '@');
      var mp2 = parts[0];
      sp = parts[1];
      if (mp2.indexOf(':') === -1) return null;
      var m3 = splitOnce(mp2, ':');
      method = m3[0]; password = m3[1];
    }
    var hp = splitHostPort(sp, 443);
    var server = hp[0], port = hp[1];
    password = urlDec(password);

    var pluginRaw = qget(params, 'plugin', '');
    var plugin = '';
    var pluginOpts = {};
    var smux = null;
    if (pluginRaw) {
      var pp = pluginRaw.split(';');
      plugin = pp[0].trim();
      for (var i = 1; i < pp.length; i++) {
        if (pp[i].indexOf('=') !== -1) {
          var kv = splitOnce(pp[i], '=');
          pluginOpts[kv[0].trim()] = kv[1].trim();
        }
      }
    }
    var OPTS = ['obfs-host', 'obfs-uri', 'host', 'path', 'mode', 'mux',
      'tls', 'insecure', 'sni', 'certificate', 'private-key',
      'skip-cert-verify', 'fingerprint', 'ca', 'ca_str',
      'alpn', 'custom', 'version', 'password', 'psk'];
    for (var j = 0; j < OPTS.length; j++) {
      var v = get(params, OPTS[j], '');
      if (v) pluginOpts[OPTS[j]] = v;
    }
    if (get(params, 'smux', '') === '1' || get(params, 'mux', '') === '1') {
      smux = { enabled: true, protocol: get(params, 'smux-proto', 'smux') };
    }
    return {
      type: 'ss', method: method, password: password,
      server: server, port: port, remarks: remark || server,
      plugin: plugin, plugin_opts: Object.keys(pluginOpts).length ? pluginOpts : null,
      smux: smux
    };
  }

  function parseSsr(u) {
    u = u.trim();
    if (u.indexOf('ssr://') !== 0) return null;
    var s = splitHashAndQuery(u, 6);
    var raw = s.raw, remark = s.remark, params = s.params;
    var decoded = b64Decode(raw);
    if (!decoded) return null;
    var main = decoded;
    var extra, kv;
    if (main.indexOf('/?') !== -1) {
      var e1 = splitOnce(main, '/?');
      main = e1[0];
      extra = e1[1];
      kv = parseQslDict(splitOnce(extra, '#')[0]);
      for (var k1 in kv) if (Object.prototype.hasOwnProperty.call(kv, k1)) params[k1] = kv[k1];
    }
    if (main.indexOf('?') !== -1) {
      var e2 = splitOnce(main, '?');
      main = e2[0];
      extra = e2[1];
      kv = parseQslDict(splitOnce(extra, '#')[0]);
      for (var k2 in kv) if (Object.prototype.hasOwnProperty.call(kv, k2)) params[k2] = kv[k2];
    }
    var parts = main.split(':');
    if (parts.length < 6) return null;
    var srv = parts[0], port = parts[1], proto = parts[2],
      method = parts[3], obfs = parts[4], pw = parts[5];
    var password = b64Decode(pw) || pw;
    return {
      type: 'ssr', server: srv, port: sInt(port, 443),
      protocol: proto, method: method, obfs: obfs,
      password: urlDec(password),
      protoparam: qget(params, 'protoparam', ''),
      obfsparam: qget(params, 'obfsparam', ''),
      remarks: remark || srv
    };
  }

  function parseTrojan(u) {
    u = u.trim();
    if (u.indexOf('trojan://') !== 0) return null;
    var s = splitHashAndQuery(u, 9);
    var raw = s.raw, remark = s.remark, params = s.params;
    if (raw.indexOf('@') === -1) return null;
    var at = splitOnce(raw, '@');
    var password = urlDec(at[0]);
    var hp = splitHostPort(at[1], 443);
    return {
      type: 'trojan', password: password,
      server: hp[0], port: hp[1], remarks: remark || hp[0],
      sni: qget(params, 'sni', hp[0]),
      security: get(params, 'security', 'tls'),
      alpn: get(params, 'alpn', ''),
      fp: get(params, 'fp', 'chrome'),
      flow: get(params, 'flow', ''),
      allow_insecure: sBool(get(params, 'allowInsecure', '0')),
      network: get(params, 'type', 'tcp'),
      host: qget(params, 'host', ''),
      path: qget(params, 'path', '/'),
      grpc_service: get(params, 'serviceName', get(params, 'grpc-serviceName', '')),
      pbk: get(params, 'pbk', ''),
      sid: get(params, 'sid', ''),
      spx: get(params, 'spx', ''),
      ss_method: get(params, 'ss', ''),
      ss_password: qget(params, 'ss-password', '')
    };
  }

  function parseVmess(u) {
    u = u.trim();
    if (u.indexOf('vmess://') !== 0) return null;
    var raw = u.slice(8);
    // ⚠️ vmess 的正文是整段 base64，**后面还可以带一个 `#备注`**：
    //    不先切掉，备注里的字母会拼到 base64 尾巴上 ⇒ 解码/JSON 解析失败、整条丢掉。
    var frag = '';
    var h = raw.indexOf('#');
    if (h >= 0) { frag = raw.slice(h + 1); raw = raw.slice(0, h); }
    var js = b64Decode(raw);
    if (!js) return null;
    var o;
    try { o = JSON.parse(js); } catch (e) { return null; }
    if (o === null || typeof o !== 'object' || Array.isArray(o)) return null;
    return {
      type: 'vmess',
      uuid: get(o, 'id', ''),
      server: get(o, 'add', ''),
      port: sInt(get(o, 'port', undefined), 443),
      aid: sInt(get(o, 'aid', 0)),
      method: get(o, 'scy', 'auto'),
      net: get(o, 'net', 'tcp'),
      tls: get(o, 'tls', 'none'),
      sni: get(o, 'sni', ''),
      host: get(o, 'host', ''),
      path: get(o, 'path', '/'),
      fp: get(o, 'fp', 'chrome'),
      alpn: get(o, 'alpn', ''),
      remarks: get(o, 'ps', '') || decodeFrag(frag) || get(o, 'add', ''),
      pbk: get(o, 'pbk', ''),
      sid: get(o, 'sid', ''),
      spx: get(o, 'spx', ''),
      grpc_service: get(o, 'serviceName', ''),
      http_method: get(o, 'method', 'GET'),
      http_headers: get(o, 'headers', ''),
      h2_host: get(o, 'h2Host', ''),
      h2_path: get(o, 'h2Path', '/')
    };
  }

  function parseVless(u) {
    u = u.trim();
    if (u.indexOf('vless://') !== 0) return null;
    var s = splitHashAndQuery(u, 8);
    var raw = s.raw, remark = s.remark, params = s.params;
    if (raw.indexOf('@') === -1) return null;
    var at = splitOnce(raw, '@');
    var uuid = at[0];
    var hp = splitHostPort(at[1], 443);
    return {
      type: 'vless',
      uuid: uuid, server: hp[0], port: hp[1], remarks: remark || hp[0],
      net: get(params, 'type', 'tcp'),
      security: get(params, 'security', 'none'),
      sni: qget(params, 'sni', hp[0]),
      flow: get(params, 'flow', ''),
      fp: get(params, 'fp', 'chrome'),
      pbk: get(params, 'pbk', ''),
      sid: get(params, 'sid', ''),
      spx: get(params, 'spx', ''),
      path: qget(params, 'path', '/'),
      host: qget(params, 'host', ''),
      alpn: get(params, 'alpn', ''),
      encryption: get(params, 'encryption', ''),
      grpc_service: get(params, 'serviceName', ''),
      xhttp_mode: get(params, 'xhttp-mode', ''),
      xhttp_host: qget(params, 'xhttp-host', ''),
      xhttp_path: qget(params, 'xhttp-path', '/')
    };
  }

  function parseHysteria2(u) {
    u = u.trim();
    var raw;
    if (u.indexOf('hy2://') === 0) {
      raw = u.slice(6);          // 'hy2://' 是 6 个字符；写成 u[5:] 会多吃一个 '/'，密码前面多出一个斜杠
    } else if (u.indexOf('hysteria2://') === 0) {
      raw = u.slice(12);
    } else {
      return null;
    }
    // 前缀已经切掉了，这里只处理 # 与 ? —— 复用 splitHashAndQuery 会重复切前缀
    var remark = '';
    if (raw.indexOf('#') !== -1) {
      var h = splitOnce(raw, '#');
      raw = h[0];
      remark = urlDec(h[1]);
    }
    var params = {};
    if (raw.indexOf('?') !== -1) {
      var q = splitOnce(raw, '?');
      raw = q[0];
      params = parseQslDict(q[1]);
    }
    if (raw.indexOf('@') === -1) return null;
    var at = splitOnce(raw, '@');
    var hp = splitHostPort(at[1], 443);
    return {
      type: 'hysteria2', password: urlDec(at[0]),
      server: hp[0], port: hp[1], remarks: remark || hp[0],
      sni: qget(params, 'sni', hp[0]),
      insecure: sBool(get(params, 'insecure', '0')),
      obfs: get(params, 'obfs', ''),
      obfs_password: qget(params, 'obfs-password', ''),
      up: get(params, 'up', ''), down: get(params, 'down', ''),
      // mihomo 没有 pinSHA256 这个键，证书固定写在 fingerprint 上
      // （mihomo 自己的链接转换器 common/convert/converter.go 也是这么搬的）。
      fingerprint: qget(params, 'pinSHA256', '') || get(params, 'fingerprint', ''),
      alpn: get(params, 'alpn', 'h3'),
      bbr_profile: get(params, 'bbr-profile', ''),
      fast_open: sBool(get(params, 'fast-open', '0')),
      hop_interval: get(params, 'hop-interval', ''),
      ports: get(params, 'ports', '')
    };
  }

  function parseHysteria(u) {
    u = u.trim();
    if (u.indexOf('hysteria://') !== 0) return null;
    var s = splitHashAndQuery(u, 11);
    var raw = s.raw, remark = s.remark, params = s.params;
    var auth, sp;
    if (raw.indexOf('@') !== -1) {
      var at = splitOnce(raw, '@');
      auth = at[0];
      sp = at[1];
    } else {
      auth = '';
      sp = raw;
    }
    var hp = splitHostPort(sp, 443);
    return {
      type: 'hysteria', server: hp[0], port: hp[1], remarks: remark || hp[0],
      auth_str: auth ? urlDec(auth) : qget(params, 'auth', ''),
      sni: qget(params, 'peer', hp[0]),
      insecure: sBool(get(params, 'insecure', '0')),
      up: get(params, 'up', ''), down: get(params, 'down', ''),
      obfs: get(params, 'obfs', ''),
      alpn: get(params, 'alpn', ''),
      protocol: get(params, 'protocol', 'udp'),
      fast_open: sBool(get(params, 'fast-open', '0')),
      fingerprint: qget(params, 'pinSHA256', '') || get(params, 'fingerprint', '')
    };
  }

  function parseTuic(u) {
    u = u.trim();
    if (u.indexOf('tuic://') !== 0) return null;
    var s = splitHashAndQuery(u, 7);
    var raw = s.raw, remark = s.remark, params = s.params;
    if (raw.indexOf('@') === -1) return null;
    var at = splitOnce(raw, '@');
    var left = at[0];
    var uuid = '', password = '', token = '', version;
    if (left.indexOf(':') !== -1) {
      var lp = splitOnce(left, ':');
      uuid = lp[0]; password = lp[1];
      token = '';
      version = 5;
    } else {
      token = left;
      uuid = ''; password = '';
      version = 4;
    }
    var hp = splitHostPort(at[1], 443);
    return {
      type: 'tuic',
      uuid: urlDec(uuid), password: urlDec(password),
      token: urlDec(token),
      version: version,
      server: hp[0], port: hp[1], remarks: remark || hp[0],
      sni: qget(params, 'sni', hp[0]),
      alpn: get(params, 'alpn', 'h3'),
      insecure: sBool(get(params, 'allow_insecure', get(params, 'insecure', '0'))),
      congestion: get(params, 'congestion_control', 'cubic'),
      udp_relay_mode: get(params, 'udp_relay_mode', 'native'),
      disable_sni: sBool(get(params, 'disable_sni', '0')),
      reduce_rtt: sBool(get(params, 'reduce_rtt', '0')),
      heartbeat: get(params, 'heartbeat_interval', ''),
      request_timeout: get(params, 'request_timeout', ''),
      bbr_profile: get(params, 'bbr-profile', ''),
      fast_open: sBool(get(params, 'fast-open', '0')),
      max_udp: get(params, 'max_udp_relay_packet_size', ''),
      udp_over_stream: sBool(get(params, 'udp_over_stream', '0'))
    };
  }

  function parseWireguard(u) {
    u = u.trim();
    if (u.indexOf('wireguard://') !== 0) return null;
    var s = splitHashAndQuery(u, 12);
    var raw = s.raw, remark = s.remark, params = s.params;
    if (raw.indexOf('@') === -1) return null;
    var at = splitOnce(raw, '@');
    var hp = splitHostPort(at[1], 2408);
    var AM_KEYS = ['jc', 'jmin', 'jmax', 's1', 's2', 's3', 's4',
      'h1', 'h2', 'h3', 'h4', 'i1', 'i2', 'i3', 'i4', 'i5',
      'j1', 'j2', 'j3', 'itime'];
    var amnezia = null;
    var am = {};
    for (var i = 0; i < AM_KEYS.length; i++) {
      var k = AM_KEYS[i];
      if (Object.prototype.hasOwnProperty.call(params, k)) am[k] = params[k];
    }
    if (Object.keys(am).length) amnezia = am;
    return {
      type: 'wireguard',
      private_key: urlDec(at[0]),
      public_key: qget(params, 'publicKey', ''),
      server: hp[0], port: hp[1], remarks: remark || hp[0],
      ip: get(params, 'ip', ''), ipv6: get(params, 'ipv6', ''),
      psk: qget(params, 'preSharedKey', ''),
      reserved: get(params, 'reserved', ''),
      mtu: sInt(get(params, 'mtu', 0)),
      keepalive: get(params, 'persistent-keepalive', ''),
      amnezia: amnezia
    };
  }

  function parseSnell(u) {
    u = u.trim();
    if (u.indexOf('snell://') !== 0) return null;
    var s = splitHashAndQuery(u, 8);
    var raw = s.raw, remark = s.remark, params = s.params;
    if (raw.indexOf('@') === -1) return null;
    var at = splitOnce(raw, '@');
    var hp = splitHostPort(at[1], 443);
    return {
      type: 'snell', psk: urlDec(at[0]),
      server: hp[0], port: hp[1], remarks: remark || hp[0],
      version: sInt(get(params, 'version', 4)),
      // Snell v6 才有：default / unshaped / unsafe-raw（mihomo 1.19.34 起）
      mode: get(params, 'mode', ''),
      obfs: get(params, 'obfs', ''),
      obfs_host: qget(params, 'host', '')
    };
  }

  function parseHttp(u) {
    u = u.trim();
    var isHttps = u.indexOf('https://') === 0;
    var isHttp = u.indexOf('http://') === 0;
    if (!isHttp && !isHttps) return null;
    var s = splitHashAndQuery(u, isHttps ? 8 : 7);
    var raw = s.raw, remark = s.remark, params = s.params;
    var user = '', password = '', sp;
    if (raw.indexOf('@') !== -1) {
      var at = splitOnce(raw, '@');
      var auth = at[0];
      sp = at[1];
      if (auth.indexOf(':') !== -1) {
        var ap = splitOnce(auth, ':');
        user = ap[0]; password = ap[1];
      } else {
        user = auth; password = '';
      }
    } else {
      user = ''; password = '';
      sp = raw;
    }
    var hp = splitHostPort(sp, isHttps ? 443 : 80);
    return {
      type: 'http', server: hp[0], port: hp[1], remarks: remark || hp[0],
      username: urlDec(user), password: urlDec(password),
      // 不能只认 https:// 前缀：http://user:pass@host:port?tls=true 这种写法
      // 一样是 HTTPS 代理，只按前缀判断会把 TLS 静默丢掉，节点直接连不上。
      tls: isHttps || sBool(get(params, 'tls', '0')),
      sni: qget(params, 'sni', hp[0]),
      skip_cert_verify: sBool(get(params, 'skip-cert-verify', '0')),
      fingerprint: get(params, 'fingerprint', '')
    };
  }

  function parseSocks5(u) {
    u = u.trim();
    if (u.indexOf('socks5://') !== 0) return null;
    var s = splitHashAndQuery(u, 9);
    var raw = s.raw, remark = s.remark, params = s.params;
    var user = '', password = '', sp;
    if (raw.indexOf('@') !== -1) {
      var at = splitOnce(raw, '@');
      var auth = at[0];
      sp = at[1];
      if (auth.indexOf(':') !== -1) {
        var ap = splitOnce(auth, ':');
        user = ap[0]; password = ap[1];
      } else {
        user = auth; password = '';
      }
    } else {
      user = ''; password = '';
      sp = raw;
    }
    var hp = splitHostPort(sp, 1080);
    return {
      type: 'socks5', server: hp[0], port: hp[1], remarks: remark || hp[0],
      username: urlDec(user), password: urlDec(password),
      tls: sBool(get(params, 'tls', '0')),
      skip_cert_verify: sBool(get(params, 'skip-cert-verify', '0')),
      fingerprint: get(params, 'fingerprint', '')
    };
  }

  function parseSsh(u) {
    u = u.trim();
    if (u.indexOf('ssh://') !== 0) return null;
    var raw = u.slice(6);
    var remark = '';
    if (raw.indexOf('#') !== -1) {
      var h = splitOnce(raw, '#');
      raw = h[0];
      remark = urlDec(h[1]);
    }
    if (raw.indexOf('@') === -1) return null;
    var at = splitOnce(raw, '@');
    var auth = at[0];
    var sp = at[1];
    var username, password;
    if (auth.indexOf(':') !== -1) {
      var ap = splitOnce(auth, ':');
      username = ap[0]; password = ap[1];
    } else {
      username = auth; password = '';
    }
    var params = {};
    if (sp.indexOf('?') !== -1) {
      var q = splitOnce(sp, '?');
      sp = q[0];
      params = parseQslDict(q[1]);
    }
    var hp = splitHostPort(sp, 22);
    var info = {
      type: 'ssh', server: hp[0], port: hp[1], remarks: remark || hp[0],
      username: urlDec(username), password: urlDec(password)
    };
    // 私钥认证：mihomo 的 ssh 支持 private-key 与 private-key-passphrase，query 里这两个
    // 字段必须解析，否则用私钥认证的 ssh 节点生成不出可用配置。
    var pkNames = ['private-key', 'private_key', 'privateKey'];
    for (var i = 0; i < pkNames.length; i++) {
      if (get(params, pkNames[i], '')) { info['private-key'] = params[pkNames[i]]; break; }
    }
    var pkpNames = ['private-key-passphrase', 'private_key_passphrase', 'passphrase'];
    for (var j = 0; j < pkpNames.length; j++) {
      if (get(params, pkpNames[j], '')) { info['private-key-passphrase'] = params[pkpNames[j]]; break; }
    }
    return info;
  }

  function parseShadowtls(u) {
    u = u.trim();
    if (u.indexOf('shadowtls://') !== 0) return null;
    var s = splitHashAndQuery(u, 12);
    var raw = s.raw, remark = s.remark, params = s.params;
    if (raw.indexOf('@') === -1) return null;
    var at = splitOnce(raw, '@');
    var hp = splitHostPort(at[1], 443);
    return {
      type: 'shadowtls', password: urlDec(at[0]),
      server: hp[0], port: hp[1], remarks: remark || hp[0],
      version: sInt(get(params, 'version', 2)),
      // shadow-tls 分享链接里 host / sni 两种写法都有人用，都接受
      host: qget(params, 'sni', '') || qget(params, 'host', '') || 'cloud.tencent.com',
      fp: get(params, 'fp', 'chrome')
    };
  }

  /**
   * anytls://password@host:port?sni=..&allowInsecure=1#name
   *
   * 字段直接按 mihomo 原生键名产出（不用别的协议那套 fp / allow_insecure 内部写法），
   * 因为 anytls 没有手写渲染分支，走的是 render_generic 透传。
   */
  function parseAnytls(u) {
    u = u.trim();
    if (u.indexOf('anytls://') !== 0) return null;
    var s = splitHashAndQuery(u, 9);
    var raw = s.raw, remark = s.remark, params = s.params;
    if (raw.indexOf('@') === -1) return null;
    var at = rSplitOnce(raw, '@');
    var password = urlDec(at[0]);
    var hp = splitHostPort(at[1], 443);
    var info = {
      type: 'anytls', password: password,
      server: hp[0], port: hp[1], remarks: remark || hp[0],
      udp: true
    };
    var sni = qget(params, 'sni', '') || get(params, 'peer', '');
    if (sni) info.sni = sni;
    var alpn = get(params, 'alpn', '');
    if (alpn) info.alpn = alpn.split(',').filter(function (x) { return x; });
    var fp = get(params, 'fp', '') || get(params, 'fingerprint', '');
    if (fp) info['client-fingerprint'] = fp;
    if (sBool(get(params, 'allowInsecure', '0')) || sBool(get(params, 'insecure', '0'))) {
      info['skip-cert-verify'] = true;
    }
    return info;
  }

  var PARSERS = [
    ['ss://', parseSs],
    ['ssr://', parseSsr],
    ['trojan://', parseTrojan],
    ['vmess://', parseVmess],
    ['vless://', parseVless],
    ['hysteria2://', parseHysteria2],
    ['hy2://', parseHysteria2],
    ['hysteria://', parseHysteria],
    ['tuic://', parseTuic],
    ['wireguard://', parseWireguard],
    ['snell://', parseSnell],
    ['https://', parseHttp],
    ['http://', parseHttp],
    ['socks5://', parseSocks5],
    ['ssh://', parseSsh],
    ['shadowtls://', parseShadowtls],
    ['anytls://', parseAnytls]
  ];

  function parseProxy(u) {
    u = String(u == null ? '' : u).trim();
    if (!u || u.charAt(0) === '#') return null;
    for (var i = 0; i < PARSERS.length; i++) {
      if (u.indexOf(PARSERS[i][0]) === 0) {
        var r = PARSERS[i][1](u);
        if (r) return r;
      }
    }
    return null;
  }

  /** 地址栏 `#备注` 的解码（解不开就原样用） */
  function decodeFrag(f) {
    if (!f) return '';
    try { return decodeURIComponent(f); } catch (e) { return f; }
  }

  /**
   * 补上用户信息里漏转义的 `#`：有些面板（s-ui 之类）生成链接时不给密码里的特殊字符转义，
   * 而 URL 规则里 `#` 是「备注从这里开始」，`pass#@host:port#备注` 会被切成地址 + 备注、整条报废。
   * 判据：正常链接里 `@` 一定在第一个 `#` 之前；第一个 `#` 前没有 `@` 而后面有，那个 `#` 只可能
   * 是密码的一部分。只动第一个 `#`。
   */
  function fixUnescapedHash(line) {
    // ⚠️ vmess 是整段 base64 + 可选 `#备注`，这里补 %23 只会把它弄坏（parseVmess 自己会切）
    if (/^vmess:\/\//i.test(line)) return line;
    var h = line.indexOf('#');
    if (h === -1) return line;
    if (line.slice(0, h).indexOf('@') !== -1) return line;    // 正常链接，别碰
    if (line.slice(h + 1).indexOf('@') === -1) return line;   // 后面也没有 @，不是这种情况
    return line.slice(0, h) + '%23' + line.slice(h + 1);
  }

  /**
   * 协议必填凭据齐不齐。少了必填字段的节点，mihomo 在创建出站时就会报错、整份配置加载失败
   * （不是只跳过那一个节点）⇒ 一条残链接能把全部节点拖下水，所以这里直接丢掉。
   * 注意：键名两种都认 —— 链接解析器产出的下划线键、Clash YAML 的 kebab 键。
   */
  function credOk(p) {
    var has = function (v) { return truthy(v); };
    var pick = function (a, b) { return has(p[a]) ? p[a] : p[b]; };
    switch (p.type) {
      case 'ss':
      case 'ssr':
        if (String(p.method || p.cipher || '').trim() === 'none') return true;
        return has(p.password) && has(p.method || p.cipher);
      case 'trojan':
      case 'hysteria2':
      case 'shadowtls':
      case 'anytls':
        return has(p.password);
      case 'vmess':
      case 'vless':
        return has(p.uuid);
      case 'hysteria':
        return has(pick('auth_str', 'auth-str') || p.auth);
      case 'tuic':
        // v4 用 token；v5 用 uuid + password（YAML 只写 token = v4）
        if (Number(p.version) === 4 || (has(p.token) && !has(p.uuid))) return has(p.token);
        return has(p.uuid) && has(p.password);
      case 'wireguard':
        return has(pick('private_key', 'private-key')) && has(pick('public_key', 'public-key'));
      case 'snell':
        return has(p.psk);
      case 'ssh':
        return has(p.username);
      default:
        return true;
    }
  }

  /** 上一次 parseAnyInput 补过转义的链接条数（界面提示用）。 */
  var lastHashRepairs = 0;
  function hashRepairs() { return lastHashRepairs; }

  /**
   * 逐行解析节点链接，清洗名称、按凭据去重。去重键不含 name 但含 remarks —— 只用
   * type:server:port 的话，同机器不同凭据的节点会被当成重复静默丢掉。
   */
  function parseNodes(text) {
    var proxies = [], seen = Object.create(null), counter = 1;
    var lines = String(text == null ? '' : text).split(LINE_BREAK);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.charAt(0) === '#') continue;
      if (line.indexOf('://') === -1) continue;
      var fixed = fixUnescapedHash(line);
      if (fixed !== line) lastHashRepairs += 1;
      var info = parseProxy(fixed);
      if (!info) continue;
      // 没有 server 的条目必须丢掉：畸形 vmess（base64 解出来是个空 JSON）
      // 会得到 server=""/port=443，渲染进配置会让 mihomo 直接拒绝加载。
      if (!hostOk(info.server)) continue;
      // 端口越界（vmess 的 JSON 端口不走 splitHostPort，这里统一兜一道）
      if (!(info.port >= 1 && info.port <= 65535)) continue;
      // 缺必填凭据的节点（空 uuid / 空密码 / 没公钥…）会让内核整份配置加载失败
      if (!credOk(info)) continue;
      var key = stableJson(withoutKey(info, 'name'));
      if (seen[key]) continue;
      seen[key] = true;
      info.name = cleanName(info.remarks, pad3(counter));
      proxies.push(info);
      counter += 1;
    }
    return dedupeNames(proxies);
  }

  function withoutKey(obj, key) {
    var out = {};
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      if (k === key) continue;
      out[k] = obj[k];
    }
    return out;
  }

  function pad3(n) {
    var s = String(n);
    while (s.length < 3) s = '0' + s;
    return s;
  }

  // ── 顶层导入入口 ────────────────────────────────────────────
  // 这些出站类型本来就没有 server 字段（组网 / 路由标记类）。
  var NO_SERVER_TYPES = ['tailscale', 'zerotier', 'easytier', 'rematch'];

  // mihomo（v1.19.32 的 adapter/parser.go `switch proxyType`）认的全量出站类型。
  // 注意：不在这张表里的 type 会让整份配置加载失败（不是跳过那个节点）—— 订阅里混进一条
  // `type: hysteria3` 就能把整台机器打瘫，这里直接挡掉。`shadowtls` 不是 mihomo 的 type，
  // 是我们链接解析器自己的中间形态（render.js 会改写成 ss + shadow-tls 插件），所以也放进来；
  // 内核升级后新增类型要同步补这张表。
  var SUPPORTED_TYPES = [
    'ss', 'ssr', 'socks5', 'http', 'vmess', 'vless', 'snell', 'trojan',
    'hysteria', 'hysteria2', 'wireguard', 'tuic', 'shadowquic', 'gost-relay',
    'direct', 'dns', 'reject', 'rematch', 'ssh', 'mieru', 'anytls', 'sudoku',
    'masque', 'trusttunnel', 'openvpn', 'tailscale', 'zerotier', 'easytier',
    'shadowtls'
  ];

  function typeOk(p) {
    return typeof p.type === 'string' && SUPPORTED_TYPES.indexOf(p.type) !== -1;
  }

  var _yamlError = null;
  var _yamlDropped = 0;

  function yamlError() { return _yamlError; }
  /** 因为 `type` 不认识 / 缺失被丢掉的节点数（界面提示用）。 */
  function yamlDropped() { return _yamlDropped; }

  /**
   * Clash YAML 里的 proxy 端口也得过一遍范围校验。
   * ⚠️ 链接那条路（splitHostPort）已经拦了 0 / 65536；YAML 这条路是直接透传的，
   *    不拦的话 `port: 99999` 会原样写进配置，内核按 uint16 解析 ⇒ 整份拒载。
   */
  function yamlPortOk(p) {
    if (NO_SERVER_TYPES.indexOf(p.type) !== -1) return true;
    // hysteria2 可以不写 `port`、只写 `ports: 443-8443`（官方两种写法都认）；
    // 别的类型没 port 就是废节点。
    if (!truthy(p.port)) return p.type === 'hysteria2' && truthy(p.ports);
    if (typeof p.port === 'boolean') return false;
    var n = Number(p.port);
    return isFinite(n) && n >= 1 && n <= 65535 && Math.floor(n) === n;
  }

  /**
   * 一份文本要么是 Clash YAML，要么是纯链接逐行。
   * 不清 `_yamlError` —— 清理动作按顶层调用算（parseAnyInput 最多会调它三次）。
   */
  function parseYamlOrNodes(text) {
    // `.yaml` / `.yml` 之外，界面上还收 `.json` —— Clash 的配置用 JSON 写也是合法 YAML
    // （js-yaml 直接吃），但键名是带引号的 `"proxies":`，上面那条正则匹配不到。
    var looksJson = /^\s*[{\[]/.test(text) && /["']?proxies["']?\s*:/.test(text);
    if ((/^\s*proxies\s*:/m.test(text) || looksJson) && typeof MH.yamlLoad === 'function') {
      var data = null;
      try {
        data = MH.yamlLoad(text);
      } catch (e) {
        _yamlError = String(e && e.message ? e.message : e).replace(/\s+/g, ' ').trim();
        data = null;
      }
      if (data && typeof data === 'object' && Array.isArray(data.proxies)) {
        var proxies = data.proxies.filter(function (p) {
          if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
          // 类型不认识 / 缺失 ⇒ 丢掉（否则整份配置被内核拒载）
          if (!typeOk(p)) { _yamlDropped += 1; return false; }
          return (hostOk(p.server) || NO_SERVER_TYPES.indexOf(p.type) !== -1) &&
            yamlPortOk(p) && credOk(p);
        });
        if (proxies.length) {
          for (var i = 0; i < proxies.length; i++) {
            delete proxies[i].remarks;
            proxies[i].name = cleanName(proxies[i].name, pad3(i + 1));
            // 端口统一成整数：`"443.0"` / `"1e3"` / `"0443"` 这类字符串原样写出去，
            // 内核按 int 解会失败（`0443` 还可能被当成八进制）。
            if (proxies[i].port !== undefined && proxies[i].port !== null && proxies[i].port !== '') {
              proxies[i].port = Math.floor(Number(proxies[i].port));
            }
          }
          return dedupeNames(proxies);
        }
      }
    }
    return parseNodes(text);
  }

  /**
   * 统一导入入口：Clash YAML / base64 订阅 / 纯链接，三种都认。机场订阅十有八九是 base64，
   * 甚至双重编码。
   */
  function parseAnyInput(text) {
    _yamlError = null;
    _yamlDropped = 0;
    lastHashRepairs = 0;
    var got = parseYamlOrNodes(text);
    if (got && got.length) return got;
    if (looksLikeB64(text)) {
      var dec = b64DecodeSafe(text);
      if (dec) {
        got = parseYamlOrNodes(dec);
        if (got && got.length) return got;
        if (looksLikeB64(dec)) {
          var dec2 = b64DecodeSafe(dec);
          if (dec2) return parseYamlOrNodes(dec2);
        }
      }
    }
    return got || [];
  }

  MH.parseAnyInput = parseAnyInput;
  MH.yamlError = yamlError;
  MH.yamlDropped = yamlDropped;
  MH.hashRepairs = hashRepairs;
  MH.cleanName = cleanName;
  MH.hostOk = hostOk;
  MH.cleanSecret = cleanSecret;
  MH.cleanListen = cleanListen;
  MH.dedupeNames = dedupeNames;
  MH.extractDomains = extractDomains;
  MH.splitHostPort = splitHostPort;
  MH.stableJson = stableJson;
})(typeof globalThis !== 'undefined' ? globalThis : this);
