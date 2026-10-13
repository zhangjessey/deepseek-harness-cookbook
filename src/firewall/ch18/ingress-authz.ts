// src/firewall/ch18/ingress-authz.ts —— ingress-authz：Consumer（数据面入口）
//
// 数据面（data plane）的强制点：挡在真正处理请求之前。两件事：
//  1) 入口先拒绝超长字段——这是"边界"的职责，不是引擎的职责（引擎只看归一化后的请求）。
//  2) 再交给 firewall.evaluate 做规则判定。
// 它只认 firewall 契约，不管规则是哪来的——这就是"数据面"与"规则来源"解耦。
import { Context, Service } from '@deepseek-ai/cordis'
import { FIELD_MAX_LEN } from './rules'
import { Decision, HttpRequest } from './types'

declare module '@deepseek-ai/cordis' {
  interface Context {
    ingressAuthz: IngressAuthz
  }
}

export class IngressAuthz extends Service {
  static inject = ['firewall'] as const

  constructor(ctx: Context) {
    super(ctx, 'ingressAuthz')
  }

  // 数据面入口：先由"入口"拒绝超长字段，再交给 firewall 评估。
  authorize(request: HttpRequest): { decision: Decision | null; rejectedByEntry?: boolean } {
    if (isOverlong(request)) {
      return {
        decision: { action: 'deny', ruleId: 'entry', ruleName: 'entry: 字段超过上限，入口拒绝' },
        rejectedByEntry: true,
      }
    }
    // 强制点的兜底：判定不了就拒绝（fail-closed）。异常若穿透出去，后果是进程崩 →
    // nginx 侧 auth_request 拿到 5xx；宿主若把错误页转成 200，就等于全放行。
    let decision: Decision | null
    try {
      decision = this.ctx.firewall.evaluate(request)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return {
        decision: { action: 'deny', ruleId: 'error', ruleName: `evaluate 异常，默认拒绝：${reason}` },
        rejectedByEntry: true,
      }
    }
    if (decision) return { decision }
    // 白名单模式：未命中 allow → 默认拒绝（fail-closed）；黑名单模式：默认放行。
    // 这是 firewall.evaluate 返回 null 时"由上层处理"的那一半——引擎只报"没命中"，默认动作由入口定。
    if (this.ctx.firewall.getMode() === 'whitelist') {
      return { decision: { action: 'deny', ruleId: 'default', ruleName: 'whitelist: 未命中 allow，默认拒绝' } }
    }
    return { decision: null }
  }
}

// 超长字段由入口拒绝：引擎不处理"超出系统上限"的请求——这类请求在入口就挡掉，
// 避免超大载荷进入匹配/评测路径。"线性不等于便宜"：超长字段即便能匹配，代价也不可接受。
// 只查 path / body / ua 三处：这是最可能被灌大的字段（URL、请求体、UA）；headers/query
// 也可能超长，但真实部署由 nginx 等前置件限流，本讲引擎只守住这三处（够演示"边界先拒"）。
function isOverlong(req: HttpRequest): boolean {
  return (
    (req.path?.length ?? 0) > FIELD_MAX_LEN ||
    (req.body?.length ?? 0) > FIELD_MAX_LEN ||
    (req.ua?.length ?? 0) > FIELD_MAX_LEN
  )
}
