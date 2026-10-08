// src/ch17/workflow-demo.ts —— Workflow：模型现写脚本，引擎真派子 agent
// 跑法：DEEPSEEK_API_KEY=sk-xxx npm run start:ch17:workflow
//
// 这个文件演示本讲 Workflow 那条路的真实运行：
//   父模型现场写脚本 → 调 workflow 工具 → 工具内部调编排引擎 → 引擎按脚本派子 agent。
// 子 agent 是完整 agent（联网调真实模型），它每一步都留在自己的会话日志里，
// 所以这里能把「子 agent 内部发生了什么」也打出来：等模型 → 调工具 → 看工具结果 → 再等模型。
//
// 注意：本讲示例要联网、要真实 API key（DEEPSEEK_API_KEY），因为只有真模型
// 才能看到「模型现场写脚本」和「子 agent 真的动手干活」这两件事。
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import WorkerThreadWorkflowEngine from '@deepseek-ai/dsh-workflow-worker-thread'
import * as ToolWorkflow from '@deepseek-ai/dsh-tool-workflow'
import * as DeepSeekAdapter from '@deepseek-ai/dsh-llm-deepseek'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import { printEvents } from './shared-print-events.ts'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** DeepSeek 官方适配器挂载的 provider 路由。 */
const PROVIDER = 'deepseek-official'
/** 默认目录里的一个模型；换模型只需改这里，不用重新注册路由。 */
const MODEL = 'deepseek-v4-flash'
const WORKSPACE = mkdtempSync(join(tmpdir(), 'ch17-workspace-'))
// 预置示例文件：src 目录 5 个、docs 目录 3 个，让子 agent 真去数
const SAMPLE_FILES = [
  'src/main.py', 'src/utils.py', 'src/lib/io.py', 'src/lib/core.py', 'src/sub/deep/nested.rs',
  'docs/README.md', 'docs/guide.md', 'docs/api/reference.md',
]
for (const file of SAMPLE_FILES) {
  const full = join(WORKSPACE, file)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, '')
}
const STORAGE = mkdtempSync(join(tmpdir(), 'ch17-sessions-'))

async function main(): Promise<void> {
  if (process.env.DEEPSEEK_API_KEY === undefined || process.env.DEEPSEEK_API_KEY === '') {
    console.error('这个示例要联网调真实模型：请先 export DEEPSEEK_API_KEY=... 再跑 npm run start:ch17:workflow')
    process.exit(1)
  }

  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  // JSONL 后端：子 agent 的会话事件落盘，后面才能按会话 id 把它的过程读出来
  await ctx.plugin(SessionPersistenceJsonl, { root: STORAGE })
  // 真实模型适配器（读 DEEPSEEK_API_KEY），取代假模型
  await ctx.plugin(DeepSeekAdapter, { apiKeyEnv: 'DEEPSEEK_API_KEY' })
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawnInProcess)
  await ctx.plugin(WorkerThreadWorkflowEngine, { provider: 'spawn' })
  await ctx.plugin(ToolWorkflow, {})
  // bash 工具：子 agent 靠它真的执行命令（数文件 / 写工作区）
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { cwd: WORKSPACE })
  await ctx.plugin(ShellEnv)
  await ctx.plugin(ToolBash, {})

  // 脚本里每次 agent() 建子 agent，引擎都发 workflow/agent-start（第二个参数 agent 带会话 id 与 seq）
  const children: Array<{ seq: number; childId: SessionId }> = []
  ctx.on('workflow/agent-start', (_info, agent) => {
    if (agent.childId !== undefined) {
      children.push({ seq: agent.seq, childId: agent.childId })
    }
  })

  const parent = ctx.agentLoop.create(SessionId('sess-parent'), { provider: PROVIDER, model: MODEL }, { cwd: WORKSPACE })

  console.log('--- Workflow：模型现写脚本，引擎真派子 agent ---')
  console.log(`  模型：${PROVIDER} / ${MODEL}`)
  console.log(`  工作区：${WORKSPACE}`)
  console.log(`  会话日志：${STORAGE}`)

  // 提示词只提任务、不规定怎么编排——并行/顺序/流水线都由模型现写决定
  const prompt = '请用 workflow 工具写一段脚本：派两个子 agent，一个统计 src 目录、一个统计 docs 目录各有多少个文件，最后把两个结果汇总返回。'
  console.log('\n--- 给父模型的提示词 ---')
  console.log(`  ${prompt}`)

  parent.followup(
    createUserMessage({
      content: [
        {
          type: 'text',
          text: prompt,
        },
      ],
      source: { kind: 'user' },
    }),
  )
  await parent.whenIdle()

  console.log('\n--- 父模型现场写的脚本（workflow 工具收到的 script）---')
  for (const event of parent.session.events) {
    if (event.type !== 'tool/call') continue
    const data = event.data as { name?: string; arguments?: string }
    if (data.name !== 'workflow') continue
    const args = JSON.parse(data.arguments ?? '{}') as { script?: string }
    console.log(args.script ?? '(没拿到脚本)')
  }

  console.log('\n--- 子 agent 内部：每一步都留在它自己的会话里 ---')
  for (const child of children) {
    console.log(`\n  子 agent #${child.seq}（会话 ${child.childId}）`)
    const inspection = await ctx.sessionPersistence.inspect(child.childId)
    printEvents(inspection.events)
  }

  console.log('\n--- 编排结果（脚本 return 的值）---')
  for (const event of parent.session.events) {
    if (event.type !== 'tool/result') continue
    const data = event.data as { message?: { content?: Array<{ content?: Array<{ type: string; text?: string }> }> } }
    const blocks = data.message?.content?.[0]?.content ?? []
    const text = blocks.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('')
    if (text.length === 0) continue
    console.log(`  ${text}`)
  }
}

main()
