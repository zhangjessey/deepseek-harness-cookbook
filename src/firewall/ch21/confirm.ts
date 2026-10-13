// src/firewall/ch21/confirm.ts —— 确认：三种关卡（命名 / 意图 / 风险），关卡在工具代码里、受约束生成
//
// 对应第21讲"确认三种关卡"：候选"转正"前过三关——关卡是写进工具代码的函数（不是靠提示词），
// 并且与 ch20 的"约束在工具代码里"一脉相承：提案受约束生成，确认再校验。
import { leavesOf } from '../ch18/condition.ts'
import type { Candidate } from '../ch20/propose'
import type { EvalResult } from './evaluate'

export interface GateResult {
  pass: boolean
  reason: string
}

export interface ConfirmReport {
  naming: GateResult // 命名关卡
  intent: GateResult // 意图关卡
  risk: GateResult // 风险关卡
  pass: boolean
}

// 命名关卡：候选必须有可读名字，不能还顶着自动生成的 id 样式（cand-*/rule-*）。
export function checkNaming(c: Candidate): GateResult {
  if (/^(cand-|rule-)/.test(c.name)) {
    return { pass: false, reason: `名字仍是自动 id（${c.name}），需人命名后再转正` }
  }
  if (c.name.length < 4) return { pass: false, reason: '名字过短，语义不清' }
  return { pass: true, reason: `命名可读：${c.name}` }
}

/**
 * 名字里是否含这个**词**（按非字母数字切分后逐词比较）。
 *
 * 不能用 `name.includes(word)`：那是子串匹配，"block manual probe" 会被当成 ua 类
 * （"man**ua**l" 里含 "ua"）、"block guard" 同理——于是被要求作用于 ua 字段，合法候选
 * 因此被误杀。而真正写 "block ua scanner" 的候选若名字里没有独立的 ua 词，又会被漏判。
 */
function hasWord(name: string, word: string): boolean {
  return name.split(/[^a-z0-9]+/i).includes(word)
}

// 意图关卡：名字声称的意图必须和 when 结构对齐（"block sqli" 要真针对注入特征，而非随便一个 path 匹配）。
export function checkIntent(c: Candidate): GateResult {
  // 用统一的叶子视图，而不是 `as Record<string, unknown>` 去读 `.field` / `.op`：
  // 组合型候选（and / or / not）根本没有"单个 field"，那样读会拿到 **undefined** 而静默
  // 判错——组合型候选于是要么被误杀、要么被漏判，且查不出原因。
  const leaves = leavesOf(c.when)
  const name = c.name.toLowerCase()
  if (hasWord(name, 'sqli')) {
    const ok = leaves.some(
      (l) => l.field === 'path' && l.op === 'contains' && typeof l.value === 'string' && l.value.includes("'"),
    )
    return ok
      ? { pass: true, reason: '意图与 when 对齐（sqli）' }
      : { pass: false, reason: '名为 sqli 但 when 未针对注入特征' }
  }
  // 名字里点名了字段的：就要求 when 真的作用于那个字段（ip / method / body / ua 皆然）。
  for (const [word, field] of [
    ['ua', 'ua'],
    ['ip', 'ip'],
    ['method', 'method'],
    ['body', 'body'],
  ] as const) {
    if (!hasWord(name, word)) continue
    return leaves.some((l) => l.field === field)
      ? { pass: true, reason: `意图与 when 对齐（${field}）` }
      : { pass: false, reason: `名为 ${field} 类但 when 未作用于 ${field} 字段` }
  }
  if (hasWord(name, 'probe') || hasWord(name, 'admin') || hasWord(name, 'path')) {
    return leaves.some((l) => l.field === 'path')
      ? { pass: true, reason: '意图与 when 对齐（path）' }
      : { pass: false, reason: '名为路径类但 when 未作用于 path 字段' }
  }
  return { pass: false, reason: '名字未体现可识别意图，需人确认' }
}

// 风险关卡：误伤率过高或作用域过宽 → 高风险，必须人确认，不能自动转正。
export function checkRisk(c: Candidate, evalResult: EvalResult): GateResult {
  // 同样走叶子视图：组合型候选要逐个叶子看，只看"顶层 field"会漏掉内层过宽的条件。
  const broad = leavesOf(c.when).some(
    (l) => l.field === 'path' && l.op === 'contains' && typeof l.value === 'string' && l.value.length <= 1,
  )
  // 样本不足时误伤率算出来是 0——但那不是"确实没误伤"，而是"没有数据可判"。
  // 绝不能让"无数据"冒充"0% 误伤"：样本路径配错、或样本里根本没有正常流量时，
  // 所有候选（包括那条会拦掉全部正常请求的 trap-1）都会"确定性地"通过风险关卡并进灰度。
  if (!evalResult.sampleSufficient) {
    return {
      pass: false,
      reason: `样本不足以评估风险（该拦 ${evalResult.totalBad} 条 / 正常 ${evalResult.totalGood} 条），需补样本后由人确认`,
    }
  }
  // 命中 0 次 = 这条规则在回放样本里**拦不住任何东西**。它"零误伤"只是因为什么都没拦，
  // 不是因为拦得准——所以不能据此判定风险可控。（demo 里的 cand-7 正是这种：覆盖率 0.0%、
  // 命中 0 次，却曾三关全过并被当作"健康推进"送进灰度。）
  if (evalResult.caughtBad + evalResult.caughtGood === 0) {
    return {
      pass: false,
      reason: `回放样本里命中 0 次（覆盖 0.0%）：该候选拦不住任何东西，无法据此评估风险，需人确认`,
    }
  }
  if (evalResult.falsePositiveRate > 0.02) {
    return {
      pass: false,
      reason:
        `误伤率 ${(evalResult.falsePositiveRate * 100).toFixed(1)}% 过高，需人确认` +
        `（注意 Oracle 是第 20 讲的启发式检测器：误伤也可能只是这条候选**比检测器更准**，` +
        `请人工复核后再决定，不要直接当成坏规则）`,
    }
  }
  if (broad) return { pass: false, reason: 'when 作用域过宽（短包含），误伤风险高' }
  return { pass: true, reason: `风险可控（误伤率 ${(evalResult.falsePositiveRate * 100).toFixed(1)}%）` }
}

export function confirmCandidate(c: Candidate, evalResult: EvalResult): ConfirmReport {
  const naming = checkNaming(c)
  const intent = checkIntent(c)
  const risk = checkRisk(c, evalResult)
  return { naming, intent, risk, pass: naming.pass && intent.pass && risk.pass }
}
