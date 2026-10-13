// src/firewall/ch18/rules-file.ts —— rules-file：Consumer（数据面的规则来源）
//
// 它是 firewall 契约的"消费者"：从规则文件（发布产物、只读）读入规则，灌进 firewall 服务。
// firewall 不知道规则来自内存还是文件——这正是 seam 的意义。第19讲会在它之上加"带外修改立即生效、
// 账本补记"；本讲只做"启动时整体载入"。
import { Context } from '@deepseek-ai/cordis'
import { existsSync, readFileSync } from 'node:fs'
import { assertValidCondition } from './condition'
import { RuleInput } from './types'

export interface RulesFileConfig {
  file: string
}

export const rulesFile = {
  name: 'rules-file',
  inject: ['firewall'] as const,
  apply(ctx: Context, config: RulesFileConfig) {
    const firewall = ctx.firewall
    firewall.loadRules(readRulesFile(config.file))
  },
}

/**
 * 装配后确认：规则**真的**灌进来了吗。
 *
 * 为什么必须有它：`rulesFile` 抛错时（文件不存在、某条规则不合法），cordis 只会把该
 * 插件记为失败、**不向调用方传播**——表现为进程"正常启动"、规则库却是空的，黑名单模式下
 * 等于**全放行，而且没有任何报错**。这是安全组件最坏的失败形态。
 * 所以装配方必须在 `ctx.plugin(...)` 之后显式确认一次，不能假定"挂上了就是成功了"。
 *
 * 三种情况必须分开处理，混在一起就会误伤合法场景：
 *  ① 文件读不出来（不存在 / 某条规则不合法）→ **硬失败**
 *  ② 文件里有规则却一条都没进引擎     → **硬失败**（插件加载失败了）
 *  ③ 文件本身就是空规则库             → **合法**，按模式决定：
 *     黑名单模式只是默认放行（合法起始状态，warn）；
 *     白名单模式则等于拒绝全部请求（要么有意为之、要么配错了，拒绝启动）。
 */
export function assertRulesLoaded(ctx: Context, file: string): void {
  // 引擎插件没挂上时 `ctx.firewall` 是 undefined——最常见的原因是 re2 守卫
  // （assertRealRe2）在 FirewallEngine 构造时抛错，而 cordis 不把插件异常抛给调用方。
  // 直接往下走只会得到 "Cannot read properties of undefined"，看不出真正的原因。
  if (!ctx.firewall) {
    throw new Error(
      'firewall 服务不存在：引擎插件没挂上（cordis 不把插件异常抛给调用方）。' +
        '若刚改过 re2 匹配器，最可能是 assertRealRe2 守卫拒绝了它——见 re2-matcher.ts。',
    )
  }
  if (ctx.firewall.listRules().length > 0) return
  // ①②都在这里现形：文件读不出来、或某条规则不合法，`readRulesFile` 会抛错。
  const onDisk = readRulesFile(file)
  if (onDisk.length > 0) {
    throw new Error(
      `规则文件里有 ${onDisk.length} 条规则却一条都没载入：${file}。` +
        `这通常意味着插件加载失败了（cordis 不会把插件异常抛给调用方）。` +
        `绝不带空规则库上线——黑名单模式下等于全放行。`,
    )
  }
  // ③ 空规则库：合法起始状态还是配错了，取决于模式
  if (ctx.firewall.getMode() === 'whitelist') {
    throw new Error(
      `白名单模式下规则库为空等于拒绝全部请求：${file} 里没有规则。` +
        `若确要"默认全拒"请显式确认；否则请检查规则文件路径。`,
    )
  }
  ctx.logger?.warn?.(`[${rulesFile.name}] 规则库为空（${file} 里没有规则）——黑名单模式下默认放行，属合法起始状态`)
}

/**
 * 读取并**逐条校验**规则文件——导出它是为了让组合包（`packages/dsh-firewall-rule`）
 * 复用同一份实现：两边各写一份的话，失败策略与校验口径迟早漂移（而组合包是"装进真实
 * dsh"的那一份，漂移的代价是线上行为与 cookbook 不一致）。
 *
 * 校验不是形式：文件里一个拼错的 op（`regex`）、一个非 deny/allow 的 action、一个缺 field
 * 的 when，若被静默接受，会变成一条**永不命中**的规则——界面上显示"3 条规则在防护"，
 * 实际全放行。所以对每条规则逐项校验，失败时带上序号与收到的值，让人能直接改。
 */
export function readRulesFile(file: string): RuleInput[] {
  if (!existsSync(file)) throw new Error(`规则文件不存在：${file}`)
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { rules?: unknown }
  if (!Array.isArray(parsed.rules)) throw new Error('规则文件顶层需有 rules 数组')
  return parsed.rules.map((raw, i) => parseRule(raw, `规则文件 ${file} 第 ${i + 1} 条`))
}

function parseRule(raw: unknown, where: string): RuleInput {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${where}：必须是对象，收到 ${JSON.stringify(raw)}`)
  const r = raw as Record<string, unknown>
  if (typeof r.name !== 'string' || r.name.trim() === '') {
    throw new Error(`${where}：name 必须是非空字符串，收到 ${JSON.stringify(r.name)}`)
  }
  if (r.action !== 'deny' && r.action !== 'allow') {
    throw new Error(`${where}：action 必须是 deny 或 allow，收到 ${JSON.stringify(r.action)}`)
  }
  const when = assertValidCondition(r.when, `${where} 的 when`)
  const unless = r.unless === undefined ? undefined : assertValidCondition(r.unless, `${where} 的 unless`)
  return { name: r.name, action: r.action, when, unless }
}
