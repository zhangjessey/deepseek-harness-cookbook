// src/firewall/ch19/session-prompt.ts —— system prompt 片段：账本状态怎么给模型看
//
// dsh 的 system prompt 由若干**片段**按 order 升序拼接而成：
//   -100 = harness 身份，0 = 部署人设，100–199 = 工具说明。
// 本讲的账本片段取 60（在人设之后、工具说明之前）。
//
// 关键约束（dsh 模式）：**片段从日志折叠的状态渲染，不读文件、不读外部存储**。
// 否则恢复会话或分叉会话之后，模型看到的会是"现在的文件"，而不是"这个会话当时的状态"——
// 这就破坏了 model-visible ← logged（模型看到的内容必须能从会话日志重建）。
//
// order 还影响缓存：模型服务按 prompt 前缀缓存已算好的结果，前缀从某处变化，
// 缓存从那里失效。所以变化最少的排在前面——本片段内容只在规则变更时变，故排在工具说明之前。
import type { Context } from '@deepseek-ai/cordis'
import type { Rule } from './ledger'

export const LEDGER_SECTION_NAME = 'firewall:ledger'
export const LEDGER_SECTION_ORDER = 60

/** 把折叠出的规则渲染成给模型看的一段话（纯函数，便于测试）。 */
export function renderLedgerPrompt(rules: Rule[]): string {
  if (rules.length === 0) return '当前防火墙规则库为空（还没有任何已生效的规则）。'
  const lines = rules.map((r) => `- [${r.state}] ${r.name}（${r.action}）`)
  return [
    '下面是当前防火墙规则库。它由会话日志折叠得到，代表**这个会话**的状态，',
    '不一定是磁盘上规则文件此刻的内容。',
    ...lines,
  ].join('\n')
}

/**
 * 注册账本片段。用 `ctx.inject([...])` 而不是直接取：
 * 没有 systemPrompt 服务的装配（比如只跑数据面）时本插件不受影响。
 */
export function mountLedgerPrompt(ctx: Context): void {
  ctx.inject(['systemPrompt', 'ledgerLog'], (c) => {
    c.effect(() =>
      c.systemPrompt.section({
        name: LEDGER_SECTION_NAME,
        order: LEDGER_SECTION_ORDER,
        // text 是函数：每次组装 prompt 时重新渲染，内容永远来自折叠后的状态。
        text: () => renderLedgerPrompt(c.ledgerLog.state()),
      }),
    )
  })
}
