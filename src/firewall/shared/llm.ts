// src/firewall/shared/llm.ts —— 真实 DeepSeek 调用的封装。
//
// 通过 dsh 的真实 LLM 能力（dsh-llm 的 LlmRuntime + dsh-llm-deepseek 的 DeepSeekAdapter）
// 发起请求，走与产品一致的实现；API key 取自环境变量 DEEPSEEK_API_KEY。
// 这是 19/20/21 讲"模型起草 / 模型长出候选"的真实来源。
import { Context } from '@deepseek-ai/cordis'
import ConsoleExporter from '@deepseek-ai/cordis-plugin-logger-console'
import LlmRuntime, { assertUsableApiKey } from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'

// 可用环境变量覆盖：换模型/换端点不必改代码（默认仍与产品一致）。
const PROVIDER = process.env.FIREWALL_LLM_PROVIDER ?? 'deepseek-official'
const MODEL = process.env.FIREWALL_LLM_MODEL ?? 'deepseek-v4-flash'
/**
 * 调用超时。必须有上界：网络挂起或长时间排队时，`ask` 会一直挂着，
 * 整条进化链（以及跑它的 CI）跟着挂死，而且没有任何报错。
 */
const DEFAULT_TIMEOUT_MS = Number(process.env.FIREWALL_LLM_TIMEOUT_MS ?? 60_000)

/**
 * 失败的分类。**必须用错误码而不是消息字符串来传递**：
 * 消息是写给人看的，为了排障会列出多种可能原因（比如"空内容"那条消息里会提到
 * "连接中断或超时"），若上层靠关键字匹配消息来决定是否重试，就会把"鉴权失败"
 * 误判成"超时"而反复重试——一次快速失败被拖成几次慢失败。
 */
export type LlmErrorCode =
  | 'timeout' // 超时（可重试）
  | 'network' // 网络抖动 / 连接失败（可重试）
  | 'auth' // 鉴权失败：key 无效或额度耗尽（重试也不会变好）
  | 'empty' // 返回内容为空（成因不明，含鉴权失败；保守不重试）
  | 'malformed' // 输出不是 JSON 或未闭合（重试通常无济于事）
  | 'unavailable' // llm 服务不可用（要等宿主就绪，不是重试能解决的）
  | 'unknown'

export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'LlmError'
  }
}

/**
 * 只对**框架抛出的**错误做字符串推断——我们自己抛的都是带 code 的 `LlmError`。
 * 框架不给错误码，只能按消息归类；这是退而求其次，不是判定逻辑的主体。
 */
export function classifyLlmError(err: unknown): LlmErrorCode {
  const msg = err instanceof Error ? err.message : String(err)
  if (/timeout|ETIMEDOUT|超时/i.test(msg)) return 'timeout'
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed|socket hang up|network/i.test(msg)) return 'network'
  // 鉴权。第三条不可省：DeepSeek 侧的真实消息是 "Authentication Fails, Your api key:
  // **** is invalid, please check your api key."——"invalid" 出现在 key **之后**，
  // 只写 `invalid ... key` 这种顺序匹配不上，会漏成 `unknown`，让"按码说话"这条承诺
  // 在最常见的失败（key 无效 / 额度耗尽）上恰好失效。
  if (
    /401|403|unauthorized|forbidden|authentication fail|鉴权/i.test(msg) ||
    /\b(invalid|incorrect|expired)\s+(api\s+)?key\b/i.test(msg) ||
    /\bapi[_\s-]?key\b[^\n]*\b(invalid|incorrect|expired|无效)\b/i.test(msg)
  ) {
    return 'auth'
  }
  return 'unknown'
}

export interface AskOptions {
  system?: string
  maxTokens?: number
  temperature?: number
  /** 单次调用超时（毫秒），默认取 FIREWALL_LLM_TIMEOUT_MS 或 60s。 */
  timeoutMs?: number
}

export interface AskResult {
  text: string
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number }
}

// 缓存的是**启动中的 Promise**而不是结果：否则并发首次调用会各自跑一遍初始化，
// 建出两个 Context、两套匿名 id。
let starting: Promise<{ ctx: Context; llm: any }> | undefined

/** 启动（或复用）一个带 DeepSeek 适配器的真实 LLM 上下文。 */
async function runtime(): Promise<{ ctx: Context; llm: any }> {
  if (starting) return starting
  starting = (async () => {
    const ctx = new Context()
    ctx.plugin(ConsoleExporter)
    ctx.plugin(LlmRuntime)
    const options = () => resolveAdapterOptions({ thinking: 'disabled' }, undefined)
    const adapter = new DeepSeekAdapter({
      options,
      resolveApiKey: async () => assertUsableApiKey(process.env.DEEPSEEK_API_KEY!, 'llm-deepseek', 'DEEPSEEK_API_KEY'),
      resolveUserId: () => getOrCreateAnonymousUserId(),
    })
    await ctx.fiber.await()
    // dsh 的 Context.llm 类型只声明了 generate，运行时 LlmRuntime 实例另有 registerAdapter。
    const llm = ctx.get('llm', false) as any
    if (!llm) throw new LlmError('unavailable', 'llm 服务不可用（等宿主就绪，重试无益）')
    llm.registerAdapter([PROVIDER], adapter)
    return { ctx, llm }
  })().catch((err) => {
    // 初始化失败（key 缺失、llm 未就绪）后把缓存置回 undefined：允许下次调用重新初始化。
    // 否则一次失败会把 rejected 的 Promise 缓存到进程结束，运行期补上 key 也救不回来。
    starting = undefined
    throw err
  })
  return starting
}

/** 收流：只认 block-end 的文本块（流式增量不参与拼接），并累计使用量。 */
async function collect(prepared: any): Promise<AskResult> {
  const stream = prepared.stream(prepared.config)
  let text = ''
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
  for await (const chunk of stream) {
    if (chunk.type === 'block-end' && chunk.block?.type === 'text') text += chunk.block.text
    else if (chunk.type === 'usage' && chunk.usage) {
      usage.inputTokens += chunk.usage.inputTokens ?? 0
      usage.outputTokens += chunk.usage.outputTokens ?? 0
      usage.cacheReadTokens += chunk.usage.cacheReadTokens ?? 0
    }
    // adapter 层的错误以 finish chunk 终结（不会抛异常）；不接住它，真实失败会被
    // 伪装成"内容为空"，排障时彻底失去方向（in/out 均为 0 的假象就是这么来的）。
    else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
      const failure = chunk.reason.failure
      const msg = failure?.message ?? String(chunk.reason)
      throw new LlmError(classifyLlmError(msg), `adapter 失败（code=${failure?.code ?? '?'}）：${msg}`)
    }
  }
  return { text, usage }
}

/** 向真实 DeepSeek 模型发一次请求，返回拼接后的文本与 token 用量。 */
export async function ask(prompt: string, opts: AskOptions = {}): Promise<AskResult> {
  const { llm } = await runtime()
  const messages = [
    ...(opts.system ? [{ role: 'system' as const, content: [{ type: 'text' as const, text: opts.system }] }] : []),
    { role: 'user' as const, content: [{ type: 'text' as const, text: prompt }] },
  ]
  // maxTokens 不传时让框架注入模型默认值（dsh-llm 的 resolveCallFor 会填
  // defaultMaxTokens）。实测显式传小值会被服务端以"空 SSE 流"回应（HTTP 200
  // 但零数据事件），所以这里不做 `?? 1024` 之类的本地默认。
  const prepared = await llm.prepareCall(
    {
      provider: PROVIDER,
      model: MODEL,
      messages,
      ...(opts.maxTokens !== undefined && { maxTokens: opts.maxTokens }),
    },
    undefined,
  )

  // 超时兜底：网络挂起或长时间排队时，`ask` 会一直挂着，整条进化链（以及跑它的 CI）
  // 跟着挂死且毫无报错——所以必须有上界。
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  // 【已知限制】超时只是让 `Promise.race` 先 reject，collect 的底层异步迭代仍在后台继续
  // 直到它自己完成/失败（race 只忽略其结果，不取消底层请求）。单次影响小（短暂占用连接，
  // 不会产生 unhandledRejection），故不为此引入 abort 重构；若要彻底解决，需在超时后对
  // 流显式 `return`/abort。
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new LlmError('timeout', `模型调用超时（${timeoutMs}ms）：网络挂起或长时间排队`)),
      timeoutMs,
    )
  })
  try {
    const result = await Promise.race([collect(prepared), timeout])
    // 空文本通常意味着流被截断（触达 maxTokens 或连接中断）：尽早报错，
    // 别把空串当成"模型没产出候选"而静默继续。
    if (result.text.trim() === '') {
      // 这里拿不到 HTTP 状态码（框架把响应封装掉了），所以**不要把原因写死成某一个**：
      // 实测无效 key（401）也会表现为"空文本"，若只写"流被截断 / 触达 maxTokens"，
      // 排障就会一路查 maxTokens，而真正的原因是 key 没额度——方向完全错了。
      // 所以按可能性列出原因，并给出第一步该怎么验。
      // code 用 `empty`：成因不明（实测无效 key 就是返回空文本），保守不重试。
      // 注意消息里会提到"连接中断或超时"——那是给人排障用的**可能原因列表**，
      // 上层若拿消息关键字判断是否重试，就会把鉴权失败误判成超时。
      throw new LlmError(
        'empty',
        `模型返回内容为空（usage: in=${result.usage.inputTokens} out=${result.usage.outputTokens}）。` +
          '可能原因（按常见程度）：① API key 无效或额度耗尽；' +
          '② 流被截断（触达 maxTokens）；③ 连接中断或超时。' +
          '建议先用一次最小请求确认 key 可用，再排查 maxTokens。',
      )
    }
    return result
  } catch (err) {
    // 框架抛出的底层错误（网络抖动 / 鉴权失败）不带 code，这里统一归到带 code 的
    // LlmError：上层的 isRetryable 按**错误码**判定是否重试，而不是靠消息字符串猜。
    // 自己抛的 LlmError（timeout/empty/malformed/unavailable）原样穿透，不二次包装。
    // 没有这个 catch，collect() 抛的真实网络错误会以普通 Error 冒泡，
    // isRetryable 拿到 `unknown` → 不重试，于是"网络抖动再试一次"这条承诺形同虚设。
    if (err instanceof LlmError) throw err
    throw new LlmError(classifyLlmError(err), err instanceof Error ? err.message : String(err))
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 从模型文本里抽取 JSON（容忍模型附带解释性文字）。
 *
 * 扫描必须**字符串感知**：逐字符数括号而不管字符串的话，一旦 JSON 里某个字符串值含有
 * `}` / `]`（例如 sqli 候选的 value 是 `'}--`），就会误判"已闭合"、把一条本来合法的
 * 候选截断成非法 JSON 而解析失败——而且失败点离真正的原因很远，很难查。
 */
export function extractJson<T = unknown>(text: string): T {
  const start = text.search(/[[{]/)
  if (start < 0) throw new LlmError('malformed', '模型未返回 JSON：' + text.slice(0, 200))
  let depth = 0
  let end = -1
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      // 字符串里的括号不是结构，只有未转义的引号才结束它。
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      continue
    }
    if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  if (end < 0) throw new LlmError('malformed', '模型返回 JSON 未闭合：' + text.slice(0, 200))
  const slice = text.slice(start, end)
  try {
    return JSON.parse(slice) as T
  } catch {
    // 括号闭合但内容非法（尾逗号、裸 undefined、单引号键等）：JSON.parse 抛的是普通
    // SyntaxError。归到 malformed，别让上层 isRetryable 拿到 unknown 而误判"不重试"。
    throw new LlmError('malformed', '模型返回的 JSON 无法解析：' + slice.slice(0, 200))
  }
}
