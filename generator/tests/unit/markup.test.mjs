import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';

/*
 * index.html 的结构体检。
 *
 * 勾选框 `<label class="check">` 改 `<div>` 时，带 `id=` 的行只换了开标签、`</label>` 忘了换的话
 * 浏览器会把后面的卡片全塞进那个 div 里，「设置」整页挤成一条窄列、卡片互相重叠。单元测试跑不到
 * DOM，所以这里用最朴素的标签配平来兜底：数量对不上、或某个 .check 行里出现 `</label>`，直接红。
 */
const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const count = (re) => (html.match(re) || []).length;

describe('index.html 结构', () => {
  test('div / label 标签配平', () => {
    expect(count(/<div\b/g)).toBe(count(/<\/div>/g));
    expect(count(/<label\b/g)).toBe(count(/<\/label>/g));
  });

  test('勾选框一律 div.check，行内不夹 </label>', () => {
    expect(html).not.toContain('<label class="check"');
    const bad = html.split('\n').filter((ln) => ln.includes('class="check"') && ln.includes('</label>'));
    expect(bad).toEqual([]);
  });
});
