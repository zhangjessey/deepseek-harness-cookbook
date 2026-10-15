// src/firewall/ch19/firewall-demo.ts —— cli / 可运行入口（对应脚本 npm run start:ch19）
//
// 装配 edge + control 两个 bundle，跑通"起草候选 -> 人审批 -> 发布 ->
// facts 校验 -> 带外修改补记 -> 重启恢复"的完整链路。需要 DEEPSEEK_API_KEY：本讲"Agent 起草候选"由真实 DeepSeek 模型把自然语言意图起草成规则，其余 ledger/审批/facts 机制为确定性代码。
import { Context } from '@deepseek-ai/cordis'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { edgeBundle, controlBundle } from '../bundles'
import { ACTOR, Ledger } from '../ledger'
import { verifyFacts } from '../facts'
import { mountLedgerLog } from '../session-log'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { LEDGER_PROJECTION_KEY, mountLedgerProjection } from '../session-projection'
import { SystemPrompt, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { mountLedgerPrompt } from '../session-prompt'
import { runAgentTests } from './real-model-run'
import { agentDraftRule } from '../agent-draft.ts'

async function main(): Promise<void> {
  const file = fileURLToPath(new URL('../rules.ledger.json', import.meta.url))
  // 每次运行用新的落盘目录：保证输出可复现（权威不累积上一次运行的事实）。
  const root = mkdtempSync(join(tmpdir(), 'firewall-ch19-'))
  const ctx = new Context()
  await ctx.plugin(edgeBundle, { file, sessionId: 'sess-1', agentsSessionId: 'sess-1', root })
  await ctx.plugin(controlBundle)

  // 通过 cordis 服务取用，而不是模块级全局变量：
  // 数据面提供 ctx.ledger，控制面 inject 它再暴露命令与审批工具。
  const ledger = ctx.ledger.ledger
  const cmd = ctx.firewallControl.command
  const edit = ctx.firewallControl.edit
  // 启动时对账：上一次运行留下的规则文件（产物）若权威里没有，就补记进会话日志——
  // 此后文件只作为投影存在，不再充当历史。
  await ledger.adoptProjection()

  console.log('=== /firewall level 1（默认）===')
  console.log(await cmd.handle('level 1'))

  console.log('\n=== Agent 起草候选 -> 人审批 -> 发布（真实模型）===')
  const intent = '拦截来自 1.2.3.4 的所有请求'
  const draft = await agentDraftRule(intent)
  console.log(`模型原始回复: ${draft.raw}`)
  console.log(`模型 token 用量: in=${draft.usage.inputTokens} out=${draft.usage.outputTokens}`)
  const id = await edit.draftCandidate(draft.input, { by: ACTOR.agentDraft })
  console.log(`草稿 ${id} 起草为候选: ${JSON.stringify(draft.input)}`)
  await edit.approve(id, { by: ACTOR.humanApprove })
  console.log(`人审批后 ${id} 已 active`)

  console.log('\n=== 带外修改：人直接改文件，补记对账 ===')
  const current = ledger.listRules().map((r) => ({ ...r }))
  current.push({
    id: 'rule-outofband',
    name: 'block outofband',
    action: 'deny',
    when: { field: 'ip', op: 'eq', value: '1.2.3.4' },
    state: 'active',
  })
  await ledger.applyOutOfBand(current)
  console.log('带外新增 rule-outofband 已补记')

  console.log('\n=== facts 校验 ===')
  // 对账：权威（会话日志折叠）与产物（文件投影）是否一致。
  const facts = verifyFacts(ctx.ledgerLog, file)
  console.log(`一致=${facts.consistent}，事件数=${facts.eventCount}，当前规则数=${facts.rulesFromFold.length}`)

  console.log('\n=== 重启恢复（新进程从磁盘上的 JSONL 恢复权威）===')
  // 真实重启：开一个全新 Context，只带同样的落盘目录与 sessionId，从磁盘读回权威。
  // 等持久化把最后一帧落盘（写入是异步批处理）：**轮询重试**而不是固定 sleep——
  // 固定值在机器负载高时会不够，表现为"恢复出的规则数偏少"，且看不出是时序问题。
  const expected = ledger.listRules().length
  let restored = 0
  const deadline = Date.now() + 5_000
  for (;;) {
    const ctxRestart = new Context()
    await mountLedgerLog(ctxRestart, { sessionId: 'sess-1', root })
    restored = new Ledger(ctxRestart.ledgerLog, file, 'sess-1').listRules().length
    if (restored >= expected || Date.now() > deadline) break
    await new Promise((r) => setTimeout(r, 20))
  }
  console.log(`恢复后规则数=${restored}`)

  console.log('\n=== 账本事实写进 dsh 会话日志（会话日志是权威，文件只是产物）===')
  await ctx.plugin(SessionProjectionRegistry) // 控制面才有投影；数据面不挂也不影响
  // 会话日志已由 edgeBundle 挂好（它是账本的权威），这里直接取用。
  const log = ctx.ledgerLog
  // 发布本身就在写会话日志，所以这里不必再手动补一遍——直接看权威与产物是否对得上。
  console.log(`  权威：会话日志内事实=${log.facts().length} 条，折叠出规则数=${log.state().length}`)

  // 投影：同一个折叠函数，供工具与命令、界面、prompt 片段三处使用，不会各读各的。
  mountLedgerProjection(ctx)
  await new Promise((r) => setImmediate(r)) // 等 inject 回调落地
  const snapshot = ctx.sessionProjections.snapshot(log.session)
  const view = snapshot.values[LEDGER_PROJECTION_KEY] as { rules: unknown[] } | undefined
  console.log(`  投影 ${LEDGER_PROJECTION_KEY}：规则数=${view?.rules.length ?? 0}（与上面折叠一致）`)

  // prompt 片段：从折叠状态渲染，不读规则文件——否则恢复/分叉会话后模型看到的是"现在的文件"。
  await ctx.plugin(SystemPrompt)
  mountLedgerPrompt(ctx)
  await new Promise((r) => setImmediate(r))
  const assembled = renderPrompt(await ctx.systemPrompt.assemble())
  console.log(
    `  prompt 片段 firewall:ledger（order=60）已装配：${assembled.includes('block') ? '含当前规则' : '空库'}，总长=${assembled.length}`,
  )

  console.log('\n=== 真实模型 Agent 测试 ===')
  for (const line of await runAgentTests(file, ctx.ledgerLog)) console.log(line)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
