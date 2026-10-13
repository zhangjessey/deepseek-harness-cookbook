// src/firewall/ch18/condition.test.ts —— 条件树校验器与叶子视图的单元测试
//
// 这份校验器是跨讲契约（ch18 规则文件 / ch20 候选 / ch21 评测与确认都用它），
// 所以它自己必须先被钉住：字段白名单、算子白名单、value 形状、组合结构展开。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isKnownField, isValidCondition, leavesOf } from './condition'

test('isValidCondition：叶子 / and / or / not 合法', () => {
  assert.ok(isValidCondition({ field: 'path', op: 'starts_with', value: '/admin' }))
  assert.ok(isValidCondition({ and: [{ field: 'path', op: 'eq', value: '/a' }] }))
  assert.ok(isValidCondition({ or: [{ field: 'ua', op: 'contains', value: 'python' }] }))
  assert.ok(isValidCondition({ not: { field: 'ip', op: 'eq', value: '1.2.3.4' } }))
  // 嵌套组合
  assert.ok(
    isValidCondition({
      and: [{ field: 'path', op: 'starts_with', value: '/admin' }, { not: { field: 'ua', op: 'eq', value: 'ok' } }],
    }),
  )
})

test('isValidCondition：未知字段 / 非法算子 / value 形状不符都拒绝', () => {
  // 未知字段让取值返回 undefined：ne 恒真（全站 403）、eq/contains 恒假（全放行），
  // 两种都是静默失效，必须在校验阶段拒掉。
  assert.ok(!isValidCondition({ field: 'nope', op: 'ne', value: 1 }))
  assert.ok(!isValidCondition({ field: 'header.', op: 'eq', value: 'x' }), '空的 header. 名也要拒')
  assert.ok(isValidCondition({ field: 'header.X-Forwarded-For', op: 'eq', value: '1.2.3.4' }))
  assert.ok(!isValidCondition({ field: 'path', op: 'regex', value: 'x' }), 'op 必须在算子白名单内')
  assert.ok(!isValidCondition({ field: 'path', op: 'eq' }), 'eq 缺 value')
  assert.ok(!isValidCondition({ field: 'path', op: 'matches', value: 1 }), 'matches 的 value 必须是字符串')
  assert.ok(!isValidCondition({ field: 'path', op: 'in', value: 'x' }), 'in 的 value 必须是数组')
  assert.ok(!isValidCondition(null))
  assert.ok(!isValidCondition('x'))
})

test('isKnownField：七个请求字段 + header./query. 前缀', () => {
  for (const f of ['method', 'path', 'body', 'ip', 'ua']) assert.ok(isKnownField(f))
  assert.ok(isKnownField('header.cookie'))
  assert.ok(isKnownField('query.role'))
  assert.ok(!isKnownField('cookie'), '没有 header. 前缀就不算已知字段')
  assert.ok(!isKnownField('header.'))
})

test('leavesOf：收集所有叶子（and / or / not 都会展开，含嵌套）', () => {
  assert.deepEqual(leavesOf({ field: 'path', op: 'eq', value: '/a' }), [{ field: 'path', op: 'eq', value: '/a' }])
  assert.deepEqual(
    leavesOf({
      and: [
        { field: 'path', op: 'starts_with', value: '/a' },
        { field: 'ua', op: 'contains', value: 'x' },
      ],
    }),
    [
      { field: 'path', op: 'starts_with', value: '/a' },
      { field: 'ua', op: 'contains', value: 'x' },
    ],
  )
  assert.deepEqual(leavesOf({ not: { or: [{ field: 'ip', op: 'eq', value: '1' }] } }), [
    { field: 'ip', op: 'eq', value: '1' },
  ])
})

test('leavesOf：非对象返回空数组，绝不返回带 undefined 字段的叶子', () => {
  // 这正是它存在的理由：ch21 的意图/风险关卡、证据逆推若各自 `as Record<string, unknown>`
  // 去读 `.field`，遇到 and / or / not 会拿到 **undefined** 而静默判错——
  // 组合型候选于是要么被误杀、要么被漏判。这个入口保证拿到的叶子字段都是真字符串。
  assert.deepEqual(leavesOf(null), [])
  assert.deepEqual(leavesOf('x'), [])
  assert.deepEqual(leavesOf(42), [])
  for (const leaf of leavesOf({ and: [{ field: 'path', op: 'contains', value: '/' }] })) {
    assert.equal(typeof leaf.field, 'string')
    assert.equal(typeof leaf.op, 'string')
  }
})

test('空组合与空集合一律拒绝（空 and 恒真 / 空 or 恒假 / 空 in 恒不含）', () => {
  // 三种都能通过"键存在性"检查，却都让规则静默失效或静默命中：
  //   · `and: []`：引擎里空数组的 `every` 是真空真 → **命中一切请求**
  //     （配成 allow 就是白名单下全放行，配成 deny 就是全站 403，放在 unless 上
  //      就是那条 deny 规则永不触发）
  //   · `or: []` ：`some` 是真空假 → 规则永不生效，等于没写
  //   · `in: []` ：恒不含任何值 → 同上
  assert.ok(!isValidCondition({ and: [] }), '空 and 必须拒绝（它会命中一切请求）')
  assert.ok(!isValidCondition({ or: [] }), '空 or 必须拒绝（它会让规则永不生效）')
  assert.ok(!isValidCondition({ not: { or: [] } }), '嵌套的空 or 也要拒绝')
  assert.ok(!isValidCondition({ field: 'path', op: 'in', value: [] }), '空 in 必须拒绝')
  // 非空仍然合法（别把正常的组合一起拒了）
  assert.ok(isValidCondition({ and: [{ field: 'path', op: 'eq', value: '/a' }] }))
  assert.ok(isValidCondition({ or: [{ field: 'path', op: 'eq', value: '/a' }] }))
  assert.ok(isValidCondition({ field: 'path', op: 'in', value: ['/a'] }))
})

test('循环引用不栈溢出：isValidCondition 与 leavesOf 都要兜住', () => {
  // JSON 表达不了环、文件路径安全，但运行时 API（addRule/loadRules、ch21 候选对象）
  // 可以传入。没有 seen 兜底就会无限递归直到栈溢出（DoS）。
  const c = { and: [] } as Record<string, unknown>
  ;(c.and as unknown[]).push(c)
  assert.equal(isValidCondition(c), false, '循环引用 → 非法，且不栈溢出')
  assert.equal(leavesOf(c).length, 0, 'leavesOf 遇到环要停止展开，且不栈溢出')

  const viaNot = { not: {} } as Record<string, unknown>
  viaNot.not = viaNot
  assert.equal(isValidCondition(viaNot), false)
  assert.equal(leavesOf(viaNot).length, 0)
})
