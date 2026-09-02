// src/ch05/seam-demo.ts —— seam 三角色：只换 Provider，工具一行不改
// 跑法：npm run start:ch05:seam
import { Context, Service } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { defineTool, ToolRuntime } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'

// ── 角色一：Definition（契约）──
abstract class EnvProbe extends Service {
  constructor(ctx: Context) {
    super(ctx, 'envProbe')
  }
  abstract probe(): Promise<{ platform: string; node: string }>
}

// 把服务名挂到 Context 上，下面的 ctx.envProbe 才有类型
// （这是 Cordis 服务的常规做法：注册是一回事，让 TypeScript 认识它是另一回事）
declare module '@deepseek-ai/cordis' {
  interface Context {
    envProbe: EnvProbe
  }
}

// ── 角色二：Service Provider（实现，可替换）──
class LocalEnvProbe extends EnvProbe {
  async probe() {
    return { platform: process.platform, node: process.version }
  }
}

class FakeEnvProbe extends EnvProbe {
  async probe() {
    return { platform: '<fake:platform>', node: '<fake:node>' }
  }
}

// ── 角色三：Consumer（只认契约）──
const envProbeTool = {
  name: 'env-probe-tool',
  inject: ['tools', 'envProbe'] as const,
  apply(ctx: Context) {
    ctx.tools.register(
      defineTool({
        name: 'env_probe',
        description: 'Report the runtime environment.',
        parameters: {},
        output: {
          // ... output 与 parameters 写法同上一节，此处略
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              platform: { type: 'string' },
              node: { type: 'string' },
            },
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute() {
          return ctx.envProbe.probe() // 只依赖契约，不关心具体实现
        },
      }),
    )
  },
}

function callTool(root: Context) {
  return root.tools.execute({
    callId: CallId('call-1'),
    name: 'env_probe',
    arguments: {},
    signal: new AbortController().signal,
  })
}

async function main(): Promise<void> {
  try {
    const root = new Context()
    await root.plugin(SystemPrompt)
    await root.plugin(ToolRuntime)

    // 挂上 Provider A
    const providerA = await root.plugin(LocalEnvProbe)
    await root.plugin(envProbeTool)
    console.log('--- 提供方 = local ---')
    console.log({ value: (await callTool(root)).value })

    // 只卸载 Provider，工具一行没动
    await providerA.dispose()
    console.log('--- 卸载 Provider 后，剩余工具 ---')
    console.log(JSON.stringify(root.tools.schemas()))

    // 换上 Provider B
    await root.plugin(FakeEnvProbe)
    console.log('--- 换上 fake 后，剩余工具 ---')
    console.log(JSON.stringify(root.tools.schemas().map((s) => s.name)))
    console.log({ value: (await callTool(root)).value })
  } catch (err) {
    console.error('Failed to run seam-demo:', err)
    process.exit(1)
  }
}

main()
