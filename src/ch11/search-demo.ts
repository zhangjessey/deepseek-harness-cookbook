// src/ch11/search-demo.ts —— 跨会话查询：全文搜索
// 跑法：npm run start:ch11:search
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

  // 造三个会话，各自聊一个主题（中英混合，英文是给 FTS 的 token，中文是给 text 过滤的子串）
  const a = ctx.sessions.create(SessionId('sess-a'), { meta: { cwd: process.cwd() } })
  seedTurn(a, 1, '日志怎么落盘？', '先写进内存的 events，再 flush 到磁盘。')
  const b = ctx.sessions.create(SessionId('sess-b'), { meta: { cwd: process.cwd() } })
  seedTurn(b, 1, '进程崩了怎么办？', '靠崩溃修复，把 crash 留下的半截 turn 配平。')
  const c = ctx.sessions.create(SessionId('sess-c'), { meta: { cwd: process.cwd() } })
  seedTurn(c, 1, '上下文装不下怎么办？', '用 compact 把旧历史压成摘要。')

  // 跨会话全文搜索：FTS 按 token 召回，英文 token 好搜
  console.log('--- 跨会话全文搜索：搜「crash」 ---')
  const page = await ctx.sessionQuery.searchSessions({ query: 'crash' })
  console.log(`  命中 ${page.items.length} 个会话`)
  for (const hit of page.items) {
    console.log(`  · ${hit.header.id}：${hit.bestMatch.snippet}`)
  }

  // 会话内全文搜索：只在一个会话里搜，返回的是"事件命中项"
  console.log('--- 会话内全文搜索：在 sess-a 里搜「flush」 ---')
  const hits = await ctx.sessionQuery.searchEvents({
    sessionId: SessionId('sess-a'),
    query: 'flush',
  })
  console.log(`  命中 ${hits.items.length} 条`)
  for (const hit of hits.items) {
    console.log(`  · seq ${hit.seq} ${hit.type}：${hit.snippet}`)
  }
  console.log('  每条命中 = 一条事件 + 它自己的 snippet；跨会话搜索的 bestMatch 就是从这里挑的最强一条。')

  // 中文子串 FTS 搜不到（整段中文是一个 token）——这就是 FTS 的能力边界
  console.log('--- 跨会话全文搜索：搜「落盘」（中文子串）---')
  const cn = await ctx.sessionQuery.searchSessions({ query: '落盘' })
  console.log(`  命中 ${cn.items.length} 个会话（搜子串要用过滤器）`)
}

main()
