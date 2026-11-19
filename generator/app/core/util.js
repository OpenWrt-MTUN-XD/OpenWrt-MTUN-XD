/*!
 * iStoreOS-Mihomo-config 生成器 — 基础工具
 *
 * 本文件是 Python 版 `Mihomo配置生成器.py` 同名函数的逐行移植：真值判定、URI 解码、
 * base64 宽容度、整数解析这些与 JS 默认行为不同的地方都单独抽成函数并写明差异，
 * 别顺手用 JS 的写法替换。浏览器 <script> 直接加载（零构建），测试里用 eval 注入。
 */
(function (root) {
  'use strict';

  var MH = (root.MH = root.MH || {});

  // ── 真值判定 ────────────────────────────────────────────────
  /**
   * Python 的 `bool(v)`：JS 里 `[]` / `{}` 是 truthy、`NaN` 是 falsy，Python 正好相反；
   * 节点里 alpn 可能是空数组、smux 可能是空对象，直接用 JS 真值会让两边输出不一致。
   */
  function truthy(v) {
    if (v === undefined || v === null || v === false || v === '') return false;
    if (typeof v === 'number') return v !== 0; // NaN → true，对齐 Python
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.keys(v).length > 0;
    return true;
  }

  /** Python 的 `str(v)` —— 只有 yq/_g_scalar 会用，用来保证字面量一致。 */
  function pyStr(v) {
    if (v === null || v === undefined) return 'None';
    if (v === true) return 'True';
    if (v === false) return 'False';
    return String(v);
  }

  // ── 文本编码 ────────────────────────────────────────────────
  var _enc = new TextEncoder();
  var _decStrict = new TextDecoder('utf-8', { fatal: true });
  var _decReplace = new TextDecoder('utf-8');

  function utf8Encode(s) { return _enc.encode(s); }

  /** 严格 UTF-8 解码；非法字节返回 null（对应 Python `.decode('utf-8')` 抛错）。 */
  function utf8DecodeStrict(bytes) {
    try { return _decStrict.decode(bytes); } catch (e) { return null; }
  }

  /** 宽松 UTF-8 解码；非法字节换成 U+FFFD（对应 `.decode('utf-8', 'replace')`）。 */
  function utf8DecodeReplace(bytes) { return _decReplace.decode(bytes); }

  // ── URL 解码 ────────────────────────────────────────────────
  /**
   * Python 的 `urllib.parse.unquote(s)`：畸形转义（`%ZZ`、截断的 UTF-8）不抛异常，而是
   * 原样保留 / 换成 U+FFFD —— 订阅里一个坏字节不能让整份配置生成失败。
   */
  function urlDec(s) {
    s = s == null ? '' : String(s);
    if (s.indexOf('%') === -1) return s;
    var bytes = [];
    for (var i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) === 37 /* % */ && i + 2 < s.length) {
        var hex = s.substr(i + 1, 2);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          bytes.push(parseInt(hex, 16));
          i += 2;
          continue;
        }
      }
      var cp = s.codePointAt(i);
      var chunk = String.fromCodePoint(cp);
      if (cp > 0xffff) i++;
      var enc = utf8Encode(chunk);
      for (var j = 0; j < enc.length; j++) bytes.push(enc[j]);
    }
    return utf8DecodeReplace(new Uint8Array(bytes));
  }

  /**
   * Python 的 `urllib.parse.parse_qsl(qs)` + `dict(...)`。三个必须对齐的点：
   *   1. 没有 `=` 的段、有 `=` 但值为空的段都被丢掉（keep_blank_values 默认 False）；
   *   2. `+` 在 unquote 之前先变成空格；
   *   3. 重复键后者覆盖前者（JS 的 URLSearchParams.get 取第一个）。
   */
  function parseQslDict(qs) {
    var out = {};
    if (qs == null) return out;
    var segs = String(qs).split('&');
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i];
      if (!seg) continue;
      var eq = seg.indexOf('=');
      if (eq === -1) continue;              // 无 '=' → 丢弃
      var value = seg.slice(eq + 1);
      if (!value) continue;                 // 空值 → 丢弃
      var name = urlDec(seg.slice(0, eq).replace(/\+/g, ' '));
      out[name] = urlDec(value.replace(/\+/g, ' '));
    }
    return out;
  }

  // ── base64 ──────────────────────────────────────────────────
  function b64Pad(s) {
    var m = s.length % 4;
    return m ? s + new Array(5 - m).join('=') : s;
  }

  function atobBytes(b64) {
    var bin;
    try { bin = root.atob(b64); } catch (e) { return null; }
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function bytesToB64(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return root.btoa(bin);
  }

  /**
   * REALITY 公钥必须是 base64url 且不带填充 —— mihomo 只认这一种形式（v1.19.32 起标准
   * base64 与带填充的 base64url 都会被拒）。长度对不上就原样返回，硬解再重编码会把
   * 'abc' 静默变成 'ab'。
   */
  function b64urlNopad(s) {
    s = String(s == null ? '' : s).trim();
    if (!s) return s;
    if (s.length !== 43 && s.length !== 44) return s;   // 32 字节 → base64url 43 字符（带填充 44）
    var t = s.replace(/-/g, '+').replace(/_/g, '/');
    var bytes = atobBytes(b64Pad(t));
    if (!bytes || bytes.length !== 32) return s;
    return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /**
   * Python 的 `b64_decode` —— 解码失败（字母表 / 长度 / UTF-8 任一环节）返回 null。对齐点：
   * `-` `_` 先换成 `+` `/`；字母表外的字符直接丢掉（validate=False，混进换行也能解）；
   * 补齐 padding；结果必须是合法 UTF-8，否则返回 null。
   */
  function b64Decode(s) {
    if (s == null) return null;
    var t = String(s).replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
    if (!t) return null;
    var bytes = atobBytes(b64Pad(t));
    if (!bytes) return null;
    return utf8DecodeStrict(bytes);
  }

  /** Python 的 `b64decode_safe` —— 容忍畸形输入，UTF-8 坏字节换成 U+FFFD。 */
  function b64DecodeSafe(s) {
    if (!s) return null;
    var t = String(s).trim();
    t = t.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
    if (!t) return null;
    var bytes = atobBytes(b64Pad(t));
    if (!bytes) return null;
    return utf8DecodeReplace(bytes);
  }

  /**
   * Python 的 `looks_like_b64` —— 整段是否像 base64 订阅；放宽到 `len % 4 !== 1` 即可
   * （`%4==1` 不可能是合法 base64）。
   */
  function looksLikeB64(text) {
    var t = String(text == null ? '' : text).replace(/\s+/g, '');
    if (t.length < 16) return false;
    if (t.length % 4 === 1) return false;
    return /^[A-Za-z0-9+/\-_]+={0,2}$/.test(t);
  }

  // ── 数值 / 布尔解析 ─────────────────────────────────────────
  /** Python 的 `int(s)`，失败返回默认值。 */
  function sInt(s, d) {
    if (typeof s === 'number') return Number.isInteger(s) ? s : (d === undefined ? 0 : d);
    var t = (s == null ? '' : String(s)).trim();
    if (!/^[+-]?[0-9]+$/.test(t)) return d === undefined ? 0 : d;
    var v = parseInt(t, 10);
    return Number.isFinite(v) ? v : (d === undefined ? 0 : d);
  }

  /** Python 的 `s_bool` —— 注意 `True` 直接返回，其余小写后比对。 */
  function sBool(s) {
    if (typeof s === 'boolean') return s;
    return ['1', 'true', 'yes', 'on'].indexOf(String(s).toLowerCase()) !== -1;
  }

  /** Python 的 `classify` —— IP 返回 'ip'，其余非空返回 'domain'。 */
  function classify(v) {
    v = normalizeHost(v);
    if (!v) return '';
    // host:port 不是 IP：不能当 v6 解析，否则会被静默丢（`example.com:8080`）
    if (hasHostPort(v)) return 'domain';
    if (v.indexOf(':') !== -1) return 'ip';
    if (/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(v)) return 'ip';
    // `192.168.1.10-192.168.1.20` 这种网段写法也是 IP（mihomo 没有 IP 段类型，输出时展开成 CIDR）。
    // 每个八位组都要 ≤255 —— `999.1.1.1-999.1.1.9` 是垃圾输入，不能认成 IP。
    var rm = /^(\d{1,3}(?:\.\d{1,3}){3})\s*-\s*(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
    if (rm && ipv4ToInt(rm[1]) != null && ipv4ToInt(rm[2]) != null) return 'ip';
    return 'domain';
  }

  function intToIpv4(n) {
    n = n >>> 0;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  }

  /**
   * `a.b.c.d-e.f.g.h` → 最小 CIDR 列表（mihomo 只有 IP-CIDR / IP-CIDR6，没有 IP 段类型）。
   * 解析不了返回 null；跨度太大（> 512 条）也返回 null，避免一条输入炸出上千行规则。
   */
  function ipRangeToCidrs(v) {
    var m = /^\s*(\d{1,3}(?:\.\d{1,3}){3})\s*-\s*(\d{1,3}(?:\.\d{1,3}){3})\s*$/.exec(String(v == null ? '' : v));
    if (!m) return null;
    var a = ipv4ToInt(m[1]), b = ipv4ToInt(m[2]);
    // ipv4ToInt 非法时返回 null（不是 -1）—— 必须判 null，否则 256/999 会被当成 0
    if (a == null || b == null || a > b) return null;
    var out = [];
    // 标准 range→CIDR：从起始地址按最大对齐块逐块吃掉。
    // ⚠️ 对齐检验必须针对**候选块**（size*2）：先翻倍再检查，失败时 size 已经是 2 倍，
    //    会输出 `100/29` 这种没对齐的 CIDR（漏覆盖 + 越界）。
    var cur = a;
    while (cur <= b) {
      var size = 1;
      while (size < 0x80000000 && (cur & (size * 2 - 1)) === 0 && cur + size * 2 - 1 <= b) size *= 2;
      // size 是块大小；前缀长度 = 32 - log2(size)。
      // ⚠️ 不能用 `t >>= 1` 数位：2^31 是有符号位移的负数，会立刻退出循环，把 /1 写成 /31
      var bits = Math.round(Math.log2(size));
      out.push(intToIpv4(cur) + '/' + (32 - bits));
      if (out.length > 4096) return null;
      cur += size;
    }
    return out;
  }

  // ── IP 字面量 ───────────────────────────────────────────────
  function isIpv4(s) {
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
    if (!m) return false;
    for (var i = 1; i <= 4; i++) {
      var part = m[i];
      if (part.length > 1 && part.charAt(0) === '0') return false; // Python 3.9.5+ 拒绝前导零
      if (parseInt(part, 10) > 255) return false;
    }
    return true;
  }

  /** IPv6 字面量校验（含 `::` 压缩与内嵌 IPv4）。 */
  function isIpv6(s) {
    s = String(s == null ? '' : s);
    if (!s || s.indexOf(':') === -1) return false;
    if (s.indexOf('%') !== -1) return false;           // zone id 不属于 ip_address()
    if (s.indexOf('::') !== s.lastIndexOf('::')) return false;
    var dbl = s.indexOf('::') !== -1;
    var head, tail = '';
    if (dbl) {
      var at = s.indexOf('::');
      head = s.slice(0, at);
      tail = s.slice(at + 2);
    } else {
      head = s;
    }
    function groups(p) { return p === '' ? [] : p.split(':'); }

    function ok(list) {
      for (var i = 0; i < list.length; i++) {
        var g = list[i];
        if (g === '') return false;
        if (g.indexOf('.') !== -1) {
          if (i !== list.length - 1) return false;      // 内嵌 v4 只能在末尾
          if (!isIpv4(g)) return false;
        } else if (!/^[0-9A-Fa-f]{1,4}$/.test(g)) {
          return false;
        }
      }
      return true;
    }

    var h = groups(head);
    var t = groups(tail);
    if (!ok(h)) return false;
    if (dbl && !ok(t)) return false;
    var v4InHead = h.length > 0 && h[h.length - 1].indexOf('.') !== -1;
    if (v4InHead && dbl && t.length > 0) return false;  // v4 必须是整个地址的末尾
    var v4 = v4InHead || (t.length > 0 && t[t.length - 1].indexOf('.') !== -1);
    var count = h.length + t.length + (v4 ? 1 : 0);     // 内嵌 v4 记两段
    if (dbl) return count <= 7;
    return count === 8;
  }

  /** Python 的 `ipaddress.ip_address()` 可用性判断（返回 bool）。 */
  function isIp(s) {
    s = String(s == null ? '' : s);
    if (isIpv4(s)) return true;
    return isIpv6(s);
  }

  /** int → 点分十进制（Python 的 `str(ipaddress.ip_address(int))`）。 */
  function ipText(n) {
    n = n >>> 0;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  }

  /** 'a.b.c.d' → 32 位无符号整数；非法（含前导零 / 越界）返回 null。 */
  function ipv4ToInt(s) {
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s));
    if (!m) return null;
    var out = 0;
    for (var i = 1; i <= 4; i++) {
      var part = m[i];
      if (part.length > 1 && part.charAt(0) === '0') return null;
      var v = parseInt(part, 10);
      if (v > 255) return null;
      out = out * 256 + v;
    }
    return out >>> 0;
  }

  /**
   * 随机生成一串面板密码 —— 界面上那个「随机」按钮用的。
   *
   * 注意：用 `crypto.getRandomValues`，http 下也能用（路由器上就是 http + 内网 IP，只有
   * `crypto.subtle` 要求安全上下文）；字符集只用 `[A-Za-z0-9]`，这个值要穿过 YAML、
   * Authorization 头、CGI 的 sed 和面板 localStorage，字母数字在哪儿都不会被吃掉。
   * 注意：无偏取样 —— 256 不是 62 的整数倍，直接 `% 62` 会让前几位偏多，所以丢掉 ≥248 的字节。
   */
  function randomSecret(n) {
    var abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var len = sInt(n, 16);
    if (len < 1) len = 16;
    var out = '';
    var c = root.crypto;
    if (c && c.getRandomValues) {
      var buf = new Uint8Array(len * 2 + 8);
      while (out.length < len) {
        c.getRandomValues(buf);
        for (var i = 0; i < buf.length && out.length < len; i++) {
          if (buf[i] < 248) out += abc.charAt(buf[i] % 62);
        }
      }
      return out;
    }
    // 兜底：没有 crypto（很老的浏览器）也别给个空串
    while (out.length < len) out += abc.charAt(Math.floor(Math.random() * 62));
    return out;
  }

  /**
   * 数一份生成的配置里 `proxies:` 段写入了多少个节点（界面第 3 步显示用）。
   * 只认块写法：顶格 `proxies:` 到下一个顶格 key 之间、`  - name: ` 开头的行。
   * ⚠️ 引擎必须保持这个块写法；tests/unit/build.test.mjs 用真实产物钉住了这点。
   */
  function countProxies(text) {
    var s2 = '\n' + String(text == null ? '' : text);
    var head = '\nproxies:\n';
    var at = s2.indexOf(head);
    if (at === -1) return 0;
    var rest = s2.slice(at + head.length);
    var end = rest.search(/\n[a-z][a-z-]*:/);
    var body = '\n' + (end === -1 ? rest : rest.slice(0, end));
    var n = 0;
    var re = /\n {2}- name: /g;
    while (re.exec(body)) n++;
    return n;
  }

  MH.countProxies = countProxies;
  MH.truthy = truthy;
  MH.pyStr = pyStr;
  MH.urlDec = urlDec;
  MH.parseQslDict = parseQslDict;
  MH.b64urlNopad = b64urlNopad;
  MH.b64Decode = b64Decode;
  MH.b64DecodeSafe = b64DecodeSafe;
  MH.looksLikeB64 = looksLikeB64;
  MH.sInt = sInt;
  MH.sBool = sBool;
  /**
   * 这个地址/CIDR 是不是内网（或本机/链路本地）：
   *   IPv4：10/8、172.16/12、192.168/16、127/8、169.254/16、100.64/10
   *   IPv6：fc00::/7、fe80::/10、::1/128
   * 内网地址在自定义规则里按**来源**匹配（SRC-IP-CIDR），公网按目标匹配（IP-CIDR）。
   */
  function isPrivateCidr(c) {
    var t = String(c == null ? '' : c).trim();
    if (!t) return false;
    if (t.indexOf(':') !== -1) {
      var v6p = t.split('/');
      if (v6p.length > 2) return false;
      var v6 = v6p[0].replace(/^\[|\]$/g, '').toLowerCase();
      if (!isIpv6(v6)) return false;                       // 先验整体合法，别把 fd00::10-fd00::20 当内网
      if (v6p.length === 2 && (!/^[0-9]+$/.test(v6p[1]) || parseInt(v6p[1], 10) > 128)) return false;
      if (v6 === '::1') return true;
      // IPv6 省略前导零：fc::1 展开是 0x00fc::1（全球单播），不是 ULA。必须按数值判首个 16 位组，
      // 不能用前缀正则（那会把 fc:: / fc0:: / fcd:: / fe8:: 都当成内网）。
      var first = v6.indexOf('::') === 0 ? 0 : parseInt(v6.split(':')[0] || '0', 16);
      if ((first & 0xfe00) === 0xfc00) return true;   // fc00::/7  (fc00–fdff)
      if ((first & 0xffc0) === 0xfe80) return true;   // fe80::/10 (fe80–febf)
      return false;
    }
    var m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}(?:\/(\d{1,2}))?$/.exec(t);
    if (!m) return false;
    var a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    var mask = m[3] === undefined ? 32 : parseInt(m[3], 10);
    // 只按前缀落在内网段里就算内网（10/8 等），不看具体的 /32
    var first = (a << 24 | b << 16) >>> 0;
    var inBlocks = [
      [0x0A000000, 8], [0xAC100000, 12], [0xC0A80000, 16],
      [0x7F000000, 8], [0xA9FE0000, 16], [0x64400000, 10],
    ];
    for (var i = 0; i < inBlocks.length; i++) {
      var base = inBlocks[i][0], bits = inBlocks[i][1];
      var blockMask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
      if (((first & blockMask) >>> 0) === base && mask >= bits) return true;
    }
    return false;
  }

  MH.classify = classify;
  MH.isPrivateCidr = isPrivateCidr;

  /** 目标（单 IP / CIDR / `a-b` 段）是否整体属于内网。段里只要有一段是公网就算公网。 */
  function isPrivateTarget(t) {
    var v = String(t == null ? '' : t).trim();
    if (!v) return false;
    var cidrs = ipRangeToCidrs(v);
    if (cidrs) {
      for (var i = 0; i < cidrs.length; i++) if (!isPrivateCidr(cidrs[i])) return false;
      return true;
    }
    return isPrivateCidr(v);
  }
  MH.isPrivateTarget = isPrivateTarget;

  /**
   * 地址规范化：`[v6]`、`[v6]/128`、`[v6]:8080`、`[v4]` 里的方括号一律去掉，
   * 返回 `host` / `host/mask` / `host:port` 的裸串。所有校验与渲染都先过这里，
   * 免得各写一份 replace 而漏掉「括号 + 掩码」这种形态（I-1 就是这么炸的）。
   */
  function normalizeHost(t) {
    var s2 = String(t == null ? '' : t).trim();
    if (s2.charAt(0) === '[') {
      var close = s2.indexOf(']');
      if (close > 0) return s2.slice(1, close) + s2.slice(close + 1);
    }
    return s2;
  }
  MH.normalizeHost = normalizeHost;

  /** 带端口的写法（`1.2.3.4:8080` / `[fd00::1]:8080`）—— 规则目标不接受端口。 */
  function hasHostPort(t) {
    var raw = String(t == null ? '' : t).trim();
    if (/^\[[^\]]+\]:\d+$/.test(raw)) return true;                  // [v6]:port
    if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(raw)) return true;      // v4:port
    // 单冒号 + 数字结尾 + 冒号前没有冒号 → 域名/主机名:port（`example.com:8080`）
    if (/^[^\s:\[\]]+:\d+$/.test(raw) && raw.indexOf('::') === -1) return true;
    // 裸 IPv6 不是端口：`fd00::2:1`、`fe80::1:2` 都是合法地址，不能当 `host:port`
    return false;
  }
  MH.hasHostPort = hasHostPort;

  /** 合法 CIDR（v4 / v6，可省掩码）：地址与掩码范围都要对。 */
  function isValidCidr(t) {
    if (hasHostPort(t)) return false;
    var parts = normalizeHost(t).split('/');
    if (parts.length > 2) return false;
    var a = parts[0].trim().replace(/^\[|\]$/g, '');
    var v4 = ipv4ToInt(a) !== null;
    var v6 = !v4 && isIpv6(a);
    if (!v4 && !v6) return false;
    if (parts.length === 2) {
      if (!/^[0-9]+$/.test(parts[1])) return false;
      if (parseInt(parts[1], 10) > (v4 ? 32 : 128)) return false;
    }
    return true;
  }
  MH.isValidCidr = isValidCidr;

  /**
   * 域名目标合法性：逗号 / 空格 / 斜杠 / 冒号这些会让规则行多出一列或被截断（整份配置被内核拒载）。
   * 单标签主机名（`router`）允许；每段 1–63、总长 ≤253、首尾不能是 `-`。
   */
  function isValidDomain(d) {
    var s2 = String(d == null ? '' : d).trim();
    if (!s2 || s2.length > 253) return false;
    if (/[\s,\/:;#"'\\?&=%@<>|*]/.test(s2)) return false;
    if (s2.charAt(0) === '.' || s2.charAt(s2.length - 1) === '.') return false;
    if (s2.charAt(0) === '-') return false;
    var labels = s2.split('.');
    for (var i = 0; i < labels.length; i++) {
      var L = labels[i];
      if (!L || L.length > 63) return false;
      if (L.charAt(0) === '-' || L.charAt(L.length - 1) === '-') return false;
    }
    return true;
  }
  MH.isValidDomain = isValidDomain;

  /** 目标是不是 IPv6（用于「内网控制只吃 IPv4」这条界限）。 */
  function isV6Target(t) {
    var v = String(t == null ? '' : t).trim().replace(/^\[|\]$/g, '');
    if (!v) return false;
    if (v.indexOf(':') === -1) return false;
    if (v.indexOf('-') !== -1) return false;   // IP 段单独由 ipRangeToCidrs 判
    return isValidCidr(v);
  }
  MH.isV6Target = isV6Target;

  /** 看着像 IP / CIDR，但按 mihomo 的语法不合法（缺段、带端口、掩码越界、带 '-' 的 v6 段…）。 */
  function looksLikeBadIp(t) {
    var s2 = normalizeHost(t);
    if (!s2) return false;
    if (hasHostPort(t)) return true;
    if (s2.indexOf('-') !== -1) return false;          // IP 段由 ipRangeToCidrs 单独判
    if (/^\d{1,3}(?:\.\d{1,3}){1,3}$/.test(s2)) return classify(s2) !== 'ip';
    if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(s2)) return true;   // 带端口的 IP
    if (/^[0-9a-fA-F:.\/]+$/.test(s2) && (s2.indexOf('/') !== -1 || s2.indexOf(':') !== -1)) {
      if (classify(s2) !== 'ip') return true;
      return !isValidCidr(s2);
    }
    return false;
  }
  MH.looksLikeBadIp = looksLikeBadIp;
  MH.ipRangeToCidrs = ipRangeToCidrs;
  MH.isIp = isIp;
  MH.isIpv6 = isIpv6;
  MH.ipText = ipText;
  MH.ipv4ToInt = ipv4ToInt;
  MH.randomSecret = randomSecret;
})(typeof globalThis !== 'undefined' ? globalThis : this);
