import { expect, test } from 'bun:test';
import { loadCore } from '../helpers/load.mjs';

const MH = loadCore();

test('SIP008：servers → ss 节点，保留名称与 plugin', () => {
  const n = MH.parseAnyInput(JSON.stringify({
    version: 1,
    servers: [{
      remarks: 'SIP 01',
      server: 'sip.example.com',
      server_port: 8388,
      method: 'aes-128-gcm',
      password: 'pass',
      plugin: 'obfs-local',
      plugin_opts: 'obfs=http;obfs-host=bing.com'
    }]
  }));
  expect(n).toHaveLength(1);
  expect(n[0]).toMatchObject({
    type: 'ss',
    name: 'SIP 01',
    server: 'sip.example.com',
    port: 8388,
    method: 'aes-128-gcm',
    password: 'pass',
    plugin: 'obfs'
  });
  expect(n[0].plugin_opts).toEqual({ obfs: 'http', 'obfs-host': 'bing.com' });
});

test('SIP008：Base64 包裹也能识别', () => {
  const doc = JSON.stringify({
    version: 1,
    servers: [{
      remarks: 'B64 SIP',
      server: 'b64.example.com',
      server_port: 443,
      method: 'aes-128-gcm',
      password: 'pass'
    }]
  });
  const n = MH.parseAnyInput(btoa(doc));
  expect(n).toHaveLength(1);
  expect(n[0].name).toBe('B64 SIP');
});

test('sing-box：outbounds 常见协议转换，selector 跳过', () => {
  const n = MH.parseAnyInput(JSON.stringify({
    outbounds: [
      {
        type: 'vmess', tag: 'VM',
        server: 'vm.example.com', server_port: 443,
        uuid: '11111111-1111-1111-1111-111111111111', alter_id: 0, security: 'auto',
        tls: { enabled: true, server_name: 'vm.example.com', utls: { fingerprint: 'chrome' } },
        transport: { type: 'ws', path: '/ws', headers: { Host: 'cdn.example.com' } }
      },
      {
        type: 'vless', tag: 'VL',
        server: 'vl.example.com', server_port: 443,
        uuid: '22222222-2222-2222-2222-222222222222',
        tls: { enabled: true, server_name: 'vl.example.com', reality: { public_key: 'pk', short_id: 'sid' } },
        transport: { type: 'grpc', service_name: 'svc' }
      },
      {
        type: 'hysteria2', tag: 'HY',
        server: 'hy.example.com', server_port: 8443, password: 'hp',
        tls: { enabled: true, server_name: 'hy.example.com', insecure: true }
      },
      {
        type: 'tuic', tag: 'TU',
        server: 'tu.example.com', server_port: 443,
        uuid: '33333333-3333-3333-3333-333333333333', password: 'tup',
        tls: { enabled: true, server_name: 'tu.example.com' }
      },
      { type: 'selector', tag: 'GROUP', outbounds: ['VM'] }
    ]
  }));

  expect(n.map((x) => x.name)).toEqual(['VM', 'VL', 'HY', 'TU']);
  expect(n[0]).toMatchObject({ type: 'vmess', net: 'ws', tls: 'tls', path: '/ws', host: 'cdn.example.com', fp: 'chrome' });
  expect(n[1]).toMatchObject({ type: 'vless', net: 'grpc', security: 'reality', pbk: 'pk', sid: 'sid', grpc_service: 'svc' });
  expect(n[2]).toMatchObject({ type: 'hysteria2', insecure: true, sni: 'hy.example.com' });
  expect(n[3]).toMatchObject({ type: 'tuic', version: 5, congestion: 'cubic' });
});

test('sing-box：wireguard endpoint 转换', () => {
  const n = MH.parseAnyInput(JSON.stringify({
    endpoints: [{
      type: 'wireguard', tag: 'WG',
      address: ['10.0.0.2/32', 'fd00::2/128'],
      private_key: 'private',
      peers: [{
        server: 'wg.example.com', server_port: 51820,
        public_key: 'public', pre_shared_key: 'psk',
        allowed_ips: ['0.0.0.0/0', '::/0']
      }]
    }]
  }));
  expect(n).toHaveLength(1);
  expect(n[0]).toMatchObject({
    type: 'wireguard', name: 'WG', server: 'wg.example.com', port: 51820,
    private_key: 'private', public_key: 'public', pre_shared_key: 'psk',
    ip: '10.0.0.2/32', ipv6: 'fd00::2/128'
  });
});

test('JSON 字符串数组：按分享链接解析', () => {
  const n = MH.parseAnyInput(JSON.stringify([
    'ss://YWVzLTEyOC1nY206cGFzcw==@json.example.com:8388#JSON-LINK'
  ]));
  expect(n).toHaveLength(1);
  expect(n[0]).toMatchObject({ type: 'ss', name: 'JSON-LINK', server: 'json.example.com', port: 8388 });
});

test('格式提示：QX / Surge / provider-only 给明确结论', () => {
  expect(MH.formatHint('[server_local]\nss=ss,1.2.3.4,8388')).toContain('Quantumult X');
  expect(MH.formatHint('[Proxy]\nDIRECT = direct\n[Proxy Group]\nAuto = url-test')).toContain('Surge / Loon');
  expect(MH.formatHint('proxy-providers:\n  airport:\n    type: http')).toContain('proxy-providers');
});

test('格式提示：HTML 登录页不当成节点', () => {
  expect(MH.formatHint('<!doctype html><html><body>login</body></html>')).toContain('HTML 页面');
});

test('Outline 单条 access key：无 type 也按 ss 导入', () => {
  const n = MH.parseAnyInput(JSON.stringify({
    server: 'outline.example.com', server_port: 8388,
    method: 'aes-128-gcm', password: 'pass'
  }));
  expect(n).toHaveLength(1);
  expect(n[0]).toMatchObject({ type: 'ss', name: 'outline.example.com', port: 8388 });
});

test('机场占位节点：Base64 包裹的“客户端版本太旧”要拒绝', () => {
  const fake = [
    'ss://YWVzLTEyOC1nY206cGFzcw==@127.0.0.1:12345#客户端版本太旧了',
    'ss://YWVzLTEyOC1nY206cGFzcw==@127.0.0.1:12345#请升级Shadowrocket客户端'
  ].join('\n');
  expect(MH.placeholderHint(Buffer.from(fake).toString('base64'))).toContain('客户端版本过旧');
});
