// src/firewall/ch19/agent-draft.e2e.test.ts —— 真模型端到端测试（需 DEEPSEEK_API_KEY）
//
// 这是"受约束生成"那条线用**真 DeepSeek 模型**做的端到端测试，不是 mock：
// 模型把自然语言意图起草成结构化候选，再走确定性 ledger 审批链路，
// 最后 facts 校验。断言只钉"契约/不变量"（结构合法、状态转移、账本一致），
// 不依赖模型的具体措辞，因此非确定性下依然稳定。
//
// 无 DEEPSEEK_API_KEY 时整组跳过（npm test 不会因此失败）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { LedgerLogService } from './session-log'
import { Ledger } from './ledger'
import { FirewallEdit } from './tool-firewall-edit'
import { agentDraftRule, isValidRuleWhen } from './agent-draft'
import { verifyFacts } from './facts'
import { evaluateRequest } from '../ch18/rules'
import type { HttpRequest, PatternMatcher, Rule } from '../ch18/types'

const skip = !process.env.DEEPSEEK_API_KEY

// 起草的 when 只用 eq/starts_with/contains/ends_with（无 matches），桩 matcher 即可。
const STUB_MATCHER: PatternMatcher = {
  engine: 're2',
  compile: () => {
    throw new Error('起草 when 无 matches 算子，无需 RE2')
  },
  match: () => {
    throw new Error('起草 when 无 matches 算子，无需 RE2')
  },
}

// 根据模型起草的 when 反向构造一条"应当命中"的请求，验证它真的能被 ch18 引擎判定命中。
function buildMatchingRequest(when: unknown): HttpRequest {
  const w = when as { field: string; op: string; value: string }
  const base: HttpRequest = { method: 'GET', path: '/normal', headers: {}, ip: '9.9.9.9', ua: 'Mozilla/5.0' }
  const { field, op, value } = w
  if (field === 'path') {
    if (op === 'eq') return { ...base, path: value }
    if (op === 'starts_with') return { ...base, path: value + '/rest' }
    if (op === 'contains') return { ...base, path: '/pre/' + value + '/suf' }
    if (op === 'ends_with') return { ...base, path: '/pre/' + value }
  }
  if (field === 'method') return { ...base, method: value }
  if (field === 'ip') return { ...base, ip: value }
  if (field === 'ua') {
    if (op === 'eq') return { ...base, ua: value }
    if (op === 'starts_with') return { ...base, ua: value + '-rest' }
    if (op === 'contains') return { ...base, ua: 'pre-' + value + '-suf' }
    if (op === 'ends_with') return { ...base, ua: 'pre-' + value }
  }
  if (field === 'body') {
    if (op === 'eq') return { ...base, body: value }
    if (op === 'contains') return { ...base, body: 'pre' + value + 'suf' }
    if (op === 'starts_with') return { ...base, body: value + 'rest' }
    if (op === 'ends_with') return { ...base, body: 'pre' + value }
  }
  return base
}

test('真模型起草候选 → 人审批 → facts 一致（端到端）', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-draft-e2e-'))
  const file = join(dir, 'rules.json')
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LedgerLogService, { sessionId: 'sess-model-e2e' })
  const ledger = new Ledger(ctx.ledgerLog, file, 'sess-model-e2e')
  const edit = new FirewallEdit(ledger)

  // 真模型：自然语言意图 → 结构化候选
  const draft = await agentDraftRule('阻止所有访问 /admin 路径的探测请求')
  assert.equal(typeof draft.input.name, 'string', '规则名是字符串')
  assert.ok(draft.input.name.length > 0, '规则名非空')
  assert.ok(draft.input.action === 'deny' || draft.input.action === 'allow', 'action 合法')
  assert.ok(isValidRuleWhen(draft.input.when), 'when 是合法条件树（field/op 在契约内、value 非空）')
  assert.ok(draft.usage.inputTokens > 0, '有真实 token 消耗（证明确实调了模型）')

  // 确定性链路：候选 → 审批 → active（publish 走串行写链，断言前等落链）
  const id = await edit.draftCandidate(draft.input)
  assert.equal(ledger.listRules().find((r) => r.id === id)?.state, 'candidate', '第一稿只是候选，不直接生效')
  await edit.approve(id)
  await new Promise((r) => setImmediate(r))
  assert.equal(ledger.listRules().find((r) => r.id === id)?.state, 'active', '审批后转 active')

  // 接缝：起草出的规则必须能被 ch18 引擎编译并判定命中——"可生成"的最后一公里，
  // 也是 ch19 与 ch18 的衔接点（生成的规则要真的能拦，而不只是躺在账本里）。
  const rule: Rule = {
    id: 'draft-e2e',
    name: draft.input.name,
    action: draft.input.action,
    when: draft.input.when as Rule['when'],
    state: 'active',
  }
  assert.equal(
    evaluateRequest(rule, buildMatchingRequest(draft.input.when), STUB_MATCHER),
    true,
    '起草的规则能被 ch18 引擎判定命中',
  )

  // facts 校验：会话日志是权威，文件只是投影
  const facts = verifyFacts(ctx.ledgerLog, file)
  assert.equal(facts.consistent, true, '权威折叠与文件投影一致')
  assert.equal(facts.eventCount, 2, 'draft + approve 两条事实')
  rmSync(dir, { recursive: true, force: true })
})
