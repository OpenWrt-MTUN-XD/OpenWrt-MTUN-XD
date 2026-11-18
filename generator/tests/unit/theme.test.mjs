import { beforeEach, describe, expect, test } from 'bun:test';
import { loadCore } from '../helpers/load.mjs';

// theme.js 是浏览器里的传统脚本（挂在 globalThis.MHTheme 上），加载器已经 eval 过
loadCore();

const store = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

function loc(search) { globalThis.location = { search }; }
function systemDark(dark) {
  globalThis.matchMedia = (q) => ({ matches: !!dark && /dark/.test(q) });
}

beforeEach(() => {
  store.clear();
  loc('');
  systemDark(false);
});

describe('主题来源：?theme= > 面板绿点记号 > 系统', () => {
  test('宿主 ?theme= 最高优先级（哪怕面板记号是反的）', () => {
    store.set('mihomo-gen-theme', 'light');
    loc('?noframe=1&theme=dark');
    expect(MHTheme.hint()).toBe('dark');
  });

  test('面板记号：light / dark 都认，别的值一律不认', () => {
    store.set('mihomo-gen-theme', 'dark');
    expect(MHTheme.hint()).toBe('dark');
    store.set('mihomo-gen-theme', 'sunset');   // daisyUI 主题名不该流进来
    expect(MHTheme.hint()).toBe('');
  });

  test('嵌在 LuCI 里（noframe）不认面板记号 —— 别盖掉宿主的明确选择', () => {
    store.set('mihomo-gen-theme', 'dark');
    loc('?noframe=1');
    expect(MHTheme.hint()).toBe('');
    // 但宿主自己带的 ?theme= 照样认
    loc('?noframe=1&theme=light');
    expect(MHTheme.hint()).toBe('light');
  });

  test('没有宿主、没有记号 → 空串（交给系统）', () => {
    loc('?secret=abc&listen=127.0.0.1');
    expect(MHTheme.hint()).toBe('');
  });

  test('系统明暗：prefers-color-scheme 说了算；拿不到 media query 当浅色', () => {
    systemDark(true);
    expect(MHTheme.system()).toBe('dark');
    systemDark(false);
    expect(MHTheme.system()).toBe('light');
    delete globalThis.matchMedia;
    expect(MHTheme.system()).toBe('light');
  });
});
