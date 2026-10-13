// src/firewall/ch19/command-seam.ts —— /firewall 命令注册到 dsh 的 commands seam
//
// 这是"人工命令"这条线真正接上 dsh 的地方：不再自己解析命令行字符串，
// 而是把命令注册进 `ctx.commands`（dsh 的命令注册表），让 dsh 的 UI / 会话
// 按它自己的规则分发命令、记录 `command/run` 与 `command/done` 事件。
//
// 领域逻辑（list / level / approve / reject）留在 command-firewall.ts 的
// `handle` 里，纯文本进、纯文本出；这里只做"注册 + 把 rawInput 交给领域逻辑"。
import type { Context } from '@deepseek-ai/cordis'
// 引入 dsh-commands 的类型：声明合并给 Context 加上 `commands` 服务。
import '@deepseek-ai/dsh-commands'
import { FirewallCommand } from './command-firewall'

export function mountFirewallCommand(ctx: Context, cmd: FirewallCommand): void {
  // 用 inject 而不是直接取：宿主没有 commands 服务（比如只跑数据面）时跳过注册。
  ctx.inject(['commands'], (c) => {
    // register 返回 disposer，交给 effect：随插件卸载，命令一起消失。
    c.effect(() =>
      c.commands.register({
        name: 'firewall',
        description: '查看 / 调整防火墙规则与自主级别，批准或驳回候选',
        handler: async (invocation) => {
          // rawInput 是命令名之后的文本（含前导空格），正好交给领域逻辑的 handle。
          // handle 是异步的（要等发布真正落链才回报），dsh 的 handler 支持返回 Promise；
          // 抛错会被 dsh 收敛成 `kind: 'error'` 结果，不会变成 unhandled rejection。
          const text = await cmd.handle(invocation.rawInput)
          return { kind: 'success', text }
        },
      }),
    )
  })
}
