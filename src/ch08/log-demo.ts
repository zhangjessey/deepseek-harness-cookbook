// src/ch08/log-demo.ts —— 会话就是一份只追加的日志
// 跑法：npm run start:ch08
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'

const session = Session.create(SessionId('sess-1'))
const callId = CallId('call-1')

// 一次最简的交互：用户提问 → 模型决定调工具 → 工具返回 → 收尾
session.append('turn/start', { turn: 1 })
session.append('step/start', { turn: 1, step: 1 })
session.append(
  'user/message',
  createUserMessage({
    content: [{ type: 'text', text: '现在几点了？' }],
    source: { kind: 'user' },
  }),
  { surfaceOp: 'append' },
)
session.append(
  'assistant/message',
  {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: '我来看一下时间。' }],
      source: { provider: 'demo', model: 'demo-1' },
    }),
  },
  { surfaceOp: 'append' },
)
session.append('tool/call', { turn: 1, step: 1, callId, name: 'clock', arguments: '{}' })
session.append(
  'tool/result',
  {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId,
      content: [{ type: 'text', text: '10:42' }],
      isError: false,
    }),
  },
  { surfaceOp: 'append' },
)
session.append('step/end', { turn: 1, step: 1 })
session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

console.log('--- ① 日志：一条条追加，seq 连号 ---')
for (const event of session.events) {
  console.log(`  seq ${event.seq}  ${event.type}`)
}
console.log(`小结：日志里现在有 ${session.events.length} 条事件，下一条的 seq 将是 ${session.seq}`)
// 列表只打了类型；这里把 seq 2 原样打出来，看清一条事件的完整字段
console.log('\n把 seq 2 这条原样打出来：')
console.log(JSON.stringify(session.events[2], null, 2))

console.log('\n--- ② 塞一个无法无损序列化的值 ---')
try {
  session.append('turn/start', { turn: Number.NaN })
  console.log('  竟然通过了（不该发生）')
} catch (error) {
  console.log(`  被拒：${(error as Error).message}`)
}

console.log('\n--- ③ 试着改一下已经写下的历史 ---')
console.log(`  Object.isFrozen(events[0])      = ${Object.isFrozen(session.events[0])}`)
console.log(`  Object.isFrozen(events[0].data) = ${Object.isFrozen((session.events[0] as { data: object }).data)}`)
try {
  ;(session.events[0] as { data: { turn: number } }).data.turn = 99
  console.log('  改写成功了（不该发生）')
} catch (error) {
  console.log(`  events[0].data.turn = 99  →  ${(error as Error).name}: ${(error as Error).message}`)
}
console.log(`  events[0].data.turn 仍然是 ${(session.events[0] as { data: { turn: number } }).data.turn}`)

console.log('\n--- ④ surface：只有 3 个节点进得了 ---')
console.log(
  `  nodes = ${JSON.stringify(session.surface.nodes)}，replaceGeneration = ${session.surface.replaceGeneration}`,
)

console.log('\n--- ⑤ deriveMessages()：从日志算出的消息历史 ---')
for (const message of session.deriveMessages()) {
  const text = message.content.map((block) => (block.type === 'text' ? block.text : `<${block.type}>`)).join('')
  console.log(`  ${message.role.padEnd(9)} | ${text}`)
}
console.log(`小结：${session.deriveMessages().length} 条消息，来自 ${session.events.length} 条事件`)
