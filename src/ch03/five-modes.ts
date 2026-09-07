// 第 03 章：事件系统 —— 五种分发模式及其适用场景
//
// 本章讲解 Cordis 的事件系统：插件之间除了「依赖」（A 需要 B 的能力），
// 还常常需要「通信」（A 要通知 B 发生了某件事）。Cordis 提供了五种
// 分发模式：emit、parallel、serial、bail、waterfall，各有适用场景。
//
// 具体业务逻辑先用 console.log 占位，后续章节逐步替换。
import { Context } from '@deepseek-ai/cordis'

// —— 声明事件名及其监听器签名（声明合并） ——
declare module '@deepseek-ai/cordis' {
  interface Events {
    // emit 场景：广播一条「用户消息」，不关心结果
    'chat/message'(text: string): void
    // parallel 场景：分发一个「耗时任务」，多个处理器并发执行
    'task/run'(name: string): void
    // serial / bail 场景：依次询问「谁能处理这个意图」，第一个能处理的胜出
    'chat/intent'(text: string): string | void
    // waterfall 场景：对「回复文本」做层层加工（中间件），可短路
    'chat/reply'(text: string, next: () => string): string
  }
}

// —— 入口：逐一演示五种分发模式 ——
async function main() {
  const root = new Context()

  // ========== 1. emit：同步广播，不等待、不收集返回值 ==========
  console.log('=== emit：广播一条消息，所有监听器都收到 ===')
  root.on('chat/message', (text) => {
    console.log('  [日志插件] 记录消息：', text)
  })
  root.on('chat/message', (text) => {
    console.log('  [统计插件] 消息字数：', text.length)
  })
  root.emit('chat/message', '你好，Cordis')
  // emit 同步执行所有监听器，返回值被忽略；适合「通知所有人，但不需要反馈」

  console.log('')
  // ========== 2. parallel：并发运行，一起等待 ==========
  console.log('=== parallel：多个耗时任务并发执行 ===')
  root.on('task/run', async (name) => {
    await new Promise((r) => setTimeout(r, 100)) // 模拟耗时任务 A
    console.log('  [任务 A] 完成：', name)
  })
  root.on('task/run', async (name) => {
    await new Promise((r) => setTimeout(r, 100)) // 模拟耗时任务 B
    console.log('  [任务 B] 完成：', name)
  })
  await root.parallel('task/run', '并行任务')
  console.log('  （两个任务并发完成，总耗时约 100ms 而非 200ms）')

  console.log('')
  // ========== 3. serial：按顺序执行，第一个有返回值者胜出 ==========
  console.log('=== serial：依次询问「谁能处理」，第一个能处理的胜出 ===')
  root.on('chat/intent', (text) => {
    if (text.includes('天气')) {
      return 'weather' // 我负责天气，返回非空值 = 我接单了
    }
    // 返回 undefined = 我不处理，继续问下一个
  })
  root.on('chat/intent', (text) => {
    if (text.includes('时间')) {
      return 'time' // 我负责时间，返回非空值 = 我接单了
    }
  })
  const intent = await root.serial('chat/intent', '帮我查一下天气')
  console.log('  识别到的意图：', intent) // 'weather'

  console.log('')
  // ========== 4. bail：serial 的同步版本 ==========
  console.log('=== bail：同步地找第一个能回答的监听器 ===')
  const syncIntent = root.bail('chat/intent', '现在的时间是几点')
  console.log('  同步识别到的意图：', syncIntent) // 'time'

  console.log('')
  // ========== 5. waterfall：层层加工（中间件），可短路 ==========
  console.log('=== waterfall：对回复文本层层加工 ===')
  // 监听器一（外层）：给下游返回的回复加上署名（加工下游返回值）
  root.on('chat/reply', (text, next) => {
    const downstream = next() // 先拿到下游的结果
    return `【bot】${downstream}` // 再加工：加上署名
  })
  // 监听器二（内层）：遇到敏感词就短路（不调用 next）
  root.on('chat/reply', (text, next) => {
    if (text.includes('脏话')) {
      return '（内容已拦截）' // 直接返回，不调用 next，短路！
    }
    return next() // 正常情况，继续往下走
  })
  // 最内层的默认行为：真正的回复生成（占位）
  const reply1 = root.waterfall('chat/reply', '你好啊', () => '你好，很高兴见到你')
  console.log('  正常回复：', reply1) // 被外层加上署名
  const reply2 = root.waterfall('chat/reply', '这句包含脏话', () => '不应该出现')
  console.log('  被拦截的回复：', reply2) // 被内层短路拦截

  console.log('')
  console.log('=== 收尾 ===')
  await root.fiber.dispose()
  console.log('demo 已退出')
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
