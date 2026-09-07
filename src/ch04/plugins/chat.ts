// src/ch04/plugins/chat.ts —— shell 服务的消费者
// shell 的类型由 shell.ts 用声明合并挂到 Context 上，这里直接拿来用
import { Context, Service } from '@deepseek-ai/cordis'

export const name = 'chat'
export const inject = ['shell']

export function apply(ctx: Context) {
  // inject: ['shell'] 保证 apply 运行时 shell 已就绪（第二章的依赖机制）
  const reply = ctx.shell.chat('你好')
  // 顺手看一眼：我当前作用域里解析到的 shell 合并配置（intercept 效果在这里可见）
  const resolved = (ctx.shell as any)[Service.resolveConfig]?.()
  const tail = resolved && Object.keys(resolved).length ? `（我看到 shell 配置：${JSON.stringify(resolved)}）` : ''
  console.log(`[chat] 收到：${reply}${tail}`)
}
