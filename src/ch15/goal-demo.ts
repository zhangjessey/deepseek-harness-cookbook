// src/ch15/goal-demo.ts —— 用一个目标驱动 agent 自动续跑长任务
// 跑法：npm run start:ch15
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import GoalService from '@deepseek-ai/dsh-goal'
import * as ToolGoal from '@deepseek-ai/dsh-tool-goal'
import * as GoalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'

const MODEL = 'mock'

/** 假模型：第 1 轮只干活，第 2 轮调用 update_goal 把目标标成 complete。 */
class ScriptedAdapter extends LlmAdapter {
  private calls = 0
  constructor(private refOf: () => { id: string; revision: number }) {
    super()
  }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 60_000 } })
  }
  override async *stream(): AsyncIterable<StreamChunk> {
    this.calls += 1
    if (this.calls === 2) {
      const { id, revision } = this.refOf()
      const cid = CallId('call-complete')
      const args = JSON.stringify({ goal_id: id, revision, action: 'complete' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: cid, name: 'update_goal', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: cid, name: 'update_goal', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = `第 ${this.calls} 轮：继续推进目标。`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function main(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(GoalService)
  await ctx.plugin(ToolGoal, { blockedAfterConsecutiveRounds: 3 })
  await ctx.plugin(GoalRoundDriver)

  const refBox: { ref: { id: string; revision: number } } = { ref: { id: '', revision: 1 } }
  // @ts-expect-error 第 04 讲为演示 isolate 给 ctx.llm 声明过一个占位类型，这里用的是 dsh-llm 的真实服务
  ctx.llm.registerAdapter([MODEL], new ScriptedAdapter(() => refBox.ref))

  const agent = ctx.agentLoop.create(SessionId('sess-goal'), { provider: MODEL, model: MODEL }, { cwd: process.cwd() })

  const goal = ctx.goals.create(agent, { objective: '把文档里的错别字全部改完', maxGoalRounds: 5 })
  refBox.ref = { id: goal.id, revision: goal.revision }

  console.log('--- 定义一个目标 ---')
  console.log(`  objective: ${goal.objective}`)
  console.log(
    `  phase: ${goal.phase}，activation: ${goal.activation}，roundsStarted: ${goal.roundsStarted} / ${goal.maxGoalRounds}`,
  )

  console.log('\n--- 驱动器在 idle 时自动排下一轮 ---')
  for (let i = 0; i < 4; i++) {
    await agent.whenIdle()
    const g = ctx.goals.get(agent)
    if (g === undefined) break
    console.log(`  第 ${i + 1} 次回到 idle：phase=${g.phase}，roundsStarted=${g.roundsStarted}`)
    if (g.phase !== 'active') break
  }

  console.log('\n--- 会话日志里的 goal 与轮次事件 ---')
  for (const event of agent.session.events) {
    if (event.type === 'goal/change') {
      const op = (event.data as { operation?: string })?.operation ?? 'clear'
      console.log(`  seq ${event.seq}  goal/change（${op}）`)
    } else if (event.type === 'user/message') {
      const src = (event.data as { source?: { kind?: string; round?: number } })?.source
      if (src?.kind === 'goal') {
        console.log(`  seq ${event.seq}  user/message（goal，round ${src.round}）`)
      }
    } else if (event.type === 'turn/start' || event.type === 'turn/end') {
      console.log(`  seq ${event.seq}  ${event.type}`)
    }
  }

  console.log('\n--- 最终状态 ---')
  const final = ctx.goals.get(agent)
  if (final !== undefined) {
    console.log(`  phase: ${final.phase}，roundsStarted: ${final.roundsStarted} / ${final.maxGoalRounds}`)
  }
}

await main()
