// src/ch09/fork-demo.ts —— 会话续接（上）：把一份历史分叉出去
// 跑法：npm run start:ch09:fork
import { Context } from '@deepseek-ai/cordis'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const ask = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

async function main(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)

  const parent = ctx.sessions.create(SessionId('parent'), { meta: { cwd: process.cwd() } })
  parent.append('turn/start', { turn: 1 })
  parent.append('step/start', { turn: 1, step: 1 })
  parent.append('user/message', ask('第一轮：投影是什么'), { surfaceOp: 'append' })
  parent.append('step/end', { turn: 1, step: 1 })
  parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  parent.append('turn/start', { turn: 2 })
  parent.append('user/message', ask('第二轮：日志怎么落盘'), { surfaceOp: 'append' })
  parent.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

  console.log('--- ① 父会话：两轮对话，8 条事件 ---')
  for (const event of parent.events) console.log(`  seq ${event.seq}  ${event.type}`)

  // fork 出来的是一个活跃会话，可以直接往里 append；种子事件是深克隆的，父子此后互不相干
  // 第二个参数是 boundary：传 undefined 表示"到最后一个事件为止"
  const full = ctx.sessions.fork(parent, undefined, SessionId('child-full'))
  const last = full.events[full.events.length - 1]
  console.log('\n--- ② fork 一份出去（不指定 boundary）---')
  console.log(
    `  子会话 ${full.events.length} 条，seedLength = ${full.header.seedLength}，parent = ${full.header.parentSession}`,
  )
  console.log(`  最后一条：seq ${last.seq}  ${last.type}   ← 种子边界`)
  console.log(`  消息历史 ${full.deriveMessages().length} 条（全是继承来的）`)

  const part = ctx.sessions.fork(parent, 4, SessionId('child-part'))
  console.log('\n--- ③ 只要第一轮（boundary = 4）---')
  console.log(`  子会话 ${part.events.length} 条，seedLength = ${part.header.seedLength}`)
  console.log(`  消息历史 ${part.deriveMessages().length} 条`)

  console.log('\n--- ④ boundary 落在开放轮次内（seq 2 正卡在第一轮中间）---')
  try {
    ctx.sessions.fork(parent, 2, SessionId('child-bad'))
    console.log('  竟然成功了（不该发生）')
  } catch (error) {
    console.log(`  被拒：${(error as Error).message}`)
  }
}

main()
