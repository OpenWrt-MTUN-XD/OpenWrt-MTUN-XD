import { describe, expect, test } from 'bun:test';
import { loadCore } from '../helpers/load.mjs';

const MH = loadCore();

/**
 * `MH.randomSecret()` —— 「面板密码」旁边那个「随机」按钮。
 *
 * 这里能测的只有「它生成了个什么东西」：长度、字符集、随机性、n 的容错。真正要防的写在实现里，
 * 顺手在这儿钉一下，免得以后有人往字符集里加符号：
 *   · 字符集必须只有 [A-Za-z0-9] —— 这个值要穿过 YAML、shell 的 Authorization 头、CGI 的 sed、
 *     面板的 localStorage；
 *   · 不许出现空白/引号（`cleanSecret` 会把它们吃掉，密码就悄悄变成另一个了）。
 */
describe('随机面板密码', () => {
  const ABC = /^[A-Za-z0-9]+$/;

  test('默认 16 位，字符集只有字母数字', () => {
    const s = MH.randomSecret();
    expect(s.length).toBe(16);
    expect(ABC.test(s)).toBe(true);
  });

  test('长度可以指定，非法值回落到 16', () => {
    expect(MH.randomSecret(8).length).toBe(8);
    expect(MH.randomSecret(32).length).toBe(32);
    expect(MH.randomSecret('24').length).toBe(24);   // 走 sInt，字符串也认
    for (const bad of [0, -5, undefined, null, '', 'abc', 1.5]) {
      expect(MH.randomSecret(bad).length).toBe(16);
    }
  });

  test('连着要两串不会一样', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(MH.randomSecret());
    expect(seen.size).toBe(200);
  });

  test('每个字符都出现过（取样无偏的话 62 个字符都会轮到）', () => {
    // 200 串 × 16 位 = 3200 个字符，漏掉某个字符的概率约 62·e^-51，可以忽略
    let all = '';
    for (let i = 0; i < 200; i++) all += MH.randomSecret();
    expect(new Set(all).size).toBe(62);
  });

  test('里面不会混进空白或引号（否则会被 cleanSecret 悄悄吃掉）', () => {
    for (let i = 0; i < 200; i++) {
      const s = MH.randomSecret();
      expect(s).toBe(MH.cleanSecret(s));
    }
  });

  test('生成的密码原样穿过 YAML 引号（产出的 secret 行能读回来）', () => {
    // 就是 mihomo-apply 里那句 `sed … | tr -d '"'` 的等价物
    for (let i = 0; i < 50; i++) {
      const s = MH.randomSecret();
      const line = 'secret: ' + JSON.stringify(s);
      const back = line.replace(/^secret:[ \t]*/, '').replace(/["' ]/g, '');
      expect(back).toBe(s);
    }
  });
});
