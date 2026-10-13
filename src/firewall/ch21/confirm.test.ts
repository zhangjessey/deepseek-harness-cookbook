// src/firewall/ch21/confirm.test.ts —— 确认三关卡（命名/意图/风险）的单元测试
//
// 覆盖"候选转正前过三关"的确定性部分：命名可读、意图与 when 对齐、风险可控，
// 以及三关合成。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Condition } from '../ch18/types'
import type { Candidate } from '../ch20/propose'
import { checkIntent, checkNaming, checkRisk, confirmCandidate } from './confirm'
import type { EvalResult } from './evaluate'

/**
 * 入参收 `unknown` 是**故意**的：关卡存在的意义就是在运行时拒掉结构上非法的候选，
 * 所以测试必须能构造出这种候选——传非法形状时相当于"类型上撒谎"，由关卡的运行时判断兜住。
 */
const cand = (name: string, when: unknown): Candidate => ({
  id: 'c1',
  name,
  action: 'deny',
  when: when as Condition,
})

// 一份"样本充足"的评测结果：19 条回放 = 9 条该拦 + 10 条正常（与 traffic.sample.log 一致）。
// sampleSufficient 必须显式为真——样本不足时误伤率算出来是 0.0%，但那不是"没误伤"。
const evalOk: EvalResult = {
  candidateId: 'c1',
  candidateName: 'x',
  total: 19,
  totalBad: 9,
  totalGood: 10,
  caughtBad: 3,
  caughtGood: 0,
  coverage: 3 / 9,
  precision: 1,
  falsePositiveRate: 0,
  evidenceKinds: ['path-probe'],
  sampleSufficient: true,
  oracle: '测试用 Oracle 说明',
  factCheck: { ok: true, note: '' },
}

test('checkNaming：自动 id 样式拒绝（需人命名）', () => {
  assert.equal(checkNaming(cand('cand-1', {})).pass, false)
  assert.equal(checkNaming(cand('rule-2', {})).pass, false)
})

test('checkNaming：过短拒绝、可读通过', () => {
  assert.equal(checkNaming(cand('ab', {})).pass, false)
  assert.equal(checkNaming(cand('block admin', {})).pass, true)
})

test('checkIntent：sqli 名字须真对注入特征', () => {
  assert.equal(checkIntent(cand('block sqli', { field: 'path', op: 'contains', value: "'--" })).pass, true)
  assert.equal(checkIntent(cand('block sqli', { field: 'path', op: 'starts_with', value: '/admin' })).pass, false)
})

test('checkIntent：ua 名字须作用于 ua 字段', () => {
  assert.equal(checkIntent(cand('block ua scanner', { field: 'ua', op: 'eq', value: 'python' })).pass, true)
  assert.equal(checkIntent(cand('block ua scanner', { field: 'path', op: 'eq', value: '/x' })).pass, false)
})

test('checkIntent：path 类名字须作用于 path 字段', () => {
  assert.equal(checkIntent(cand('block admin probe', { field: 'path', op: 'starts_with', value: '/admin' })).pass, true)
})

test('checkIntent：名字未体现可识别意图拒绝', () => {
  assert.equal(checkIntent(cand('do something', { field: 'path', op: 'eq', value: '/x' })).pass, false)
})

test('checkRisk：误伤率过高拒绝', () => {
  const high = { ...evalOk, falsePositiveRate: 0.05 }
  assert.equal(checkRisk(cand('block x', { field: 'path', op: 'eq', value: '/x' }), high).pass, false)
})

test('checkRisk：命中 0 次的候选拒绝（覆盖 0% 不代表"零误伤"，只代表什么都没拦）', () => {
  // demo 里的 cand-7（ua eq 'scanner'）正是这种：覆盖率 0.0%、命中 0 次，却曾三关全过
  // 并被当作"健康推进"送进灰度。一条拦不住任何东西的规则没有任何价值，
  // 它"零误伤"只是因为一次都没生效。
  const zero: EvalResult = { ...evalOk, caughtBad: 0, caughtGood: 0, coverage: 0, precision: 0 }
  const r = checkRisk(cand('block ua scanner', { field: 'ua', op: 'eq', value: 'scanner' }), zero)
  assert.equal(r.pass, false, '命中 0 次必须拒绝')
  assert.ok(r.reason.includes('命中 0 次'), `拒绝理由应说明命中 0 次，实际：${r.reason}`)
  // 整条确认链路也因此不通过
  assert.equal(
    confirmCandidate(cand('block ua scanner', { field: 'ua', op: 'eq', value: 'scanner' }), zero).pass,
    false,
    '命中 0 次的候选不得转正',
  )
})

test('checkRisk：作用域过宽（单字符包含）拒绝', () => {
  const broad = cand('block x', { field: 'path', op: 'contains', value: '/' })
  assert.equal(checkRisk(broad, evalOk).pass, false)
})

test('checkRisk：样本不足拒绝（不让"无数据"冒充 0% 误伤）', () => {
  // 样本里没有正常流量时，误伤率算出来是 0.0%。若据此放行，一条会拦掉全部正常请求的
  // 候选（demo 里 trap-1 那种误伤 100%）反而能"确定性地"通过风险关卡——
  // 这是最危险的失败形态：样本路径一配错，所有候选都自动转正。
  const empty: EvalResult = {
    ...evalOk,
    total: 0,
    totalBad: 0,
    totalGood: 0,
    caughtBad: 0,
    caughtGood: 0,
    sampleSufficient: false,
  }
  const trap = cand('block ua browser', { field: 'ua', op: 'contains', value: 'Mozilla' })
  const r = checkRisk(trap, empty)
  assert.equal(r.pass, false, '样本不足必须拒绝')
  assert.ok(r.reason.includes('样本不足'), `拒绝理由应说明样本不足，实际：${r.reason}`)
})

test('confirmCandidate：三关合成（全过 / 任一不过）', () => {
  assert.equal(
    confirmCandidate(cand('block admin', { field: 'path', op: 'starts_with', value: '/admin' }), evalOk).pass,
    true,
  )
  assert.equal(confirmCandidate(cand('cand-1', { field: 'path', op: 'eq', value: '/x' }), evalOk).pass, false)
})

test('checkIntent 按词匹配：manual / guard 不会被误判成 ua 类', () => {
  // 子串匹配时 "block manual probe" 里含 "ua"（man**ua**l），会被要求作用于 ua 字段 → 误杀。
  // 同理 "guard" 含 "ua"。改成按词匹配后这类合法候选不会被错杀。
  // "manual" 里含 "ua"：子串匹配时会被要求作用于 ua 字段 → 这条合法候选被误杀。
  assert.equal(
    checkIntent(cand('block manual probe', { field: 'path', op: 'starts_with', value: '/admin' })).pass,
    true,
  )
  // "guard" 同样含 "ua"：它确实不体现已知意图（所以仍不通过），但**不该**是因为被当成 ua 类。
  const guard = checkIntent(cand('block guard rail', { field: 'ua', op: 'eq', value: 'x' }))
  assert.equal(guard.pass, false, 'guard rail 本就不体现已知意图')
  assert.ok(!guard.reason.includes('ua'), `guard 不该被判成 ua 类，实际理由：${guard.reason}`)
  // 真正点名 ua 的仍要作用于 ua 字段
  assert.equal(checkIntent(cand('block ua scanner', { field: 'ua', op: 'eq', value: 'python' })).pass, true)
  assert.equal(checkIntent(cand('block ua scanner', { field: 'path', op: 'eq', value: '/x' })).pass, false)
})

test('checkIntent：ip / method / body 类名字也要对齐对应字段', () => {
  // 原先只认 sqli / ua / path 三类，ip、method、body 类候选**无条件被拒**。
  assert.equal(checkIntent(cand('block suspicious ip', { field: 'ip', op: 'eq', value: '1.2.3.4' })).pass, true)
  assert.equal(checkIntent(cand('block put method', { field: 'method', op: 'eq', value: 'PUT' })).pass, true)
  assert.equal(checkIntent(cand('block evil body', { field: 'body', op: 'contains', value: 'x' })).pass, true)
  assert.equal(
    checkIntent(cand('block suspicious ip', { field: 'path', op: 'eq', value: '/x' })).pass,
    false,
    '名为 ip 却作用于 path → 拒',
  )
})

test('误伤率过高时，理由要提示"可能只是比检测器更准"（Oracle 自证的局限）', () => {
  const high = { ...evalOk, falsePositiveRate: 0.05 }
  const r = checkRisk(cand('block x', { field: 'path', op: 'eq', value: '/x' }), high)
  assert.equal(r.pass, false)
  assert.ok(r.reason.includes('比检测器更准'), `误伤理由必须提示 Oracle 局限，实际：${r.reason}`)
})

test('意图关卡：组合型候选也能正确判断（不会因顶层没有 field 而被误杀）', () => {
  // 以前直接读 `w.field`，对 and / or 结构拿到的是 **undefined** → 恒判"未对齐"
  // → 把所有组合型候选都误杀了。改成走 leavesOf 后，内层叶子能被看到。
  const onPath = { and: [{ field: 'path', op: 'starts_with', value: '/admin' }] }
  assert.equal(checkIntent(cand('block admin probe', onPath)).pass, true, '组合里的 path 叶子要被看到')

  const sqli = {
    and: [
      { field: 'path', op: 'contains', value: "'--" },
      { field: 'method', op: 'eq', value: 'POST' },
    ],
  }
  assert.equal(checkIntent(cand('block sqli', sqli)).pass, true, '组合里的 sqli 特征要被看到')

  // 组合里没有任何叶子对齐名字声称的字段 —— 仍然要拒
  const mismatch = { and: [{ field: 'ua', op: 'contains', value: 'x' }] }
  assert.equal(checkIntent(cand('block admin probe', mismatch)).pass, false, '组合里没有 path 叶子 → 拒')
})

test('风险关卡：组合型候选的内层过宽条件也要被看到', () => {
  // 只看"顶层 field"会漏掉内层的 `path contains "/"`。
  const broad = {
    and: [
      { field: 'path', op: 'contains', value: '/' },
      { field: 'method', op: 'eq', value: 'GET' },
    ],
  }
  const r = checkRisk(cand('block everything', broad), evalOk)
  assert.equal(r.pass, false, '内层过宽也要拦')
  assert.ok(r.reason.includes('作用域过宽'))
})
