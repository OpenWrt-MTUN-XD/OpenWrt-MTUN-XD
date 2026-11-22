/*!
 * iStoreOS-Mihomo-config 生成器 — 应用状态
 *
 * 只管数据与规则，不碰 DOM（那是 ui.js 的事）。
 *
 * 注意：什么都不持久化，每次打开都是干净的出厂默认（defaultState），上次填的模式 / 端口 /
 * DNS / 自定义规则一概不带过来；STORAGE_KEY 现在只用来删老访客浏览器里的旧存档。
 * 登录相关的缓存（面板密码 / 工具密码 / 写盘口端口）另算，不在这个文件里。
 */
(function (root) {
  'use strict';

  var MH = (root.MH = root.MH || {});

  var APP_VERSION = 'v2026.11.23';
  /** 老版本的设置存档键 —— 打开时清一次，让老访客也别留着上次那份。 */
  var STORAGE_KEY = 'mihomo-config-web:settings:v1';

  // 界面上的「规则方案」下拉就是遍历这个表生成的，顺序即显示顺序。
  // 第三档 global 已砍掉：它覆盖的「全部流量走代理」在精准分流里就能做到。
  var MODES = {
    split: { id: 'split', label: '精准分流' },
    oneip: { id: 'oneip', label: '内网控制' }
  };

  function defaultState() {
    return {
      mode: 'split',
      nodes: [],
      // 自定义规则：一条 = { target: 域名/IP, actions: [节点名... | 'DIRECT'] }；
      // `type: 'geosite'` 时 target 是 GeoSite 分类（常用 AI = category-ai-!cn），生成
      // `GEOSITE,<分类>,<出口>`。一个节点 = 直接走它，多个 = 生成负载均衡组（智能选择 /
      // 默认出口已占用的节点不出现在出口选项里）。旧形态 { target, action } 仍兼容。
      customRules: [],

      secret: '123456',
      port: 9090,
      // 面板监听地址。默认只监听本机 —— 不预置任何私网地址（各家网关网段都不一样），
      // 想内网进面板就填自己的网关。
      controllerListen: MH.DEFAULT_LISTEN,
      // DNS 模式：勾选框是「使用 redir-host」，默认不勾 = fake-ip。
      // 键从 fakeIp 翻成 redirHost，跟界面上的控件一一对应（勾了就是 true）。
      redirHost: MH.DEFAULT_REDIR_HOST,

      stack: 'mixed',
      ipv6: true,
      webrtc: true,
      // 广告拦截：勾上就加 217heidai 的 rule-provider + 一条 RULE-SET（默认**不勾**）
      // 默认关：一份 24 万条的规则集对路由器内存/启动时间都有成本，需要的人自己勾。
      adBlock: false,
      // 智能选择模式（生成 fallback 测速组并当默认出口），默认不勾：导进来两个以上节点时，
      // 第一个节点本来就是他要的出口，再自动套一层「哪台快走哪台」是替他做决定。
      autoSelect: false,
      // 「智能选择」测速组的成员黑名单：界面里被勾掉的节点名。这些节点只参与自定义规则，
      // 没被任何规则引用时生成配置时直接从 proxies 剔除。默认空数组 = 全部进组，生成结果
      // 与没这个功能时逐字一致（golden 基线不受影响）。
      autoSelectExclude: [],
      returnMode: false,
      // 全局代理：精准分流里「全部流量走代理」的勾选框（默认不勾）。
      // 与回国模式互斥 —— 一个说"全走代理"，一个说"国内走代理、国外直连"。
      globalProxy: false,
      defaultNode: '',
      // 打开「智能选择」前用户手选的默认出口：关掉开关时还原，避免出口跳回第一个节点
      defaultNodeMemory: '',
      // 本地出口：「国内出口」勾选后 GEOSITE,cn / GEOIP,CN 改走这个节点；默认不勾 = 国内直连。
      localExit: false,
      localExitNode: '',

      network: '192.168.100',
      startIp: '2',
      ipsPerNode: '1',
      oneipReturnMode: false,
      oneipMainland: false,
      anydesk: false,
      tg: false,

      theme: '',

      // ── 进阶参数 ──
      // 默认值必须与 engines.js 里 SplitEngine 构造函数的默认值一一对应，否则「界面显示的
      // 默认」和「引擎实际用的默认」分家，build.test.mjs 的「buildConfig 与 golden 等价」会抓到。
      // 列表类直接引用引擎导出的出厂表；数字存字符串（走 bindInput 的 el.value，与 ipsPerNode 一致）。
      // 注意：adBlock 出厂不勾，与引擎构造函数里的默认（false）一致。
      logLevel: 'info',
      unifiedDelay: true,
      tcpConcurrent: true,
      // 两个调度策略开关（各自只管自己那类组）：autoRoundRobin → 「智能选择」组，
      // lbRoundRobin → 自定义规则生成的「负载均衡」组。勾上 = round-robin（按连接轮流），
      // 默认 consistent-hashing（同站固定出口）；只建议在「同组同 IP 出口」时勾。
      autoRoundRobin: false,
      lbRoundRobin: false,
      keepAliveIdle: '60',
      keepAliveInterval: '30',
      findProcessMode: 'off',

      autoRoute: true,
      autoRedirect: true,
      autoDetectInterface: true,
      strictRoute: true,
      mtu: '1400',
      dnsHijack: ['any:53', 'tcp://any:53'],

      dnsListen: MH.DNS_DEFAULTS.listen,
      dnsDefaultNs: MH.DNS_DEFAULTS.defaultNs.slice(),
      dnsNameserver: MH.DNS_DEFAULTS.nameserver.slice(),
      dnsProxyServerNs: MH.DNS_DEFAULTS.proxyNs.slice(),
      dnsDirectNs: MH.DNS_DEFAULTS.directNs.slice(),
      dnsPolicyCn: MH.DNS_DEFAULTS.policyCn.slice(),
      dnsPolicyGeo: MH.DNS_DEFAULTS.policyGeo.slice(),

      snifferEnable: true,
      snifferHttpPorts: MH.SNIFFER_DEFAULTS.http.slice(),
      snifferTlsPorts: MH.SNIFFER_DEFAULTS.tls.slice(),
      snifferQuicPorts: MH.SNIFFER_DEFAULTS.quic.slice(),
      snifferSkipDomains: MH.SNIFFER_DEFAULTS.skip.slice()
    };
  }

  /**
   * 节点的「凭据指纹」 —— 与 parsers.js 的去重键同一套规则：除 name 外的全部字段。
   * remarks 参与其中是有意的：同一台机器不同凭据的节点不能当成重复丢掉。
   */
  function nodeKey(node) {
    var stripped = {};
    for (var k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      if (k === 'name') continue;
      stripped[k] = node[k];
    }
    return MH.stableJson(stripped);
  }

  /** 重复的节点名加 `(2)` `(3)` 后缀（引用节点的规则靠名字对上）。 */
  function dedupeNames(nodes) {
    return MH.dedupeNames(nodes);
  }

  /**
   * 追加导入：跨来源去重（同一节点贴两次不会变成两条），再统一重排名。
   * 返回真正新增的条数。
   */
  function addNodes(state, incoming) {
    var existing = Object.create(null);
    for (var i = 0; i < state.nodes.length; i++) {
      existing[nodeKey(state.nodes[i])] = true;
    }
    var added = 0;
    for (var j = 0; j < incoming.length; j++) {
      var key = nodeKey(incoming[j]);
      if (existing[key]) continue;
      existing[key] = true;
      state.nodes.push(incoming[j]);
      added += 1;
    }
    if (added) dedupeNames(state.nodes);
    return added;
  }

  /**
   * 宿主在部署时带进来的「监听地址」出厂值（LuCI「MTUN-XD → 配置工具」带 `?listen=`）。
   *
   * 注意：路由器那份默认就是 `127.0.0.1`，不再猜地址 —— 套件的 `expose on` 已把内核挂到
   * uhttpd 那个端口上，面板 / 配置工具 / API 全走 80 同源，不必再绑内网地址。
   * 注意：只给地址、不带端口，端口是旁边独立的「UI 端口」一格，产物由 engines.js 拼成
   * `external-controller: <地址>:<端口>`；带上 :9090 会生成 `1.2.3.4:9090:9090`，内核起不来。
   * 注意：只在还是出厂值（MH.DEFAULT_LISTEN）时才贴，自己填过别的（0.0.0.0、别的网段）一律不动。
   */
  function applyListenHint(state, hint) {
    if (hint === undefined) hint = LISTEN_HINT;
    if (!hint) return;
    if (state.controllerListen && state.controllerListen !== MH.DEFAULT_LISTEN) return;
    state.controllerListen = hint;
  }

  /** 取 `?listen=` 的值（宿主带在查询串里的）；没有就是空串。 */
  function readListenHint() {
    var loc = root.location;
    if (!loc) return '';
    var m = /[?&]listen=([^&#]*)/.exec(String(loc.search || ''));
    if (!m) return '';
    var v = m[1];
    try { v = decodeURIComponent(v); } catch (e) { /* 原样用 */ }
    return MH.cleanListen ? MH.cleanListen(v) : v;
  }

  // 必须在加载时就抓下来（不能等 init）：secret.js / gate.js 读完 `?secret=` / `#tool=` 会调
  // history.replaceState 清理地址栏，抹完这个参数就没了。这里跟别的脚本一样顺序加载。
  var LISTEN_HINT = readListenHint();

  /**
   * 打开页面时调一次：不读存档，传进来的 state 就是 defaultState() 那份出厂默认，这里一个键
   * 都不覆盖（节点本来就不落盘，整份配置每次从零开始）；顺手删掉老访客浏览器里那份旧存档。
   * 唯一要贴的是宿主的部署时默认值（LuCI 带进来的 `?listen=`），它跟「上次的存档」无关。
   */
  function loadSettings(state) {
    try { root.localStorage.removeItem(STORAGE_KEY); } catch (e) { /* 隐私模式 / 被禁用，无所谓 */ }
    applyListenHint(state);
  }

  MH.APP_VERSION = APP_VERSION;
  MH.MODES = MODES;
  MH.STORAGE_KEY = STORAGE_KEY;
  MH.defaultState = defaultState;
  /**
   * 把「一次粘进来的一串目标」拆成一条条：用户在自定义规则那格一次贴好几个域名，这里按
   * 换行、逗号、分号、空白（中英文标点都算）切开 —— 域名 / IP / CIDR 里不会出现这些。
   * 注意：单行 `<input>` 的 value 里换行早被浏览器吃掉了，所以 ui.js 那边还得在 `paste`
   * 事件里先用 clipboardData 拿原始文本。
   */
  function splitRuleTargets(text) {
    return String(text == null ? '' : text)
      .split(/[\s,;，；、]+/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
  }

  MH.nodeKey = nodeKey;
  MH.addNodes = addNodes;
  MH.splitRuleTargets = splitRuleTargets;
  MH.loadSettings = loadSettings;
  MH.applyListenHint = applyListenHint;
  MH.readListenHint = readListenHint;
})(typeof globalThis !== 'undefined' ? globalThis : this);
