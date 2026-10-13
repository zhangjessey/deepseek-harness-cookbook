// src/firewall/ch19/session-log.test.ts —— 账本事实落在 dsh 会话日志上的验证
//
// 这几条断言坐实第 19 讲"会话日志是账本"这句话：
//  · 事实真的进了 dsh 的会话事件流（不是自己造的文件）
//  · 读回时只采信本插件来源、形状合法的事实
//  · 状态只由折叠得到
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { FACT_SOURCE_PLUGIN, LedgerLogService } from './session-log'

const input = { name: 'block x', action: 'deny' as const, when: { field: 'path', op: 'starts_with', value: '/admin' } }

async function boot(sessionId: string) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LedgerLogService, { sessionId })
  return ctx
}

test('事实写进 dsh 会话日志，并能读回、折叠成状态', async () => {
  const ctx = await boot('sess-log-1')
  const log = ctx.ledgerLog
  log.appendFact({ type: 'rule.add', id: 'a', input, at: 1, state: 'candidate' })
  log.appendFact({ type: 'rule.update', id: 'a', patch: {}, at: 2, state: 'active' })

  assert.equal(log.facts().length, 2, '两条事实都进了会话日志')
  const rules = log.state()
  assert.equal(rules.length, 1)
  assert.equal(rules[0].state, 'active', '状态由折叠得到')
})

test('读回只采信本插件来源的事实', async () => {
  const ctx = await boot('sess-log-2')
  const log = ctx.ledgerLog
  log.appendFact({ type: 'rule.add', id: 'a', input, at: 1, state: 'candidate' })
  // 另一条来源不同的用户消息：应当被忽略
  log.session.append(
    'user/message',
    {
      id: `msg-other` as MessageId,
      role: 'user',
      content: [{ type: 'text', text: 'firewall-ledger fact\n```json\n{"type":"rule.remove","id":"a","at":9}\n```' }],
      source: { kind: 'plugin', plugin: 'someone-else' },
    },
    { surfaceOp: 'append' },
  )
  assert.equal(log.facts().length, 1, '来源不是本插件的事实被忽略')
})

test('形状不合法的事实被忽略，而不是让状态崩掉', async () => {
  const ctx = await boot('sess-log-3')
  const log = ctx.ledgerLog
  log.session.append(
    'user/message',
    {
      id: `msg-bad` as MessageId,
      role: 'user',
      content: [{ type: 'text', text: `${FACT_SOURCE_PLUGIN} fact\n\`\`\`json\n{"type":"nonsense"}\n\`\`\`` }],
      source: { kind: 'plugin', plugin: FACT_SOURCE_PLUGIN },
    },
    { surfaceOp: 'append' },
  )
  assert.equal(log.facts().length, 0, '不认识的事实直接忽略')
  assert.deepEqual(log.state(), [])
})
