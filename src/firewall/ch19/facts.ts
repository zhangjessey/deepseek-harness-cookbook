// src/firewall/ch19/facts.ts —— facts：对账"权威"与"产物"
//
// 权威 = 会话日志里的事实折叠出的状态；产物 = 规则文件里投影出来的规则。
// 两者一致，说明文件确实只是权威的投影、没有反过来充当历史——
// 这是第 19 讲"持久化可靠"的实测入口。
import { fold, readProjectionFile, sameRule, Rule, type FactLog } from './ledger'

export interface FactsReport {
  consistent: boolean // 权威折叠 与 文件投影 是否一致
  rulesFromFold: Rule[] // 权威
  rulesStored: Rule[] // 产物
  eventCount: number // 权威里的事实条数
  /** 产物读不出来时的原因。有值表示"根本无法比较"，而不是"比较后发现不一致"。 */
  projectionUnreadable?: string
}

export function verifyFacts(log: FactLog, file: string): FactsReport {
  const facts = log.facts()
  const rulesFromFold = fold(facts)
  const read = readProjectionFile(file)
  // 文件读不出来不能当成"空"：那会得出"权威有规则、文件里没有"的误导结论，
  // 掩盖真正的问题（文件损坏 / 权限错误）。所以显式标为"无法比较"并给出原因。
  if (read.kind === 'corrupt') {
    return {
      consistent: false,
      rulesFromFold,
      rulesStored: [],
      eventCount: facts.length,
      projectionUnreadable: read.reason,
    }
  }
  const rulesStored = read.kind === 'ok' ? read.rules : []
  // 逐条比较，而不是 JSON.stringify：后者会因**键顺序**不同（例如人手工改过投影文件）
  // 误判成"不一致"，而内容其实完全一样。
  return { consistent: sameRules(rulesFromFold, rulesStored), rulesFromFold, rulesStored, eventCount: facts.length }
}

function sameRules(a: Rule[], b: Rule[]): boolean {
  if (a.length !== b.length) return false
  const byId = new Map(b.map((r) => [r.id, r]))
  for (const r of a) {
    const other = byId.get(r.id)
    if (!other || !sameRule(r, other)) return false
  }
  return true
}
