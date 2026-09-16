// src/ch11/corpus-demo.ts —— 跨会话查询：逻辑语料库的四个读入口
// 跑法：npm run start:ch11:corpus
import { Context } from '@deepseek-ai/cordis'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { type Session, SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'

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
  session.append(
    'assistant/message',
    {
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: answer }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    },
    { surfaceOp: 'append' },
  )
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

async function main(): Promise<void> {
  const ctx = new Context()
  void new SessionStore(ctx)
  void new SqliteSessionQueryEngine(ctx, { path: ':memory:' })

  // 造两个会话：一个聊两轮，一个聊一轮
  const a = ctx.sessions.create(SessionId('sess-a'), { meta: { cwd: process.cwd() } })
  seedTurn(a, 1, '日志怎么落盘？', '先写进内存的 events，再 flush 到磁盘。')
  seedTurn(a, 2, '那重启之后呢？', '从磁盘读回来，接着上次的 events 继续追加。')
  const b = ctx.sessions.create(SessionId('sess-b'), { meta: { cwd: process.cwd() } })
  seedTurn(b, 1, '上下文装不下怎么办？', '用 compact 把旧历史压成摘要。')

  // 入口一：listSessions —— 只给 header，一条事件都不读
  console.log('--- listSessions：列 header 清单 ---')
  const records = await ctx.sessionQuery.listSessions()
  console.log(`  共 ${records.length} 个会话（本例没装持久化，都在内存里）`)
  // 结果本身是"最近创建的在前"，几个会话几毫秒内先后创建时顺序不固定，按 id 展示以便复现
  const sorted = [...records].sort((x, y) => x.header.id.localeCompare(y.header.id))
  for (const record of sorted) {
    console.log(`  · ${record.header.id}  live=${record.live}  persisted=${record.persisted}`)
  }

  // 入口二：readSession —— 完整原始日志，重放验证通过才给
  console.log('--- readSession：读完整日志 ---')
  const snap = await ctx.sessionQuery.readSession(SessionId('sess-a'))
  console.log(`  ${snap.session.id}：共 ${snap.events.length} 条事件`)
  console.log(`  类型序列：${snap.events.map((event) => event.type).join(' → ')}`)

  // 入口三：listEvents —— 轻量记录，每条带 surface 归属
  console.log('--- listEvents：列带归属的事件 ---')
  const events = await ctx.sessionQuery.listEvents(SessionId('sess-a'))
  for (const event of events) {
    console.log(`  seq ${event.seq}  ${event.type}  surface=${event.surface}`)
  }

  // 入口四：readSurface —— 从全部事件现场折叠出的当前快照
  console.log('--- readSurface：当前 surface 快照 ---')
  const surface = await ctx.sessionQuery.readSurface(SessionId('sess-a'))
  console.log(`  截到 seq：${surface.capturedThroughSeq}`)
  console.log(`  surface 上还剩 ${surface.events.length} 条（只剩还在模型眼前的，结构事件不在内）`)
}

main()
