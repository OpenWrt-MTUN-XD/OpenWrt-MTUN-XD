import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `app/vendor/sha256.js` —— 纯 JS 实现的 SHA-256。
 *
 * ⚠️ 为什么要自己实现：`crypto.subtle` 要求安全上下文，而路由器上这个页面是 http + 内网 IP，
 *    那个 API 根本不存在（`crypto.getRandomValues` 不受限）。
 * ⚠️ 手写 hash 最容易错在补位和跨块边界上，所以两头夹：官方测试向量（FIPS 180-4，不依赖外部
 *    实现）+ 拿 node:crypto 当对照物把 0～200 每个长度都跑一遍。
 */
const SRC = readFileSync(
  join(import.meta.dir, '..', '..', 'app', 'vendor', 'sha256.js'),
  'utf8'
);

// 按浏览器里那种「挂全局」的方式加载（这份文件本来就是个 IIFE）
const g = {};
new Function('globalThis', SRC).call(g, g);
const hex = g.MHSha256.hex;

/** 官方测试向量（FIPS 180-4 / NIST 的示例）。 */
const VECTORS = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ['The quick brown fox jumps over the lazy dog',
    'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592'],
];

describe('纯 JS SHA-256', () => {
  test('官方测试向量', () => {
    for (const [input, want] of VECTORS) {
      expect(hex(input)).toBe(want);
    }
  });

  test('每个长度都对得上 node:crypto（补位/跨块边界的坑全在这一轮里）', () => {
    for (let len = 0; len <= 200; len++) {
      const s = 'x'.repeat(len);
      expect(hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
    }
  });

  test('非 ASCII 走的是 UTF-8（不是 UTF-16）', () => {
    for (const s of ['中文密码', 'длинный пароль', '🔑🔒🔐', 'naïve café — ok']) {
      expect(hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
    }
  });

  test('随机串也对得上（含空串和超长的）', () => {
    let s = '';
    for (let i = 0; i < 500; i++) {
      s += String.fromCharCode(33 + (i * 7) % 90);
      expect(hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
    }
  });

  test('空/未定义当空串处理，不抛异常', () => {
    expect(hex(null)).toBe(VECTORS[0][1]);
    expect(hex(undefined)).toBe(VECTORS[0][1]);
  });
});
