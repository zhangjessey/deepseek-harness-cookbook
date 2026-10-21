// src/firewall/bundles-runtime.test.ts —— 四个组合包的**运行时**行为验证
//
// 为什么单独一个文件：`packages/*/src` 已经纳入 typecheck / lint / prettier，但**类型检查
// 抓不到"装上之后行为不对"**。ch20 那个缺 await 的 bug 就是这样进了构建产物的——
// 补上 tsconfig 后 `tsc` 立刻报出来，说明它此前从未被任何检查看过。
//
// 所以这里测的是**装进 dsh 之后**发生什么（apply → 服务与工具注册 → execute 的行为），
// 也就是四讲 README 里"dsh plugin add <本包>"那一段承诺的落点。
//
// 只钉**会被悄悄弄坏**的那几条：装上之后审批闸是否真的存在、关卡是否真的强制、
// 规则文件是否真的被载入、后台任务是否真的在跑。工具的细节行为在各讲自己的测试里。
//
// 收尾必须 `dispose`：组合包会挂定时器（后台任务）与会话持久化，它们都是 cordis 的
// **effect**——只 `stop()` 定时器不 dispose 的话，残留的服务与监听器会让测试进程不退出。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Plugin } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { apply as applyRule } from './dsh-firewall-rule/src/index'
import { apply as applyGovernance } from './dsh-firewall-governance/src/index'
import { apply as applyEvolution } from './dsh-firewall-evolution/src/index'
import { apply as applyEvalLoop } from './dsh-firewall-eval-loop/src/index'

interface ToolsStub {
  registered: Map<string, ToolDefinition>
  /** 通过 ctx.tools.guard 注册的守卫（白名单守卫 / 单调守卫）。 */
  guards: Array<(exec: { name: string }) => string | undefined>
}

/**
 * 最小 tools 桩：记录**注册了什么**。
 * 不实现 dsh 的执行管线（pre-execute / 呈现）——这里要测的是"装上之后有没有把闸门挂上"。
 */
function provideToolsStub(ctx: Context): ToolsStub {
  const stub: ToolsStub = { registered: new Map(), guards: [] }
  ctx.provide('tools', {
    register(def: ToolDefinition) {
      stub.registered.set(def.name, def)
      return () => {}
    },
    guard(fn: (exec: { name: string }) => string | undefined) {
      stub.guards.push(fn)
      return () => {}
    },
  } as unknown as ToolRuntime)
  return stub
}

/**
 * cordis 的子插件不是同步挂上的；组合包内部还有**多层 await**
 * （挂会话 → 挂持久化 → 挂任务 → attachLog），一个宏任务沉降不完。
 */
function settle(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** 等某个路径出现（落盘是异步批处理的，不能 sleep 固定值）。 */
async function waitForPath(p: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(p)) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return false
}

/** 回放样本（ch21 自带，19 条）。 */
const TRAFFIC = fileURLToPath(new URL('../src/firewall/ch21/traffic.sample.log', import.meta.url))

/**
 * 轮询等待某个东西就绪。
 *
 * 组合包的挂载链里有**文件 IO**（会话持久化的 prepare），固定 sleep 不稳
 * （负载高时不够、负载低时又白等），所以轮询到就绪为止。
 */
async function waitFor<T>(get: () => T | undefined, what: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = get()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`等待 ${what} 超时（组合包子插件未挂载完成）`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/**
 * 收尾：从 registry 里卸载插件。
 *
 * **注意 cordis 的 `Context` 没有 `dispose()`**——写成 `ctx.dispose?.()` 会被 `?.`
 * 静默跳过，等于什么都没清理。结果是定时器（后台任务）一直挂在事件循环上，
 * 表现为"测试跑完了但进程不退出"。
 * 正确做法是从 registry 删掉插件：它的 effect 随之清理，定时器也就停了。
 */
function teardown(ctx: Context, ...plugins: Plugin[]): void {
  // 传进来的必须是**当初挂上去的那个插件对象**（各包的 `apply` 函数）。
  // 传别的（哪怕是包内部注册的服务类）`delete` 就是 no-op，插件与其子插件全部残留——
  // 子插件里往往还挂着定时器与会话持久化，测试进程于是退不出去。
  for (const p of plugins) ctx.registry.delete(p)
}

// ── ch18 组合包 ──

test('ch18 组合包：装上后注册只读工具，且规则文件真的被载入', async () => {
  const dir = tmpDir('bundle-rule-')
  const rulesFile = join(dir, 'rules.json')
  writeFileSync(
    rulesFile,
    JSON.stringify({
      rules: [
        { name: 'block admin scan', action: 'deny', when: { field: 'path', op: 'starts_with', value: '/admin' } },
      ],
    }),
  )
  const prev = process.env.FIREWALL_RULES_FILE
  process.env.FIREWALL_RULES_FILE = rulesFile
  const ctx = new Context()
  const tools = provideToolsStub(ctx)
  try {
    await ctx.plugin(applyRule)
    await settle()

    assert.ok(tools.registered.has('list_rules'), 'list_rules 已注册')
    assert.ok(tools.registered.has('check_request'), 'check_request 已注册')
    assert.equal(ctx.firewall.listRules().length, 1, '规则文件里的规则真的进了引擎')
    assert.equal(ctx.firewall.listRules()[0].name, 'block admin scan')
  } finally {
    if (prev === undefined) delete process.env.FIREWALL_RULES_FILE
    else process.env.FIREWALL_RULES_FILE = prev
    teardown(ctx, applyRule)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ch18 组合包：check_request 走数据面入口（控制面与数据面同口径）', async () => {
  // 组合包层再验一次：控制面是给治理 Agent 做判断用的，若它绕过入口，
  // 同一个"未命中"在控制面读作放行、在数据面读作拒绝，Agent 据此做的决定是错的。
  const ctx = new Context()
  const tools = provideToolsStub(ctx)
  try {
    await ctx.plugin(applyRule)
    await settle()

    const def = tools.registered.get('check_request')
    assert.ok(def, 'check_request 已注册')
    const out = (await def.execute({ method: 'GET', path: `/x`.repeat(9000) }, {} as never)) as {
      decision: { ruleId: string } | null
      rejectedByEntry?: boolean
    }
    assert.equal(out.rejectedByEntry, true, '超长字段必须被入口拒绝（而不是"未命中"）')
    assert.equal(out.decision?.ruleId, 'entry')
  } finally {
    teardown(ctx, applyRule)
  }
})

// ── ch19 组合包 ──

test('ch19 组合包：装上之后审批闸**真的存在**', async () => {
  // 这是"人始终在 Agent 之上"在真实部署里的落点。若组合包没挂载审批闸，
  // 任何 Agent 在任何自主级别都能起草/自批/驳回——而界面上看起来一切正常。
  // （此前这一条正是缺失的：全 packages 里 grep 不到任何 mountApproval 调用。）
  const dir = tmpDir('bundle-gov-')
  const ctx = new Context()
  const tools = provideToolsStub(ctx)
  try {
    await ctx.plugin(applyGovernance, { file: join(dir, 'firewall.ledger.json'), sessionId: 'sess-bundle-gov' })
    await settle()

    assert.ok(tools.guards.length > 0, '组合包必须挂上 tools.guard（白名单守卫）')
    // 守卫真的收紧：白名单外拒绝、白名单内放行
    assert.ok(
      tools.guards.some((g) => typeof g({ name: 'bash' }) === 'string'),
      '白名单外的工具（bash）必须被守卫拒绝',
    )
    assert.ok(
      tools.guards.every((g) => g({ name: 'firewall_list' }) === undefined),
      '白名单内的工具（firewall_list）不该被守卫拒绝',
    )
  } finally {
    teardown(ctx, applyGovernance)
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── ch20 组合包 ──

test('ch20 组合包：装上后注册观察与提案工具', async () => {
  const ctx = new Context()
  const tools = provideToolsStub(ctx)
  try {
    await ctx.plugin(applyEvolution)
    await settle()

    assert.ok(tools.registered.has('firewall_observe'), 'firewall_observe 已注册')
    assert.ok(tools.registered.has('firewall_propose'), 'firewall_propose 已注册')
  } finally {
    teardown(ctx, applyEvolution)
  }
})

// ── ch21 组合包 ──

test('ch21 组合包：伪造的 evalResult 骗不过确认（候选确认由服务端算）', async () => {
  // 确认吃的是评测算出的误伤率。若让模型把 evalResult 当参数传进来，它只要传一个
  // `falsePositiveRate: 0` 就能让 100% 误伤的候选"确定性地"通过风险检查——确认成了装饰。
  //
  // 这里用**行为**而不是"入参里有没有这个字段"来验证：直接把伪造值塞进去，
  // 看确认是否仍按真实回放判定。（查字段名只能证明当前没这个参数，
  // 证明不了"就算传了也不会被采信"。）
  const dir = tmpDir('bundle-loop-')
  const ctx = new Context()
  const tools = provideToolsStub(ctx)
  try {
    // root 指到临时目录：闭环日志默认写在宿主 cwd 下，测试不能污染工作区。
    await ctx.plugin(applyEvalLoop, { root: dir, intervalMs: 3_600_000 })
    const def = await waitFor(() => tools.registered.get('firewall_loop'), 'firewall_loop 注册')

    // 一条会命中全部浏览器流量的坏候选（demo 里的 trap-1）
    const candidate = {
      id: 'trap-1',
      name: 'block ua browser',
      action: 'deny',
      when: { field: 'ua', op: 'contains', value: 'Mozilla' },
    }
    const out = (await def.execute(
      {
        candidate,
        trafficFile: TRAFFIC,
        autonomyLevel: '1',
        // 模型伪造：声称 0% 误伤、覆盖 100%
        evalResult: { falsePositiveRate: 0, coverage: 1, precision: 1, sampleSufficient: true },
      },
      {} as never,
    )) as { report: { pass: boolean; risk: { pass: boolean; reason: string } } }

    assert.equal(out.report.risk.pass, false, '伪造的 evalResult 不得让风险检查放行')
    assert.match(
      out.report.risk.reason,
      /误伤率|命中 0 次|样本不足/,
      `理由应指向真实回放结果：${out.report.risk.reason}`,
    )
  } finally {
    teardown(ctx, applyEvalLoop)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ch21 组合包：闭环后台任务真的被挂上（老化 / 自动回退不是"用完即弃"）', async () => {
  // 以前工具每次调用都 new 一个 RuleLifecycle、用完即弃，于是"连续 N 次无命中 → 老化"
  // 永远触发不了——自动回退这张安全网在真实部署里等于不存在。
  const dir = tmpDir('bundle-loop-')
  const ctx = new Context()
  provideToolsStub(ctx)
  try {
    await ctx.plugin(applyEvalLoop, { root: dir, intervalMs: 3_600_000 })
    const task = await waitFor(
      () => (ctx as unknown as { firewallLoopTask?: { persistent: boolean } }).firewallLoopTask,
      '后台任务挂载',
    )
    assert.equal(task.persistent, true, '组合包挂了闭环日志，应当是持久化模式（否则重启即忘）')
  } finally {
    teardown(ctx, applyEvalLoop)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ch19 组合包：账本事实真的落盘（不是只挂 SessionStore）', async () => {
  // 只挂 SessionStore 而不带 JSONL 持久化的话，"会话日志是账本"这句话不成立：
  // 进程一退权威就没了。更实质的一条是：权威恒空会让 `adoptProjection` 每次启动都走
  // "带外补记"分支，把磁盘投影按 `state` 原样补记回权威——那条兜底路径本该只在首次
  // 运行命中，不挂持久化会把它变成每次重启的常规路径（"文件被改过就转 active"）。
  const dir = tmpDir('bundle-gov-log-')
  const root = join(dir, 'sessions')
  const ctx = new Context()
  try {
    provideToolsStub(ctx)
    await ctx.plugin(applyGovernance, {
      file: join(dir, 'firewall.ledger.json'),
      sessionId: 'sess-gov-log',
      root,
    })
    // 只断言"服务存在"证明不了会落盘——持久化目录是**首次写入**时才建的。
    // 所以真的写一条账本事实，再等它出现在 root 下。
    await waitFor(() => (ctx as unknown as { sessionPersistence?: unknown }).sessionPersistence, 'JSONL 持久化服务')
    const log = await waitFor(
      () => (ctx as unknown as { ledgerLog?: { appendFact: (f: unknown) => void } }).ledgerLog,
      'ledgerLog 服务',
    )
    log.appendFact({
      type: 'rule.add',
      id: 'r1',
      input: { name: 'x', action: 'deny', when: { field: 'path', op: 'eq', value: '/a' } },
      at: Date.now(),
      state: 'candidate',
    })
    assert.ok(await waitForPath(root), `写入事实后，持久化目录应当被创建：${root}`)
  } finally {
    teardown(ctx, applyGovernance)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ch21 组合包：模型自报的观测值不被采信（自动回退按真实回放判定）', async () => {
  // 与"不接受 evalResult"同一原则：**让被约束方自己报告判定依据，闸门就是装饰**。
  // actualBad 若由模型传，它只要恒传 true，误伤计数与误伤率就永远是 0 →
  // **自动回退永不触发**。现在这两个观测值都由服务端从回放样本算出来。
  //
  // 用**行为**验证而不是"入参里有没有字段"：直接把伪造值塞进去，看回退是否照样发生。
  const dir = tmpDir('bundle-loop-')
  const ctx = new Context()
  const tools = provideToolsStub(ctx)
  try {
    await ctx.plugin(applyEvalLoop, { root: dir, intervalMs: 3_600_000 })
    const def = await waitFor(() => tools.registered.get('firewall_loop'), 'firewall_loop 注册')

    // trap-1：会拦下所有带 Mozilla 的正常请求 → 真实回放里误伤率很高
    const candidate = {
      id: 'trap-1',
      name: 'block ua browser',
      action: 'deny',
      when: { field: 'ua', op: 'contains', value: 'Mozilla' },
    }
    // 用**两个相反方向**的伪造值各跑一次（用不同 id，避免 track 按 id 去重）：
    //  · 乐观：声称"没拦下、而且这条是坏的" → 试图让误伤率变成 0
    //  · 悲观：声称"拦下了、而且这条是好的" → 试图制造一次误伤
    // 若这些值被采信，两次结果必然不同；不被采信则两次一致。
    const run = async (id: string, forged: Record<string, unknown>) =>
      (await def.execute(
        { candidate: { ...candidate, id }, trafficFile: TRAFFIC, autonomyLevel: '2', ...forged },
        {} as never,
      )) as { stage: string }

    const optimistic = await run('cand-optimistic', { blocked: false, actualBad: true })
    const pessimistic = await run('cand-pessimistic', { blocked: true, actualBad: false })
    assert.equal(optimistic.stage, pessimistic.stage, '两个相反方向的自报值都没被采信 → 闭环只按回放样本推进')
  } finally {
    teardown(ctx, applyEvalLoop)
    rmSync(dir, { recursive: true, force: true })
  }
})
