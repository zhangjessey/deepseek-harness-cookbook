// src/firewall/ch21/demo/rule-eval-demo.ts —— cli / 可运行入口（对应脚本 npm run start:ch21）
//
// 演示 ch20→ch21 的流水线：ch20 长出候选 → ch21 评测三件事 → 确认三关卡 → 闭环（shadow/灰度/active/老化/自动回退）。
// 需要 DEEPSEEK_API_KEY：候选由 ch20 的真实模型提案生成；评测/确认/闭环为确定性代码（关卡写进工具代码）。
import { fileURLToPath } from 'node:url'
import { Observer, ObserveSession } from '../../ch20/observe'
import { proposeFromEvidence } from '../../ch20/propose'
import { evaluate, loadHistoricalTraffic, wouldBlock } from '../evaluate'
import { confirmCandidate } from '../confirm'
import { RuleLifecycle } from '../loop'

function pct(x: number): string {
  return (x * 100).toFixed(1) + '%'
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
  console.log(
    `（ch20 真实模型提案回复节选: ${proposeRaw.slice(0, 120)}…；token in=${proposeUsage.inputTokens} out=${proposeUsage.outputTokens}）`,
  )
  candidates.push({
    id: 'trap-1',
    name: 'block ua browser',
    action: 'deny',
    when: { field: 'ua', op: 'contains', value: 'Mozilla' }, // 过宽：命中所有浏览器流量
  })

  // 3) 评测三件事 + 事实校验
  console.log('\n=== 评测三件事（覆盖 / 精确 / 误伤）+ 事实校验 ===')
  const results = candidates.map((c) => evaluate(c, traffic))
  for (const r of results) {
    const weak =
      r.caughtBad + r.caughtGood === 0
        ? '  ⚠ 未命中任何流量：该候选的 when 按"归类值"生成，需改回匹配原始 ua（如 ua contains）才生效'
        : ''
    console.log(
      `  ${r.candidateId} [${r.candidateName}] 覆盖=${pct(r.coverage)} 精确=${pct(r.precision)} 误伤率=${pct(r.falsePositiveRate)} 逆推=[${r.evidenceKinds.join(',')}] 事实校验=${r.factCheck.ok ? 'ok' : 'FAIL'}${weak}`,
    )
  }

  // 4) 确认三关卡
  console.log('\n=== 确认三关卡（命名 / 意图 / 风险）===')
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

  // 5) 闭环：取一个三关卡全过的候选（仍来自真实模型提案，按确认结果定位、不依赖模型命名），演示健康推进
  const good = candidates.find((c, i) => confirmCandidate(c, results[i]).pass)
  if (!good) throw new Error('没有通过三关卡的候选，无法演示健康闭环')
  const goodConfirm = confirmCandidate(good, results[candidates.indexOf(good)])
  console.log('\n=== 闭环：shadow → 灰度 → active（自主级别 2，候选三关卡全过）===')
  const lc = new RuleLifecycle({ autonomyLevel: '2', fpThreshold: 0.02, staleHits: 3 })
  console.log(`  初始: ${lc.init(goodConfirm.pass)}`)
  const goodHit = traffic.find((t) => wouldBlock(good, t.req))!
  for (let i = 0; i < 3; i++) {
    lc.observe(wouldBlock(good, goodHit.req), goodHit.isBad)
    console.log(`  observe(拦,${goodHit.isBad}) → ${lc.report()}`)
  }

  // 6) 老化演示：长期无命中 → aged_out
  // 用 noteIdle（后台任务的"滴答"）而不是 observe：真实后台任务不拦流量时走的是滴答，
  // 它只推进"连续无命中"计数、不把滴答当成真实正常观测计入误伤率分母（observe 会）。
  console.log('\n=== 闭环：老化（长期无命中）===')
  const lc2 = new RuleLifecycle({ autonomyLevel: '2', fpThreshold: 0.02, staleHits: 3 })
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
  const lc3 = new RuleLifecycle({ autonomyLevel: '2', fpThreshold: 0.02, staleHits: 3, minGoodTotal: 1 })
  lc3.init(false) // 风险未过 → 停在 shadow（级别 2 也要先走影子期）
  lc3.promote('canary') // 演示：由人推进到灰度——必须走转移表，不能直接改 stage 绕过关卡
  // 喂一条被它误拦的正常请求 → 误伤率 100% → 自动回退守卫触发
  const goodReq = traffic.find((t) => !t.isBad)!.req
  lc3.observe(wouldBlock(trap, goodReq), false)
  console.log(`  误拦正常请求后: ${lc3.report()}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
