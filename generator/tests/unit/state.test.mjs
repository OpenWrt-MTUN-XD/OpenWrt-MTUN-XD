import { describe, expect, test } from 'bun:test';
import { loadCore, loadFixtures } from '../helpers/load.mjs';

const MH = loadCore();
const fx = loadFixtures();

function freshState() { return MH.defaultState(); }

// ── 自定义规则：一次粘一串目标 ─────────────────────────────────────────
// 一次贴几个域名只算一条（openai.com / chatgpt.com / …）时只能挨个添加；切分在这儿，
// ui.js 那边还负责从 paste 事件里抢原始文本。
describe('自定义规则的目标切分', () => {
  test('换行 / 逗号 / 分号 / 空格都当分隔', () => {
    expect(MH.splitRuleTargets('a.com\nb.com\nc.com')).toEqual(['a.com', 'b.com', 'c.com']);
    expect(MH.splitRuleTargets('a.com,b.com')).toEqual(['a.com', 'b.com']);
    expect(MH.splitRuleTargets('a.com; b.com')).toEqual(['a.com', 'b.com']);
    expect(MH.splitRuleTargets('a.com  b.com')).toEqual(['a.com', 'b.com']);
  });

  test('中文标点也认（，；、）', () => {
    expect(MH.splitRuleTargets('a.com，b.com；c.com、d.com'))
      .toEqual(['a.com', 'b.com', 'c.com', 'd.com']);
  });

  test('用户报的那一串：4 个域名 + 空行/缩进 → 正好 4 条', () => {
    const raw = '\n  openai.com\nchatgpt.com\n  oaistatic.com\noaiusercontent.com  \n';
    expect(MH.splitRuleTargets(raw))
      .toEqual(['openai.com', 'chatgpt.com', 'oaistatic.com', 'oaiusercontent.com']);
  });

  test('单个目标原样返回（老行为不变）；空 / 空白 / null / undefined → 空数组', () => {
    expect(MH.splitRuleTargets('example.com')).toEqual(['example.com']);
    expect(MH.splitRuleTargets('  example.com  ')).toEqual(['example.com']);
    for (const v of ['', '   ', '\n\n', null, undefined]) {
      expect(MH.splitRuleTargets(v)).toEqual([]);
    }
  });

  test('IP / CIDR 不会被切坏（IPv6 里的冒号不是分隔符）', () => {
    expect(MH.splitRuleTargets('10.0.0.0/8, 2001:db8::/32'))
      .toEqual(['10.0.0.0/8', '2001:db8::/32']);
  });
});

describe('状态层', () => {
  test('出厂默认里没有节点（节点从来就不落盘）', () => {
    const s = freshState();
    expect(s.nodes).toEqual([]);
    expect(s.mode).toBe('split');
  });

  test('追加导入跨来源去重', () => {
    const s = freshState();
    const nodes = MH.parseAnyInput(fx.nodes_text);
    expect(MH.addNodes(s, nodes)).toBe(nodes.length);
    expect(MH.addNodes(s, nodes)).toBe(0);           // 第二次全部重复
    expect(s.nodes.length).toBe(nodes.length);
    // 只新增其中一条
    const extra = MH.parseAnyInput(fx.subscription.plain);
    expect(MH.addNodes(s, extra)).toBe(extra.length);
    expect(s.nodes.length).toBe(nodes.length + extra.length);
  });

  test('重名节点自动加后缀', () => {
    const s = freshState();
    const a = MH.parseAnyInput(fx.subscription.plain)[0];
    const b = JSON.parse(JSON.stringify(a));
    b.remarks = '';
    MH.addNodes(s, [a, b]);
    expect(s.nodes[0].name).toBe(a.name);
    expect(s.nodes[1].name).toBe(a.name + ' (2)');
  });

  test('凭据指纹：同机器不同凭据不视为重复', () => {
    const a = MH.parseAnyInput(fx.subscription.plain)[0];
    const b = JSON.parse(JSON.stringify(a));
    b.password = 'different';
    expect(MH.nodeKey(a)).not.toBe(MH.nodeKey(b));
  });

  // ── 每次打开就是出厂默认 ──────────────────────────────────────────
  // 设置不再存进 localStorage（老版本那套 DEFAULTS_VERSION 迁移已拆掉）：loadSettings 一个键都
  // 不覆盖，顺手把老访客浏览器里那份旧存档删掉。
  test('存档里写了什么都不认：打开就是出厂默认', () => {
    localStorage.setItem(MH.STORAGE_KEY, JSON.stringify({
      mode: 'oneip', port: 7899, secret: 'keep-me', autoSelect: true,
      customRules: [{ target: 'a.com', action: 'DIRECT' }], theme: 'light',
      controllerListen: '192.168.100.1', dnsProxyServerNs: ['1.1.1.1'],
    }));
    const s = freshState();
    MH.loadSettings(s);
    expect(s.mode).toBe('split');
    expect(s.port).toBe(9090);
    expect(s.secret).toBe('123456');
    expect(s.autoSelect).toBe(false);
    expect(s.customRules).toEqual([]);
    expect(s.controllerListen).toBe('127.0.0.1');
    expect(s.dnsProxyServerNs).toEqual(['223.5.5.5', 'https://doh.pub/dns-query']);
  });

  test('打开时把旧存档删掉（老访客那份不再留着）', () => {
    localStorage.setItem(MH.STORAGE_KEY, JSON.stringify({ mode: 'oneip' }));
    MH.loadSettings(freshState());
    expect(localStorage.getItem(MH.STORAGE_KEY)).toBe(null);
  });

  test('出厂默认：面板监听地址只监听本机（不预置任何私网网段）', () => {
    expect(freshState().controllerListen).toBe('127.0.0.1');
  });

  test('出厂默认：智能选择模式不勾', () => {
    expect(freshState().autoSelect).toBe(false);
  });

  test('出厂默认：DNS 模式是 fake-ip（键叫 redirHost，反着存）', () => {
    expect(freshState().redirHost).toBe(false);   // 不勾 = fake-ip
  });

  test('出厂默认的「节点 DNS」是两条', () => {
    expect(freshState().dnsProxyServerNs).toEqual(['223.5.5.5', 'https://doh.pub/dns-query']);
  });
});

// ── 监听地址：宿主部署时带进来的默认值 ────────────────────────────────
// 宿主 = LuCI 里的「配置工具」，它用 ?listen= 把识别出的网关地址带进来当出厂值；独立站不带
// 这个参数，所以这一段完全是增量。
describe('监听地址：宿主带进来的部署时默认值', () => {
  function withSearch(qs, fn) {
    const had = 'location' in globalThis;
    const old = globalThis.location;
    globalThis.location = { search: qs, hash: '' };
    try { return fn(); }
    finally {
      if (had) globalThis.location = old;
      else delete globalThis.location;
    }
  }

  test('readListenHint：没有 / 带了别的不带 listen 都是空串', () => {
    for (const qs of ['', '?secret=abc&noframe=1']) {
      withSearch(qs, () => expect(MH.readListenHint()).toBe(''));
    }
  });

  test('readListenHint：解出 ?listen= 并清掉空白 / 控制字符', () => {
    // ⚠️ 带进来的是**地址**（没有端口）—— 那一格只放地址，端口是旁边独立那格。
    withSearch('?secret=abc&noframe=1&listen=%20192.168.100.1%09', () => {
      expect(MH.readListenHint()).toBe('192.168.100.1');
    });
  });

  test('没动过这一项（还是出厂值）→ 吃下带进来的地址', () => {
    const s = freshState();
    expect(s.controllerListen).toBe('127.0.0.1');
    MH.applyListenHint(s, '192.168.100.1');
    expect(s.controllerListen).toBe('192.168.100.1');
  });

  test('用户自己填过的地址一律保留', () => {
    for (const mine of ['0.0.0.0', '10.0.0.1', 'myrouter.lan']) {
      const s = freshState();
      s.controllerListen = mine;
      MH.applyListenHint(s, '192.168.100.1');
      expect(s.controllerListen).toBe(mine);
    }
  });

  test('宿主没带（独立站 / 面板里打开）→ 出厂值一个字节不变', () => {
    for (const hint of ['', undefined]) {
      const s = freshState();
      MH.applyListenHint(s, hint);
      expect(s.controllerListen).toBe('127.0.0.1');
    }
  });
});
// ── 监听地址：不再自动识别 ────────────────────────────────────────
// 路由器那份默认就是 127.0.0.1（面板/配置工具/API 都走 uhttpd 那条口子，不必再绑内网地址）。
// 不猜地址：那两路兜底（本页是内网 IP 就用它 / 页面里的 __MHLAN）已删。
describe('监听地址：不自动识别', () => {
  function withLoc(loc, fn) {
    const had = 'location' in globalThis;
    const old = globalThis.location;
    globalThis.location = loc;
    try { return fn(); }
    finally {
      if (had) globalThis.location = old;
      else delete globalThis.location;
    }
  }

  test('内网 IP / 域名 / 隧道 打开，没带 ?listen= → 一律出厂值 127.0.0.1', () => {
    for (const h of ['192.168.100.1', '10.0.0.1', 'nat.s-ui.com', 'mihomo.wxcircle.top']) {
      withLoc({ search: '', hash: '', hostname: h }, () => {
        localStorage.removeItem(MH.STORAGE_KEY);
        const s = freshState();
        MH.loadSettings(s);
        MH.applyListenHint(s);
        expect(s.controllerListen).toBe('127.0.0.1');
      });
    }
  });

  test('页面里写了 window.__MHLAN 也不认了（那个机制撤了）', () => {
    const had = '__MHLAN' in globalThis;
    const old = globalThis.__MHLAN;
    globalThis.__MHLAN = '192.168.100.1';
    try {
      withLoc({ search: '', hash: '', hostname: 'nat.s-ui.com' }, () => {
        const s = freshState();
        MH.applyListenHint(s);
        expect(s.controllerListen).toBe('127.0.0.1');
      });
    } finally {
      if (had) globalThis.__MHLAN = old;
      else delete globalThis.__MHLAN;
    }
  });

  test('宿主带了 ?listen= 照样认（那个口子留着）', () => {
    const s = freshState();
    MH.applyListenHint(s, '10.1.1.1');
    expect(s.controllerListen).toBe('10.1.1.1');
  });
});
