// src/firewall/ch19/real-model-run.ts —— real-model-run：真实模型驱动的 Agent 测试
//
// 用真实 DeepSeek 模型把自然语言意图起草成规则候选（对应正文"受约束生成"），
// 再走确定性 ledger 审批链路并断言 facts 一致。这是第19讲"可验证"的实测来源。
import { Ledger, RuleInput, type FactLog } from '../ledger'
import { verifyFacts } from '../facts'
import { FirewallEdit } from '../tool-firewall-edit'
import { agentDraftRule } from '../agent-draft.ts'

export async function runAgentTests(file: string, factLog: FactLog): Promise<string[]> {
  const log: string[] = []
  // 权威是传进来的会话日志；文件只是产物。
  const ledger = new Ledger(factLog, file, 'sess-1')
  const edit = new FirewallEdit(ledger)

  // 真实 Agent 受约束起草：模型把自然语言意图转成结构化候选（第一稿只是候选）。
  const intent = '阻止所有访问 /admin 路径的探测请求'
  const draft = await agentDraftRule(intent)
  const input: RuleInput = draft.input
  log.push(`模型起草候选（intent="${intent}"）→ ${JSON.stringify(input)}`)
  log.push(`模型 token 用量: in=${draft.usage.inputTokens} out=${draft.usage.outputTokens}`)
  const id = await edit.draftCandidate(input)
  log.push(`Agent 起草候选 ${id}（state=candidate）`)

  // 人审批（级别 1 下转正确认）后批准。
  await edit.approve(id)
  const state = ledger.listRules().find((r) => r.id === id)?.state
  log.push(`人审批后 ${id} state=${state}`)

  const facts = verifyFacts(factLog, file)
  log.push(`facts 一致=${facts.consistent}，事件数=${facts.eventCount}`)
  if (facts.consistent !== true) throw new Error('real-model-run 校验失败')
  return log
}
