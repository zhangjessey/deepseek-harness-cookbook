// src/firewall/ch19/agent-loop.test.ts —— 真模型 + 真实 Agent 循环里的审批闸端到端验证
//
// 这是"模型在会话里调工具"这件事的**真跑**：挂起完整的 agent-loop
// （LlmRuntime + SessionStore + SystemPrompt + ToolRuntime + AgentRegistry + AgentLoop），
// 用**真实 DeepSeek 模型**（不是 mock）在会话里被引导调用防火墙写工具，
// 看它走到 tools/pre-execute 审批闸之后是被 deny 还是放行。
//
// 断言设计：真模型输出非确定，所以钉"契约/不变量"——
//   · 级别 2（放行）：模型调用了工具 → 候选落账本（证明 tool-calling 全链路通）
//   · off（拒绝）：即便模型调用工具，账本也不可能有候选（写工具被审批闸 deny）
// 两者合起来才是"审批闸在真实 agent-loop 里生效"的完整证据。
//
// 无 DEEPSEEK_API_KEY 时整组跳过。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { LlmRuntime, createUserMessage, assertUsableApiKey } from '@deepseek-ai/dsh-llm'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { LedgerLogService } from './session-log'
import { ACTOR, Ledger } from './ledger'
import { FirewallEdit } from './tool-firewall-edit'
import { mountApproval } from './approval'

const skip = !process.env.DEEPSEEK_API_KEY
const PROVIDER = 'deepseek-official'
const MODEL = 'deepseek-v4-flash'

const output = {
  schema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
  render: (_args: unknown, value: { result: string }) => [{ type: 'text', text: value.result }],
}

const GUIDE =
  '你现在有一个工具 firewall_draft。请立即调用它起草一条规则，参数传空对象 {}，不要做任何其他事，不要输出任何解释文字。'

function registerDraftTool(ctx: Context, edit: FirewallEdit): void {
  ctx.tools.register({
    name: 'firewall_draft',
    description: '起草一条候选防火墙规则',
    parameters: { type: 'object', properties: {}, required: [] },
    output,
    execute: async () => {
      await edit.draftCandidate(
        {
          name: 'block x',
          action: 'deny',
          when: { field: 'path', op: 'starts_with', value: '/admin' },
        },
        { by: ACTOR.agentDraft },
      )
      return { result: 'drafted' }
    },
  } as never)
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

async function harness(autonomyLevel: string): Promise<{ ctx: Context; ledger: Ledger }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LedgerLogService, { sessionId: 'sess-real-agent' })

  // 真实 DeepSeek 适配器（与 shared/llm.ts 同源）
  const options = () => resolveAdapterOptions({ thinking: 'disabled' }, undefined)
  const adapter = new DeepSeekAdapter({
    options,
    resolveApiKey: async () => assertUsableApiKey(process.env.DEEPSEEK_API_KEY!, 'llm-deepseek', 'DEEPSEEK_API_KEY'),
    resolveUserId: () => getOrCreateAnonymousUserId(),
  })
  ;(ctx.llm as any).registerAdapter([PROVIDER], adapter)

  const ledger = new Ledger(ctx.ledgerLog, '/tmp/real-agent.json', 'sess-real-agent')
  const edit = new FirewallEdit(ledger)
  registerDraftTool(ctx, edit)
  mountApproval(ctx, () => autonomyLevel as never)
  return { ctx, ledger }
}

test('真模型在真实 agent-loop 里调写工具：级别 2 放行 → 候选落账本', { skip }, async () => {
  const { ctx, ledger } = await harness('2')
  const agent = ctx.agentLoop.create(SessionId('a1'), { provider: PROVIDER, model: MODEL })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: GUIDE }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)
  await new Promise((r) => setImmediate(r))

  const rules = ledger.listRules()
  assert.ok(rules.length >= 1, '真模型成功调用工具，候选落账本（tool-calling 全链路通）')
  assert.equal(rules[0]?.state, 'candidate')
})

test('真模型在真实 agent-loop 里调写工具：0 级别被审批闸 deny → 账本无候选', { skip }, async () => {
  const { ctx, ledger } = await harness('0')
  const agent = ctx.agentLoop.create(SessionId('a2'), { provider: PROVIDER, model: MODEL })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: GUIDE }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)
  await new Promise((r) => setImmediate(r))

  // 0 级别下写工具必被 pre-execute 拒绝，无论模型怎么做，账本都不可能有候选。
  assert.equal(ledger.listRules().length, 0, '0 级别下写工具被审批闸 deny，账本无候选')
})
