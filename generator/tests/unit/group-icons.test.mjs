import { expect, test } from 'bun:test';
import { loadCore } from '../helpers/load.mjs';

const MH = loadCore();

test('组名图标：全部单码点、互不重复', () => {
  const icons = MH.SplitEngine.GROUP_ICONS;
  expect(Array.isArray(icons)).toBe(true);
  expect(new Set(icons).size).toBe(icons.length);
  for (const ic of icons) expect(Array.from(ic)).toHaveLength(1);
});
