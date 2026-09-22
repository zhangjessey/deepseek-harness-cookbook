// src/ch13/agent-loop-demo.ts —— 一个轮次在六个包之间怎么跑完
// 跑法：npm run start:ch13
//
// 这个文件把第 13 讲那条循环链跑一遍，并把每一步留在日志里的事实打出来：
//   llm → sessions → system-prompt → tools → agents → agent-loop
// 第 1 轮故意让模型先请求一次工具调用，这样能同时看到「模型流」「工具分发」两个等待点。
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as echoTool from './echo-tool.ts'

const MODEL = 'mock'

/** 假模型：第 1 次请求 `echo` 工具，之后直接给文字答案。 */
class ScriptedAdapter extends LlmAdapter {
  private calls = 0

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 60_000 } })
  }

  override async *stream(): AsyncIterable<StreamChunk> {
    this.calls += 1
    if (this.calls === 1) {
      const id = CallId('call-echo-1')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'echo', argumentsDelta: '{"text":"你好"}' }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id, name: 'echo', arguments: '{"text":"你好"}' },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = this.calls === 2 ? '回显出来了：「你好」' : '没有别的新东西，还是「你好」'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function textOf(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content.map((block) => (block.type === 'text' ? (block.text ?? '') : `[${block.type}]`)).join('')
}

async function main(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  const loopFiber = await ctx.plugin(AgentLoop, { agents: [] })
  // @ts-expect-error 第 04 讲为演示 isolate 给 ctx.llm 声明过一个占位类型，这里用的是 dsh-llm 的真实服务
  ctx.llm.registerAdapter([MODEL], new ScriptedAdapter())
  await ctx.plugin(echoTool)

  console.log('--- 装配：一轮要流的几个包 ---')
  console.log('  llm → sessions → system-prompt → tools → agents → agent-loop')
  console.log(`  循环声明它依赖哪些服务（AgentLoop.inject）：${AgentLoop.inject.join(', ')}`)
  console.log(`  一次最多并行几个工具调用：${ctx.agentLoop.config.maxParallelToolCalls}`)

  // 订阅生命周期事件：看 agent 从生到死都发了些什么
  const lifecycle: string[] = []
  ctx.on('agent/created', ({ agent: born }) => lifecycle.push(`created(${born.session.id})`))
  ctx.on('agent/session-start', ({ source }) => lifecycle.push(`session-start(source=${source})`))
  ctx.on('agent/disposed', ({ agent: dead }) => lifecycle.push(`disposed(${dead.session.id})`))

  const agent = ctx.agentLoop.create(SessionId('sess-loop'), { provider: MODEL, model: MODEL }, { cwd: process.cwd() })

  const statuses: string[] = []
  ctx.on('agent/status', ({ status }) => {
    statuses.push(status)
  })

  console.log('\n--- 第 1 轮：模型先要工具，再给答案 ---')
  let mark = agent.session.events.length
  agent.followup(
    createUserMessage({ content: [{ type: 'text', text: '帮我把「你好」回显一遍' }], source: { kind: 'user' } }),
  )
  await agent.whenIdle()
  for (const event of agent.session.events.slice(mark)) {
    console.log(`  seq ${event.seq}  ${event.type}`)
  }
  console.log(`  agent/status 变化：${statuses.join(' → ')}`)

  console.log('\n--- 第 1 轮结束时的 surface（模型下一轮能看到的消息）---')
  const afterFirst = agent.session.deriveMessages()
  for (const message of afterFirst) {
    console.log(`  [${message.role}] ${textOf(message)}`)
  }

  console.log('\n--- 第 2 轮：同一个 agent 再来一次 ---')
  mark = agent.session.events.length
  statuses.length = 0
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '再说一遍' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  for (const event of agent.session.events.slice(mark)) {
    console.log(`  seq ${event.seq}  ${event.type}`)
  }
  console.log(`  agent/status 变化：${statuses.join(' → ')}`)
  console.log(`  surface 消息数：${afterFirst.length} → ${agent.session.deriveMessages().length}`)

  console.log('\n--- 注册表：agent 不止一条，得知道自己在问谁 ---')
  console.log(`  ctx.agents.list()：${ctx.agents.list().length} 个 agent`)
  console.log(`  ctx.agents.roots()：${ctx.agents.roots().length} 个（没有父级的那些）`)
  console.log(`  ctx.agents.get('sess-loop') 就是它本人：${ctx.agents.get(SessionId('sess-loop')) === agent}`)

  console.log('\n--- 两轮之后，日志一共这么多条 ---')
  console.log(`  事件数：${agent.session.events.length}（第 1 轮前 0 条）`)

  console.log('\n--- 收尾：只拆循环这一个 fiber，看 agent 怎么退场 ---')
  const before = ctx.agents.list().length
  await loopFiber.dispose()
  console.log(`  生命周期事件：${lifecycle.join(' → ')}`)
  console.log(`  ctx.agents.list()：${before} → ${ctx.agents.list().length}`)
}

main()
