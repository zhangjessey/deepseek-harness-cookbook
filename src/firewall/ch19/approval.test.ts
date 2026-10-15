// src/firewall/ch19/approval.test.ts —— 审批与白名单规则的验证
//
// 断言的是"人始终在 Agent 之上"这条主张的可测部分：
//  · 写操作在 0 / manual / off 下一定被拦
//  · 读操作不受自主级别限制（否则 Agent 连"看"都做不到，也就没法起草）
//  · 白名单外的工具一律拒绝，且守卫只收紧不放宽
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ALLOWED_TOOLS, WRITE_TOOLS, denyReasonFor, guardReasonFor } from './approval'
import type { AutonomyLevel } from './command-firewall'

test('写操作在 0 / manual / off 下被拦下', () => {
  for (const level of ['0', 'manual', 'off'] as const) {
    for (const tool of ['firewall_draft', 'firewall_approve', 'firewall_reject']) {
      assert.ok(denyReasonFor(level, tool), `${level} 下 ${tool} 必须被拦`)
    }
  }
})

test('级别 1 / 2 的写操作不在这一层拦；读操作任何级别都不拦', () => {
  assert.equal(denyReasonFor('1', 'firewall_draft'), undefined)
  assert.equal(denyReasonFor('2', 'firewall_approve'), undefined)
  assert.equal(denyReasonFor('0', 'firewall_list'), undefined, '读操作不受自主级别限制')
})

test('白名单外的工具一律拒绝，名单内的放行', () => {
  assert.equal(guardReasonFor('firewall_list'), undefined)
  assert.equal(guardReasonFor('firewall_draft'), undefined)
  assert.ok(guardReasonFor('bash'), '白名单外的工具要给出拒绝理由')
  assert.ok(guardReasonFor('firewall_unknown'))
})

test('写操作集合是白名单的子集（不会出现"允许了却没定义"的工具）', () => {
  for (const tool of WRITE_TOOLS) assert.ok(ALLOWED_TOOLS.has(tool), `${tool} 必须在白名单里`)
})

test('未知级别一律拒绝（"拒绝名单"写反会让 OFF / 00 / toString 静默放行）', () => {
  // 若把 denyReasonFor 写成"只拒 off/0/manual，其余放行"，一次大小写差异或拼写错误
  // 就能把 off 变成全自动；`toString`、`constructor` 这类原型键同理（曾被 `in` 放过）。
  for (const lv of ['OFF', '00', 'toString', 'constructor', ''] as unknown as AutonomyLevel[]) {
    assert.ok(denyReasonFor(lv, 'firewall_draft'), `级别 ${String(lv)} 必须被拒，不能静默放行`)
  }
})

test('转正与下线永远比起草更需要人（级别 1 / 2 不是"全放行"）', () => {
  assert.equal(denyReasonFor('1', 'firewall_draft'), undefined, '级别1：起草进 shadow 是自动的')
  assert.ok(denyReasonFor('1', 'firewall_approve'), '级别1：转正必须人确认')
  assert.ok(denyReasonFor('1', 'firewall_reject'), '级别1：下线必须人确认')
  assert.equal(denyReasonFor('2', 'firewall_approve'), undefined, '级别2：新增类过门槛可自动转正')
  assert.ok(denyReasonFor('2', 'firewall_reject'), '级别2：收窄与下线必须人确认')
})

test('Agent 不能给自己提级（firewall_level 任何级别都拒绝）', () => {
  // 级别调整改变的是权限本身：若允许 Agent 调用，它在任何级别都能把自己提到 2。
  for (const lv of ['0', 'manual', '1', '2'] as const) {
    const reason = denyReasonFor(lv, 'firewall_level')
    assert.ok(reason, `${lv} 下 Agent 也不能调级别`)
    assert.ok(reason.includes('人调整'), '理由应指向人的界面')
  }
})
