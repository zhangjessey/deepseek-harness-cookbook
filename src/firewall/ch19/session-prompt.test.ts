// src/firewall/ch19/session-prompt.test.ts —— system prompt 片段的验证
//
// 两条断言对应 dsh 模式"prompt 片段从日志折叠的状态渲染，不读文件"：
//  · 渲染是纯函数，内容来自折叠结果
//  · 注册后真的进入 dsh 组装出的 system prompt
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SystemPrompt, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { fold } from './ledger'
import { LedgerLogService } from './session-log'
import { mountLedgerPrompt, renderLedgerPrompt } from './session-prompt'

const input = { name: 'block x', action: 'deny' as const, when: { field: 'path', op: 'starts_with', value: '/admin' } }

test('账本片段：渲染的是折叠结果（空库与有规则两种情况）', () => {
  assert.match(renderLedgerPrompt([]), /为空/)

  const rules = fold([{ type: 'rule.add', id: 'a', input, at: 1, state: 'active' }])
  const text = renderLedgerPrompt(rules)
  assert.match(text, /block x/)
  assert.match(text, /active/)
})

test('片段注册后，进入 dsh 组装出的 system prompt', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LedgerLogService, { sessionId: 'sess-prompt-1' })
  await ctx.plugin(SystemPrompt)
  mountLedgerPrompt(ctx)
  await new Promise((r) => setImmediate(r)) // 等 inject 回调落地

  ctx.ledgerLog.appendFact({ type: 'rule.add', id: 'a', input, at: 1, state: 'active' })

  const assembly = await ctx.systemPrompt.assemble()
  const text = renderPrompt(assembly)
  assert.ok(text.includes('block x'), '折叠出的规则出现在组装结果里')
})
