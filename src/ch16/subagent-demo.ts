// src/ch16/subagent-demo.ts —— 父 agent 用 spawn 委派一个子 agent 去"数文件"
// 跑法：npm run start:ch16
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'

const MODEL = 'mock'

/** 假模型：无论问什么，都回答"仓库里一共 42 个文件"。 */
class ScriptedAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 60_000 } })
  }
  override async *stream(): AsyncIterable<StreamChunk> {
    const text = '仓库里一共 42 个文件。'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** 提取 assistant 输出里的纯文本。 */
function text(blocks: { type: string; text?: string }[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text).join('')
}

async function main(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawnInProcess)

  // @ts-expect-error 第 04 讲为演示 isolate 给 ctx.llm 声明过一个占位类型，这里用的是 dsh-llm 的真实服务
  ctx.llm.registerAdapter([MODEL], new ScriptedAdapter())

  const parent = ctx.agentLoop.create(
    SessionId('sess-parent'),
    { provider: MODEL, model: MODEL },
    { cwd: process.cwd() },
  )

  console.log('--- 委派：父 agent 把活交给子 agent ---')
  console.log(`  父会话：${parent.session.header.id}`)

  const run = await ctx.subagents.start('spawn', {
    parent,
    prompt: [{ type: 'text', text: '数一下这个仓库里有多少个文件，直接回答。' }],
    signal: new AbortController().signal,
  })

  const child = ctx.agents.get(run.id)
  console.log(`  子会话是新会话：${run.id !== parent.session.header.id}（spawn 看不到父的历史）`)
  console.log(`  子 agent 的委派深度：${child?.session.header.delegationDepth}`)

  const result = await run.result
  console.log('\n--- 子 agent 的结果 ---')
  console.log(`  stopReason: ${result.stopReason}`)
  console.log(`  output: ${text(result.output)}`)

  await run.dispose()
  console.log('\n--- 回收 ---')
  console.log('  子 agent 已 dispose（回收完成）')
}

await main()
