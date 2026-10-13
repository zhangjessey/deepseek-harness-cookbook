// src/firewall/ch19/agent-draft.ts —— 用真实 DeepSeek 模型把自然语言意图起草成防火墙规则候选。
//
// 这是第19讲"Agent 起草候选"的真实落点：模型读意图，产出结构化的 RuleInput（name/action/when），
// 之后交给确定性 ledger 走审批链路。
import { ask, extractJson } from '../shared/llm.ts'
import type { RuleInput } from './ledger.ts'

const SYSTEM = `你是一个防火墙策略助手。用户用自然语言描述想要的一条防护规则，
你需要把它翻译成结构化 JSON，不要任何解释文字，只输出一个 JSON 对象。

字段约定：
- name: 简短英文规则名（如 "block admin probe"）
- action: "deny" 或 "allow"
- when: 匹配条件，形如 { "field": 取值见下, "op": 取值见下, "value": 字符串 }
  field 可选: "path" | "ip" | "method" | "ua" | "body"
  op 可选: "eq" | "starts_with" | "contains" | "ends_with"
- 不要输出 unless 字段

只输出 JSON。`

// 受约束生成的契约：when 必须是合法叶子——field/op 在允许集合内、value 为非空字符串。
// 这一步是"约束在代码里"（不是靠提示词）：模型即使吐出不合法结构，也会在进入 ledger 前被拒绝，
// 而不是等 ch18 引擎求值时静默不匹配（该拦的没拦、还不报错）。
const FIELDS = ['path', 'ip', 'method', 'ua', 'body'] as const
const OPS = ['eq', 'starts_with', 'contains', 'ends_with'] as const

export function isValidRuleWhen(when: unknown): boolean {
  if (typeof when !== 'object' || when === null) return false
  const w = when as Record<string, unknown>
  if (typeof w.field !== 'string' || !(FIELDS as readonly string[]).includes(w.field)) return false
  if (typeof w.op !== 'string' || !(OPS as readonly string[]).includes(w.op)) return false
  if (typeof w.value !== 'string' || w.value.length === 0) return false
  return true
}

export interface AgentDraftResult {
  input: RuleInput
  raw: string
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number }
}

/** 让真实模型把自然语言意图起草成一条规则候选。 */
export async function agentDraftRule(intent: string): Promise<AgentDraftResult> {
  const r = await ask(intent, { system: SYSTEM, maxTokens: 256 })
  const obj = extractJson<{ name: string; action: string; when: unknown }>(r.text)
  if (obj.action !== 'deny' && obj.action !== 'allow') {
    throw new Error('模型返回的 action 非法: ' + obj.action)
  }
  if (!isValidRuleWhen(obj.when)) {
    throw new Error('模型返回的 when 非法: ' + JSON.stringify(obj.when))
  }
  return {
    input: { name: obj.name, action: obj.action as 'deny' | 'allow', when: obj.when },
    raw: r.text,
    usage: r.usage,
  }
}
