// src/firewall/ch21/loop.ts —— 闭环：shadow / 灰度 / 自动回退 / 老化 + 连续实验（误伤、放过都变信号）
//
// 对应第21讲"规则上线后在放了坏事与误伤之间持续平衡"：候选转正后进入生命周期管理。
// 候选转正涉及"自动/灰度"时由第19讲自主级别控制（import 自 ch19 的 AutonomyLevel）。
import { randomUUID } from 'node:crypto'
import type { AutonomyLevel } from '../ch19/command-firewall'
import type { NginxLine } from '../ch20/observe'

export type Stage = 'proposed' | 'shadow' | 'canary' | 'active' | 'rolled_back' | 'aged_out'

/**
 * 合法转移表。
 *
 * 写成显式表格而不是散落在各个 `if` 里，是为了让"哪些转移合法"一眼可查，并且**任何**
 * 阶段变更都要过它（包括 `init`）。这堵住两类洞：
 *  1) 外部直接改阶段跳过关卡——原来 `stage` 是公开可写字段，demo 里就有一处
 *     `lc3.stage = 'canary'` 在绕过确认直接进灰度；
 *  2) 终态复活——`rolled_back` / `aged_out` 必须是终点，不能靠一次 observe 又活过来。
 */
const TRANSITIONS: Record<Stage, readonly Stage[]> = {
  // 起草后：推进到 shadow（影子观察）；级别 2 且关卡已过时可**直接**进灰度；不推进就老化。
  proposed: ['shadow', 'canary', 'aged_out'],
  // 影子期：由人或系统推进到灰度（真正开始拦截）——这条边原先在代码里**根本不存在**，
  // 于是级别 1 下的候选会永远停在 shadow，直到被老化移出。
  shadow: ['canary', 'aged_out'],
  // 灰度期：达标转 active；误伤超阈值自动回退；长期无命中老化。
  canary: ['active', 'rolled_back', 'aged_out'],
  active: ['rolled_back', 'aged_out'],
  rolled_back: [], // 终态：不可复活，要重新上线就重新走一遍流程
  aged_out: [], // 终态
}

/** 终态：不再接受任何转移。 */
const isTerminal = (stage: Stage): boolean => TRANSITIONS[stage].length === 0

export interface LoopConfig {
  autonomyLevel: AutonomyLevel
  fpThreshold: number // 灰度期误伤率上限，超则自动回退
  staleHits: number // 连续无命中达到此数 → 老化
  /**
   * 启用"误伤率超阈值即回退"所需的**最小正常样本数**，默认 20。
   *
   * 没有这个门槛时，`goodTotal === 1` 的那一次误伤算出来是 100%，
   * 于是一条规则被**单条噪声观测**永久判死——回退落盘后要靠 reinstate 才能解除，
   * 闭环状态落盘之后连重启都救不回来。样本不足时应当继续观察，而不是下终审判决。
   */
  minGoodTotal?: number
}

/** 默认的最小正常样本数（见 LoopConfig.minGoodTotal）。 */
export const DEFAULT_MIN_GOOD_TOTAL = 20

export interface Signal {
  falsePositives: number // 误伤信号（拦了正常的）
  missedTrue: number // 放过信号（没拦住坏的）
  hits: number // 命中计数
  /**
   * 见到的**正常请求**总数——误伤率的分母。
   *
   * 必须单独记：只看 fp/hits 的话，算出来的是 1−精确率，与第 21 讲评测里的
   * falsePositiveRate（误伤的正常 / 所有正常）**不是同一个量**。两处若各用一套定义，
   * 阈值就会对不上，出现"评测判 0.3% 可控放行、进灰度后按另一套算法 3% 立刻回退"的矛盾。
   */
  goodTotal: number
}

// 对一个候选规则做生命周期管理。observe 每来一个请求更新信号并可能转移阶段。
export class RuleLifecycle {
  private _stage: Stage = 'proposed'
  private _signal: Signal = { falsePositives: 0, missedTrue: 0, hits: 0, goodTotal: 0 }
  /** 被放过的请求（漏拦的坏请求）本身——不是计数，是请求，供回接喂回证据库（见 `drainMissed`）。 */
  private missedLines: NginxLine[] = []
  // 自上次命中以来的观测次数。老化看的是"连续多久没命中"，
  // 而不是累计命中数——否则命中过一次就永远不会老化，与防膨胀的设计意图相反。
  private missesSinceHit = 0
  /**
   * 最近一次阶段变更的**原因**（供审计）。
   *
   * 这个字段存在与否，直接决定落盘的事件归因是真是假：以前后台任务把回退原因硬编码成
   * "灰度期误伤率超过阈值"，于是**人工** `promote('rolled_back')` 或 active 期的回退
   * 落盘后都会显示成误伤回退——审计日志里出现假归因。所以原因必须由产生这次转移的
   * 那一方（转移本身）给出，而不是由搬运者（后台任务）猜。
   */
  private _reason?: string

  /**
   * @param id 这条闭环的标识。**必须**与它所管理的规则 id 一致（默认随机生成一个）。
   *   有 id 才能回答"哪条规则被回退了 / 什么时候"，也让后台任务能拒绝"已被判死的
   *   同一条规则重新进入闭环"——否则一条刚被回退的规则换个实例就能重新灰度。
   */
  constructor(
    private cfg: LoopConfig,
    readonly id: string = randomUUID(),
  ) {}

  /** 当前阶段（只读）。要变更只能走 `promote` / `init`，且必须过转移表。 */
  getStage(): Stage {
    return this._stage
  }

  /**
   * 最近一次转移决策的原因（只读）。调用方（后台任务）落盘时应如实搬运它，
   * 不要自己编——编出来的归因会让审计日志失真。
   *
   * 注意它不仅覆盖"发生了阶段变更"，也覆盖"决定**不**转移"的诊断（如样本不足、暂不回退）：
   * 那个诊断同样是要落到审计里的关键信息——它解释了一条误伤规则为什么还留在线上。
   */
  getReason(): string {
    return this._reason ?? '（未记录原因）'
  }

  /** 信号快照（只读副本）：外部不能改 hits / 误伤数来伪造"达标"。 */
  getSignal(): Readonly<Signal> {
    return { ...this._signal }
  }

  /**
   * 显式推进（人确认，或系统判定达标）。走转移表，非法转移直接抛错。
   * 这是原先缺失的那条边：没有它，"shadow → 灰度 → active"这条主链路在代码里不存在。
   */
  promote(to: Stage, reason = '人 / 系统显式推进'): Stage {
    this.setStage(to, reason)
    return this._stage
  }

  /** 当前能否推进到目标阶段（供调用方提前判断，而不是抛错后才知道）。 */
  canPromote(to: Stage): boolean {
    return TRANSITIONS[this._stage].includes(to)
  }

  // 初始阶段：off → 不转正；manual/0 → 需人确认（停 proposed）；1 → shadow；2 → 风险已过则自动灰度。
  init(autoConfirmAllowed: boolean): Stage {
    switch (this.cfg.autonomyLevel) {
      case 'off':
      case '0':
      case 'manual':
        break // 停在 proposed：等人用 promote 推进，不能自动生效
      case '1':
        this.setStage('shadow', 'init：进入影子观察')
        break
      case '2':
        this.setStage(
          autoConfirmAllowed ? 'canary' : 'shadow',
          autoConfirmAllowed ? 'init：确认三关卡全过，进灰度' : 'init：确认三关卡未全过，停在影子',
        )
        break
      default: {
        // 穷尽性保护：AutonomyLevel 若新增取值，这里会在编译期报错，而不是静默走到默认分支。
        const unreachable: never = this.cfg.autonomyLevel
        throw new Error(`未知自主级别: ${String(unreachable)}`)
      }
    }
    return this._stage
  }

  // 一个请求到达：blocked = 候选是否会拦它；actualBad = 它真是坏的吗（Oracle）。
  // line 是原始日志行（可选）：只有"放过"时才留下它——计数只够回答"漏了几次"，
  // 要让下一轮知道"漏的是**什么**"，必须留住这条请求本身（见 drainMissed）。
  observe(blocked: boolean, actualBad: boolean, line?: NginxLine): void {
    if (this._stage === 'shadow' || this._stage === 'canary' || this._stage === 'active') {
      if (blocked) {
        this._signal.hits++
        this.missesSinceHit = 0
        if (!actualBad) this._signal.falsePositives++ // 误伤：拦了正常的 → 信号
      } else {
        this.missesSinceHit++
        if (actualBad) {
          this._signal.missedTrue++ // 放过：没拦住坏的 → 信号
          if (line) this.missedLines.push(line)
        }
      }
      // 正常请求无论拦没拦，都计入误伤率的分母（漏了这一行，分母就变成"命中数"了）。
      if (!actualBad) this._signal.goodTotal++
    }
    this.transition()
  }

  /**
   * 取出并清空"被放过的请求"（drain 语义），供回接喂回证据库。
   *
   * 用 drain 而不是 getter，是为了让"喂过一次"**不可逆**：若同一个漏拦样本每轮都被重复喂回，
   * 证据库里这一条会越积越多，下一轮模型眼里就只剩它——那正是第 20 讲抗挤占采样要防的
   * 事（一类刷屏挤掉别类），回接侧不能自己再犯一遍。
   */
  drainMissed(): NginxLine[] {
    const out = this.missedLines
    this.missedLines = []
    return out
  }

  /**
   * 记录一次"**没有新观测**"（后台任务的定时器滴答）。
   *
   * 它**只推进老化**，绝不计入误伤率的分母。滴答不是真实请求：若把它当成一次
   * `observe(false, false)`，分母 `goodTotal` 会被灌到几百，于是真实的误伤被稀释到
   * 阈值以下 → **永不回退**。运行越久稀释越强（滴答越多，一次真实误伤的占比越小），
   * 这条回退守卫等于被自己的心跳关掉。
   *
   * 以前后台任务正是用 `observe(false, false)` 冒充一次请求观测，所以这个方法必须存在。
   */
  noteIdle(): void {
    if (!isTerminal(this._stage)) this.missesSinceHit++
    this.transition()
  }

  private transition(): void {
    // 终态不再转移：已经回退/老化的规则不能被后续观测复活，也不会被老化覆盖。
    if (isTerminal(this._stage)) return

    // 自动回退：灰度/active 期误伤率超阈值 → 回退。
    if (this._stage === 'canary' || this._stage === 'active') {
      // 误伤率 = 误伤的正常 / 见到的正常——与评测里的 falsePositiveRate 同一定义。
      const rate = this._signal.goodTotal === 0 ? 0 : this._signal.falsePositives / this._signal.goodTotal
      const minGood = this.cfg.minGoodTotal ?? DEFAULT_MIN_GOOD_TOTAL
      const overThreshold = rate > this.cfg.fpThreshold
      // 门槛只保护**灰度期**（canary）：防止单条噪声把一条还在观察的规则判死。
      // active 已经是全量拦截、误伤在伤害真实用户，不套这个保守门槛，直接回退。
      const sufficient = this._stage === 'active' || this._signal.goodTotal >= minGood
      if (overThreshold && sufficient) {
        // 样本充足（或已在全量拦截）且误伤率超阈值 → 回退。
        this.setStage(
          'rolled_back',
          `误伤率 ${(rate * 100).toFixed(1)}% 超过阈值 ${(this.cfg.fpThreshold * 100).toFixed(1)}%（正常样本 ${this._signal.goodTotal} 条）`,
        )
        return
      }
      if (overThreshold && !sufficient) {
        // 样本不足但已见误伤：**只跳过回退判定**（不在此处 return）；灰度达标转 active 的判断在下面，独立于此。
        // 少了这道门槛，`goodTotal === 1` 的那一次误伤算出来就是 100%，
        // 于是一条规则被**单条噪声观测**永久判死（回退是终态，落盘后连重启都救不回来）。
        this._reason =
          `误伤率 ${(rate * 100).toFixed(1)}%，但正常样本仅 ${this._signal.goodTotal} 条` +
          `（不足 ${minGood} 条）：暂不判定回退，继续观察`
      }
      // 灰度达标转 active：与误伤率门槛**无关**，不能被样本不足一并卡住。
      if (this._stage === 'canary' && this._signal.hits >= 3) {
        this.setStage('active', `灰度达标：命中 ${this._signal.hits} 次`)
      }
    }
    // 老化：连续 staleHits 次没命中 → 移出，避免规则库膨胀。
    if (this.missesSinceHit >= this.cfg.staleHits) {
      this.setStage('aged_out', `连续 ${this.missesSinceHit} 次无命中`)
    }
  }

  private setStage(next: Stage, reason?: string): void {
    const allowed = TRANSITIONS[this._stage]
    if (!allowed.includes(next)) {
      throw new Error(
        `非法阶段转移：${this._stage} → ${next}（${this._stage} 允许：${allowed.join('、') || '（终态，不可转移）'}）`,
      )
    }
    this._stage = next
    // 没给原因就明确记成"未记录"，而不是留空：留空会让下游拿不到归因时
    // 自行补一个默认值——那正是假归因的来源。
    this._reason = reason ?? `（未记录原因）→ ${next}`
  }

  report(): string {
    return `stage=${this._stage} hits=${this._signal.hits} 误伤=${this._signal.falsePositives} 放过=${this._signal.missedTrue}`
  }
}
