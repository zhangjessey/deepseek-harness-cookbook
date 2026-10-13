// src/firewall/ch19/agent-draft.test.ts —— when 结构校验的单元测试（免 key）
//
// "受约束生成"的约束是写在代码里的（isValidRuleWhen），不靠提示词。
// 这里钉死：合法叶子通过；field 拼错 / op 不在契约 / 空 value / 非对象 一律拒绝。
// 因为 ch18 引擎对非法 when 是"静默不匹配"（该拦的没拦、还不报错），
// 所以这一层校验必须在进入 ledger 之前就拦下。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isValidRuleWhen } from './agent-draft'

test('isValidRuleWhen：合法叶子通过', () => {
  assert.ok(isValidRuleWhen({ field: 'path', op: 'starts_with', value: '/admin' }))
  assert.ok(isValidRuleWhen({ field: 'ua', op: 'contains', value: 'python' }))
  assert.ok(isValidRuleWhen({ field: 'method', op: 'eq', value: 'POST' }))
})

test('isValidRuleWhen：field 拼错 / op 不在契约 / 空 value 拒绝', () => {
  assert.ok(!isValidRuleWhen({ field: 'pathh', op: 'eq', value: '/x' }), 'field 拼错')
  assert.ok(!isValidRuleWhen({ field: 'path', op: 'regex', value: '/x' }), 'op 不在契约')
  assert.ok(!isValidRuleWhen({ field: 'path', op: 'eq', value: '' }), '空 value')
})

test('isValidRuleWhen：非对象 / 缺字段拒绝', () => {
  assert.ok(!isValidRuleWhen(null))
  assert.ok(!isValidRuleWhen('string'))
  assert.ok(!isValidRuleWhen({ field: 'path' }), '缺 op/value')
  assert.ok(!isValidRuleWhen({ op: 'eq' }), '缺 field')
})
