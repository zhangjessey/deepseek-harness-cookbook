// 第 04 章：插件树 —— 声明式配置、isolate 与 HMR
//
// 本章讲解 Cordis 的「插件树」：插件不是平铺的列表，而是一棵可以嵌套、
// 可以隔离、可以热更新的树。
//
// 本文件演示「isolate（服务隔离）」：同一个 llm 服务，在不同作用域里
// 解析到不同的实例，互不干扰。
import { Context } from '@deepseek-ai/cordis'

// —— 声明 llm 服务类型：通过「声明合并」把 llm 挂到 Context 上 ——
declare module '@deepseek-ai/cordis' {
  interface Context {
    llm: { generate: (prompt: string) => string }
  }
}

// 一个"对话"插件：依赖 llm，打印它看到的 llm 是哪个供应商
const chatPlugin = {
  name: 'chat',
  inject: ['llm'],
  apply(ctx: Context) {
    console.log(`[chat] 我看到的 llm 是：${ctx.llm.generate('你好')}`)
  },
}

// 用 ctx.provide 直接提供 llm 服务（避免依赖 llm-service.ts，让本章自包含）
function provideLlm(ctx: Context, vendor: string) {
  ctx.provide('llm', {
    generate: () => `【${vendor}】关于「你好」，这是我的回答（占位实现）`,
  })
}

async function main() {
  const root = new Context()

  console.log('=== 根上下文：提供默认 llm（deepseek） ===')
  await root.plugin((ctx) => provideLlm(ctx, 'deepseek'))

  console.log('')
  console.log('=== 创建两个隔离的作用域，各自提供不同的 llm ===')
  // isolate('llm') 为「llm」这个服务名创建独立作用域。
  // 在隔离作用域里，llm 的解析不再向上穿透到父级，而是用作用域内自己的实例。
  const scopeA = root.isolate('llm')
  const scopeB = root.isolate('llm')

  console.log('')
  console.log('=== 作用域 A：提供自己的 llm（mock），挂载 chat 插件 ===')
  await scopeA.plugin((ctx) => provideLlm(ctx, 'mock'))
  await scopeA.plugin(chatPlugin) // 这个 chat 看到的 llm 是 mock

  console.log('')
  console.log('=== 作用域 B：提供自己的 llm（gpt），挂载 chat 插件 ===')
  await scopeB.plugin((ctx) => provideLlm(ctx, 'gpt'))
  await scopeB.plugin(chatPlugin) // 这个 chat 看到的 llm 是 gpt

  console.log('')
  console.log('=== 根上下文：挂载 chat 插件（看到的是根级的 deepseek） ===')
  await root.plugin(chatPlugin) // 这个 chat 看到的 llm 是 deepseek

  console.log('')
  console.log('=== 收尾 ===')
  await root.fiber.dispose()
  console.log('demo 已退出')
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
