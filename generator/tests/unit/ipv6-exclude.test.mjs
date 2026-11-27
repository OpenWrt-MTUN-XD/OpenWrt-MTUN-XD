import { expect, test } from 'bun:test';
import { loadCore, loadFixtures } from '../helpers/load.mjs';

const MH = loadCore();
const fx = loadFixtures();

// buildConfig 要求至少一个节点，空状态会直接抛「请先导入节点」——用 fixture 的节点铺底
function build(over) {
  const s = MH.ui.state;
  Object.assign(s, MH.defaultState());
  s.nodes = MH.parseAnyInput(fx.nodes_text);
  s.secret = '123456';
  s.port = 9090;
  Object.assign(s, over);
  return MH.ui.buildConfig();
}

test('ipv6 关闭：route-exclude 只留 IPv4，且不写 inet6-address', () => {
  const t = build({ ipv6: false, ipv6ViaNode: false });
  expect(t).toContain('  route-exclude-address:');
  expect(t).toContain('    - 10.0.0.0/8');
  expect(t).not.toContain('fc00::/7');
  expect(t).not.toContain('fe80::/10');
  expect(t).not.toContain('inet6-address:');
});

test('ipv6 开启 + 走节点：inet6-address 与 v6 排除都在', () => {
  const t = build({ ipv6: true, ipv6ViaNode: true });
  expect(t).toContain('  inet6-address:');
  expect(t).toContain('    - fdfe:dcba:9876::1/126');
  expect(t).toContain('    - fc00::/7');
  expect(t).toContain('    - fe80::/10');
});
