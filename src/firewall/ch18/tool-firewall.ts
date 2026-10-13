// src/firewall/ch18/tool-firewall.ts —— tool-firewall：Consumer（控制面只读工具）
//
// 控制面（control plane）的暴露点：把 firewall 的能力以"只读工具"形式交给治理 Agent。
// 这里只暴露 list_rules / check_request 两个只读工具——写操作（增删改规则）在第 19、21 讲，
// 且受 tools.guard 白名单 + 人审批约束。本讲只做"只读暴露"，演示数据面与控制面如何共用同一份 firewall 契约。
//
// inject 纪律：主条目只声明它真正依赖的 `firewall`，**不声明 `tools`**——否则宿主没有 tools 服务时，
// 整个条目会 pending 不激活，而不是"跳过工具注册"。工具注册放进声明了 `inject: ['tools']` 的子插件：
// 宿主无 tools 服务时，子插件 pending（等价于"跳过注册"），主条目本身照常激活。
import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Firewall } from './firewall'
import { IngressAuthz } from './ingress-authz'
import { HttpRequest } from './types'

/**
 * 把任意值归一成字符串映射（与数据面 flattenHeaders 同口径：引擎只认字符串）。
 * check_request 的 schema 是 additionalProperties: true，调用方可能传数字/布尔/嵌套对象；
 * 不归一的话，非字符串值进入 lookupHeader/getField 后会因 `typeof !== 'string'` 静默 false，
 * 试算结论与真实流量不一致。
 */
function normalizeStringMap(v: unknown): Record<string, string> {
  if (typeof v !== 'object' || v === null) return {}
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v)) {
    if (val === undefined || val === null) continue
    out[k] = typeof val === 'string' ? val : String(val)
  }
  return out
}

export const toolFirewall = {
  name: 'tool-firewall',
  inject: ['firewall'] as const,
  apply(ctx: Context) {
    const firewall: Firewall = ctx.firewall

    ctx.plugin({
      name: 'tool-firewall-tools',
      // tools 用来注册工具；ingressAuthz 是**数据面强制点**——check_request 必须走它，
      // 见下面 check_request 里的说明。
      inject: ['tools', 'ingressAuthz'] as const,
      apply(c: Context) {
        const ingressAuthz: IngressAuthz = c.ingressAuthz
        c.tools.register(
          defineTool({
            name: 'list_rules',
            description: '列出当前防火墙规则库（只读）。',
            parameters: {},
            output: {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: { rules: { type: 'array' } },
              },
              render: (_args, value) => [{ type: 'text', text: JSON.stringify(value.rules, null, 2) }],
            },
            async execute() {
              return {
                rules: firewall.listRules().map((r) => ({ id: r.id, name: r.name, action: r.action })),
              }
            },
          }),
        )

        c.tools.register(
          defineTool({
            name: 'check_request',
            description: '评估一条请求会命中哪条规则（只读，不修改规则）。',
            parameters: {
              method: { type: 'string', required: true, description: 'HTTP 方法' },
              path: { type: 'string', required: true, description: '请求路径' },
              ip: { type: 'string', description: '客户端 IP' },
              ua: { type: 'string', description: 'User-Agent' },
              body: { type: 'string', description: '请求体（可选）' },
              headers: {
                type: 'object',
                additionalProperties: true,
                description: '请求头（可选，用于 header.<name> 规则试算）',
              },
              query: {
                type: 'object',
                additionalProperties: true,
                description: '查询参数（可选，用于 query.<name> 规则试算）',
              },
            },
            output: {
              // decision 可能为 null（未命中），形状随判定结果变化，这里只约束"是对象"，不锁死内部结构。
              schema: { type: 'object', additionalProperties: true },
              render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
            },
            async execute(args) {
              const req: HttpRequest = {
                method: String(args.method),
                path: String(args.path),
                ip: String(args.ip ?? ''),
                ua: String(args.ua ?? ''),
                body: args.body ? String(args.body) : undefined,
                // 值归一成字符串（与数据面 flattenHeaders 同口径）：schema 是
                // additionalProperties: true，值可以是数字/布尔/嵌套对象。`as Record<string,
                // string>` 是断言，非字符串值进入 lookupHeader/getField 后会因 `typeof !==
                // 'string'` 静默 false，试算结论与真实流量不一致。
                headers: normalizeStringMap(args.headers),
                query: normalizeStringMap(args.query),
              }
              // 走**数据面入口**（强制点），而不是直接调 `firewall.evaluate`。两者差两件事：
              //  · 入口有边界检查（超长字段直接拒绝）——绕过它，等于在试算一条真实流量里
              //    根本到不了这里的请求，Agent 据此得出的结论是假的；
              //  · 入口有模式默认动作（白名单未命中即拒绝，fail-closed）——直接 evaluate
              //    返回 null，于是同一个"未命中"在控制面被读作**放行**、在数据面被读作
              //    **拒绝**：两条路径结论相反。控制面是给治理 Agent 做判断用的，口径必须
              //    与真正拦流量的那一侧一致，否则它基于试算做的决定是错的。
              const r = ingressAuthz.authorize(req)
              return {
                decision: r.decision
                  ? { action: r.decision.action, ruleId: r.decision.ruleId, ruleName: r.decision.ruleName }
                  : null,
                rejectedByEntry: r.rejectedByEntry ?? false,
              }
            },
          }),
        )
      },
    })
  },
}
