import { describe, expect, test } from 'bun:test';
import { loadCore, loadFixtures } from '../helpers/load.mjs';

const MH = loadCore();
const fx = loadFixtures();
const proxies = fx.parsed_nodes;
const names = proxies.map((p) => p.name);

/** 复刻 bless.mjs 里 split_case 的默认装配（两边必须一致，否则基线对不上）。 */
function makeSplit(overrides = {}) {
  const eng = new MH.SplitEngine();
  eng.proxies = overrides._proxies || proxies;
  eng.secret = 'sk-test"quote';
  eng.port = 9090;
  eng.default_node = names[0];
  // 与 bless.mjs 的 splitCase 一样显式钉死 DNS 模式，不吃构造函数默认值
  eng.redir_host = true;
  for (const [k, v] of Object.entries(overrides)) {
    if (k === '_proxies') continue;
    eng[k] = v;
  }
  return eng;
}

describe('精准分流（对齐基线）', () => {
  const CASES = {
    'default-multi': {},
    'single-node': { default_node: names[0] },
    'auto-select': { auto_select: true, default_node: MH.SplitEngine.AUTO_GROUP },
    'auto-select-fixed-node': { auto_select: true },
    'auto-select-return': { auto_select: true, return_mode: true, default_node: MH.SplitEngine.AUTO_GROUP },
    'return-mode': { return_mode: true },
    'mainland': { mainland: true },
    'no-ipv6': { ipv6_enabled: false },
    'fake-ip': { redir_host: false },
    'fake-ip-no-ipv6': { redir_host: false, ipv6_enabled: false },
    'fake-ip-mainland': { redir_host: false, mainland: true },
    'fake-ip-return': { redir_host: false, return_mode: true },
    'no-webrtc': { webrtc_protect: false },
    'listen-127': { controller_listen: '127.0.0.1' },
    'stack-gvisor': { stack: 'gvisor' },
    'direct-rules': {
      direct_ips: ['1.1.1.1', '10.0.0.0/8', '2001:db8::1', '1.1.1.1'],
      direct_domains: ['a.com', '.b.com', 'a.com'],
    },
  };

  for (const c of fx.split) {
    test(`split: ${c.id}`, () => {
      if (c.id === 'one-node-split') {
        const eng = new MH.SplitEngine();
        eng.proxies = [proxies[0]];
        eng.secret = '123456';
        eng.default_node = proxies[0].name;
        eng.redir_host = true;                  // 同上：显式钉死
        expect(eng.generate()).toBe(c.yaml);
        return;
      }
      const overrides = CASES[c.id];
      expect(overrides, `缺少用例装配: ${c.id}`).toBeDefined();
      const eng = makeSplit(overrides);
      expect(eng.generate()).toBe(c.yaml);
    });
  }

  // 基线里那批用例都不设 custom_rules，所以这块单独立钉
  test('自定义规则：整块排在最前，重复条目去重', () => {
    const eng = makeSplit({
      custom_rules: [
        { target: 'a.com', action: names[0] },
        { target: 'a.com', action: names[0] },       // 重复，应去掉
        { target: '10.0.0.0/8', action: names[0] },
      ],
    });
    const y = eng.generate();
    expect(y).toContain('  # 定义 规则\n'
      + '  - DOMAIN,a.com,' + names[0] + '\n'
      + '  - SRC-IP-CIDR,10.0.0.0/8,' + names[0] + ',no-resolve'
      + '\n\n  # 内网 直连');
    expect((y.match(/DOMAIN,a\.com,/g) || []).length).toBe(1);
  });

  test('自定义规则：GEOIP 标签', () => {
    const y = makeSplit({
      custom_rules: [{ type: 'geoip', target: 'netflix', action: names[0] }],
    }).generate();
    expect(y).toContain('  # Net Flix\n  - GEOIP,netflix,' + names[0]);
  });

  test('自定义规则：一条都没有时不输出空挂的标题', () => {
    expect(makeSplit({}).generate()).not.toContain('# 定义 规则');
    expect(makeSplit({ custom_rules: [] }).generate()).not.toContain('# 定义 规则');
  });

  // 全局代理（界面上的一个勾选框，不是独立方案）—— 基线里没有对应用例，
  // 下面几条是它自己的行为钉。
  test('全局代理：分流规则全不出，只剩自定义规则 + 直连块 + MATCH', () => {
    const y = makeSplit({ global_mode: true }).generate();
    const tail = y.slice(y.indexOf('\nrules:') + 1);
    expect(tail).toContain('- MATCH,' + names[0]);
    expect(tail).not.toContain('GEOSITE,cn');
    expect(tail).not.toContain('GEOIP,CN');
    expect(tail).not.toContain('GEOSITE,geolocation-!cn');
    expect(tail).not.toContain('DOMAIN-KEYWORD,stun');   // WebRTC 那条也不出
  });

  test('全局代理：动作选直连的自定义规则不会被 MATCH 吞掉', () => {
    const y = makeSplit({
      global_mode: true,
      direct_ips: ['10.0.0.0/8'],
      direct_domains: ['a.com'],
    }).generate();
    const tail = y.slice(y.indexOf('\nrules:') + 1);
    expect(tail).toContain('- IP-CIDR,10.0.0.0/8,DIRECT,no-resolve');
    expect(tail).toContain('- DOMAIN,a.com,DIRECT');
    expect(tail).toContain('- MATCH,' + names[0]);       // MATCH 永远在最后
  });

  test('全局代理：出口跟着 default_node 走，不写死组名', () => {
    // 写死的话，autoSelect 关掉时 _skeleton 不建那个组，MATCH 就指向一个
    // 不存在的 proxy-group，mihomo 会拒绝加载。
    const y = makeSplit({ global_mode: true }).generate();
    expect(y).toContain('- MATCH,' + names[0]);
    expect(y).not.toContain('- MATCH,' + MH.SplitEngine.AUTO_GROUP);
    expect(y).not.toContain('proxy-groups:');             // 没勾智能选择就不该建组
  });
});

describe('一机一IP（对齐基线）', () => {
  for (const c of fx.oneip) {
    test(`oneip: ${c.id}`, () => {
      const eng = new MH.OneIPEngine();
      eng.proxies = c.node_count === 1 ? [proxies[0]] : proxies;
      eng.secret = 'oneip secret';
      eng.port = 9091;
      eng.network = c.params.network;
      eng.start_ip = c.params.start_ip;
      eng.ips_per_node = c.params.ips_per_node;
      for (const [k, v] of Object.entries(c.options)) eng[k] = v;
      expect(eng.generate()).toBe(c.yaml);
    });
  }

  test('oneip 参数报错与 Python 一致', () => {
    for (const e of fx.oneip_errors) {
      const eng = new MH.OneIPEngine();
      eng.proxies = e.id === 'no-nodes' ? [] : proxies;
      if (e.id === 'too-small-net') { eng.network = '192.168.100.0/30'; eng.ips_per_node = 3; }
      if (e.id === 'bad-net') eng.network = '192.168.100.999';
      if (e.id === 'net-too-few-octets') eng.network = '192.168';
      if (e.id === 'start-out-of-range') eng.start_ip = '192.168.200.1';
      if (e.id === 'start-overflow') eng.start_ip = '999';
      if (e.id === 'ipv6-net') eng.network = 'fd00::/64';
      if (e.id === 'exhausted') { eng.network = '192.168.100.0/29'; eng.start_ip = '1'; }
      let err = null;
      try { eng.generate(); } catch (ex) { err = ex.message; }
      expect(err, `用例 ${e.id} 的报错不匹配`).toBe(e.error);
    }
  });

  test('IP 分配预览', () => {
    const d = new MH.OneIPEngine();
    expect(d.ipPreview(proxies.slice(0, 3))).toBe(fx.ip_preview.default);
    const p2 = new MH.OneIPEngine();
    p2.ips_per_node = 2;
    expect(p2.ipPreview(proxies.slice(0, 3))).toBe(fx.ip_preview.per2);
    const none = new MH.OneIPEngine();
    let err = null;
    try { none.ipPreview([]); } catch (e) { err = e.message; }
    expect('ERROR: ' + err).toBe(fx.ip_preview.none);
  });
});

describe('生成的配置本身是合法 YAML', () => {
  test('三种模式的产物都能被 YAML 解析且 proxies 非空', () => {
    const cases = [];
    for (const c of fx.split) cases.push(['split:' + c.id, c.yaml]);
    for (const c of fx.oneip) cases.push(['oneip:' + c.id, c.yaml]);
    for (const [id, text] of cases) {
      const data = MH.yamlLoad(text);
      expect(data, id + ' 解析为空').toBeTruthy();
      expect(Array.isArray(data.proxies), id + ' 缺少 proxies').toBe(true);
      expect(data.proxies.length > 0, id + ' proxies 为空').toBe(true);
      expect(data.mode, id + ' 缺少 mode: rule').toBe('rule');
      for (const p of data.proxies) {
        expect(typeof p.name, id + ' 节点缺少 name').toBe('string');
        expect(typeof p.type, id + ' 节点缺少 type').toBe('string');
      }
    }
  });
});

// 界面「智能选择」下面那张成员框：勾掉的节点不进 fallback 测速组，
// 但节点本身、规则、其它引用一概不动（黑名单只管这一个组）。
describe('智能选择：成员黑名单（auto_select_exclude）', () => {
  const groupBlock = (yaml) => yaml.slice(yaml.indexOf('proxy-groups:'), yaml.indexOf('\nrules:'));

  test('勾掉的节点不进测速组，且没被引用就不写进配置', () => {
    const y = makeSplit({
      auto_select: true,
      default_node: MH.SplitEngine.AUTO_GROUP,
      auto_select_exclude: [names[1]]
    }).generate();
    const block = groupBlock(y);
    expect(block).toContain(names[0]);
    expect(block).toContain(names[2]);
    expect(block).not.toContain(names[1]);
    // 没被任何组 / 规则引用 → proxies 里也不出现
    expect(y).not.toContain('name: "' + names[1] + '"');
  });

  test('全勾掉：不生成组（默认出口由 buildConfig 改成直连）', () => {
    const y = makeSplit({
      auto_select: true,
      default_node: 'DIRECT',
      auto_select_exclude: names.slice()
    }).generate();
    expect(y).not.toContain('proxy-groups:');
    expect(y).toContain('- MATCH,DIRECT');
  });

  test('黑名单里有不存在的名字 = 跟没设一样（逐字相同）', () => {
    const base = makeSplit({ auto_select: true, default_node: MH.SplitEngine.AUTO_GROUP }).generate();
    const withGhost = makeSplit({
      auto_select: true,
      default_node: MH.SplitEngine.AUTO_GROUP,
      auto_select_exclude: ['不存在的节点']
    }).generate();
    expect(withGhost).toBe(base);
  });

  test('没开智能选择时黑名单不起作用', () => {
    const base = makeSplit({ default_node: names[0] }).generate();
    const withEx = makeSplit({ default_node: names[0], auto_select_exclude: [names[1]] }).generate();
    expect(withEx).toBe(base);
    expect(withEx).not.toContain('proxy-groups:');
  });
});


// 「广告拦截」（默认不勾）：勾了才加 rule-providers + 一条 RULE-SET。
describe('广告拦截：217heidai rule-provider（config 里只一条 RULE-SET）', () => {

  test('不勾：config 里没有 RULE-SET，也没有 rule-providers', () => {
    const y = makeSplit({ default_node: names[0] }).generate();
    expect(y).not.toContain('广告 拦截');
    expect(y).not.toContain('RULE-SET,');
    expect(y).not.toContain('rule-providers:');
    expect((y.match(/,REJECT$/gm) || []).length).toBe(0);
  });

  test('勾上：只有一个 rule-provider（217heidai），rules 只有一条 RULE-SET', () => {
    const y = makeSplit({ default_node: names[0], ad_block: true }).generate();
    expect(y).toContain('rule-providers:');
    expect(y).toContain('  adblock:');
    expect(y).toContain('    behavior: domain');
    expect(y).toContain('217heidai/adblockfilters@main/rules/adblockmihomo.mrs');
    expect(y).toContain('    format: mrs');
    expect(y).toContain('    interval: 28800');
    expect(y).toContain('./rules/adblock.mrs');
    expect(y).toContain('  - RULE-SET,adblock,REJECT');
    expect(y).not.toContain('hgfq');
    // rules 段里只有这一条 REJECT（明细在外部文件里）
    expect((y.match(/,REJECT$/gm) || []).length).toBe(1);
    // 排在内网直连之前（REJECT 要最先命中）
    expect(y.indexOf('# 广告 拦截')).toBeLessThan(y.indexOf('GEOIP,LAN,DIRECT'));
  });

});

// 回归：广告拦截在回国 / 全局两条分支也要真的落到 rules 里
describe('广告拦截：各分支都生效', () => {
  const hasRule = (y) => /^\s*-\s*RULE-SET,adblock,REJECT$/m.test(y);

  test('回国模式：provider 与 RULE-SET 同时存在', () => {
    const y = makeSplit({ default_node: names[0], ad_block: true, return_mode: true }).generate();
    expect(y).toContain('rule-providers:');
    expect(hasRule(y)).toBe(true);
  });

  test('全局代理：provider 与 RULE-SET 同时存在', () => {
    const y = makeSplit({ default_node: names[0], ad_block: true, global_mode: true }).generate();
    expect(y).toContain('rule-providers:');
    expect(hasRule(y)).toBe(true);
  });

  test('不勾时任何分支都不出 provider', () => {
    for (const extra of [{}, { return_mode: true }, { global_mode: true }]) {
      const y = makeSplit(Object.assign({ default_node: names[0] }, extra)).generate();
      expect(y).not.toContain('rule-providers:');
      expect(hasRule(y)).toBe(false);
    }
  });
});

// 回归：非法 IP / IPv6 监听地址
describe('输入校验的兜底', () => {
  test('自定义规则里的非法 IP 直接丢掉（别让内核整份拒载）', () => {
    const y = makeSplit({ custom_rules: [
      { target: '1.2.3.999', action: 'DIRECT' },
      { target: '10.0.0.0/8', action: 'DIRECT' },
    ] }).generate();
    expect(y).not.toContain('1.2.3.999');
    // 内网目标按来源匹配（设备级直连）
    expect(y).toContain('SRC-IP-CIDR,10.0.0.0/8,DIRECT,no-resolve');
  });

  test('监听地址是 IPv6 字面量时加方括号并加引号', () => {
    // ⚠️ 裸写 `[::1]:9090` 会被 YAML 当成 flow sequence，整份配置解析失败。
    const y = makeSplit({ controller_listen: '::1' }).generate();
    expect(y).toContain('external-controller: "[::1]:9090"');
    expect(MH.yamlLoad(y)['external-controller']).toBe('[::1]:9090');
  });
});
