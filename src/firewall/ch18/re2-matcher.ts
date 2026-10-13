// src/firewall/ch18/re2-matcher.ts —— re2-matcher：RE2 风格匹配器（Service Provider 角色）
//
// 产品决定："正则只用 RE2 扩展算子，不回退 RegExp"。本文件是这条决定的具象：
//  • 用 Thompson NFA 做线性时间匹配，没有回溯，因此没有 ReDoS（正则灾难）。
//  • 主体是纯 NFA（无回溯、无 ReDoS），遇到回溯型构造（反向引用、环视、{n,m} 等）直接抛错，而不是回退到 JS 正则。
//    （唯一例外：\d \s \w 等字符类转义借用 JS 单字符正则字面量，如 /[0-9]/.test(x)——单字符 O(1)、无回溯，不构成 ReDoS 面。）
//  • assertRealRe2：治理 Agent 的工具若被换成"测试替身"（用 RegExp 实现的假 matcher），引擎在加载时拒绝。
//
// 这是教学子集，支持：字面量、.（任意非换行）、* + ?、分组 ()、选择 |、字符类 [...]/[^...]
// （含范围与 \d \s \w 转义）、锚点 ^ $。不支持的构造抛 Re2Unsupported。
// matches 算子大小写不敏感（WAF 常见做法，也与 DSL 提示一致）。
import { Context, Service } from '@deepseek-ai/cordis'
import type { PatternMatcher } from './types'

export type Inst =
  | { op: 'char'; ch: string }
  | { op: 'any' }
  | { op: 'class'; test: (ch: string) => boolean }
  | { op: 'split'; x: number; y: number }
  | { op: 'jump'; x: number }
  | { op: 'match' }

export interface Re2Pattern {
  source: string
  program: Inst[]
  start: number
  anchoredStart: boolean
  anchoredEnd: boolean
}

// 能力 seam 中"匹配器"的 Service Definition（抽象契约）。engine 标记让它能直接当作 PatternMatcher 使用。
/**
 * RE2 匹配器的抽象基类。**声明 implements PatternMatcher**：
 * 编译与匹配结果在契约里是**不透明值**（unknown），由具体实现解释——这样调用方
 * （rules.ts / firewall.ts）只认契约、不认实现，也就不需要 `as unknown as` 去绕过类型系统
 * （那种双重断言会让编译器**停止检查**实现到底符不符合契约）。
 */
export abstract class Re2Matcher extends Service implements PatternMatcher {
  readonly engine = 're2' as const
  constructor(ctx: Context) {
    super(ctx, 're2')
  }
  abstract compile(pattern: string): unknown
  abstract match(compiled: unknown, text: string): boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    re2: Re2Matcher
  }
}

export class Re2Unsupported extends Error {
  constructor(reason: string) {
    super(`RE2 教学子集不支持：${reason}`)
    this.name = 'Re2Unsupported'
  }
}

// ── 编译：递归下降把模式编译成 NFA 程序（Thompson 构造）──
// 关键修正：每个原子指令（char/any/class）后都跟一条可 patch 的 jump，作为该片段的"出口"，
// 这样 concat / alt / 量词 / 收尾到 match 都能正确连线——否则交替与结尾会连不到 match。
type Patch = { at: number; slot: 'x' | 'y' }
interface Frag {
  start: number
  out: Patch[]
}

function patch(prog: Inst[], p: Patch, target: number): void {
  const inst = prog[p.at] as Extract<Inst, { op: 'split' }>
  inst[p.slot] = target
}

class Compiler {
  private prog: Inst[] = []
  private pos = 0
  constructor(private src: string) {}

  private peek(): string | undefined {
    return this.src[this.pos]
  }
  private eat(): string {
    return this.src[this.pos++]
  }
  private push(inst: Inst): number {
    this.prog.push(inst)
    return this.prog.length - 1
  }
  // 原子片段：push 指令 + 后接一条可 patch 的 jump（jump.x 初始指向指令后方）。
  private leaf(inst: Inst): Frag {
    const i = this.push(inst)
    const j = this.push({ op: 'jump', x: i + 2 })
    return { start: i, out: [{ at: j, slot: 'x' }] }
  }

  compile(): Re2Pattern {
    let anchoredStart = false
    if (this.peek() === '^') {
      anchoredStart = true
      this.eat()
    }
    const frag = this.parseAlt()
    let anchoredEnd = false
    if (this.peek() === '$') {
      anchoredEnd = true
      this.eat()
    }
    if (this.pos !== this.src.length) throw new Re2Unsupported(`多余字符：${this.src.slice(this.pos)}`)
    const matchIdx = this.push({ op: 'match' })
    for (const p of frag.out) patch(this.prog, p, matchIdx)
    return { source: this.src, program: this.prog, start: frag.start, anchoredStart, anchoredEnd }
  }

  private parseAlt(): Frag {
    let left = this.parseConcat()
    while (this.peek() === '|') {
      this.eat()
      const right = this.parseConcat()
      const splitIdx = this.push({ op: 'split', x: left.start, y: right.start })
      left = { start: splitIdx, out: [...left.out, ...right.out] }
    }
    return left
  }

  private parseConcat(): Frag {
    const frags: Frag[] = []
    // '$' 必须在 parseConcat 处停止，交给 compile() 外层识别为锚点——
    // 否则它会被 parseAtom 当作字面量字符吃掉，锚点语义失效。
    while (this.peek() !== undefined && this.peek() !== '|' && this.peek() !== ')' && this.peek() !== '$') {
      frags.push(this.parseRepeat())
    }
    if (frags.length === 0) {
      const jumpIdx = this.push({ op: 'jump', x: 0 })
      return { start: jumpIdx, out: [{ at: jumpIdx, slot: 'x' }] }
    }
    for (let i = 0; i < frags.length - 1; i++) {
      for (const p of frags[i].out) patch(this.prog, p, frags[i + 1].start)
    }
    return { start: frags[0].start, out: frags[frags.length - 1].out }
  }

  private parseRepeat(): Frag {
    const atom = this.parseAtom()
    const q = this.peek()
    if (q === '*' || q === '+' || q === '?') {
      this.eat()
      if (q === '*' || q === '+') {
        const splitIdx = this.push({ op: 'split', x: atom.start, y: 0 })
        for (const p of atom.out) patch(this.prog, p, splitIdx)
        return { start: q === '*' ? splitIdx : atom.start, out: [{ at: splitIdx, slot: 'y' }] }
      }
      const splitIdx = this.push({ op: 'split', x: atom.start, y: 0 })
      return { start: splitIdx, out: [...atom.out, { at: splitIdx, slot: 'y' }] }
    }
    return atom
  }

  private parseAtom(): Frag {
    const c = this.peek()
    if (c === undefined) throw new Re2Unsupported('意外结束')
    if (c === '(') {
      this.eat()
      // `(?...)` 是分组扩展（环视 / 非捕获 / 命名组 / 内联修饰符）：回溯型或本子集不支持。
      // 放行的话它会经 parseAlt 走到下面的字面量兜底，把 `?` 当普通字符吃掉——
      // `(?=.*admin)` 于是变成去匹配一个字面串 "(?=.*admin)"，规则永不命中、静默放行。
      if (this.peek() === '?') {
        throw new Re2Unsupported('分组扩展 (?...)（环视 / 非捕获 / 命名组 / 修饰符）')
      }
      const inner = this.parseAlt()
      if (this.eat() !== ')') throw new Re2Unsupported('缺少 )')
      return inner
    }
    if (c === '[') return this.parseClass()
    if (c === ')') throw new Re2Unsupported('多余的 )')
    if (c === '{') throw new Re2Unsupported('{n,m} 量词（回溯型构造）')
    // 量词出现在这个位置 = 它前面没有可作用的原子：`a**` 的第二个 `*`、`.*?` 的第二个 `?`、
    // 或孤立的 `*` / `+` / `?`。以前这里会把它们当**字面量字符**吃掉，于是 `.*?` 编译成
    // "任意字符 + 一个字面问号"——WAF 规则里 `.+?`、`.{0,}?` 是极常见的写法，写进去就永不命中。
    // 规则作者/起草 Agent 得不到任何报错，防火墙却在全放行：这是最坏的一类失败。
    if (c === '*' || c === '+' || c === '?') {
      throw new Re2Unsupported(`量词 ${c} 缺少作用对象（双重量词或孤立量词）`)
    }
    // 锚点只在模式首尾有意义（由 compile() 识别）。中间的 `^` 若当字面量，
    // 规则作者以为写了锚定，实际在匹配一个字面 ^ 字符。
    if (c === '^' || c === '$') throw new Re2Unsupported('锚点 ^ / $ 只能出现在模式首尾')
    if (c === '\\') return this.parseEscape()
    if (c === '.') {
      this.eat()
      return this.leaf({ op: 'any' })
    }
    this.eat()
    return this.leaf({ op: 'char', ch: c.toLowerCase() })
  }

  private parseClass(): Frag {
    this.eat() // [
    let negated = false
    if (this.peek() === '^') {
      negated = true
      this.eat()
    }
    const members: Array<(ch: string) => boolean> = []
    const ranges: Array<[string, string]> = []
    while (this.peek() !== ']' && this.peek() !== undefined) {
      if (this.peek() === '\\') {
        members.push(this.classEscape())
      } else {
        const ch = this.eat().toLowerCase()
        if (this.peek() === '-' && this.src[this.pos + 1] !== ']') {
          this.eat() // -
          const end = this.eat().toLowerCase()
          ranges.push([ch, end])
        } else {
          members.push((x) => x === ch)
        }
      }
    }
    if (this.eat() !== ']') throw new Re2Unsupported('缺少 ]')
    const test = (x: string): boolean => {
      const inSet = members.some((m) => m(x)) || ranges.some(([a, b]) => x >= a && x <= b)
      return negated ? !inSet : inSet
    }
    return this.leaf({ op: 'class', test })
  }

  private classEscape(): (ch: string) => boolean {
    this.eat() // backslash
    const e = this.eat()
    switch (e) {
      case 'd':
        return (x) => /[0-9]/.test(x)
      case 'D':
        return (x) => !/[0-9]/.test(x)
      case 's':
        return (x) => /\s/.test(x)
      case 'S':
        return (x) => !/\s/.test(x)
      case 'w':
        return (x) => /[A-Za-z0-9_]/.test(x)
      case 'W':
        return (x) => !/[A-Za-z0-9_]/.test(x)
      case 'n':
        return (x) => x === '\n'
      case 'r':
        return (x) => x === '\r'
      case 't':
        return (x) => x === '\t'
      default: {
        // 与 parseEscape 同一规则：数字是反向引用、字母是有语义的转义，都拒绝；
        // 标点才是字面量转义（`[\.]`、`[\[]`、`[\-]` 等）。
        if (e === undefined) throw new Re2Unsupported('\\ 后意外结束')
        if (/[0-9]/.test(e)) throw new Re2Unsupported(`字符类内的反向引用 \\${e}`)
        if (/[A-Za-z]/.test(e)) throw new Re2Unsupported(`字符类内未支持的转义 \\${e}`)
        return (x) => x === e.toLowerCase()
      }
    }
  }

  private parseEscape(): Frag {
    this.eat() // backslash
    const e = this.eat()
    if (e === undefined) throw new Re2Unsupported('\\ 后意外结束')
    // \n \r \t 是合法的字面控制字符（与字符类内的处理保持一致）。
    if (e === 'n') return this.leaf({ op: 'char', ch: '\n' })
    if (e === 'r') return this.leaf({ op: 'char', ch: '\r' })
    if (e === 't') return this.leaf({ op: 'char', ch: '\t' })
    if ('dDsSwW'.includes(e)) {
      const test = (x: string): boolean => {
        switch (e) {
          case 'd':
            return /[0-9]/.test(x)
          case 'D':
            return !/[0-9]/.test(x)
          case 's':
            return /\s/.test(x)
          case 'S':
            return !/\s/.test(x)
          case 'w':
            return /[A-Za-z0-9_]/.test(x)
          case 'W':
            return !/[A-Za-z0-9_]/.test(x)
        }
        return false
      }
      return this.leaf({ op: 'class', test })
    }
    // 转义的落点按字符类别区分，而不是一律当字面量：
    //  · 数字 = 反向引用（\1）——NFA 无法实现，必须拒绝；否则被当字面数字吃掉，
    //    规则作者以为在引用前面的分组，实际在匹配一个数字。
    //  · 字母 = 有语义的转义（\b 单词边界、\A、\p{...} 等）——本子集不支持，拒绝。
    //  · 标点 = 字面量转义（\. \( \+ \\ 等），这才是正确行为，保留。
    if (/[0-9]/.test(e)) throw new Re2Unsupported(`反向引用 \\${e}（回溯型构造）`)
    if (/[A-Za-z]/.test(e)) throw new Re2Unsupported(`未支持的转义 \\${e}`)
    return this.leaf({ op: 'char', ch: e.toLowerCase() })
  }
}

// ── 匹配：NFA 模拟（单趟多线程、线性时间、无回溯）──
//
// 为什么必须是"单趟多线程"：非锚定匹配（模式不带 ^）的朴素做法是"对每个起始位置重跑一遍
// NFA"，那是 O(n²)——带 `.*` 前缀的模式在**不匹配**的长正文上，每个起点都要扫到结尾，
// 8KB 正文（正好是入口允许的上限）约 3300 万步，单请求就能打到秒级 CPU。
// 正确做法是同时推进所有起点：每个位置把起点重新注入活跃集，整趟只扫一遍文本 → O(n·m)。

// 真正的 RE2 Provider：编译 + 匹配都走 NFA，绝不用 new RegExp。
export class SafeRe2Matcher extends Re2Matcher {
  compile(pattern: string): Re2Pattern {
    try {
      return new Compiler(pattern).compile()
    } catch (err) {
      if (err instanceof Re2Unsupported) throw err
      throw new Re2Unsupported((err as Error).message)
    }
  }

  match(compiled: unknown, text: string): boolean {
    // 契约里编译结果是不透明值；本实现知道它就是 Re2Pattern。断言收在**实现内部**这一处，
    // 好过让每个调用方各写一个 `as unknown as` ——后者会让编译器不再检查契约是否成立。
    const pattern = compiled as Re2Pattern
    // matches 大小写不敏感（WAF 常见做法）：匹配前把文本归一为小写。
    const lower = text.toLowerCase()
    const prog = pattern.program
    // visited 用"版本号数组"代替每步 new Set：热路径上每个状态一次 Set 分配 + 一次
    // Array.from 去重，是原实现除 O(n²) 之外的第二大开销。
    const seen = new Int32Array(prog.length)
    let stamp = 0
    // 闭包里遇到 match 就置位，省掉每次判定的 O(m) 遍历（containsMatch）。
    let hasMatch = false

    // 步数预算：单趟复杂度是 O(n·m)。在 closure 里累计**真实**工作量——每次真正处理一个
    // 程序状态（seen 去重后命中）计一步。超出说明程序或输入异常，抛错让强制点拒绝
    // （判定不了 = 拒绝），绝不让一次匹配把 CPU 吃掉。
    // （原来把 `++steps` 放在每字符外层循环里，最大值 = 文本长度 n，而 budget ≥ n+1，
    // 于是恒 false、永不抛——是条死守卫，读者却以为有防失控兜底。）
    const budget = prog.length * (lower.length + 1) + 1024
    let steps = 0

    const closure = (list: number[], pc: number): void => {
      if (seen[pc] === stamp) return
      seen[pc] = stamp
      if (++steps > budget) {
        throw new Re2Unsupported(`匹配步数超出预算（模式 ${pattern.source} / 文本长度 ${lower.length}）`)
      }
      const inst = prog[pc]
      if (inst.op === 'split') {
        closure(list, inst.x)
        closure(list, inst.y)
      } else if (inst.op === 'jump') {
        closure(list, inst.x)
      } else {
        if (inst.op === 'match') hasMatch = true
        list.push(pc) // char/any/class/match 都是"消耗/终态"，无 epsilon 出边
      }
    }

    let list: number[] = []
    stamp++
    hasMatch = false
    closure(list, pattern.start)
    // 零宽匹配（如 `a*` 在空文本上）：位置 0 先判一次。
    if (hasMatch && (!pattern.anchoredEnd || lower.length === 0)) return true

    for (let i = 0; i < lower.length; i++) {
      const c = lower[i]
      const next: number[] = []
      stamp++
      hasMatch = false
      for (const pc of list) {
        const inst = prog[pc]
        if (inst.op === 'char' && inst.ch === c) closure(next, pc + 1)
        else if (inst.op === 'any' && c !== '\n') closure(next, pc + 1)
        else if (inst.op === 'class' && inst.test(c)) closure(next, pc + 1)
      }
      // 非锚定：下一步之前把起点重新注入活跃集——这条额外线程就是"同时从任意位置起匹配"，
      // 它取代了原来"对每个起点重跑一遍"的 O(n²) 做法。
      if (!pattern.anchoredStart) {
        stamp++
        closure(next, pattern.start)
      }
      list = next
      if (list.length === 0) return false // 活跃集空了，后续不可能再匹配上
      if (hasMatch) {
        if (!pattern.anchoredEnd) return true
        if (i + 1 === lower.length) return true
      }
    }
    return false
  }
}

/**
 * 守卫：matcher 必须是真正的 RE2 实现。
 *
 * **不能用 `instanceof SafeRe2Matcher`**——它有两类问题：
 *  ① 挡不住绕过：一行 `class Evil extends SafeRe2Matcher { compile/match 用 RegExp }`
 *     就是子类实例，`instanceof` 直接放行，守卫形同虚设；
 *  ② 会误拒：合法的替代实现（native node-re2 绑定、给本类加缓存的装饰器类）
 *     都不是 `SafeRe2Matcher` 的实例，于是被拒——这与"能力 seam / Provider 可替换"自相矛盾。
 *
 * 所以改成**行为指纹**：用已知输入探测它是否满足 RE2 的两条硬承诺。
 */
export function assertRealRe2(matcher: unknown): void {
  const m = matcher as PatternMatcher
  if (!m || typeof m.compile !== 'function' || typeof m.match !== 'function') {
    throw new Error('拒绝加载：matcher 不是合法的 PatternMatcher（缺少 compile / match）')
  }
  // 指纹 1：真能匹配。挡住"什么都不匹配"的假实现——那会让所有规则静默失效（= 全放行）。
  let matched = false
  try {
    matched = m.match(m.compile('admin'), 'xxadminxx')
  } catch (err) {
    throw new Error(`拒绝加载：matcher 在匹配指纹上抛错：${(err as Error).message}`)
  }
  if (!matched) {
    throw new Error('拒绝加载：matcher 未通过匹配指纹（compile("admin") 匹配不上 "xxadminxx"）')
  }
  // 指纹 2：遇到不支持的构造必须抛错——这是"永不回退 RegExp"的核心承诺。
  // RegExp 与 PCRE 都接受 {n,m}，所以这条能挡住用 RegExp 实现的替身。
  let rejected = false
  try {
    m.compile('a{2,3}')
  } catch {
    rejected = true
  }
  if (!rejected) {
    throw new Error('拒绝加载：matcher 接受了 {n,m} 这类回溯型构造，疑似回退到 RegExp。RE2 不回退 RegExp。')
  }
}
