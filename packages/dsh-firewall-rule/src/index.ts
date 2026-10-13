// packages/dsh-firewall-rule/src/index.ts
//
// 本包是「第18讲防火墙」的可安装 dsh 组合包（bundle）。引擎实现复用 cookbook 的
// src/firewall/ch18（构建时由 esbuild 内联进 lib/，因此发布产物自包含，不依赖 cookbook 源码）。
//
// 安装：dsh plugin --profile <name> add <本包路径 | github:org/cookbook | npm:dsh-firewall-rule>
//
// 注意：firewall 服务是本包自己注册的（FirewallEngine）。若在主条目上声明 inject: ['firewall']，
// 宿主会在 apply 之前就要求该服务就绪，而它恰恰要等 apply 执行后才存在——必然 pending 不激活
// （真实 dsh 下表现为 "1 entry did not activate: pending (waiting for service: firewall)"）。
// 因此主条目不声明 inject，需要访问 ctx.firewall 的载入逻辑放到子插件 firewall-rule-loader 里。
import { Context } from '@deepseek-ai/cordis'
import { SafeRe2Matcher } from '../../../src/firewall/ch18/re2-matcher'
import { FirewallEngine } from '../../../src/firewall/ch18/firewall'
import { IngressAuthz } from '../../../src/firewall/ch18/ingress-authz'
import { readRulesFile } from '../../../src/firewall/ch18/rules-file'
import { toolFirewall } from '../../../src/firewall/ch18/tool-firewall'

export function apply(ctx: Context): void {
  // 引擎核心：re2 Provider + firewall Provider（注入 re2）。
  ctx.plugin(SafeRe2Matcher)
  ctx.plugin(FirewallEngine)
  // 数据面入口（强制点）：宿主在自己的 HTTP 入口调用 ctx.ingressAuthz.authorize(req)。
  ctx.plugin(IngressAuthz)
  // 控制面只读工具：list_rules / check_request（工具注册在声明 inject: ['tools'] 的子插件里，
  // 无 tools 服务时子插件 pending、主条目照常激活）。
  ctx.plugin(toolFirewall)

  // 可选：从环境变量指定的规则文件整体载入规则库（缺省为空，由宿主运行时增删）。
  // 访问 ctx.firewall 需要 inject 声明，故放进子插件——主条目声明会自锁（见文件头注释）。
  ctx.plugin({
    name: 'firewall-rule-loader',
    inject: ['firewall'] as const,
    apply(c: Context) {
      const file = process.env.FIREWALL_RULES_FILE
      if (!file) return
      // 与 src 侧（rules-file.ts）**同一份**实现与失败策略：文件读不出来、或某条规则不合法
      // 就拒绝载入并上抛，而不是 warn 一下带空规则库继续——
      // 空规则库在黑名单模式下等于全放行，而"防火墙已加载"又会让宿主以为在防护。
      // 以前这里是三连 `as` 断言 + 失败只 warn，与 src 侧的严格校验正好相反。
      c.firewall.loadRules(readRulesFile(file))
    },
  })
}

export const name = 'dsh-firewall-rule'
// dsh loader 通过 module.default ?? module 取插件：默认导出即插件对象（主条目无 inject 依赖）。
export default { name: 'dsh-firewall-rule', apply }
