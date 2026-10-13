// src/firewall/ch20/propose.e2e.test.ts —— 真模型端到端测试（需 DEEPSEEK_API_KEY）
//
// "Agent 长出候选"这条线用**真 DeepSeek 模型**做的端到端测试：
// 模型读脱敏证据长出候选，断言候选非空、action 全为 deny、且全部通过
// 两阶段校验（结构 + 语义）。断言只钉契约，不依赖模型具体命名/条件。
//
// 无 DEEPSEEK_API_KEY 时整组跳过。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitize, type NginxLine } from './observe'
import { proposeFromEvidence, validateStage1, validateStage2 } from './propose'

const skip = !process.env.DEEPSEEK_API_KEY

const line: NginxLine = {
  ip: '1.2.3.4',
  method: 'GET',
  path: '/admin',
  status: 403,
  ua: 'python-requests/2.31',
  hasCookie: true,
}

test('真模型从脱敏证据长出候选 → 两阶段校验全过', { skip }, async () => {
  const evidences = [
    sanitize({ kind: 'path-probe', line }),
    sanitize({ kind: 'sqli', line: { ...line, path: "/search?q=1'--" } }),
    sanitize({ kind: 'bad-ua', line: { ...line, path: '/ok', ua: 'python-requests/2.31' } }),
  ]

  const { candidates, usage } = await proposeFromEvidence(evidences)
  assert.ok(usage.inputTokens > 0, '有真实 token 消耗')
  assert.ok(candidates.length > 0, '模型至少长出一个候选')

  for (const c of candidates) {
    assert.equal(c.action, 'deny', `候选 ${c.name} 是 deny`)
    assert.ok(validateStage1(c), `候选 ${c.name} 过结构校验`)
    const s2 = validateStage2(c)
    // 断言**结论**，而不是 `notes.length > 0`——后者是恒真的（盲区说明无条件 push），
    // 永远为真、发现不了任何问题。
    assert.ok(s2.ok, `候选 ${c.name} 过语义校验`)
    // 盲区声明是契约的一部分：每条候选都必须带上"过窄发现不了"这条提示，
    // 否则调用方会误以为两阶段校验已经覆盖了全部风险。
    assert.ok(
      s2.notes.some((n) => n.includes('过窄')),
      `候选 ${c.name} 必须带盲区声明（否则调用方会误以为校验已覆盖全部风险）`,
    )
  }
})

test('模型不可用时降级为空候选 + 明确原因（不是抛错，也不是静默返回空）', { skip }, async () => {
  // 用 1ms 超时强制失败：拿到的是"这一轮没跑成"，而不是一个异常把整条链打挂。
  // 这里降级是安全的——进化链不是强制点，现有防护规则一条不少（ch18 引擎仍在工作）。
  const evidences = [sanitize({ kind: 'path-probe', line })]
  const r = await proposeFromEvidence(evidences, { timeoutMs: 1, retries: 0 })
  assert.equal(r.ok, false, '必须标记这一轮没跑成')
  assert.equal(r.candidates.length, 0, '降级为空候选')
  assert.ok(r.error && r.error.length > 0, '必须给出原因：只看到"0 条候选"会误以为模型看过了')
})
