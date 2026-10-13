// packages/dsh-firewall-eval-loop/src/index.ts
//
// 本包是第21讲「评测与闭环」的可安装 dsh 组合包（bundle）。
// 引擎与机制实现复用 cookbook 的 src/firewall/ch21（构建时由 esbuild 内联进 lib/，发布产物自包含）。
//
// 安装：dsh plugin --profile <name> add ./packages/dsh-firewall-eval-loop
//
// 本讲落点（详见 ch21 正文）：候选"真能拦吗"靠历史流量回放评测三件事（覆盖/精确/误伤）+ 事实校验
// + 从候选逆推证据；转正前过确认三关卡（命名/意图/风险，关卡写在工具代码里）；上线后进入生命周期
// 管理（shadow/灰度/active/老化/自动回退），候选转正涉及"自动/灰度"时由第19讲的自主级别控制。
//
// 【关卡为什么必须由服务端算】确认三关卡吃的是评测算出的误伤率。如果让模型把 evalResult 当参数
// 传进来，模型只要传一个 `falsePositiveRate: 0` 就能让 100% 误伤的候选"确定性地"通过风险关卡——
// 关卡就成了装饰。所以三个工具一律**服务端**跑 evaluate → confirm，模型只能给候选与样本路径。
import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { evaluate, loadHistoricalTraffic, wouldBlock, type EvalResult } from '../../../src/firewall/ch21/evaluate'
import { confirmCandidate } from '../../../src/firewall/ch21/confirm'
import { RuleLifecycle } from '../../../src/firewall/ch21/loop'
import { mountLoopTask } from '../../../src/firewall/ch21/loop-task'
import type { AutonomyLevel } from '../../../src/firewall/ch19/command-firewall'
import type { Candidate } from '../../../src/firewall/ch20/propose'
import { assertValidCondition } from '../../../src/firewall/ch18/condition.ts'
import { toJson } from '../../../src/firewall/shared/json.ts'

export const name = 'dsh-firewall-eval-loop'
// 同 ch19：主条目不声明 tools 依赖，工具注册放进声明了 inject tools 的子插件，
// 宿主无 tools 时该子插件 pending（即跳过注册），主条目本身照常激活。

function warn(ctx: Context, msg: string): void {
  const logger = (ctx as unknown as { logger?: { warn?: (m: string) => void } }).logger
  logger?.warn?.(msg)
}

/**
 * 模型给的候选是 JSON，形状必须校验：不校验就直接喂给评测，一条 `when: null` 会在
 * 条件树求值时抛 TypeError，把整次工具调用打挂。校验失败抛可行动错误而不是静默降级。
 */
function requireCandidate(value: unknown): Candidate {
  const v = value as Record<string, unknown> | null
  if (!v || typeof v !== 'object') throw new Error(`candidate 必须是对象，收到 ${JSON.stringify(value)}`)
  if (typeof v.id !== 'string' || typeof v.name !== 'string') {
    throw new Error(`candidate 需要字符串 id 与 name，收到 ${JSON.stringify(value)}`)
  }
  if (v.action !== 'deny')
    throw new Error(`candidate.action 必须是 'deny'（进化的候选只产阻断），收到 ${String(v.action)}`)
  if (!('when' in v)) throw new Error(`candidate 缺少 when 条件树，收到 ${JSON.stringify(value)}`)
  // 用 ch18 那一份校验器，而不是只查"有没有 when 这个键"：键存在但形状非法
  // （`when: null`、拼错的 op、缺 value 的叶子）会让求值抛 TypeError 把工具调用打挂，
  // 或更糟——静默永不命中（等于放行）。这里校验 + 收窄成 Condition 一举两得。
  return { id: v.id, name: v.name, action: 'deny', when: assertValidCondition(v.when, 'candidate.when') }
}

/** 自主级别也要校验：未知取值一律按最保守处理（不自动转正），而不是被当成"级别 2"。 */
function requireLevel(value: unknown): AutonomyLevel {
  const lv = String(value)
  if (lv === 'off' || lv === '0' || lv === 'manual' || lv === '1' || lv === '2') return lv
  throw new Error(`未知自主级别：${lv}（可选 0 | manual | 1 | 2 | off）`)
}

/**
 * 组合包配置。三项都可配：真实部署里闭环日志的落点与推进节奏都要能调
 * （写死的话，多 profile 会共用同一份闭环事实，还会往宿主 cwd 里写目录）。
 */
export interface EvalLoopConfig {
  /** 闭环事实日志的会话 id（默认 `firewall-loop`）。 */
  sessionId?: string
  /** 闭环事实日志的持久化根目录（默认宿主 cwd 下的 `.dsh-sessions`）。 */
  root?: string
  /** 后台任务推进间隔（毫秒，默认 60_000，可用环境变量 FIREWALL_LOOP_INTERVAL_MS 覆盖）。 */
  intervalMs?: number
}

export function apply(ctx: Context, config: EvalLoopConfig = {}): void {
  /**
   * 闭环**后台任务**：老化与自动回退由它推进（确定性的，不需要模型判断，也不需要人确认）。
   *
   * 前提是它真的在跑：以前工具每次调用都 `new` 一个 RuleLifecycle、用完即弃，于是
   * "连续 N 次无命中 → 老化"永远触发不了——自动回退这张安全网在真实部署里等于不存在。
   * 所以这里挂一个长住的任务，让**同一条规则**的观测能跨多次工具调用累积。
   */
  ctx.plugin({
    name: 'firewall-eval-loop-task',
    // 走 `mountLoopTask` 而不是自己 `c.plugin(...)`：挂日志与挂任务之间有**顺序依赖**
    // （必须先等 loopLog 就绪，再 attachLog），而 `c.plugin` 不 await 就返回，
    // 自己拼会得到"日志挂上了、但任务没接上"的静默降级——persistent 一直是 false。
    async apply(c: Context) {
      await mountLoopTask(c, {
        intervalMs: config.intervalMs ?? Number(process.env.FIREWALL_LOOP_INTERVAL_MS ?? 60_000),
        autonomyLevel: '1',
        // 闭环状态落盘：不落的话进程一重启，"这条规则已被回退过"就被忘了，
        // 同一条规则可以重新走一遍灰度。
        log: { sessionId: config.sessionId ?? 'firewall-loop', root: config.root },
      })
    },
  })

  ctx.plugin({
    name: 'firewall-eval-loop-tools',
    inject: ['tools'] as const,
    apply(c: Context) {
      if (!c.tools) {
        warn(c, '[firewall-eval-loop] 未检测到 tools 服务，跳过评测/闭环工具注册')
        return
      }

      // 工具一：评测候选（覆盖/精确/误伤 + 事实校验 + 逆推证据）。
      c.tools.register(
        defineTool({
          name: 'firewall_evaluate',
          description:
            '评测候选规则：覆盖/精确/误伤三件事 + 事实校验 + 从候选逆推证据。输出含 sampleSufficient —— 样本不足时误伤率不可信，不得据此转正。',
          parameters: {
            candidate: {
              type: 'object',
              required: true,
              additionalProperties: true,
              description: '候选规则对象 { id, name, action: "deny", when }',
            },
            trafficFile: { type: 'string', required: true, description: '历史流量日志路径（作回放样本）' },
          },
          output: {
            schema: { type: 'json' },
            render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
          },
          async execute(args) {
            const candidate = requireCandidate(args.candidate)
            const traffic = loadHistoricalTraffic(String(args.trafficFile))
            return toJson(evaluate(candidate, traffic))
          },
        }),
      )

      // 工具二：确认三关卡（命名/意图/风险）。evalResult 由服务端现算，不接受模型传入。
      c.tools.register(
        defineTool({
          name: 'firewall_confirm',
          description:
            '对候选规则跑确认三关卡（命名/意图/风险）。评测结果由服务端现算（不接受模型传入），因此风险关卡无法被伪造的误伤率骗过。',
          parameters: {
            candidate: {
              type: 'object',
              required: true,
              additionalProperties: true,
              description: '候选规则对象 { id, name, action: "deny", when }',
            },
            trafficFile: { type: 'string', required: true, description: '历史流量日志路径（作回放样本）' },
          },
          output: {
            schema: { type: 'json' },
            render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
          },
          async execute(args) {
            const candidate = requireCandidate(args.candidate)
            const traffic = loadHistoricalTraffic(String(args.trafficFile))
            const evalResult = evaluate(candidate, traffic)
            const report = confirmCandidate(candidate, evalResult)
            return toJson({ report, eval: evalResult })
          },
        }),
      )
    },
  })

  /**
   * 工具三（闭环推进）单独一个插件：它**依赖后台任务**（要把这条规则 track 进去），
   * 所以必须声明 `inject: ['firewallLoopTask']`。
   *
   * 用 `as unknown as { firewallLoopTask?: ... }` 绕过类型检查是没用的——cordis 在
   * **运行时**照样抛 `cannot get property "firewallLoopTask" without inject`
   * （README 里"实跑才知道的两条 inject 约束"正是这条：类型骗过了，运行时没骗过）。
   *
   * 分开声明还换来优雅降级：评测与确认两个工具只依赖 tools，后台任务挂不上时它们
   * 照常可用，只有"闭环推进"这一个工具会 pending。
   */
  ctx.plugin({
    name: 'firewall-eval-loop-tool',
    inject: ['tools', 'firewallLoopTask'] as const,
    apply(c: Context) {
      if (!c.tools) return

      // 工具三：闭环生命周期（shadow/灰度/active/老化/自动回退）。
      // 关键：`init` 的 autoConfirmAllowed 来自**真实的确认结果**，不是写死 true——
      // 三关没全过的候选只能停在 shadow，不能进灰度。
      c.tools.register(
        defineTool({
          name: 'firewall_loop',
          description:
            '闭环生命周期：先服务端跑评测与确认三关卡，三关全过才允许进灰度，然后按这条请求的观测推进 shadow/灰度/active/老化/自动回退。',
          parameters: {
            candidate: {
              type: 'object',
              required: true,
              additionalProperties: true,
              description: '候选规则对象 { id, name, action: "deny", when }',
            },
            trafficFile: { type: 'string', required: true, description: '历史流量日志路径（作回放样本）' },
            autonomyLevel: { type: 'string', required: true, description: '自主级别：0 | manual | 1 | 2 | off' },
            fpThreshold: { type: 'number', description: '灰度期误伤率上限（默认 0.02）' },
            staleHits: { type: 'number', description: '连续无命中老化阈值（默认 3）' },
            minGoodTotal: {
              type: 'number',
              description: '误伤判定所需最小正常样本数（默认 20）。回放样本不足此数时，误伤率再高也不会自动回退（防止单条噪声把仍在观察的规则判死）；样本少时可调低。',
            },
          },
          output: {
            schema: { type: 'json' },
            render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
          },
          async execute(args) {
            const candidate = requireCandidate(args.candidate)
            const level = requireLevel(args.autonomyLevel)
            const traffic = loadHistoricalTraffic(String(args.trafficFile))
            // 强制链：先评测，再确认，只有三关全过才允许自动转正。
            const evalResult: EvalResult = evaluate(candidate, traffic)
            const report = confirmCandidate(candidate, evalResult)

            // id 必须**稳定**（用候选 id，而不是每次随机生成）：否则每次工具调用都是
            // 一个全新的对象，命中/误伤计数永远从零开始，"连续 N 次无命中 → 老化"
            // 这类阈值判断永远触发不了——闭环的自动回退与老化等于不存在。
            const lc = new RuleLifecycle(
              {
                autonomyLevel: level,
                fpThreshold: Number(args.fpThreshold ?? 0.02),
                staleHits: Number(args.staleHits ?? 3),
                // 默认门槛 20 是防"单条噪声判死"的保守值；但本工具的样本来自回放文件，
                // 往往不足 20 条，若不暴露这个参数，自动回退会因样本不足而**永远不触发**。
                minGoodTotal: Number(args.minGoodTotal ?? 20),
              },
              candidate.id,
            )
            lc.init(report.pass)
            // 用**回放样本**推进闭环，两个观测值都由服务端算：
            //  · blocked   = wouldBlock（候选会不会拦下这条请求）
            //  · actualBad = 样本自带的 Oracle（检测器判为异常即"该拦"）
            //
            // 不接受模型传入这两个值：否则模型只要恒传 `actualBad=true`，
            // 误伤率就永远是 0、误伤计数恒为 0 → **自动回退永不触发**。
            // 这与"三关卡必须由服务端算"是同一个原则：让被约束方自己报告判定依据，
            // 那道闸门就成了装饰。
            for (const item of traffic) lc.observe(wouldBlock(candidate, item.req), item.isBad)

            // 交给后台任务推进。后台任务由上面的 `inject` 保证就绪——
            // 未就绪时本插件根本不会激活，所以这里不需要再判空。
            c.firewallLoopTask.setAutonomyLevel(level)
            c.firewallLoopTask.track(lc)
            return toJson({
              stage: lc.getStage(),
              autoConfirmAllowed: report.pass,
              tracked: true,
              report,
              eval: evalResult,
              note: report.pass
                ? '三关卡全过：允许按自主级别推进。'
                : `三关卡未全过（${[report.naming, report.intent, report.risk]
                    .filter((g) => !g.pass)
                    .map((g) => g.reason)
                    .join('；')}）：候选停在 ${lc.getStage()}，未进灰度。`,
            })
          },
        }),
      )
    },
  })
}

// dsh loader 通过 module.default ?? module 取插件：默认导出即插件对象（主条目无 inject 依赖）。
export default { name, apply }
