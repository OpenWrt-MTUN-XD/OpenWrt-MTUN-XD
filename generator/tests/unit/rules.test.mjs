import { describe, expect, test } from 'bun:test';
import { loadCore } from '../helpers/load.mjs';

const MH = loadCore();
const ui = MH.ui;

/**
 * 「自定义规则出口」的两处缺陷：
 *   ① 待添加的出口被按「菜单里能不能选」过滤 → 变成默认出口/进了智能组就被重置成 DIRECT
 *   ② 打开智能选择时，反选全丢的多节点规则被整条删掉（用户丢数据，且没有任何提示）
 */
describe('自定义规则出口', () => {
  test('validRuleActions：节点还在就保留，不因为"菜单里不列它"变成 DIRECT', () => {
    // 按 ruleOptions（会剔掉默认出口 / 智能组成员）过滤 ⇒ 这里会得到 ['DIRECT']
    expect(ui.validRuleActions(['B'], ['A', 'B', 'C'])).toEqual(['B']);
    expect(ui.validRuleActions(['B', 'C'], ['A', 'B', 'C'])).toEqual(['B', 'C']);
  });

  test('validRuleActions：节点被删掉才剔除；一个都不剩才回落 DIRECT', () => {
    expect(ui.validRuleActions(['B', 'C'], ['A'])).toEqual(['DIRECT']);
    expect(ui.validRuleActions(['B'], ['A'])).toEqual(['DIRECT']);
    expect(ui.validRuleActions([], ['A'])).toEqual(['DIRECT']);
    expect(ui.validRuleActions(['DIRECT', 'B'], ['B'])).toEqual(['DIRECT']);
  });

  test('narrowRuleActions：反选全丢时降级成单选，不删规则', () => {
    expect(ui.narrowRuleActions(['A', 'B'], [])).toEqual(['A']);
    expect(ui.narrowRuleActions(['A', 'B'], ['B'])).toEqual(['B']);
    expect(ui.narrowRuleActions(['A'], [])).toEqual(['A']);
    expect(ui.narrowRuleActions(['DIRECT'], ['A'])).toEqual(['DIRECT']);
  });
});
