// src/firewall/ch19/command-firewall.ts —— command-firewall：/firewall 命令 + 五个自主级别
//
// 人掌握决定权的直接界面：/firewall list 看规则、/firewall level <x> 调自主级别、
// /firewall approve <id> 批准候选。五个级别：0/manual、1(默认)、2、off。
import { Ledger, Rule } from './ledger'
import { FirewallEdit } from './tool-firewall-edit'

export type AutonomyLevel = '0' | 'manual' | '1' | '2' | 'off'

const LEVEL_DESC: Record<AutonomyLevel, string> = {
  '0': '每一步都确认，Agent 不自动做变更',
  manual: '每一步都确认（同 0）',
  '1': 'shadow 自动；灰度与转正确认',
  '2': '新增类过门槛自动；收窄与下线确认',
  off: '撤下治理工具，Agent 不能改规则',
}

export class FirewallCommand {
  private level: AutonomyLevel
  /**
   * 命令（人的界面）与工具（Agent 的界面）是两条入口，但**动作必须是同一份实现**。
   * 各写一份的话迟早漂移——现在已经漂过一次：命令的 reject 发 `rule.remove` 直接删除，
   * 而工具的 reject 是"标成 rejected、留在账本里"。于是"人驳回"和"Agent 驳回"
   * 在账本里留下完全不同的痕迹，事后说不清这条规则到底经历了什么。
   */
  private edit: FirewallEdit

  constructor(
    private ledger: Ledger,
    level: AutonomyLevel = '1',
  ) {
    this.level = level
    this.edit = new FirewallEdit(ledger)
  }

  setLevel(level: AutonomyLevel): string {
    // 校验在前，且用 hasOwn 而不是 in：`in` 会命中原型链（`'toString' in LEVEL_DESC` 为真），
    // 于是 `level toString` 会被当成合法级别放行——一次拼写/注入就把"off"变成全自动。
    // 未知级别一律拒绝并保持原级别，而不是静默生效。
    if (!Object.hasOwn(LEVEL_DESC, level)) {
      return `未知自主级别：${String(level)}（可选：${Object.keys(LEVEL_DESC).join(' | ')}）`
    }
    this.level = level
    return `自主级别已设为 ${level}：${LEVEL_DESC[level]}`
  }

  getLevel(): AutonomyLevel {
    return this.level
  }

  // 处理 /firewall 命令文本：list / level / approve / reject。
  // 这里只负责"文本 → 动作"（纯领域逻辑）；真正的命令注册在 command-seam.ts 里
  // 挂到 dsh 的 commands seam，handler 收到的是命令名之后的 rawInput。
  //
  // 异步是刻意的：approve / reject 必须等发布真正落链才回报，否则命令会在事实
  // 还没进权威时就说"已批准"；而 publish 一旦抛错且没人接住，就会变成 unhandled
  // rejection（Node ≥15 会直接终止进程）。dsh 的 command handler 支持返回 Promise，
  // 且抛错会被收敛成 `kind: 'error'` 结果，所以这里如实向上抛。
  async handle(cmd: string): Promise<string> {
    const [op, ...rest] = cmd.trim().split(/\s+/)
    if (op === 'list') {
      const rules: Rule[] = this.ledger.listRules()
      return rules.map((r) => `  ${r.id} [${r.state}] ${r.name}`).join('\n') || '  (无规则)'
    }
    if (op === 'level') {
      if (!rest[0]) return `用法：/firewall level <${Object.keys(LEVEL_DESC).join('|')}>`
      const lv = rest[0] as AutonomyLevel
      if (!Object.hasOwn(LEVEL_DESC, lv)) return `未知级别：${lv}（可选：${Object.keys(LEVEL_DESC).join(' | ')}）`
      return this.setLevel(lv)
    }
    if (op === 'approve') {
      const id = rest[0]
      if (!id) return '用法：/firewall approve <id>'
      // 走 FirewallEdit（与 Agent 工具同一份实现）：目标必须存在且当前是 candidate，
      // 否则"批准了一条不存在的规则"会静默成功——界面说已批准、日志里躺着一条 approve
      // 事实，而规则从未存在，审计无从发现。
      // 失败**抛错**而不转成字符串：由 dsh 的命令 seam 收敛成 error 结果
      // （见 command-seam.ts），这样失败在人眼里是"错误"而不是一句普通回显。
      await this.edit.approve(id)
      return `已批准 ${id}（candidate → active）`
    }
    if (op === 'reject') {
      const id = rest[0]
      if (!id) return '用法：/firewall reject <id>'
      // `by` 记下这次驳回来自人的命令，而不是 Agent 的工具——审计时能区分两者。
      // 驳回是**归档**（留成 rejected 状态）而不是删除：理由见 ledger.ts 的 RuleState。
      await this.edit.reject(id, { by: '人（/firewall reject）' })
      return `已驳回 ${id}（state=rejected，保留在账本中）`
    }
    return `未知命令：${cmd}`
  }
}
