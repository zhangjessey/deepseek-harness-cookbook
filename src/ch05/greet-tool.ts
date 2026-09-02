// src/ch05/greet-tool.ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'greet-tool'
export const inject = ['tools'] // 等工具注册表就绪；少了它 Cordis 会抛错

export function apply(ctx: Context) {
  ctx.tools.register(
    defineTool({
      // ── 模型唯一看得见的三样 ──
      name: 'greet',
      description: 'Greet someone by name.',
      parameters: {
        name: { type: 'string', required: true, description: 'The name to greet' },
      },

      // ── 模型看不见，给框架用的 ──
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value as string }],
      },

      async execute(args) {
        return `Hello, ${args.name}!`
      },
    }),
  )
}
