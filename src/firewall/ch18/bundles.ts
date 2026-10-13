// src/firewall/ch18/bundles.ts —— 三个 bundle：把插件按职责分组后挂上树
//
// 一个 dsh 应用不是"一个文件"，而是把若干插件按职责分组、再依次挂上插件树。这里给本讲的三个：
//  • engineBundle      —— 引擎核心：re2（Provider）+ firewall（Provider）
//  • dataPlaneBundle   —— 数据面：ingress-authz（入口）+ rules-file（规则来源）
//  • controlPlaneBundle—— 控制面：tool-firewall（只读工具，无 tools 服务时自动跳过）
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SafeRe2Matcher } from './re2-matcher'
import { FirewallEngine } from './firewall'
import { assertRulesLoaded, rulesFile, RulesFileConfig } from './rules-file'
import { IngressAuthz } from './ingress-authz'
import { toolFirewall } from './tool-firewall'

// 引擎核心 bundle：注册两个 Provider。
export const engineBundle = {
  name: 'firewall-engine',
  apply(ctx: Context) {
    ctx.plugin(SafeRe2Matcher) // re2 的 Service Provider
    ctx.plugin(FirewallEngine) // firewall 的 Service Provider（注入 re2）
  },
}

// 数据面 bundle：入口 + 规则来源 Consumer。规则文件路径由部署配置传入。
export const dataPlaneBundle = {
  name: 'firewall-data-plane',
  // 必须声明 `inject: ['firewall']`：装配后的确认（`assertRulesLoaded`）要读 `ctx.firewall`。
  // 不声明的话 cordis 在**运行时**抛 `cannot get property "firewall" without inject`
  // ——类型上骗得过去，运行时骗不过。
  inject: ['firewall'] as const,
  Config: z.object({ file: z.string() }),
  async apply(ctx: Context, config: RulesFileConfig) {
    // 两个子插件都必须 **await**：cordis 的子插件是异步挂载的，不 await 就去检查
    // 规则库，看到的是"还没灌入"的空库——那条守卫于是会在正常情况下也报错。
    await ctx.plugin(IngressAuthz) // 数据面入口
    await ctx.plugin(rulesFile, { file: config.file }) // 规则来源 Consumer
    // 装配后**必须**确认规则真的灌进来了。
    //
    // 少了这一步，规则文件路径写错（或文件被删/改名）时的表现是：cordis 把 `rulesFile`
    // 记为加载失败、**不向调用方传播**，于是引擎照常起来、规则库却是空的——
    // 黑名单模式下等于全放行，而且没有任何报错。
    // 这一步原先只加在两个 demo 里，生产装配路径（本 bundle）反而没接到，等于没防。
    assertRulesLoaded(ctx, config.file)
  },
}

// 控制面 bundle：只读工具 Consumer（无 tools 服务时自动跳过）。
export const controlPlaneBundle = {
  name: 'firewall-control-plane',
  apply(ctx: Context) {
    ctx.plugin(toolFirewall)
  },
}
