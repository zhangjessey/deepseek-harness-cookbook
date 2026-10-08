// src/ch17/ralph-demo.ts —— Ralph：模型只传目标，循环脚本写死在工具里
// 跑法：DEEPSEEK_API_KEY=sk-xxx npm run start:ch17:ralph
//
// 这个文件演示本讲 Ralph 那条路的真实运行：
//   模型只传一个目标（objective）→ ralph 工具拿写死的循环脚本调同一个编排引擎
//   → 每一轮开一个全新子 agent（真实 agent，联网调模型）→ 靠共享工作区和交接跨轮接力。
//
// 因为子 agent 是真实的，这里能看到三件事：
//   1. 每一轮都是「新的」子 agent（各自的会话 id 不同，谁也不继承谁的对话）；
//   2. 子 agent 内部真的会动手（等模型 → 调工具写工作区 → 看结果）；
//   3. 跨轮靠什么接力：工作区是同一份文件，加上上一轮传的那份报告（交接）。
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
import * as ToolRalph from '@deepseek-ai/dsh-tool-ralph'
import * as DeepSeekAdapter from '@deepseek-ai/dsh-llm-deepseek'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import { printEvents } from './shared-print-events.ts'
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PROVIDER = 'deepseek-official'
const MODEL = 'deepseek-v4-flash'
const WORKSPACE = mkdtempSync(join(tmpdir(), 'ch17-ralph-workspace-'))
const STORAGE = mkdtempSync(join(tmpdir(), 'ch17-ralph-sessions-'))

async function main(): Promise<void> {
  if (process.env.DEEPSEEK_API_KEY === undefined || process.env.DEEPSEEK_API_KEY === '') {
    console.error('这个示例要联网调真实模型：请先 export DEEPSEEK_API_KEY=... 再跑 npm run start:ch17:ralph')
    process.exit(1)
  }

  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  // JSONL 后端：子 agent 的会话事件落盘，后面才能按会话 id 把每一轮的过程读出来
  await ctx.plugin(SessionPersistenceJsonl, { root: STORAGE })
  // 真实模型适配器（读 DEEPSEEK_API_KEY）
  await ctx.plugin(DeepSeekAdapter, { apiKeyEnv: 'DEEPSEEK_API_KEY' })
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawnInProcess)
  await ctx.plugin(WorkerThreadWorkflowEngine, { provider: 'spawn' })
  // ralph 工具：循环脚本写死在它里面，模型只传 objective / maxRounds
  await ctx.plugin(ToolRalph, {})
  // bash 工具：子 agent 靠它真的读写共享工作区
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { cwd: WORKSPACE })
  await ctx.plugin(ShellEnv)
  await ctx.plugin(ToolBash, {})

  // 脚本每轮 agent() 建子 agent 时发的事件（第二个参数 agent 带 seq 与 childId）
  const children: Array<{ seq: number; childId: SessionId }> = []
  ctx.on('workflow/agent-start', (_info, agent) => {
    if (agent.childId !== undefined) {
      children.push({ seq: agent.seq, childId: agent.childId })
    }
  })

  const parent = ctx.agentLoop.create(SessionId('sess-parent'), { provider: PROVIDER, model: MODEL }, { cwd: WORKSPACE })

  console.log('--- Ralph：模型只传目标，循环脚本写死在工具里 ---')
  console.log(`  模型：${PROVIDER} / ${MODEL}`)
  console.log(`  共享工作区：${WORKSPACE}`)
  console.log(`  会话日志：${STORAGE}`)

  parent.followup(
    createUserMessage({
      content: [
        {
          type: 'text',
          text: '请用 ralph 工具：目标是把本次示例整理成一份要点笔记写进工作区；请显式传 maxRounds=2。',
        },
      ],
      source: { kind: 'user' },
    }),
  )
  await parent.whenIdle()

  console.log('\n--- 模型传了什么（ralph 工具收到的参数）---')
  for (const event of parent.session.events) {
    if (event.type !== 'tool/call') continue
    const data = event.data as { name?: string; arguments?: string }
    if (data.name !== 'ralph') continue
    console.log(`  ${data.arguments ?? '(没拿到参数)'}`)
  }

  console.log('\n--- 每一轮：开一个全新子 agent，它内部发生了什么 ---')
  for (const child of children) {
    console.log(`\n  第 ${child.seq} 轮的子 agent（会话 ${child.childId}）`)
    const inspection = await ctx.sessionPersistence.inspect(child.childId)
    printEvents(inspection.events)
  }

  console.log('\n--- 收手：ralph 工具返回的终态 ---')
  for (const event of parent.session.events) {
    if (event.type !== 'tool/result') continue
    const data = event.data as { message?: { content?: Array<{ content?: Array<{ type: string; text?: string }> }> } }
    const blocks = data.message?.content?.[0]?.content ?? []
    const text = blocks.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('')
    if (text.length === 0) continue
    console.log(`  ${text}`)
  }

  console.log('\n--- 共享工作区里留下了什么（每轮都写进这一份）---')
  for (const name of readdirSync(WORKSPACE)) {
    const full = join(WORKSPACE, name)
    if (statSync(full).isDirectory()) continue
    const content = readFileSync(full, 'utf8')
    console.log(`  ${name}：`)
    for (const line of content.split('\n')) {
      if (line.trim().length > 0) console.log(`    ${line}`)
    }
  }
}

main()
