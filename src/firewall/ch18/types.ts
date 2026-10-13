// src/firewall/ch18/types.ts —— 规则系统共享类型（纯数据，无 cordis 依赖）
//
// 这一讲要讲清"能力 seam"：规则语言、请求、判定这些类型是全讲共用的契约。
// 它们与具体引擎实现无关——Provider（InMemoryFirewall / FileFirewall）和 Consumer
// （rules-file / ingress-authz / tool-firewall）都认这些类型，这才是 seam 的意义。

// 防火墙拦的"请求"：七个字段对齐真实 HTTP（查询、正文可选）。
// 注意：引擎只看到这七个字段，看不到连接状态、看不到 TLS 信息——这是"防不住的部分"之一。
export interface HttpRequest {
  method: string
  path: string
  query?: Record<string, string>
  headers: Record<string, string>
  body?: string
  ip: string
  ua: string
}

// 结构化匹配算子。**刻意**没有暴露"任意正则"——模式匹配只通过 matches 走 re2-matcher（RE2 子集）。
export type Operator =
  | 'eq'
  | 'ne'
  | 'contains'
  | 'starts_with'
  | 'ends_with'
  | 'matches' // 仅这一项走 RE2，且永不回退 RegExp
  | 'in'
  | 'exists'

// 条件树：叶子 = 字段 + 算子 + 值；可 and / or / not 组合。
export type Condition =
  { field: string; op: Operator; value?: unknown } | { and: Condition[] } | { or: Condition[] } | { not: Condition }

export type Action = 'deny' | 'allow'
// candidate（候选）是第 19 讲治理流程引入的状态（起草 → 人审批 → 转 active）；
// 本讲引擎只处理 active（evaluate 里非 active 一律跳过），candidate 在此仅"入库不生效"。
export type RuleState = 'candidate' | 'active'

// 一条规则。unless 是例外：when 命中但 unless 也命中时，这条规则不触发——
// 这就是"把例外写进那条 deny 规则本身"，而不是另起一条 allow 来开洞。
export interface Rule {
  id: string
  name: string
  when: Condition
  action: Action
  unless?: Condition
  state: RuleState
}

export type RuleInput = Omit<Rule, 'id' | 'state'>

// 判定结果：命中则返回动作 + 命中的规则；没命中返回 null（默认放行/由模式决定）。
export interface Decision {
  action: Action
  ruleId: string
  ruleName: string
}

// PatternMatcher：RE2 匹配器的契约（能力 seam 中 re2-matcher 这一 Provider 角色对外暴露的接口）。
// rules 纯函数引擎只认这个接口，不认任何具体实现——因此本讲永远不会出现 new RegExp。
// 编译结果是不透明值（unknown），由具体 Provider 解释。
export interface PatternMatcher {
  readonly engine: 're2'
  compile(pattern: string): unknown
  match(compiled: unknown, text: string): boolean
}
