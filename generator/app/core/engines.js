/*!
 * iStoreOS-Mihomo-config 生成器 — 配置引擎
 *
 *   SplitEngine  精准分流（按 GEOIP / GEOSITE 分流；含回国模式与全局代理）
 *   OneIPEngine  一机一IP（按 SRC-IP-CIDR 分流，支持回国 / TG / AnyDesk 直连）
 *
 * 移植自 Python 版的同名类。两个引擎共用同一份骨架（`_skeleton`）与同一个节点渲染器，
 * 所以同一批节点在三种模式里输出的文本逐字一致 —— 别为了「某个模式少写一行」去分叉骨架。
 */
(function (root) {
  'use strict';

  var MH = (root.MH = root.MH || {});
  var yq = MH.yq;
  var extractDomains = MH.extractDomains;
  var ipText = MH.ipText;
  var ipv4ToInt = MH.ipv4ToInt;
  var isIpv6 = MH.isIpv6;

  var DEFAULT_SECRET = '123456';

  /**
   * 面板监听地址的出厂值：`127.0.0.1` 最保守（只有本机进得来）。不预置任何私网地址 ——
   * 每家网关网段都不一样，写死对别人就是错的；想内网进面板填自己的网关，想全开填 0.0.0.0
   * （那会把 external-controller 同时挂在 docker0 和 WAN IP 上）。
   */
  var DEFAULT_LISTEN = '127.0.0.1';

  /**
   * DNS 模式的出厂值：`false` = fake-ip（默认），`true` = redir-host。
   *
   * 选 fake-ip 当默认：官方 wiki 和仓库示例给的都是它，TUN + 全流量接管下更快、分流判定也更准
   * （域名一定拿得到，不靠嗅探猜）。redir-host 更宽容（绕开 mihomo 的流量也能通），代价是判定
   * 准确度变成概率问题，所以只当界面可选项。
   */
  var DEFAULT_REDIR_HOST = false;

  // fake-ip-filter 两套名单：
  //   FULL     —— 软路由 / 精准分流用：把 STUN、米家这些会自己解析本地地址的服务排除掉。
  //   MAINLAND —— 「国内使用国内节点」用（原单机国内版），只留系统级的几条。
  var FAKE_IP_FILTER_FULL = [
    '+.lan', '+.test', '+.local', '+.ts.net', '+.nip.io', '+.ntp.org',
    '+.invalid', '+.oray.com', '+.internal', '+.miui.com', '+.sslip.io',
    '+.stun.*.*', '+.home.arpa', '+.ntp.*.com', '+.localhost', '+.inband.com',
    '+.xiaomi.com', '+.miwifi.com', '+.time.*.com', '+.time.*.gov',
    '+.stun.*.*.*', '+.ntsc.ac.cn', '+.ntp.org.cn', '+.localdomain',
    '+.mijia.cloud', 'time.*.edu.cn', '+.time.edu.cn', '+.orayimg.com',
    '+.stun.*.*.*.*', '+.l.google.com', '+.msftncsi.com', '+.ot.io.mi.com',
    '+.api.io.mi.com', '+.push.apple.com', 'captive.apple.com',
    '+.3gppnetwork.org', 'time-ios.apple.com', 'time-macos.apple.com',
    '+.dyn.blackberry.net', '+.turn.cloudflare.com', '+.msftconnecttest.com',
    '+.services.mozilla.com', '+.openrelay.metered.ca',
    'connectivitycheck.gstatic.com', 'connectivitycheck.platform.hicloud.com'
  ];
  var FAKE_IP_FILTER_MAINLAND = [
    '+.lan', '+.local', '+.home.arpa', '+.ntp.org',
    '+.msftncsi.com', '+.time.windows.com', '+.msftconnecttest.com'
  ];

  // 代理组健康检查地址，按出口位置二选一：
  //   出国（普通分流 / 全局代理）→ INTERL：内核与面板的默认值，海外节点就近命中 Google 边缘。
  //   回国 / 国内使用国内节点 → CN：检查点在国内，延迟低。
  // 注意：两个都必须是 https + 204 + HEAD + 不跳转（内核用 HEAD 查、严格比对 expected-status，
  // 开了 unified-delay 还会再发一次 HEAD）；别拿国内地址给海外节点用，也别拿 gstatic 给国内出口用。
  var HEALTH_URL_INTL = 'https://www.gstatic.com/generate_204';
  var HEALTH_URL_CN = 'https://connectivitycheck.platform.hicloud.com/generate_204';

  // 内网 直连 / 内网 域名 两段在所有分流规则里都是同一份，抽出来避免抄错。
  // 注意：`no-resolve` 不能省 —— mihomo 的 GEOIP 规则没写它会先 `helper.ResolveIP()` 解析一次
  // 再匹配（见 rules/common/geoip.go），而这是整份规则的第一条，不加等于每个域名连接都要先解析；
  // 官方「快捷配置」示例也是 `GEOIP,lan,直连,no-resolve`。漏了不丢功能：后面的 GEOSITE,private 兜着。
  var LAN_DIRECT = ['  # 内网 直连', '  - GEOIP,LAN,DIRECT,no-resolve'];
  var LAN_DOMAINS = ['  # 内网 域名', '  - GEOSITE,private,DIRECT'];
  var NTP_DIRECT = ['  # NTP 直连', '  - DST-PORT,123,DIRECT'];

  /**
   * 「广告拦截」勾选框 → 订阅 217heidai/adblockfilters 的合并清单（24 万条，8 小时一更）。
   * 注意：必须用 mrs 不用它的 yaml —— yaml 有 7 MB，mihomo 拉取 15 秒超时，会一直
   * `context deadline exceeded`、永远用旧缓存；mrs 只有 2.2 MB。
   * 注意：不用 HaGeZi（只有 `*.foo` wildcard，内核的 `*` 只匹配一层子域）、不用 Loyalsoldier
   * （覆盖少 5 万条、日更）；走 fastly 不走 cdn（有的固件上 cdn.jsdelivr.net 拉取直接 EOF）。
   */
  var ADBLOCK_PROVIDER = {
    name: 'adblock',
    url: 'https://fastly.jsdelivr.net/gh/217heidai/adblockfilters@main/rules/adblockmihomo.mrs',
    path: './rules/adblock.mrs',
    format: 'mrs',
    interval: 28800
  };
  var ADBLOCK_RULE = ['  # 广告 拦截', '  - RULE-SET,' + ADBLOCK_PROVIDER.name + ',REJECT'];

  /**
   * 单条规则。第二个参数是目标出口：某个节点名，或 'DIRECT'；不传就是 DIRECT。
   */
  /** IP / CIDR 合法性（非法条目直接丢，别让内核因为一行废规则整份拒载）。 */
  /** 合法 CIDR 判定 —— 实现只有一份，在 core/util.js（MH.isValidCidr）。 */
  function validIp(ip) {
    return MH.isValidCidr(ip);
  }

  function ipRule(ip, action) {
    ip = MH.normalizeHost(ip);
    if (!ip) return null;
    if (!validIp(ip)) return null;
    var to = action || 'DIRECT';
    if (ip.indexOf(':') !== -1) {
      if (ip.indexOf('/') === -1) ip += '/128';
      return '  - IP-CIDR6,' + ip + ',' + to + ',no-resolve';
    }
    if (ip.indexOf('/') === -1) ip += '/32';
    return '  - IP-CIDR,' + ip + ',' + to + ',no-resolve';
  }

  /**
   * 一段目标 → 若干行规则。IP 段（`a.b.c.d-e.f.g.h`）要展开成多条 IP-CIDR —— mihomo 没有
   * IP 段类型，直接写 DOMAIN 会变成一条永远匹配不上的死规则（就是那个 bug）。
   */
  function ruleLines(t, action) {
    var out = [];
    if (MH.hasHostPort(t)) return out;   // 规则目标不接受端口（界面会提示，这里兜底）
    var cidrs = MH.ipRangeToCidrs(t);
    if (cidrs) {
      for (var i = 0; i < cidrs.length; i++) {
        var l = scopedIpRule(cidrs[i], action);
        if (l) out.push(l);
      }
      return out;
    }
    var one = MH.classify(t) === 'ip' ? scopedIpRule(t, action) : domainRule(t, action);
    return one ? [one] : [];
  }

  /**
   * IP 规则按「内网还是公网」自动选匹配方向：
   *   · 内网地址（10/8、172.16/12、192.168/16、127/8、169.254/16、100.64/10、fc00::/7…）
   *     → `SRC-IP-CIDR`，按**来源**匹配，即「局域网里这台设备怎么走」；
   *   · 公网地址 → `IP-CIDR` / `IP-CIDR6`，按目标匹配。
   * 内核实测：`SRC-IP-CIDR` 同时接受 IPv4 / IPv6；`SRC-IP-CIDR6` 不存在（unsupported rule type）。
   */
  function scopedIpRule(ip, action) {
    var t = MH.normalizeHost(ip);
    var to = action || 'DIRECT';
    if (MH.isPrivateCidr(t)) {
      // 私网分支同样要校验：`fd00::1/129`、`192.168.1.1/33`、带 '-' 的 v6 段都是
      // 畸形输入，直接拼进 SRC-IP-CIDR 会让内核整份拒载（payloadRule error）。
      if (!validIp(t)) return null;
      var v = t;
      if (v.indexOf('/') === -1) v += v.indexOf(':') !== -1 ? '/128' : '/32';
      return '  - SRC-IP-CIDR,' + v + ',' + to + ',no-resolve';
    }
    return ipRule(t, action);
  }

  /** 按**目标**匹配的 IP 规则（直连 IP 块用）：IP 段展开成多条 IP-CIDR / IP-CIDR6。 */
  function destRuleLines(t, action) {
    var out = [];
    if (MH.hasHostPort(t)) return out;
    var cidrs = MH.ipRangeToCidrs(t);
    if (cidrs) {
      for (var i = 0; i < cidrs.length; i++) {
        var l = ipRule(cidrs[i], action);
        if (l) out.push(l);
      }
      return out;
    }
    if (MH.classify(t) !== 'ip') return [domainRule(t, action)].filter(Boolean);
    var one = ipRule(t, action);
    return one ? [one] : [];
  }

  function domainRule(d, action) {
    // 必须在这里归一：校验（isValidDomain）会去尾点，输出也得用同一份值，
    // 否则 `example.com.` 会通过校验却写出带尾点的 DOMAIN（永不匹配）。
    d = MH.normalizeHost(d).replace(/^\.+/, '');
    if (!d) return null;
    // 含逗号/空格/斜杠的「域名」会让规则行多一列 → 内核整份拒载（`proxy [y.com] not found`）
    if (!MH.isValidDomain(d)) return null;
    return '  - DOMAIN,' + d + ',' + (action || 'DIRECT');
  }

  /**
   * 用户自己加的「自定义规则」：每条 `{ target, action }`，target 是域名或 IP、action 是节点名
   * 或 'DIRECT'。输出成一块放在规则段最前面（位置就是优先级）；具体那行交给 `ipRule` /
   * `domainRule`，no-resolve 与判 IP/域名的规则跟直连那边完全一致。一条都没有时返回 null。
   */
  function customRuleBlock(rules) {
    if (!rules || !rules.length) return null;
    // 「常用 → TK / TC / AI / NF」各自单独成段，其余还是 `# 定义 规则`。
    var normal = [], ai = [], tk = [], tencent = [], nf = [];
    var seen = Object.create(null);
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (!r || typeof r !== 'object') continue;
      var target = String(r.target == null ? '' : r.target).trim();
      var action = String(r.action == null ? '' : r.action).trim();
      if (!target || !action) continue;
      var lines;
      if (r.type === 'geosite') {
        // 目标是一个 GeoSite 分类（如 category-ai-!cn / tiktok）
        lines = ['  - GEOSITE,' + target + ',' + action];
      } else if (r.type === 'geoip') {
        // 目标是一个 GeoIP 标签（如 netflix / cloudflare）
        lines = ['  - GEOIP,' + target + ',' + action];
      } else {
        lines = ruleLines(target, action);
      }
      if (!lines || !lines.length) continue;
      var isAi = r.preset === 'ai' || (r.type === 'geosite' &&
        (target === 'category-ai-!cn' || target === 'category-ai-cn'));
      var isTk = r.preset === 'tk' || (r.type === 'geosite' && target === 'tiktok');
      var isTc = r.preset === 'tencent' || (r.type === 'geosite' && target === 'tencent');
      var isNf = r.preset === 'nf' ||
        ((r.type === 'geosite' || r.type === 'geoip') && target === 'netflix');
      for (var li = 0; li < lines.length; li++) {
        var line = lines[li];
        if (!line || seen[line]) continue;
        seen[line] = 1;
        if (isAi) ai.push(line);
        else if (isTk) tk.push(line);
        else if (isTc) tencent.push(line);
        else if (isNf) nf.push(line);
        else normal.push(line);
      }
    }
    if (!normal.length && !ai.length && !tk.length && !tencent.length && !nf.length) return null;
    var b = [];
    if (normal.length) {
      b.push('  # 定义 规则');
      b.push.apply(b, normal);
    }
    if (tk.length) {
      // 用户自己的规则排前面：同一个域名两边都命中时，先写的赢
      if (b.length) b.push('');
      b.push('  # Tik Tok');
      b.push.apply(b, tk);
    }
    if (tencent.length) {
      if (b.length) b.push('');
      b.push('  # TC 服务');
      b.push.apply(b, tencent);
    }
    if (nf.length) {
      if (b.length) b.push('');
      b.push('  # Net Flix');
      b.push.apply(b, nf);
    }
    if (ai.length) {
      if (b.length) b.push('');
      b.push('  # AI 服务');
      b.push.apply(b, ai);
    }
    return b;
  }

  /**
   * 直连 IP / 直连域名两块，有内容才出。分流共用 —— 自定义规则里动作选「直连」的条目落在这些块里。
   */
  function directBlocks(ips, domains) {
    var out = [];
    var i, r;
    if (ips && ips.length) {
      var b = ['  # 直连 IP'];
      var seenIp = Object.create(null);
      for (i = 0; i < ips.length; i++) {
        var lines = destRuleLines(ips[i], 'DIRECT');
        for (var li = 0; li < lines.length; li++) {
          if (lines[li] && !seenIp[lines[li]]) { seenIp[lines[li]] = 1; b.push(lines[li]); }
        }
      }
      if (b.length > 1) out.push(b);
    }
    if (domains && domains.length) {
      var b2 = ['  # 直连 域名'];
      var seenD = Object.create(null);
      for (i = 0; i < domains.length; i++) {
        r = domainRule(domains[i]);
        if (r && !seenD[r]) { seenD[r] = 1; b2.push(r); }
      }
      if (b2.length > 1) out.push(b2);
    }
    return out;
  }

  /**
   * 用户输入的列表项（DNS 各组 / 劫持 / skip-domain 等）—— 写进 YAML 前做安全化。
   * 注意：裸拼 `- <值>` 的话，一行 `foo: bar` 会被解析成 map、`[x]` 会被解析成 seq ⇒ mihomo 的
   * []string 反序列化失败、整份配置拒载。只有确实会被误读时才加引号，普通值保持裸写。
   */
  function listScalar(v) {
    var s = String(v == null ? '' : v);
    // 已经是带引号的形态（quotePorts 给端口区间加的那对）就别重复加引号
    if (s.length > 1 && s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') return s;
    if (!s) return '""';
    if (/^[\s\[\]{}&*#!|>'"%@`?,]/.test(s) || /:\s/.test(s) || /:$/.test(s) || /\s#/.test(s)) {
      return yq(s);
    }
    return s;
  }

  /** 监听地址：IPv6 字面量要加方括号（`::1` → `[::1]`），否则 `::1:9090` 是非法地址。 */
  function listenHost(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return DEFAULT_LISTEN;
    if (s.indexOf(':') !== -1 && s.charAt(0) !== '[') return '[' + s + ']';
    return s;
  }

  /**
   * 写进 YAML 的地址：以 `[` 开头的必须加引号 —— `external-controller: [::1]:9090` 在 YAML 里
   * 会被当成 flow sequence 的开头，整份解析失败；`#` 同理（会被当注释）。普通地址保持裸写。
   */
  function yamlAddr(s) {
    s = String(s == null ? '' : s);
    return (s.charAt(0) === '[' || s.indexOf('#') !== -1) ? yq(s) : s;
  }

  /**
   * DNS 监听地址：`host:port` 形态，host 是 IPv6 字面量时必须加方括号（`::1:1053` 是非法地址）。
   * 没写端口时整串当主机（照 listenHost 处理）。
   */
  function dnsAddr(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return yamlAddr(DNS_DEFAULTS.listen);
    // 带方括号但没有端口：`[::1]` 不是合法 listen 值
    if (s.charAt(0) === '[') {
      if (!/^\[[^\]]+\]:[0-9]+$/.test(s)) {
        throw new Error('DNS 监听地址必须带端口，例如 [::1]:1053');
      }
      return yamlAddr(s);
    }
    var at = s.lastIndexOf(':');
    if (at === -1) throw new Error('DNS 监听地址必须带端口，例如 127.0.0.1:1053');
    var host = s.slice(0, at), port = s.slice(at + 1);
    // ⚠️ 裸 IPv6（`::1`、`2001:db8::1`）和「IPv6+端口」在字面上分不开：末段是数字就会被当端口，
    //    产出 `[:]:1` 这种非法地址。这里要求 IPv6 必须显式写成 `[::1]:1053`，否则直接报错。
    if (looksLikeBareIPv6(s)) {
      throw new Error('DNS 监听地址里的 IPv6 必须带端口和方括号，例如 [::1]:1053');
    }
    if (!/^[0-9]+$/.test(port)) {
      throw new Error('DNS 监听地址必须带端口，例如 127.0.0.1:1053');
    }
    return yamlAddr(listenHost(host) + ':' + port);
  }

  /** 整串本身就是合法 IPv6（多段冒号、无方括号）—— 这种输入没法再拆出端口。 */
  function looksLikeBareIPv6(s) {
    if (s.charAt(0) === '[' || s.indexOf(':') === -1) return false;
    if (/^[0-9.]+:[0-9]+$/.test(s)) return false;       // IPv4:port
    return /^[0-9A-Fa-f:.]+$/.test(s) && (s.match(/:/g) || []).length >= 2;
  }

  function joinBlocks(blocks) {
    var L = ['rules:'];
    for (var i = 0; i < blocks.length; i++) {
      if (i > 0) L.push('');
      L.push.apply(L, blocks[i]);
    }
    return L;
  }

  /**
   * 列表类参数的取值：用户填了就用用户的，空 / 没填就回退出厂值。
   * 注意：空列表必须回退 —— 直接输出「组名后面一个子项都没有」会被解析成 null，内核拒载整份配置。
   */
  function listOr(value, fallback) {
    return (value && value.length) ? value : fallback;
  }

  /**
   * DNS 的出厂值。构造函数的默认值、骨架里「用户没填就回退」用的都是这一份（两处各写一遍迟早
   * 改漏一边）。取用时一律 .slice()，免得实例和常量共享引用、被 push 污染所有人的出厂值。
   */
  var DNS_DEFAULTS = {
    listen: '127.0.0.1:1053',
    defaultNs: ['223.5.5.5', '119.29.29.29'],
    nameserver: ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query'],
    proxyNs: ['223.5.5.5', 'https://doh.pub/dns-query'],
    directNs: ['223.5.5.5', '119.29.29.29'],
    policyCn: ['https://223.5.5.5/dns-query', 'https://dns.alidns.com/dns-query'],
    policyGeo: ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query']
  };

  /** sniffer 的出厂值（同 DNS_DEFAULTS，取用时 .slice()）。 */
  var SNIFFER_DEFAULTS = {
    http: ['80', '8080-8880'],
    tls: ['443', '8443'],
    quic: ['443', '8443'],
    skip: ['miui.com', 'xiaomi.com', 'mijia.cloud', 'ot.io.mi.com', 'api.io.mi.com']
  };

  /**
   * 端口列表：含 `-` 的区间写法（如 8080-8880）要加双引号，单个端口裸写 —— 全加或全不加都会
   * 让 golden 用例立刻红。
   */
  function quotePorts(value, fallback) {
    var items = listOr(value, fallback);
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var p = String(items[i]).trim();
      out.push(p.indexOf('-') !== -1 ? '"' + p + '"' : p);
    }
    return out;
  }

  // ══ 精准分流（含「全局代理」勾选框）═══════════════════════════
  function SplitEngine() {
    this.proxies = [];
    this.secret = DEFAULT_SECRET;
    this.port = 9090;
    this.return_mode = false;
    this.default_node = '';
    this.custom_rules = [];
    this.stack = 'mixed';
    this.direct_domains = [];
    this.direct_ips = [];
    this.webrtc_protect = true;
    // 广告拦截（引擎与界面出厂默认都是关；勾选后由 ui.js 显式赋 true 才会输出 provider 与规则）
    this.ad_block = false;
    this.ipv6_enabled = true;
    // 仅 ipv6_enabled 时由 ui.js 赋值；true 才输出 tun.inet6-address 并接管 IPv6。
    this.ipv6_via_node = false;
    this.global_mode = false;
    // 本地出口：非空时国内流量（GEOSITE,cn / GEOIP,CN）走这个节点；空 = 直连
    this.local_exit = '';
    this.auto_select = false;
    // 「智能选择」fallback 组要排除的节点名（界面上勾掉的）；默认空数组 = 全部进组，输出逐字不变。
    this.auto_select_exclude = [];
    // 自定义规则的多节点出口 → 额外的负载均衡组：[{name, proxies:[节点名...]}]；默认空 = 不输出。
    this.custom_groups = [];
    // true = 所有节点都算被引用（一机一IP 用）；精准分流只写真正引用到的节点
    this.all_proxies_used = false;
    this.controller_listen = DEFAULT_LISTEN;
    this.mainland = false;
    this.redir_host = DEFAULT_REDIR_HOST;
    // 用到 IP-ASN 规则时置 true → geox-url 里多写一条 asn（没有 ASN.mmdb 时内核会去下）
    this.need_asn = false;

    // ── 进阶参数 ──
    // 下面这些默认值逐字等于 _skeleton 里写死的字面值，它们就是「出厂配置」，golden 测试
    // 钉的正是这套默认值 —— 动一个字节 tests/unit/engines.test.mjs 立刻红。界面改的是实例属性。
    this.log_level = 'info';
    this.unified_delay = true;
    this.tcp_concurrent = true;
    // 「智能选择」组的调度策略：false = consistent-hashing（默认，同站固定出口），true = round-robin
    // （按连接轮流）。只在成员同 IP 出口时才有意义；只管这个组，负载均衡组各自独立。
    this.auto_group_round_robin = false;
    // generate() 每次重建：旧组名 → 输出组名
    this._group_name_map = Object.create(null);
    // 自定义规则生成的「负载均衡 / 负载均衡2…」组：同上，默认 hashing。
    this.lb_round_robin = false;
    this.keep_alive_idle = 60;
    this.keep_alive_interval = 30;
    this.find_process_mode = 'off';
    this.auto_route = true;
    this.auto_redirect = true;
    this.auto_detect_interface = true;
    this.strict_route = true;
    this.mtu = 1400;
    this.dns_hijack = ['any:53', 'tcp://any:53'];
    this.dns_listen = DNS_DEFAULTS.listen;
    this.dns_default_ns = DNS_DEFAULTS.defaultNs.slice();
    this.dns_nameserver = DNS_DEFAULTS.nameserver.slice();
    this.dns_proxy_server_ns = DNS_DEFAULTS.proxyNs.slice();
    this.dns_direct_ns = DNS_DEFAULTS.directNs.slice();
    this.dns_policy_cn = DNS_DEFAULTS.policyCn.slice();
    this.dns_policy_geo = DNS_DEFAULTS.policyGeo.slice();
    this.sniffer_enable = true;
    this.sniffer_http_ports = SNIFFER_DEFAULTS.http.slice();
    this.sniffer_tls_ports = SNIFFER_DEFAULTS.tls.slice();
    this.sniffer_quic_ports = SNIFFER_DEFAULTS.quic.slice();
    this.sniffer_skip_domains = SNIFFER_DEFAULTS.skip.slice();
  }
  SplitEngine.STACKS = ['system', 'gvisor', 'mixed', 'mips'];

  /**
   * 智能选择模式下那个 fallback 测速组的名字。
   *
   * 注意：界面层和引擎必须用同一个名字 —— ui.js 把它写进 `default_node`，引擎拿它当 MATCH /
   * GEOx 规则的目标；写岔了产物就会引用一个不存在的 proxy-group，mihomo 直接拒绝加载。
   * 基线里 tests/golden/bless.mjs 用本常量装配，不写字面量。
   */
  SplitEngine.AUTO_GROUP = '自动优选';
  // 输出组名：策略名 + 实例图标。界面继续用旧组名，只在生成配置时映射。
  var GROUP_ICONS = ['⚡', '🚀', '💨', '🔥', '🚗', '💎', '💫', '🌠', '🏁', '🌀'];
  // 单测据此校验：每枚图标必须单码点，避免带 U+FE0F 变体选择符导致面板显示不齐。
  SplitEngine.GROUP_ICONS = GROUP_ICONS;
  function outGroupName(strategy, index) {
    var icon = GROUP_ICONS[index] || ('·' + (index + 1));
    return (strategy === 'round-robin' ? '轮询分摊' : '目标固定') + icon;
  }

  /**
   * 智能选择组的实际成员池 = 全部节点减去界面上勾掉的。
   * 注意：返回空数组是合法的 —— 节点全被取消就不建组、默认出口直连（buildConfig 把
   * default_node 改成 DIRECT），绝不退回全量。
   */
  SplitEngine.smartPool = function (proxies, exclude) {
    var list = proxies || [];
    var ex = exclude || [];
    return list.filter(function (p) { return ex.indexOf(p.name) === -1; });
  };

  /**
   * 配置里真正用到的节点 = 智能组成员 + 默认出口 + 自定义规则/组引用的节点；其余节点直接不写进
   * 配置 —— 工具没法改正在跑的核心配置，留着没人引用的节点只是死配置。
   */
  SplitEngine.prototype._activeProxies = function () {
    // 一机一IP 里每个节点都有一条 SRC-IP-CIDR 规则引用，全部保留
    if (this.all_proxies_used) return this.proxies.slice();
    var used = Object.create(null);
    var i, j;
    var mark = function (n) { if (n) used[n] = true; };
    // 智能选择组的成员（只有真的会建组时才算）
    if (this.auto_select && this.proxies.length >= 2) {
      var pool = SplitEngine.smartPool(this.proxies, this.auto_select_exclude);
      if (pool.length >= 2) {
        for (i = 0; i < pool.length; i++) mark(pool[i].name);
      }
    }
    // 默认出口（单节点 / 不带智能选择时，MATCH 等规则直接指向它）
    mark(this.default_node);
    // 本地出口（国内规则直接指向它）—— 不标的话节点会被当成"没引用"剔除
    mark(this.local_exit);
    // 自定义规则直接指向的节点
    var rules = this.custom_rules || [];
    for (i = 0; i < rules.length; i++) mark(rules[i] && rules[i].action);
    // 自定义负载均衡组的成员
    var groups = this.custom_groups || [];
    for (i = 0; i < groups.length; i++) {
      var members = (groups[i] && groups[i].proxies) || [];
      for (j = 0; j < members.length; j++) mark(members[j]);
    }
    return this.proxies.filter(function (p) { return used[p.name]; });
  };

  /** 共享骨架：顶部 / profile / geo / tun / dns / sniffer / proxies（不含 rules）。 */
  SplitEngine.prototype._skeleton = function () {
    var L = [];
    var active = this._activeProxies();
    var A = function (s) { L.push(s); };
    // DNS / sniffer 里那些列表项的缩进有 4 空格也有 6 空格，统一走它输出
    var EACH = function (items, indent) {
      for (var k = 0; k < items.length; k++) A(indent + '- ' + listScalar(items[k]));
    };
    A('mode: rule');
    A('ipv6: ' + (this.ipv6_enabled ? 'true' : 'false'));
    A('log-level: ' + this.log_level);
    A('external-ui: ui');
    A('secret: ' + yq(this.secret));
    A('keep-alive-idle: ' + this.keep_alive_idle);
    A('unified-delay: ' + (this.unified_delay ? 'true' : 'false'));
    A('tcp-concurrent: ' + (this.tcp_concurrent ? 'true' : 'false'));
    A('keep-alive-interval: ' + this.keep_alive_interval);
    // 值两侧的单引号不能省：off / on 会被 YAML 当布尔读走
    A("find-process-mode: '" + this.find_process_mode + "'");
    A('external-controller: ' + yamlAddr(listenHost(this.controller_listen) + ':' + this.port));
    A('');
    A('profile:');
    if (!this.redir_host) A('  store-fake-ip: true');
    A('  store-selected: true');
    A('');
    A('geo-auto-update: true');
    A('geo-update-interval: 24');
    A('geox-url:');
    // jsDelivr 的 release 分支（内核 24h 自动更新是直连，GitHub 国内经常拉不动）
    A('  mmdb: "https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.metadb"');
    A('  geosite: "https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite.dat"');
    // 用了 IP-ASN 规则就必须有 ASN.mmdb：没有的话内核会现场去这个地址下，
    // 下不到直接起不来（不是跳过那条规则）。所以只在真的用到时写这一行。
    if (this.need_asn) {
      A('  asn: "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/GeoLite2-ASN.mmdb"');
    }
    A('');
    // 字段顺序按官方 tun 模板：
    // enable → stack → auto-route → auto-redirect → auto-detect-interface
    // → dns-hijack → device → mtu → strict-route → gso → inet6-address
    // → route-exclude-address
    A('tun:');
    A('  enable: true');
    A('  stack: ' + this.stack);
    A('  auto-route: ' + (this.auto_route ? 'true' : 'false'));
    A('  auto-redirect: ' + (this.auto_redirect ? 'true' : 'false'));
    A('  auto-detect-interface: ' + (this.auto_detect_interface ? 'true' : 'false'));
    A('  dns-hijack:');
    var hijack = listOr(this.dns_hijack, ['any:53', 'tcp://any:53']);
    for (var hi = 0; hi < hijack.length; hi++) A('    - ' + listScalar(hijack[hi]));
    A('  mtu: ' + this.mtu);
    A('  strict-route: ' + (this.strict_route ? 'true' : 'false'));
    A('  gso: true');
    A('  gso-max-size: 65536');
    if (this.ipv6_enabled && this.ipv6_via_node) {
      A('  inet6-address:');
      A('    - fdfe:dcba:9876::1/126');
    }
    A('  route-exclude-address:');
    A('    - fc00::/7');
    A('    - fe80::/10');
    A('    - 10.0.0.0/8');
    A('    - 100.64.0.0/10');
    A('    - 172.16.0.0/12');
    A('    - 192.168.0.0/16');
    A('');
    A('dns:');
    A('  ipv6: ' + (this.ipv6_enabled ? 'true' : 'false'));
    A('  enable: true');
    A('  use-hosts: true');
    A('  prefer-h3: false');
    A('  respect-rules: true');
    A('  cache-algorithm: arc');
    A('  cache-max-size: 4096');
    A('  listen: ' + dnsAddr(this.dns_listen || DNS_DEFAULTS.listen));
    A('  use-system-hosts: true');
    if (this.redir_host) {
      A('  enhanced-mode: redir-host');
    } else {
      A('  enhanced-mode: fake-ip');
      if (this.ipv6_enabled) A('  fake-ip-range6: 2001:2::/48');
      A('  fake-ip-range: 198.18.0.1/16');
      if (!this.mainland) A('  fake-ip-filter-mode: blacklist');
      A('  fake-ip-filter:');
      var filters = this.mainland ? FAKE_IP_FILTER_MAINLAND : FAKE_IP_FILTER_FULL;
      for (var fi = 0; fi < filters.length; fi++) A("    - '" + filters[fi] + "'");
      var nodeDomains = active.length ? extractDomains(active) : [];
      if (nodeDomains.length) {
        // 全是 IP 节点时一个域名都没有：空挂一个 "# 节点域名" 注释比不写还难看
        A('');
        A('    # 节点 域名');
        for (var di = 0; di < nodeDomains.length; di++) A("    - '" + nodeDomains[di] + "'");
      }
    }
    A('');
    A('  # 引导 DNS');
    A('  default-nameserver:');
    // 回国模式用国外 DNS 起步；正常 / 国内共用一套，可被界面覆盖
    EACH(this.return_mode ? ['1.1.1.1', '8.8.8.8']
      : listOr(this.dns_default_ns, DNS_DEFAULTS.defaultNs), '    ');
    A('');
    A('  # 默认 DNS');
    A('  nameserver:');
    if (this.mainland) {
      EACH(['https://223.5.5.5/dns-query', 'https://doh.pub/dns-query'], '    ');
    } else if (this.return_mode) {
      EACH(['https://223.5.5.5/dns-query', 'https://dns.alidns.com/dns-query'], '    ');
    } else {
      // 只有"正常"这一套开放给界面编辑；回国 / 国内两套是内置预设
      EACH(listOr(this.dns_nameserver, DNS_DEFAULTS.nameserver), '    ');
    }
    A('');
    A('  # 节点 DNS');
    A('  proxy-server-nameserver:');
    EACH(listOr(this.dns_proxy_server_ns, DNS_DEFAULTS.proxyNs), '    ');
    A('');
    A('  # 中国 DNS');
    A('  nameserver-policy:');
    A('    "geosite:cn":');
    // 中国域名一律走国内 DoH —— 回国模式反转的是"哪些域名走哪条路"，
    // 不是"中国域名该问谁"。
    EACH(listOr(this.dns_policy_cn, DNS_DEFAULTS.policyCn), '      ');
    A('');
    A('    "geosite:private":');
    A('      - 127.0.0.1');
    A('');
    if (this.mainland) A('    # 国内 DNS');
    else if (this.return_mode) A('    # 本地 DNS');
    else A('    # 国外 DNS');
    A('    "geosite:geolocation-!cn":');
    if (this.mainland) {
      EACH(['https://223.5.5.5/dns-query', 'https://doh.pub/dns-query'], '      ');
    } else {
      EACH(listOr(this.dns_policy_geo, DNS_DEFAULTS.policyGeo), '      ');
    }
    A('');
    A('  # 直连 DNS');
    A('  direct-nameserver:');
    if (this.return_mode) {
      EACH(['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query'], '    ');
    } else {
      EACH(listOr(this.dns_direct_ns, DNS_DEFAULTS.directNs), '    ');
    }
    A('  direct-nameserver-follow-policy: true');
    A('');
    A('sniffer:');
    // mainland 优先于 sniffer_enable：国内模式整块只剩 enable: false，
    // 与手动关掉 sniff 的输出逐字相同（skip-domain 那一坨也一并省掉）。
    if (this.mainland || !this.sniffer_enable) {
      A('  enable: false');
    } else {
      A('  enable: true');
      A('  parse-pure-ip: true');
      A('  parse-pooled-conns: true');
      A('  sniff:');
      A('    HTTP:');
      A('      ports:');
      EACH(quotePorts(this.sniffer_http_ports, SNIFFER_DEFAULTS.http), '        ');
      A('      override-destination: true');
      A('    TLS:');
      A('      ports:');
      EACH(quotePorts(this.sniffer_tls_ports, SNIFFER_DEFAULTS.tls), '        ');
      // TLS 这里也要覆盖目标地址。关掉 fake-ip（enhanced-mode: redir-host）时，
      // 客户端手里是**真实 IP**，分流判断几乎全靠嗅探 —— 嗅到 SNI 之后按域名去连，
      // 判断更准，也不会拿着被污染/劣化的 IP 连到错地方。
      // fake-ip 模式下这行是空操作（域名本来就已知），不会有害。
      A('      override-destination: true');
      A('    QUIC:');
      A('      ports:');
      EACH(quotePorts(this.sniffer_quic_ports, SNIFFER_DEFAULTS.quic), '        ');
      A('  skip-domain:');
      EACH(listOr(this.sniffer_skip_domains, SNIFFER_DEFAULTS.skip), '    ');
    }
    // 只写被引用到的节点；一个都没有时整段不出（纯 DIRECT 的配置也能加载）
    A('');
    if (active.length) {
      A('proxies:');
      for (var i = 0; i < active.length; i++) {
        // 一律带 ip-version：三种模式的节点文本必须逐字一致。它跟本地 IPv6 开关
        // 不是一回事 —— 官方文档写的是"代理软件出站使用的 ip 版本"。
        L.push.apply(L, MH.proxyToYaml(active[i], true));
        if (i < active.length - 1) A('');
      }
      A('');
    }
    // ── proxy-groups = 智能选择（可选）+ 自定义规则的多节点出口 ────────────
    var groupDefs = [];
    if (this.auto_select && this.proxies.length >= 2) {
      var pool = SplitEngine.smartPool(this.proxies, this.auto_select_exclude);
      // 成员只剩一个就不建组了 —— 一个节点的负载均衡组没有意义，
      // default_node 已经由 buildConfig 改指向那个节点。
      if (pool.length >= 2) {
        groupDefs.push({
          name: SplitEngine.AUTO_GROUP,
          members: pool.map(function (p) { return p.name; }),
          strategy: this.auto_group_round_robin ? 'round-robin' : 'consistent-hashing',
          iconIndex: 0
        });
      }
    }
    // 自定义规则的多节点出口（成员已由界面 / buildConfig 校验过）
    var extraGroups = this.custom_groups || [];
    var customIndex = 0;
    for (var gi = 0; gi < extraGroups.length; gi++) {
      var g = extraGroups[gi];
      if (!g || !g.name || !g.proxies || g.proxies.length < 2) continue;
      groupDefs.push({
        name: g.name,
        members: g.proxies.slice(),
        strategy: this.lb_round_robin ? 'round-robin' : 'consistent-hashing',
        // 自动组固定 ⚡；自定义组从 🚀 开始，不因自动组是否存在而改变图标
        iconIndex: 1 + customIndex
      });
      customIndex += 1;
    }
    // 旧组名 → 输出组名（策略名 + 图标）；规则里的引用同步映射。
    var groupMap = Object.create(null);
    for (var gn = 0; gn < groupDefs.length; gn++) {
      groupDefs[gn].outName = outGroupName(groupDefs[gn].strategy, groupDefs[gn].iconIndex);
      groupMap[groupDefs[gn].name] = groupDefs[gn].outName;
    }
    this._group_name_map = groupMap;

    // 组体检地址：按这份配置的**出口位置**选，回国 / 国内使用国内节点 走国内检查点，
    // 其余（出国 / 全局代理）走 gstatic。详见文件顶部 HEALTH_URL_* 的注释。
    var health_url = (this.return_mode || this.mainland) ? HEALTH_URL_CN : HEALTH_URL_INTL;

    if (groupDefs.length) {
      A('proxy-groups:');
      // ── GLOBAL ─────────────────────────────────────────────────────────
      // 内核默认会把组也塞进 GLOBAL，面板里 GLOBAL 下面就挂着「智能选择 / 负载均衡」，看着乱。
      // 所以自己定义 GLOBAL（mihomo 认，会跳过内置那个），只放 DIRECT/REJECT。
      // 注意：不写 `include-all-proxies` —— 那行会把所有节点都塞进 GLOBAL；只有真的建了组才这么写。
      // 注意：代价是全局模式下 GLOBAL 里只有 DIRECT/REJECT，选不到节点/组。
      // 注意：`hidden: true` 让面板不画这张卡；既然不展示，`url` 也不需要（它只为面板测速服务）。
      A('  - name: GLOBAL');
      A('    type: select');
      A('    hidden: true');
      A('    proxies:');
      A('      - DIRECT');
      A('      - REJECT');
      A('');
      for (var gj = 0; gj < groupDefs.length; gj++) {
        var gd = groupDefs[gj];
        A('  - name: ' + yq(gd.outName || gd.name));
        // ⚠️ 类型是 load-balance，不是 fallback：fallback 只用第一个能用的节点（坏了才换）不叠加
        // 带宽；load-balance 让新连接在成员间轮流分，坏节点被体检剔除后不再分配。
        // 注意：它只对**新建连接**生效，已经在跑的长连接不会中途换线。
        A('    type: load-balance');
        A('    proxies:');
        for (var mj = 0; mj < gd.members.length; mj++) {
          A('      - ' + yq(gd.members[mj]));
        }
        // 健康检查：面板里的延迟数字、以及「谁坏了不许再接新连接」都靠它。
        // 注意：地址按出口换（见 HEALTH_URL_*）：出国用 gstatic，回国 / 国内用华为 204 ——
        // 反过来用会让国内线路超时、好节点被误判，或让海外节点延迟虚高。
        // 注意：走 https 不走 http —— mihomo 的 unified-delay 会连发两次 HEAD，源码建议 https；
        // 明文地址容易被机场劫持、也不保证重复 HEAD。多一次 TLS 握手，所有节点一样多，排名不受影响。
        A('    url: "' + health_url + '"');
        A('    interval: 30');            // 30 秒一轮：坏节点最多半分钟被踢出轮换（配合 max-failed-times 仍要连错两次才判死）
        A('    lazy: false');              // 空闲也体检 —— 不然没人用的时候坏了不知道
        A('    timeout: 3000');
        A('    max-failed-times: 2');      // 连续 2 次拨号失败即判坏（下一轮自愈）
        A('    expected-status: 204');     // 严格：被劫持 / 返回别的状态码一律算坏
        // 调度策略按组决定（不是全局开关）：
        // · consistent-hashing（默认）—— 按站点固定，同一个域名永远同一个节点
        // · round-robin —— 按连接轮流，组内均分；只在成员同 IP 出口时才安全
        //   （出口 IP 不同的话同一站点会一会儿一个 IP，登录/风控会出问题）
        A('    strategy: ' + (gd.strategy || 'consistent-hashing'));
        A('');
      }
    }
    // 广告拦截：明细放在外部规则文件里，config 里只有一条 RULE-SET。
    // 内核首次加载和每隔 interval 自己去拉（缓存落到 path，断网时用旧缓存）。
    if (this.ad_block) {
      A('rule-providers:');
      A('  ' + ADBLOCK_PROVIDER.name + ':');
      A('    type: http');
      A('    behavior: domain');
      A('    format: ' + ADBLOCK_PROVIDER.format);
      A('    url: "' + ADBLOCK_PROVIDER.url + '"');
      A('    path: ' + ADBLOCK_PROVIDER.path);
      A('    interval: ' + ADBLOCK_PROVIDER.interval);   // 8 小时：清单本身 8 小时一更
      A('    proxy: DIRECT');
      A('');
    }
    return L;
  };

  SplitEngine.prototype.generate = function () {
    var L = this._skeleton();
    L.push.apply(L, this.genRules());
    return L.join('\n');
  };

  SplitEngine.prototype.genRules = function () {
    var map = this._group_name_map || {};
    var node = map[this.default_node] || this.default_node;
    var i, b;

    // 用户自定义规则（"选节点"的那些），永远排在最前 —— 位置即优先级
    var mappedRules = (this.custom_rules || []).map(function (r) {
      if (!r || typeof r !== 'object') return r;
      var c = {};
      for (var k in r) c[k] = r[k];
      c.action = map[r.action] || r.action;
      return c;
    });
    var custom = customRuleBlock(mappedRules);

    // ===== 全局代理（全部流量走代理）=====
    // 界面上是精准分流面板里的一个勾选框，不是独立方案。勾上就只剩三块：自定义规则 → 直连块 →
    // 一句 MATCH，分流那堆 GEOIP / GEOSITE 全都不出。
    if (this.global_mode) {
      var g = [];
      // 自定义优先，广告拦截其次（白名单要盖得住）
      if (custom) g.push(custom);
      g.push.apply(g, directBlocks(this.direct_ips, this.direct_domains));
      if (this.ad_block) g.push(ADBLOCK_RULE.slice());
      // 内网 / NTP 直连：全局模式下同样保留，否则开全局连路由器管理页、NAS 都进不去
      g.push(LAN_DIRECT.slice());
      g.push(LAN_DOMAINS.slice());
      g.push(NTP_DIRECT.slice());
      // 出口用 default_node 而不是写死 SplitEngine.AUTO_GROUP：默认出口是 UI 按 autoSelect / 用户
      // 选择算好后写进来的。写死的话 autoSelect 关掉时 _skeleton 不建那个组，MATCH 就指向一个不存在
      // 的 proxy-group，mihomo 会拒绝加载。
      g.push(['  - MATCH,' + node]);
      return joinBlocks(g);
    }

    // ===== 回国模式（海外环境 → 国内节点）=====
    if (this.return_mode) {
      var blocks = [];
      if (custom) blocks.push(custom);

      // 内网直连 / 内网域名 / NTP：三段的注释与规则见文件顶部常量。
      // GEOIP,LAN 是 mihomo 内置伪规则，v4/v6 通吃，是原先六条 IP-CIDR 的严格超集；
      // 带 no-resolve —— 这条只看目标 IP 字面量，域名交给紧随其后的 GEOSITE,private。
      blocks.push(LAN_DIRECT.slice());
      blocks.push(LAN_DOMAINS.slice());

      if (this.direct_ips && this.direct_ips.length) {
        b = ['  # 直连 IP'];
        var seenIp = Object.create(null);
        for (i = 0; i < this.direct_ips.length; i++) {
          var ir = ipRule(this.direct_ips[i]);
          if (ir && !seenIp[ir]) { seenIp[ir] = 1; b.push(ir); }
        }
        if (b.length > 1) blocks.push(b);
      }
      if (this.direct_domains && this.direct_domains.length) {
        b = ['  # 直连 域名'];
        var seenD = Object.create(null);
        for (i = 0; i < this.direct_domains.length; i++) {
          var dr = domainRule(this.direct_domains[i]);
          if (dr && !seenD[dr]) { seenD[dr] = 1; b.push(dr); }
        }
        if (b.length > 1) blocks.push(b);
      }

      // 广告拦截：自定义 / 直连条目之后、网络规则之前
      if (this.ad_block) blocks.push(ADBLOCK_RULE.slice());

      blocks.push(NTP_DIRECT.slice());
      // WebRTC STUN（走默认出口；回国模式默认出口就是节点）
      if (this.webrtc_protect) {
        blocks.push(['  # WebRTC STUN', '  - DOMAIN-KEYWORD,stun,' + node]);
      }
      // 中国 代理
      blocks.push(['  # 中国 代理',
        '  - GEOSITE,cn,' + node,
        '  - GEOIP,CN,' + node]);
      // 国外 直连
      blocks.push(['  # 本地 直连', '  - GEOSITE,geolocation-!cn,DIRECT']);
      // 默认 直连
      blocks.push(['  # 默认 直连', '  - MATCH,DIRECT']);

      return joinBlocks(blocks);
    }

    var blocks2 = [];

    // 自定义规则排最前（位置即优先级）：用户写的白名单要能盖住下面的广告拦截
    if (custom) blocks2.push(custom);
    blocks2.push.apply(blocks2, directBlocks(this.direct_ips, this.direct_domains));

    // 广告拦截：排在自定义规则之后、网络规则之前 —— 既拦得住广告，又不挡用户白名单
    if (this.ad_block) blocks2.push(ADBLOCK_RULE.slice());

    blocks2.push(LAN_DIRECT.slice());
    blocks2.push(LAN_DOMAINS.slice());

    blocks2.push(NTP_DIRECT.slice());

    // STUN / WebRTC（按 WebRTC防泄露 勾选状态输出）
    if (this.webrtc_protect) {
      blocks2.push(['  # WebRTC STUN', '  - DOMAIN-KEYWORD,stun,' + node]);
    }

    // 非中国（核心规则）
    blocks2.push(['  # 国外 代理', '  - GEOSITE,geolocation-!cn,' + node]);
    // 中国
    if (this.local_exit) {
      // 本地出口：国内流量改走选中的节点
      blocks2.push(['  # 国内 代理',
        '  - GEOSITE,cn,' + this.local_exit,
        '  - GEOIP,CN,' + this.local_exit]);
    } else {
      blocks2.push(['  # 国内 直连', '  - GEOSITE,cn,DIRECT', '  - GEOIP,CN,DIRECT']);
    }
    // 默认兜底
    blocks2.push(['  # 默认 代理', '  - MATCH,' + node]);

    return joinBlocks(blocks2);
  };

  // ══ 一机一IP ═════════════════════════════════════════
  function OneIPEngine() {
    this.proxies = [];
    this.direct_ips = [];
    this.direct_domains = [];
    this.network = '192.168.100';
    this.start_ip = 2;
    this.ips_per_node = 1;
    this.secret = DEFAULT_SECRET;
    this.port = 9090;
    this.anydesk = false;
    this.tg = false;
    this.return_mode = false;
    this.mainland = false;
    this.redir_host = DEFAULT_REDIR_HOST;
    this.controller_listen = DEFAULT_LISTEN;
    this.custom_rules = [];
    // 多节点出口 → 负载均衡组（跟分流共用同一套骨架）
    this.custom_groups = [];
  }

  /**
   * 解析内网网段 → {net, prefixlen, usable, first, last}
   * 支持任意 IPv4 内网网段：
   *   '192.168.100'        → 192.168.100.0/24
   *   '192.168.100.0/24'   → 192.168.100.0/24
   *   '10.0.0.0/8'         → 10.0.0.0/8
   */
  OneIPEngine.prototype.networkInfo = function () {
    var spec = String(this.network == null ? '' : this.network).trim();
    if (!spec) throw new Error('内网网段为空');
    var s = spec;
    if (s.indexOf('/') === -1) {
      var dots = (s.match(/\./g) || []).length;
      if (dots === 2) {
        s += '.0/24';
      } else if (dots === 3) {
        s += '/24';
      } else {
        throw new Error('内网网段格式错误: ' + s + '（支持 192.168.100 或 192.168.100.0/24）');
      }
    }
    var at = s.indexOf('/');
    var addrPart = s.slice(0, at);
    var prefixPart = s.slice(at + 1);
    if (!/^[0-9]+$/.test(prefixPart)) throw new Error('内网网段格式错误: ' + s);
    var plen = parseInt(prefixPart, 10);
    var addr = ipv4ToInt(addrPart);
    if (addr === null) {
      // 地址不是 IPv4：可能是 IPv6 网段，也可能纯属格式错 —— 两者报错不同
      if (isIpv6(addrPart)) throw new Error('仅支持 IPv4 内网网段: ' + s);
      throw new Error('内网网段格式错误: ' + s);
    }
    if (plen > 32) throw new Error('内网网段格式错误: ' + s);

    var size = Math.pow(2, 32 - plen);
    var mask = plen === 0 ? 0 : ((0xffffffff << (32 - plen)) >>> 0);
    var netInt = (addr & mask) >>> 0;
    var broadcast = netInt + size - 1;
    var first, last, usable;
    if (plen <= 30) {
      first = netInt + 1;
      last = broadcast - 1;
      usable = size - 2;
    } else {
      first = netInt;
      last = netInt + size - 1;
      usable = size;
    }
    return {
      net: ipText(netInt) + '/' + plen, prefixlen: plen,
      usable: usable, first: first, last: last
    };
  };

  /** 起始IP：纯数字 = 第 N 个可用主机的偏移；带点 = 网段内绝对地址。 */
  OneIPEngine.prototype.resolveStart = function (first, last, usable) {
    var s = String(this.start_ip == null || this.start_ip === '' || this.start_ip === 0
      ? '' : this.start_ip).trim();
    if (/^[0-9]+$/.test(s)) {
      var idx = parseInt(s, 10);
      if (idx < 1) throw new Error('起始IP 至少为 1（第 1 个可用主机）');
      if (idx > usable) throw new Error('起始IP 偏移 ' + idx + ' 超出网段可用主机数 ' + usable);
      return first + idx - 1;
    }
    var ip = ipv4ToInt(s);
    if (ip === null) {
      if (isIpv6(s)) {
        throw new Error('起始IP ' + s + ' 不在网段可用范围 (' +
          ipText(first) + '-' + ipText(last) + ')');
      }
      throw new Error('起始IP 格式错误: ' + s + '（数字偏移或完整 IP）');
    }
    if (!(first <= ip && ip <= last)) {
      throw new Error('起始IP ' + s + ' 不在网段可用范围 (' +
        ipText(first) + '-' + ipText(last) + ')');
    }
    return ip;
  };

  /** 计算节点 → IP 分配，返回 [{name, ips:[int,...]}]，并校验容量。 */
  OneIPEngine.prototype.allocation = function () {
    var info = this.networkInfo();
    var start = this.resolveStart(info.first, info.last, info.usable);
    var perRaw = this.ips_per_node === 0 || this.ips_per_node === '' ||
      this.ips_per_node == null ? 1 : MH.sInt(this.ips_per_node, 1);
    var per = Math.max(perRaw, 1);
    var need = this.proxies.length * per;
    if (need === 0) throw new Error('没有节点可分配');
    var lastNeeded = start + need - 1;
    if (lastNeeded > info.last) {
      throw new Error('IP 地址不足: 网段可用 ' + info.usable + ' 个, 从 ' +
        ipText(start) + ' 起需要 ' + need + ' 个, 超出网段末尾 ' + ipText(info.last));
    }
    var result = [];
    var cur = start;
    for (var i = 0; i < this.proxies.length; i++) {
      var ips = [];
      for (var j = 0; j < per; j++) ips.push(cur + j);
      result.push({ name: this.proxies[i].name, ips: ips });
      cur += per;
    }
    return result;
  };

  OneIPEngine.prototype.genRules = function (allocation) {
    var L = ['rules:'];

    // 自定义规则（"选节点"的那部分）：三档方案里都排在最前，一机一IP 也不例外。
    // ⚠️ 一机一IP 只按源 IPv4 分流（ipv6_enabled = false），IPv6 目标写进来也永远匹配不上，
    //    所以在这一层直接滤掉 —— 界面那边会先提示，这里是不让手滑绕过去。
    var map = this._group_name_map || {};
    var custom = customRuleBlock((this.custom_rules || []).filter(function (r) {
      return r && !MH.isV6Target(r.target);
    }).map(function (r) {
      var c = {};
      for (var k in r) c[k] = r[k];
      c.action = map[r.action] || r.action;
      return c;
    }));
    if (custom) {
      L.push.apply(L, custom);
      L.push('');
    }

    if (this.tg) {
      L.push('  # Telegram');
      // 域名交给 GeoSite：TELEGRAM 分类 21 条，比手写的 7 条全。
      // ⚠️ **IP 必须留着**：GeoSite 只有域名，而 Telegram 客户端大量直连 DC 的 IP。
      //    用 IP-ASN 代替一长串 IP-CIDR：Telegram 的段都在下面这几个 ASN 里，
      //    换 IP / 加 IP 不用跟着改（44907/62041/62014/59930/211157）。
      L.push('  - GEOSITE,telegram,DIRECT');
      L.push('');
      var TG_ASNS = ['44907', '62041', '62014', '59930', '211157'];
      for (var j = 0; j < TG_ASNS.length; j++) {
        L.push('  - IP-ASN,' + TG_ASNS[j] + ',DIRECT,no-resolve');
      }
      L.push('');
    }

    if (this.anydesk) {
      L.push('  # AnyDesk');
      L.push('  - DOMAIN-SUFFIX,anydesk.com,DIRECT');
      L.push('');
    }

    if (this.direct_ips && this.direct_ips.length) {
      var seen = Object.create(null);
      for (var k = 0; k < this.direct_ips.length; k++) {
        if (MH.isV6Target(this.direct_ips[k])) continue;   // 同上：内网控制不吃 IPv6
        var rule = ipRule(this.direct_ips[k]);
        if (rule && !seen[rule]) { seen[rule] = 1; L.push(rule); }
      }
      L.push('');
    }

    if (this.direct_domains && this.direct_domains.length) {
      var seenD = Object.create(null);
      for (var m = 0; m < this.direct_domains.length; m++) {
        var drule = domainRule(this.direct_domains[m]);
        if (drule && !seenD[drule]) { seenD[drule] = 1; L.push(drule); }
      }
      L.push('');
    }

    // 广告拦截：排在自定义规则 / 直连条目之后，网络规则之前（用户白名单优先）
    if (this.ad_block) {
      L.push.apply(L, ADBLOCK_RULE.slice());
      L.push('');
    }

    // 内网 / NTP 直连必须排在 SRC-IP-CIDR 前面：SRC 规则只看源 IP、不看目标，
    // 排在它后面的话，被分配到节点的设备连路由器、NAS 也会被送去节点（连不上）。
    L.push.apply(L, LAN_DIRECT.slice());
    L.push('');
    L.push.apply(L, LAN_DOMAINS.slice());
    L.push('');
    L.push.apply(L, NTP_DIRECT.slice());
    L.push('');

    L.push('  # 内网 控制');
    for (var n = 0; n < allocation.length; n++) {
      for (var q = 0; q < allocation[n].ips.length; q++) {
        L.push('  - SRC-IP-CIDR,' + ipText(allocation[n].ips[q]) + '/32,' + allocation[n].name);
      }
    }
    L.push('');
    L.push('  # 默认 直连');
    L.push('  - MATCH,DIRECT');

    return L;
  };

  /**
   * 一机一IP 与分流共用的骨架字段。
   *
   * OneIPEngine.generate 是 `new SplitEngine()` 之后逐个属性拷贝再调 `_skeleton()` 的，漏掉一个
   * 就会出现「分流模式能调、一机一IP 调了没反应」这种完全不报错的 bug，所以集中列一份。
   * 注意：不在这份名单里的（有意为之）：`ipv6_enabled`（强制关），以及 secret/port/
   * controller_listen/mainland/redir_host/return_mode 这些单独处理、另有语义的字段。
   */
  var SHARED_SKELETON_FIELDS = [
    'stack',
    'log_level', 'unified_delay', 'tcp_concurrent', 'keep_alive_idle',
    'keep_alive_interval', 'find_process_mode',
    'auto_route', 'auto_redirect', 'auto_detect_interface', 'strict_route',
    'mtu', 'dns_hijack',
    'dns_listen', 'dns_default_ns', 'dns_nameserver', 'dns_proxy_server_ns',
    'dns_direct_ns', 'dns_policy_cn', 'dns_policy_geo',
    'sniffer_enable', 'sniffer_http_ports', 'sniffer_tls_ports',
    'sniffer_quic_ports', 'sniffer_skip_domains',
    'ad_block', 'lb_round_robin'
  ];

  OneIPEngine.prototype.generate = function () {
    var allocation = this.allocation();
    var eng = new SplitEngine();
    eng.proxies = this.proxies;
    // 每个节点都会被 genRules 的 SRC-IP-CIDR 引用，别按精准分流那套裁剪
    eng.all_proxies_used = true;
    eng.secret = this.secret;
    eng.port = this.port;
    eng.controller_listen = this.controller_listen;
    eng.custom_groups = this.custom_groups || [];
    // 不设 webrtc_protect：只有 SplitEngine.genRules 会读，一机一IP 用自己的 genRules。
    // 这里关的是本机 IPv6：一机一IP 只用 IPv4 源 IP 分流，用不上 AAAA。
    eng.ipv6_enabled = false;
    // 「回国模式」与「国内使用国内节点」互斥：都开会得到一份国内 DNS 配回国规则反转的混合体；
    // GUI 勾选时会互相取消，这里再兜一道底。
    eng.mainland = this.mainland;
    eng.redir_host = this.redir_host;
    // Telegram 直连用的是 IP-ASN —— 让骨架把 geox-url.asn 也写出来
    eng.need_asn = !!this.tg;
    eng.return_mode = this.return_mode && !this.mainland;
    // 进阶参数（基础 / TUN / DNS / sniffer）走同一份 _skeleton，所以也得搬过去。
    // `!== undefined` 这个守卫是关键：没设过就是 undefined → 不覆盖 → SplitEngine 的默认值生效。
    for (var si = 0; si < SHARED_SKELETON_FIELDS.length; si++) {
      var sf = SHARED_SKELETON_FIELDS[si];
      if (this[sf] !== undefined) eng[sf] = this[sf];
    }
    var L = eng._skeleton();
    this._group_name_map = eng._group_name_map;
    L.push.apply(L, this.genRules(allocation));
    return L.join('\n');
  };

  /** 地址范围文本：首尾相同时只写一个，否则写成 `a ~ b`。 */
  function ipRange(a, b) {
    return a === b ? ipText(a) : ipText(a) + ' ~ ' + ipText(b);
  }

  /** IP 分配预览（界面显示用）：容量行 + 分配列表行；错误抛 Error。 */
  OneIPEngine.prototype.ipPreview = function (proxies, limit) {
    if (limit === undefined) limit = 12;
    var info = this.networkInfo();
    var start = this.resolveStart(info.first, info.last, info.usable);
    var perRaw = this.ips_per_node === 0 || this.ips_per_node === '' ||
      this.ips_per_node == null ? 1 : MH.sInt(this.ips_per_node, 1);
    var per = Math.max(perRaw, 1);
    var need = proxies.length * per;
    if (need === 0) throw new Error('没有节点可分配');
    var lastNeeded = start + need - 1;
    if (lastNeeded > info.last) {
      throw new Error('IP 地址不足: 网段可用 ' + info.usable + ' 个, 从 ' +
        ipText(start) + ' 起需要 ' + need + ' 个, 超出网段末尾 ' + ipText(info.last));
    }
    var cap = '当前网段为 ' + info.net + '，可用 ' + info.usable + ' 台。本次分配共 ' +
      need + ' 台，使用地址范围为 ' + ipRange(start, lastNeeded) + '，具体如下：';
    var parts = [];
    var cur = start;
    var shown = Math.min(proxies.length, limit);
    for (var i = 0; i < shown; i++) {
      if (per === 1) {
        parts.push(ipText(cur) + '→' + proxies[i].name);
      } else {
        parts.push(ipRange(cur, cur + per - 1) + '→' + proxies[i].name);
      }
      cur += per;
    }
    if (proxies.length > limit) parts.push('… 共 ' + proxies.length + ' 个节点');
    return cap + '\n' + parts.join(' | ');
  };

  MH.SplitEngine = SplitEngine;
  MH.OneIPEngine = OneIPEngine;
  MH.DEFAULT_SECRET = DEFAULT_SECRET;
  MH.DEFAULT_LISTEN = DEFAULT_LISTEN;
  MH.DEFAULT_REDIR_HOST = DEFAULT_REDIR_HOST;
  // 导出给 state.js 用：界面那几栏的出厂值必须和引擎实际用的默认值是同一份，别两处各写一遍。
  MH.DNS_DEFAULTS = DNS_DEFAULTS;
  MH.SNIFFER_DEFAULTS = SNIFFER_DEFAULTS;
})(typeof globalThis !== 'undefined' ? globalThis : this);
