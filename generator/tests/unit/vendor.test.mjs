import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadCore } from '../helpers/load.mjs';

/**
 * app/vendor/ 下是仓库里唯一的第三方代码，把哈希钉死。
 *
 * 这个值来自 js-yaml 4.1.0 的官方发布物，已用三条独立来源核对过、三者一致：
 *   * jsDelivr  https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js
 *   * unpkg     https://unpkg.com/js-yaml@4.1.0/dist/js-yaml.min.js
 *   * npm 官方 tarball  https://registry.npmjs.org/js-yaml/-/js-yaml-4.1.0.tgz
 *     （包内 package/dist/js-yaml.min.js）
 *
 * 升级依赖时这个断言会失败 —— 那是提醒你重新核对来源，**不是**让你直接把
 * 新哈希粘进去就完事。
 */
const JS_YAML_SHA256 = '45dc3dd03dc07a06705a2c2989b8c7f7';

describe('第三方文件完整性', () => {
  test('js-yaml 4.1.0 与官方发布物逐字节一致', () => {
    const buf = readFileSync(join(ROOT, 'app', 'vendor', 'js-yaml.min.js'));
    const hash = createHash('sha256').update(buf).digest('hex');
    expect(hash.slice(0, 32)).toBe(JS_YAML_SHA256);
    // 版本号也要对得上，免得哈希和版本被人一起换掉还看不出来
    expect(buf.toString('utf8', 0, 60)).toContain('js-yaml 4.1.0');
  });

  test('适配层只用官方 API，没有猴子补丁', () => {
    // yaml-load.js 换 schema 走的是 jsyaml.Type + DEFAULT_SCHEMA.extend，
    // 如果哪天改成直接改 jsyaml 内部对象，这里会炸。
    const src = readFileSync(join(ROOT, 'app', 'core', 'yaml-load.js'), 'utf8');
    expect(src).toContain('jsyaml.DEFAULT_SCHEMA.extend');
    expect(src).not.toMatch(/jsyaml\.\w+\s*=\s*function/);
  });

  test('PyYAML 风格的布尔表确实生效', () => {
    const MH = loadCore();
    const parsed = MH.yamlLoad('a: yes\nb: no\nc: on\nd: off\ne: true\nf: nope\n');
    expect(parsed).toEqual({ a: true, b: false, c: true, d: false, e: true, f: 'nope' });
  });
});
