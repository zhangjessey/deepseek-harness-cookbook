// src/firewall/ch18/firewall-plugin.ts —— 把防火墙打包成 dsh 插件（开发调试：无侵入接入宿主）
//
// 想把这个防火墙塞进一个已有的 dsh 宿主（而不改宿主源码），就用 cordis 的 patch 机制——
// cordis.patch.yml 里一行 insert 把本插件挂进 Loader 注册表。本文件只做入口：把引擎的两个
// Provider 挂上，宿主就能通过 ctx.firewall 取用。
//
// 范围：本讲只演示到 boot() 装配为止，dsh 命令的完整行为见官方文档。
import { Context } from '@deepseek-ai/cordis'
import { SafeRe2Matcher } from './re2-matcher'
import { FirewallEngine } from './firewall'

export const name = 'firewall'

export function apply(ctx: Context): void {
  // 引擎核心：re2 Provider + firewall Provider（与 bundles.ts 的 engineBundle 等价）。
  // 在真实宿主里，这一步由 patch 的 insert 触发，无需改宿主源码。
  ctx.plugin(SafeRe2Matcher)
  ctx.plugin(FirewallEngine)
}
