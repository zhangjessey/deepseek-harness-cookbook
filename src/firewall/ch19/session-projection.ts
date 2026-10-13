// src/firewall/ch19/session-projection.ts —— 投影：从会话日志增量得到账本状态
//
// 第 19 讲有一句关键的话："账本状态由日志折叠得到"。dsh 里这句话的机制叫**投影**：
// 注册一个单元（key / init / apply / view），注册表会把每个已提交事件喂给 `apply`，
// 状态增量推进；读侧用 `view` 暴露出给界面与客户端看的值。
//
// 为什么要有它（而不是每次读的时候重新折叠一遍全部事件）：
//   · 增量——只对新事件做一次转换，而不是每次读都重放整个日志
//   · 一处折叠，三处使用——工具与命令、投影、prompt 片段都从同一个 `fold` 出结果，
//     不会各读各的导致三处看到不同的状态
//   · 随插件卸载消失——注册是 effect，插件卸载后这个 key 从快照里消失，
//     客户端读到的是"能力缺失"，而不是一份陈旧状态
//
// 折叠语义变了要 bump `stateVersion`：持久化的投影缓存会按版本作废，
// 否则旧版本的缓存行会被继续套用到新语义上，得到垃圾状态。
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { fold, type RuleEvent } from './ledger'
import { factFromEvent, type SessionEventLike } from './session-log'

/** 投影对外暴露的值：当前规则集的精简视图。 */
export interface LedgerView {
  rules: Array<{ id: string; name: string; action: string; state: string }>
}

// 声明合并：把本插件的投影 key 加进 dsh 的投影表。
declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionMap {
    'firewall-ledger': LedgerView
  }
}

export const LEDGER_PROJECTION_KEY = 'firewall-ledger'
/** 折叠语义或序列化字段变化时递增；当前为初版。 */
/**
 * 折叠语义 / 序列化字段变了就 bump（README 里"投影的 stateVersion 改了为什么要 bump"）。
 *
 * v2：账本新增 `rule.reject` 事件与 `rejected` 状态——驳回从"删除"改成"归档留痕"。
 * 折叠语义因此变了：旧缓存行里根本没有"驳回"这一维，若继续复用，
 * 一条已被驳回的规则会被显示成它驳回前的样子（candidate / active），
 * 于是"驳回"在界面与 prompt 片段里等于没生效——正是这条规则要防的垃圾状态。
 */
export const LEDGER_STATE_VERSION = 2

const viewSchema = z.object({
  rules: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      action: z.string(),
      state: z.string(),
    }),
  ),
})

export const ledgerProjection = {
  // ProjectionDefinition 的 key 要求是字面量类型（对应 SessionProjectionMap 的键），
  // 对象字面量会把它放宽成 string，这里显式收窄。
  key: LEDGER_PROJECTION_KEY as 'firewall-ledger',
  schema: viewSchema,
  init: (): RuleEvent[] => [],
  apply: (state: RuleEvent[], event: SessionEventLike): RuleEvent[] => {
    const fact = factFromEvent(event)
    // 不是本插件的事实就返回同一个引用：引用不变则下游零工作量。
    if (!fact) return state
    return [...state, fact]
  },
  view: (state: RuleEvent[]): LedgerView => ({
    rules: fold(state).map((r) => ({
      id: r.id,
      name: r.name,
      action: r.action,
      state: r.state,
    })),
  }),
  stateVersion: LEDGER_STATE_VERSION,
}

/**
 * 挂载投影。用 `ctx.inject(['sessionProjections'], …)` 而不是直接取：
 * 没有投影服务装配（比如只跑数据面）时本插件不受影响，不会因为没有注册表而加载失败。
 */
export function mountLedgerProjection(ctx: Context): void {
  ctx.inject(['sessionProjections'], (c) => {
    // register 返回 disposer，交给 effect 托管：插件卸载时投影一起消失。
    c.effect(() => c.sessionProjections.register(ledgerProjection))
  })
}
