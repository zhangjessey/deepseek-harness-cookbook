// src/firewall/ch20/propose.test.ts —— 候选校验的单元测试
//
// 覆盖"候选由模型长出后，先过两阶段校验"的确定性部分：
// 结构校验（action=deny + when 是条件树）、语义校验（空匹配拒绝）、盲区声明。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isRetryable,
  isValidCondition,
  proposeFromEvidence,
  validateStage1,
  validateStage2,
  type Candidate,
} from './propose'
import type { Condition } from '../ch18/types'
import { LlmError } from '../shared/llm.ts'

/**
 * 构造候选。入参收 `unknown` 是**故意**的：校验器存在的意义就是能在运行时拒掉结构上非法
 * 的候选（模型输出本来就是不可信的 unknown），所以测试必须能构造出这种候选。
 * 这里显式 `as Condition` 相当于"类型上撒谎"，由 validateStage1 / 阶段2 的运行时校验兜住
 * ——也正是这些测试要验证的东西。
 */
const cand = (when: unknown, action: Candidate['action'] = 'deny'): Candidate => ({
  id: 'cand-x',
  name: 'block x',
  action,
  when: when as Condition,
})

test('isValidCondition：叶子 / and / or / not 合法', () => {
  assert.ok(isValidCondition({ field: 'path', op: 'starts_with', value: '/admin' }))
  assert.ok(isValidCondition({ and: [{ field: 'path', op: 'eq', value: '/a' }] }))
  assert.ok(isValidCondition({ or: [{ field: 'ua', op: 'contains', value: 'python' }] }))
  assert.ok(isValidCondition({ not: { field: 'ip', op: 'eq', value: '1.2.3.4' } }))
})

test('isValidCondition：未知字段拒绝（只查"有没有 field/op 键"是拦不住的）', () => {
  // 未知字段让取值返回 undefined：ne 恒真（命中一切 → 全站 403）、eq/contains 恒假
  // （规则永不生效 → 全放行）。两种都是静默失效，必须在校验阶段拒掉。
  assert.ok(!isValidCondition({ field: 'nope', op: 'ne', value: 1 }))
  assert.ok(!isValidCondition({ field: 'header.', op: 'eq', value: 'x' }), '空的 header. 名也要拒')
  assert.ok(isValidCondition({ field: 'header.X-Forwarded-For', op: 'eq', value: '1.2.3.4' }))
})

test('isValidCondition：value 形状不符算子拒绝', () => {
  assert.ok(!isValidCondition({ field: 'path', op: 'eq' }), 'eq 缺 value')
  assert.ok(!isValidCondition({ field: 'path', op: 'matches', value: 1 }), 'matches 的 value 必须是字符串')
  assert.ok(!isValidCondition({ field: 'path', op: 'in', value: 'x' }), 'in 的 value 必须是数组')
})

test('validateStage2：形状合法但语义上"拒绝一切"的候选被拒', () => {
  // 静态可判的三类：空 and 的 every 是真空真、空串包含恒真、exists 恒真。
  // 注：`not` 里"取反后几乎命中全部"（如 not(eq '/某冷门路径')）取决于该值是否出现在真实
  // 流量中，静态判不了——那类要靠回放命中率判定，属于 ch21 评测的职责。
  const all = [{ and: [] }, { field: 'path', op: 'contains', value: '' }, { field: 'path', op: 'exists' }]
  for (const when of all) {
    assert.equal(validateStage2(cand(when)).ok, false, `${JSON.stringify(when)} 必须被拒`)
  }
})

test('validateStage2：when 为 null 不抛异常（模型返回畸形输出时不打挂整条链）', () => {
  const r = validateStage2(cand(null))
  assert.equal(r.ok, false)
  assert.ok(r.notes.some((n) => n.includes('结构不合法')))
  assert.equal(validateStage2(cand('a string' as unknown)).ok, false)
})

test('isValidCondition：非法结构拒绝', () => {
  assert.ok(!isValidCondition(null))
  assert.ok(!isValidCondition('string'))
  assert.ok(!isValidCondition({}))
  assert.ok(!isValidCondition({ field: 'a' })) // 缺 op
})

test('validateStage1：action=deny 且 when 合法才通过', () => {
  assert.ok(validateStage1(cand({ field: 'path', op: 'eq', value: '/a' })))
  assert.ok(!validateStage1(cand({ field: 'path', op: 'eq' }, 'allow' as Candidate['action'])), 'allow 拒绝')
  assert.ok(!validateStage1(cand({})), 'when 非法拒绝')
})

test('validateStage2：空匹配全部请求的候选（op=exists）拒绝', () => {
  const r = validateStage2(cand({ field: 'path', op: 'exists' }))
  assert.equal(r.ok, false)
  assert.ok(
    r.notes.some((n) => n.includes('空匹配')),
    '语义校验标记空匹配',
  )
})

test('validateStage2：合法候选通过', () => {
  const r = validateStage2(cand({ field: 'path', op: 'starts_with', value: '/admin' }))
  assert.equal(r.ok, true)
})

test('validateStage2：盲区声明始终存在（自查发现不了过窄）', () => {
  const r = validateStage2(cand({ field: 'path', op: 'starts_with', value: '/admin' }))
  assert.ok(
    r.notes.some((n) => n.includes('过窄')),
    '盲区声明存在',
  )
})

test('可重试判定：按**错误码**，不靠消息字符串', () => {
  // 超时 / 网络抖动值得再试一次；鉴权、空内容、输出畸形、服务不可用重试多少遍都是
  // 同一个结果，只会把一次快速失败拖成一次慢失败，白白吃掉一次超时预算。
  assert.ok(isRetryable(new LlmError('timeout', '模型调用超时（100ms）：网络挂起或长时间排队')))
  assert.ok(isRetryable(new LlmError('network', 'fetch failed')))
  assert.ok(!isRetryable(new LlmError('auth', '401 鉴权失败')), '鉴权重试也不会变好')
  assert.ok(!isRetryable(new LlmError('malformed', '模型未返回 JSON：随便说点什么')), '输出不是 JSON 不该重试')
  assert.ok(!isRetryable(new LlmError('unavailable', 'llm 服务不可用')))

  // 最关键的一条：真实鉴权失败在实测中表现为**返回空内容**，而 llm.ts 为排障方便
  // 在那条消息里列出了全部可能原因（含"连接中断或超时"）。若靠关键字匹配消息，
  // 就会把它误判成超时而反复重试——按 code 判定则不会。
  const realAuthFailure = new LlmError(
    'empty',
    '模型返回内容为空。可能原因（按常见程度）：① API key 无效或额度耗尽；③ 连接中断或超时。',
  )
  assert.ok(!isRetryable(realAuthFailure), '消息里含“超时”字样也不该重试（code 是 empty）')
})

test('证据为空：不调模型，直接返回 ok=true 的空结果', async () => {
  const r = await proposeFromEvidence([])
  assert.equal(r.ok, true, '没有证据不是失败（只是没东西可归纳）')
  assert.deepEqual(r.candidates, [])
  assert.equal(r.error, undefined)
})

test('空组合在阶段1 就被拒（neverMatches 的空集分支因此不可达）', () => {
  // 第一层：ch18 的 isValidCondition 拒绝空 and / or / in，
  // 所以"空集合"这类形状根本到不了阶段2 的语义判断。
  assert.ok(!isValidCondition({ not: { or: [] } }), '空 or 被拒')
  assert.ok(!isValidCondition({ not: { and: [] } }), '空 and 被拒')
  assert.equal(validateStage1(cand({ not: { or: [] } })), false)
})

test('阶段2：not(X) 的判定必须与引擎求值一致（第二层）', () => {
  // 未知字段上的 eq 永不命中 → 取反后命中每一个请求 → 必须拒。
  assert.equal(
    validateStage2(cand({ not: { field: 'nope', op: 'eq', value: 'x' } })).ok,
    false,
    'not(永不命中) = 命中全部请求，必须拒',
  )
  // 已知字段上的普通条件可能命中 → 取反后不等于"命中一切" → 不该被误杀。
  assert.equal(
    validateStage2(cand({ not: { field: 'path', op: 'eq', value: '/a' } })).ok,
    true,
    'not(可能命中) 不该被当成“拒绝一切”误杀',
  )
})
