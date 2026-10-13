// src/firewall/shared/fact-log.ts —— 把"某一类事实"落在 dsh 会话日志上的通用实现
//
// ch19 的规则事实与 ch21 的闭环事实都需要同一件事：写进 dsh 会话日志、重启后能读回、
// 读回时逐条校验。这些恰恰是"权威不丢"最脆弱的几处（载体选错 → 重启加载不了；
// 读回不校验 → 静默蒸发；恢复失败静默 → 以空权威启动并覆盖磁盘）。
// 两处各写一份的话，这几处迟早漂移——而漂移的后果是**数据丢失且没有报错**。
//
// 所以把通用部分提到这里：各自只声明**自己的事实类型**（标记 + 来源 + 校验器）。
//
// 为什么用"插件注入的 user/message"这个已知载体，而不是自定义事件类型：
// dsh 推荐用声明合并扩展 SessionEventMap，但仓库外插件写入的自定义事件会让重启后的会话
// 无法加载（SessionFormatUnsupportedError）。所以按 dsh 的做法选已知载体之一：
//   · 工具结果的 meta（output.presentationMeta）——Agent 调用工具时产生
//   · 命令记录 command/run 与 command/done
//   · 插件注入的 user/message（来源 plugin:<插件名>）  ← 本文件用这个
// 它会被持久化、重启后可加载，也满足 model-visible ← logged（模型看到的都在日志里）。
import { Context, Service } from '@deepseek-ai/cordis'
import { SessionStore, type Session, type SessionId } from '@deepseek-ai/dsh-session'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { join } from 'node:path'
import type { MessageId } from '@deepseek-ai/dsh-llm'

/** 一类事实怎么落地、怎么认回来。 */
export interface FactSpec<T> {
  /** 写在消息正文里的事实标记（区分不同种类的事实流）。 */
  marker: string
  /** 来源插件标记（读回时据此过滤：只采信自己写的）。 */
  sourcePlugin: string
  /**
   * 校验（**type guard**）：形状不合法的事实一律不采信。
   * 写成 type guard 而不是返回 boolean，读回侧才能直接用类型收窄的结果。
   */
  validate: (value: unknown) => value is T
  /** 校验失败时给出可行动的报错（写侧用）。 */
  assert: (value: unknown, where: string) => T
}

export interface FactLogConfig {
  sessionId: string
  /**
   * 会话日志的持久化根目录（JSONL）。
   * 不挂持久化，权威就只活在内存里——进程一退，"会话日志是权威"这句话就不成立了。
   */
  root?: string
}

function defaultRoot(): string {
  return join(process.cwd(), '.dsh-sessions')
}

/** 把一条事实渲染成会话里的用户消息：说明文字 + JSON 代码块。 */
function renderFact<T>(spec: FactSpec<T>, fact: T): string {
  return `${spec.marker}\n\`\`\`json\n${JSON.stringify(fact)}\n\`\`\``
}

function textOf(content: unknown): string | null {
  if (!Array.isArray(content)) return null
  for (const block of content) {
    const b = block as { type?: string; text?: string }
    if (b?.type === 'text' && typeof b.text === 'string') return b.text
  }
  return null
}

/** 一条会话事件的最小形状：不强依赖 SessionEvent 的具体类型。 */
export interface SessionEventLike {
  type: string
  data: unknown
}

/**
 * 从一条会话事件里取出某类事实；不是这类事实、或形状不合法就返回 null。
 *
 * 提供模块级版本是因为：有些调用方（如 ch19 的投影、prompt 片段）手上只有事件、
 * 没有服务实例，但它们也必须走**同一个**校验入口——各读各的就会出现
 * "工具看到的"与"投影用到的"不是同一份事实。
 */
export function factFromEvent<T>(spec: FactSpec<T>, ev: SessionEventLike): T | null {
  if (ev.type !== 'user/message') return null
  const msg = ev.data as { content?: unknown; source?: { kind?: string; plugin?: string } }
  if (msg.source?.kind !== 'plugin' || msg.source.plugin !== spec.sourcePlugin) return null
  const text = textOf(msg.content)
  if (!text) return null
  const markerAt = text.indexOf(spec.marker)
  if (markerAt < 0) return null
  const start = text.indexOf('```json', markerAt)
  if (start < 0) return null
  const from = text.indexOf('\n', start)
  const end = text.indexOf('```', from)
  if (from < 0 || end < 0) return null
  try {
    const parsed: unknown = JSON.parse(text.slice(from + 1, end).trim())
    // 不合法就忽略：日志里可能有别的东西，也可能被改过。
    return spec.validate(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 通用的"事实日志"服务。
 *
 * 注意它是**泛型的、但一个服务名只对应一类事实**：ch19 用 `ledgerLog`（规则事实），
 * ch21 用 `loopLog`（闭环事实）。两类事实不混在同一条会话里，读回时按各自的
 * `sourcePlugin` 过滤，互不影响——也就不会出现"闭环事件被当成规则事实折叠"这类串味。
 */
export class FactLogService<T> extends Service {
  static inject = ['sessions'] as const

  private _session?: Session

  constructor(
    ctx: Context,
    /** 服务名（也是 ctx 上的注入键）。 */
    serviceName: string,
    private spec: FactSpec<T>,
    private config: FactLogConfig,
  ) {
    super(ctx, serviceName)
  }

  /** 本事实流对应的会话 id（用于对账时确认没串会话）。 */
  get sessionId(): string {
    return this.config.sessionId
  }

  /**
   * 会话按需取得（不在 constructor 里碰其他服务）。
   *
   * 重启恢复不在这里做——由 `mountFactLog` 在挂载时 adopt 一个从磁盘读回的会话。
   */
  get session(): Session {
    // SessionId 是带品牌的类型，调用方给的是普通字符串，这里做一次显式转换。
    this._session ??= this.ctx.sessions.create(this.config.sessionId as SessionId, {
      meta: { cwd: process.cwd() },
    })
    return this._session
  }

  /** 直接采用一个已恢复出来的会话（重启时用），接着磁盘上的权威继续写。 */
  adopt(session: Session): void {
    this._session = session
  }

  /**
   * 追加一条事实。这是**唯一的写入口**，所以校验放在这里。
   *
   * 用的是与读回侧**同一份**校验器：两侧各用一套的话，一旦漂移就会出现"写进去、读不回来"
   * 的静默蒸发——日志里有这条事实、读回时却当没看见，状态永久不一致且查不出原因。
   * 非法事实一律**拒绝写入并明确报错**，而不是留一条读不回来的事实在日志里。
   */
  appendFact(fact: T): void {
    this.spec.assert(fact, `${this.spec.sourcePlugin} 的 appendFact`)
    this.session.append(
      'user/message',
      {
        id: `msg-${this.session.seq}` as MessageId,
        role: 'user',
        content: [{ type: 'text', text: renderFact(this.spec, fact) }],
        source: { kind: 'plugin', plugin: this.spec.sourcePlugin },
      },
      { surfaceOp: 'append' },
    )
  }

  /** 读回：只采信本类事实来源、且形状合法的事实。 */
  facts(): T[] {
    const out: T[] = []
    for (const ev of this.session.events) {
      const fact = this.factFromEvent(ev as unknown as SessionEventLike)
      if (fact !== null) out.push(fact)
    }
    return out
  }

  /**
   * 从一条会话事件里取出本类事实；不是本类的、或形状不合法就返回 null。
   * 这是"读回校验"的唯一入口——所有调用方都走它，看到的永远是同一份经过校验的事实。
   */
  factFromEvent(ev: SessionEventLike): T | null {
    return factFromEvent(this.spec, ev)
  }
}

/** cordis 插件构造函数的最小形状（用于 mountFactLog 的装配）。 */
export type FactLogCtor<T> = new (ctx: Context, config: FactLogConfig) => FactLogService<T>

/**
 * 已挂过会话基础设施的 ctx → 当时用的根目录（见 mountFactLog 里的去重说明）。
 * 记的是 root 而不是"挂过没有"：只记布尔的话，第二次传入的不同 root 会被静默忽略。
 */
const bootstrapped = new WeakMap<Context, string>()

/**
 * 供 bundle / demo 挂载：先挂 dsh 的会话服务，再挂事实日志，最后做重启恢复。
 *
 * @param serviceName 服务名（与 Service 子类里传给 super 的名字一致），用于取出实例做 adopt
 * @param logTag 告警前缀（便于一眼看出是哪一类事实流恢复失败）
 */
export async function mountFactLog<T>(
  ctx: Context,
  Service: FactLogCtor<T>,
  config: FactLogConfig,
  opts: { serviceName: string; logTag: string },
): Promise<void> {
  // 会话服务与 JSONL 持久化**只挂一次**（按 ctx 实例去重）：同一个 ctx 里可能挂多类事实
  // （ch19 的规则事实 + ch21 的闭环事实）。重复挂载会让后挂的覆盖先挂的 sessions 服务，
  // 于是先挂的那类事实之后会写进另一个（空的）会话里去——表现为"写进去了、重启后没了"。
  // 注意不能用 ctx.inject 来探测服务是否已存在：它缺服务时会 pending，而不是返回 false。
  const root = config.root ?? defaultRoot()
  const prevRoot = bootstrapped.get(ctx)
  if (prevRoot === undefined) {
    await ctx.plugin(SessionStore)
    // 让权威落盘：挂上之后，写路径的监听器会把每个已提交事件追加进 JSONL。
    // 没有这一层，会话日志只在内存里，进程退出即消失——重启恢复也就无从谈起。
    await ctx.plugin(JsonlSessionPersistence, { root })
    bootstrapped.set(ctx, root)
  } else if (prevRoot !== root) {
    // 基础设施只有一份，所以本次指定的 root **不会生效**。这必须出声：
    // 静默取首次值会表现为"明明配了 A，实际却写在 B"，排障时无从下手。
    ctx.logger?.warn?.(
      `[${opts.logTag}] 本 ctx 已挂过会话持久化（根目录 ${prevRoot}），本次指定的 ${root} 不会生效。` +
        `若两类事实要用不同目录，请把它们挂在不同的子 ctx 上。`,
    )
  }
  await ctx.plugin(Service, config)

  // 进程重启：磁盘上已有这个会话就恢复，读不到（首次运行）就保持新建的空会话。
  // 用 ctx.inject 而不是在 Service 里访问——这样没有挂持久化的装配也不会因为缺服务而挂起。
  // 用 `inject` 取出服务，而不是直接取属性：本函数常被**别人的子插件 apply**调用，
  // 那时直接访问 `ctx.<service>` 会被 cordis 拒绝
  // （`cannot get property "..." without inject`），于是 adopt 静默失败——
  // 表现为"会话没从磁盘恢复，而且没有任何报错"。
  // 依赖里显式带上 `sessions`：回调体要调 `c.sessions.enter/announce`。虽然 SessionStore
  // 挂在同一个 ctx 上时 `Reflect.has` 会放行访问，但"不声明就用"依赖的是 cordis 的
  // 实现细节，哪天行为变了这里就静默接不上（正是本函数注释里反复警告的那种"挂上了
  // 但没接上"）。声明出来，依赖关系才算自洽。
  await ctx.inject(['sessionPersistence', 'sessions', opts.serviceName] as never, async (c) => {
    try {
      const prep = await c.sessionPersistence.prepare(config.sessionId as SessionId)
      const log = (c as unknown as Record<string, FactLogService<T> | undefined>)[opts.serviceName]
      if (!log) throw new Error(`事实日志服务未就绪：${opts.serviceName}`)
      log.adopt(prep.session)
      c.sessions.enter(prep.session)
      c.sessions.announce(prep.session)
    } catch (err) {
      // 只有"这个会话还没有落盘记录"（首次运行）才适合静默沿用新建会话。其余失败
      // （格式不兼容 / JSONL 损坏 / 权限问题）一律要出声：静默会让进程以**空权威**启动，
      // 随后把空状态投影覆盖到磁盘上——已发布的内容就此永久丢失，且没有任何报错。
      const reason = err instanceof Error ? err.message : String(err)
      ctx.logger?.warn?.(`[${opts.logTag}] 会话日志恢复失败（若非首次运行，权威可能不完整）：${reason}。`)
    }
  })
}
