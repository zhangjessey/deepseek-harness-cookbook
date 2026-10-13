// src/firewall/ch21/loop-task.ts —— 后台任务：自动回退与老化由定时器驱动
//
// 第 21 讲有一句："自动回退与灰度撤回也是确定性的后台任务，不需要模型判断，也不需要人确认。"
// 落到这里就是：定时推进闭环状态（没有新命中就累计"连续未命中"，到阈值即老化移出）。
//
// 两条工程约束：
//  1. **随插件卸载停止**：用 `ctx.setInterval`（timer 插件提供的 effect 版），
//     而不是裸 `setInterval`——否则插件卸载或热重载后定时器还在跑，会继续改状态。
//  2. **单次失败不停循环**：一次 tick 抛异常不能让整个后台任务停摆，
//     否则一次意外就把"自动回退"这个安全网弄没了。
import { Context, Service } from '@deepseek-ai/cordis'
import timerPlugin from '@deepseek-ai/cordis-plugin-timer'
import { RuleLifecycle } from './loop'
import { LoopLogService, mountLoopLog, replayRetired, type RetiredRecord } from './loop-log'
import type { AutonomyLevel } from '../ch19/command-firewall'

export interface LoopTaskConfig {
  intervalMs: number
  autonomyLevel: AutonomyLevel
  /**
   * 闭环事实日志（**可选**）。挂上之后，"回退 / 老化"会写进 dsh 会话日志并落盘，
   * 于是进程重启后仍然知道"这条规则已被判死"，不会重新走一遍灰度。
   * 不挂就是降级模式：记录只活在内存里，重启即空（此时构造会明确告警）。
   */
  log?: { sessionId: string; root?: string }
}

/** 人完全掌握控制时暂停推进，只通知（对应 off / manual / 0）。 */
const PAUSED_LEVELS: readonly AutonomyLevel[] = ['off', 'manual', '0']

declare module '@deepseek-ai/cordis' {
  interface Context {
    firewallLoopTask: LoopTaskService
  }
}

export class LoopTaskService extends Service {
  // `ctx.setInterval` 来自 timer 服务的 mixin——它也是一项服务，
  // 不声明就会抛 "cannot get property timer without inject"。
  static inject = ['timer'] as const

  private lifecycles: RuleLifecycle[] = []
  private stopTimer?: () => void
  /** 已执行的 tick 次数（测试与排障用）。 */
  ticks = 0
  /** 因人在掌握控制而暂停。 */
  paused = false
  /**
   * 已退出闭环的规则（老化 / 回退），连同原因与时间。
   *
   * 接了闭环日志（`attachLog`）时，这份记录启动时从**已落盘的事实**重放、退出时写回日志，
   * 所以能跨进程存活——"这条规则已被判死"不会因为重启而忘掉。
   * 没接日志时它只活在内存里：重启即空，一条被回退过的规则可以重新开始灰度。
   * 那是**降级**而不是等价方案，所以 `mountLoopTask` 会明确告警，不让运维误以为已持久化。
   */
  private retired = new Map<string, RetiredRecord & { ruleId: string }>()
  private log?: LoopLogService
  /** 是否已开始推进（等 attachLog 完成，见 start 的说明）。 */
  private started = false

  constructor(
    ctx: Context,
    private config: LoopTaskConfig,
  ) {
    super(ctx, 'firewallLoopTask')
    this.paused = PAUSED_LEVELS.includes(config.autonomyLevel)
    // 定时器在构造时**注册**（ctx.setInterval 是 effect 版，要绑定到本插件的 fiber，
    // 插件卸载或热重载才会自动清理；放到别处调就绑不上了），
    // 但在 `start()` 之前**不推进状态**——见下面 started 的说明。
    // 同时保存 disposer，让调用方也能主动停（测试与"暂停闭环"这类场景需要）。
    this.stopTimer = ctx.setInterval(() => this.tick(), config.intervalMs)
  }

  /**
   * 开始推进（由 `mountLoopTask` 在日志接好之后调用）。
   *
   * 不能一注册就开始推进：日志没接上时若有对象进入终态，`reap` 里 `this.log` 还是
   * undefined → 这条退出事实**漏写**，重启后就忘了它已被判死。
   */
  start(): void {
    this.started = true
  }

  /** 主动停止定时器。卸载由 effect 自动处理，这里只是给调用方一个显式开关。 */
  stop(): void {
    this.stopTimer?.()
    this.stopTimer = undefined
  }

  /**
   * 接上闭环事实日志：先把历史重放进 `retired`，之后每次"退出闭环"都写进日志。
   *
   * 这就是**重启后不重新灰度**的落点：新进程启动时重放出"已判死"的规则，
   * 它们再被 track 时会被直接拒绝，而不是当成第一次见面重新开始。
   */
  attachLog(log: LoopLogService): void {
    this.log = log
    for (const [ruleId, rec] of replayRetired(log.facts())) {
      this.retired.set(ruleId, { ruleId, ...rec })
    }
  }

  /** 是否已接上闭环日志（决定 retired 能不能跨进程存活）。排障与自检用。 */
  get persistent(): boolean {
    return this.log !== undefined
  }

  /**
   * 解除某条规则的"已判死"状态（人复核后认为那次误伤是噪声、规则仍然有效）。
   *
   * 这是**高风险操作**——它让一条已被回退的规则重新进入灰度，所以调用方必须走审批
   * （组合包若把它暴露为工具，必须加进 ch19 的治理白名单并受人确认，不能让 Agent 自作主张）。
   *
   * 落盘是必须的：只在内存里解除的话，重启后从日志重放又会记得它"已判死"，
   * 这次解除白做了。
   *
   * @returns 是否真的解除了（原本就没被判死则返回 false）
   */
  reinstate(ruleId: string, opts: { by?: string; reason?: string } = {}): boolean {
    let changed = this.retired.delete(ruleId)
    // 已进入终态但还没被 reap 的规则也要能解除：规则在 observe 里回退后、到下一次
    // tick 的 reap 之前，它仍待在 lifecycles 里、不在 retired——若只查 retired，
    // 人想解除时正好落在这个窗口（或 stop()/paused 后 reap 不再跑）就解不掉。
    this.lifecycles = this.lifecycles.filter((lc) => {
      if (lc.id !== ruleId) return true
      const stage = lc.getStage()
      if (stage !== 'rolled_back' && stage !== 'aged_out') return true
      changed = true
      return false
    })
    if (!changed) return false
    this.log?.appendFact({
      type: 'lifecycle.reinstate',
      ruleId,
      at: Date.now(),
      by: opts.by,
      reason: opts.reason,
    })
    return true
  }

  /**
   * 运行时调整自主级别。
   *
   * `paused` 不能只在构造时算一次：ch19 支持运行时 `/firewall level`，若后台任务不跟随，
   * 人把级别调到 off（"撤下治理工具"）之后定时器仍在推进状态——**人明明拿回了控制权，
   * 闭环却还在自己动**。
   */
  setAutonomyLevel(level: AutonomyLevel): void {
    this.paused = PAUSED_LEVELS.includes(level)
  }

  /** 把一个候选的生命周期交给后台任务推进。 */
  track(lc: RuleLifecycle): void {
    // 同一条规则不重复跟踪：否则它每 tick 被推进两次，老化速度凭空翻倍。
    if (this.lifecycles.some((x) => x.id === lc.id)) return
    // 已被判死的同一条规则不再重新进入闭环：否则一条刚被回退的规则换一个实例就能重新
    // 灰度——那等于自动回退这张安全网被绕过了一次。
    const dead = this.retired.get(lc.id)
    if (dead) {
      this.ctx.logger?.warn?.(`[firewall-loop] 规则 ${lc.id} 已因 ${dead.stage} 退出闭环（${dead.at}），不再重新跟踪`)
      return
    }
    this.lifecycles.push(lc)
  }

  /** 当前**仍在闭环中**的对象（终态的已被 reap 移出）。 */
  tracked(): readonly RuleLifecycle[] {
    return [...this.lifecycles]
  }

  /** 已退出闭环的记录（老化 / 回退），供排障与遥测。 */
  retiredRecords(): readonly (RetiredRecord & { ruleId: string })[] {
    return [...this.retired.values()]
  }

  tick(): void {
    // 单次失败不停循环。
    try {
      // 未 start（日志还没接上）或人在掌握控制时都不推进——见 start() 的说明。
      if (this.paused || !this.started) return
      this.ticks++
      // 没有新命中就推进"连续未命中"计数，到阈值由生命周期自己转入 aged_out。
      //
      // 必须用 `noteIdle()` 而不是 `observe(false, false)`：后者会把这次滴答当成一次
      // 真实请求观测计进误伤率的分母，于是真实误伤被稀释 → 永不回退。
      for (const lc of this.lifecycles) lc.noteIdle()
      this.reap()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.ctx.logger?.warn?.(`[firewall-loop] 一次 tick 失败，继续下一轮：${msg}`)
    }
  }

  /**
   * 把进入终态（aged_out / rolled_back）的对象移出活跃集。
   *
   * 不清理的话：老化 / 回退的规则会永远留在数组里、每 tick 都被遍历一次，而数组
   * **只增不减**——长时间运行就是无界增长（内存与每 tick 的开销都随时间线性上涨）。
   * 移出前记进 retired，保证"哪条规则退出了、为什么、什么时候"仍然可查。
   */
  private reap(): void {
    // 先把终态与活跃集分开，并**立即更新活跃集**。
    // 若留到写日志之后再赋值，中途有一条 appendFact 抛错，本轮已处理过的对象就会
    // 留在数组里，下一轮再 reap 一次 → 同一条规则在日志里出现多条退出记录。
    const finished: Array<{ lc: RuleLifecycle; stage: 'aged_out' | 'rolled_back' }> = []
    const alive: RuleLifecycle[] = []
    for (const lc of this.lifecycles) {
      const stage = lc.getStage()
      if (stage === 'aged_out' || stage === 'rolled_back') finished.push({ lc, stage })
      else alive.push(lc)
    }
    this.lifecycles = alive

    for (const { lc, stage } of finished) {
      const at = Date.now()
      this.retired.set(lc.id, { ruleId: lc.id, stage, at })
      if (!this.log) continue
      try {
        // 落盘：不写进日志，这条记录就随内存消失——重启后同一条规则可以重新走一遍灰度。
        // reason 取自产生这次转移的那一方（`lc.getReason()`），**不是这里编的**：
        // 以前硬编码成"灰度期误伤率超过阈值"，于是人工回退也会被记成误伤回退。
        // 老化同样带 reason（"连续 N 次无命中"）——审计要能回答"为什么这条规则退出了"，
        // 而不是只有 type、没有依据。
        this.log.appendFact(
          stage === 'aged_out'
            ? { type: 'lifecycle.aged_out', ruleId: lc.id, at, reason: lc.getReason() }
            : { type: 'lifecycle.rollback', ruleId: lc.id, at, reason: lc.getReason() },
        )
      } catch (err) {
        // 写日志失败不该让这条记录消失（内存里已记为退出，仍会拒绝重新灰度），
        // 但**必须出声**：静默会让人以为已落盘，而重启后其实会忘掉这次判死。
        const msg = err instanceof Error ? err.message : String(err)
        this.ctx.logger?.warn?.(`[firewall-loop] 规则 ${lc.id} 的退出事实未能落盘（重启后可能重新进入灰度）：${msg}`)
      }
    }
  }
}

/** 挂载后台任务（先挂 timer 插件，再挂任务本身）。 */
export async function mountLoopTask(ctx: Context, config: LoopTaskConfig): Promise<void> {
  await ctx.plugin(timerPlugin)
  if (config.log) {
    // 挂闭环日志：让"回退 / 老化"成为**落盘的账本事实**，于是重启后仍然记得
    // "这条规则已被判死"，不会重新灰度。
    await mountLoopLog(ctx, config.log)
    await ctx.plugin(LoopTaskService, config)
    // 同样用 inject 取，而不是 `ctx.firewallLoopTask.attachLog(ctx.loopLog)`：
    // 直接取属性在子插件的 apply 里会被 cordis 拒绝（cannot get property ... without inject），
    // 于是这一步**静默不执行**——表现为"日志挂上了、任务没接上"（persistent 一直是 false，
    // 重启后照样重新灰度，而界面上看不出任何异常）。
    await ctx.inject(['loopLog', 'firewallLoopTask'] as const, (c) => {
      c.firewallLoopTask.attachLog(c.loopLog)
      // 日志接好之后才开始推进：否则这段窗口里进入终态的规则会漏写退出事实。
      c.firewallLoopTask.start()
    })
    return
  }
  await ctx.plugin(LoopTaskService, config)
  await ctx.inject(['firewallLoopTask'] as const, (c) => c.firewallLoopTask.start())
  // 没挂日志 = **降级模式**：闭环状态只活在内存里，进程重启即丢。
  // 这是降级而不是等价方案，所以必须出声——否则运维以为已经持久化了，
  // 于是在最需要它的时候发现安全网没了。
  ctx.logger?.warn?.(
    '[firewall-loop] 未挂载闭环日志（config.log）：闭环状态只活在内存里，' +
      '进程重启后已回退 / 已老化的规则会重新进入灰度。要持久化请传 log: { sessionId }。',
  )
}
