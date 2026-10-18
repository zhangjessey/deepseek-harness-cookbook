// src/firewall/ch20/session-observe.ts —— 证据以插件注入的 user/message 进入会话
//
// 第 20 讲的问题："异常怎样成为 Agent 可见、可追溯的证据？"
// 答案落在 dsh 的已知事件类型上——**插件注入的 `user/message`**，来源标成
// `plugin:firewall-observe`。它会被持久化、重启后可加载，也满足
// model-visible ← logged：进入模型上下文的内容必须能从会话日志重建。
//
// 这与第 19 讲账本用的是同一种载体、同一套读回校验（只采信本插件来源、
// 形状不合法就忽略），所以"证据"和"发布事实"能落在同一条日志里对账——
// 复盘时可以沿证据链往回追溯：某条候选是依据哪一批证据长出来的。
import { Context, Service } from '@deepseek-ai/cordis'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { renderEvidence, type SanitizedEvidence } from './observe'
import { ensureSessionInfra } from '../shared/fact-log'

export const EVIDENCE_SOURCE_PLUGIN = 'firewall-observe'
const EVIDENCE_MARKER = 'firewall-observe evidence'

declare module '@deepseek-ai/cordis' {
  interface Context {
    observeSession: ObserveSessionService
  }
}

export interface ObserveSessionConfig {
  sessionId: string
  /** 会话日志的持久化根目录（JSONL），默认 `.dsh-sessions`。 */
  root?: string
}

/**
 * 渲染后的证据形状（与 observe.ts 的 renderEvidence 严格对应）：
 * `异常证据[kind] method=… path=… status=… uaClass=… ipHash=… cookie=…`
 * 少任何一个字段都说明这条文本不完整（截断或被改过），不能被当作证据采信。
 */
const EVIDENCE_SHAPE =
  /^异常证据\[[^\]]+\] method=\S+ path=\S+ status=\d+ uaClass=\S+ ipHash=\S+ cookie=(?:true|false)$/

function isEvidenceShape(body: string): boolean {
  return EVIDENCE_SHAPE.test(body)
}

function textOf(content: unknown): string | null {
  if (!Array.isArray(content)) return null
  for (const block of content) {
    const b = block as { type?: string; text?: string }
    if (b?.type === 'text' && typeof b.text === 'string') return b.text
  }
  return null
}

export class ObserveSessionService extends Service {
  static inject = ['sessions'] as const

  private _session?: Session

  constructor(
    ctx: Context,
    private config: ObserveSessionConfig,
  ) {
    super(ctx, 'observeSession')
  }

  /** 会话按需创建（不在 constructor 里碰其他服务）。 */
  get session(): Session {
    this._session ??= this.ctx.sessions.create(this.config.sessionId as SessionId, {
      meta: { cwd: process.cwd() },
    })
    return this._session
  }

  /** 重启恢复时采用一个从磁盘读回的会话（见 mountObserveSession）。 */
  adopt(session: Session): void {
    this._session = session
  }

  /** 证据脱敏后进入会话——脱敏必须在进会话之前做完，因为它会永久留在日志里。 */
  injectEvidence(ev: SanitizedEvidence): void {
    this.session.append(
      'user/message',
      {
        id: `msg-${this.session.seq}` as MessageId,
        role: 'user',
        content: [{ type: 'text', text: `${EVIDENCE_MARKER}\n${renderEvidence(ev)}` }],
        source: { kind: 'plugin', plugin: EVIDENCE_SOURCE_PLUGIN },
      },
      { surfaceOp: 'append' },
    )
  }

  /**
   * 读回：只采信本插件来源、**且形状合法**的证据。
   *
   * 只查来源标记是不够的：日志里的文本可能被截断（写入中断）、被改过，或来自旧版本的
   * 不同格式。把这类文本也当证据，下游（按类别聚合、长候选）就会读到缺字段的假证据
   * ——这与 ch19 账本读回侧的严格校验是同一个道理，两处口径必须一致：
   * "证据"和"发布事实"落在同一条日志里对账，校验强度却不一样是说不过去的。
   */
  evidences(): string[] {
    const out: string[] = []
    for (const ev of this.session.events) {
      if (ev.type !== 'user/message') continue
      const msg = ev.data as { content?: unknown; source?: { kind?: string; plugin?: string } }
      if (msg.source?.kind !== 'plugin' || msg.source.plugin !== EVIDENCE_SOURCE_PLUGIN) continue
      const text = textOf(msg.content)
      if (!text) continue
      const at = text.indexOf(EVIDENCE_MARKER)
      if (at < 0) continue
      // 标记之后那一段就是渲染的正文（见 observe.ts 的 renderEvidence），必须是完整形状。
      const body = text.slice(at + EVIDENCE_MARKER.length).trim()
      if (!isEvidenceShape(body)) continue
      out.push(text)
    }
    return out
  }
}

/** 挂载：先挂 dsh 的会话基础设施（含 JSONL 持久化），再挂证据会话，最后做重启恢复。 */
export async function mountObserveSession(ctx: Context, config: ObserveSessionConfig): Promise<void> {
  await ensureSessionInfra(ctx, config.root, 'firewall-observe')
  await ctx.plugin(ObserveSessionService, config)
  // 重启恢复：磁盘上已有这个会话就恢复，读不到（首次运行）就保持新建的空会话。
  await ctx.inject(['sessionPersistence', 'sessions', 'observeSession'] as never, async (c) => {
    try {
      const prep = await c.sessionPersistence.prepare(config.sessionId as SessionId)
      c.observeSession.adopt(prep.session)
      c.sessions.enter(prep.session)
      c.sessions.announce(prep.session)
    } catch (err) {
      // 只有"这个会话还没有落盘记录"（首次运行）才适合静默沿用新建会话；其余失败
      // （格式不兼容 / JSONL 损坏 / 权限问题）要出声，而不是带着不完整的证据继续。
      const reason = err instanceof Error ? err.message : String(err)
      ctx.logger?.warn?.(`[firewall-observe] 会话日志恢复失败（若非首次运行，证据可能不完整）：${reason}。`)
    }
  })
}
