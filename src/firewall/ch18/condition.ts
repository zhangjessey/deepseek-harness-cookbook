// src/firewall/ch18/condition.ts —— 条件树（Condition）的结构化校验
//
// 为什么单独一个文件：条件树是跨讲契约——ch18 规则文件要校验它、ch20 长出的候选要校验它、
// ch21 评测/确认接手的候选也要校验它。三处各写一份（或干脆不校验、用 `as` 硬转）会让
// "约束在代码里"变成一句注释：模型产出的 `when: null`、拼错的 `op`、缺 value 的叶子
// 都能蒙混过关，直到求值时抛 TypeError 或——更糟——静默永不命中（等于放行）。
//
// 所以这里提供唯一一份 type guard，三讲共用；规则文件与工具入参的边界都必须过它。
import { Condition, Operator } from './types'

export const OPERATORS: readonly Operator[] = [
  'eq',
  'ne',
  'contains',
  'starts_with',
  'ends_with',
  'matches',
  'in',
  'exists',
]

/**
 * 结构化校验：判断 unknown 是否是一条合法条件树。
 * 递归检查 and / or / not 与叶子（field 字符串、op 在算子白名单内、value 形状正确）。
 */
export function isValidCondition(value: unknown): value is Condition {
  return isValidConditionRec(value, new WeakSet())
}

function isValidConditionRec(value: unknown, seen: WeakSet<object>): boolean {
  if (typeof value !== 'object' || value === null) return false
  // 循环引用（`const c={and:[]}; c.and.push(c)`）经运行时 API 传入会无限递归直到栈溢出。
  // JSON 表达不了环、文件路径安全，但 addRule/loadRules 与 ch21 候选对象可以——seen 兜住。
  if (seen.has(value)) return false
  seen.add(value)
  const c = value as Record<string, unknown>

  // **空组合必须拒绝**：`and: []` 求值时空数组的 `every` 是真空真 → 命中一切请求
  // （配成 allow 就是白名单下全放行，配成 deny 就是全站 403，放在 unless 上就是那条
  //   deny 规则永不触发）；`or: []` 的 `some` 是真空假 → 规则静默失效、等于没写。
  // 两种都是"规则存在但不生效"，正是本文件要消灭的那一类失败。
  if ('and' in c) return Array.isArray(c.and) && c.and.length > 0 && c.and.every((x) => isValidConditionRec(x, seen))
  if ('or' in c) return Array.isArray(c.or) && c.or.length > 0 && c.or.every((x) => isValidConditionRec(x, seen))
  if ('not' in c) return isValidConditionRec(c.not, seen)

  return isLeaf(c)
}

/** 引擎认识的字段：七个请求字段 + `header.<name>` / `query.<name>` 前缀形式。 */
const BASE_FIELDS: ReadonlySet<string> = new Set(['method', 'path', 'body', 'ip', 'ua'])
const FIELD_PREFIXES: readonly string[] = ['header.', 'query.']

/**
 * 字段是否引擎认识。未知字段不是"无害的笔误"：它让取值返回 undefined，于是
 * `ne` 恒真（命中一切请求 → 全站 403）、`eq`/`contains` 恒假（规则永不生效 → 全放行）。
 * 两种都是**静默**失效，所以必须在校验阶段就拒掉，而不是等上线后才发现没拦住。
 */
export function isKnownField(field: string): boolean {
  if (BASE_FIELDS.has(field)) return true
  return FIELD_PREFIXES.some((p) => field.startsWith(p) && field.length > p.length)
}

function isLeaf(c: Record<string, unknown>): boolean {
  if (typeof c.field !== 'string' || !isKnownField(c.field)) return false
  if (typeof c.op !== 'string' || !OPERATORS.includes(c.op as Operator)) return false
  // 值形状按算子约束：`matches` 必须是字符串（要能编译成 RE2 模式），`in` 必须是数组，
  // 其余算子除 `exists` 外都要求值存在（否则条件恒真或恒假，规则等于失效）。
  if (c.op === 'exists') return true
  if (c.op === 'matches') return typeof c.value === 'string' && c.value !== ''
  // `in` 的空数组恒不含任何值 → 条件恒假，规则静默失效。
  if (c.op === 'in') return Array.isArray(c.value) && c.value.length > 0
  return c.value !== undefined && c.value !== null
}

/**
 * 校验并给出可行动的错误（用于规则文件与工具入参的边界）：
 * 静默接受一条坏规则，后果是"规则存在但不生效"——运维以为在防护，实际全放行。
 */
export function assertValidCondition(value: unknown, where: string): Condition {
  if (!isValidCondition(value)) {
    throw new Error(
      `${where}：条件树不合法，收到 ${JSON.stringify(value)}（叶子需 { field: string, op: 算子, value }，组合用 and / or / not）`,
    )
  }
  return value
}

/** 一个叶子的形状（and / or / not 是组合节点，不是叶子）。 */
export interface LeafShape {
  field: string
  op: Operator
  value?: unknown
}

/**
 * 取条件树里**所有叶子**（组合节点会被展开）。
 *
 * 为什么需要它：ch21 的意图关卡、风险关卡、证据逆推都要问"这条规则作用在哪个字段、用了
 * 什么算子"，但候选可以是任意深度的 and / or / not 组合。若各处自己 `as Record<string,
 * unknown>` 去读 `.field` / `.op`，遇到组合节点会拿到 **undefined** 而静默判错——
 * 于是组合型候选要么被误杀、要么被漏判，且查不出原因。这里给出唯一入口，三处共用。
 */
export function leavesOf(value: unknown, out: LeafShape[] = []): LeafShape[] {
  collectLeaves(value, out, new WeakSet())
  return out
}

function collectLeaves(value: unknown, out: LeafShape[], seen: WeakSet<object>): void {
  if (typeof value !== 'object' || value === null) return
  // 循环引用停止展开（否则栈溢出）；条件树本身非法，由 isValidCondition 的 seen 拒绝。
  if (seen.has(value)) return
  seen.add(value)
  const c = value as Record<string, unknown>
  if (Array.isArray(c.and)) {
    for (const sub of c.and) collectLeaves(sub, out, seen)
    return
  }
  if (Array.isArray(c.or)) {
    for (const sub of c.or) collectLeaves(sub, out, seen)
    return
  }
  if ('not' in c) {
    collectLeaves(c.not, out, seen)
    return
  }
  if (typeof c.field === 'string' && typeof c.op === 'string') {
    out.push({ field: c.field, op: c.op as Operator, value: c.value })
  }
}
