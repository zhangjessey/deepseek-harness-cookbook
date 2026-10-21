// src/firewall/ch21/demo/rule-eval-demo.ts —— cli / 可运行入口（对应脚本 npm run start:ch21）
//
// 演示 ch20→ch21 的流水线：ch20 长出候选 → ch21 评测三件事 → 候选确认 → 闭环（shadow/灰度/active/老化/自动回退）。
// 需要 DEEPSEEK_API_KEY：候选由 ch20 的真实模型提案生成；评测/确认/闭环为确定性代码（确认写进工具代码）。
import { fileURLToPath } from 'node:url'
import { Observer, ObserveSession } from '../../ch20/observe'
import { proposeFromEvidence } from '../../ch20/propose'
import { evaluate, loadHistoricalTraffic, wouldBlock, type EvalResult } from '../evaluate'
import { confirmCandidate } from '../confirm'
import { RuleLifecycle } from '../loop'
import { feedMissedToEvidence } from '../feedback'
import type { Candidate } from '../../ch20/propose'

function pct(x: number): string {
  return (x * 100).toFixed(1) + '%'
}

/**
 * 命中 0 的候选，原因**不止一种**——提示必须按候选针对的异常类别分开给。
 *
 * 统一说"按归类值生成"会把 sqli 的真实原因带偏：它命中 0 不是因为归类值，
 * 而是注入特征在**查询参数的值**里，回放时 "?" 之后被拆进 query 字段、
 * path 只剩主干，于是 path contains "'--" 根本匹配不到
 * （实测 query.q contains "'--" 覆盖率 11.1%）。
 */
function weakHint(r: EvalResult): string {
  if (r.caughtBad + r.caughtGood !== 0) return ''
  if (r.evidenceKinds.includes('bad-ua')) {
    return '  ⚠ 未命中任何流量：when 按脱敏的“归类值”（如 scanner）生成，而引擎匹配的是原始 ua 字符串（如 python-requests/2.28），需改回匹配原始 ua 才生效'
  }
  if (r.evidenceKinds.includes('sqli')) {
    return "  ⚠ 未命中任何流量：注入特征在查询参数的“值”里，回放时 ? 之后会拆进 query 字段、path 只剩主干，故 path contains \"'--\" 匹配不到；需作用于 query.<参数名>（如 query.q contains \"'--\"，实测覆盖率 11.1%）"
  }
  return '  ⚠ 未命中任何流量'
}

async function main(): Promise<void> {
  // 1) 历史流量（ch21 自己的回放样本）
  const trafficFile = fileURLToPath(new URL('../traffic.sample.log', import.meta.url))
  const traffic = loadHistoricalTraffic(trafficFile)
  const bad = traffic.filter((t) => t.isBad).length
  console.log('=== 历史流量（回放样本）===')
  console.log(`请求数=${traffic.length}  该拦(bad)=${bad}  正常(good)=${traffic.length - bad}`)

  // 2) 从 ch20 的"长出候选"拿真实候选（演示 ch20→ch21 流水线）；再补一个"过宽"陷阱候选
  const evFile = fileURLToPath(new URL('../../ch20/access.sample.log', import.meta.url))
  const session = new ObserveSession()
  const obs = new Observer(session, { threshold: 2, perHourCap: 100, maxShare: 0.9 })
  const evidences = obs.observeOnce(evFile)
  const { candidates, raw: proposeRaw, usage: proposeUsage } = await proposeFromEvidence(evidences)
  // 模型可能把回复包进 markdown 代码围栏（```json … ```）：围栏只是格式包装、不是回复内容。
  // 剥掉再节选，否则 ```json 会提前结束文档里输出块的代码围栏。
  const proposeExcerpt = proposeRaw.replace(/^\s*```[a-zA-Z]*\s*\n?/, '').replace(/\s*```\s*$/, '')
  console.log(
    `（ch20 真实模型提案回复节选: ${proposeExcerpt.slice(0, 120)}…；token in=${proposeUsage.inputTokens} out=${proposeUsage.outputTokens}）`,
  )
  candidates.push({
    id: 'trap-1',
    name: 'block ua browser',
    action: 'deny',
    when: { field: 'ua', op: 'contains', value: 'Mozilla' }, // 过宽：命中所有浏览器流量
  })

  // 3) 评测三件事 + 事实校验
  console.log('\n=== 评测三件事（覆盖率 / 精确率 / 误伤率）+ 事实校验 ===')
  const results = candidates.map((c) => evaluate(c, traffic))
  for (const r of results) {
    console.log(
      `  ${r.candidateId} [${r.candidateName}] 覆盖率=${pct(r.coverage)} 精确率=${pct(r.precision)} 误伤率=${pct(r.falsePositiveRate)} 逆推=[${r.evidenceKinds.join(',')}] 事实校验=${r.factCheck.ok ? 'ok' : 'FAIL'}${weakHint(r)}`,
    )
  }

  // 4) 候选确认
  console.log('\n=== 候选确认（命名 / 意图 / 风险）===')
  candidates.forEach((c, i) => {
    const rep = confirmCandidate(c, results[i])
    console.log(
      `  ${c.id} [${c.name}] 命名=${rep.naming.pass ? 'ok' : 'FAIL'} 意图=${rep.intent.pass ? 'ok' : 'FAIL'} 风险=${rep.risk.pass ? 'ok' : 'FAIL'} → ${rep.pass ? '通过' : '不通过'}`,
    )
    if (!rep.pass) {
      const reason = !rep.naming.pass ? rep.naming.reason : !rep.intent.pass ? rep.intent.reason : rep.risk.reason
      console.log(`      · ${reason}`)
    }
  })

  // 5) 闭环：取一个确认通过的候选（仍来自真实模型提案，按确认结果定位、不依赖模型命名），演示健康推进
  const good = candidates.find((c, i) => confirmCandidate(c, results[i]).pass)
  if (!good) throw new Error('没有通过确认的候选，无法演示健康闭环')
  const goodConfirm = confirmCandidate(good, results[candidates.indexOf(good)])
  console.log('\n=== 闭环：shadow → 灰度 → active（自主级别 2，候选确认通过）===')
  const lc = new RuleLifecycle({ autonomyLevel: '2', fpThreshold: 0.02, staleHits: 3, promoteHits: 3 })
  console.log(`  初始: ${lc.init(goodConfirm.pass)}`)
  const goodHit = traffic.find((t) => wouldBlock(good, t.req))!
  // 演示用**同一条**请求重复 observe 3 次，模拟"累计命中 3 次"触发灰度转 active
  // （promoteHits=3）。真实系统里是 3 条**不同**请求流经时累计命中，不会重复同一条。
  for (let i = 0; i < 3; i++) {
    lc.observe(wouldBlock(good, goodHit.req), goodHit.isBad)
    console.log(`  observe(拦,${goodHit.isBad}) → ${lc.report()}`)
  }

  // 6) 老化演示：长期无命中 → aged_out
  // 用 noteIdle（后台任务的"滴答"）而不是 observe：真实后台任务不拦流量时走的是滴答，
  // 它只推进"连续无命中"计数、不把滴答当成真实正常观测计入误伤率分母（observe 会）。
  console.log('\n=== 闭环：老化（长期无命中）===')
  const lc2 = new RuleLifecycle({ autonomyLevel: '2', fpThreshold: 0.02, staleHits: 3, promoteHits: 3 })
  lc2.init(true)
  for (let i = 0; i < 3; i++) {
    lc2.noteIdle()
    console.log(`  tick（无命中）→ ${lc2.report()}`)
  }

  // 7) 自动回退演示：过宽候选在灰度期误伤超阈值 → rolled_back
  const trap = candidates.find((c) => c.id === 'trap-1')!
  console.log('\n=== 闭环：自动回退（过宽候选灰度期误伤超阈值）===')
  // minGoodTotal: 1 —— 让单条样本就能触发回退判定。默认门槛是 20（防单条噪声把仍在
  // 观察的规则判死），但这里演示的就是"一条误伤即回退"的止损路径，必须显式放宽门槛，
  // 否则 goodTotal=1 < 20，演示会停在 canary、名不副实。
  const lc3 = new RuleLifecycle({ autonomyLevel: '2', fpThreshold: 0.02, staleHits: 3, promoteHits: 3, minGoodTotal: 1 })
  lc3.init(false) // 风险未过 → 停在 shadow（级别 2 也要先走影子期）
  lc3.promote('canary') // 演示：由人推进到灰度——必须走转移表，不能直接改 stage 绕过确认
  // 喂一条被它误拦的正常请求 → 误伤率 100% → 自动回退守卫触发
  const goodReq = traffic.find((t) => !t.isBad)!.req
  lc3.observe(wouldBlock(trap, goodReq), false)
  console.log(`  误拦正常请求后: ${lc3.report()}`)

  // 8) 喂回：把"漏拦"喂回证据库——留下"上一轮漏了什么"的记录。
  // feedMissedToEvidence 返回喂回的证据本身（fed），下面第 9 步用它和原有证据合并，
  // 演示"上一轮漏的变成下一轮的候选"。
  console.log('\n=== 漏拦 → 喂回证据库 ===')
  const narrow: Candidate = {
    id: 'narrow-1',
    name: 'block admin only',
    action: 'deny',
    when: { field: 'path', op: 'eq', value: '/admin' },
  }
  // staleHits 调大：这条窄候选会漏掉样本里大部分异常，按默认 3 早就老化了；
  // 这里要看的是"漏掉的东西被喂回去"，不是老化（老化在上面单独演示过）。
  const lc4 = new RuleLifecycle({ autonomyLevel: '2', fpThreshold: 0.02, staleHits: 999, promoteHits: 3 })
  lc4.init(true)
  for (const t of traffic) lc4.observe(wouldBlock(narrow, t.req), t.isBad, t.line)
  const missed = lc4.getSignal().missedTrue
  const before = session.messages().length
  const fed = feedMissedToEvidence(session, lc4)
  console.log(`  窄候选（只拦 /admin）回放后: ${lc4.report()}`)
  console.log(`  漏拦 ${missed} 条 → 脱敏后喂回证据库 ${fed.length} 条`)
  console.log(`  证据库: ${before} 条 → ${session.messages().length} 条`)
  for (const m of session.messages().slice(before).slice(0, 2)) {
    console.log(`    user: ${m.content.slice(0, 88)}…`)
  }
  // drain 语义：同一批漏拦不会被每轮重复喂回（否则这一条越积越多，把别的信号全挤掉）
  console.log(`  再喂一次: ${feedMissedToEvidence(session, lc4).length} 条（drain 后不再重复）`)

  // 9) 下一轮提案：把"喂回的证据"和原有证据合并，再跑一次提案——
  // 上一轮漏掉的 /wp-admin、/etc/passwd 等探测，这一轮模型看见了，长出覆盖它们的候选。
  console.log('\n=== 喂回 → 下一轮提案（漏掉的异常请求变成候选）===')
  const nextEvidence = [...evidences, ...fed]
  const { candidates: nextCandidates, usage: nextUsage } = await proposeFromEvidence(nextEvidence)
  console.log(
    `  下一轮提案输入 ${nextEvidence.length} 条证据（原 ${evidences.length} 条 + 喂回 ${fed.length} 条）；token in=${nextUsage.inputTokens} out=${nextUsage.outputTokens}`,
  )
  for (const c of nextCandidates) {
    const r = evaluate(c, traffic)
    console.log(
      `  ${c.id} [${c.name}] 覆盖率=${pct(r.coverage)} 精确率=${pct(r.precision)} 误伤率=${pct(r.falsePositiveRate)}`,
    )
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
