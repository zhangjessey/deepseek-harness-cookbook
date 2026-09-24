import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'

// 本地工具插件的绝对路径，会写进两份 agent.cordis.yml
const toolJs = fileURLToPath(new URL('./tool.js', import.meta.url))

/** 一份 preset 的组装文本：一个人设行 + 一个工具行。 */
function presetOf(persona: string, tool: string): string {
  return `- id: tool
  name: ${toolJs}
  config:
    tool: ${tool}

- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: ${persona}
`
}

async function main(): Promise<void> {
  // 1. 造两个 preset 目录，各放一份 agent.cordis.yml
  const root = await mkdtemp(join(tmpdir(), 'dsh-preset-demo-'))
  for (const [id, persona, tool] of [
    ['coder', '你是个严谨的程序员，写代码一丝不苟。', 'run_command'],
    ['writer', '你是个文艺的作家，出口成章。', 'write_poem'],
  ] as const) {
    await mkdir(join(root, id))
    await writeFile(join(root, id, 'agent.cordis.yml'), presetOf(persona, tool))
  }

  // 2. 装配：ch13 的六个包，外加 Loader 和 preset roster
  const ctx = new Context()
  // 让 Loader 从宿主基址解析裸包名（@deepseek-ai/dsh-*）——preset 存在主目录下，
  // Node 向上找 node_modules 够不到 dsh，不设这行那些行就会 import 失败
  ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '部署默认人设' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, {
    default: 'coder',
    roots: [{ path: root, trust: 'user' as const }], // trust：system = 应用自带，user = 用户或 agent 写的
    includeUserRoot: false,
  })

  // 3. 用某个 preset 组装一个 agent（setup 钩子 = 唯一受支持的挂载点）
  const on = async (id: string, presetId?: string): Promise<Agent> =>
    (
      await ctx.agents.create({
        sessionId: SessionId(id),
        setup: async (agentCtx: Context) => void (await ctx.agentPresets.mount(agentCtx, presetId)),
      })
    ).agent

  const show = async (label: string, agent: Agent | undefined): Promise<void> => {
    const tools = ctx.tools.schemas(agent).map((s) => s.name)
    const persona = agent
      ? (await ctx.systemPrompt.assemble(assembleContextFor(agent))).sections.find(
          (s) => s.name === 'deployment:persona',
        )?.text
      : (await ctx.systemPrompt.assemble()).sections.find((s) => s.name === 'deployment:persona')?.text
    console.log(`  ${label}: 工具 [${tools.join(', ') || '无'}]，人设 "${persona ?? '无'}"`)
  }

  console.log('--- roster 发现了哪些 preset ---')
  for (const p of (await ctx.agentPresets.list()).sort((a, b) => a.id.localeCompare(b.id))) {
    console.log(`  ${p.id}${p.broken ? `（损坏：${p.broken}）` : ''}`)
  }

  console.log('\n--- 用不同 preset 各挂载一个 agent ---')
  const coder = await on('sess-coder', 'coder')
  const writer = await on('sess-writer', 'writer')
  await show('sess-coder', coder)
  await show('sess-writer', writer)

  console.log('\n--- 宿主 ctx（没挂任何 preset）---')
  await show('host', undefined)

  console.log('\n--- 再来一个也用 coder 的 agent ---')
  const coder2 = await on('sess-coder-2', 'coder')
  await show('sess-coder-2', coder2)
  const same =
    ctx.tools
      .schemas(coder)
      .map((s) => s.name)
      .join() ===
    ctx.tools
      .schemas(coder2)
      .map((s) => s.name)
      .join()
  console.log(`  两个 coder 会话看到同一套工具：${same}`)

  console.log('\n--- 创作 = 复制：copy() 出一个新的 ---')
  await ctx.agentPresets.copy('coder', 'coder2', '程序员二号')
  for (const p of (await ctx.agentPresets.list()).sort((a, b) => a.id.localeCompare(b.id))) {
    console.log(`  ${p.id}`)
  }
}

await main()
