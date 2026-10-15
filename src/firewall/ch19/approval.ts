// src/firewall/ch19/approval.ts —— 审批与工具白名单（"让专职 Agent 安全地改东西"）
//
// 两层，顺序不能颠倒：
//  1. `tools/pre-execute` —— **waterfall 事件**：监听器一个接一个，每个都必须调用 `next()`，
//     拿到后续（含默认策略）的决策后再决定要不要改成拒绝。结果默认拒绝：
//     没有明确放行的写操作一律不放行。
//  2. `tools.guard` —— 在 pre-execute 之后运行的**单调**守卫：任何守卫都可以拒绝，
//     但没有任何守卫能把别人拒绝的调用重新放行（单调 = 只收紧，不放宽）。
//     所以它只按"工具是否在白名单里"判断，不试图做例外。
//
// 另外，"人始终在 Agent 之上"在这里的落点是：自主级别越低，Agent 能自动做的事越少；
// 转正（approve）与下线（reject）永远比起草（draft）更需要人——代码约束的是调用，不是说服。
import type { Context } from '@deepseek-ai/cordis'
// 引入 dsh-tools 的类型：它用声明合并给 Context 加上 `tools`、给 Events 加上
// `tools/pre-execute` 等——不引入就看不到这些扩展点。
import '@deepseek-ai/dsh-tools'
import type { AutonomyLevel } from './command-firewall'

/**
 * 治理 Agent 的工具名——**唯一真相**。
 *
 * 注册处（`packages/dsh-firewall-governance`）与守卫白名单（`ALLOWED_TOOLS`）都从这里取，
 * 不再各写一份字符串。以前两边各硬编码一份，漏同步的表现是：新工具注册了却被单调 guard
 * 拒绝，而且只在真实 dsh 里才暴露（cookbook 单测走不到那条路）。
 * 现在新增工具只需在这里加一项，白名单自动包含它。
 */
export const GOVERNANCE_TOOLS = {
  list: 'firewall_list',
  level: 'firewall_level',
  draft: 'firewall_draft',
  approve: 'firewall_approve',
  reject: 'firewall_reject',
} as const

/** 需要人把关的写操作（读操作不受限）。级别调整也算写操作——它改变的是权限本身。 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  GOVERNANCE_TOOLS.draft,
  GOVERNANCE_TOOLS.approve,
  GOVERNANCE_TOOLS.reject,
  GOVERNANCE_TOOLS.level,
])

/** 治理 Agent 可用的工具白名单（读 + 写）：从 `GOVERNANCE_TOOLS` 派生，不另写一份。 */
export const ALLOWED_TOOLS: ReadonlySet<string> = new Set(Object.values(GOVERNANCE_TOOLS))

/**
 * 放行表：**只有**这里列出的 (级别, 工具) 组合才放行，其余一律拒绝（fail-closed）。
 * 语义与 LEVEL_DESC 一致：
 *  · 0 / manual：写操作一律拒绝，Agent 不自动做变更
 *  · 1：起草自动（可以起草候选），但**批准与驳回必须人确认**
 *  · 2：起草与批准都自动，但**驳回（下线，reject）必须人确认**
 * 级别调整（firewall_level）任何级别都不自动放行——Agent 不能给自己提级。
 */
const ALLOWED_WRITES: Record<AutonomyLevel, ReadonlySet<string>> = {
  off: new Set(),
  '0': new Set(),
  manual: new Set(),
  '1': new Set(['firewall_draft']),
  '2': new Set(['firewall_draft', 'firewall_approve']),
}

/**
 * 给一个写操作定拒绝理由；返回 undefined 表示不拦。
 * 纯函数，便于直接断言——审批的真伪不靠"看起来对"，靠可测的规则。
 *
 * 注意是**放行名单**而不是拒绝名单：未知的级别、未知的工具一律拒绝。反过来写（列出
 * 要拒的几种级别）会让 `OFF`、`00`、`toString` 这类取值静默落到"放行"分支上。
 */
export function denyReasonFor(level: AutonomyLevel, toolName: string): string | undefined {
  if (!WRITE_TOOLS.has(toolName)) return undefined // 读操作不受自主级别限制
  if (toolName === 'firewall_level') {
    return '自主级别只能由人调整（用 /firewall level 命令）：Agent 不能给自己提级'
  }
  if (!Object.hasOwn(ALLOWED_WRITES, level)) {
    return `未知自主级别：${String(level)}——不能据此放行写操作`
  }
  const allowed = ALLOWED_WRITES[level]
  if (allowed.has(toolName)) return undefined
  const allowedList = allowed.size > 0 ? [...allowed].join('、') : '（该级别不自动做任何写操作）'
  return `自主级别 ${level}：${toolName} 必须人确认（该级别只自动放行 ${allowedList}）`
}

/** 白名单判断：不在名单里的工具一律拒绝（单调守卫用，不做例外）。 */
export function guardReasonFor(toolName: string): string | undefined {
  return ALLOWED_TOOLS.has(toolName) ? undefined : `工具不在治理白名单内：${toolName}`
}

/**
 * 挂载审批与守卫。
 * 监听器写成 waterfall：先 `await next()` 让后续策略跑完，再决定是否收紧。
 */
export function mountApproval(ctx: Context, level: () => AutonomyLevel): void {
  ctx.on('tools/pre-execute', async (exec, next) => {
    // waterfall 的规矩：必须调用 next()，否则链条断在这里。
    const decision = await next()
    const reason = denyReasonFor(level(), exec.name)
    if (reason) return { kind: 'deny', reason } as typeof decision
    return decision
  })

  ctx.tools.guard((exec) => guardReasonFor(exec.name))
}
