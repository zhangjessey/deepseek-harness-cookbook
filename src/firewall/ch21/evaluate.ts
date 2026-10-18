// src/firewall/ch21/evaluate.ts —— 评测：覆盖 / 精确 / 误伤；历史流量回放；事实校验；从候选逆推证据
//
// 对应第21讲"评测三件事"：评测要回答"候选真能拦吗"——靠历史流量回放（复用 ch18 纯函数引擎，
// 确定性、可回放），给出覆盖（recall）、精确（precision）、误伤（false positive）；
// 并用事实校验（回放计数自洽）+ 从候选逆推证据（候选的 when 能覆盖哪些异常证据）对齐。
import { existsSync, readFileSync } from 'node:fs'
import { leavesOf } from '../ch18/condition.ts'
import { compileRule, evaluateRequest, ruleMatches, sanitizeRequest } from '../ch18/rules'
import type { Condition, HttpRequest, PatternMatcher, Rule } from '../ch18/types'
import { detect, parseLine, type NginxLine } from '../ch20/observe'
import type { Candidate } from '../ch20/propose'

// 评测不依赖 RE2：本讲候选只用 eq/contains/starts_with 等算子（无 matches），故用桩 matcher。
const STUB_MATCHER: PatternMatcher = {
  engine: 're2',
  compile: () => {
    throw new Error('评测未用 matches 算子，无需 RE2')
  },
  match: () => {
    throw new Error('评测未用 matches 算子，无需 RE2')
  },
}

function toRule(c: Candidate): Rule {
  // 不需要 `as`：Candidate.when 与 Rule.when 都是 ch18 的 Condition（跨讲契约统一）。
  // 以前那个强转掩盖了"两边本该是同一类型"这件事，于是结构错误要到运行时才暴露。
  return { id: c.id, name: c.name, action: c.action, when: c.when, state: 'candidate' }
}

/**
 * 回放样本**能**提供的字段。
 *
 * nginx **访问**日志只记请求行 / 状态码 / UA / 引用，不记请求体，也不记绝大多数请求头。
 * 所以依赖 body 或某个具体 header 的候选，在这个样本上是**评不了的**——若把它当
 * "命中 0"处理就会误杀（配上"命中 0 即拒绝"的风险关卡，一条本来有用的规则会
 * 因为样本里没有 body 而被判成"拦不住任何东西"）。这类情况要归到"样本不足"。
 */
const ASSESSABLE_FIELDS = new Set(['method', 'path', 'ip', 'ua', 'query'])

function isAssessable(field: string): boolean {
  // cookie 只有"有无"（访问日志不记内容），用占位值让 header.cookie 类规则可判。
  return ASSESSABLE_FIELDS.has(field) || field === 'header.cookie'
}

/** 访问日志只解析出 hasCookie（有无），没有内容：给一个占位值，让 exists/eq 类规则仍可评估。 */
function cookieHeader(line: NginxLine): Record<string, string> {
  return line.hasCookie ? { cookie: 'present' } : {}
}

function parseQuery(query: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const kv of query.split('&').filter(Boolean)) {
    const eq = kv.indexOf('=')
    if (eq < 0) continue
    try {
      out[decodeURIComponent(kv.slice(0, eq))] = decodeURIComponent(kv.slice(eq + 1).replace(/\+/g, ' '))
    } catch {
      // 畸形百分号编码：跳过这一项，不影响其余参数
    }
  }
  return out
}

function toHttpRequest(line: NginxLine): HttpRequest {
  // query 要从 URI 里拆出来：ch18 支持 query.<name> 字段语法，
  // 合在 path 里会让这类候选永远匹配不上（等于凭空造出"命中 0"）。
  const q = line.path.indexOf('?')
  const headers = cookieHeader(line)
  if (q < 0) return { method: line.method, path: line.path, headers, ip: line.ip, ua: line.ua }
  return {
    method: line.method,
    path: line.path.slice(0, q),
    query: parseQuery(line.path.slice(q + 1)),
    headers,
    ip: line.ip,
    ua: line.ua,
  }
}

/**
 * 候选用到的字段（用来判断这条候选能不能用本样本评估）。
 * 复用 ch18 的 `leavesOf`，不在这里再手写一份递归——两份递归一旦漂移，
 * 就会出现"某个字段被漏掉，于是把评不了的候选误判成可评估"。
 */
function usedFields(when: Condition): Set<string> {
  const out = new Set<string>()
  for (const leaf of leavesOf(when)) out.add(leaf.field.startsWith('query.') ? 'query' : leaf.field)
  return out
}

export interface TrafficItem {
  req: HttpRequest
  isBad: boolean // Oracle：检测器判为异常即"该拦"
  /**
   * 原始日志行。**刻意保留**：请求侧没有 status（那是响应的字段），
   * 而回接（`feedback.ts`）构造证据需要它——若拿 HttpRequest 合成，
   * 回喂出去的 status 就是编的，证据失真，下一轮照着学等于学错。
   */
  line: NginxLine
}

export interface EvalResult {
  candidateId: string
  candidateName: string
  total: number
  totalBad: number
  totalGood: number
  caughtBad: number // 覆盖的"该拦"数
  caughtGood: number // 误伤的"正常"数
  coverage: number // 覆盖 = caughtBad / totalBad
  precision: number // 精确 = caughtBad / (caughtBad + caughtGood)
  falsePositiveRate: number // 误伤率 = caughtGood / totalGood
  evidenceKinds: string[] // 从候选逆推的异常类别
  // 样本是否足以支撑结论：坏样本或正常样本为 0 时，误伤率/覆盖率算出来都是 0，
  // 但那表示"没数据"，不表示"确实没误伤 / 确实拦不住"。下游关卡必须据此拒绝放行。
  sampleSufficient: boolean
  /** 样本无法提供的字段（如 body）。不为空时 sampleSufficient 为 false——供诊断与提示用。 */
  unassessableFields?: string[]
  /**
   * Oracle（"这条请求真是坏的吗"的判据）的来源。
   *
   * **注意这里存在自证**：Oracle 是第 20 讲的启发式检测器，而候选规则正是从这些检测器
   * 长出来的。所以本指标衡量的是"对检测器的**复现度**"，不等于真实防护效果——
   * 一条比检测器更准（抓到检测器漏掉的攻击）的规则，反而会被记成误伤。
   */
  oracle: string
  factCheck: { ok: boolean; note: string }
}

/** Oracle 的自述：放进每个 EvalResult，避免读者把"复现度"误读成"真实效果"。 */
const ORACLE_DESCRIPTION = 'ch20 启发式检测器（detect）：本指标衡量对检测器的复现度，非独立 ground truth'

// 从候选逆推它能覆盖的异常证据类别（依据 when 结构反推意图来源）。
export function reverseEvidenceKinds(c: Candidate): string[] {
  // 走统一叶子视图：组合型候选（and / or）本来就可能同时对应多个类别，
  // 只看"顶层 field"会把它归成一个，从而漏掉它真正覆盖的那一类。
  const kinds = new Set<string>()
  for (const leaf of leavesOf(c.when)) {
    if (leaf.field === 'ua') kinds.add('bad-ua')
    else if (leaf.field === 'path') {
      const isSqli = leaf.op === 'contains' && typeof leaf.value === 'string' && leaf.value.includes("'")
      kinds.add(isSqli ? 'sqli' : 'path-probe')
    } else kinds.add('unknown')
  }
  return kinds.size > 0 ? [...kinds] : ['unknown']
}

// 评测一个候选：对每条历史流量回放（ch18 引擎），统计覆盖/精确/误伤。
export function evaluate(candidate: Candidate, traffic: TrafficItem[]): EvalResult {
  let totalBad = 0
  let totalGood = 0
  let caughtBad = 0
  let caughtGood = 0
  const rule = toRule(candidate)
  // 编译**一次**，循环内只求值：原来每条请求都 compileRule 一遍，19 条样本无感，
  // 但真实日志（万/十万行）会退化成 N 次条件树编译 + 每个叶子重新分配闭包。
  const compiled = compileRule(rule, STUB_MATCHER)
  for (const { req, isBad } of traffic) {
    const matched = ruleMatches(compiled, sanitizeRequest(req))
    if (isBad) {
      totalBad++
      if (matched) caughtBad++
    } else {
      totalGood++
      if (matched) caughtGood++
    }
  }
  // "0" 在这里同时表示"无数据"和"真的是 0"，两者必须分开：样本里没有正常流量时误伤率
  // 算出来是 0.0%，下游若直接当成"没误伤"，一条会拦掉全部正常请求的规则就会被放行。
  // 候选若依赖样本根本提供不了的字段（body / 某个具体 header），回放出来的"命中 0"
  // 也不代表它拦不住东西，只代表**这个样本评不了它**——并入"样本不足"，
  // 于是关卡给出的是"无法评估、需人确认"，而不是把它误判成"无用的规则"。
  const unassessableFields = [...usedFields(candidate.when)].filter((f) => !isAssessable(f))
  const sampleSufficient = totalBad > 0 && totalGood > 0 && unassessableFields.length === 0
  const coverage = totalBad === 0 ? 0 : caughtBad / totalBad
  const precision = caughtBad + caughtGood === 0 ? 0 : caughtBad / (caughtBad + caughtGood)
  const fpr = totalGood === 0 ? 0 : caughtGood / totalGood
  const evidenceKinds = reverseEvidenceKinds(candidate)
  // 事实校验：回放计数自洽。不能写成 `caughtBad + caughtGood <= totalBad + totalGood`
  // ——那是恒真式（两个不相交集合各自都不超过自身总量），永远为真、发现不了任何不一致，
  // 等于一条永不失败的假断言。下面每条都能真的失败。
  const factCheck = checkFacts(traffic.length, totalBad, totalGood, caughtBad, caughtGood)
  return {
    candidateId: candidate.id,
    candidateName: candidate.name,
    total: traffic.length,
    totalBad,
    totalGood,
    caughtBad,
    caughtGood,
    coverage,
    precision,
    falsePositiveRate: fpr,
    evidenceKinds,
    sampleSufficient,
    ...(unassessableFields.length > 0 ? { unassessableFields } : {}),
    oracle: ORACLE_DESCRIPTION,
    factCheck,
  }
}

/**
 * 回放计数自洽检查——每一条都能真的失败：
 *  · Oracle 标注必须覆盖全部样本：漏标会让分母失真，指标看起来"很好"却是假的
 *  · 逐项上界：能抓住"同一条请求被同时计入两边"这类不一致
 */
function checkFacts(
  total: number,
  totalBad: number,
  totalGood: number,
  caughtBad: number,
  caughtGood: number,
): { ok: boolean; note: string } {
  if (totalBad + totalGood !== total) {
    return { ok: false, note: `标注未覆盖全部样本：${totalBad} + ${totalGood} ≠ ${total}` }
  }
  if (caughtBad > totalBad) {
    return { ok: false, note: `拦下的坏请求 ${caughtBad} 超过样本中坏请求总数 ${totalBad}` }
  }
  if (caughtGood > totalGood) {
    return { ok: false, note: `误伤的正常请求 ${caughtGood} 超过样本中正常请求总数 ${totalGood}` }
  }
  return { ok: true, note: `回放计数自洽（该拦 ${caughtBad}/${totalBad}，误伤 ${caughtGood}/${totalGood}）` }
}

// 便捷：候选是否会拦下这条请求（闭环喂数据时复用）。
export function wouldBlock(c: Candidate, req: HttpRequest): boolean {
  return evaluateRequest(toRule(c), req, STUB_MATCHER)
}

// 读历史流量日志，用 ch20 检测器作 Oracle 标注"该拦/正常"。
export function loadHistoricalTraffic(file: string): TrafficItem[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((text) => {
      const line = parseLine(text)
      if (!line) return null
      return { req: toHttpRequest(line), isBad: detect(line) !== null, line }
    })
    .filter((x): x is TrafficItem => x !== null)
}
