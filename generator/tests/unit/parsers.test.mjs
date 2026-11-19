import { describe, expect, test } from 'bun:test';
import { loadCore, loadFixtures } from '../helpers/load.mjs';

const MH = loadCore();
const fx = loadFixtures();

describe('IP 规则：内网按来源、公网按目标', () => {
  const mk = () => {
    const eng = new MH.SplitEngine();
    eng.proxies = [{ name: 'A', type: 'trojan', server: 'h.example.com', port: 443, password: 'p' }];
    eng.secret = '123456'; eng.port = 9090; eng.default_node = 'A';
    return eng;
  };
  const lineOf = (target) => {
    const e = mk();
    e.custom_rules = [{ target: target, action: 'A' }];
    return (e.generate().split('\n').find((l) => /CIDR/.test(l)) || '').trim();
  };

  test('内网 IPv4 走 SRC-IP-CIDR', () => {
    expect(lineOf('192.168.100.50')).toBe('- SRC-IP-CIDR,192.168.100.50/32,A,no-resolve');
    expect(lineOf('10.0.0.0/8')).toBe('- SRC-IP-CIDR,10.0.0.0/8,A,no-resolve');
  });

  test('公网 IPv4 走 IP-CIDR', () => {
    expect(lineOf('8.8.8.8')).toBe('- IP-CIDR,8.8.8.8/32,A,no-resolve');
  });

  test('内网 IPv6 走 SRC-IP-CIDR，公网 IPv6 走 IP-CIDR6', () => {
    expect(lineOf('fd00::1')).toBe('- SRC-IP-CIDR,fd00::1/128,A,no-resolve');
    expect(lineOf('2408:8000::1')).toBe('- IP-CIDR6,2408:8000::1/128,A,no-resolve');
  });
});

describe('IPv6 私网判定按数值（不靠前缀正则）', () => {
  test('fc:: / fc0:: / fcd:: / fe8:: 是全球单播，不是内网', () => {
    for (const v of ['fc::1', 'fc0::1', 'fcd::1', 'fe8::1']) {
      expect(MH.isPrivateCidr(v)).toBe(false);
    }
    for (const v of ['fd00::1', 'fdff::1', 'fe80::1', 'febf::1', '::1']) {
      expect(MH.isPrivateCidr(v)).toBe(true);
    }
  });

  test('带方括号的 IPv6 会被去掉括号后使用', () => {
    const e = new MH.SplitEngine();
    e.proxies = [{ name: 'A', type: 'trojan', server: 'h.example.com', port: 443, password: 'p' }];
    e.secret = '1'; e.port = 9090; e.default_node = 'A';
    e.custom_rules = [{ target: '[fd00::1]', action: 'A' }];
    expect(e.generate()).toContain('SRC-IP-CIDR,fd00::1/128,A,no-resolve');
  });
});

describe('畸形 IP 不能进配置（回归保护）', () => {
  test('掩码越界 / 缺段 / 带端口都算不合法', () => {
    expect(MH.isValidCidr('192.168.1.1/33')).toBe(false);
    expect(MH.isValidCidr('fd00::1/129')).toBe(false);
    expect(MH.isValidCidr('192.168.100.50')).toBe(true);
    expect(MH.isValidCidr('fd00::1')).toBe(true);
    expect(MH.looksLikeBadIp('192.168/16')).toBe(true);
    expect(MH.looksLikeBadIp('10/8')).toBe(true);
    expect(MH.looksLikeBadIp('192.168.1.1:8080')).toBe(true);
    expect(MH.looksLikeBadIp('192.168.1.10')).toBe(false);
  });

  test('引擎把畸形私网输入丢掉，而不是写进 SRC-IP-CIDR', () => {
    const mk = () => {
      const e = new MH.SplitEngine();
      e.proxies = [{ name: 'A', type: 'trojan', server: 'h.example.com', port: 443, password: 'p' }];
      e.secret = '1'; e.port = 9090; e.default_node = 'A';
      return e;
    };
    for (const bad of ['fd00::1/129', '192.168.1.1/33', 'fd00::10-fd00::20']) {
      const e = mk();
      e.custom_rules = [{ target: bad, action: 'A' }];
      expect(e.generate()).not.toContain(bad);
    }
  });
});

describe('IP 段（a-b）展开成 CIDR', () => {
  test('classify 认得 IP 段', () => {
    expect(MH.classify('192.168.100.100-192.168.100.200')).toBe('ip');
    expect(MH.classify('not-a-range')).toBe('domain');
    // 起止反了：仍是 IP 形态（所以不会退化成一条 DOMAIN 死规则），但展开返回 null → 引擎丢弃
    expect(MH.classify('1.2.3.4-1.2.3.3')).toBe('ip');
    expect(MH.ipRangeToCidrs('1.2.3.4-1.2.3.3')).toBeNull();
  });

  test('最小 CIDR 展开', () => {
    expect(MH.ipRangeToCidrs('10.0.0.0-10.0.0.255')).toEqual(['10.0.0.0/24']);
    expect(MH.ipRangeToCidrs('1.2.3.4-1.2.3.4')).toEqual(['1.2.3.4/32']);
    expect(MH.ipRangeToCidrs('10.0.0.5-10.0.0.6')).toEqual(['10.0.0.5/32', '10.0.0.6/32']);
    // 2^31 块：掩码必须是 /1，不能因为位移溢出写成 /31
    expect(MH.ipRangeToCidrs('0.0.0.0-255.255.255.255')).toEqual(['0.0.0.0/1', '128.0.0.0/1']);
    expect(MH.ipRangeToCidrs('0.0.0.0-127.255.255.255')).toEqual(['0.0.0.0/1']);
    expect(MH.ipRangeToCidrs('0.0.0.0-63.255.255.255')).toEqual(['0.0.0.0/2']);
    expect(MH.ipRangeToCidrs('192.168.100.100-192.168.100.200')).toEqual([
      '192.168.100.100/30', '192.168.100.104/29', '192.168.100.112/28',
      '192.168.100.128/26', '192.168.100.192/29', '192.168.100.200/32',
    ]);
    // 垃圾输入不能在 classify 里变成 IP，也不能产出 0.0.0.0/32 这种越界规则
    expect(MH.ipRangeToCidrs('999.1.1.1-999.1.1.9')).toBeNull();
    expect(MH.classify('999.1.1.1-999.1.1.9')).toBe('domain');
  });

  test('展开结果必须对齐、且刚好覆盖原区间（不漏不越界）', () => {
    const toInt = (s) => s.split('.').reduce((a, x) => a * 256 + Number(x), 0);
    const cases = [
      ['192.168.100.100-192.168.100.200', '192.168.100.100', '192.168.100.200'],
      ['10.0.0.5-10.0.0.6', '10.0.0.5', '10.0.0.6'],
      ['192.168.1.1-192.168.1.255', '192.168.1.1', '192.168.1.255'],
    ];
    for (const [range, first, last] of cases) {
      const cidrs = MH.ipRangeToCidrs(range);
      let expectStart = toInt(first);
      for (const c of cidrs) {
        const [addr, maskStr] = c.split('/');
        const mask = Number(maskStr);
        const size = Math.pow(2, 32 - mask);
        const start = toInt(addr);
        expect(start % size).toBe(0);            // 对齐：任何解析器都不会把它挪到别的段
        expect(start).toBe(expectStart);         // 连续覆盖，不漏
        expectStart = start + size;
      }
      expect(expectStart - 1).toBe(toInt(last)); // 结尾正好是区间末尾，不越界
    }
  });

  test('引擎把 IP 段写成多条 IP-CIDR，而不是一条 DOMAIN', () => {
    const eng = new MH.SplitEngine();
    eng.proxies = [{ name: 'A', type: 'trojan', server: 'h.example.com', port: 443, password: 'p' }];
    eng.secret = '123456'; eng.port = 9090; eng.default_node = 'A';
    eng.direct_ips = ['192.168.100.100-192.168.100.100'];
    const t = eng.generate();
    expect(t).toContain('IP-CIDR,192.168.100.100/32,DIRECT,no-resolve');
    expect(t).not.toContain('DOMAIN,192.168.100.100-');
  });
});

describe('节点链接解析（对齐基线）', () => {
  test('parseAnyInput 纯链接文本', () => {
    expect(MH.parseAnyInput(fx.nodes_text)).toEqual(fx.parsed_nodes);
  });

  test('parseAnyInput Clash YAML 订阅', () => {
    expect(MH.parseAnyInput(fx.clash_yaml)).toEqual(fx.parsed_yaml_nodes);
  });

  test('parseAnyInput JSON 形式的 Clash 配置（界面收 .json）', () => {
    const json = JSON.stringify({ proxies: [{
      name: 'j', type: 'ss', server: '1.2.3.4', port: 8388,
      cipher: 'aes-256-gcm', password: 'p',
    }] });
    const n = MH.parseAnyInput(json);
    expect(n.length).toBe(1);
    expect(n[0].name).toBe('j');
    expect(n[0].server).toBe('1.2.3.4');
  });

  test('parseAnyInput base64 订阅（单层 / 双层）', () => {
    const s = fx.subscription;
    expect(MH.parseAnyInput(s.plain)).toEqual(s.parsed_plain);
    expect(MH.parseAnyInput(s.b64)).toEqual(s.parsed_b64);
    expect(MH.parseAnyInput(s.b64_double)).toEqual(s.parsed_b64_double);
  });

  test('经典 ss 的密码空格原样保留（只有 2022 才归一化）', () => {
    const b64 = (x) => Buffer.from(x, 'utf8').toString('base64');
    const n = MH.parseAnyInput('ss://' + b64('aes-256-gcm: pass ') + '@h.example.com:1#c');
    expect(n.length).toBe(1);
    expect(n[0].password).toBe(' pass ');
  });

  test('2022 密钥两端空白要去掉（链接与 YAML 两条路径）', () => {
    const k = Buffer.from(Array.from({length:16}, (_,i)=>i)).toString('base64');
    const link = MH.parseAnyInput('ss://2022-blake3-aes-128-gcm:' + encodeURIComponent(' ' + k + ' ') + '@h.example.com:1#a');
    expect(link[0].password).toBe(k);
    const yaml = 'proxies:\n  - name: y\n    type: ss\n    server: h.example.com\n    port: 1\n'
      + '    cipher: 2022-blake3-aes-128-gcm\n    password: " ' + k + ' : ' + k + ' "\n';
    const n = MH.parseAnyInput(yaml);
    expect(n.length).toBe(1);
    expect(n[0].password).toBe(k + ':' + k);
  });

  test('S-UI 的「服务器密钥:用户密钥」双段 2022 密钥要接受', () => {
    const k1 = Buffer.from(Array.from({length:16}, (_,i)=>i)).toString('base64');
    const k2 = Buffer.from(Array.from({length:16}, (_,i)=>i+16)).toString('base64');
    const link = 'ss://2022-blake3-aes-128-gcm:' + encodeURIComponent(k1 + ':' + k2) + '@h.example.com:29126#pair';
    const n = MH.parseAnyInput(link);
    expect(n.length).toBe(1);
    expect(n[0].password).toBe(k1 + ':' + k2);
    // 两段长度都不对时才丢
    const bad = MH.parseAnyInput('ss://2022-blake3-aes-128-gcm:' + encodeURIComponent('short:short') + '@h.example.com:1#bad');
    expect(bad.length).toBe(0);
  });

  test('Clash YAML 里的 2022 坏密钥同样被丢弃', () => {
    const bad = Buffer.from('shortkey').toString('base64');
    const yaml = 'proxies:\n  - name: b\n    type: ss\n    server: h.example.com\n'
      + '    port: 1\n    cipher: 2022-blake3-aes-128-gcm\n    password: "' + bad + '"\n';
    const n = MH.parseAnyInput(yaml);
    expect(n.length).toBe(0);
    expect(MH.badKeys()).toBe(1);
  });

  test('SS-2022 密钥长度不对的节点被丢弃并计数', () => {
    // 合法：16 字节密钥的 base64
    const good = Buffer.from(Array.from({length:16}, (_,i)=>i)).toString('base64');
    const ok = MH.parseAnyInput('ss://2022-blake3-aes-128-gcm:' + good + '@h.example.com:1#ok');
    expect(ok.length).toBe(1);
    // 非法：密钥只有 8 字节
    const bad = Buffer.from('shortkey').toString('base64');
    const n = MH.parseAnyInput('ss://2022-blake3-aes-128-gcm:' + bad + '@h.example.com:1#bad');
    expect(n.length).toBe(0);
    expect(MH.badKeys()).toBe(1);
  });

  test('SS 明文 userinfo 的百分号要解（2022-blake3 的密钥含 + / =）', () => {
    // 用真实 16 字节密钥：base64 里带 +、结尾带 =，整体百分号编码后塞进明文 userinfo
    const key = Buffer.from(Array(16).fill(0xfb)).toString('base64');
    expect(key).toContain('+');
    const enc = encodeURIComponent(key);
    const n = MH.parseAnyInput('ss://2022-blake3-aes-128-gcm:' + enc + '@h.example.com:29126#k');
    expect(n.length).toBe(1);
    expect(n[0].method).toBe('2022-blake3-aes-128-gcm');
    expect(n[0].password).toBe(key);
  });

  test('SS 密码不做二次解码（SIP002 里密码是原文）', () => {
    // base64("aes-128-gcm:pa%2Fss") —— 密码原文就是 pa%2Fss，不该变成 pa/ss
    const b64 = (x) => Buffer.from(x, 'utf8').toString('base64').replace(/=+$/, '');
    const n = MH.parseAnyInput('ss://' + b64('aes-128-gcm:pa%2Fss') + '@1.2.3.4:8388#ss');
    expect(n.length).toBe(1);
    expect(n[0].password).toBe('pa%2Fss');
  });

  test('密码里带 @ 不会被整条丢弃（按最后一个 @ 切）', () => {
    const n = MH.parseAnyInput('trojan://pa@ss@1.2.3.4:443#nodeB');
    expect(n.length).toBe(1);
    expect(n[0].password).toBe('pa@ss');
    expect(n[0].server).toBe('1.2.3.4');
  });

  test('SSR 的 IPv6 主机不会散架', () => {
    const b64 = (x) => Buffer.from(x, 'utf8').toString('base64').replace(/=+$/, '');
    const main = '[2001:db8::1]:443:origin:aes-256-cfb:plain:' + b64('pw');
    const n = MH.parseAnyInput('ssr://' + b64(main) + '#v6');
    expect(n.length).toBe(1);
    expect(n[0].server).toBe('2001:db8::1');
    expect(n[0].port).toBe(443);
  });

  test('同一节点不同备注只留一条', () => {
    const r = MH.parseAnyInput([
      'trojan://pw@1.2.3.4:443#A',
      'trojan://pw@1.2.3.4:443#B',
    ].join(String.fromCharCode(10)));
    expect(r.length).toBe(1);
  });

  test('parseAnyInput 无节点输入', () => {
    expect(MH.parseAnyInput('hello world, no nodes here')).toEqual(fx.subscription.parsed_empty);
    expect(MH.parseAnyInput('proxies:\n  - name: x\n   type: broken indent\n'))
      .toEqual(fx.subscription.parsed_broken_yaml);
  });

  test('splitHostPort', () => {
    const cases = ['h.com:8443', 'h.com', 'h.com/', '[::1]:8080',
      '[2001:db8::1]', 'h.com:8443/', 'h.com/sub', '1.2.3.4:abc',
      'hk.s-ui.com:2096/sub/ALL', '[::1]:8080/sub'];
    cases.forEach((input, i) => {
      expect(MH.splitHostPort(input, 443)).toEqual(fx.split_host_port[i]);
    });
  });

  test('classify / host_ok / looks_like_b64 / clean_name', () => {
    for (const [k, v] of Object.entries(fx.classify)) expect(MH.classify(k)).toBe(v);
    for (const [k, v] of Object.entries(fx.host_ok)) expect(MH.hostOk(k)).toBe(v);
    for (const [k, v] of Object.entries(fx.looks_like_b64)) expect(MH.looksLikeB64(k)).toBe(v);
    for (const [k, v] of Object.entries(fx.clean_name)) {
      expect(MH.cleanName(k === 'null' ? null : k, 'FB')).toBe(v);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 把「订阅地址」粘进粘贴框是个高频误操作 —— 它长得就像一条 http 代理链接。
// 带路径的一律要丢掉，绝不能静默变成一个连不上的假节点（顺带端口还被改成 443）。
// ─────────────────────────────────────────────────────────────
describe('订阅地址不会被当成节点', () => {
  test('带路径的 http(s) 地址一律丢弃', () => {
    for (const u of [
      'https://hk.s-ui.com:2096/sub/ALL',
      'http://panel.example.com:8080/sub?id=1',
      'https://example.com/api/v1/client/subscribe?token=SECRET',
    ]) {
      expect(MH.parseAnyInput(u), u).toEqual([]);
    }
  });

  test('端口那格不是数字时不能退回默认端口', () => {
    // 退回 443 会把路径从 host 里抹掉（`host` 变干净），底下 hostOk 就拦不住了。
    expect(MH.splitHostPort('hk.s-ui.com:2096/sub/ALL', 443))
      .toEqual(['hk.s-ui.com:2096/sub/ALL', 443]);
    expect(MH.splitHostPort('1.2.3.4:abc', 443)).toEqual(['1.2.3.4:abc', 443]);
    expect(MH.splitHostPort('[::1]:8080/sub', 443)).toEqual(['[::1]:8080/sub', 443]);
  });

  test('真正的 http 代理节点照常认（别误伤）', () => {
    const n = MH.parseAnyInput('http://user:pass@hp.example.com:8080?tls=true#HP')[0];
    expect(n.type).toBe('http');
    expect(n.server).toBe('hp.example.com');
    expect(n.port).toBe(8080);
  });

  test('裸 IPv6 带端口照常认，带冒号的域名照常拒（别误伤）', () => {
    expect(MH.hostOk('2001:db8::1')).toBe(true);
    expect(MH.splitHostPort('2001:db8::1:443', 443)).toEqual(['2001:db8::1', 443]);
    expect(MH.hostOk('example.com:8080')).toBe(false);
    expect(MH.hostOk('1.2.3.4:abc')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 面板（s-ui 等）生成的链接，密码里可能带没转义的 `#` —— URL 规则里 `#` 是
// "备注从这里开始"，于是 `pass#@host:port` 被切成两半、整条报废。
// 判据：正常链接里 `@` 一定在第一个 `#` 之前。
// ─────────────────────────────────────────────────────────────
describe('密码里未转义的 # 自动补转义', () => {
  // 用例：s-ui 生成的链接里密码带未转义的 `#`
  const LINK = 'http://YunJuDian:Maninngsyepiz1506#@nat.s-ui.com:63327'
    + '#%E5%B9%BF%E4%B8%9C%E7%A7%BB%E5%8A%A8';

  test('原样的链接能被修好并完整导入', () => {
    const n = MH.parseAnyInput(LINK);
    expect(n.length).toBe(1);
    expect(n[0].name).toBe('广东移动');          // 末尾那个 # 仍是备注分隔符
    expect(n[0].type).toBe('http');
    expect(n[0].server).toBe('nat.s-ui.com');   // 不是 "YunJuDian"
    expect(n[0].port).toBe(63327);              // 不是默认的 80
    expect(n[0].username).toBe('YunJuDian');
    expect(n[0].password).toBe('Maninngsyepiz1506#');
    expect(MH.hashRepairs()).toBe(1);
  });

  test('藏在 base64 订阅里的这种链接也修', () => {
    const b64 = Buffer.from(LINK, 'utf8').toString('base64');
    expect(MH.parseAnyInput(b64).length).toBe(1);
    expect(MH.hashRepairs()).toBe(1);
  });

  test('正常链接一个都不碰（别误伤）', () => {
    for (const c of [
      'trojan://pw@h.com:443#备注',
      'trojan://pw@h.com:443#user@example.com',   // 备注里带 @ 也不行
      'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ=@1.2.3.4:8388#NoPad',
      'trojan://pa%23ss@1.2.3.4:443#hash-in-pass', // 已经转义过的
      'trojan://p+s@1.2.3.4:443#plus-only',
    ]) {
      MH.parseAnyInput(c);
      expect(MH.hashRepairs(), c).toBe(0);
    }
  });

  test('没有 # 或没有 @ 的链接不动', () => {
    for (const c of ['trojan://pw@h.com:443', 'ss://YWVzLTEyOC1nY206cGFzcw==@1.2.3.4:8388#X']) {
      MH.parseAnyInput(c);
      expect(MH.hashRepairs(), c).toBe(0);
    }
  });
});

describe('刁钻输入（Python / JS 语义最容易分叉的地方）', () => {
  // 这 27 条不是"再挑几个协议"，而是专门挑 base64 补位、明文冒号、IPv6 主机、
  // 名字里的 emoji 与转义、密码里带 # / + / @、畸形 base64、空串这些
  // 两边实现容易不一致的场景。逐条比对解析结果。
  fx.edge_links.forEach((link, i) => {
    test(`edge: ${JSON.stringify(link.slice(0, 46))}`, () => {
      expect(MH.parseAnyInput(link)).toEqual(fx.edge_parsed[i]);
    });
  });
});

// 回归：端口范围与名字里的 '#'
describe('端口范围与名字里的 #', () => {
  test('端口 0 / 越界 的节点直接丢掉（内核按 uint16 解析，会整份拒载）', () => {
    for (const port of ['0', '65536', '99999']) {
      const u = `vless://a@1.2.3.4:${port}?type=ws&security=tls&sni=e.com#x`;
      expect(MH.parseAnyInput(u).length, u).toBe(0);
    }
  });

  test('正常端口照收', () => {
    const n = MH.parseAnyInput('vless://a@1.2.3.4:443?type=ws&security=tls&sni=e.com#x');
    expect(n.length).toBe(1);
    expect(n[0].port).toBe(443);
    const h = MH.parseAnyInput('vless://a@[2001:db8::1]:8443?type=ws&security=tls&sni=e.com#x');
    expect(h.length).toBe(1);
    expect(h[0].port).toBe(8443);
  });

  test('Clash YAML 里的越界端口同样丢掉', () => {
    const y = (port) => `proxies:\n  - name: x\n    type: ss\n    server: 1.2.3.4\n    port: ${port}\n    cipher: aes-256-gcm\n    password: p\n`;
    for (const port of ['0', '65536', '99999', '-1', 'abc']) {
      expect(MH.parseAnyInput(y(port)).length, String(port)).toBe(0);
    }
    expect(MH.parseAnyInput(y(443)).length).toBe(1);
    expect(MH.parseAnyInput(y('"8443"')).length).toBe(1);
    // 字符串形态统一归一成整数（`0443` 不能被内核按八进制读成 291）
    expect(MH.parseAnyInput(y('"443.0"'))[0].port).toBe(443);
    expect(MH.parseAnyInput(y('"0443"'))[0].port).toBe(443);
    expect(MH.parseAnyInput(y('true')).length).toBe(0);
  });

  test('hysteria2 只写 ports 的 YAML 不算废节点', () => {
    const y = (extra) => `proxies:\n  - name: h\n    type: hysteria2\n    server: h.example.com\n    password: p\n${extra}`;
    expect(MH.parseAnyInput(y('    ports: 443-8443\n')).length).toBe(1);
    // 别的类型没 port 就还是丢掉
    expect(MH.parseAnyInput(y('    ports: 443-8443\n').replace('hysteria2', 'trojan')).length).toBe(0);
  });

  test('名字里的「 #」会被清掉，规则行不会被 YAML 当注释截断', () => {
    const n = MH.parseAnyInput('vless://a@1.2.3.4:443?type=ws&security=tls&sni=e.com#HK%20%231');
    expect(n[0].name).toBe('HK 1');
  });

  test('名字里的「: 」会被清掉，规则行不会被 YAML 解析成 map', () => {
    // `- MATCH,US: 1x` 在 YAML 里是 map ⇒ mihomo 的 rules []string 反序列化失败
    const n = MH.parseAnyInput('vless://a@1.2.3.4:443?type=ws&security=tls&sni=e.com#US:%201x');
    expect(n[0].name).toBe('US 1x');
  });
});

describe('必填凭据与地址清洗（残链接不能拖垮整份配置）', () => {
  test('缺 uuid / 密码 / 公钥的节点直接丢掉', () => {
    const bad = [
      'vless://@a.com:443?type=ws',
      'vmess://eyJhZGQiOiJhLmNvbSIsInBvcnQiOiI0NDMiLCJpZCI6IiJ9',
      'wireguard://@wg.com:51820?publicKey=x',
      'trojan://@t.com:443',
    ];
    for (const u of bad) expect(MH.parseAnyInput(u), u).toEqual([]);
  });

  test('Clash YAML 里缺 uuid 的节点也丢掉', () => {
    const y = 'proxies:\n  - name: x\n    type: vless\n    server: a.com\n    port: 443\n';
    expect(MH.parseAnyInput(y)).toEqual([]);
  });

  test('server 里的引号直接拒（会截断 fake-ip-filter 的 YAML 标量）', () => {
    expect(MH.parseAnyInput("trojan://p@foo'bar.com:443")).toEqual([]);
  });

  test('query 参数只解一次码（%2520 不能被解成空格）', () => {
    const n = MH.parseAnyInput('vless://u@h.com:443?type=ws&security=tls&path=%2Ffoo%2520bar');
    expect(n[0].path).toBe('/foo%20bar');
  });

  test('面板密码里的反斜杠会被洗掉（写盘 CGI 不解 YAML 转义）', () => {
    expect(MH.cleanSecret('a\\b"c d')).toBe('abcd');
  });

  test('监听地址里误带的端口会被剥掉', () => {
    expect(MH.cleanListen('192.168.1.1:9090')).toBe('192.168.1.1');
    expect(MH.cleanListen('[::1]:9090')).toBe('::1');
    expect(MH.cleanListen('::1')).toBe('::1');
    expect(MH.cleanListen('0.0.0.0:9090')).toBe('0.0.0.0');
  });
});

describe('vmess 备注 / 保留名', () => {
  const b64 = (s) => Buffer.from(s).toString('base64').replace(/=+$/, '');
  const vmess = (remark) => 'vmess://' + b64(JSON.stringify({
    v: '2', ps: '', add: 'a.example.com', port: '443',
    id: '8f7c1d2e-1a2b-4c3d-9e8f-1234567890ab',
    net: 'ws', tls: 'tls', path: '/ws',
  })) + remark;

  test('vmess 带 #备注：不丢节点，备注当名字', () => {
    const n = MH.parseAnyInput(vmess('#MyName'));
    expect(n.length).toBe(1);
    expect(n[0].server).toBe('a.example.com');
    expect(n[0].name).toBe('MyName');
  });

  test('vmess 备注里带 @ 也不会把 base64 弄坏', () => {
    const n = MH.parseAnyInput(vmess('#name@example'));
    expect(n.length).toBe(1);
    expect(n[0].name).toBe('name@example');
  });

  test('节点名是内置动作（REJECT / DIRECT / GLOBAL）会被改名', () => {
    // 端口各不相同：这三个用例只关心「名字会不会被改名」，别被去重（同端口=同节点）吃掉
    const mk = (name, port) => 'ss://' + b64('aes-256-gcm:p') + '@1.2.3.4:' + port + '#' + name;
    const r = MH.parseAnyInput([mk('REJECT', 8388), mk('DIRECT', 8389), mk('GLOBAL', 8390)].join(String.fromCharCode(10)));
    expect(r.length).toBe(3);
    expect(r.every((x) => !/^(REJECT|DIRECT|GLOBAL)$/.test(x.name))).toBe(true);
  });
});

describe('Snell v6（mihomo 1.19.34）', () => {
  test('链接里的 version=6 / mode= 要带出来', () => {
    const n = MH.parseAnyInput('snell://PSK1234567890@1.2.3.4:443?version=6&mode=unshaped#n6');
    expect(n.length).toBe(1);
    expect(n[0].version).toBe(6);
    expect(n[0].mode).toBe('unshaped');
  });

  test('老链接（没有 mode）保持原样，不凭空冒出 mode', () => {
    const n = MH.parseAnyInput('snell://p@1.2.3.4:443?version=4&obfs=http#old');
    expect(n.length).toBe(1);
    expect(n[0].version).toBe(4);
    expect(n[0].mode).toBe('');
    expect(n[0].obfs).toBe('http');
  });
});

/**
 * Clash YAML 里 `type` 内核不认（漏写 / 新协议 / 机场写错）会让**整份配置**加载失败
 * —— 不是跳过那个节点。所以解析阶段就要挡掉，并数出来给界面提示。
 * 允许清单对齐 mihomo v1.19.32 adapter/parser.go 的 switch。
 */
describe('Clash YAML 的出站类型校验', () => {
  const yaml = [
    'proxies:',
    '  - {name: ok-ss, type: ss, server: 1.2.3.4, port: 8388, cipher: aes-256-gcm, password: p}',
    '  - {name: bad-type, type: hysteria3, server: 5.6.7.8, port: 443, password: p}',
    '  - {name: no-type, server: 9.9.9.9, port: 443, password: p}',
    '  - {name: new-masque, type: masque, server: m.example.com, port: 443}',
    '  - {name: st, type: shadowtls, server: s.example.com, port: 443, password: p}',
    '',
  ].join('\n');

  test('不认识的 type / 没写 type 的节点被丢掉，并计数', () => {
    const n = MH.parseAnyInput(yaml);
    expect(n.map((x) => x.name)).toEqual(['ok-ss', 'new-masque', 'st']);
    expect(MH.yamlDropped()).toBe(2);
  });

  test('全是坏类型时返回空（界面会提示真实原因，而不是"链接列表"）', () => {
    const n = MH.parseAnyInput('proxies:\n  - {name: x, type: hysteria3, server: a.com, port: 443}\n');
    expect(n).toEqual([]);
    expect(MH.yamlDropped()).toBe(1);
  });

  test('计数按每次导入重置（不会累加）', () => {
    MH.parseAnyInput(yaml);
    expect(MH.yamlDropped()).toBe(2);
    MH.parseAnyInput('proxies:\n  - {name: y, type: ss, server: a.com, port: 443, cipher: aes-256-gcm, password: p}\n');
    expect(MH.yamlDropped()).toBe(0);
  });
});
