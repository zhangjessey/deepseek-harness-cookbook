// src/firewall/ch21/evaluate.test.ts —— 评测（覆盖/精确/误伤、逆推证据、事实校验）的单元测试
//
// 覆盖"候选真能拦吗"的确定性部分：历史流量回放、覆盖/精确/误伤三指标、
// 从候选逆推证据类别、事实校验、历史流量加载与 Oracle 标注。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Condition } from '../ch18/types'
import type { Candidate } from '../ch20/propose'
import { evaluate, loadHistoricalTraffic, reverseEvidenceKinds, wouldBlock, type TrafficItem } from './evaluate'

// 入参收 unknown 是故意的：评测要能处理模型产出的任意形状，非法形状由上层校验拦住。
const cand = (when: unknown): Candidate => ({
  id: 'c1',
  name: 'block x',
  action: 'deny',
  when: when as Condition,
})

const req = (path: string): TrafficItem['req'] => ({ method: 'GET', path, headers: {}, ip: '1.2.3.4', ua: 'u' })

test('reverseEvidenceKinds：ua → bad-ua，path 含引号 → sqli，path 其他 → path-probe', () => {
  assert.deepEqual(reverseEvidenceKinds(cand({ field: 'ua', op: 'eq', value: 'python' })), ['bad-ua'])
  assert.deepEqual(reverseEvidenceKinds(cand({ field: 'path', op: 'contains', value: "'--" })), ['sqli'])
  assert.deepEqual(reverseEvidenceKinds(cand({ field: 'path', op: 'starts_with', value: '/admin' })), ['path-probe'])
})

test('evaluate：覆盖 / 精确 / 误伤全命中', () => {
  const traffic: TrafficItem[] = [
    { req: req('/admin'), isBad: true },
    { req: req('/admin'), isBad: true },
    { req: req('/ok'), isBad: false },
  ]
  const r = evaluate(cand({ field: 'path', op: 'starts_with', value: '/admin' }), traffic)
  assert.equal(r.totalBad, 2)
  assert.equal(r.caughtBad, 2)
  assert.equal(r.coverage, 1)
  assert.equal(r.caughtGood, 0)
  assert.equal(r.precision, 1)
  assert.equal(r.falsePositiveRate, 0)
  assert.equal(r.factCheck.ok, true)
})

test('evaluate：误伤拉低精确率、推高误伤率', () => {
  const traffic: TrafficItem[] = [
    { req: req('/admin'), isBad: true },
    { req: req('/admin'), isBad: false }, // 拦了一条正常请求 → 误伤
  ]
  const r = evaluate(cand({ field: 'path', op: 'starts_with', value: '/admin' }), traffic)
  assert.equal(r.caughtBad, 1)
  assert.equal(r.caughtGood, 1)
  assert.equal(r.precision, 0.5)
  assert.equal(r.falsePositiveRate, 1)
})

test('evaluate：空 traffic 除零安全', () => {
  const r = evaluate(cand({ field: 'path', op: 'eq', value: '/x' }), [])
  assert.equal(r.total, 0)
  assert.equal(r.coverage, 0)
  assert.equal(r.precision, 0)
  assert.equal(r.falsePositiveRate, 0)
  assert.equal(r.factCheck.ok, true)
})

test('wouldBlock：候选是否拦下这条请求', () => {
  const c = cand({ field: 'path', op: 'eq', value: '/admin' })
  assert.equal(wouldBlock(c, req('/admin')), true)
  assert.equal(wouldBlock(c, req('/ok')), false)
})

test('loadHistoricalTraffic：读日志并用 ch20 检测器作 Oracle 标注', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-'))
  const file = join(dir, 'traffic.log')
  const nginx = (p: string): string =>
    `1.2.3.4 - - [10/Oct/2026:12:00:00 +0000] "GET ${p} HTTP/1.1" 403 1024 "-" "Mozilla/5.0" "-"`
  writeFileSync(file, [nginx('/admin'), nginx('/ok')].join('\n') + '\n')

  const items = loadHistoricalTraffic(file)
  assert.equal(items.length, 2)
  assert.equal(items[0]?.isBad, true, '/admin 被检测器判为异常')
  assert.equal(items[1]?.isBad, false, '/ok 正常')
  rmSync(dir, { recursive: true, force: true })
})

test('loadHistoricalTraffic：文件不存在返回空', () => {
  assert.deepEqual(loadHistoricalTraffic('/nonexistent-traffic.log'), [])
})

test('回放请求不再被压成空壳：query 从 URI 拆出，query.<name> 类候选能命中', () => {
  // 原实现把 URI 整段（含 ?role=admin）当作 path、query 恒为空，于是 query.role 类候选
  // 永远匹配不上 → 覆盖恒为 0 → 会被误判成"拦不住任何东西的规则"。
  const dir = mkdtempSync(join(tmpdir(), 'eval-q-'))
  try {
    const file = join(dir, 'access.log')
    const line = (p: string): string =>
      `1.2.3.4 - - [10/Oct/2026:12:00:00 +0000] "GET ${p} HTTP/1.1" 403 1 "-" "Mozilla/5.0" "-"`
    writeFileSync(file, [line('/admin?role=admin'), line('/admin?role=guest')].join('\n') + '\n')
    const traffic = loadHistoricalTraffic(file)
    assert.equal(traffic.length, 2, '两行都被检出（/admin 前缀）')
    const r = evaluate(cand({ field: 'query.role', op: 'eq', value: 'admin' }), traffic)
    assert.equal(r.caughtBad, 1, 'query.role=admin 只命中第一条（query 若没拆出来这里会是 0）')
    assert.equal(r.totalBad, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('依赖样本提供不了的字段（body）时，标为"无法评估"，不是"命中 0 = 无用"', () => {
  const traffic: TrafficItem[] = [
    { req: req('/admin'), isBad: true },
    { req: req('/ok'), isBad: false },
  ]
  const r = evaluate(cand({ field: 'body', op: 'contains', value: 'x' }), traffic)
  // 访问日志不记请求体：这个样本**评不了**这条候选。若当成"命中 0"，风险关卡会
  // 判它"拦不住任何东西"而拒绝——那是误杀，所以必须走"样本不足"。
  assert.equal(r.caughtBad, 0)
  assert.equal(r.sampleSufficient, false, '样本无法评估时必须标为不足')
  assert.deepEqual(r.unassessableFields, ['body'], '并说明是哪个字段评不了')
})

test('EvalResult 声明 Oracle 来源（避免把"复现度"误读成真实防护效果）', () => {
  // Oracle 是 ch20 的启发式检测器，而候选正是从它长出来的——存在**自证**：
  // 一条比检测器更准（抓到检测器漏掉的攻击）的规则会被记成误伤。
  // 所以结果里必须写清 Oracle 是谁，让调用方知道这个局限。
  const r = evaluate(cand({ field: 'path', op: 'starts_with', value: '/admin' }), [
    { req: req('/admin'), isBad: true },
    { req: req('/ok'), isBad: false },
  ])
  assert.ok(r.oracle.includes('ch20'), `oracle 应说明来源，实际：${r.oracle}`)
  assert.ok(r.oracle.includes('复现度'), '应点明这是复现度，不是独立 ground truth')
})

test('证据逆推：组合型候选能同时覆盖多个类别', () => {
  // 以前只看"顶层 field"，组合候选会被归成单一类别（或 unknown），
  // 于是漏掉它真正覆盖的那一类。
  const both = {
    and: [
      { field: 'ua', op: 'contains', value: 'scanner' },
      { field: 'path', op: 'contains', value: "'--" },
    ],
  }
  assert.deepEqual(reverseEvidenceKinds(cand(both)).sort(), ['bad-ua', 'sqli'])
})
