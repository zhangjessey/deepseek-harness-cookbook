// 第 02 章：空之协同 —— Service、inject 与响应式依赖
//
// 本章从「空间」维度理解 Cordis：多个组件共存时，它们之间的依赖关系
// 如何被声明、解析，并在依赖变化时被框架自动「响应」。这正是论文
// 《A Programming Paradigm for Spatiotemporal Composability》中
// spatial composability 的核心 —— reactive coeffects（响应式协效应）。
//
// 本文件演示「服务消失 → 插件自动停，服务恢复 → 插件自动起」的完整过程。
import { Context } from '@deepseek-ai/cordis'

// —— 声明 greeter 服务类型：通过「声明合并」把 greeter 挂到 Context 上 ——
declare module '@deepseek-ai/cordis' {
  interface Context {
    greeter: { greet: (who: string) => string }
  }
}

// 一个"服务"：提供 greet 能力。为了看清"换服务"，让每次提供的返回内容不同
function provideGreeter(ctx: Context, tag: string) {
  ctx.provide('greeter', {
    greet: (who: string) => `[${tag}] Hello, ${who}!`,
  })
}

// 一个"依赖者"：声明我需要 greeter，框架保证 greeter 就绪后我才被调用
const consumer = {
  inject: ['greeter'], // 声明依赖：我需要 greeter 服务
  apply(ctx: Context) {
    console.log('[consumer]', ctx.greeter.greet('world'))
  },
}

async function main() {
  const root = new Context()

  // 1. 先提供 greeter，再挂载 consumer —— consumer 直接启动
  const greeterFiber = await root.plugin((ctx) => provideGreeter(ctx, 'v1'))
  console.log('[greeter:v1] 已上线')
  await root.plugin(consumer)

  // 2. 撤销 greeter —— consumer 检测到依赖消失，自动停止
  console.log('--- 撤销 greeter ---')
  await greeterFiber.dispose()
  console.log('[greeter:v1] 已下线')

  // 3. 换一个新的 greeter 上线 —— consumer 自动重启
  console.log('--- 新 greeter 上线 ---')
  await root.plugin((ctx) => provideGreeter(ctx, 'v2'))
}

main()
