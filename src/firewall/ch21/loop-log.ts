// src/firewall/ch21/loop-log.ts —— 闭环事实落在 dsh 会话日志上
//
// 为什么闭环状态也必须落盘：它若只活在内存里，进程一重启，"这条规则已经被回退/老化过"
// 这件事就随内存一起没了——同一条规则换个实例就能重新走一遍灰度。
// 那等于**自动回退这张安全网在重启后失效**：最需要它的时候（刚回退完、还没修好）
// 恰恰是它消失的时候。
//
// 机制复用 `shared/fact-log.ts`（与 ch19 的账本事实同一套：user/message 载体 + JSONL
// 持久化 + 重启恢复 + 读回逐条校验）。这里只声明**闭环事实这一类**（标记 + 来源 + 校验器）——
// 两类事实各走各的会话 id 与来源标记，读回时按来源过滤，不会串味。
import { Context } from '@deepseek-ai/cordis'
import { FactLogService, mountFactLog, type FactSpec } from '../shared/fact-log'
import type { Stage } from './loop'

/** 本插件在会话日志里的事实来源标记。 */
export const LOOP_SOURCE_PLUGIN = 'firewall-loop'

/** 闭环事实：一条规则在生命周期里走过的每一步。 */
export type LifecycleEvent =
  // init / promote 目前**没有写路径**：闭环从 track 那一刻起由后台任务推进，只落盘
  // "退出"与"解除"这两个需要跨重启记住的状态，不逐条落盘每次转移。保留这两个类型是给
  // 未来的完整审计留位置——看到它们别误以为有数据在写（见 replayRetired，它们只读）。
  | { type: 'lifecycle.init'; ruleId: string; at: number; autoConfirmAllowed: boolean }
  | { type: 'lifecycle.promote'; ruleId: string; at: number; to: Stage }
  | { type: 'lifecycle.rollback'; ruleId: string; at: number; reason?: string }
  | { type: 'lifecycle.aged_out'; ruleId: string; at: number; reason?: string }
  /**
   * 解除"已判死"状态（人复核后认为那条误伤是噪声、规则仍然有效）。
   *
   * 没有它，回退就是**不可逆**的：一次噪声观测永久禁用一条规则，而状态还会落盘，
   * 连重启都救不回来。所以必须有一个解除入口，而且它本身也要落盘——
   * 否则解除只在本次进程生效，重启后又记得它"已判死"。
   */
  | { type: 'lifecycle.reinstate'; ruleId: string; at: number; by?: string; reason?: string }

const ALL_STAGES: ReadonlySet<string> = new Set(['proposed', 'shadow', 'canary', 'active', 'rolled_back', 'aged_out'])
const TERMINAL_STAGES: ReadonlySet<string> = new Set(['rolled_back', 'aged_out'])

/**
 * 闭环事实是否形状合法。
 *
 * 逐字段校验，而不是只查 `type`：
 *  · `ruleId` 为空会让"哪条规则退出了"无从回答；
 *  · `at` 不是数字，按时间排序与排障都会出错；
 *  · `to` 不在状态集合内，重放时会把规则折成一个根本不存在的状态。
 */
export function isValidLifecycleEvent(value: unknown): value is LifecycleEvent {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v.ruleId !== 'string' || v.ruleId === '') return false
  if (typeof v.at !== 'number' || !Number.isFinite(v.at)) return false
  switch (v.type) {
    case 'lifecycle.init':
      return typeof v.autoConfirmAllowed === 'boolean'
    case 'lifecycle.promote':
      return typeof v.to === 'string' && ALL_STAGES.has(v.to)
    case 'lifecycle.rollback':
      return v.reason === undefined || typeof v.reason === 'string'
    case 'lifecycle.aged_out':
      return true
    case 'lifecycle.reinstate':
      if (v.by !== undefined && typeof v.by !== 'string') return false
      if (v.reason !== undefined && typeof v.reason !== 'string') return false
      return true
    default:
      return false
  }
}

export function assertValidLifecycleEvent(value: unknown, where: string): LifecycleEvent {
  if (!isValidLifecycleEvent(value)) {
    throw new Error(`${where}：闭环事实形状不合法 ${JSON.stringify(value)}`)
  }
  return value
}

const LOOP_FACT: FactSpec<LifecycleEvent> = {
  marker: 'firewall-loop fact',
  sourcePlugin: LOOP_SOURCE_PLUGIN,
  validate: isValidLifecycleEvent,
  assert: assertValidLifecycleEvent,
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    loopLog: LoopLogService
  }
}

export interface LoopLogConfig {
  sessionId: string
  root?: string
}

export class LoopLogService extends FactLogService<LifecycleEvent> {
  constructor(ctx: Context, config: LoopLogConfig) {
    super(ctx, 'loopLog', LOOP_FACT, config)
  }
}

/** 一条"已退出闭环"的记录。 */
export interface RetiredRecord {
  stage: 'rolled_back' | 'aged_out'
  at: number
  reason?: string
}

/**
 * 从闭环事实里重放出"已退出闭环"的规则。
 *
 * 这是"重启后不重新灰度"的关键：新进程启动时先读回这份记录，于是被回退过的规则
 * 再被 track 时会被直接拒绝——而不是当成第一次见面重新开始。
 * 后发生的覆盖先发生的（同一条规则先老化、后回退，最终记为回退）。
 */
export function replayRetired(facts: LifecycleEvent[]): Map<string, RetiredRecord> {
  const out = new Map<string, RetiredRecord>()
  for (const f of facts) {
    if (f.type === 'lifecycle.rollback') {
      out.set(f.ruleId, { stage: 'rolled_back', at: f.at, reason: f.reason })
    } else if (f.type === 'lifecycle.aged_out') {
      out.set(f.ruleId, { stage: 'aged_out', at: f.at })
    } else if (f.type === 'lifecycle.promote' && TERMINAL_STAGES.has(f.to)) {
      out.set(f.ruleId, { stage: f.to as 'rolled_back' | 'aged_out', at: f.at })
    } else if (f.type === 'lifecycle.reinstate') {
      // 解除发生在退出之后 → 抹掉这条判死记录。
      // 用 `>=` 而不是 `>`：`at` 是 `Date.now()` 的毫秒值，同一毫秒内先 rollback 再
      // reinstate 时两者相等，严格 `>` 会漏掉这次解除（重启后又记得它"已判死"）。
      const cur = out.get(f.ruleId)
      if (!cur || f.at >= cur.at) out.delete(f.ruleId)
    }
  }
  return out
}

/** 供 bundle / demo 挂载。 */
export async function mountLoopLog(ctx: Context, config: LoopLogConfig): Promise<void> {
  await mountFactLog(ctx, LoopLogService, config, { serviceName: 'loopLog', logTag: 'firewall-loop' })
}
