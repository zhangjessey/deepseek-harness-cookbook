// src/ch06/pipeline-demo.ts —— 一次工具调用要过的几道关
// 跑法：npm run start:ch06
//
// 这个文件把第 06 章那张「流水线 8 站」的图跑一遍。
// 每个演示只碰其中一站（或两站的组合），顺序顺着流水线方向，与正文一致：
//
//   基线：一个监听器都不挂，证明「流水线不因你挂不挂而改变」
//   pre-execute 决定 ask（① 站）：没人应答 → 失败关闭
//   pre-execute 决定 deny（① 站）：策略层主动拒绝
//   守卫（② 站）：拒绝问候 "World"
//   再挂一个「想放行」的守卫（② 站）：验证单调性
//   tools/execute 环绕计时（③ 站）
//   post-execute accept { content }（⑥ 站）：改呈现、值不动
//   post-execute accept { value }（⑥ 站）：呈现跟着重算
//   post-execute block（⑥ 站）：把成功改判为失败
//
// 注意：每段用完都会立刻注销自己挂的监听器/守卫（那一串 offXxx()），
// 否则上一段的钩子会继续影响下一段，输出就对不上了。

import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as greetTool from '../ch05/greet-tool.ts'

// 每次调用都要一个全新的 callId，否则注册表会当成同一次调用
let seq = 0
function call(root: Context) {
  return root.tools.execute({
    callId: CallId(`call-${++seq}`),
    name: 'greet',
    arguments: { name: 'World' },
    // 生产环境由 agent loop 传入真实的取消信号；这里只是演示，用一个永不中止的信号
    signal: new AbortController().signal,
  })
}

async function main(): Promise<void> {
  try {
    const root = new Context()
    await root.plugin(SystemPrompt)
    await root.plugin(ToolRuntime)
    await root.plugin(greetTool) // 沿用第 05 章那个 greet 工具

    // ── 基线：一个监听器都不挂时，调用长什么样 ──
    // 流水线照样在，只是没人拦，所以一路绿灯走完全程。
    console.log('--- 基线：什么关卡都没有 ---')
    console.log(await call(root))

    // ── pre-execute 决定 ask（第 ① 站）──
    // ask 把决定权交给审批服务 ctx.approval。
    // 本进程没有挂审批服务，于是触发「失败关闭（fail closed）」：
    // 没人应答 = 拒绝，而不是没人应答 = 通过。
    console.log('\n--- pre-execute 决定 ask（本进程没有审批服务）---')
    const offAsk = root.on('tools/pre-execute', async () => ({
      kind: 'ask' as const,
      reason: '危险操作，需要人工确认',
    }))
    console.log(await call(root))
    offAsk()

    // ── pre-execute 决定 deny（第 ① 站）──
    // 这一关是「策略层」：它既能 allow 也能 deny，
    // 是流水线上唯一能主动放行的位置。
    console.log('\n--- pre-execute 决定 deny ---')
    const offDeny = root.on('tools/pre-execute', async () => ({
      kind: 'deny' as const,
      reason: '该工具已对当前会话下线',
    }))
    console.log(await call(root))
    offDeny()

    // ── 守卫（第 ② 站）──
    // 守卫的返回值只有两种：
    //   返回字符串  = 拒绝，这个字符串就是拒绝理由
    //   返回 undefined = 我弃权
    // 注意：**没有「允许」这个返回值**——这是刻意的，它带来「单调性」。
    console.log('\n--- 挂一个守卫，拒绝问候 "World" ---')
    const offGuard = root.tools.guard((exec) => {
      const args = exec.arguments as { name?: string }
      return args?.name === 'World' ? '不允许问候 "World"' : undefined
    })
    console.log(await call(root))

    // ── 再挂一个「想放行」的守卫（第 ② 站）：验证单调性 ──
    // 新挂的守卫对所有调用都返回 undefined（= 弃权），
    // 但它并没有「放行」的能力，所以结果照样被上一道拒绝。
    // 这就是单调性：弃权 ≠ 允许；最保守的那道说了算。
    console.log('\n--- 再挂一个"想放行"的守卫（验证单调性）---')
    const offPermissive = root.tools.guard(() => undefined)
    console.log(await call(root))
    offGuard()
    offPermissive()

    // ── tools/execute 环绕：给每次调用计时（第 ③ 站）──
    // 这一站是「环绕分发」：next() 之前是进去之前，之后是出来之后。
    // 超时、重试、埋点这类「绕在外面的关注点」都挂在这里。
    // 注意：环绕包装只能替换 exec.signal，**改不了结果**。
    console.log('\n--- tools/execute 环绕：给每次调用计时 ---')
    const offAround = root.on('tools/execute', async (exec, next) => {
      const started = Date.now()
      const result = await next() // 交棒：让更内层的环绕和工具本体先跑
      console.log(`  [环绕] ${exec.name} 耗时 ${Date.now() - started}ms，isError=${result.isError}`)
      return result
    })
    console.log(await call(root))
    offAround()

    // ── post-execute accept { content }（第 ⑥ 站）──
    // accept 有两种写法且互斥。这一段的写法是 accept { content }：
    // 只换 content（给模型看的那一份），value（给程序用的）原地不动。
    // 所以别指望靠换 content 来「藏住」一个值——它还在 value 里躺着。
    console.log('\n--- post-execute 放行但改写呈现（注意：只改呈现，值没动）---')
    const offReplace = root.on('tools/post-execute', async () => ({
      kind: 'accept' as const,
      content: [{ type: 'text' as const, text: '[已折叠]' }],
    }))
    console.log(await call(root))
    offReplace()

    // ── post-execute accept { value }（第 ⑥ 站）──
    // 与上一段相对的另一半镜像：accept { value } 改的是值，
    // 于是 content 会被 render 重新算一遍（值是源，呈现是它的投影）。
    console.log('\n--- post-execute 改写值（呈现会被 render 重算）---')
    const offValue = root.on('tools/post-execute', async () => ({
      kind: 'accept' as const,
      value: 'REPLACED',
    }))
    console.log(await call(root))
    offValue()

    // ── post-execute block（第 ⑥ 站）──
    // 工具本体其实跑成功了，但策略认为这个结果不该给模型看。
    // block 会丢弃 value，只留下 feedback 作为纠正反馈。
    console.log('\n--- post-execute 把成功结果改判为失败 ---')
    const offBlock = root.on('tools/post-execute', async () => ({
      kind: 'block' as const,
      feedback: [{ type: 'text' as const, text: '结果含受限称呼 "World"，已拦截' }],
    }))
    console.log(await call(root))
    offBlock()
  } catch (err) {
    console.error('Failed to run pipeline-demo:', err)
    process.exit(1)
  }
}

main()
