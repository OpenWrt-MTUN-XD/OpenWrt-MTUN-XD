import { beforeEach, describe, expect, test } from 'bun:test';
import { loadCore, loadFixtures } from '../helpers/load.mjs';

const MH = loadCore();
const fx = loadFixtures();

/**
 * `MH.ui.buildConfig()` —— 把界面状态映射成引擎参数，再生成配置文本。
 *
 * 这是 ui.js 里唯一值得（也唯一能）在没有浏览器的环境下测的部分：纯函数，但干的事很重 ——
 * 模式分派 + 二十多项字段搬运 + 多节点时的默认出口/AI 节点推导。少搬一个字段（比如忘了
 * webrtc_protect）不会报错，只会静默生成一份不合预期的配置。
 * 每个用例都从干净状态开始：先 reset，再按需改字段。
 */
function reset(overrides = {}) {
  const s = MH.ui.state;
  // 出厂默认 adBlock 是关的；老用例都只关心自己那件事，这里统一关掉做隔离 —— 默认值本身另有用例盯着。
  Object.assign(s, MH.defaultState(), { adBlock: false });
  s.nodes = MH.parseAnyInput(fx.nodes_text);
  s.secret = '123456';
  s.port = 9090;
  Object.assign(s, overrides);
  return s;
}

const yamlOf = (s) => MH.yamlLoad(MH.ui.buildConfig());

describe('buildConfig：出厂默认', () => {
  test('广告拦截默认不勾：配置里没有 rule-providers / adblock 规则', () => {
    const s = MH.ui.state;
    Object.assign(s, MH.defaultState());
    s.nodes = MH.parseAnyInput(fx.nodes_text);
    s.secret = '123456';
    s.port = 9090;
    expect(s.adBlock).toBe(false);
    const text = MH.ui.buildConfig();
    expect(text).not.toContain('rule-providers:');
    expect(text).not.toContain('- RULE-SET,adblock,REJECT');
  });

  test('勾上广告拦截：rule-providers + 第一条规则都在', () => {
    const s = MH.ui.state;
    Object.assign(s, MH.defaultState(), { adBlock: true });
    s.nodes = MH.parseAnyInput(fx.nodes_text);
    s.secret = '123456';
    s.port = 9090;
    const text = MH.ui.buildConfig();
    expect(text).toContain('rule-providers:');
    expect(text).toContain('adblock:');
    expect(text).toContain('behavior: domain');
    expect(text).toContain('- RULE-SET,adblock,REJECT');
  });

  test('一机一IP 也吃广告拦截', () => {
    const s = reset({ mode: 'oneip' });
    s.adBlock = true;
    const text = MH.ui.buildConfig();
    expect(text).toContain('rule-providers:');
    expect(text).toContain('adblock:');
    expect(text).toContain('- RULE-SET,adblock,REJECT');
  });
});

describe('buildConfig：模式分派', () => {
  test('精准分流 + 目标固定⚡ → 生成 load-balance 组并作为默认出口', () => {
    const s = reset({ mode: 'split', autoSelect: true });
    const text = MH.ui.buildConfig();
    expect(text).toContain('  # 默认 代理\n  - MATCH,目标固定⚡');
    expect(text).toContain('- GEOSITE,cn,DIRECT');       // 国内照旧直连
    expect(text).toContain('proxy-groups:');
    expect(text).toContain('  - name: "目标固定⚡"');
    // load-balance：fallback 不叠加带宽；load-balance 才有多线路分担 + 坏节点自动剔除。
    expect(text).toContain('    type: load-balance');
    expect(text).toContain('    strategy: consistent-hashing');
    expect(text).toContain('    max-failed-times: 2');
    expect(text).toContain('    expected-status: 204');
    expect(s.nodes.length).toBeGreaterThan(2);
  });

  test('目标固定⚡组策略：默认 consistent-hashing，勾 round-robin 才变', () => {
    reset({ mode: 'split', autoSelect: true });
    expect(MH.ui.buildConfig()).toContain('    strategy: consistent-hashing');

    reset({ mode: 'split', autoSelect: true, autoRoundRobin: true });
    const text = MH.ui.buildConfig();
    expect(text).toContain('    strategy: round-robin');
    expect(text).not.toContain('consistent-hashing');
  });

  test('两个 round-robin 开关各管各的组', () => {
    const s = reset({ mode: 'split', autoSelect: true, autoRoundRobin: true });
    const names = s.nodes.map((n) => n.name);
    // 目标固定⚡成员不能进自定义规则的出口 —— 把这两个反选出去，再用它们建组
    s.autoSelectExclude = [names[0], names[1]];
    s.customRules = [{ target: 'example.com', actions: [names[0], names[1]] }];
    let strat = Object.fromEntries(yamlOf()['proxy-groups'].map((g) => [g.name, g.strategy]));
    expect(strat['轮询分摊⚡']).toBe('round-robin');       // 自动组：勾了
    expect(strat['目标固定🚀']).toBe('consistent-hashing'); // 自定义组：没勾

    s.autoRoundRobin = false;
    s.lbRoundRobin = true;
    strat = Object.fromEntries(yamlOf()['proxy-groups'].map((g) => [g.name, g.strategy]));
    expect(strat['目标固定⚡']).toBe('consistent-hashing');
    expect(strat['轮询分摊🚀']).toBe('round-robin');
  });

  test('目标固定⚡：成员只剩一个 → 不建组，默认出口直接指向该节点', () => {
    const s = reset({ mode: 'split', autoSelect: true });
    const names = s.nodes.map((n) => n.name);
    s.autoSelectExclude = names.slice(0, names.length - 1);
    const d = yamlOf();
    expect(d['proxy-groups']).toBeUndefined();
    expect(d.rules).toContain('MATCH,' + names[names.length - 1]);
    expect(MH.ui.buildConfig()).not.toContain('目标固定⚡');
  });

  test('目标固定⚡：成员只剩一个 + 全局代理 → MATCH 直接指向该节点', () => {
    const s = reset({ mode: 'split', autoSelect: true, globalProxy: true });
    const names = s.nodes.map((n) => n.name);
    s.autoSelectExclude = names.slice(0, names.length - 1);
    const d = yamlOf();
    const rules = d.rules;
    expect(rules[rules.length - 1]).toBe('MATCH,' + names[names.length - 1]);
    expect(rules).toContain('GEOIP,LAN,DIRECT,no-resolve');
    expect(rules).toContain('GEOSITE,private,DIRECT');
    expect(rules).toContain('DST-PORT,123,DIRECT');
    expect(d['proxy-groups']).toBeUndefined();
  });

  test('有组时自定义 GLOBAL：只放 DIRECT/REJECT，节点和组都不进 GLOBAL', () => {
    const s = reset({ mode: 'split', autoSelect: true });
    const d = yamlOf();
    const g = d['proxy-groups'].find((x) => x.name === 'GLOBAL');
    expect(g).toBeDefined();
    expect(g.type).toBe('select');
    // 不写 include-all-proxies：GLOBAL 里不该出现一长串节点
    expect(g['include-all-proxies']).toBeUndefined();
    expect(g.proxies).toEqual(['DIRECT', 'REJECT']);
    // 不展示 + 不测速：hidden 让面板不画这张卡，url 也就不需要了
    expect(g.hidden).toBe(true);
    expect(g.url).toBeUndefined();
    expect(g.proxies).not.toContain('目标固定⚡');
  });

  test('没有组时不定义 GLOBAL（内置那个本来就只有节点 + 内置出站）', () => {
    reset({ mode: 'split', autoSelect: false });
    expect(yamlOf()['proxy-groups']).toBeUndefined();
  });

  test('目标固定⚡：全部取消 → 默认直连，不建组，自定义规则照常可选', () => {
    const s = reset({ mode: 'split', autoSelect: true });
    const names = s.nodes.map((n) => n.name);
    s.autoSelectExclude = names.slice();
    let d = yamlOf();
    expect(d['proxy-groups']).toBeUndefined();
    expect(d.rules).toContain('MATCH,DIRECT');

    // 全部反选后，自定义规则的多选不受影响（哪些节点被引用，哪些才进配置）
    s.customRules = [{ target: 'a.com', actions: [names[0], names[1]] }];
    d = yamlOf();
    const lb = d['proxy-groups'].find((g) => g.name === '目标固定🚀');
    expect(lb.proxies).toEqual([names[0], names[1]]);
    expect(d.rules).toContain('MATCH,DIRECT');
  });

  test('全局代理 → 广告 + 内网 / NTP 直连 + 一句 MATCH，分流那堆全不出', () => {
    const s = reset({ mode: 'split', globalProxy: true, autoSelect: false });
    const d = yamlOf();
    const rules = d.rules;
    expect(rules[rules.length - 1]).toBe('MATCH,' + s.nodes[0].name);
    expect(rules).toContain('GEOIP,LAN,DIRECT,no-resolve');
    expect(rules).toContain('GEOSITE,private,DIRECT');
    expect(rules).toContain('DST-PORT,123,DIRECT');
    expect(rules.join('\n')).not.toContain('geolocation-!cn');
  });

  test('全局代理 + 目标固定⚡ → 出口是测速组，且不建重复的组', () => {
    const s = reset({ mode: 'split', globalProxy: true, autoSelect: true });
    const d = yamlOf();
    const rules = d.rules;
    expect(rules[rules.length - 1]).toBe('MATCH,目标固定⚡');
    expect(rules).toContain('GEOIP,LAN,DIRECT,no-resolve');
    expect(d['proxy-groups'].map((g) => g.name)).toEqual(['GLOBAL', '目标固定⚡']);
    expect(s.nodes.length).toBeGreaterThan(2);
  });

  test('全局代理压过回国模式（两个都存着时以全局代理为准）', () => {
    // 界面上是互斥的，但 localStorage 里可能两个都留着 true
    reset({ mode: 'split', globalProxy: true, returnMode: true, autoSelect: false });
    const d = yamlOf();
    expect(d.rules.join('\n')).not.toContain('GEOIP,CN');
    expect(d.dns['default-nameserver']).toEqual(['223.5.5.5', '119.29.29.29']);
  });

  test('内网直连那条带 no-resolve（两种方案都是）', () => {
    // 官方的「快捷配置」示例就是 `GEOIP,lan,直连,no-resolve`。少了它，mihomo
    // 匹配前会先 ResolveIP() 一次 —— 这条又是第一条规则，等于每个域名连接
    // 都要先解析一次才轮到后面的 GEOSITE。内网域名由 GEOSITE,private 兜着。
    for (const mode of ['split', 'oneip']) {
      reset({ mode });
      const rules = yamlOf().rules.join('\n');
      expect(rules, mode).toContain('GEOIP,LAN,DIRECT,no-resolve');
      expect(rules, mode).not.toMatch(/GEOIP,LAN,DIRECT(?!,no-resolve)/);
    }
  });

  test('精准分流 → 完整分流规则', () => {
    reset({ mode: 'split' });
    const text = MH.ui.buildConfig();
    expect(text).toContain('- GEOSITE,cn,DIRECT');
    expect(text).toContain('- GEOIP,CN,DIRECT');
    expect(text).toContain('- GEOSITE,geolocation-!cn,');
  });

  test('一机一IP → SRC-IP-CIDR 规则，且 TUN 关掉本机 IPv6', () => {
    reset({ mode: 'oneip', ipv6: true, network: '192.168.100', startIp: '2' });
    const text = MH.ui.buildConfig();
    expect(text).toContain('- SRC-IP-CIDR,192.168.100.2/32,');
    expect(text).toContain('- MATCH,DIRECT');
    // 一机一IP 只用 IPv4 源 IP 分流，本地 IPv6 恒关（跟别的方案不一样）
    expect(MH.yamlLoad(text).ipv6).toBe(false);
  });

  test('没有节点时直接报错，不生成半成品', () => {
    reset({ nodes: [] });
    expect(() => MH.ui.buildConfig()).toThrow('请先导入节点');
  });
});

describe('buildConfig：选项搬运', () => {
  test('通用设置逐项落到配置里', () => {
    reset({ mode: 'split', secret: 'a:b"c', port: 7788, redirHost: false, ipv6: false, controllerListen: '127.0.0.1' });
    const d = yamlOf();
    expect(d.secret).toBe('a:bc');   // cleanSecret 会把引号洗掉
    expect(d['external-controller']).toBe('127.0.0.1:7788');
    expect(d.ipv6).toBe(false);
    expect(d.dns['enhanced-mode']).toBe('fake-ip');
    expect(d.profile['store-fake-ip']).toBe(true);
  });

  test('监听地址：出厂值只监听本机，不预置任何私网地址', () => {
    reset({ mode: 'split' });
    expect(yamlOf()['external-controller']).toBe('127.0.0.1:9090');
  });

  test('监听地址：可以手动填任意地址，填 0.0.0.0 就写 0.0.0.0', () => {
    reset({ mode: 'split', controllerListen: '0.0.0.0' });
    expect(yamlOf()['external-controller']).toBe('0.0.0.0:9090');
    reset({ mode: 'split', controllerListen: '10.0.0.1' });
    expect(yamlOf()['external-controller']).toBe('10.0.0.1:9090');
  });

  test('监听地址：清空 / 带空格都不让配置坏掉', () => {
    reset({ mode: 'split', controllerListen: '   ' });
    expect(yamlOf()['external-controller']).toBe('127.0.0.1:9090');   // 回落出厂值
    reset({ mode: 'split', controllerListen: '  10.0.0.1  ' });
    expect(yamlOf()['external-controller']).toBe('10.0.0.1:9090');        // 两端空白洗掉
  });

  test('监听地址：IPv6 加方括号并加引号（否则 YAML 解析失败）', () => {
    reset({ mode: 'split', controllerListen: '::1' });
    const text = MH.ui.buildConfig();
    expect(text).toContain('external-controller: "[::1]:9090"');
    expect(yamlOf()['external-controller']).toBe('[::1]:9090');

    reset({ mode: 'split', dnsListen: '[::1]:1053' });
    expect(MH.ui.buildConfig()).toContain('  listen: "[::1]:1053"');
    expect(yamlOf().dns.listen).toBe('[::1]:1053');
  });

  test('勾上「使用 redir-host」时写 redir-host，且不出现任何 fake-ip 行', () => {
    reset({ mode: 'split', redirHost: true });
    const text = MH.ui.buildConfig();
    expect(text).toContain('enhanced-mode: redir-host');
    expect(text).not.toContain('fake-ip-range');
    expect(text).not.toContain('store-fake-ip');
  });

  test('DNS 模式出厂值是 fake-ip（不预置 redir-host）', () => {
    reset({ mode: 'split' });
    const text = MH.ui.buildConfig();
    expect(text).toContain('enhanced-mode: fake-ip');
    expect(text).not.toContain('enhanced-mode: redir-host');
    expect(text).toContain('store-fake-ip: true');
  });

  test('面板密码会先洗掉引号/空白/控制字符', () => {
    reset({ mode: 'split', secret: '  pa"ss\tword\n ' });
    expect(yamlOf().secret).toBe('password');
  });

  test('面板密码洗空之后回落到默认值', () => {
    reset({ mode: 'split', secret: '   "' });
    expect(yamlOf().secret).toBe(MH.DEFAULT_SECRET);
  });

  test('TUN 栈传到了引擎', () => {
    reset({ mode: 'split', stack: 'gvisor' });
    expect(yamlOf().tun.stack).toBe('gvisor');
  });

  test('WebRTC 开关两种模式都生效；回国模式下 stun 走默认出口', () => {
    reset({ mode: 'split', webrtc: false });
    expect(yamlOf().rules.some((r) => r.indexOf('stun') !== -1)).toBe(false);

    reset({ mode: 'split', webrtc: true });
    expect(yamlOf().rules.some((r) => r.indexOf('stun') !== -1)).toBe(true);

    reset({ mode: 'split', webrtc: false, returnMode: true });
    expect(yamlOf().rules.some((r) => r.indexOf('stun') !== -1)).toBe(false);

    // 回国模式的默认出口是节点 —— STUN 跟着它走（跟普通分流一致）
    const s = reset({ mode: 'split', webrtc: true, returnMode: true });
    expect(yamlOf().rules).toContain('DOMAIN-KEYWORD,stun,' + s.nodes[0].name);
  });

  test('回国模式反转 DNS 与规则', () => {
    reset({ mode: 'split', returnMode: true });
    const d = yamlOf();
    expect(d.rules[d.rules.length - 1]).toBe('MATCH,DIRECT');
    expect(d.rules).toContain('GEOSITE,geolocation-!cn,DIRECT');
    expect(d.rules.some((r) => r.startsWith('GEOSITE,cn,'))).toBe(true);
    expect(d.dns['default-nameserver']).toEqual(['1.1.1.1', '8.8.8.8']);
    expect(d.dns.nameserver).toContain('https://223.5.5.5/dns-query');
  });

  test('非法 TUN 栈回落到 mixed', () => {
    reset({ mode: 'split', stack: '不存在的栈' });
    expect(yamlOf().tun.stack).toBe('mixed');
  });

  test('自定义规则：动作是直连时，按 IP / 域名分两类落地', () => {
    reset({
      mode: 'split',
      customRules: [
        { target: '1.1.1.1', action: 'DIRECT' },
        { target: '2001:db8::1', action: 'DIRECT' },
        { target: 'a.com', action: 'DIRECT' },
        { target: '10.0.0.0/8', action: 'DIRECT' },
      ],
    });
    const rules = yamlOf().rules.join('\n');
    expect(rules).toContain('IP-CIDR,1.1.1.1/32,DIRECT,no-resolve');
    expect(rules).toContain('IP-CIDR6,2001:db8::1/128,DIRECT,no-resolve');
    // 内网 IP 按来源匹配（设备级），不是「目标在内网」
    expect(rules).toContain('SRC-IP-CIDR,10.0.0.0/8,DIRECT,no-resolve');
    expect(rules).toContain('DOMAIN,a.com,DIRECT');
  });

  test('自定义规则：动作是某个节点时，排在整个 rules 的最前面', () => {
    const s = reset({ mode: 'split', autoSelect: false });
    const names = s.nodes.map((n) => n.name);
    s.customRules = [
      { target: 'a.com', action: names[0] },
      { target: '10.0.0.0/8', action: names[0] },
    ];
    const d = yamlOf();
    // rules[0] 就是自定义规则 —— 说明它排在所有固定块之前（位置即优先级）
    expect(d.rules[0]).toBe('DOMAIN,a.com,' + names[0]);
    // 内网 IP 在自定义规则里按来源匹配（这台设备怎么走），公网才按目标
    expect(d.rules[1]).toBe('SRC-IP-CIDR,10.0.0.0/8,' + names[0] + ',no-resolve');
  });

  test('自定义规则：两种方案都生效，目标固定⚡下也不会被 MATCH 吞掉', () => {
    const s = reset({ mode: 'split', autoSelect: true });
    const names = s.nodes.map((n) => n.name);
    // 目标固定⚡下只有反选的节点能进自定义规则
    s.autoSelectExclude = [names[0]];
    s.customRules = [
      { target: 'a.com', action: names[0] },
      { target: 'b.com', action: 'DIRECT' },
    ];
    const d = yamlOf();
    expect(d.rules[0]).toBe('DOMAIN,a.com,' + names[0]);   // 选节点的排最前
    expect(d.rules).toContain('DOMAIN,b.com,DIRECT');      // 选直连的也得在
    expect(d.rules[d.rules.length - 1]).toMatch(/^MATCH,/); // 兜底永远在最后
  });

  test('自定义规则：引用已删掉的节点时这条被丢弃，且不回落成直连', () => {
    reset({
      mode: 'split',
      customRules: [
        { target: 'a.com', action: '早就删掉的节点' },
        { target: 'b.com', action: 'DIRECT' },
      ],
    });
    const rules = yamlOf().rules.join('\n');
    // 不回落成 DIRECT 很关键：用户本意是走代理，改成直连等于把流量放出去
    expect(rules).not.toContain('a.com');
    expect(rules).toContain('DOMAIN,b.com,DIRECT');
  });

  test('自定义规则：多选节点 → 生成目标固定🚀组，规则指向组名', () => {
    const s = reset({ mode: 'split', autoSelect: false });
    const names = s.nodes.map((n) => n.name);
    s.customRules = [{ target: 'a.com', actions: [names[0], names[1]] }];
    const d = yamlOf();
    const lb = d['proxy-groups'].find((g) => g.name === '目标固定🚀');
    expect(lb).toBeDefined();
    expect(lb.type).toBe('load-balance');
    expect(lb.proxies).toEqual([names[0], names[1]]);
    expect(d.rules[0]).toBe('DOMAIN,a.com,目标固定🚀');
  });

  test('自定义规则：成员相同的多条规则共用一个目标固定🚀组', () => {
    const s = reset({ mode: 'split', autoSelect: false });
    const names = s.nodes.map((n) => n.name);
    s.customRules = [
      { target: 'a.com', actions: [names[0], names[1]] },
      { target: 'b.com', actions: [names[1], names[0]] },   // 顺序不同也算同一组
    ];
    const d = yamlOf();
    expect(d['proxy-groups'].filter((g) => g.name !== 'GLOBAL')).toHaveLength(1);
    expect(d.rules.slice(0, 2)).toEqual(['DOMAIN,a.com,目标固定🚀', 'DOMAIN,b.com,目标固定🚀']);
  });

  test('自定义规则：目标固定⚡下，单选指向智能组成员的规则照常生成', () => {
    const s = reset({ mode: 'split', autoSelect: true });
    const names = s.nodes.map((n) => n.name);
    s.customRules = [{ target: 'a.com', action: names[0] }];
    const d = yamlOf();
    expect(d.rules).toContain('DOMAIN,a.com,' + names[0]);
    // 同一个节点：既在智能组里，也被自定义规则引用 —— 两份引用都成立
    expect(d['proxy-groups'].find((g) => g.name === '目标固定⚡').proxies).toContain(names[0]);
  });

  test('自定义规则：目标固定⚡开着时，只有被反选的节点才能多选成组', () => {
    const s = reset({ mode: 'split', autoSelect: true });
    const names = s.nodes.map((n) => n.name);
    // 两个都在"目标固定⚡成员"里被点掉 → 可以建组
    s.autoSelectExclude = [names[0], names[1]];
    s.customRules = [{ target: 'a.com', actions: [names[0], names[1]] }];
    let d = yamlOf();
    expect(d['proxy-groups'].some((g) => g.name === '目标固定🚀')).toBe(true);

    // 只反选了一个 → 不足 2 个，退回单选第一个，不建组
    s.autoSelectExclude = [names[0]];
    s.customRules = [{ target: 'b.com', actions: [names[0], names[1]] }];
    d = yamlOf();
    expect(d['proxy-groups'].some((g) => g.name === '目标固定🚀')).toBe(false);
    expect(d.rules[0]).toBe('DOMAIN,b.com,' + names[0]);
  });

  test('本地出口：勾选后国内流量走节点，不勾仍是直连', () => {
    const s = reset({ mode: 'split', autoSelect: false });
    const names = s.nodes.map((n) => n.name);
    s.localExit = true;
    s.localExitNode = names[1];

    let text = MH.ui.buildConfig();
    expect(text).toContain('  # 国内 代理\n  - GEOSITE,cn,' + names[1] + '\n  - GEOIP,CN,' + names[1]);
    expect(text).not.toContain('# 国内 直连');
    // 本地出口指向的节点必须写进 proxies（否则规则引用不存在的节点）
    expect(MH.yamlLoad(text).proxies.map((p) => p.name)).toContain(names[1]);

    s.localExit = false;
    text = MH.ui.buildConfig();
    expect(text).toContain('  # 国内 直连\n  - GEOSITE,cn,DIRECT\n  - GEOIP,CN,DIRECT');
    expect(text).not.toContain('# 国内 代理');
  });

  test('本地出口：回国模式 / 全局代理下不生效', () => {
    const s = reset({ mode: 'split', autoSelect: false });
    s.localExit = true;
    s.localExitNode = s.nodes[1].name;

    s.returnMode = true;
    expect(MH.ui.buildConfig()).not.toContain('# 国内 代理');
    s.returnMode = false;
    s.globalProxy = true;
    expect(MH.ui.buildConfig()).not.toContain('# 国内 代理');
  });

  test('常用 AI：geosite 目标生成 GEOSITE 规则（多选建组 / 单选 / 直连）', () => {
    const s = reset({ mode: 'split', autoSelect: false });
    const names = s.nodes.map((n) => n.name);

    s.customRules = [{ target: 'category-ai-!cn', type: 'geosite', actions: [names[0], names[1]] }];
    let d = yamlOf();
    let text = MH.ui.buildConfig();
    expect(d.rules[0]).toBe('GEOSITE,category-ai-!cn,目标固定🚀');
    expect(text).toContain('  # AI 服务\n  - GEOSITE,category-ai-!cn,目标固定🚀');
    expect(text).not.toContain('# 定义 规则');
    const lb = d['proxy-groups'].find((g) => g.name === '目标固定🚀');
    expect(lb.proxies).toEqual([names[0], names[1]]);

    s.customRules = [{ target: 'category-ai-!cn', type: 'geosite', actions: [names[0]] }];
    d = yamlOf();
    expect(d.rules[0]).toBe('GEOSITE,category-ai-!cn,' + names[0]);

    s.customRules = [{ target: 'category-ai-!cn', type: 'geosite', actions: ['DIRECT'] }];
    d = yamlOf();
    expect(d.rules[0]).toBe('GEOSITE,category-ai-!cn,DIRECT');
  });

  test('常用 AI：和普通规则共存时，# 定义 规则 在前，# AI 服务 在后', () => {
    const s = reset({ mode: 'split', autoSelect: false });
    const names = s.nodes.map((n) => n.name);
    s.customRules = [
      { target: 'a.com', actions: [names[0]] },
      { target: 'category-ai-!cn', type: 'geosite', actions: [names[0]] },
    ];
    const text = MH.ui.buildConfig();
    expect(text.indexOf('# 定义 规则')).toBeLessThan(text.indexOf('# AI 服务'));
    expect(text).toContain('  - DOMAIN,a.com,' + names[0]);
    expect(text).toContain('  # AI 服务\n  - GEOSITE,category-ai-!cn,' + names[0]);
  });

  test('常用 AI：回国模式用国内 AI 分类，普通模式用海外 AI 分类', () => {
    const s = reset({ mode: 'split', autoSelect: false });
    const names = s.nodes.map((n) => n.name);
    s.customRules = [{ preset: 'ai', target: 'category-ai-cn', type: 'geosite', actions: [names[0], names[1]] }];

    let text = MH.ui.buildConfig();
    expect(text).toContain('  # AI 服务\n  - GEOSITE,category-ai-!cn,目标固定🚀');
    expect(text).not.toContain('category-ai-cn');

    s.returnMode = true;
    text = MH.ui.buildConfig();
    expect(text).toContain('  # AI 服务\n  - GEOSITE,category-ai-cn,目标固定🚀');
    expect(text).not.toContain('category-ai-!cn');
  });

  test('常用 AI：一机一IP 的回国模式也用国内 AI 分类', () => {
    const s = reset({ mode: 'oneip', oneipReturnMode: true });
    const names = s.nodes.map((n) => n.name);
    s.customRules = [{ preset: 'ai', target: 'category-ai-!cn', type: 'geosite', actions: [names[0]] }];
    const d = yamlOf();
    expect(d.rules[0]).toBe('GEOSITE,category-ai-cn,' + names[0]);
  });

  test('常用 AI：手写 geosite:<分类> 也按 GEOSITE 生成', () => {
    const s = reset({ mode: 'split', autoSelect: false });
    const names = s.nodes.map((n) => n.name);
    // splitCustomRules 收到的是 UI 解析后的形态；分类名要在生成时原样带出
    s.customRules = [{ target: 'openai', type: 'geosite', actions: [names[0]] }];
    const d = yamlOf();
    expect(d.rules[0]).toBe('GEOSITE,openai,' + names[0]);
  });

  test('常用 TK：固定 tiktok，多选建组 / 单选 / 直连', () => {
    const s = reset({ mode: 'split', autoSelect: false });
    const names = s.nodes.map((n) => n.name);

    s.customRules = [{ preset: 'tk', target: 'tiktok', type: 'geosite', actions: [names[0], names[1]] }];
    let d = yamlOf();
    let text = MH.ui.buildConfig();
    expect(d.rules[0]).toBe('GEOSITE,tiktok,目标固定🚀');
    expect(text).toContain('  # Tik Tok\n  - GEOSITE,tiktok,目标固定🚀');
    expect(text).not.toContain('# 定义 规则');

    s.customRules = [{ preset: 'tk', target: 'tiktok', type: 'geosite', actions: [names[0]] }];
    d = yamlOf();
    expect(d.rules[0]).toBe('GEOSITE,tiktok,' + names[0]);

    s.customRules = [{ preset: 'tk', target: 'tiktok', type: 'geosite', actions: ['DIRECT'] }];
    d = yamlOf();
    expect(d.rules[0]).toBe('GEOSITE,tiktok,DIRECT');
  });

  test('常用 TK：不随回国模式切换，始终 tiktok', () => {
    const s = reset({ mode: 'split', autoSelect: false });
    const names = s.nodes.map((n) => n.name);
    s.customRules = [{ preset: 'tk', target: 'tiktok', type: 'geosite', actions: [names[0], names[1]] }];

    let text = MH.ui.buildConfig();
    expect(text).toContain('GEOSITE,tiktok,目标固定🚀');

    s.returnMode = true;
    text = MH.ui.buildConfig();
    expect(text).toContain('GEOSITE,tiktok,目标固定🚀');
    expect(text).not.toContain('category-ai-cn');
  });

  test('常用 TK：和普通规则 / AI 共存时段落顺序', () => {
    const s = reset({ mode: 'split', autoSelect: false });
    const names = s.nodes.map((n) => n.name);
    s.customRules = [
      { target: 'a.com', actions: [names[0]] },
      { preset: 'ai', target: 'category-ai-!cn', type: 'geosite', actions: [names[0]] },
      { preset: 'tk', target: 'tiktok', type: 'geosite', actions: [names[0]] },
    ];
    const text = MH.ui.buildConfig();
    expect(text.indexOf('# 定义 规则')).toBeLessThan(text.indexOf('# Tik Tok'));
    expect(text.indexOf('# Tik Tok')).toBeLessThan(text.indexOf('# AI 服务'));
    expect(text).toContain('  # Tik Tok\n  - GEOSITE,tiktok,' + names[0]);
  });

  test('常用 TK：手写 geosite:tiktok 也进 TikTok 段', () => {
    const s = reset({ mode: 'split', autoSelect: false });
    const names = s.nodes.map((n) => n.name);
    s.customRules = [{ target: 'tiktok', type: 'geosite', actions: [names[0]] }];
    const text = MH.ui.buildConfig();
    expect(text).toContain('  # Tik Tok\n  - GEOSITE,tiktok,' + names[0]);
  });

  test('常用 TC：生成 GEOSITE,tencent，段落顺序 TK → TC → AI', () => {
    const s = reset({ mode: 'split', autoSelect: false });
    const names = s.nodes.map((n) => n.name);
    s.customRules = [
      { target: 'a.com', actions: [names[0]] },
      { preset: 'tk', target: 'tiktok', type: 'geosite', actions: [names[0]] },
      { preset: 'ai', target: 'category-ai-!cn', type: 'geosite', actions: [names[0]] },
      { preset: 'tencent', target: 'tencent', type: 'geosite', actions: [names[0]] },
    ];
    const text = MH.ui.buildConfig();
    expect(text).toContain('  # TC 服务\n  - GEOSITE,tencent,' + names[0]);
    expect(text.indexOf('# 定义 规则')).toBeLessThan(text.indexOf('# Tik Tok'));
    expect(text.indexOf('# Tik Tok')).toBeLessThan(text.indexOf('# TC 服务'));
    expect(text.indexOf('# TC 服务')).toBeLessThan(text.indexOf('# AI 服务'));
  });

  test('常用 TC：任何模式都保留', () => {
    const s = reset({ mode: 'split', autoSelect: false, returnMode: true });
    const names = s.nodes.map((n) => n.name);
    s.customRules = [{ preset: 'tencent', target: 'tencent', type: 'geosite', actions: [names[0]] }];
    const text = MH.ui.buildConfig();
    expect(text).toContain('  # TC 服务\n  - GEOSITE,tencent,' + names[0]);
  });

  test('常用 TC：全局代理 / 一机一IP 也照样生成', () => {
    let s = reset({ mode: 'split', globalProxy: true });
    let names = s.nodes.map((n) => n.name);
    s.customRules = [{ preset: 'tencent', target: 'tencent', type: 'geosite', actions: [names[0]] }];
    expect(MH.ui.buildConfig()).toContain('  # TC 服务\n  - GEOSITE,tencent,' + names[0]);

    s = reset({ mode: 'oneip', oneipMainland: true });
    names = s.nodes.map((n) => n.name);
    s.customRules = [{ preset: 'tencent', target: 'tencent', type: 'geosite', actions: [names[0]] }];
    expect(MH.ui.buildConfig()).toContain('  # TC 服务\n  - GEOSITE,tencent,' + names[0]);
  });

  test('自定义规则：一机一IP 也能用多选目标固定🚀组', () => {
    const s = reset({ mode: 'oneip' });
    const names = s.nodes.map((n) => n.name);
    s.customRules = [{ target: 'a.com', actions: [names[0], names[1]] }];
    const d = yamlOf();
    expect(d['proxy-groups'].some((g) => g.name === '目标固定🚀')).toBe(true);
    expect(d.rules[0]).toBe('DOMAIN,a.com,目标固定🚀');
  });

  test('自定义规则：一机一IP 不受（残留的）目标固定⚡反选限制', () => {
    const s = reset({ mode: 'oneip', autoSelect: true });
    const names = s.nodes.map((n) => n.name);
    // 目标固定⚡的黑名单是精准分流那边的设置，一机一IP 里不该拿来过滤自定义组
    s.autoSelectExclude = names.slice(2);
    s.customRules = [{ target: 'a.com', actions: [names[0], names[1]] }];
    const d = yamlOf();
    const lb = d['proxy-groups'].find((g) => g.name === '目标固定🚀');
    expect(lb.proxies).toEqual([names[0], names[1]]);
  });

  test('端口非法时报错信息逐字固定', () => {
    for (const [value, msg] of [['99999', 'UI端口 超出范围: 99999'],
      ['0', 'UI端口 超出范围: 0'], ['abc', 'UI端口 格式错误: abc']]) {
      reset({ mode: 'split', port: value });
      expect(() => MH.ui.buildConfig()).toThrow(msg);
    }
  });
});

describe('buildConfig：多节点时的出口推导', () => {
  test('关掉目标固定⚡后：默认出口取第一个节点', () => {
    const s = reset({ mode: 'split', autoSelect: false });
    const names = s.nodes.map((n) => n.name);
    const rules = yamlOf().rules.join('\n');
    expect(rules).toContain('MATCH,' + names[0]);
    expect(rules).toContain('GEOSITE,geolocation-!cn,' + names[0]);
  });

  test('默认状态（什么都不改）不走目标固定⚡，出口就是第一个节点', () => {
    // reset() 会先铺一遍 defaultState()，所以这里断言的就是出厂设置。
    // 出厂是不勾目标固定⚡：两个以上节点时，「第一个节点」就是他要的出口，不替他套一层「哪台快走哪台」。
    const s = reset({ mode: 'split' });
    expect(s.autoSelect).toBe(false);
    expect(s.defaultNode).toBe('');

    const names = s.nodes.map((n) => n.name);
    const d = yamlOf();
    expect(d['proxy-groups']).toBeUndefined();
    expect(d.rules).toContain('MATCH,' + names[0]);
    expect(d.rules).toContain('GEOSITE,geolocation-!cn,' + names[0]);
  });

  test('单节点时 autoSelect 保持为真，但生成时自动失效、不留脏出口名', () => {
    const s = reset({ mode: 'split', autoSelect: true });
    s.nodes = s.nodes.slice(0, 1);
    const d = yamlOf();
    expect(d['proxy-groups']).toBeUndefined();
    expect(d.rules.some((r) => r.startsWith('MATCH,' + s.nodes[0].name))).toBe(true);
    expect(JSON.stringify(d.rules)).not.toContain('目标固定⚡');
  });

  test('智能选择模式：默认出口切到测速组', () => {
    reset({ mode: 'split', autoSelect: true });
    const d = yamlOf();
    expect(d.rules.some((r) => r.startsWith('MATCH,目标固定⚡'))).toBe(true);
    expect(d['proxy-groups'].map((g) => g.name)).toEqual(['GLOBAL', '目标固定⚡']);
  });

  test('单节点 + 遗留的「智能选择」出口名 → 回落到真实节点，不生成非法配置', () => {
    // 这正是"开了智能选择再把节点删到只剩一个"之后的中间状态。
    // 不兜底的话会生成 MATCH,智能选择，而此时根本不存在那个 proxy-group，
    // mihomo 会因为引用不存在的组拒绝加载整份配置。
    const s = reset({ mode: 'split', autoSelect: false, defaultNode: '智能选择' });
    s.nodes = s.nodes.slice(0, 1);
    const d = yamlOf();
    expect(d['proxy-groups']).toBeUndefined();
    expect(d.rules.some((r) => r.startsWith('MATCH,' + s.nodes[0].name))).toBe(true);
    expect(JSON.stringify(d.rules)).not.toContain('智能选择');
  });

  test('单节点 + 老存档里遗留的旧组名「自动选择」→ 回落到真实节点', () => {
    // 测速组从「自动选择」改名成「目标固定⚡」之前存过档的人，defaultNode 里
    // 留的还是旧名。它既不是节点名、也不该出现在产物里。
    const s = reset({ mode: 'split', autoSelect: false, defaultNode: '自动选择' });
    s.nodes = s.nodes.slice(0, 1);
    const d = yamlOf();
    expect(d.rules.some((r) => r.startsWith('MATCH,' + s.nodes[0].name))).toBe(true);
    expect(JSON.stringify(d.rules)).not.toContain('自动选择');
  });

  test('单节点 + 遗留的已删节点名 → 同样回落到真实节点', () => {
    const s = reset({ mode: 'split', defaultNode: '早就删掉的节点' });
    s.nodes = s.nodes.slice(0, 1);
    const d = yamlOf();
    expect(d.rules.some((r) => r.startsWith('MATCH,' + s.nodes[0].name))).toBe(true);
    expect(JSON.stringify(d.rules)).not.toContain('早就删掉的节点');
  });

  test('单节点：不生成测速组，走该节点', () => {
    const s = reset({ mode: 'split' });
    s.nodes = s.nodes.slice(0, 1);
    const d = yamlOf();
    expect(d['proxy-groups']).toBeUndefined();
    expect(d.rules.some((r) => r.startsWith('MATCH,' + s.nodes[0].name))).toBe(true);
  });

  test('回国模式 + 目标固定⚡：国内走测速组，兜底直连', () => {
    const s = reset({ mode: 'split', autoSelect: true, returnMode: true });
    const d = yamlOf();
    expect(d.rules).toContain('GEOIP,CN,目标固定⚡');        // 回国模式：中国走代理
    expect(d.rules[d.rules.length - 1]).toBe('MATCH,DIRECT'); // 兜底直连，长尾国外不绕中国
    expect(d['proxy-groups'].some((g) => g.name === '目标固定⚡')).toBe(true);
    expect(s.nodes.length).toBeGreaterThan(2);
  });
});

describe('buildConfig：一机一IP 的参数', () => {
  test('网段 / 起始 IP / 每节点 IP 数真的生效', () => {
    reset({ mode: 'oneip', network: '10.0.0.0/8', startIp: '5', ipsPerNode: '2' });
    const rules = yamlOf().rules.join('\n');
    expect(rules).toContain('SRC-IP-CIDR,10.0.0.5/32,');
    expect(rules).toContain('SRC-IP-CIDR,10.0.0.6/32,');
  });

  test('回国模式 + 国内模式互斥：两个都开时以国内模式为准', () => {
    reset({ mode: 'oneip', oneipReturnMode: true, oneipMainland: true });
    const d = yamlOf();
    // 国内模式关 sniffer、DNS 全走国内
    expect(d.sniffer.enable).toBe(false);
    expect(d.dns.nameserver).toContain('https://doh.pub/dns-query');
  });

  test('Telegram / AnyDesk 直连只在勾选时出现', () => {
    reset({ mode: 'oneip' });
    const off = yamlOf().rules.join('\n');
    expect(off).not.toContain('anydesk.com');
    expect(off).not.toContain('telegram.org');

    reset({ mode: 'oneip', anydesk: true, tg: true });
    const full = MH.ui.buildConfig();
    const on = MH.yamlLoad(full).rules.join('\n');
    expect(on).toContain('DOMAIN-SUFFIX,anydesk.com,DIRECT');
    // 域名用 GeoSite（比手写列表全），IP 用 IP-ASN —— Telegram 大量直连 DC IP
    expect(on).toContain('GEOSITE,telegram,DIRECT');
    expect(on).not.toContain('DOMAIN-SUFFIX,telegram.org,DIRECT');
    expect(on).toContain('IP-ASN,44907,DIRECT,no-resolve');
    // 用到 IP-ASN 就必须把 ASN 数据库地址写出来（缺文件时内核自己去下）
    expect(full).toContain('asn: "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/GeoLite2-ASN.mmdb"');
  });
});

describe('countProxies：用引擎真实产物钉住块写法', () => {
  const build = (nodes, opts) => {
    const eng = new MH.SplitEngine();
    Object.assign(eng, {
      proxies: nodes,
      secret: '123456',
      port: 9090,
      stack: 'mixed',
      ipv6_enabled: true,
      webrtc_protect: true,
      return_mode: false,
      mainland: false,
      redir_host: false,
      controller_listen: MH.DEFAULT_LISTEN,
      direct_ips: [],
      direct_domains: [],
    }, opts || {});
    return eng.generate();
  };

  test('单节点 / 名字带空格与 # / 名字带冒号', () => {
    const one = [{ name: 'A', type: 'trojan', server: 'h.example.com', port: 443, password: 'p' }];
    expect(MH.countProxies(build(one, { default_node: 'A' }))).toBe(1);

    const odd = [
      { name: 'has space # and: colon', type: 'trojan', server: 'h.example.com', port: 443, password: 'p' },
    ];
    expect(MH.countProxies(build(odd, { default_node: odd[0].name }))).toBe(1);
  });

  test('三个节点只引用一个：引擎只写被引用的，计数与产物一致', () => {
    const nodes = ['A', 'B', 'C'].map((n, i) => ({
      name: n, type: 'trojan', server: 'h' + i + '.example.com', port: 443, password: 'p',
    }));
    // 引擎会剔除没被任何规则/组引用的节点 —— 界面显示的「写入 N 个」必须跟这个一致
    const text = build(nodes, { default_node: 'A' });
    expect(MH.countProxies(text)).toBe(1);
  });
});

describe('buildConfig 与 golden 用例等价', () => {
  test('用界面状态装配出的配置，与直接装配引擎的结果一致', () => {
    // 守住"界面这一层没有在搬运过程中篡改任何字段"：
    // 同一个用例走 buildConfig 和走手工装配引擎，产出的 YAML 必须逐字节相同。
    const s = reset({ mode: 'split', stack: 'gvisor', webrtc: false, autoSelect: false });
    const viaUi = MH.ui.buildConfig();

    const names = s.nodes.map((n) => n.name);
    const eng = new MH.SplitEngine();
    eng.proxies = s.nodes;
    eng.secret = s.secret;
    eng.port = s.port;
    eng.stack = 'gvisor';
    eng.ipv6_enabled = s.ipv6;
    eng.webrtc_protect = false;
    eng.return_mode = false;
    eng.mainland = false;
    eng.redir_host = s.redirHost;
    eng.controller_listen = s.controllerListen;
    eng.direct_ips = [];
    eng.direct_domains = [];
    eng.default_node = names[0];
    expect(viaUi).toBe(eng.generate());
  });
});

/**
 * 进阶参数（基础 / TUN / DNS / sniffer）。
 *
 * 这一批的总底线：默认状态下产物一个字节都不能变。那两张卡片上的控件默认值必须等于引擎里
 * 写死的出厂值，否则用户什么都没碰、生成出来的配置却变了 —— 这正是这套工具最不该出的问题。
 */
describe('buildConfig：进阶参数', () => {
  test('不碰任何新控件时，产物与「只用出厂值的引擎」逐字节相同', () => {
    // 这条会在任何人把某个界面默认值改成与引擎默认值不同时立刻变红。
    const s = reset({ mode: 'split', autoSelect: false, adBlock: MH.defaultState().adBlock });
    const viaUi = MH.ui.buildConfig();

    const eng = new MH.SplitEngine();
    eng.proxies = s.nodes;
    eng.secret = MH.cleanSecret(s.secret) || MH.DEFAULT_SECRET;
    eng.port = s.port;
    eng.auto_select = false;
    eng.controller_listen = s.controllerListen;
    eng.ipv6_enabled = s.ipv6;
    eng.stack = s.stack;
    eng.direct_ips = [];
    eng.direct_domains = [];
    eng.webrtc_protect = s.webrtc;
    eng.ad_block = s.adBlock;
    eng.return_mode = false;
    eng.mainland = false;
    eng.redir_host = s.redirHost;
    const names = s.nodes.map((n) => n.name);
    eng.default_node = names[0];
    expect(viaUi).toBe(eng.generate());
  });

  test('出厂值逐行长这样（find-process-mode 的引号、端口区间引号都在）', () => {
    reset({ mode: 'split' });
    const text = MH.ui.buildConfig();
    expect(text).toContain('log-level: info');
    expect(text).toContain("find-process-mode: 'off'");
    expect(text).toContain('keep-alive-idle: 60');
    expect(text).toContain('keep-alive-interval: 30');
    expect(text).toContain('unified-delay: true');
    expect(text).toContain('tcp-concurrent: true');
    expect(text).toContain('  mtu: 1400');
    expect(text).toContain('  listen: 127.0.0.1:1053');
    expect(text).toContain('        - "8080-8880"');
  });

  test('列表清空 = 回退出厂值，不会生成「组名后面一个子项都没有」的配置', () => {
    reset({
      mode: 'split',
      dnsNameserver: [], dnsDefaultNs: [], dnsProxyServerNs: [],
      dnsDirectNs: [], dnsPolicyCn: [], dnsPolicyGeo: [],
      dnsHijack: [], snifferHttpPorts: [], snifferTlsPorts: [],
      snifferQuicPorts: [], snifferSkipDomains: [],
    });
    const text = MH.ui.buildConfig();
    expect(text).toContain('  nameserver:\n    - https://1.1.1.1/dns-query');
    expect(text).toContain('    - any:53\n    - tcp://any:53');
    expect(text).toContain('        - 80\n        - "8080-8880"');
    // 解析得出来且列表非空 —— 空挂的话这里会是 null 或直接抛
    const d = MH.yamlLoad(text);
    expect(d.dns.nameserver.length).toBeGreaterThan(0);
    expect(d.sniffer['skip-domain'].length).toBeGreaterThan(0);
  });

  test('改主 DNS 只在常规模式生效，回国模式仍走内置预设', () => {
    // 用 203.0.113.x（TEST-NET-3），别用 9.9.9.9 —— golden 那批节点里正好
    // 有个节点 server 就是 9.9.9.9，拿它做断言会因为节点文本而假通过 / 假失败。
    const mine = 'https://203.0.113.9/dns-query';
    reset({ mode: 'split', dnsNameserver: [mine] });
    expect(MH.ui.buildConfig()).toContain('    - ' + mine);

    reset({ mode: 'split', returnMode: true, dnsNameserver: [mine] });
    const text = MH.ui.buildConfig();
    expect(text).not.toContain('203.0.113.9');
    expect(text).toContain('    - https://223.5.5.5/dns-query\n    - https://dns.alidns.com/dns-query');
  });

  test('DNS 列表项里有 ": " / 方括号 也不会把 YAML 写坏', () => {
    // `[x]` 走界面这一路：方括号开头会被 YAML 当成 flow sequence，引擎得给它加引号。
    reset({ mode: 'split', dnsNameserver: ['[x]', '223.5.5.5'] });
    expect(yamlOf().dns.nameserver).toEqual(['[x]', '223.5.5.5']);

    // `foo: bar`（带空格）现在会被界面的输入校验挡掉（内核会拒载），
    // 但引擎层的 YAML 兜底仍然要成立 —— 直接喂引擎，别让这条断言依赖 UI 有没有拦。
    const eng = new MH.SplitEngine();
    eng.dns_nameserver = ['foo: bar', '[x]', '223.5.5.5'];
    expect(MH.yamlLoad(eng.generate()).dns.nameserver).toEqual(['foo: bar', '[x]', '223.5.5.5']);
  });

  test('dns.listen 空值回落默认，格式不对报中文错', () => {
    reset({ mode: 'split', dnsListen: '0.0.0.0:5353' });
    expect(MH.ui.buildConfig()).toContain('  listen: 0.0.0.0:5353');

    reset({ mode: 'split', dnsListen: '   ' });
    expect(MH.ui.buildConfig()).toContain('  listen: 127.0.0.1:1053');

    reset({ mode: 'split', dnsListen: '不是地址' });
    expect(() => MH.ui.buildConfig()).toThrow('DNS 监听地址格式错误');
  });

  test('关掉 sniffer 时整块只剩 enable: false', () => {
    reset({ mode: 'split', snifferEnable: false });
    const text = MH.ui.buildConfig();
    expect(text).toContain('sniffer:\n  enable: false');
    expect(text).not.toContain('parse-pooled-conns');
  });

  test('一机一IP 勾了「国内使用国内节点」时 sniffer 恒关（mainland 优先）', () => {
    reset({ mode: 'oneip', oneipMainland: true, snifferEnable: true });
    const text = MH.ui.buildConfig();
    expect(text).toContain('sniffer:\n  enable: false');
    expect(text).not.toContain('parse-pooled-conns');
  });

  test('基础 / TUN 参数确实落进配置', () => {
    reset({
      mode: 'split', logLevel: 'warning', findProcessMode: 'strict', mtu: '1500',
      unifiedDelay: false, tcpConcurrent: false,
      keepAliveIdle: '99', keepAliveInterval: '11',
      autoRoute: false, strictRoute: false, dnsHijack: ['any:53'],
    });
    const text = MH.ui.buildConfig();
    expect(text).toContain('log-level: warning');
    expect(text).toContain("find-process-mode: 'strict'");   // 引号必须还在
    expect(text).toContain('  mtu: 1500');
    expect(text).toContain('unified-delay: false');
    expect(text).toContain('tcp-concurrent: false');
    expect(text).toContain('keep-alive-idle: 99');
    expect(text).toContain('keep-alive-interval: 11');
    expect(text).toContain('  auto-route: false');
    expect(text).toContain('  strict-route: false');
    expect(MH.yamlLoad(text).tun['dns-hijack']).toEqual(['any:53']);
  });

  test('log-level / find-process-mode 被塞了名单外的值就回落出厂值', () => {
    reset({ mode: 'split', logLevel: '啰嗦', findProcessMode: 'xxx' });
    const text = MH.ui.buildConfig();
    expect(text).toContain('log-level: info');
    expect(text).toContain("find-process-mode: 'off'");
  });

  test('一机一IP 也搬得动进阶参数（防漏拷）', () => {
    reset({ mode: 'oneip', mtu: '1500', logLevel: 'warning', dnsListen: '0.0.0.0:5353' });
    const text = MH.ui.buildConfig();
    expect(text).toContain('  mtu: 1500');
    expect(text).toContain('log-level: warning');
    expect(text).toContain('  listen: 0.0.0.0:5353');
    // 一机一IP 自己的两条规矩不能被带歪
    expect(text).toContain('ipv6: false');
    expect(text).toContain('  stack: mixed');
  });

  test('新参数不会把 YAML 结构写坏', () => {
    reset({
      mode: 'split',
      dnsNameserver: ['https://203.0.113.9/dns-query', '1.1.1.1'],
      snifferHttpPorts: ['80', '8080-8880', '3128'],
    });
    const d = MH.yamlLoad(MH.ui.buildConfig());
    expect(d.dns.nameserver).toEqual(['https://203.0.113.9/dns-query', '1.1.1.1']);
    expect(d.sniffer.sniff.HTTP.ports).toEqual([80, '8080-8880', 3128]);
  });
});

/**
 * `writtenProxies()`：生成文本里实际写进去几个节点。
 *
 * 这数就是预览页上「已导入 N 个节点 · 配置里 M 个」里的 M：20 节点的订阅、默认出口选一台，
 * 生成的配置里只有 1 个节点，界面却只念「已导入 20 个节点」。
 *
 * 断言分两层：先钉住各形态应有的节点数，再拿 js-yaml 解析同一份文本核对 —— 数节点的方式
 * （缩进 / 分隔）跟渲染器走岔了，测试立刻红。
 */
describe('writtenProxies：配置里到底写了几个节点', () => {
  const count = (text) => MH.ui.writtenProxies(text);
  const parsed = (text) => (MH.yamlLoad(text).proxies || []).length;

  test('精准分流、没勾目标固定⚡：只写默认出口那一个', () => {
    const s = reset({ mode: 'split' });
    expect(s.nodes.length).toBeGreaterThan(3);
    const text = MH.ui.buildConfig();
    expect(count(text)).toBe(1);
    expect(parsed(text)).toBe(1);
  });

  test('勾了目标固定⚡：成员全部写进去', () => {
    const s = reset({ mode: 'split', autoSelect: true });
    const text = MH.ui.buildConfig();
    expect(count(text)).toBe(s.nodes.length);
    expect(parsed(text)).toBe(s.nodes.length);
  });

  test('目标固定⚡里反选掉的节点不写', () => {
    const s = reset({ mode: 'split', autoSelect: true });
    s.autoSelectExclude = [s.nodes[0].name, s.nodes[1].name];
    const text = MH.ui.buildConfig();
    expect(count(text)).toBe(s.nodes.length - 2);
    expect(parsed(text)).toBe(s.nodes.length - 2);
  });

  test('自定义规则选了两个节点：默认出口 + 这两个', () => {
    const s = reset({ mode: 'split' });
    const names = s.nodes.map((n) => n.name);
    s.customRules = [{ target: 'example.com', actions: [names[1], names[2]] }];
    const text = MH.ui.buildConfig();
    expect(text).toContain('目标固定🚀');
    expect(count(text)).toBe(3);
    expect(parsed(text)).toBe(3);
  });

  test('一机一IP：每个节点都有自己的 SRC-IP-CIDR，全部写', () => {
    const s = reset({ mode: 'oneip' });
    const text = MH.ui.buildConfig();
    expect(count(text)).toBe(s.nodes.length);
    expect(parsed(text)).toBe(s.nodes.length);
  });

  test('没有 proxies 段 / 空文本都算 0，不抛异常', () => {
    expect(count('')).toBe(0);
    expect(count('rules:\n  - MATCH,DIRECT')).toBe(0);
    // proxy-groups 里的 `- name:` 缩进是四格，不会被误数成节点
    const noProxy = 'proxy-groups:\n  - name: "目标固定🚀"\n    proxies:\n      - "A"\n';
    expect(count(noProxy)).toBe(0);
  });
});

/**
 * 自由文本栏位的入口校验。
 *
 * 不是洁癖：mihomo v1.19.33 的 `-t` 会直接拒绝这两种输入 ——
 *   · DNS 里带空格  → `invalid character " " in host name`，整份配置拒载
 *   · 端口填 abc    → `invalid range: abc`，同样拒载
 * 而这两个错都只在路由器上才爆。所以挡在生成这一步。
 */
describe('buildConfig：DNS / 端口的输入校验', () => {
  test('DNS 列表里混进空格 → 报错，别交给内核', () => {
    reset({ dnsNameserver: ['1.1.1.1 8.8.8.8'] });
    expect(() => MH.ui.buildConfig()).toThrow(/一行一个/);
    reset({ dnsPolicyCn: ['223.5.5.5 119.29.29.29'] });
    expect(() => MH.ui.buildConfig()).toThrow(/一行一个/);
    reset({ dnsDirectNs: ['https://x y/dns-query'] });
    expect(() => MH.ui.buildConfig()).toThrow(/一行一个/);
  });

  test('DNS 一行一个就正常', () => {
    reset({ dnsNameserver: ['1.1.1.1', '8.8.8.8'] });
    expect(MH.ui.buildConfig()).toContain('    - 8.8.8.8');
  });

  test('嗅探端口只认「端口」和「端口段」', () => {
    reset({ snifferHttpPorts: ['abc'] });
    expect(() => MH.ui.buildConfig()).toThrow(/端口或端口段/);

    reset({ snifferTlsPorts: ['8080-8880-9999'] });
    expect(() => MH.ui.buildConfig()).toThrow(/端口或端口段/);

    reset({ snifferQuicPorts: ['70000'] });
    expect(() => MH.ui.buildConfig()).toThrow(/1-65535/);

    reset({ snifferHttpPorts: ['9000-8000'] });
    expect(() => MH.ui.buildConfig()).toThrow(/起点比终点大/);
  });

  test('合法的端口 / 端口段照常通过', () => {
    reset({ snifferHttpPorts: ['80', '8080-8880'], snifferTlsPorts: ['443'], snifferQuicPorts: ['443'] });
    const text = MH.ui.buildConfig();
    expect(text).toContain('        - "8080-8880"');
    expect(text).toContain('        - 443');
  });
});

/**
 * `utf8Bytes()`：界面上报的「N 行 / X KB」和 10 MiB 上限都按字节算。
 * 用 `text.length`（UTF-16 码元）的话，中文节点名会让体积报小一半以上，10 MiB 上限形同虚设。
 */
describe('utf8Bytes：体积按 UTF-8 字节算', () => {
  test('中英混排的字节数', () => {
    expect(MH.ui.utf8Bytes('abc')).toBe(3);
    expect(MH.ui.utf8Bytes('中文')).toBe(6);
    expect(MH.ui.utf8Bytes('a中')).toBe(4);
    expect(MH.ui.utf8Bytes('')).toBe(0);
    expect(MH.ui.utf8Bytes(null)).toBe(0);
  });

  test('生成的配置：算出来的字节数与文件真实大小一致', () => {
    reset({});
    const text = MH.ui.buildConfig();
    expect(MH.ui.utf8Bytes(text)).toBe(Buffer.byteLength(text, 'utf8'));
    // 中文节点名的配置里，字符数一定小于字节数
    expect(MH.ui.utf8Bytes(text)).toBeGreaterThan(text.length);
  });
});

/**
 * 目标固定🚀组体检地址按出口位置分两套：
 *   出国（精准分流 / 全局代理）→ gstatic（内核 + 面板的默认值，海外节点就近命中）
 *   回国 / 国内使用国内节点 → 华为 204（检查点在国内）
 * 用反了的代价是「好节点被误判成坏、踢出轮换」，所以这里两种出口各钉一条。
 */
describe('目标固定🚀组体检地址：按出口分', () => {
  const GSTATIC = 'https://www.gstatic.com/generate_204';
  const HICLOUD = 'https://connectivitycheck.platform.hicloud.com/generate_204';
  const lbUrls = (text) => (MH.yamlLoad(text)['proxy-groups'] || [])
    .filter((g) => g.type === 'load-balance')
    .map((g) => g.url);

  test('出国：目标固定⚡ / 全局代理 / 自定义目标固定🚀组都是 gstatic', () => {
    // 目标固定⚡组（成员 = 全部节点）
    reset({ mode: 'split', autoSelect: true });
    expect(lbUrls(MH.ui.buildConfig())).toEqual([GSTATIC]);

    // 全局代理同样走 gstatic
    reset({ mode: 'split', autoSelect: true, globalProxy: true });
    expect(lbUrls(MH.ui.buildConfig())).toEqual([GSTATIC]);

    // 自定义规则的目标固定🚀组（目标固定⚡关掉，否则成员会先被智能组占住）
    const s = reset({ mode: 'split' });
    const names = s.nodes.map((n) => n.name);
    s.customRules = [{ target: 'a.com', actions: [names[0], names[1]] }];
    expect(lbUrls(MH.ui.buildConfig())).toEqual([GSTATIC]);
  });

  test('回国模式：目标固定⚡ + 自定义目标固定🚀组都换成华为 204', () => {
    reset({ mode: 'split', autoSelect: true, returnMode: true });
    expect(lbUrls(MH.ui.buildConfig())).toEqual([HICLOUD]);

    const s = reset({ mode: 'split', returnMode: true });
    const names = s.nodes.map((n) => n.name);
    s.customRules = [{ target: 'a.com', actions: [names[0], names[1]] }];
    expect(lbUrls(MH.ui.buildConfig())).toEqual([HICLOUD]);
  });

  test('一机一IP：国内使用国内节点用华为，默认（出国）用 gstatic', () => {
    const s = reset({ mode: 'oneip', oneipMainland: true });
    const names = s.nodes.map((n) => n.name);
    s.customRules = [{ target: 'a.com', actions: [names[0], names[1]] }];
    expect(lbUrls(MH.ui.buildConfig())).toEqual([HICLOUD]);

    const s2 = reset({ mode: 'oneip' });
    s2.customRules = [{ target: 'a.com', actions: [names[0], names[1]] }];
    expect(lbUrls(MH.ui.buildConfig())).toEqual([GSTATIC]);
  });
});

describe('buildConfig：单栈 IPv6 走节点出口', () => {
  test('只由 IPv6 + ipv6ViaNode 两个状态共同决定', () => {
    reset({ mode: 'split', ipv6: true, ipv6ViaNode: true });
    expect(MH.ui.buildConfig()).toContain('  inet6-address:\n    - fdfe:dcba:9876::1/126');

    reset({ mode: 'split', ipv6: false, ipv6ViaNode: true });
    expect(MH.ui.buildConfig()).not.toContain('inet6-address:');

    reset({ mode: 'oneip', ipv6: true, ipv6ViaNode: true });
    expect(MH.ui.buildConfig()).not.toContain('inet6-address:');
  });
});
