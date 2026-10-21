// src/firewall/ch21/pipeline.e2e.test.ts —— 真模型端到端测试（需 DEEPSEEK_API_KEY）
//
// 完整流水线：ch20 真模型长出候选 → ch21 评测（覆盖率/精确率/误伤率 + 事实校验）→
// 候选确认 → 闭环推进。候选来自真模型，评测/确认/闭环为确定性代码。
// 断言钉契约：候选非空、评测事实校验自洽、至少一个候选通过候选确认、
// 且该候选在闭环中能推进到 active（在能命中历史流量的前提下）。
//
// 无 DEEPSEEK_API_KEY 时整组跳过。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { ObserveSession, Observer } from '../ch20/observe'
import { proposeFromEvidence } from '../ch20/propose'
import { evaluate, loadHistoricalTraffic, wouldBlock } from './evaluate'
import { confirmCandidate } from './confirm'
import { RuleLifecycle } from './loop'

const skip = !process.env.DEEPSEEK_API_KEY

test('真模型候选 → 评测 → 候选确认 → 闭环推进（完整流水线）', { skip }, async () => {
  // ch20：真模型长出候选
  const evFile = fileURLToPath(new URL('../ch20/access.sample.log', import.meta.url))
  const obs = new Observer(new ObserveSession(), { threshold: 2, perHourCap: 100, maxShare: 0.9 })
  const evidences = obs.observeOnce(evFile)
  const { candidates } = await proposeFromEvidence(evidences)
  assert.ok(candidates.length > 0, '真模型长出候选')

  // ch21：评测（确定性，复用 ch18 引擎回放）
  const trafficFile = fileURLToPath(new URL('traffic.sample.log', import.meta.url))
  const traffic = loadHistoricalTraffic(trafficFile)
  assert.ok(traffic.length > 0, '历史流量已加载')
  const results = candidates.map((c) => evaluate(c, traffic))
  for (const r of results) {
    assert.equal(r.factCheck.ok, true, `候选 ${r.candidateName} 评测事实校验自洽`)
  }

  // 候选确认：至少一个候选通过（否则模型产物无法进入闭环，属产品失败）
  const idx = candidates.findIndex((c, i) => confirmCandidate(c, results[i]!).pass)
  assert.ok(idx >= 0, '至少一个候选通过候选确认')

  // 闭环：通过候选确认的候选在级别 2 下推进到 active
  const good = candidates[idx]!
  const conf = confirmCandidate(good, results[idx]!)
  const lc = new RuleLifecycle({ autonomyLevel: '2', fpThreshold: 0.02, staleHits: 3 })
  assert.equal(lc.init(conf.pass), 'canary', '候选确认全过且级别 2 → 直接灰度')
  const hit = traffic.find((t) => wouldBlock(good, t.req))
  if (hit) {
    for (let i = 0; i < 3; i++) lc.observe(wouldBlock(good, hit.req), hit.isBad)
    assert.equal(lc.getStage(), 'active', '命中达标后转 active')
  }
})
