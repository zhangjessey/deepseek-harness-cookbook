// src/firewall/ch19/tool-firewall-edit.ts —— tool-firewall-edit：审批工具（起草候选 / 批准 / 驳回）
//
// 控制面给治理 Agent 的工具：第一稿只是候选（不直接 active），人审批后才转 active。
// 真实部署挂在全局 scope（与官方默认子插件作用域不同，已对照 dsh capability-seams / tools 确认）；这里提供纯函数供 demo / real-model-run 调用。
import { randomUUID } from 'node:crypto'
import { assertValidCondition } from '../ch18/condition.ts'
import { Ledger, RuleInput } from './ledger'

export class FirewallEdit {
  constructor(private ledger: Ledger) {}

  /**
   * Agent 起草：第一稿只是候选，不直接生效。
   *
   * 校验下沉到这一步是**必须**的：工具路径（`firewall_draft`）收到的是模型可控的 JSON，
   * 若不在写进权威之前校验，被注入的治理 Agent 就能写进任意条件树——包括 `unless`，
   * 那正是在一条 deny 规则上开洞的字段。模型助手（agent-draft）里那层校验只是可选的
   * 前置过滤，**闸门必须在"写进权威"这一步**，否则换个调用方就绕过去了。
   *
   * 返回 Promise 是刻意的：发布走串行写链，不等它落链就返回 id，调用方会在事实还没进
   * 权威时以为"起草成功了"；而 publish 抛错若没人接住，会变成 unhandled rejection
   * （Node ≥15 直接终止进程）。
   */
  async draftCandidate(input: RuleInput): Promise<string> {
    const when = assertValidCondition(input.when, 'draftCandidate 的 when')
    const unless =
      input.unless === undefined ? undefined : assertValidCondition(input.unless, 'draftCandidate 的 unless')
    // randomUUID 而不是 Math.random：后者可预测，且一旦碰撞，
    // 后面的 rule.add 会静默覆盖同 id 的既有规则。
    const id = `rule-${randomUUID().slice(0, 8)}`
    await this.ledger.publish({
      type: 'rule.add',
      id,
      input: { ...input, when, unless },
      at: Date.now(),
      state: 'candidate',
    })
    return id
  }

  // 人审批：把候选转 active（真实流程受自主级别与 tools/pre-execute 审批闸约束，见正文）。
  async approve(id: string): Promise<void> {
    // 目标必须存在、且当前是 candidate：否则"批准了一条不存在的规则"会**静默成功**——
    // 界面显示"已批准 xx"、日志里躺着一条 approve 事实，而规则从未存在，审计无从发现。
    this.requireExisting(id, '批准')
    await this.ledger.publish({ type: 'rule.update', id, patch: {}, at: Date.now(), state: 'active' })
  }

  /**
   * 驳回 / 下线：把规则标成 `rejected` 并**留在账本里**。
   *
   * 以前这里是 `rule.remove`（直接删除），后果是这条规则凭空消失——
   * "被谁、何时、为什么驳回"再也回答不了，审计时只能看到一个空缺。
   * 驳回是**归档**，不是删除；真正的清理另有 remove。
   */
  async reject(id: string, opts: { by?: string; reason?: string } = {}): Promise<void> {
    this.requireExisting(id, '驳回')
    await this.ledger.publish({
      type: 'rule.reject',
      id,
      at: Date.now(),
      by: opts.by,
      reason: opts.reason,
    })
  }

  private requireExisting(id: string, action: string): void {
    const target = this.ledger.listRules().find((r) => r.id === id)
    if (!target) throw new Error(`${action}失败：找不到规则 ${id}`)
    if (action === '批准' && target.state !== 'candidate') {
      throw new Error(`批准失败：规则 ${id} 当前是 ${target.state}，只有 candidate 能被批准`)
    }
    if (action === '驳回' && target.state === 'rejected') {
      // 重复驳回若静默成功，日志里会躺着两条一模一样的 reject 事实，
      // 而"到底驳回了一次还是两次"从此说不清。
      throw new Error(`驳回失败：规则 ${id} 已经是 rejected 状态`)
    }
  }
}
