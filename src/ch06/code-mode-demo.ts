// src/ch06/code-mode-demo.ts —— Code Mode：让模型写程序调工具
// 跑法：npm run start:ch06:code
//
// 这个文件演示第 06 章的 Code Mode，演示顺序与正文对应：
//
//   native 模式：模型看见的工具（两个：add、env_probe）
//   code 模式：模型看见的工具（只剩一个：run_code）
//   随之生成的 SDK（提示词节选）——「工具地图」在哪儿
//   让模型写一段程序，一次 run_code 里调两个工具
//   模型绕过 run_code 直接点名调 env_probe → UNKNOWN_TOOL
//   守卫能否管住程序里的子调用
//
// 核心一句话：**Code Mode 换的是入口，不是流水线**——一站不加、一站不减。

import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import WorkerThreadCodeRuntime from '@deepseek-ai/dsh-code-runtime-worker-thread'

// ── 两个小工具：一个做加法，一个报环境 ──
//
// 这里的写法沿用第 05 章：模型只能看见 name / description / parameters 三样，
// 剩下的 output / execute 都被注册表用白名单挡在外面。
// 等一下会看到：Code Mode 会把「模型看得见的」和「程序用得上的」拆成两条路。
const probeTools = {
  name: 'probe-tools',
  inject: ['tools'] as const, // 等工具注册表就绪，少了它 Cordis 会抛错
  apply(ctx: Context) {
    // ── 工具一：add，入参和返回值都是数字 ──
    ctx.tools.register(
      defineTool({
        name: 'add',
        // description 会被原样搬进 SDK，变成 /** Add two numbers. */
        description: 'Add two numbers.',
        parameters: {
          // 参数描述同样会变成 SDK 里的 /** First addend */，不是摆设
          a: { type: 'number', required: true, description: 'First addend' },
          b: { type: 'number', required: true, description: 'Second addend' },
        },
        output: {
          // schema 声明「程序拿到的值长什么样」，render 产出「模型看到的文本」
          // 两者必须一起声明：少了 schema，程序没法按字段取用；少了 render，模型看不到排版好的文本
          schema: { type: 'number' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(args) {
          return args.a + args.b
        },
      }),
    )

    // ── 工具二：env_probe，返回值是一个对象 ──
    ctx.tools.register(
      defineTool({
        name: 'env_probe',
        description: 'Report the runtime environment.',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            // 显式写出的 object 节点必须表态开不开放，缺了注册时就抛 JsonSchemaError
            additionalProperties: false,
            // 注意：只写了 properties、没写 required
            // 于是下面生成的 SDK 里 platform / node 都会带 «?»——模型看到的就是「可能不存在」
            // SDK 是对 schema 的忠实翻译，连偷懒一起翻译过去
            properties: { platform: { type: 'string' }, node: { type: 'string' } },
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute() {
          return { platform: process.platform, node: process.version }
        },
      }),
    )
  },
}

let seq = 0
function runCode(root: Context, code: string) {
  return root.tools.execute({
    callId: CallId(`call-${++seq}`),
    name: 'run_code',
    // code 是一段 async 函数的函数体，可以直接用顶层 await 和 return
    arguments: { code, description: 'probe the environment and add' },
    signal: new AbortController().signal,
  })
}

// ── native 模式：模型直接看见每一个工具 ──
async function nativeView(): Promise<void> {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime) // mode 默认 'native'
  await root.plugin(probeTools)

  const assembly = await root.systemPrompt.assemble()
  console.log('--- native 模式：模型看见的工具 ---')
  console.log(JSON.stringify(assembly.tools.map((tool) => tool.name)))
}

// ── code 模式：模型只看见 run_code，工具清单变成了 SDK ──
async function codeView(): Promise<void> {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(WorkerThreadCodeRuntime) // 挂上后端，run_code 才有东西可跑
  await root.plugin(ToolRuntime, { mode: 'code' })
  await root.plugin(probeTools)

  const assembly = await root.systemPrompt.assemble()
  console.log('\n--- code 模式：模型看见的工具 ---')
  console.log(JSON.stringify(assembly.tools.map((tool) => tool.name)))

  // 工具没消失，只是换了个形式：schema 被现场翻译成 TypeScript 类型声明
  //    「现场」是关键——每次组装提示词都重新生成，永远和注册表里挂着的工具一致。
  console.log('\n--- 随之生成的 SDK（提示词节选）---')
  const prompt = renderPrompt(assembly)
  const start = prompt.indexOf('```ts')
  console.log(prompt.slice(start, prompt.indexOf('```', start + 5) + 3))

  // 模型写的程序：一次 run_code，里面调两个工具。
  //    只有最终这份 { logs, result } 回模型上下文，中间产物留在程序里——
  //    这正是 Code Mode 省 token 的地方。
  //
  //    注意 env.platform：程序拿到的是**结构化对象**，不是一段文本。
  //    而回给模型的 content 是渲染后的文本（见下面输出里的 content 字段）。
  //    上一章那句「程序要 value，模型要 content」到这里就落地了。
  console.log('\n--- 让模型写一段程序，一次跑完 ---')
  console.log(
    JSON.stringify(
      await runCode(
        root,
        `const sum = await tools.add({ a: 1, b: 2 })
const env = await tools.env_probe({})
console.log('platform =', env.platform)
return { sum, platform: env.platform }`,
      ),
    ),
  )

  // 模型想绕过程序、直接点名 env_probe？不行。
  //    错误码是 UNKNOWN_TOOL——对它来说这个工具根本不存在，
  //    不是「存在但不许调」，而是干脆不在可调用面里。
  console.log('\n--- 模型绕过 run_code，直接点名调 env_probe ---')
  console.log(
    JSON.stringify(
      await root.tools.execute({
        callId: CallId(`call-${++seq}`),
        name: 'env_probe',
        arguments: {},
        signal: new AbortController().signal,
      }),
      null,
      2,
    ),
  )

  // 守卫对子调用一视同仁。
  //    程序里 await tools.env_probe({}) 会抛 ToolCallError，
  //    程序用 try/catch 接住、记下一句话，接着照常跑 add；外层 run_code 依然是 isError: false。
  //    （把 try/catch 去掉再跑一次，整个 run_code 就会失败——那是本章的思考题。）
  console.log('\n--- 守卫能否管住程序里的子调用 ---')
  const offGuard = root.tools.guard((exec) => (exec.name === 'env_probe' ? 'env_probe 已被禁用' : undefined))
  const result = await runCode(
    root,
    `let probe
try {
  probe = await tools.env_probe({})
} catch (error) {
  probe = 'caught: ' + error.message
}
return { probe, sum: await tools.add({ a: 3, b: 4 }) }`,
  )
  console.log(JSON.stringify(result, null, 2))
  offGuard()
}

async function main(): Promise<void> {
  try {
    await nativeView()
    await codeView()
  } catch (err) {
    console.error('Failed to run code-mode-demo:', err)
    process.exit(1)
  }
}

main()
