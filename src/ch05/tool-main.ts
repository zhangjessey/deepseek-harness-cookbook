// src/ch05/tool-main.ts —— 把 greet 工具跑起来
// 跑法：npm run start:ch05
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as greetTool from './greet-tool.ts'

async function main(): Promise<void> {
  try {
    const root = new Context()

    await root.plugin(SystemPrompt) // ① ToolRuntime 依赖 systemPrompt，先提供它
    await root.plugin(ToolRuntime) // ② 挂上工具注册表本身
    const fiber = await root.plugin(greetTool) // ③ 挂消费方插件，工具随之注册

    console.log('--- 模型看得见的工具清单 ---')
    console.log(JSON.stringify(root.tools.schemas(), null, 2))

    console.log('--- 调用 greet ---')
    console.log(
      await root.tools.execute({
        callId: CallId('call-1'), // 调用标识，用于追踪（是品牌类型，不能直接给字符串）
        name: 'greet',
        arguments: { name: 'World' },
        signal: new AbortController().signal, // 取消信号，生产环境由 agent loop 传入
      }),
    )

    console.log('--- 卸载消费方插件 ---')
    await fiber.dispose()

    console.log('--- 卸载后再看清单 ---')
    console.log(JSON.stringify(root.tools.schemas()))
  } catch (err) {
    console.error('Failed to run tool-main:', err)
    process.exit(1)
  }
}

main()
