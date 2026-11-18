import { describe, expect, test } from 'bun:test';
import { loadCore, loadFixtures } from '../helpers/load.mjs';

const MH = loadCore();
const fx = loadFixtures();

describe('YAML 标量序列化（对齐基线）', () => {
  test('_g_scalar 只在会被误读时加引号', () => {
    for (const [k, v] of Object.entries(fx.scalar)) expect(MH.gScalar(k)).toBe(v);
    const types = fx.scalar_types;
    expect(MH.gScalar(true)).toBe(types[0]);
    expect(MH.gScalar(false)).toBe(types[1]);
    expect(MH.gScalar(null)).toBe(types[2]);
    expect(MH.gScalar(9090)).toBe(types[3]);
    expect(MH.gScalar(1.5)).toBe(types[4]);
  });

  test('官方字段顺序表完整', () => {
    for (const [type, order] of Object.entries(fx.documented_order)) {
      expect(MH.DOC_KEY_ORDER[type]).toEqual(order);
    }
  });
});

describe('节点渲染（对齐基线）', () => {
  test('每个节点逐字段输出一致', () => {
    for (const [name, lines] of Object.entries(fx.proxy_yaml)) {
      const node = fx.parsed_nodes.find((p) => p.name === name);
      expect(MH.proxyToYaml(node, true)).toEqual(lines);
    }
  });

  test('节点域名提取', () => {
    for (const [name, domains] of Object.entries(fx.proxy_yaml_node_domains)) {
      const node = fx.parsed_nodes.find((p) => p.name === name);
      expect(MH.extractDomains([node])).toEqual(domains);
    }
  });

  test('渲染出来的每一行都是安全标量（注入防护）', () => {
    // 名字里带引号 / 逗号 / 换行的节点：yq 必须把换行转义掉，不能越出标量
    const nasty = fx.parsed_nodes.find((p) => p.name.indexOf('hasquote') !== -1);
    const lines = MH.proxyToYaml(nasty, true);
    // 名字行必须是单独一行、带引号的完整标量，不能越出标量
    expect(lines[0]).toBe('  - name: "hasquote commaand-newline"');
    expect(lines.join('\n').indexOf('\n  - name:')).toBe(-1);
  });
});

// ─────────────────────────────────────────────────────────────
// 下面这些是官网有、但很容易漏掉的字段（基线里的节点不带这些键，所以没有
// 对应用例），单独立钉。设计原则：**源里有才输出**，不发明默认值 ——
// 这样订阅里带的设置不会被静默丢掉，现有配置的产物也不会变。
// ─────────────────────────────────────────────────────────────
describe('节点渲染：容易漏掉的官网字段', () => {
  const linesOf = (node) => MH.proxyToYaml(Object.assign({ name: 'n' }, node), false);
  const yOf = (node) => linesOf(node).join('\n');
  const at = (node, key) => linesOf(node).findIndex((l) => l.trim().indexOf(key + ':') === 0);
  const parsed = (node) =>
    MH.yamlLoad('proxies:\n' + yOf(node) + '\n').proxies[0];

  test('wireguard：三个字段的顺序跟官网（persistent-keepalive → udp → mtu）', () => {
    const n = {
      type: 'wireguard', server: 'wg.example.com', port: 2408,
      private_key: 'PK', public_key: 'PUB', reserved: '1,2,3',
      keepalive: 25, mtu: 1420,
    };
    expect(at(n, 'reserved')).toBeLessThan(at(n, 'persistent-keepalive'));
    expect(at(n, 'persistent-keepalive')).toBeLessThan(at(n, 'udp'));
    expect(at(n, 'udp')).toBeLessThan(at(n, 'mtu'));
  });

  test('wireguard：allowed-ips / ip-stack / dialer-proxy / remote-dns-resolve / dns 能带出来', () => {
    const n = {
      type: 'wireguard', server: 'wg.example.com', port: 2408,
      private_key: 'PK', public_key: 'PUB',
      allowed_ips: ['0.0.0.0/0'], ip_stack: { mode: 'auto', 'congestion-controller': 'cubic' },
      dialer_proxy: 'ss1', remote_dns_resolve: true, dns: ['1.1.1.1', '8.8.8.8'],
    };
    const d = parsed(n);
    expect(d['allowed-ips']).toEqual(['0.0.0.0/0']);
    expect(d['ip-stack']).toEqual({ mode: 'auto', 'congestion-controller': 'cubic' });
    expect(d['dialer-proxy']).toBe('ss1');
    expect(d['remote-dns-resolve']).toBe(true);
    expect(d.dns).toEqual(['1.1.1.1', '8.8.8.8']);
    // 官网把 allowed-ips 排在 public-key 之后、pre-shared-key 之前
    expect(at(n, 'public-key')).toBeLessThan(at(n, 'allowed-ips'));
    // dialer-proxy / remote-dns-resolve / dns 排在 mtu 之后
    expect(at(n, 'mtu')).toBeLessThan(at(n, 'dialer-proxy'));
  });

  test('wireguard：Clash YAML 的 kebab-case 键也能认', () => {
    const d = parsed({
      type: 'wireguard', server: 'wg.example.com', port: 2408,
      'private-key': 'PK', 'public-key': 'PUB',
      'allowed-ips': ['10.0.0.0/8'], 'persistent-keepalive': 25,
      'dialer-proxy': 'ss1',
    });
    expect(d['allowed-ips']).toEqual(['10.0.0.0/8']);
    expect(d['persistent-keepalive']).toBe(25);
    expect(d['dialer-proxy']).toBe('ss1');
  });

  test('ss：Clash YAML 的 plugin-opts（kebab）不能丢', () => {
    // ⚠️ 丢了它内核会报 `obfs mode error: `，整份配置拒载。
    const d = parsed({
      type: 'ss', server: 's.example.com', port: 8388, cipher: 'aes-256-gcm',
      password: 'pw', plugin: 'obfs', 'plugin-opts': { mode: 'http', host: 'bing.com' },
    });
    expect(d.plugin).toBe('obfs');
    expect(d['plugin-opts']).toEqual({ mode: 'http', host: 'bing.com' });

    // 原生布尔 / 数字值不能被写成 "True" / "2" 这种字符串
    const v = parsed({
      type: 'ss', server: 's.example.com', port: 8388, cipher: 'aes-256-gcm',
      password: 'pw', plugin: 'v2ray-plugin', 'plugin-opts': { mode: 'websocket', tls: true, mux: 2 },
    });
    expect(v['plugin-opts']).toEqual({ mode: 'websocket', tls: true, mux: 2 });
  });

  test('Clash YAML 的其余 kebab / 嵌套键也要带出来', () => {
    // ssr
    let d = parsed({
      type: 'ssr', server: 'r.example.com', port: 8388, cipher: 'aes-256-cfb',
      password: 'pw', obfs: 'plain', protocol: 'origin',
      'obfs-param': 'o', 'protocol-param': 'p',
    });
    expect(d['obfs-param']).toBe('o');
    expect(d['protocol-param']).toBe('p');

    // trojan 的 ss-opts
    d = parsed({
      type: 'trojan', server: 't.example.com', port: 443, password: 'pw',
      'ss-opts': { enabled: true, method: 'aes-128-gcm', password: 'sp' },
    });
    expect(d['ss-opts']).toEqual({ enabled: true, method: 'aes-128-gcm', password: 'sp' });

    // vmess 的 h2-opts / http-opts
    d = parsed({
      type: 'vmess', server: 'v.example.com', port: 443, uuid: 'u', tls: true,
      network: 'h2', 'h2-opts': { host: ['a.com', 'b.com'], path: '/h2' },
    });
    expect(d['h2-opts']).toEqual({ host: ['a.com', 'b.com'], path: '/h2' });
    d = parsed({
      type: 'vmess', server: 'v.example.com', port: 443, uuid: 'u',
      network: 'http', 'http-opts': { method: 'POST', path: ['/x'], headers: { Host: ['h.com'] } },
    });
    expect(d['http-opts'].method).toBe('POST');
    expect(d['http-opts'].path).toBe('/x');

    // vless 的 xhttp-opts + 原生 servername
    d = parsed({
      type: 'vless', server: 'x.example.com', port: 443, uuid: 'u', tls: true,
      servername: 'x.example.com',
      network: 'xhttp', 'xhttp-opts': { path: '/xp', host: 'xh.com', mode: 'auto' },
    });
    expect(d['xhttp-opts']).toEqual({ path: '/xp', host: 'xh.com', mode: 'auto' });
    expect(d.servername).toBe('x.example.com');

    // vless 顶层 ws-headers / reality 的 support-x25519mlkem768
    d = parsed({
      type: 'vless', server: 'w.example.com', port: 443, uuid: 'u', tls: true,
      network: 'ws', 'ws-opts': { path: '/w' }, 'ws-headers': { Host: 'wh.com' },
      'reality-opts': {
        'public-key': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        'support-x25519mlkem768': true,
      },
    });
    expect(d['ws-opts']).toEqual({ path: '/w', headers: { Host: 'wh.com' } });
    expect(d['reality-opts']['support-x25519mlkem768']).toBe(true);

    // vless 的 h2 传输
    d = parsed({
      type: 'vless', server: 'h.example.com', port: 443, uuid: 'u', tls: true,
      network: 'h2', 'h2-opts': { host: ['a.com', 'b.com'], path: '/vh2' },
    });
    expect(d['h2-opts']).toEqual({ host: ['a.com', 'b.com'], path: '/vh2' });

    // vmess 原生 alterId / cipher
    d = parsed({
      type: 'vmess', server: 'v.example.com', port: 443, uuid: 'u',
      alterId: 64, cipher: 'zero',
    });
    expect(d.alterId).toBe(64);
    expect(d.cipher).toBe('zero');

    // hysteria2 / hysteria / tuic / wireguard 的 kebab 键
    d = parsed({
      type: 'hysteria2', server: 'h.example.com', port: 443, password: 'pw',
      'hop-interval': '30', 'obfs-password': 'op', 'bbr-profile': 'bbr',
    });
    expect(d['hop-interval']).toBe('30');
    expect(d['obfs-password']).toBe('op');
    expect(d['bbr-profile']).toBe('bbr');

    // 只写 ports 的 hysteria2：不能输出 `port: None`
    d = parsed({ type: 'hysteria2', server: 'h.example.com', password: 'p', ports: '443-8443' });
    expect(d.port).toBeUndefined();
    expect(d.ports).toBe('443-8443');
    d = parsed({
      type: 'hysteria', server: 'h.example.com', port: 443,
      'auth-str': 'a', 'fast-open': true,
    });
    expect(d['auth-str']).toBe('a');
    expect(d['fast-open']).toBe(true);
    d = parsed({
      type: 'tuic', server: 'u.example.com', port: 443, uuid: 'u', password: 'pw',
      'heartbeat-interval': 10, 'udp-relay-mode': 'quic',
      'congestion-controller': 'bbr', 'max-udp-relay-packet-size': 1500,
    });
    expect(d['heartbeat-interval']).toBe(10);
    expect(d['udp-relay-mode']).toBe('quic');
    expect(d['congestion-controller']).toBe('bbr');
    expect(d['max-udp-relay-packet-size']).toBe(1500);
    d = parsed({
      type: 'wireguard', server: 'w.example.com', port: 2408,
      'private-key': 'PK', 'public-key': 'PUB', 'pre-shared-key': 'PSK',
      'amnezia-wg-option': { jc: 4, jmin: 40 },
    });
    expect(d['pre-shared-key']).toBe('PSK');
    expect(d['amnezia-wg-option']).toEqual({ jc: 4, jmin: 40 });

    // TUIC：只写 token 的 YAML 节点按 v4 渲染（否则 token 被丢掉、节点报废）
    d = parsed({ type: 'tuic', server: 'u.example.com', port: 443, token: 'tk' });
    expect(d.token).toBe('tk');
    expect(d.uuid).toBeUndefined();
  });

  test('snell：udp / reuse / client-fingerprint + obfs-opts 的 shadow-tls 子键', () => {
    const n = {
      type: 'snell', server: 's.example.com', port: 443, psk: 'PSK', version: 4,
      udp: true, reuse: true, fp: 'chrome',
      obfs_opts: { mode: 'shadow-tls', host: 'b.com', password: 'P', version: 2, alpn: ['h2'] },
    };
    const d = parsed(n);
    expect(d.udp).toBe(true);
    expect(d.reuse).toBe(true);
    expect(d['client-fingerprint']).toBe('chrome');
    expect(d['obfs-opts']).toEqual({
      mode: 'shadow-tls', host: 'b.com', password: 'P', version: 2, alpn: ['h2'],
    });
    // 官网顺序：psk → version → udp → obfs-opts
    expect(at(n, 'psk')).toBeLessThan(at(n, 'version'));
    expect(at(n, 'version')).toBeLessThan(at(n, 'udp'));
    expect(at(n, 'udp')).toBeLessThan(at(n, 'obfs-opts'));
  });

  test('snell v6：顶层 mode 要写出来，且 v6 不写 obfs-opts（内核会拒载）', () => {
    const v6 = {
      type: 'snell', server: 's.example.com', port: 443, psk: 'PSK1234567890',
      version: 6, mode: 'unsafe-raw', udp: true,
    };
    const y = yOf(v6);
    expect(y).toContain('version: 6');
    expect(y).toContain('mode: unsafe-raw');
    expect(at(v6, 'version')).toBeLessThan(at(v6, 'mode'));

    // v6 带 tls/http obfs ⇒ mihomo 直接报 "version 6 does not support obfs mode"
    const y6o = yOf({ ...v6, obfs_opts: { mode: 'http', host: 'b.com' }, obfs: 'http' });
    expect(y6o).not.toContain('obfs-opts');

    // v4 照旧
    const v4 = { type: 'snell', server: 's.example.com', port: 443, psk: 'p', version: 4, obfs_opts: { mode: 'http', host: 'b.com' } };
    expect(yOf(v4)).toContain('obfs-opts');
    expect(yOf(v4)).not.toContain('mode: unsafe-raw');
  });

  const FP = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:' +
    'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';

  test('vmess / vless：fingerprint 排在 client-fingerprint 之前', () => {
    for (const type of ['vmess', 'vless']) {
      const n = {
        type, server: 's.example.com', port: 443, tls: true,
        uuid: 'u', fingerprint: FP, fp: 'chrome',
      };
      const d = parsed(n);
      // 冒号去掉、转小写（mihomo 的 ca.NewFingerprintVerifier 自己也会去冒号）
      expect(d.fingerprint, type).toBe(FP.replace(/:/g, '').toLowerCase());
      expect(d['client-fingerprint'], type).toBe('chrome');
      expect(at(n, 'fingerprint'), type).toBeLessThan(at(n, 'client-fingerprint'));
    }
  });

  test('trojan：fingerprint 排在 client-fingerprint 之后（官网这两处反过来）', () => {
    const n = {
      type: 'trojan', server: 's.example.com', port: 443, password: 'pw',
      fingerprint: FP, fp: 'chrome',
    };
    expect(parsed(n).fingerprint).toBe(FP.replace(/:/g, '').toLowerCase());
    expect(at(n, 'client-fingerprint')).toBeLessThan(at(n, 'fingerprint'));
  });

  test('非法 fingerprint 直接不写（内核会整份拒载）', () => {
    for (const type of ['trojan', 'socks5']) {
      for (const bad of ['AA:BB', 'deadbeef', 'zz'.repeat(32), '']) {
        const n = {
          type, server: 's.example.com', port: 443, password: 'pw',
          tls: true, fingerprint: bad,
        };
        expect(parsed(n).fingerprint, type + ' ' + JSON.stringify(bad)).toBeUndefined();
      }
    }
  });

  test('ss：udp-over-tcp 排在 udp 之后、plugin / ip-version 之前', () => {
    const n = {
      type: 'ss', server: 's.example.com', port: 8388, cipher: 'aes-128-gcm',
      password: 'pw', udp_over_tcp: true, udp_over_tcp_version: 2, plugin: 'obfs',
      plugin_opts: { mode: 'tls' },
    };
    const d = parsed(n);
    expect(d['udp-over-tcp']).toBe(true);
    expect(d['udp-over-tcp-version']).toBe(2);
    expect(at(n, 'udp')).toBeLessThan(at(n, 'udp-over-tcp'));
    expect(at(n, 'udp-over-tcp-version')).toBeLessThan(at(n, 'plugin'));
  });

  test('hysteria / hysteria2：name-cert-verify 紧跟 skip-cert-verify', () => {
    for (const type of ['hysteria', 'hysteria2']) {
      const n = {
        type, server: 's.example.com', port: 443,
        auth_str: 'a', password: 'p', insecure: true, name_cert_verify: 'c.example.com',
      };
      expect(parsed(n)['name-cert-verify'], type).toBe('c.example.com');
      expect(at(n, 'skip-cert-verify'), type).toBeLessThan(at(n, 'name-cert-verify'));
    }
  });

  test('源里没有就一个字都不输出（不发明默认值）', () => {
    expect(yOf({ type: 'wireguard', server: 's', port: 1, private_key: 'a', public_key: 'b' }))
      .not.toContain('allowed-ips');
    expect(yOf({ type: 'snell', server: 's', port: 1, psk: 'a' })).not.toContain('reuse');
    expect(yOf({ type: 'ss', server: 's', port: 1, cipher: 'aes-128-gcm', password: 'p' }))
      .not.toContain('udp-over-tcp');
    expect(yOf({ type: 'hysteria2', server: 's', port: 1, password: 'p' }))
      .not.toContain('name-cert-verify');
  });
});

describe('通用透传：数组套 map 的缩进', () => {
  test('生成的 YAML 能解析，结构不变', () => {
    const lines = MH.proxyToYaml({
      name: 'G', type: 'weird', opts: [{ a: 1, b: 2 }, { c: 3 }],
    }, false);
    const d = MH.yamlLoad(lines.join('\n'));
    expect(d[0].opts).toEqual([{ a: 1, b: 2 }, { c: 3 }]);
  });
});
