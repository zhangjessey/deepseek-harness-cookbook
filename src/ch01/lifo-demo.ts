// 第 01 章：时之可逆 —— Context、插件与可撤销的 Effect
//
// 本章从「时间」维度理解 Cordis：一个组件（插件）在运行时的每一次环境
// 修改，都必须能被完整、安全地「逆转」。这正是论文《A Programming
// Paradigm for Spatiotemporal Composability》中 temporal composability
// 的核心 —— revertible effects（可逆的副作用）。
//
// 本文件演示「可撤销 Effect」的 LIFO 逆序回收：一个生成器 effect 注册
// 三个资源的 setup/cleanup，卸载时它们按逆序被回收。
import { Context } from '@deepseek-ai/cordis'

const steps: string[] = []

function cleanupPlugin(ctx: Context) {
  // 生成器形态的 effect：setup 依次执行，yield 出的清理函数在卸载时逆序执行
  ctx.effect(function* () {
    steps.push('setup: 打开文件')
    yield () => steps.push('cleanup: 关闭文件')
    steps.push('setup: 建立连接')
    yield () => steps.push('cleanup: 断开连接')
    steps.push('setup: 启动轮询')
    yield () => steps.push('cleanup: 停止轮询')
  }, 'cleanup.demo')
}

async function main() {
  const root = new Context()
  const fiber = await root.plugin(cleanupPlugin)

  console.log('--- 卸载 cleanupPlugin ---')
  await fiber.dispose()
  console.log('清理顺序：', steps.filter((s) => s.startsWith('cleanup:')).join(' -> '))
}

main()
