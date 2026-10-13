// src/firewall/ch19/session-projection.test.ts —— 投影的验证
//
// 两条断言对应第 19 讲"一处折叠，三处使用"：
//  · 单元层：apply 增量累积事实、view 折叠出状态，与直接 fold 结果一致
//  · 集成层：注册进 dsh 的投影注册表后，snapshot 能读到同一个值
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { RuleEvent } from './ledger'
import { FACT_SOURCE_PLUGIN, LedgerLogService, type SessionEventLike } from './session-log'
import { LEDGER_PROJECTION_KEY, ledgerProjection, mountLedgerProjection } from './session-projection'

const input = { name: 'block x', action: 'deny' as const, when: { field: 'path', op: 'starts_with', value: '/admin' } }

function eventOf(fact: RuleEvent): SessionEventLike {
  return {
    type: 'user/message',
    data: {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `${FACT_SOURCE_PLUGIN} fact\n\`\`\`json\n${JSON.stringify(fact)}\n\`\`\``,
        },
      ],
      source: { kind: 'plugin', plugin: FACT_SOURCE_PLUGIN },
    },
  }
}

test('投影单元：apply 增量累积，view 折叠出与 fold 一致的状态', () => {
  let state = ledgerProjection.init()
  assert.deepEqual(ledgerProjection.view(state).rules, [])

  state = ledgerProjection.apply(state, eventOf({ type: 'rule.add', id: 'a', input, at: 1, state: 'candidate' }))
  const unrelated = { type: 'turn/start', data: {} } as SessionEventLike
  const same = ledgerProjection.apply(state, unrelated)
  assert.equal(same, state, '不关心的事件必须返回同一引用（下游零工作量）')

  state = ledgerProjection.apply(state, eventOf({ type: 'rule.update', id: 'a', patch: {}, at: 2, state: 'active' }))

  const view = ledgerProjection.view(state)
  assert.equal(view.rules.length, 1)
  assert.equal(view.rules[0].state, 'active')
})

test('注册进 dsh 投影注册表后，snapshot 读到同一个值', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(LedgerLogService, { sessionId: 'sess-proj-1' })
  mountLedgerProjection(ctx)
  await new Promise((r) => setImmediate(r)) // 让 inject 回调落地

  const log = ctx.ledgerLog
  log.appendFact({ type: 'rule.add', id: 'a', input, at: 1, state: 'candidate' })
  log.appendFact({ type: 'rule.update', id: 'a', patch: {}, at: 2, state: 'active' })

  const snapshot = ctx.sessionProjections.snapshot(log.session)
  const value = snapshot.values[LEDGER_PROJECTION_KEY]
  assert.ok(value, '投影 key 出现在快照里')
  const rules = (value as { rules: Array<{ id: string; state: string }> }).rules
  assert.equal(rules.length, 1)
  assert.equal(rules[0].state, 'active', '快照里的状态与折叠一致')
})
