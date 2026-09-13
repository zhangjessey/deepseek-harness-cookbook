// src/ch09/crash-resume-demo.ts —— 会话续接（下）：崩了怎么接上
// 跑法：npm run start:ch09:crash
import { Context } from '@deepseek-ai/cordis'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { CallId, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-ch09-'))
const plainId = SessionId('sess-plain')
const toolId = SessionId('sess-tool')
const callId = CallId('call-1')

const ask = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

// 每个"进程"都新建一个 Context：它不认识别的 Context 里的会话，
// 磁盘上的日志对它来说就是冷的 —— 效果等同于进程重启后重新打开
async function newProcess(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionPersistenceJsonl, { root: storageRoot })
  return ctx
}

// 场景一：话说到一半，进程没了
async function crashWithoutTool(): Promise<void> {
  const ctx = await newProcess()
  const session = ctx.sessions.create(plainId, { meta: { cwd: process.cwd() } })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', ask('问到一半，进程崩了'), { surfaceOp: 'append' })
  // serial 会等到 flush 真正写完；emit 不等
  await ctx.serial('session/flush', session)

  console.log(`--- ① 场景一：问到一半崩了（磁盘 ${session.events.length} 条，turn 没闭合）---`)
  // 故意不收尾：既没有 turn/end，也不再碰这个 ctx —— 后面的读操作会换一个全新的 Context
}

// 场景二：模型要求了一次工具调用，工具还没返回，进程没了
async function crashWithTool(): Promise<void> {
  const ctx = await newProcess()
  const session = ctx.sessions.create(toolId, { meta: { cwd: process.cwd() } })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', ask('查一下天气'), { surfaceOp: 'append' })
  session.append(
    'assistant/message',
    {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'tool-call', id: callId, name: 'weather', arguments: '{}' }],
        source: { provider: 'demo', model: 'demo-1' },
      }),
    },
    { surfaceOp: 'append' },
  )
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'weather', arguments: '{}' })
  await ctx.serial('session/flush', session)

  console.log(`\n--- ③ 场景二：工具调用已发出，崩了（磁盘 ${session.events.length} 条）---`)
}

function printLog(events: readonly SessionEvent[]): void {
  for (const event of events) {
    let detail = ''
    if (event.type === 'tool/result') {
      const data = event.data as {
        error?: { code?: string }
        message?: { content?: { content?: { text?: string }[] }[] }
      }
      const text = data.message?.content?.[0]?.content?.[0]?.text ?? ''
      detail = `  error.code = ${data.error?.code}\n      「${text.slice(0, 46)}…」`
    } else if (event.type === 'turn/end') {
      detail = `  ${JSON.stringify(event.data)}`
    }
    console.log(`  seq ${event.seq}  ${event.type}${detail}`)
  }
}

// 全新进程读场景一
async function loadPlain(): Promise<void> {
  const ctx = await newProcess()
  const plain = await ctx.sessionPersistence.load(plainId)
  console.log(`\n--- ② 新进程 load 场景一：${plain.events.length} 条 ---`)
  printLog(plain.events)
}

// 全新进程读场景二，并接着往下干
async function loadToolAndResume(): Promise<void> {
  const ctx = await newProcess()
  const tool = await ctx.sessionPersistence.load(toolId)
  console.log(`\n--- ④ 新进程 load 场景二：${tool.events.length} 条 ---`)
  printLog(tool.events)

  const resumed = ctx.sessions.create(SessionId('sess-resumed'), {
    seed: tool.events,
    meta: { parentSession: toolId, seedLength: tool.events.length, cwd: process.cwd() },
  })
  resumed.append('turn/start', { turn: 2 })
  resumed.append('user/message', ask('那算了，换个问题'), { surfaceOp: 'append' })
  resumed.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

  console.log(`\n--- ⑤ 续接：seedLength = ${resumed.header.seedLength}，事件 ${resumed.events.length} 条 ---`)
  console.log(`  消息历史 ${resumed.deriveMessages().length} 条：`)
  for (const message of resumed.deriveMessages()) {
    const text = message.content.map((block) => (block.type === 'text' ? block.text : `<${block.type}>`)).join('')
    console.log(`    ${message.role} | ${text}`)
  }
}

async function main(): Promise<void> {
  await crashWithoutTool() //   ①
  await loadPlain() //          ②
  await crashWithTool() //      ③
  await loadToolAndResume() //  ④⑤
}

main()
