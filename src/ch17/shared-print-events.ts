// src/ch17/shared-print-events.ts —— 把会话日志里的事件翻译成人话（workflow / ralph 两个演示共用）
//
// 会话日志是 append-only 的事件流：一次模型请求、一次工具调用、一次工具返回，各是一条事件。
// 这个文件只挑出「能说明当时发生了什么」的那几类，其余略过，这样演示输出才读得下去。
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** 把一条事件翻成一行人话；不关心的事件返回 undefined（打印时跳过）。 */
export function describe(event: SessionEvent): string | undefined {
  const data = (event.data ?? {}) as Record<string, unknown>
  switch (event.type) {
    case 'step/start':
      return `第 ${String(data.step ?? '?')} 步：等模型回话`
    case 'tool/call':
      // tool/call 的 data 是 { turn, step, callId, name, arguments }
      return `  调工具 ${String(data.name ?? '?')}(${String(data.arguments ?? '')})`
    case 'tool/result': {
      // tool/result 的 data 是 { turn, step, message: ToolResultMessage, ... }
      const message = data.message as { content?: Array<{ content?: Array<{ type: string; text?: string }> }> } | undefined
      const blocks = message?.content?.[0]?.content ?? []
      const text = blocks.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('')
      return `  工具返回：${text}`
    }
    case 'assistant/message': {
      const message = data.message as { content?: Array<{ type: string; text?: string }> } | undefined
      const text = (message?.content ?? []).map((block) => (block.type === 'text' ? (block.text ?? '') : `[${block.type}]`)).join('')
      return text.length > 0 ? `  模型说：${text}` : undefined
    }
    default:
      return undefined
  }
}

/** 按顺序打印一段事件流里"能说明问题"的那些行。 */
export function printEvents(events: readonly SessionEvent[]): void {
  for (const event of events) {
    const text = describe(event)
    if (text !== undefined) console.log(`  ${text}`)
  }
}
