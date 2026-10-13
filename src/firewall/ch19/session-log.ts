// src/firewall/ch19/session-log.ts —— 规则事实落在 dsh 会话日志上
//
// 第 19 讲的核心主张是"会话日志是账本（历史的权威），规则文件只是发布产物"。
// 这句话要成立，账本事实就**必须真的写进 dsh 会话日志**，而不是写在一个自己造的 JSON 文件里。
//
// 通用机制（载体选择、JSONL 持久化、重启恢复、读写校验）在 `shared/fact-log.ts`——
// 第 21 讲的闭环事实共用同一套机制。这里只声明**规则事实这一类**（标记 + 来源 + 校验器）：
// 两类事实各走各的会话 id 与来源标记，读回时按来源过滤，不会串味。
//
// 读回时一律校验：只采信 source.plugin === 'firewall-ledger' 的事件，
// 且只接受形状合法的 JSON，不合法的忽略——状态只由折叠得到。
import { Context } from '@deepseek-ai/cordis'
import {
  FactLogService,
  factFromEvent as factFromEventOf,
  mountFactLog,
  type FactSpec,
  type SessionEventLike,
} from '../shared/fact-log'
import { assertValidRuleEvent, fold, isValidRuleEvent, type RuleEvent, type Rule } from './ledger'

/** 本插件在会话日志里的事实来源标记。 */
export const FACT_SOURCE_PLUGIN = 'firewall-ledger'

/**
 * 规则事实这一类怎么落地、怎么认回来。
 *
 * 校验器直接用 ledger 那一份（写侧 `appendFact` 也用同一份，见 ledger.ts）：
 * 两侧各写一份的话，一旦漂移就会出现"写进去、读不回来"的静默蒸发——
 * 日志里有这条事实、权威里却没有这条规则，verifyFacts 永久不一致且查不出原因。
 */
const RULE_FACT: FactSpec<RuleEvent> = {
  marker: 'firewall-ledger fact',
  sourcePlugin: FACT_SOURCE_PLUGIN,
  validate: isValidRuleEvent,
  assert: assertValidRuleEvent,
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    ledgerLog: LedgerLogService
  }
}

export interface LedgerLogConfig {
  sessionId: string
  /**
   * 会话日志的持久化根目录（JSONL）。
   * 不挂持久化，权威就只活在内存里——进程一退，"会话日志是账本"这句话就不成立了。
   */
  root?: string
}

export class LedgerLogService extends FactLogService<RuleEvent> {
  constructor(ctx: Context, config: LedgerLogConfig) {
    super(ctx, 'ledgerLog', RULE_FACT, config)
  }

  /** 当前状态——永远由事实折叠得到，不是从文件读来的。 */
  state(): Rule[] {
    return fold(this.facts())
  }
}

export type { SessionEventLike }

/**
 * 从一条会话事件里取出本插件的账本事实；不是本插件的事实就返回 null。
 * 这是"读回校验"的唯一入口——工具与命令、投影、prompt 片段都走它，
 * 所以三处看到的永远是同一份经过校验的事实，不会各读各的。
 */
export function factFromEvent(ev: SessionEventLike): RuleEvent | null {
  return factFromEventOf(RULE_FACT, ev)
}

/** 供 bundle / demo 挂载：先挂 dsh 的会话服务，再挂账本日志，并做重启恢复。 */
export async function mountLedgerLog(ctx: Context, config: LedgerLogConfig): Promise<void> {
  await mountFactLog(ctx, LedgerLogService, config, {
    serviceName: 'ledgerLog',
    logTag: 'firewall-ledger',
  })
}
