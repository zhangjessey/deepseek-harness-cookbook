// src/ch11/filter-demo.ts —— 跨会话查询：精确过滤
// 跑法：npm run start:ch11:filter
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

/**
 * 打印一组会话记录的 id。
 *
 * 结果本身是"最近创建的在前"，但本 demo 里几个会话在几毫秒内先后创建，
 * 时间戳可能相同，顺序就不固定了；为了让输出可复现，这里按 id 排序展示。
 */
function printSessions(label: string, records: Array<{ header: { id: string } }>): void {
  const ids = records.map((record) => record.header.id).sort()
  console.log(`  ${label}：${records.length} 个 → ${ids.join(', ') || '（无）'}`)
}

async function main(): Promise<void> {
  const ctx = new Context()
  void new SessionStore(ctx)
  void new SqliteSessionQueryEngine(ctx, { path: ':memory:' })

  // 造一条谱系 root → child → grandchild，用来演示 parent 过滤
  const root = ctx.sessions.create(SessionId('sess-root'), { meta: { cwd: process.cwd() } })
  seedTurn(root, 1, '根会话的问题', '根会话的回答。')
  const child = ctx.sessions.fork(root, undefined, SessionId('sess-child'))
  seedTurn(child, 1, '子会话的问题', '子会话的回答。')
  const grandchild = ctx.sessions.fork(child, undefined, SessionId('sess-grandchild'))
  // 答案里故意放一个换行，用来演示 text 过滤按空白切段
  seedTurn(grandchild, 1, '日志怎么落盘？', '顺序是：先写内存的\nevents，再 flush 到磁盘。')

  console.log('--- filterSessions：按 parent 找根会话（parent 为 null）---')
  printSessions('根会话', await ctx.sessionQuery.filterSessions([{ kind: 'parent', values: [null] }]))

  console.log('--- filterSessions：按 parent 找 sess-root 的孩子 ---')
  printSessions(
    'sess-root 的孩子',
    await ctx.sessionQuery.filterSessions([{ kind: 'parent', values: [SessionId('sess-root')] }]),
  )

  console.log('--- 数组内是 AND：根会话 + 还在内存里 ---')
  printSessions(
    '两者都满足',
    await ctx.sessionQuery.filterSessions([
      { kind: 'parent', values: [null] },
      { kind: 'availability', values: ['live'] },
    ]),
  )

  console.log('--- values 内是 OR：sess-root 或 sess-child 的孩子 ---')
  printSessions(
    '命中任一',
    await ctx.sessionQuery.filterSessions([
      { kind: 'parent', values: [SessionId('sess-root'), SessionId('sess-child')] },
    ]),
  )

  // 事件级过滤：surface 归属
  console.log('--- filterEvents：只看 surface 上还活着的（current）---')
  const current = await ctx.sessionQuery.filterEvents(SessionId('sess-grandchild'), [
    { kind: 'surface', values: ['current'] },
  ])
  console.log(`  命中 ${current.length} 条 → ${current.map((doc) => `seq ${doc.seq} ${doc.type}`).join(', ')}`)

  console.log('--- filterEvents：结构事件（turn/*）不在语义文档里 ---')
  const turns = await ctx.sessionQuery.filterEvents(SessionId('sess-grandchild'), [
    { kind: 'type', values: ['turn/start'] },
  ])
  console.log(`  命中 ${turns.length} 条（turn/start 不产生搜索文档，所以是 0）`)

  // 事件级过滤：text 按空白切段
  // text 过滤存在的理由：FTS 搜不到的中文子串，用它兜底
  console.log('--- filterEvents：text 过滤兜底 FTS 搜不到的中文子串 ---')
  const missed = await ctx.sessionQuery.searchSessions({ query: '落盘' })
  console.log(`  FTS 搜「落盘」：命中 ${missed.items.length} 个会话`)
  const found = await ctx.sessionQuery.filterEvents(SessionId('sess-grandchild'), [{ kind: 'text', text: '落盘' }])
  console.log(`  text 过滤搜「落盘」：命中 ${found.length} 条（返回文档数组：没有 snippet，也不分页）`)
  for (const doc of found) {
    console.log(`    · seq ${doc.seq} ${doc.type}：${doc.text}`)
  }

  // 过滤器视角：text 在这里是 filterEvents 的一个子句，讲它的语法细节
  console.log('--- filterEvents：text 匹配时按空白切段 ---')
  const flexible = await ctx.sessionQuery.filterEvents(SessionId('sess-grandchild'), [
    { kind: 'text', text: '内存的 events' },
  ])
  for (const doc of flexible) {
    console.log(`  · seq ${doc.seq} ${doc.type}：${doc.text.replace(/\n/gu, '⏎')}`)
  }
  console.log('  搜索词按空白切成两段、段间用 \\s+ 连，所以原文里两段之间隔着换行也能命中；')
  console.log('  而 *、?、( 这些正则特殊字符会被转义，在你手里永远是字面量。')
}

main()
