// src/firewall/ch19/bundles.ts —— bundle-edge / bundle-control：分别部署数据面与控制面
//
// 防火墙的产品决定是数据面、控制面跑两个进程。
//  • edgeBundle（数据面）：挂起会话日志权威（dsh 会话服务 + JSONL 持久化 + 重启恢复），
//    再注册账本服务（权威 + 文件投影）。
//  • controlBundle（控制面）：注册控制面服务，它声明 inject: ['ledger']，即"消费账本服务"。
//    控制面不依赖任何模块级全局变量：两者只通过服务名耦合。
//
// 这就是能力 seam 的意义——换掉账本实现，控制面一行都不用改；
// 也正因为耦合是可替换的服务引用，两个平面才可能真的拆成两个进程。
import { Context } from '@deepseek-ai/cordis'
import { ControlService, LedgerConfig, LedgerService } from './services'
import { mountLedgerLog } from './session-log'
import { mountApproval } from './approval'

export const edgeBundle = {
  name: 'firewall-edge',
  async apply(ctx: Context, config: LedgerConfig) {
    // 权威链路：dsh 会话服务 + JSONL 持久化 + 账本事实日志（权威），并尝试从磁盘恢复。
    await mountLedgerLog(ctx, { sessionId: config.sessionId, root: config.root })
    // 账本：权威是上面的会话日志，文件只是投影产物。
    // 重启补记（adoptProjection）由 LedgerService 的 [Service.init] 钩子负责，见 services.ts。
    // 这里 await 挂载，确保补记完成后再返回。
    await ctx.plugin(LedgerService, config)
  },
}

export const controlBundle = {
  name: 'firewall-control',
  apply(ctx: Context) {
    ctx.plugin(ControlService)
    // 审批与工具白名单只在有 tools 服务时挂载：数据面不跑 Agent，没有该服务，
    // 用 inject 就不会因为缺服务而加载失败。
    ctx.inject(['tools'], (c) => {
      mountApproval(c, () => c.firewallControl.command.getLevel())
    })
  },
}
