// src/firewall/ch19/approval-e2e.test.ts —— 审批闸在真实 tools 管道里的端到端验证
//
// 这是"让专职 Agent 安全地改东西"这条线的端到端测试：不走纯函数、不走手工 emit，
// 而是真的挂起 dsh 的 tools 服务（ToolRuntime），注册工具，再通过
// `ctx.tools.execute(...)` 触发一次完整调用——它内部会按顺序走
// pre-execute 策略 → 单调 guard → around-dispatch → post-policy，
// 我们的审批监听器与白名单守卫就在这条真实管线上被调用。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { LedgerLogService } from './session-log'
import { ACTOR, Ledger } from './ledger'
import { FirewallEdit } from './tool-firewall-edit'
import { mountApproval } from './approval'

// dsh 工具的输出 schema 是 JSON Schema（不是 zod）：注册时据此校验 canonical value。
const output = {
  schema: {
    type: 'object',
    properties: { result: { type: 'string' } },
    required: ['result'],
  },
  render: (_args: unknown, value: { result: string }) => [{ type: 'text', text: value.result }],
}

async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LedgerLogService, { sessionId: 'sess-e2e' })
  await ctx.plugin(SystemPrompt) // ToolRuntime 的依赖
  await ctx.plugin(ToolRuntime)
  return ctx
}

function run(name: string) {
  return { callId: 'call-1' as never, name, arguments: {}, signal: new AbortController().signal } as never
}

test('审批闸端到端：0 级别写工具被拒、读工具放行', async () => {
  const ctx = await boot()
  const ledger = new Ledger(ctx.ledgerLog, '/tmp/e2e-1.json', 'sess-e2e')
  const edit = new FirewallEdit(ledger)

  ctx.tools.register({
    name: 'firewall_draft',
    description: '起草候选',
    output,
    execute: async () => {
      await edit.draftCandidate(
        {
          name: 'x',
          action: 'deny',
          when: { field: 'path', op: 'starts_with', value: '/admin' },
        },
        { by: ACTOR.agentDraft },
      )
      return { result: 'drafted' }
    },
  } as never)
  ctx.tools.register({
    name: 'firewall_list',
    description: '列出规则',
    output,
    execute: async () => ({ result: 'rules' }),
  } as never)

  mountApproval(ctx, () => '0')
  await new Promise((r) => setImmediate(r))

  const write = await ctx.tools.execute(run('firewall_draft'))
  assert.equal(write.isError, true, '0 级别下写工具被 pre-execute 拒绝')
  assert.match(write.error.message, /自主级别 0/, '拒绝理由包含自主级别 0')

  const read = await ctx.tools.execute(run('firewall_list'))
  assert.equal(read.isError, false, '读工具不受自主级别限制，正常执行')
})

test('审批闸端到端：级别 2 写工具放行，白名单外工具被 guard 拒绝', async () => {
  const ctx = await boot()
  const ledger = new Ledger(ctx.ledgerLog, '/tmp/e2e-2.json', 'sess-e2e')
  const edit = new FirewallEdit(ledger)

  ctx.tools.register({
    name: 'firewall_draft',
    description: '起草候选',
    output,
    execute: async () => {
      await edit.draftCandidate(
        {
          name: 'x',
          action: 'deny',
          when: { field: 'path', op: 'starts_with', value: '/admin' },
        },
        { by: ACTOR.agentDraft },
      )
      return { result: 'drafted' }
    },
  } as never)
  ctx.tools.register({
    name: 'bash',
    description: '不在白名单里',
    output,
    execute: async () => ({ result: 'pwned' }),
  } as never)

  mountApproval(ctx, () => '2')
  await new Promise((r) => setImmediate(r))

  const draft = await ctx.tools.execute(run('firewall_draft'))
  assert.equal(draft.isError, false, '级别 2 写工具放行（由其他机制把关）')

  const bash = await ctx.tools.execute(run('bash'))
  assert.equal(bash.isError, true, '白名单外的工具被 guard 拒绝')
  assert.match(bash.error.message, /白名单/, '拒绝理由指向白名单')
})
