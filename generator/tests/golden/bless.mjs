#!/usr/bin/env bun
/**
 * 重建 golden 基线 `tests/golden/fixtures.json`。
 *
 * 基线就是本项目自己的确定性输出：把 `app/core/*.js` 里所有确定性路径跑一遍导出成 JSON，
 * `tests/unit/*.test.mjs` 再拿它跟代码输出逐字节比对。
 *
 * 只有故意改了产物时才跑；平时跑 `bun test tests/unit`，它红了才轮到本脚本。⚠️ 跑本脚本 =
 * 宣布「现在这份输出就是对的」，所以跑完务必 `git diff tests/golden/fixtures.json` 看一遍：
 * 那个 diff 就是这次改动对产物的全部影响，多出来的任何一行都是意外。
 *
 *     bun tests/golden/bless.mjs
 *     git diff --stat tests/golden/fixtures.json
 *     bun test tests/unit
 *
 * 代码没改时跑它应当是空 diff（纯数字键的键序由 JS 决定，别去手工挪）。
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCore, ROOT } from '../helpers/load.mjs';

const MH = loadCore();

// ── 覆盖各协议的节点样本 ────────────────────────────────────────
const NODES_TEXT = [
  // ss: 老式 base64(method:pass)@host 与 SIP002 两种形态都测
  'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ=@1.2.3.4:8388#SS%20Legacy',
  'ss://YWVzLTI1Ni1jZmI6cHc@5.6.7.8:443?plugin=obfs-local%3Bobfs%3Dhttp%3Bobfs-host%3Db.com#SS-Plugin',
  // ssr
  'ssr://MS4yLjMuNDo4ODg4Om9yaWdpbjphZXMtMjU2LWNmYjpwbGFpbjpjR0Z6Y3c9PS8_b2Jmc3BhcmFtPSZybWFyaz1TU1I',
  // trojan(带 ws + sni)
  'trojan://tj-pass@9.9.9.9:443?sni=example.com&type=ws&host=h.com&path=%2Fws#Trojan-WS',
  // vmess(base64 JSON)
  'vmess://eyJ2IjoiMiIsInBzIjoiVk1lc3MtV1MiLCJhZGQiOiJ2LmV4YW1wbGUuY29tIiwicG9ydCI6IjQ0MyIsImlkIjoiMTExMTExMTEtMjIyMi0zMzMzLTQ0NDQtNTU1NTU1NTU1NTU1IiwiYWlkIjoiMCIsInNjeSI6ImF1dG8iLCJuZXQiOiJ3cyIsInRscyI6InRscyIsImhvc3QiOiJ2LmV4YW1wbGUuY29tIiwicGF0aCI6Ii9yYXkifQ==',
  // vless + reality + grpc
  'vless://22222222-3333-4444-5555-666666666666@v6.example.com:443?type=grpc&security=reality&sni=www.bing.com&fp=chrome&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&sid=abcd&serviceName=grpcsvc&flow=xtls-rprx-vision#VLESS-Reality',
  // vless + xhttp
  'vless://33333333-4444-5555-6666-777777777777@x.example.com:8443?type=xhttp&security=tls&sni=x.example.com&path=%2Fx&host=x.example.com&mode=auto#VLESS-XHTTP',
  // hysteria2(hy2 前缀 + obfs + pinSHA256)
  'hy2://hypass@h2.example.com:8443?sni=h2.example.com&insecure=1&obfs=salamander&obfs-password=op&pinSHA256=deadbeef#Hy2-Short',
  'hysteria2://hypass@h2b.example.com:443?alpn=h3&up=100%20Mbps&down=200%20Mbps#Hy2-Long',
  // hysteria(一代)
  'hysteria://hy1pass@h1.example.com:36712?peer=h1.example.com&insecure=1&up=50&down=100&protocol=udp&auth=hy1pass&alpn=h3&obfs=xplus#Hy1',
  // tuic v5(uuid:password) 与 v4(token)
  'tuic://44444444-5555-6666-7777-888888888888:tpass@t5.example.com:443?sni=t5.example.com&alpn=h3&congestion_control=bbr&udp_relay_mode=native#TuicV5',
  'tuic://tokenvalue@t4.example.com:443?sni=t4.example.com&allow_insecure=1#TuicV4',
  // wireguard(含 amnezia 字段)
  'wireguard://cHJpdmF0ZWtleXByaXZhdGVrZXlwcml2YXRla2V5cHJpdmF0ZQ==@wg.example.com:2408?publicKey=cHVibGlja2V5cHVibGlja2V5cHVibGlja2V5cHVibGlja2V5&ip=10.0.0.2%2F32&mtu=1420&reserved=1,2,3&jc=4&jmin=40&jmax=70&s1=30&h1=123#WG-Amnezia',
  // snell
  'snell://pskvalue@sn.example.com:443?version=4&obfs=http&host=sn.example.com#Snell',
  // http / https
  'http://user:pass@hp.example.com:8080?tls=true&sni=hp.example.com&skip-cert-verify=1#HTTP-TLS',
  'https://hu:hup@hs.example.com:443#HTTPS',
  // socks5
  'socks5://su:sp@so.example.com:1080?tls=1&skip-cert-verify=1#Socks5',
  // ssh(私钥)
  'ssh://root:toor@ssh.example.com:22?private-key=-----BEGIN%20OPENSSH%20PRIVATE%20KEY-----%0Axxx%0A-----END%20OPENSSH%20PRIVATE%20KEY-----#SSH',
  // shadowtls
  'shadowtls://stpass@st.example.com:443?version=3&sni=cloud.tencent.com&fp=chrome#ShadowTLS',
  // anytls(透传渲染)
  'anytls://atpass@at.example.com:443?sni=at.example.com&allowInsecure=1&fp=chrome#AnyTLS',
  // 边界:名字里有引号/逗号/换行; ws 只给 path 不给 host
  'vmess://eyJ2IjoiMiIsInBzIjoiTmFtZSIsImFkZCI6ImVkZ2UuZXhhbXBsZS5jb20iLCJwb3J0IjoiNDQzIiwiaWQiOiI5OTk5OTk5OS0yMjIyLTMzMzMtNDQ0NC01NTU1NTU1NTU1NTUiLCJhaWQiOiIwIiwic2N5IjoiYXV0byIsIm5ldCI6IndzIiwidGxzIjoidGxzIiwicGF0aCI6Ii9vbmx5LXBhdGgifQ==',
  // 名字含引号 / 逗号 / 换行 —— cleanName 与 YAML 转义的靶子
  'trojan://pw@7.7.7.7:443#has%22quote%22%2Ccomma%0Aand-newline',
  // 畸形/应被丢弃的行
  'https://example.com/sub?token=SECRET',
  'not-a-link',
  '# comment line',
].join('\n');

// 刁钻输入：不是"再挑几个协议"，而是专门挑那些 Python / JS 语义容易分叉的地方 ——
// 无 padding 的 base64、明文冒号、IPv6 主机、名字里的 emoji 与转义字符、
// 密码里带 # / + / @、畸形 base64、空值、应被丢弃的订阅地址。
const EDGE_CASES = [
  'ss://YWVzLTI1Ni1nY206cGFzcw@1.2.3.4:8388#NoPad',
  'ss://YWVzLTI1Ni1nY206cGFzcw==@1.2.3.4:8388#Padded',
  'ss://aes-256-gcm:plainpass@1.2.3.4:8388#PlainColon',
  'ss://cmVzLTMyOmFiYw@1.2.3.4:8388?plugin=obfs-local%3Bobfs%3Dhttp%3Bobfs-host%3Db.com#Plugin',
  'ss://YWVzLTI1Ni1nY206cGFzcw@[2001:db8::1]:8388#IPv6Host',
  'trojan://pw@1.2.3.4:443#%F0%9F%98%80%20emoji%E5%90%8D',
  'trojan://pw@1.2.3.4:443#a%2Cb%22c',
  'trojan://pa%23ss@1.2.3.4:443#hash-in-pass',
  'trojan://p+s@1.2.3.4:443#plus-only',
  'vmess://!!!!notbase64!!!!',
  'vmess://eyJhZGQiOiIxLjIuMy40IiwicG9ydCI6NDQzLCJpZCI6IngifQ',
  'vless://uuid@[::1]:443?type=ws&path=%2Fa%3Fb%3Dc#V6',
  'hysteria2://pw%25percent@h.com:443?sni=h.com#Pct',
  'hy2://pw@h.com:443?obfs=salamander&obfs-password=a%20b#Obfs',
  'tuic://uuid:pw@t.com:443#V5',
  'tuic://tok@t.com:443#V4',
  'tuic://:onlypw@t.com:443#EmptyUuid',
  'anytls://pa@ss@a.com:443?sni=a.com&allowInsecure=1#At',
  'ssh://u:p@h.com:22?private-key=KEY%0ALINE#SSH',
  'snell://psk@h.com:443?version=5&obfs=tls&host=x.com#Snell',
  'shadowtls://pw@h.com:443?sni=x.com&version=3&fp=firefox#ST',
  'http://u:p@h.com:8080?tls=true#HttpTls',
  'socks5://u:p@h.com:1080?tls=1&skip-cert-verify=1#S5',
  'https://sub.example.com/api?token=SECRET',
  'ss://',
  '   ',
  'ftp://x@y:21',
];

// base64 订阅(单层 / 双层),验证 looksLikeB64 + parseAnyInput 的解码分支
const SUB_LINKS = [
  'trojan://subpass@10.10.10.10:443#Sub-Node-1',
  'ss://YWVzLTEyOC1nY206c3VicGFzcw==@10.10.10.11:8443#Sub-Node-2',
].join('\n');

// ── Clash YAML 订阅(原生键名,含无 server 的组网类型) ──────────
const CLASH_YAML = `proxies:
  - name: YAML-ss
    type: ss
    server: y1.example.com
    port: 8388
    cipher: aes-256-gcm
    password: 'pw:with,colon'
    udp: true
    plugin: obfs
    plugin-opts:
      mode: http
      host: bing.com
    ip-version: ipv4-prefer
  - name: YAML-vmess
    type: vmess
    server: y2.example.com
    port: 443
    uuid: 12345678-1234-1234-1234-123456789012
    alterId: 0
    cipher: auto
    tls: true
    servername: y2.example.com
    network: ws
    ws-opts:
      path: /yamlpath
      headers:
        Host: y2.example.com
    skip-cert-verify: true
  - name: YAML-anytls-passthrough
    type: anytls
    server: y3.example.com
    port: 443
    password: anypass
    sni: y3.example.com
    udp: true
  - name: YAML-tailscale
    type: tailscale
    hostname: ts-node
    auth-key: tskey-xxx
`;

function buildFixtures() {
  const fx = {};

  // 1) 解析结果
  fx.nodes_text = NODES_TEXT;
  fx.clash_yaml = CLASH_YAML;
  const proxies = MH.parseAnyInput(NODES_TEXT);
  fx.parsed_nodes = proxies;
  fx.parsed_yaml_nodes = MH.parseAnyInput(CLASH_YAML);

  const b64 = Buffer.from(SUB_LINKS, 'utf8').toString('base64');
  const b64Double = Buffer.from(b64, 'utf8').toString('base64');
  fx.subscription = {
    plain: SUB_LINKS,
    b64: b64,
    b64_double: b64Double,
    parsed_plain: MH.parseAnyInput(SUB_LINKS),
    parsed_b64: MH.parseAnyInput(b64),
    parsed_b64_double: MH.parseAnyInput(b64Double),
    parsed_empty: MH.parseAnyInput('hello world, no nodes here'),
    parsed_broken_yaml: MH.parseAnyInput('proxies:\n  - name: x\n   type: broken indent\n'),
  };

  // 1b) 刁钻输入的解析结果（每条独立，不跨行去重，保持"这一条会解析成什么"）
  fx.edge_links = EDGE_CASES;
  fx.edge_parsed = EDGE_CASES.map((c) => MH.parseAnyInput(c));

  // 2) 每个节点的逐字段渲染
  fx.proxy_yaml = {};
  fx.proxy_yaml_node_domains = {};
  for (const p of proxies) {
    fx.proxy_yaml[p.name] = MH.proxyToYaml(p, true);
    fx.proxy_yaml_node_domains[p.name] = MH.extractDomains([p]);
  }

  // 3) SplitEngine 各种组合
  const names = proxies.map((p) => p.name);
  const splitCases = [];

  const splitCase = (caseId, kw = {}) => {
    const eng = new MH.SplitEngine();
    eng.proxies = kw._proxies === undefined ? proxies : kw._proxies;
    eng.secret = 'sk-test"quote';
    eng.port = 9090;
    eng.default_node = names[0];
    // DNS 模式显式钉死：用例应当是"确定的输入 → 确定的输出"，不依赖引擎构造函数
    // 的默认值 —— 否则哪天出厂值一翻（比如 redir-host → fake-ip），整个基线会
    // 整片移位，分不清是"渲染坏了"还是"默认值变了"。fake-ip 那几条各自 override。
    eng.redir_host = true;
    for (const [k, v] of Object.entries(kw)) {
      if (k !== '_proxies') eng[k] = v;
    }
    splitCases.push({ id: caseId, yaml: eng.generate() });
  };

  splitCase('default-multi');
  splitCase('single-node', { default_node: names[0] });
  // 默认出口指向测速组 —— 组名要用引擎里的常量，改一次名字不用改这里
  splitCase('auto-select', { auto_select: true, default_node: MH.SplitEngine.AUTO_GROUP });
  splitCase('auto-select-fixed-node', { auto_select: true });
  // 回国模式 + 智能选择：组体检地址要换成本地检查点（华为 204）
  splitCase('auto-select-return', { auto_select: true, return_mode: true, default_node: MH.SplitEngine.AUTO_GROUP });
  splitCase('return-mode', { return_mode: true });
  splitCase('mainland', { mainland: true });
  splitCase('no-ipv6', { ipv6_enabled: false });
  splitCase('fake-ip', { redir_host: false });
  splitCase('fake-ip-no-ipv6', { redir_host: false, ipv6_enabled: false });
  splitCase('fake-ip-mainland', { redir_host: false, mainland: true });
  splitCase('fake-ip-return', { redir_host: false, return_mode: true });
  splitCase('no-webrtc', { webrtc_protect: false });
  splitCase('listen-127', { controller_listen: '127.0.0.1' });
  splitCase('stack-gvisor', { stack: 'gvisor' });
  splitCase('direct-rules', {
    direct_ips: ['1.1.1.1', '10.0.0.0/8', '2001:db8::1', '1.1.1.1'],
    direct_domains: ['a.com', '.b.com', 'a.com'],
  });

  // 只有一个节点时的 split
  {
    const eng = new MH.SplitEngine();
    eng.proxies = [proxies[0]];
    eng.secret = '123456';
    eng.default_node = proxies[0].name;
    eng.redir_host = true;                      // 同上：显式钉死，不吃构造函数默认值
    splitCases.push({ id: 'one-node-split', yaml: eng.generate() });
  }
  fx.split = splitCases;

  // 4) OneIPEngine 各种组合
  const oneipCases = [];

  const oneipCase = (caseId, kw = {}) => {
    const eng = new MH.OneIPEngine();
    eng.proxies = kw._proxies === undefined ? proxies : kw._proxies;
    eng.secret = 'oneip secret';
    eng.port = 9091;
    eng.redir_host = true;                      // 同上：显式钉死，不吃构造函数默认值
    for (const [k, v] of Object.entries(kw)) {
      if (k !== '_proxies') eng[k] = v;
    }
    oneipCases.push({
      id: caseId,
      params: { network: eng.network, start_ip: eng.start_ip, ips_per_node: eng.ips_per_node },
      options: {
        anydesk: eng.anydesk, tg: eng.tg,
        return_mode: eng.return_mode, mainland: eng.mainland,
        redir_host: eng.redir_host, controller_listen: eng.controller_listen,
        direct_ips: eng.direct_ips.slice(),
        direct_domains: eng.direct_domains.slice(),
      },
      node_count: eng.proxies.length,
      yaml: eng.generate(),
    });
  };

  oneipCase('default');
  oneipCase('ips-per-node-2', { ips_per_node: 2 });
  oneipCase('start-offset-10', { start_ip: '10' });
  oneipCase('start-absolute', { start_ip: '192.168.100.50' });
  oneipCase('network-cidr', { network: '10.0.0.0/8' });
  oneipCase('network-slash24', { network: '192.168.100.0/24' });
  oneipCase('return-mode', { return_mode: true });
  oneipCase('mainland', { mainland: true });
  oneipCase('both-flags', { return_mode: true, mainland: true });
  oneipCase('anydesk-tg', { anydesk: true, tg: true, return_mode: true });
  oneipCase('fake-ip', { redir_host: false });
  oneipCase('listen-127', { controller_listen: '127.0.0.1' });
  oneipCase('direct', { direct_ips: ['1.1.1.1'], direct_domains: ['a.com'] });
  oneipCase('singleton', { _proxies: [proxies[0]] });
  fx.oneip = oneipCases;

  // 5) oneip 报错场景
  const errs = [];

  const oneipErr = (caseId, kw = {}) => {
    const eng = new MH.OneIPEngine();
    eng.proxies = proxies;
    for (const [k, v] of Object.entries(kw)) eng[k] = v;
    try {
      eng.generate();
      errs.push({ id: caseId, error: null });
    } catch (e) {
      errs.push({ id: caseId, error: String(e.message) });
    }
  };

  oneipErr('too-small-net', { network: '192.168.100.0/30', ips_per_node: 3 });
  oneipErr('bad-net', { network: '192.168.100.999' });
  oneipErr('net-too-few-octets', { network: '192.168' });
  oneipErr('start-out-of-range', { start_ip: '192.168.200.1' });
  oneipErr('start-overflow', { start_ip: '999' });
  oneipErr('ipv6-net', { network: 'fd00::/64' });
  oneipErr('exhausted', { network: '192.168.100.0/29', start_ip: '1' });

  {
    const eng = new MH.OneIPEngine();
    eng.proxies = [];
    try {
      eng.generate();
      errs.push({ id: 'no-nodes', error: null });
    } catch (e) {
      errs.push({ id: 'no-nodes', error: String(e.message) });
    }
  }
  fx.oneip_errors = errs;

  // 6) UI 辅助函数
  const previewOrError = (eng, nodes) => {
    try {
      return eng.ipPreview(nodes);
    } catch (e) {
      return 'ERROR: ' + e.message;
    }
  };

  {
    const previewDefault = new MH.OneIPEngine();
    const previewPer2 = new MH.OneIPEngine();
    previewPer2.ips_per_node = 2;
    const previewEmpty = new MH.OneIPEngine();
    fx.ip_preview = {
      default: previewOrError(previewDefault, proxies.slice(0, 3)),
      per2: previewOrError(previewPer2, proxies.slice(0, 3)),
      none: previewOrError(previewEmpty, []),
    };
  }

  fx.classify = {};
  for (const v of ['1.2.3.4', '1.2.3.4/24', '2001:db8::1', 'example.com', '', '  ']) {
    fx.classify[v] = MH.classify(v);
  }
  fx.clean_name = {};
  for (const v of ['a,b', 'a"b', 'a\nb', '  spaced  ', '', null, 'x'.repeat(200)]) {
    fx.clean_name[v] = MH.cleanName(v, 'FB');
  }
  fx.split_host_port = ['h.com:8443', 'h.com', 'h.com/', '[::1]:8080',
    '[2001:db8::1]', 'h.com:8443/', 'h.com/sub', '1.2.3.4:abc',
    'hk.s-ui.com:2096/sub/ALL', '[::1]:8080/sub']
    .map((x) => MH.splitHostPort(x, 443));
  fx.host_ok = {};
  for (const v of ['1.2.3.4', 'example.com', '', 'a/b', 'a b', '123', 'a?b', 'a#b']) {
    fx.host_ok[v] = MH.hostOk(v);
  }
  fx.looks_like_b64 = {};
  for (const v of ['aGVsbG8=', 'aGVsbG8', 'abc', '####', 'a'.repeat(40)]) {
    fx.looks_like_b64[v] = MH.looksLikeB64(v);
  }
  fx.scalar = {};
  for (const v of ['abc', '1.2.3.4', 'true', 'yes', 'null', 'a b', 'a:b', '-x',
    '123', '1.5', '', 'a\nb', 'Ünïcode', 'off', '~', 'none',
    'a-b_c.d/e', '.starts.with.dot']) {
    fx.scalar[v] = MH.gScalar(v);
  }
  fx.scalar_types = [MH.gScalar(true), MH.gScalar(false), MH.gScalar(null),
    MH.gScalar(9090), MH.gScalar(1.5)];
  fx.documented_order = {};
  for (const [k, v] of Object.entries(MH.DOC_KEY_ORDER)) fx.documented_order[k] = v;

  return fx;
}

const fx = buildFixtures();
const out = join(ROOT, 'tests', 'golden', 'fixtures.json');
const text = JSON.stringify(fx, null, 2) + '\n';
writeFileSync(out, text, 'utf8');

console.log('wrote ' + out + ' (' + Buffer.byteLength(text) + ' bytes)');
console.log(
  'parsed nodes: ' + fx.parsed_nodes.length +
  ' / yaml nodes: ' + fx.parsed_yaml_nodes.length +
  ' / split cases: ' + fx.split.length +
  ' / oneip cases: ' + fx.oneip.length
);
