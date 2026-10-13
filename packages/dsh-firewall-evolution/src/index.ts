// packages/dsh-firewall-evolution/src/index.ts
//
// 本包是第20讲「规则进化」的可安装 dsh 组合包（bundle）。
// 引擎与机制实现复用 cookbook 的 src/firewall/ch20（构建时由 esbuild 内联进 lib/，发布产物自包含）。
//
// 安装：dsh plugin --profile <name> add ./packages/dsh-firewall-evolution
//
// 本讲落点（详见 ch20 正文）：数据来源是 nginx 访问日志（不是判定事件）；三个检测器识别
// 敏感路径探测 / SQL 注入 / 异常 UA；先脱敏（假名化、保留可聚合结构）再作为"证据"以 user/message
// 注入 Agent 会话（对应 dsh 的会话注入能力）；阈值达成后由受约束的提案工具长出候选规则。
import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Observer, ObserveSession } from '../../../src/firewall/ch20/observe'
import { proposeFromEvidence, validateStage1, validateStage2 } from '../../../src/firewall/ch20/propose'
import { toJson } from '../../../src/firewall/shared/json.ts'

export const name = 'dsh-firewall-evolution'
// 同 ch19：主条目不声明 tools 依赖，工具注册放进声明了 inject tools 的子插件，
// 宿主无 tools 时该子插件 pending（即跳过注册），主条目本身照常激活。

function warn(ctx: Context, msg: string): void {
  const logger = (ctx as unknown as { logger?: { warn?: (m: string) => void } }).logger
  logger?.warn?.(msg)
}

export function apply(ctx: Context): void {
  ctx.plugin({
    name: 'firewall-evolution-tools',
    inject: ['tools'] as const,
    apply(c: Context) {
      if (!c.tools) {
        warn(c, '[firewall-evolution] 未检测到 tools 服务，跳过进化工具注册')
        return
      }

      // 工具一：增量读 nginx 日志 → 三类异常检测 → 脱敏 → 证据注入会话。
      c.tools.register(
        defineTool({
          name: 'firewall_observe',
          description: '增量读 nginx 日志、检测三类异常、脱敏，并把证据注入会话。',
          parameters: {
            file: { type: 'string', required: true, description: 'nginx 访问日志路径' },
            threshold: { type: 'number', description: '触发进化所需异常数（演示默认 2）' },
            perHourCap: { type: 'number', description: '每小时采样上限' },
            maxShare: { type: 'number', description: '单类异常最大占比（抗挤占）' },
          },
          output: {
            schema: { type: 'json' },
            render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
          },
          async execute(args) {
            const session = new ObserveSession()
            const observer = new Observer(session, {
              threshold: Number(args.threshold ?? 2),
              perHourCap: Number(args.perHourCap ?? 100),
              maxShare: Number(args.maxShare ?? 0.9),
            })
            const evidences = observer.observeOnce(String(args.file))
            return toJson({
              count: evidences.length,
              evidences,
              sessionMessages: session.messages().length,
              thresholdReached: observer.thresholdReached(),
            })
          },
        }),
      )

      // 工具二：从已注入会话的异常证据中长出候选规则，并做两阶段校验（结构 + 语义，含盲区声明）。
      c.tools.register(
        defineTool({
          name: 'firewall_propose',
          description: '从异常证据中长出候选规则，并做两阶段校验。',
          parameters: {
            file: { type: 'string', required: true, description: 'nginx 访问日志路径（与 observe 同源）' },
          },
          output: {
            schema: { type: 'json' },
            render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
          },
          async execute(args) {
            const session = new ObserveSession()
            const observer = new Observer(session, {
              threshold: 2,
              perHourCap: 100,
              maxShare: 0.9,
            })
            const evidences = observer.observeOnce(String(args.file))
            // proposeFromEvidence 走真实模型，是异步的：漏掉 await 会让 candidates 变成
            // Promise，下面的 map 直接抛 TypeError。这类错只有类型检查能抓住，所以
            // packages/ 必须和 src/ 一样进 tsconfig（见根 tsconfig.packages.json）。
            const { candidates, ok, error } = await proposeFromEvidence(evidences)
            // 失败要出现在工具的返回里：静默返回空候选，调用它的 Agent 会以为
            // "模型看过了、没有可提的规则"，而实际是一次失败。
            if (!ok) {
              return toJson({ ok: false, error, candidates: [], note: '模型不可用或输出不是 JSON，本轮未产出候选' })
            }
            return toJson({
              candidates: candidates.map((c) => ({
                id: c.id,
                name: c.name,
                when: c.when,
                stage1: validateStage1(c),
                stage2: validateStage2(c),
              })),
            })
          },
        }),
      )
    },
  })
}

// dsh loader 通过 module.default ?? module 取插件：默认导出即插件对象（主条目无 inject 依赖）。
export default { name, apply }
