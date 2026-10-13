// src/firewall/ch18/rules.ts —— 纯函数规则引擎：先编译后求值，清洗是全函数
//
// 设计要点（对应第18讲"必讲"）：
//  • 纯函数：sanitize / compile / 求值都没有副作用、确定性、可回放——第20讲"回放日志评测候选规则"靠它成立。
//  • 先编译后执行：compileRule 把 Condition 树（含 re2-matcher 模式）预先编译成可执行闭包，
//    热路径 evaluate 只跑编译结果，不再解析、不再碰模式字符串。
//  • 清洗是全函数：sanitizeRequest 把请求归一成匹配用的规范视图，确定性、无副作用。
//  • 不依赖 cordis，也永不直接 new RegExp：模式匹配通过注入的 PatternMatcher（re2-matcher 提供）完成。
import { posix } from 'node:path'
import { Condition, HttpRequest, PatternMatcher, Rule, RuleInput } from './types'

// 字段上限：超过此长度的字段由入口（ingress-authz）拒绝，不进入引擎。
export const FIELD_MAX_LEN = 8192

// 字段取值：field 语法 method/path/body/ip/ua/header.<name>/query.<name>。
// 模型生成的条件可能缺 field，这里容错返回 undefined（后续算子按"不存在"处理）。
function getField(request: HttpRequest, field: unknown): unknown {
  if (typeof field !== 'string') return undefined
  switch (field) {
    case 'method':
      return request.method
    case 'path':
      return request.path
    case 'body':
      return request.body
    case 'ip':
      return request.ip
    case 'ua':
      return request.ua
  }
  if (field.startsWith('header.')) return lookupHeader(request.headers, field.slice('header.'.length))
  if (field.startsWith('query.')) return request.query?.[field.slice('query.'.length)]
  return undefined
}

/**
 * header 名按大小写不敏感查找：Node 的 HTTP 解析器给的头名是**全小写**，而规则作者按 HTTP
 * 惯例写 `header.X-Forwarded-For` / `header.Content-Type`。精确匹配会让这类规则
 * 永远匹配不上——且没有任何报错，规则静默失效（黑名单模式下就是放行）。
 */
function lookupHeader(headers: Record<string, string>, name: string): string | undefined {
  const direct = headers[name]
  if (direct !== undefined) return direct
  const lower = name.toLowerCase()
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k]
  }
  return undefined
}

// ── 清洗：全函数（deterministic, no side effects）──
// 把请求归一成匹配用的规范视图。注意："超长字段由入口拒绝"是 ingress-authz 的职责，
// 这里只做归一（NFC 归一化），不做截断语义——截断/拒绝是入口的边界，不是引擎的。
export function sanitizeRequest(request: HttpRequest): HttpRequest {
  const norm = (s?: string): string | undefined => (s === undefined ? undefined : s.normalize('NFC'))
  return {
    method: request.method,
    path: normalizePath(request.path),
    query: request.query,
    headers: request.headers,
    body: norm(request.body),
    ip: request.ip,
    ua: request.ua,
  }
}

// 编译后的条件：闭包捕获已编译的 RE2 模式，求值不再解析。
export interface CompiledCondition {
  test: (request: HttpRequest) => boolean
}

// 叶子求值（不含 matches：那一项在 compileCondition 里已提前编译，见下）。
// 约定：传入的 `value` 已在编译期预处理（字符串算子小写化；`in` 逐元素小写化）。
function evalLeaf(field: string, op: string, value: unknown, request: HttpRequest): boolean {
  const actual = getField(request, field)
  switch (op) {
    case 'eq':
      return looseEqual(actual, value)
    case 'ne':
      return !looseEqual(actual, value)
    case 'contains':
      return typeof actual === 'string' && typeof value === 'string' && actual.toLowerCase().includes(value)
    case 'starts_with':
      return typeof actual === 'string' && typeof value === 'string' && actual.toLowerCase().startsWith(value)
    case 'ends_with':
      return typeof actual === 'string' && typeof value === 'string' && actual.toLowerCase().endsWith(value)
    case 'in':
      return Array.isArray(value) && value.some((v) => looseEqual(actual, v))
    case 'exists':
      return actual !== undefined
    default:
      return false
  }
}

/**
 * 字符串比较统一**大小写不敏感**（WAF 惯例）。
 *
 * 之前 `eq` / `starts_with` / `ends_with` 区分大小写，而 `contains` / `matches` 不区分——
 * 同一套 DSL 里两种语义，后果是旗舰规则 `starts_with "/admin"` 会被 `GET /ADMIN/users`
 * 直接绕过：规则写对了、界面上也有这条规则，实际却拦不住，而且没有任何提示。
 * 非字符串（数字、布尔等）仍按严格相等，避免把 `1` 和 `'1'` 混为一谈。
 */
function looseEqual(actual: unknown, value: unknown): boolean {
  if (typeof actual === 'string' && typeof value === 'string') return actual.toLowerCase() === value
  return actual === value
}

/** 编译期预处理比较值：字符串算子统一小写化（`in` 则逐元素），其余原样。 */
function prepValue(op: string, value: unknown): unknown {
  if (op === 'in' && Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v.toLowerCase() : v))
  if (op === 'matches' || op === 'exists') return value
  return typeof value === 'string' ? value.toLowerCase() : value
}

// matches 的求值：只跑**已编译**的模式，永不碰模式字符串、永不 compile、永不 new RegExp。
function evalMatches(field: string, request: HttpRequest, matcher: PatternMatcher, compiled: unknown): boolean {
  const actual = getField(request, field)
  if (typeof actual !== 'string') return false
  return matcher.match(compiled, actual)
}

// 编译：把 Condition 树递归编译成可求值的闭包（先编译后执行）。
export function compileCondition(condition: Condition, matcher: PatternMatcher): CompiledCondition {
  if ('and' in condition) {
    const xs = condition.and.map((c) => compileCondition(c, matcher))
    return { test: (r) => xs.every((x) => x.test(r)) }
  }
  if ('or' in condition) {
    const xs = condition.or.map((c) => compileCondition(c, matcher))
    return { test: (r) => xs.some((x) => x.test(r)) }
  }
  if ('not' in condition) {
    const x = compileCondition(condition.not, matcher)
    return { test: (r) => !x.test(r) }
  }
  const { field, op, value } = condition
  // 唯一走 RE2 的算子：模式在**编译期**编译一次，由闭包捕获——求值只跑 match。
  // 放在求值期有两个后果：① 每个请求、每个 matches 叶子都重编译一遍；② 坏模式要到
  // 第一个匹配的请求才抛 Re2Unsupported，而不是在装载规则时就被拒绝。后者对安全组件
  // 尤其致命：判定不了应当等于拒绝，而不是让异常穿透到强制点。
  if (op === 'matches') {
    if (typeof value !== 'string') {
      throw new Error(`matches 的 value 必须是字符串（要能编译成 RE2 模式），收到：${JSON.stringify(value)}`)
    }
    const compiled = matcher.compile(value)
    return { test: (r) => evalMatches(field, r, matcher, compiled) }
  }
  // 字符串算子统一大小写不敏感：比较值在**编译期**就小写化（见 prepValue），
  // 求值只需 lowercase 请求侧——规则侧的常量不该在每个请求上重复处理。
  const cmp = prepValue(op, value)
  return { test: (r) => evalLeaf(field, op, cmp, r) }
}

/**
 * 路径归一：百分号解码 → 规范化（合并重复斜杠、解析 `.` 与 `..`）→ NFC。
 *
 * 不做这一步，`/%61dmin` 就能绕过 `starts_with '/admin'`——WAF 的经典绕过：上游应用
 * 拿到的是解码后的 /admin，防火墙看到的却是字面 "%61dmin"，两者看到的不是同一个路径。
 * `//admin`、`/admin/./users`、`/x/../admin` 同理，都会绕过基于路径前缀的规则。
 */
function normalizePath(path: string): string {
  let decoded = path
  try {
    decoded = decodeURIComponent(path)
  } catch {
    // 畸形的百分号编码（如 %zz）无法解码：保留原样交给规则匹配。
    // 这不会造成绕过——规则看到的就是这串字面值，它不会"变成"另一个路径。
    return path
  }
  // posix.normalize 处理 //、. 与 ..，且不会越出根（/../etc → /etc），可安全使用。
  return posix.normalize(decoded).normalize('NFC')
}

// 编译后的规则：when 与 unless（例外）都预编译。
export interface CompiledRule {
  rule: Rule
  when: CompiledCondition
  unless: CompiledCondition | null
}

export function compileRule(rule: Rule, matcher: PatternMatcher): CompiledRule {
  return {
    rule,
    when: compileCondition(rule.when, matcher),
    unless: rule.unless ? compileCondition(rule.unless, matcher) : null,
  }
}

// 规则是否命中（考虑 unless 例外）：when 命中、且 unless 未命中。
// 这是纯函数，输入相同必得相同结果——可回放评测的前提。
export function ruleMatches(compiled: CompiledRule, request: HttpRequest): boolean {
  if (!compiled.when.test(request)) return false
  if (compiled.unless && compiled.unless.test(request)) return false // 例外命中 → 不触发
  return true
}

// 便捷入口：清洗 → 编译 → 求值（演示/单测用；生产热路径应复用 compileRule 结果）。
export function evaluateRequest(rule: Rule, request: HttpRequest, matcher: PatternMatcher): boolean {
  return ruleMatches(compileRule(rule, matcher), sanitizeRequest(request))
}

export type { RuleInput }
