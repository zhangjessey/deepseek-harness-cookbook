// src/ch11/lineage-demo.ts —— 跨会话查询：谱系追踪
// 跑法：npm run start:ch11:lineage
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import LlmRuntime, { createMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { type Session, SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import TokenMeter from '@deepseek-ai/dsh-token-meter'

const MODEL = 'mock'

/** 假模型：压缩时只负责吐一段固定摘要，不发起真实调用。 */
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
      block: { type: 'text', text: '前面几轮在讨论：日志怎么落盘、会话怎么续接。' },
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** 造一轮对话：用户问一句 + 模型回一句。 */
function seedTurn(session: Session, turn: number, question: string, answer: string): void {
  session.append('turn/start', { turn })
  session.append(
    'user/message',
    createUserMessage({
      content: [{ type: 'text', text: question }],
      source: { kind: 'user' },
    }),
    { surfaceOp: 'append' },
  )
  // 压缩要算 token，而 token 计量要求 assistant/message 前面有 step/start
  session.append('step/start', { turn, step: 1 })
  if (turn === 1) {
    session.append('request/header', {
      header: { config: { provider: MODEL, model: MODEL } },
      reason: 'initial',
    })
  }
  session.append(
    'assistant/message',
    {
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: answer }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    },
    { surfaceOp: 'append' },
  )
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

async function main(): Promise<void> {
  const ctx = new Context()
  void new SessionStore(ctx)
  void new SqliteSessionQueryEngine(ctx, { path: ':memory:' })

  // 造一条谱系：root → child → grandchild
  const root = ctx.sessions.create(SessionId('sess-root'), { meta: { cwd: process.cwd() } })
  seedTurn(root, 1, '根会话的问题', '根会话的回答，先在这里定下方向。')
  const child = ctx.sessions.fork(root, undefined, SessionId('sess-child'))
  seedTurn(child, 1, '子会话的问题', '子会话的回答，换个方向继续。')
  const grandchild = ctx.sessions.fork(child, undefined, SessionId('sess-grandchild'))
  seedTurn(grandchild, 1, '孙会话的问题', '孙会话的回答，再往下走一层。')

  // 追踪孙会话的谱系
  console.log('--- 追踪 sess-grandchild 的谱系 ---')
  const trace = await ctx.sessionQuery.traceSession(SessionId('sess-grandchild'))
  console.log(`  目标：${trace.target.header.id}`)
  console.log(`  完整：${trace.complete}`)
  console.log('  祖先（由近及远）：')
  for (const ancestor of trace.ancestors) {
    console.log(`    · ${ancestor.header.id}`)
  }

  // 反方向：追踪根会话的后代
  console.log('--- 追踪 sess-root 的后代 ---')
  const rootTrace = await ctx.sessionQuery.traceSession(SessionId('sess-root'))
  console.log(`  目标：${rootTrace.target.header.id}`)
  console.log('  后代树：')
  for (const node of rootTrace.descendants) {
    console.log(`    · ${node.session.header.id}`)
    for (const sub of node.descendants) {
      console.log(`      · ${sub.session.header.id}`)
    }
  }

  // ---- 事件级追踪：追一条被压缩掉的消息 ----
  // traceEvent 的价值是"把被替换掉的事件追回来"，所以先压缩一次，制造替换关系
  const llm = new LlmRuntime(ctx)
  void new TokenMeter(ctx)
  llm.registerAdapter([MODEL], new MockAdapter())

  // 给孙会话多塞几轮长对话，让历史长到能触发压缩
  for (let turn = 2; turn <= 5; turn += 1) {
    seedTurn(
      grandchild,
      turn,
      `第 ${turn} 轮的问题，内容比较长。`.repeat(12),
      `第 ${turn} 轮的回答，同样不短。`.repeat(12),
    )
  }
  const agent = {
    session: grandchild,
    options: { provider: MODEL, model: MODEL },
    runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => task(new AbortController().signal),
  } as unknown as Agent
  const compact = new BasicCompactionEngine(ctx, { auto: false })
  const compressed = await compact.compactNow(agent, new AbortController().signal)
  if (compressed === null) {
    console.log('--- 压缩没触发，事件级追踪跳过 ---')
    return
  }

  console.log('--- 压缩：制造替换关系 ---')
  console.log(`  被遮蔽的 seq：${compressed.shadowedSeqs.join(', ')}`)

  // 追其中最早被遮蔽的那条
  const victim = compressed.shadowedSeqs[0]!
  const eventTrace = await ctx.sessionQuery.traceEvent({
    sessionId: SessionId('sess-grandchild'),
    seq: victim,
  })
  console.log(`--- traceEvent：追 seq ${victim}（被压掉的那条）---`)
  console.log(`  目标：${eventTrace.target.type}（surface=${eventTrace.target.surface}）`)
  console.log(`  replacedBy（直接替换者）：${eventTrace.replacedBy ?? '（无）'}`)
  console.log(`  replacementChain（到最终替换）：${eventTrace.replacementChain.join(' → ') || '（空）'}`)
  console.log(`  replacedEventSeqs（它自己移除的）：${eventTrace.replacedEventSeqs.join(', ') || '（空）'}`)
  console.log(`  sourceEventSeqs（它引用的来源）：${eventTrace.sourceEventSeqs.join(', ') || '（空）'}`)
  console.log(`  derivedEventSeqs（引用它的）：${eventTrace.derivedEventSeqs.join(', ') || '（空）'}`)

  // readEvent：读它前后的原始日志（trace 给关系，read 给内容）
  const logWindow = await ctx.sessionQuery.readEvent({
    sessionId: SessionId('sess-grandchild'),
    seq: victim,
    before: 1,
    after: 1,
  })
  console.log(`--- readEvent：读 seq ${victim} 前后的窗口 ---`)
  console.log(`  窗口：seq ${logWindow.startSeq} → ${logWindow.endSeq}（共 ${logWindow.events.length} 条）`)
  for (const event of logWindow.events) {
    console.log(`    seq ${event.seq}  ${event.type}`)
  }
}

main()
