// src/ch08/projection-demo.ts —— 投影：把日志折叠成你要的视图
// 跑法：npm run start:ch08:projection
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

interface Stats {
  userTurns: number
  toolCalls: number
}

// 领域通过声明合并，把自己这一格加到全链共享的投影类型表上
// 注意要指到 /types：包入口只是把 SessionProjectionMap 再导出，再导出的接口合并不上去
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    'demo/stats': Stats
  }
}

// 两个计数只为打印后面那两个数字，与投影机制本身无关
let applyCount = 0
let changeCount = 0

// 一个投影单元：三个纯同步函数 + 声明，领域只负责算，不碰订阅
const statsUnit = {
  key: 'demo/stats' as const,
  schema: z.object({ userTurns: z.number(), toolCalls: z.number() }),
  init: (): Stats => ({ userTurns: 0, toolCalls: 0 }),
  apply: (state: Stats, event: SessionEvent): Stats => {
    applyCount++
    if (event.type === 'user/message') return { ...state, userTurns: state.userTurns + 1 }
    if (event.type === 'tool/call') return { ...state, toolCalls: state.toolCalls + 1 }
    return state // 与己无关：原样返回同一个引用
  },
  view: (state: Stats): Stats => state,
  stateVersion: 1,
}

const ask = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

async function main(): Promise<void> {
  const root = new Context()
  await root.plugin(SessionStore)
  await root.plugin(SessionProjectionRegistry)

  const offRegister = root.sessionProjections.register(statsUnit)
  const offChanged = root.sessionProjections.onChanged(() => {
    changeCount++
  })

  // 注意：这里用 store 创建，append 才会发布 session/event，投影才推得动
  const session = root.sessions.create(SessionId('sess-1'))

  console.log('--- ① 一条事件都还没有时的投影 ---')
  console.log(' ', JSON.stringify(root.sessionProjections.snapshot(session)))

  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', ask('问题一'), { surfaceOp: 'append' })
  session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: CallId('call-1'),
    name: 'clock',
    arguments: '{}',
  })
  session.append('user/message', ask('问题二'), { surfaceOp: 'append' })

  console.log('\n--- ② 追加 5 条事件之后 ---')
  console.log(' ', JSON.stringify(root.sessionProjections.snapshot(session)))
  console.log(`  apply 被调用了 ${applyCount} 次（事件数 = ${session.events.length}）`)
  console.log(`  但变更通知只发了 ${changeCount} 次`)

  offRegister() // 注册本身是一个 Cordis effect，注销后这一格随之消失
  console.log('\n--- ③ 卸载投影单元之后 ---')
  console.log(' ', JSON.stringify(root.sessionProjections.snapshot(session)))

  offChanged()
}

main()
