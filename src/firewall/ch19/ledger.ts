// src/firewall/ch19/ledger.ts —— ledger：把四类事件折叠成状态，发布串行，原子写文件
//
// 设计要点（对应第19讲"必讲"）：
//  • 账本 = 会话日志的投影：四类 dsh 已知事件（rule.add / rule.update / rule.reject / rule.remove）折叠成当前规则集。
//  • 发布串行（writeChain）：同一进程内并发修改排队执行，一次失败自动恢复、不毒化后续发布。
//  • 原子写：临时文件 + rename（对应真实部署的 @deepseek-ai/dsh-atomic-write，此处用等价实现，避免 API 假设）。
//  • 带外修改补记：人直接改文件后即时生效，并补记事件对账。
//  • 重启恢复：从会话日志（JSONL）重新折叠事件（logged -> 可重建，单向保证），已实测。
//  • 特别需要关注：ledger 的 sessionId 必须等于 agents 条目的 sessionId。
//
// 账本事实真的写进 dsh 会话日志（见 session-log.ts），不是本地模拟；规则文件只是投影产物。
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { isValidCondition } from '../ch18/condition.ts'

export type RuleAction = 'deny' | 'allow'
/**
 * `rejected`：**驳回/下线是归档，不是删除**。
 * 若把驳回实现成"从账本里抹掉"，这条规则就凭空消失了——"被谁、何时、为什么驳回"
 * 再也回答不了，审计时只能看到一个空缺。所以它必须作为一个状态留在账本里。
 * （真正的删除另有 `rule.remove`，两者语义不同：一个是归档留痕，一个是清理。）
 */
export type RuleState = 'candidate' | 'active' | 'rejected'
export interface RuleInput {
  name: string
  action: RuleAction
  when: unknown
  unless?: unknown
}
export interface Rule extends RuleInput {
  id: string
  state: RuleState
}

// 三种账本事件，作为"已知载体"写进 dsh 会话日志（不用自定义事件类型——
// 仓库外插件写自定义事件会让重启后的会话无法加载）。
export type RuleEvent =
  | { type: 'rule.add'; id: string; input: RuleInput; at: number; state?: RuleState }
  | { type: 'rule.update'; id: string; patch: Partial<RuleInput>; at: number; state?: RuleState }
  // 驳回 / 下线：把规则标成 rejected 并**留在账本里**，同时记下是谁、为什么。
  // `rule.remove` 仍是"删除"（清理），两者不可混用。
  | { type: 'rule.reject'; id: string; at: number; by?: string; reason?: string }
  | { type: 'rule.remove'; id: string; at: number }

// ── 事实校验：读侧与写侧共用**同一份**校验器 ──
//
// 为什么两侧都要校验、且必须是同一份：
// 只做读侧的话，一条形状非法的事实（比如 when 缺 op）会被写进会话日志、读回时又被丢弃
// ——规则于是"**静默蒸发**"：日志里有这条事实、权威里却没有这条规则，verifyFacts 永久
// 不一致，而且查不出原因（日志看着是对的）。只做写侧的话，又挡不住"人直接改了日志文件"。
//
// 放在本文件是因为：session-log.ts 已经依赖 ledger.ts，反过来 import 会形成循环依赖。
const RULE_STATES: ReadonlySet<string> = new Set(['candidate', 'active', 'rejected'])
const RULE_ACTIONS: ReadonlySet<string> = new Set(['deny', 'allow'])

/**
 * 一条规则的必填项：name 非空、action 合法、when 是 ch18 认可的合法条件树。
 * 写成 **type guard**（而不是返回 boolean）：调用方校验完就能直接用类型收窄的结果，
 * 不必再写一遍 `as`（那种断言会让编译器停止检查，于是"校验"与"使用"可以悄悄漂移）。
 */
export function isValidRuleInput(value: unknown): value is RuleInput {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  if (typeof r.name !== 'string' || r.name === '') return false
  if (typeof r.action !== 'string' || !RULE_ACTIONS.has(r.action)) return false
  // `unless` 是**在 deny 规则上开洞**的那个字段：它若形状非法，取值会变成 undefined，
  // 于是 `ne` 恒真 → 例外恒命中 → 那条 deny 规则永不触发 → 全放行。
  // 只校验 `when` 不校验 `unless`，等于把闸门开了一半——`applyOutOfBand`（带外补记
  // 与启动时 adoption）就是绕过去的那条路径，它会把投影文件里的非法 unless 原样
  // 写进权威。闸门唯一该在的位置是"写进权威这一步"，所以两个字段都要过。
  if (r.unless !== undefined && !isValidCondition(r.unless)) return false
  // when 复用 ch18 那一份校验器：跨讲契约只认一处，避免这里再写一遍而与之漂移。
  return isValidCondition(r.when)
}

/**
 * 账本事实是否形状合法。
 *
 * 逐字段校验，只查 id/type 是不够的：
 *  · `state` 任取（"ACTIVE"、""）会让折叠出的规则状态非法，判定行为不可预测；
 *  · `at` 不是数字，排障与按时间排序都会出错；
 *  · `input` 缺 name/action/when 的话，规则入库后要么拦不住东西、要么恒真。
 */
export function isValidRuleEvent(value: unknown): value is RuleEvent {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || v.id === '') return false
  if (typeof v.at !== 'number' || !Number.isFinite(v.at)) return false
  if (v.state !== undefined && (typeof v.state !== 'string' || !RULE_STATES.has(v.state))) return false
  switch (v.type) {
    case 'rule.remove':
      return true
    case 'rule.reject':
      // by / reason 可选，但**出现了**就必须是字符串：否则"被谁驳回"读出来是个对象，
      // 界面无从显示，日志里也就留下一条说不清的事实。
      if (v.by !== undefined && typeof v.by !== 'string') return false
      if (v.reason !== undefined && typeof v.reason !== 'string') return false
      return true
    case 'rule.add':
      return isValidRuleInput(v.input)
    case 'rule.update': {
      if (typeof v.patch !== 'object' || v.patch === null) return false
      const p = v.patch as Record<string, unknown>
      // patch 是部分更新：字段都可选，但**出现的**必须是合法值。
      if (p.name !== undefined && typeof p.name !== 'string') return false
      if (p.action !== undefined && (typeof p.action !== 'string' || !RULE_ACTIONS.has(p.action))) return false
      if (p.when !== undefined && !isValidCondition(p.when)) return false
      if (p.unless !== undefined && !isValidCondition(p.unless)) return false
      return true
    }
    default:
      return false
  }
}

/** 校验失败就抛错，并带上收到的值——让人能直接照着改，而不是只看到"写入失败"。 */
export function assertValidRuleEvent(value: unknown, where: string): RuleEvent {
  if (!isValidRuleEvent(value)) {
    throw new Error(`${where}：账本事实形状不合法 ${JSON.stringify(value)}`)
  }
  return value
}

export interface LedgerDoc {
  version: number
  sessionId: string
  events: RuleEvent[]
  rules: Rule[] // 投影缓存，可由 events 折叠得到
}

// 折叠：把事件序列还原成"当前规则集"。这是"logged -> 可重建"单向保证的落点。
export function fold(events: RuleEvent[]): Rule[] {
  const map = new Map<string, Rule>()
  for (const e of events) {
    if (e.type === 'rule.add') {
      // 默认 candidate（而不是 active）：本讲主张"第一稿只是候选、批准才生效"，
      // 缺省必须是更安全的那一侧，避免漏传 state 就让规则直接生效。
      map.set(e.id, { ...e.input, id: e.id, state: e.state ?? 'candidate' })
    } else if (e.type === 'rule.update') {
      const r = map.get(e.id)
      if (r) map.set(e.id, { ...r, ...e.patch, state: e.state ?? r.state })
    } else if (e.type === 'rule.reject') {
      // 驳回**不是删除**：规则留在账本里、标成 rejected，于是"它被驳回了、什么时候
      // （事件里的 at）、被谁（by）、为什么（reason）"都能回答。
      // 若在这里 `map.delete(e.id)`，这条规则就凭空消失了——审计时只剩一个空缺。
      const r = map.get(e.id)
      if (r) map.set(e.id, { ...r, state: 'rejected' })
    } else {
      map.delete(e.id)
    }
  }
  return [...map.values()]
}

function strip(r: Rule): RuleInput {
  // 显式取字段，而不是 rest 解构——后者会留下两个"声明了却没用"的变量。
  // unless 只在**存在时**才建这个键：恒带 `unless: undefined` 会让 update patch 里出现
  // `unless: undefined`——fold 的 spread 会据此清掉内存里的 unless，但 JSON 序列化会
  // 丢掉这个键，于是"清除 unless"这件事没落盘，重启后 unless 回弹。
  const out: RuleInput = { name: r.name, action: r.action, when: r.when }
  if (r.unless !== undefined) out.unless = r.unless
  return out
}

// 深比较（when / unless 是嵌套对象，不能拿 JSON.stringify 比——键顺序一变就误判成"改过了"）。
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const ka = Object.keys(a as object).sort()
  const kb = Object.keys(b as object).sort()
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

/** 两条规则是否内容相同（按键顺序无关的方式比较，供对账复用）。 */
export function sameRule(a: Rule, b: Rule): boolean {
  return (
    a.name === b.name &&
    a.action === b.action &&
    a.state === b.state &&
    deepEqual(a.when, b.when) &&
    deepEqual(a.unless ?? null, b.unless ?? null)
  )
}

// 原子写：先写临时文件再 rename（POSIX 下原子），进程写一半崩溃也看不到半截。
function atomicWrite(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

/**
 * 账本事实的**权威**存储。由 dsh 会话日志实现（`session-log.ts` 的 `LedgerLogService`）。
 * 定义成接口而不是直接引用那个类，是为了让 ledger.ts 不必反向依赖会话层（避免循环）。
 */
export interface FactLog {
  readonly sessionId: string
  appendFact(fact: RuleEvent): void
  /** 读回权威里的全部事实（已按来源与形状校验过）。 */
  facts(): RuleEvent[]
  /** 由事实折叠出的当前状态——权威，任何时候都不从文件读。 */
  state(): Rule[]
}

/**
 * 账本：权威在会话日志，文件只是给数据面读的**投影产物**。
 *
 * 发布顺序是"先写权威、再投影产物"——反过来（先写文件）就会出现
 * "文件里有、日志里没有"的状态，那正是本讲要避免的（文件不能反过来充当历史）。
 */
export class Ledger {
  private writeChain: Promise<void> = Promise.resolve()

  /**
   * @param log  **权威**：账本事实落在 dsh 会话日志上
   * @param file **产物**：给数据面读的规则文件，随时可由折叠结果重建
   */
  constructor(
    private log: FactLog,
    private file: string,
    agentsSessionId: string,
  ) {
    // 特别需要关注：sessionId 必须等于 agents 条目的，否则追溯不到对应会话。
    if (log.sessionId !== agentsSessionId) {
      throw new Error(`ledger sessionId (${log.sessionId}) 必须等于 agents 条目的 sessionId (${agentsSessionId})`)
    }
  }

  /** 权威：状态永远由会话日志折叠得到。 */
  listRules(): Rule[] {
    return this.log.state()
  }

  /**
   * 启动时对账：会话日志为空、文件却有内容（上一次运行的产物，或人直接改过），
   * 就把它当成一次**带外修改**补记进权威——此后文件只作为投影存在。
   */
  async adoptProjection(): Promise<void> {
    if (this.log.state().length > 0) return
    const read = readProjectionFile(this.file)
    if (read.kind === 'missing') return // 首次运行：还没有产物，正常
    if (read.kind === 'corrupt') {
      // 损坏 ≠ 空。当成空处理会让下一步投影用 [] 覆盖磁盘内容——规则永久丢失且无任何报错。
      // 所以：保留现场（复制一份供人工恢复），并拒绝带着不确定的状态继续。
      const backup = `${this.file}.corrupt`
      try {
        copyFileSync(this.file, backup)
      } catch {
        // 复制失败不影响主判断：原文件仍在，只是少一份副本。
      }
      throw new Error(
        `账本投影文件无法解析，已复制一份到 ${backup}（原文件原样保留）：${read.reason}。` +
          `请修好或删除该文件后重启——不要以空规则库启动，那会覆盖磁盘上的真实内容。`,
      )
    }
    if (read.rules.length > 0) await this.applyOutOfBand(read.rules)
  }

  /**
   * 发布：先写会话日志（权威），再把折叠结果投影成文件（产物）。串行，互不踩。
   *
   * 【已知限制】`writeChain` 是**实例级**的：两个 Ledger 实例（同一进程里 new 两次，
   * 或跨进程）指向同一份 fact log / 同一个投影文件时，两条写链互不知晓，投影文件会
   * 互相覆盖（后 rename 者赢）。跨进程部署需要文件锁，或把投影写收归单一进程。
   */
  publish(event: RuleEvent): Promise<void> {
    const p = this.writeChain.then(() => this.applyEvent(event))
    // 写链只负责**串行**，不负责传播。
    // 若把 rejected 的 promise 直接赋回 `writeChain`（原来的写法），一次瞬时写入失败
    // 会把这条链**永久废掉**：之后每一次 publish / applyOutOfBand 都直接返回第一次那条
    // 陈旧错误，且 `then` 的回调根本不执行——起草、批准、驳回、带外补记全部失效，
    // 报的还都不是当下的错。一次抖动不该放大成永久性不可用。
    this.writeChain = p.catch(() => {})
    return p
  }

  /** 写链内的一步：追加事实 + 重新投影。只应在 writeChain 的 then 里调用。 */
  private applyEvent(event: RuleEvent): void {
    this.log.appendFact(event)
    this.writeProjection()
  }

  /**
   * 带外修改：人直接改了文件——把差异补记成事件，再由新的权威重新投影。
   *
   * 【已知取舍，不是疏漏】补记时会**采信文件里的 state**：人把某条改成 active，
   * 补记后就真的是 active（这是本讲"人直接改文件即时生效"的设计意图，人是最高权限）。
   * 代价是：能改这个文件的人（或拿到写权限的攻击者）可以在启动时让规则以 active 落地，
   * 绕开 tools/pre-execute 审批闸与自主级别。
   * 若部署环境里这个文件并非只有规则管理员可写，应当把补记一律降级为 candidate
   * （把下面 `state: r.state` 改成 `state: 'candidate'`），再走正常审批。
   */
  async applyOutOfBand(nextRules: Rule[]): Promise<void> {
    // diff 必须与补记落在**同一段写链**里。
    // 否则：快照算完之后、逐条补记执行之前，另一个 publish 可能插进来新增一条规则；
    // 而这份**陈旧快照**里没有它，diff 就会发出 rule.remove —— 那条新规则被静默删掉。
    const p = this.writeChain.then(() => {
      const current = new Map(this.log.state().map((r) => [r.id, r]))
      const next = new Map(nextRules.map((r) => [r.id, r]))
      const events: RuleEvent[] = []
      for (const [id, r] of next) {
        const prev = current.get(id)
        if (!prev) {
          events.push({ type: 'rule.add', id, input: strip(r), at: Date.now(), state: r.state })
        } else if (!sameRule(prev, r)) {
          if (prev.unless !== undefined && r.unless === undefined) {
            // 人从投影文件里删掉了 unless（收口）：用 remove + add 重建，而不是 update。
            // update 的 patch 无法表达"清除 unless"（JSON 会丢掉 `unless: undefined` 键，
            // 重启后 unless 回弹，收的口子重新打开）。remove+add 让这个意图落成两条
            // 可重放的事实，审计里也能看出"这条规则被重建过"。
            events.push({ type: 'rule.remove', id, at: Date.now() })
            events.push({ type: 'rule.add', id, input: strip(r), at: Date.now(), state: r.state })
          } else {
            events.push({ type: 'rule.update', id, patch: strip(r), at: Date.now(), state: r.state })
          }
        }
      }
      for (const id of current.keys()) {
        if (!next.has(id)) events.push({ type: 'rule.remove', id, at: Date.now() })
      }
      for (const e of events) this.applyEvent(e)
    })
    // 与 publish 对齐：写链只管串行、不管传播。否则一次带外补记失败会把链毒化，
    // 之后每次 publish / applyOutOfBand 都返回第一次那条陈旧错误且回调不执行。
    this.writeChain = p.catch(() => {})
    return p
  }

  /** 文件只是产物：由当前折叠结果原子重写，任何时候都能重建。 */
  private writeProjection(): void {
    atomicWrite(this.file, JSON.stringify({ sessionId: this.log.sessionId, rules: this.log.state() }, null, 2))
  }
}

/** 投影文件的读取结果：**必须**区分"没有文件"与"文件读不出来"。 */
export type ProjectionRead =
  | { kind: 'missing' } // 还没有产物（首次运行），正常
  | { kind: 'ok'; rules: Rule[] }
  | { kind: 'corrupt'; reason: string } // 有文件但读不出/解析不了

/**
 * 读取投影文件，区分三种结果。
 *
 * 关键：**文件读不出来 ≠ 文件里没有规则**。若把它当成"空"，下一步投影就会用 `[]`
 * 覆盖掉磁盘上的内容——那些规则就此永久丢失，而且全程没有任何报错。
 * （原来的实现正是这样做的，注释还写着"改坏文件保留好内容"，实际什么都没保留。）
 */
export function readProjectionFile(file: string): ProjectionRead {
  if (!existsSync(file)) return { kind: 'missing' }
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return { kind: 'corrupt', reason: `无法读取投影文件（${code ?? '未知错误'}）：${file}` }
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    const rules = (parsed as { rules?: unknown } | null)?.rules
    if (!Array.isArray(rules)) return { kind: 'corrupt', reason: `投影文件顶层缺少 rules 数组：${file}` }
    return { kind: 'ok', rules: parseProjectionRules(rules, file) }
  } catch (err) {
    return { kind: 'corrupt', reason: `投影文件解析失败：${(err as Error).message}（${file}）` }
  }
}

/**
 * **逐条**校验投影文件里的规则。
 *
 * 不校验的话（原来就是一句 `rules as Rule[]`），一条形状非法的规则会被原样补记进权威：
 * `state` 拼成 "ACTIVE"、缺 when、action 写成 "DROP"……写侧校验（`appendFact`）最终
 * 也会拒掉它，但那时报错说的是"账本事实不合法"，而真正的问题在**文件里的第几条**——
 * 排障要绕一圈。这里提前一步说清，指到具体那一条。
 */
function parseProjectionRules(raw: unknown[], file: string): Rule[] {
  return raw.map((r, i) => {
    const where = `投影文件 ${file} 第 ${i + 1} 条`
    if (typeof r !== 'object' || r === null) throw new Error(`${where}：必须是对象，收到 ${JSON.stringify(r)}`)
    const x = r as Record<string, unknown>
    if (typeof x.id !== 'string' || x.id === '') {
      throw new Error(`${where}：id 必须是非空字符串，收到 ${JSON.stringify(x.id)}`)
    }
    if (typeof x.state !== 'string' || !RULE_STATES.has(x.state)) {
      throw new Error(`${where}：state 必须是 ${[...RULE_STATES].join(' / ')} 之一，收到 ${JSON.stringify(x.state)}`)
    }
    if (!isValidRuleInput(x)) {
      throw new Error(
        `${where}：name / action / when 不合法，收到 ${JSON.stringify({ name: x.name, action: x.action, when: x.when })}`,
      )
    }
    // unless 只在**存在时**才建这个键：折叠结果（`{...input, id, state}`）也是这个形状，
    // 两者必须逐键一致——多一个 `unless: undefined` 键就会让"权威 vs 产物"的对账失败。
    const rule: Rule = { id: x.id, name: x.name, action: x.action, when: x.when, state: x.state as RuleState }
    if (x.unless !== undefined) rule.unless = x.unless
    return rule
  })
}

/**
 * 读取文件产物里的规则（仅用于启动对账与校验，权威仍在会话日志）。
 * 文件损坏时**抛错**而不是静默返回空——静默返回空会让调用方以为"磁盘上没有规则"，
 * 进而用空内容覆盖真实数据。需要区分三态时用 {@link readProjectionFile}。
 */
export function readProjection(file: string): Rule[] {
  const read = readProjectionFile(file)
  if (read.kind === 'missing') return []
  if (read.kind === 'corrupt') throw new Error(read.reason)
  return read.rules
}
