// src/firewall/ch21/feedback.ts —— 回接：把"漏拦"喂回证据库，闭合跨轮进化那一环
//
// 这是第 21 讲闭环的最后一环。没有它，系统只会**演化**（长出候选并筛选），不会**累积经验**：
// 每一轮提案看到的都是同一批原始日志，上一轮漏掉了什么，下一轮并不知道，
// 于是同一个坑会被反复踩。进化三要素里，变异（ch20 长出候选）与选择（本讲评测/确认/回退）
// 都已实现，缺的正是这一环——把教训传下去的"遗传"。
import { detect, sanitize } from '../ch20/observe'
import type { NginxLine, SanitizedEvidence } from '../ch20/observe'
import type { RuleLifecycle } from './loop'

/**
 * 能接收证据的东西。
 *
 * 只声明这一个方法（而不是 import 某个具体类），是为了让回接同时能接 ch20 的两种证据库：
 * 内存版 `ObserveSession` 与落盘版 `ObserveSessionService`（写进 dsh 会话日志）——
 * 两者都有 `injectEvidence`，但后者还依赖 cordis 的 sessions 服务，回接不该被它绑住。
 */
export interface EvidenceSink {
  injectEvidence(ev: SanitizedEvidence): void
}

/**
 * 把一条规则**漏掉的坏请求**脱敏后喂回证据库，返回注入条数。
 *
 * 三个不显眼但要紧的地方：
 *
 * 1. **只喂漏拦的坏请求，不喂误伤。** 误伤（拦了正常的）已由自动回退当场止损；
 *    它真正该留下的是"别再提议这类模式"，那是关于**规则**的知识，而证据库存的是
 *    **请求**样本——把误拦的正常请求当异常证据塞进去，模型反而会照着它长出朝正常请求
 *    开火的规则。所以本讲只回接漏拦这一路，误伤的跨轮避坑仍留给宿主侧。
 * 2. **回接时重新 detect 一次**再带 kind。drain 出来的是原始日志行本身，类别必须按
 *    同一个检测器判定，证据才带得上 kind；判不出类别的行（理论上不该出现——isBad 就是
 *    detect 的结果）直接跳过：宁可少一条，也不要一条 kind 缺失的假证据。
 * 3. **脱敏复用 ch20 的 `sanitize`，不另写一套。** 盐、参数值假名化、UA 归类的口径
 *    必须与正向链路完全一致；同一个 IP 若在两处算出不同哈希，"按来源聚合"这件事就废了。
 */
export function feedMissedToEvidence(sink: EvidenceSink, lc: RuleLifecycle): number {
  const lines: NginxLine[] = lc.drainMissed()
  let injected = 0
  for (const line of lines) {
    const kind = detect(line)
    if (!kind) continue
    sink.injectEvidence(sanitize({ kind, line }))
    injected++
  }
  return injected
}
