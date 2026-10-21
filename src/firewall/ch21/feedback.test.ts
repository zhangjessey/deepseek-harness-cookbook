// src/firewall/ch21/feedback.test.ts —— 喂回（跨轮进化闭环最后一环）的测试
//
// 要钉住四件事：
//  1. 漏拦的坏请求确实被喂回证据库，且每条都带正确的异常类别；
//  2. drain 语义——喂过一次就不再重复（否则同一条会被每轮重复喂回，挤掉别的信号）；
//  3. 喂回的是**脱敏后**的证据，原始 ip / 原始 UA 不进证据；
//  4. 只喂漏拦，误伤不混入（误伤另有自动回退当场止损）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { ObserveSession } from '../ch20/observe'
import { RuleLifecycle } from './loop'
import { loadHistoricalTraffic, wouldBlock } from './evaluate'
import { feedMissedToEvidence } from './feedback'
import type { Candidate } from '../ch20/propose'

const trafficFile = fileURLToPath(new URL('traffic.sample.log', import.meta.url))

/**
 * 测试专用配置：`staleHits` 故意调得很大，是为了不让"连续无命中 → 老化"把回放中途截断。
 *
 * 样本前 10 条全是正常请求，按默认的 3 回放不到第 4 条规则就已经 aged_out（终态），
 * 后面漏掉的坏请求一条也记不进信号。本文件验的是**喂回**，不是老化
 * （老化在 loop.test.ts 里有专项测试），所以这里把老化这个变量隔离掉。
 */
const cfg = { autonomyLevel: '2' as const, fpThreshold: 0.02, staleHits: 999 }

const cand = (id: string, name: string, when: Candidate['when']): Candidate => ({ id, name, action: 'deny', when })

/** 只拦 /admin 的窄候选——样本里其余异常会被它全部漏掉。 */
const narrow = cand('narrow-1', 'block admin only', { field: 'path', op: 'eq', value: '/admin' })

/** 只拦正常请求 /api/health 的"反向"候选——制造误伤，且不拦任何坏请求。 */
const wrongTarget = cand('wrong-1', 'block health', { field: 'path', op: 'eq', value: '/api/health' })

test('喂回：漏拦的坏请求被喂回证据库，每条都带异常类别', () => {
  const traffic = loadHistoricalTraffic(trafficFile)
  const lc = new RuleLifecycle(cfg)
  assert.equal(lc.init(true), 'canary', '级别 2 且关卡已过 → 直接灰度')

  for (const t of traffic) lc.observe(wouldBlock(narrow, t.req), t.isBad, t.line)

  const missed = traffic.filter((t) => !wouldBlock(narrow, t.req) && t.isBad)
  assert.ok(missed.length > 0, '窄候选确实漏掉了一些坏请求')
  assert.equal(lc.getSignal().missedTrue, missed.length, '放过计数应等于漏拦条数')

  const session = new ObserveSession()
  const injected = feedMissedToEvidence(session, lc)
  assert.equal(injected.length, missed.length, '每条漏拦都应注入一条证据')
  assert.equal(session.messages().length, missed.length)

  // 每条证据都得带 kind——没有类别的证据对提案毫无用处
  for (const m of session.messages()) {
    assert.match(m.content, /异常证据\[(path-probe|sqli|bad-ua)\]/, `证据必须带类别，实际：${m.content}`)
  }
})

test('喂回：drain 语义——喂过一次就不再重复喂', () => {
  const traffic = loadHistoricalTraffic(trafficFile)
  const lc = new RuleLifecycle(cfg)
  lc.init(true)
  for (const t of traffic) lc.observe(wouldBlock(narrow, t.req), t.isBad, t.line)

  const session = new ObserveSession()
  const first = feedMissedToEvidence(session, lc)
  assert.ok(first.length > 0, '第一次确实喂回了')

  // 再喂两次：同一批漏拦不能被重复喂回，否则证据库里这一条越积越多、
  // 把别的信号全挤掉（第 20 讲抗挤占采样要防的正是这个）
  assert.equal(feedMissedToEvidence(session, lc).length, 0, 'drain 之后不应再喂出东西')
  assert.equal(feedMissedToEvidence(session, lc).length, 0)
  assert.equal(session.messages().length, first.length, '证据数不应因重复调用而增长')
})

test('喂回：脱敏证据，原始 ip 与原始 UA 都不进证据', () => {
  const traffic = loadHistoricalTraffic(trafficFile)
  const lc = new RuleLifecycle(cfg)
  lc.init(true)
  for (const t of traffic) lc.observe(wouldBlock(narrow, t.req), t.isBad, t.line)

  const session = new ObserveSession()
  feedMissedToEvidence(session, lc)
  assert.ok(session.messages().length > 0)

  const all = session
    .messages()
    .map((m) => m.content)
    .join('\n')
  for (const t of traffic.filter((x) => x.isBad)) {
    assert.ok(!all.includes(t.line.ip), `原始 ip ${t.line.ip} 不应出现在证据里`)
    if (t.line.ua) assert.ok(!all.includes(t.line.ua), `原始 UA ${t.line.ua} 不应出现在证据里`)
    // 但有归类值可聚合
    assert.match(all, /uaClass=(scanner|script|browser|empty)/, '应保留 UA 归类值')
  }
})

test('喂回：只喂漏拦，误伤不混入（误伤由自动回退当场止损）', () => {
  const traffic = loadHistoricalTraffic(trafficFile)
  const lc = new RuleLifecycle(cfg)
  lc.init(true)
  for (const t of traffic) lc.observe(wouldBlock(wrongTarget, t.req), t.isBad, t.line)

  // 这个候选拦了正常请求 → 有误伤；同时一个坏请求都没拦 → 漏拦 = 全部坏请求
  assert.equal(lc.getSignal().falsePositives, 1, '拦了 /api/health（正常请求）应记一次误伤')
  const missedCount = traffic.filter((t) => t.isBad).length
  assert.equal(lc.getSignal().missedTrue, missedCount, '一个坏请求都没拦住')

  const session = new ObserveSession()
  const injected = feedMissedToEvidence(session, lc)
  assert.equal(injected.length, missedCount, '注入条数应等于漏拦条数')

  // 关键：被误伤的那条正常请求不能作为"异常证据"被喂回去
  const all = session
    .messages()
    .map((m) => m.content)
    .join('\n')
  assert.ok(!all.includes('/api/health'), '被误伤的正常请求不该被当成异常喂回')
})
