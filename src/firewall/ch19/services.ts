// src/firewall/ch19/services.ts —— dsh 接线层：把 ch19 的领域组件注册成 cordis Service
//
// 分层原则：领域逻辑（ledger / command / edit）保持纯 TS、不 import cordis，便于单测与复用；
// 本文件只负责"接线"——把领域组件挂到 cordis 树上，让数据面与控制面**通过服务名通信**，
// 而不是靠模块级全局变量。这正是第 18 讲"能力 seam"在 ch19 的落地：
//   LedgerService  = Provider（数据面，提供 ctx.ledger）
//   ControlService = Consumer（控制面，inject: ['ledger']）
//
// 为什么不再用全局变量：全局变量无法多实例、测试无法隔离、卸载后状态残留，
// 而且"两个平面跑两个进程"的产品决定，要求两者的耦合必须是可替换的服务引用。
import { Context, Service } from '@deepseek-ai/cordis'
import { Ledger } from './ledger'
import { FirewallCommand } from './command-firewall'
import { FirewallEdit } from './tool-firewall-edit'
import { mountFirewallCommand } from './command-seam'

export interface LedgerConfig {
  file: string
  sessionId: string
  agentsSessionId: string
  /** 权威（会话日志）的落盘目录；不传则用当前工作目录下的 `.dsh-sessions`。 */
  root?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    ledger: LedgerService
    firewallControl: ControlService
  }
}

/**
 * 数据面：持有账本，注册成 `ctx.ledger`。
 *
 * 账本的**权威是会话日志**（`ctx.ledgerLog`），文件只是投影产物——
 * 所以这里声明 `inject: ['ledgerLog']`，由 Cordis 保证权威先就绪再建账本。
 */
export class LedgerService extends Service {
  static inject = ['ledgerLog'] as const

  private _ledger?: Ledger

  constructor(
    ctx: Context,
    private config: LedgerConfig,
  ) {
    super(ctx, 'ledger')
  }

  get ledger(): Ledger {
    this._ledger ??= new Ledger(this.ctx.ledgerLog, this.config.file, this.config.agentsSessionId)
    return this._ledger
  }

  /**
   * cordis 的 `[Service.init]` 钩子：类插件在构造后运行，返回值会被 fiber 等待（支持 async）。
   *
   * 重启补记：会话日志为空、而投影文件里有内容（上一次运行的产物，或人直接改过文件）时，
   * 把文件里的规则补记回权威。放在这里而不是 edgeBundle 的 apply 里，是因为 edgeBundle
   * 访问 `ctx.ledger` 需要在 apply 里声明 inject，而 ledger 正是本服务提供的——
   * "inject 自己提供的服务"不自洽（会抛 `cannot get property "ledger" without inject`）。
   */
  [Service.init] = async (): Promise<void> => {
    await this.ledger.adoptProjection()
  }
}

/**
 * 控制面：持有 `/firewall` 命令与审批工具，注入 `ledger`。
 * 与 ch18 的 IngressAuthz 一致——注入的服务在**方法调用时**才访问，不在 constructor 里碰。
 */
export class ControlService extends Service {
  static inject = ['ledger'] as const

  private _command?: FirewallCommand
  private _edit?: FirewallEdit

  constructor(ctx: Context) {
    super(ctx, 'firewallControl')
    // 人工命令：有 commands 服务时通过 dsh commands seam 注册（数据面没有则跳过）。
    // this.command 是惰性 getter，回调触发时 ledger 已就绪，可以安全创建。
    ctx.inject(['commands'], (c) => {
      mountFirewallCommand(c, this.command)
    })
  }

  /** `/firewall` 命令与五个自主级别（级别状态由命令自己持有，故缓存实例）。 */
  get command(): FirewallCommand {
    return (this._command ??= new FirewallCommand(this.ctx.ledger.ledger))
  }

  /** 审批工具：起草候选 / 批准 / 驳回。 */
  get edit(): FirewallEdit {
    return (this._edit ??= new FirewallEdit(this.ctx.ledger.ledger))
  }
}
