// src/ch10/prune-demo.ts —— 上下文压缩：把超长的工具结果裁短
// 跑法：npm run start:ch10:prune
import { Context } from '@deepseek-ai/cordis'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { CallId, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'

const THRESHOLD = 200
const HEAD = 60
const TAIL = 30

async function main(): Promise<void> {
  const ctx = new Context()
  void new SessionStore(ctx)
  void new TokenMeter(ctx)
  await ctx.plugin(ToolResultPruner, { thresholdChars: THRESHOLD, headChars: HEAD, tailChars: TAIL })

  const session = ctx.sessions.create(SessionId('sess-prune'), { meta: { cwd: process.cwd() } })
  const callId = CallId('call-1')

  // 一轮对话：用户问 → 工具调用 → 工具返回超长文本
  session.append('turn/start', { turn: 1 })
  session.append(
    'user/message',
    createUserMessage({
      content: [{ type: 'text', text: '把这个文件读给我看看' }],
      source: { kind: 'user' },
    }),
    { surfaceOp: 'append' },
  )
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'read', arguments: '{}' })
  const longText = '这是一段超长的工具输出，'.repeat(20) // 超过 threshold=200 个字符
  session.append(
    'tool/result',
    {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: longText }], isError: false }),
    },
    { surfaceOp: 'append' },
  )

  console.log('--- 裁剪前 ---')
  console.log(`  tool/result 文本长度：${longText.length} 字`)
  console.log(`  开头：${longText.slice(0, 30)}…`)

  const result = ctx.toolResultPruner.pruneSession(session)

  console.log('--- 裁剪后 ---')
  console.log(`  裁掉几条：${result.pruned.length}`)
  console.log(`  总共裁掉：${result.charsRemoved} 字`)
  for (const entry of result.pruned) {
    console.log(
      `  原 seq ${entry.originalSeq}（${entry.charsBefore} 字）→ 新 seq ${entry.replacementSeq}（${entry.charsAfter} 字）`,
    )
  }

  const after = session.deriveMessages()
  const afterMessage = after.find((m) => m.content.some((b) => b.type === 'tool-result'))!
  const collect = (blocks: Array<{ type: string; text?: string; content?: unknown }>): string =>
    blocks
      .map((b) => {
        if (b.type === 'text') return b.text ?? ''
        if (b.type === 'tool-result') return collect(b.content as Array<{ type: string; text?: string }>)
        return `[${b.type}]`
      })
      .join('')
  const text = collect(afterMessage.content)
  console.log(
    `  裁后的 tool/result 全文：\n${text
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n')}`,
  )
}

main()
