// src/ch10/compact-demo.ts —— 上下文压缩：把旧历史压成一段摘要
// 跑法：npm run start:ch10:compact
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import LlmRuntime, { createMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'

const MODEL = 'mock'

/** 假模型：负责"生成摘要"。resolveModel 报上下文窗口，stream 吐一段固定摘要。 */
class MockAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 60_000 },
    })
  }

  override async *stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: '前面几轮在讨论：日志怎么落盘、会话怎么续接、崩溃怎么修复。' },
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function textOf(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content.map((block) => (block.type === 'text' ? (block.text ?? '') : `[${block.type}]`)).join('')
}

async function main(): Promise<void> {
  const ctx = new Context()
  const llm = new LlmRuntime(ctx)
  void new SessionStore(ctx)
  void new TokenMeter(ctx)
  llm.registerAdapter([MODEL], new MockAdapter())

  const session = ctx.sessions.create(SessionId('sess-compact'), { meta: { cwd: process.cwd() } })

  // 塞 4 轮对话，让历史越来越长
  const TURNS = 4
  for (let turn = 1; turn <= TURNS; turn += 1) {
    session.append('turn/start', { turn })
    session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: `第 ${turn} 轮的问题，内容比较长。`.repeat(12) }],
        source: { kind: 'user' },
      }),
      { surfaceOp: 'append' },
    )
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', { header: { config: { provider: MODEL, model: MODEL } }, reason: 'initial' })
    }
    session.append(
      'assistant/message',
      {
        turn,
        step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: `第 ${turn} 轮的回答，同样不短。`.repeat(12) }],
          source: { kind: 'model', provider: MODEL, model: MODEL },
        }),
      },
      { surfaceOp: 'append' },
    )
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }

  const before = session.deriveMessages()
  console.log('--- 压缩前 ---')
  console.log(`  surface 消息数：${before.length}（${TURNS} 轮，每轮一问一答）`)
  console.log(`  第 1 条（前 20 字）：${textOf(before[0]!).slice(0, 20)}…`)

  const beforeEventCount = session.events.length

  const agent = {
    session,
    options: { provider: MODEL, model: MODEL },
    runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => task(new AbortController().signal),
  } as unknown as Agent
  const compact = new BasicCompactionEngine(ctx, { auto: false })
  const result = await compact.compactNow(agent, new AbortController().signal)

  if (result === null) {
    console.log('  compactNow 返回 null：没有安全的可压缩范围')
    return
  }

  console.log('--- 压缩后 ---')
  console.log(`  被遮蔽的事件 seq：${result.shadowedSeqs.join(', ')}`)
  console.log(`  估算遮蔽 token 数：${result.shadowedTokenCount}`)

  const after = session.deriveMessages()
  console.log(`  surface 消息数：${before.length} → ${after.length}`)
  console.log('  第 1 条（替换进去的 checkpoint 节点）全文：')
  for (const line of textOf(after[0]!).split('\n')) {
    console.log(`    ${line}`)
  }
  console.log(`  第 2 条（保留的最近尾部）：${textOf(after[1]!).slice(0, 20)}…`)

  console.log('--- 压缩新落的几条事件 ---')
  for (const event of session.events.slice(beforeEventCount)) {
    console.log(`  seq ${event.seq}  ${event.type}`)
  }
}

main()
