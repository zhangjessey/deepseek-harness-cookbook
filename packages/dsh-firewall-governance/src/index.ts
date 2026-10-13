// packages/dsh-firewall-governance/src/index.ts
//
// 本包是第19讲「规则持久化与自治」的可安装 dsh 组合包（bundle）。
// 引擎与机制实现复用 cookbook 的 src/firewall/ch19（构建时由 esbuild 内联进 lib/，发布产物自包含）。
//
// 安装：dsh plugin --profile <name> add ./packages/dsh-firewall-governance
//
// 本讲落点（详见 ch19 正文）：账本 = dsh 会话日志的投影；五个自主级别约束"谁能在什么程度改规则"；
// 治理 Agent 的写操作（起草/审批/驳回）受 dsh tools 管道的 pre-execute 默认拒绝 + 单调 guard 约束
// （见 dsh `packages/core/tools`），本包只在 tools 服务存在时把对应工具暴露给治理 Agent。
//
// 【审批闸必须挂上】注册写工具而不挂 mountApproval，等于把"人始终在 Agent 之上"变成一句注释：
// 任何 Agent 在任何级别都能起草、批准、发布。所以子插件里第一件事就是挂闸。
import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Ledger } from '../../../src/firewall/ch19/ledger'
import { mountLedgerLog } from '../../../src/firewall/ch19/session-log'
import { FirewallCommand, type AutonomyLevel } from '../../../src/firewall/ch19/command-firewall'
import { FirewallEdit } from '../../../src/firewall/ch19/tool-firewall-edit'
import { mountApproval, GOVERNANCE_TOOLS } from '../../../src/firewall/ch19/approval'
import { toJson } from '../../../src/firewall/shared/json.ts'

export const name = 'dsh-firewall-governance'
// 注意：主条目不声明 tools 依赖——宿主没有 tools 服务时主条目仍要能激活（账本与命令能力不受影响）。
// 工具注册放进子插件 firewall-governance-tools，由它声明 inject tools：
// 有 tools 就注册，没有就 pending，等价于"跳过注册"。若在主条目上直接声明，宿主无 tools 时
// 整个条目会 pending 不激活，也就谈不上"跳过工具注册、账本命令仍在"。

export interface GovernanceConfig {
  file: string
  sessionId: string
  agentsSessionId: string
  /**
   * 账本事实日志（权威）的持久化根目录，默认宿主 cwd 下的 `.dsh-sessions`。
   * 真实部署里必须显式指定——它决定"权威"落在哪，也是唯一不该与别的包共用的目录。
   */
  root?: string
}

function warn(ctx: Context, msg: string): void {
  const logger = (ctx as unknown as { logger?: { warn?: (m: string) => void } }).logger
  logger?.warn?.(msg)
}

export function apply(ctx: Context, config: Partial<GovernanceConfig> = {}): void {
  const file = config.file ?? 'firewall.ledger.json'
  const sessionId = config.sessionId ?? 'sess-firewall'
  const agentsSessionId = config.agentsSessionId ?? sessionId
  // 账本：把账本事件（rule.add / rule.update / rule.reject / rule.remove）折叠成当前规则集；
  // 发布串行 + 比较并交换（CAS），原子写文件，重启从文件恢复（logged -> 可重建）。
  // 权威链路：dsh 会话服务 → 账本事实日志（权威） → 账本（权威 + 文件投影）。
  //
  // **必须走 `mountLedgerLog` 而不能只挂 `SessionStore`**：后者不带 JSONL 持久化，
  // 于是"会话日志是账本"这句话不成立——进程一退权威就没了。更实质的一条是：
  // 权威恒空会让 `adoptProjection` **每次启动**都走"带外补记"分支，把磁盘投影按
  // `state` 原样补记回权威；那条兜底路径本该只在首次运行命中（本讲的单向保证是
  // logged → 可重建，文件只是产物），不挂持久化会把它变成每次重启的常规路径——
  // "文件被改过就转 active"于是天天发生。
  ctx.plugin({
    name: 'firewall-governance-ledger-log',
    async apply(c: Context) {
      await mountLedgerLog(c, { sessionId, root: config.root })
    },
  })

  ctx.inject(['ledgerLog'], (lc: Context) => {
    const ledger = new Ledger(lc.ledgerLog, file, agentsSessionId)

    // 启动对账**必须**跑：会话日志（权威）为空、磁盘投影却有内容时，把投影补记回权威。
    // 这一步在 demo 里有、组合包里原本漏了——漏掉的话，上一次运行发布的规则在重启后
    // 既不进权威也不进判定（规则看起来还在文件里，实际根本没生效）。
    // 它是异步的，所以放进独立插件；命令与工具必须等补记完成再建，
    // 否则会基于不完整的权威对外服务。
    lc.plugin({
      name: 'firewall-governance-adopt',
      async apply(adopted: Context) {
        await ledger.adoptProjection()
        // /firewall 命令 + 自主级别（人掌握决定权的直接界面）。
        const cmd = new FirewallCommand(ledger)
        // 治理 Agent 的写工具：起草候选 / 批准 / 驳回（第一稿只是候选，人审批后才转 active）。
        const edit = new FirewallEdit(ledger)

        adopted.plugin({
          name: 'firewall-governance-tools',
          inject: ['tools'] as const,
          apply(c: Context) {
            if (!c.tools) {
              warn(c, '[firewall-governance] 未检测到 tools 服务，跳过治理工具注册（账本/命令能力仍在）')
              return
            }

            // 审批闸：pre-execute waterfall（按自主级别收紧）+ 单调 guard（白名单外的工具一律拒绝）。
            // 必须在注册工具**之前**挂，且级别取当前值（运行时改级别立即生效）。
            mountApproval(c, () => cmd.getLevel())

            c.tools.register(
              defineTool({
                name: GOVERNANCE_TOOLS.list,
                description: '列出当前防火墙规则库（含状态，只读）。',
                parameters: {},
                output: {
                  schema: { type: 'json' },
                  render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
                },
                async execute() {
                  return toJson({ rules: ledger.listRules() })
                },
              }),
            )

            c.tools.register(
              defineTool({
                name: GOVERNANCE_TOOLS.level,
                description: '查看或调整自主级别（0 | manual | 1 | 2 | off）。级别不合法会被拒绝并说明可选值。',
                parameters: {
                  level: { type: 'string', required: true, description: '目标级别：0 | manual | 1 | 2 | off' },
                },
                output: {
                  schema: { type: 'json' },
                  render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
                },
                async execute(args) {
                  // setLevel 自己校验取值：未知级别一律拒绝，而不是被当成某个级别放行。
                  return toJson({ result: cmd.setLevel(String(args.level) as AutonomyLevel) })
                },
              }),
            )

            c.tools.register(
              defineTool({
                name: GOVERNANCE_TOOLS.draft,
                description: '治理 Agent 起草一条候选规则（不直接生效，需审批）。',
                parameters: {
                  name: { type: 'string', required: true, description: '规则名' },
                  action: { type: 'string', required: true, description: '动作：deny | allow' },
                  when: { type: 'object', required: true, additionalProperties: true, description: '条件树（when）' },
                  unless: { type: 'object', additionalProperties: true, description: '例外条件（可选）' },
                },
                output: {
                  schema: { type: 'json' },
                  render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
                },
                async execute(args) {
                  if (args.action !== 'deny' && args.action !== 'allow') {
                    throw new Error(`action 必须是 deny 或 allow，收到 ${String(args.action)}`)
                  }
                  const id = await edit.draftCandidate({
                    name: String(args.name),
                    action: args.action,
                    when: args.when,
                    unless: args.unless,
                  })
                  return toJson({ id, state: 'candidate' })
                },
              }),
            )

            c.tools.register(
              defineTool({
                name: GOVERNANCE_TOOLS.approve,
                description: '批准一条候选规则，使其转为 active。目标不存在或非候选态会报错（不会静默成功）。',
                parameters: { id: { type: 'string', required: true, description: '候选规则 id' } },
                output: {
                  schema: { type: 'json' },
                  render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
                },
                async execute(args) {
                  await edit.approve(String(args.id))
                  return toJson({ id: String(args.id), state: 'active' })
                },
              }),
            )

            c.tools.register(
              defineTool({
                name: GOVERNANCE_TOOLS.reject,
                description: '驳回一条候选规则（移除）。',
                parameters: { id: { type: 'string', required: true, description: '候选规则 id' } },
                output: {
                  schema: { type: 'json' },
                  render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
                },
                async execute(args) {
                  await edit.reject(String(args.id))
                  return toJson({ id: String(args.id), removed: true })
                },
              }),
            )
          },
        })
      },
    })
  })
}

// dsh loader 通过 module.default ?? module 取插件：默认导出即插件对象（主条目无 inject 依赖）。
export default { name, apply }
