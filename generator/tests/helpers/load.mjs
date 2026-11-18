/**
 * 测试用的加载器：把 app/ 下的传统脚本（非 ES module）按依赖顺序 eval 进
 * 全局作用域，返回同一个 MH 命名空间。
 *
 * 浏览器里这些文件是 <script> 顺序加载的；这里等价地重放一遍，
 * 保证测试跑的就是浏览器里跑的那份代码（没有构建步骤，也就没有两套产物）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');

// 顺序即依赖顺序：util → yaml → parsers → render → engines → state → ui
const FILES = [
  ['app', 'vendor', 'js-yaml.min.js'],
  ['app', 'core', 'util.js'],
  ['app', 'core', 'yaml.js'],
  ['app', 'core', 'parsers.js'],
  ['app', 'core', 'render.js'],
  ['app', 'core', 'engines.js'],
  ['app', 'core', 'yaml-load.js'],
  ['app', 'theme-hint.js'],
  ['app', 'state.js'],
  ['app', 'ui.js'],
];

let loaded = false;

/**
 * 加载（幂等）并返回全局 MH 命名空间。
 *
 * ui.js 是界面层，但它里面那个 `buildConfig()`（把 state 映射成引擎参数、按模式分派）是纯函数、
 * 不碰 DOM，而它恰恰是最复杂的逻辑（20 多项赋值 + 模式分派），漏一个字段就会静默生成错的配置。
 * 所以这里给一个空的 document 桩：ui.js 顶层只有 `if (!doc) return` 这一处依赖，有了桩它就能把
 * 函数都定义出来。
 * 注意：只 stub 顶层加载，不要调用 `MH.ui.init()` —— 那个真的会去操作 DOM。
 */
export function loadCore() {
  if (!loaded) {
    if (!globalThis.document) globalThis.document = {};
    // bun 里没有 localStorage，而 state.js 的 load/save/migrate 全靠它 ——
    // 不给桩的话那一段是测试盲区（读不到就静默返回，测了也等于没测）。
    if (!globalThis.localStorage) {
      const store = new Map();
      globalThis.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
        removeItem: (k) => { store.delete(k); },
        clear: () => { store.clear(); },
      };
    }
    for (const parts of FILES) {
      const code = readFileSync(join(ROOT, ...parts), 'utf8');
      // 间接 eval：在全局作用域执行，`this` 就是 globalThis
      (0, eval)(code);
    }
    loaded = true;
  }
  return globalThis.MH;
}

/** 读取 golden fixtures。 */
export function loadFixtures() {
  return JSON.parse(readFileSync(join(ROOT, 'tests', 'golden', 'fixtures.json'), 'utf8'));
}
