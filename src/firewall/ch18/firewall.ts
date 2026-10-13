// src/firewall/ch18/firewall.ts —— firewall：规则引擎的 Service Definition（能力 seam 的契约）
//
// 这是"能力 seam"的核心：firewall 只定义契约（评估/列规则/增删），不规定规则存在内存还是文件、
// 不规定匹配器是谁——这些由 Provider（本讲 FirewallEngine，注入 re2-matcher）和 Consumer（rules-file）决定。
// 因此下面这个抽象类就是"扩展点"本身。
import { Context, Service } from '@deepseek-ai/cordis'
import { Decision, HttpRequest, PatternMatcher, Rule, RuleInput, RuleState } from './types'
import { assertValidCondition } from './condition'
import { compileRule, CompiledRule, ruleMatches, sanitizeRequest } from './rules'
import { assertRealRe2 } from './re2-matcher'

// 模式：黑名单（默认放行，命中 deny 才拦）/ 白名单（默认拒绝，命中 allow 才放）。
// 产品决定：allow 只在白名单模式合法——黑名单模式下 allow 规则不参与判定（命中 allow 也默认放行）。
export type FirewallMode = 'blacklist' | 'whitelist'

declare module '@deepseek-ai/cordis' {
  interface Context {
    firewall: Firewall
  }
}

// 能力 seam 的契约（Definition）。Consumer 只认它，不认具体实现。
export abstract class Firewall extends Service {
  constructor(ctx: Context) {
    super(ctx, 'firewall')
  }
  // 评估一条请求：命中返回判定，没命中返回 null（默认行为由模式决定）。
  abstract evaluate(request: HttpRequest): Decision | null
  abstract listRules(): Rule[]
  abstract addRule(input: RuleInput, state?: RuleState): string
  abstract removeRule(id: string): void
  abstract setMode(mode: FirewallMode): void
  abstract getMode(): FirewallMode
  // 批量载入规则（rules-file Consumer 用）：整体替换规则库。
  abstract loadRules(inputs: RuleInput[]): void
}

// Provider：本讲的内存实现。注入 re2-matcher 作为匹配器；规则存在内存；编译结果缓存。
//
// 关键判定语义（产品决定），**分两层说清**，不能笼统说成"与顺序无关"：
//  · **deny 优先于 allow**：不论两条规则在库里的先后，只要命中了 deny 就拒绝。
//    这一层确实与顺序无关——先写 allow 再写 deny，结果仍是拒绝。
//  · **多条 deny 之间**：返回命中的**第一条**，于是"是被哪条规则拦的"取决于规则库顺序
//    （顺序即优先级）。这一层**不是**与顺序无关的：两条 deny 规则冲突时，
//    调换顺序会改变日志里显示的规则名。排查规则冲突时必须知道这一点。
// unless 例外写进 deny 规则本身，而不是另起一条 allow 来开洞。
export class FirewallEngine extends Firewall {
  static inject = ['re2'] as const

  private rules: Rule[] = []
  private seq = 0
  private cache = new Map<string, CompiledRule>()
  private mode: FirewallMode = 'blacklist'
  private matcher: PatternMatcher

  constructor(ctx: Context) {
    super(ctx)
    // 守卫：matcher 必须是真正的 RE2，否则拒绝加载（检测到测试替身拒绝加载）。
    assertRealRe2(ctx.re2)
    // 不需要断言：Re2Matcher 已声明 implements PatternMatcher，编译器会持续检查它符合契约。
    // 以前那句 `as unknown as PatternMatcher` 会让编译器**停止**这项检查。
    this.matcher = ctx.re2
  }

  // 批量载入（rules-file Consumer 用）：整体替换规则库，并清编译缓存。
  loadRules(inputs: RuleInput[]): void {
    // 先做**形状校验**再编译：compileRule 只抓 RE2 不支持的语法，抓不住
    // `{and:[]}`（恒真，命中一切）/ `{or:[]}`（恒假，永不生效）这类"能编译但语义错误"
    // 的形状——它们照样进引擎，却在求值时命中一切或永不命中。文件路径有 readRulesFile
    // 拦着，但这里（程序化 loadRules）也得拦，否则"空组合拒绝"能被一条 API 调用绕过。
    for (const input of inputs) {
      assertValidCondition(input.when, `loadRules(${input.name}).when`)
      if (input.unless !== undefined) assertValidCondition(input.unless, `loadRules(${input.name}).unless`)
    }
    const rules = inputs.map((input) => ({ ...input, id: `rule-${++this.seq}`, state: 'active' as RuleState }))
    // 先全部编译，再整体替换：坏模式（Re2Unsupported）在这里就抛出，规则库不会被换成
    // 半成品。加载失败 = 保持原状并上抛，绝不留一个"有规则但不生效"的库——那等于静默放行。
    const compiled = new Map<string, CompiledRule>()
    for (const rule of rules) compiled.set(rule.id, compileRule(rule, this.matcher))
    this.rules = rules
    this.cache = compiled
  }

  evaluate(request: HttpRequest): Decision | null {
    const sreq = sanitizeRequest(request)
    // 命中 deny 即**短路**返回：以前要把整个规则库跑完再从命中集合里挑，
    // 每请求都要把全部规则求值一遍——而结果其实只需要"命中的第一条 deny"。
    let firstAllow: Rule | undefined
    for (const rule of this.rules) {
      if (rule.state !== 'active') continue
      // 黑名单模式下 allow 不参与判定，跳过求值：firstAllow 只在白名单模式被使用，
      // 黑名单下对 allow 调 ruleMatches 是纯浪费（结果被丢弃），直接 continue 省掉。
      if (this.mode === 'blacklist' && rule.action === 'allow') continue
      if (!ruleMatches(this.compiled(rule), sreq)) continue
      // deny 优先：命中 deny 立刻返回，后面的规则不必再看。
      if (rule.action === 'deny') return { action: 'deny', ruleId: rule.id, ruleName: rule.name }
      firstAllow ??= rule
    }
    // 一条 deny 都没命中：白名单模式下看有没有命中 allow；黑名单模式默认放行
    // （白名单模式走到这里表示没命中 allow，由上层默认拒绝处理）。
    if (this.mode === 'whitelist' && firstAllow) {
      return { action: 'allow', ruleId: firstAllow.id, ruleName: firstAllow.name }
    }
    return null
  }

  listRules(): Rule[] {
    return [...this.rules]
  }

  addRule(input: RuleInput, state: RuleState = 'active'): string {
    // 运行时入口同样要过形状校验（与 loadRules 同口径）：空组合/空集合这种
    // "规则存在但不生效"的形状，不能只靠文件路径拦住。
    assertValidCondition(input.when, `addRule(${input.name}).when`)
    if (input.unless !== undefined) assertValidCondition(input.unless, `addRule(${input.name}).unless`)
    const id = `rule-${++this.seq}`
    const rule: Rule = { ...input, id, state }
    // 同样先编译：坏模式在入参时就被拒绝，不会静默变成一条永不生效的规则。
    // （原来这里是一句 `cache.delete(id)`——而 id 刚由 ++seq 生成、缓存里必然没有，
    // 那是一句永远不生效的死代码，看起来像缓存正确性保障，实际是误导。）
    const cr = compileRule(rule, this.matcher)
    this.rules.push(rule)
    this.cache.set(id, cr)
    return id
  }

  removeRule(id: string): void {
    this.rules = this.rules.filter((r) => r.id !== id)
    this.cache.delete(id)
  }

  setMode(mode: FirewallMode): void {
    this.mode = mode
  }

  getMode(): FirewallMode {
    return this.mode
  }

  private compiled(rule: Rule): CompiledRule {
    const hit = this.cache.get(rule.id)
    if (hit) return hit
    const cr = compileRule(rule, this.matcher)
    this.cache.set(rule.id, cr)
    return cr
  }
}
