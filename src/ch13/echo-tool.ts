// src/ch13/echo-tool.ts —— 一个最小的工具：把参数原样吐回来
// 第 13 讲只需要一个能被模型"叫到"的工具，用来观察循环怎么分发工具调用。
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'echo-tool'
export const inject = ['tools'] // 等工具注册表就绪

export function apply(ctx: Context) {
  ctx.tools.register(
    defineTool({
      // 模型唯一看得见的三样：名字、描述、参数表
      name: 'echo',
      description: 'Echo the given text back, unchanged.',
      parameters: {
        text: { type: 'string', required: true, description: 'The text to echo' },
      },

      // 模型看不见，给框架用：输出 schema + 怎么渲染成模型能读的内容块
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value as string }],
      },

      async execute(args) {
        return String(args.text)
      },
    }),
  )
}
