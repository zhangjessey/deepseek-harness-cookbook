// src/firewall/ch20/observe.ts —— observe：增量读 nginx 日志、检测、脱敏并注入会话
//
// 对应第20讲"数据来源与检测器 → 脱敏、进入会话"：
//  • 数据来源是 nginx 访问日志（不是判定事件），要状态码；cookie 只表示带 session cookie（可伪造）；
//    ip 来自 $remote_addr。
//  • 三个检测器：敏感路径探测 / SQL 注入参数 / 异常 UA。
//  • 抗挤占采样（单类异常占比上限）+ 每小时上限。
//  • 先脱敏：假名化（hash ip、归类 ua），不是匿名化——保留可聚合的结构。
//  • 证据以"插件注入 user/message"进入 dsh 会话日志（见 session-observe.ts），脱敏在前、入会话在后。
import { createHmac, randomBytes } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync, type Stats } from 'node:fs'

export type AnomalyKind = 'path-probe' | 'sqli' | 'bad-ua'

export interface NginxLine {
  ip: string
  method: string
  path: string
  status: number
  ua: string
  hasCookie: boolean
  /** $time_local / $time_iso8601 的解析结果；解析不出来时 undefined（见 parseNginxTime）。 */
  time?: Date
}

export interface RawEvidence {
  kind: AnomalyKind
  line: NginxLine
}

export interface SanitizedEvidence {
  kind: AnomalyKind
  ipHash: string
  method: string
  path: string
  status: number
  uaClass: string
  hasCookie: boolean
  hourBucket: string
}

export interface SessionMessage {
  role: 'user' | 'assistant'
  content: string
}

// 内存版会话（演示纯检测链路用）；真实落盘版在 session-observe.ts 里写进 dsh 会话日志。
export class ObserveSession {
  private entries: SessionMessage[] = []
  injectEvidence(ev: SanitizedEvidence): void {
    this.entries.push({ role: 'user', content: renderEvidence(ev) })
  }
  messages(): SessionMessage[] {
    return [...this.entries]
  }
}

export function renderEvidence(ev: SanitizedEvidence): string {
  return `异常证据[${ev.kind}] method=${ev.method} path=${ev.path} status=${ev.status} uaClass=${ev.uaClass} ipHash=${ev.ipHash} cookie=${ev.hasCookie}`
}

/**
 * 检测前先对路径做**百分号解码**。
 *
 * 不解码的话，`/%61dmin`、`/%2eenv` 这类编码过的探测在日志里完全看不出来——
 * 攻击者只要换个编码，就能让"进化"永远看不见这类攻击。注意引擎侧（ch18）会解码并
 * 拦下流量，所以这不影响当前防护；影响的是**进化覆盖面**：检测不到 → 不产生证据 →
 * 规则长不出来。畸形编码（如 `%zz`）解不出来就保持原样，交给下面的原始匹配兜底。
 */
function decodePath(path: string): string {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

/**
 * 敏感路径：按**路径段**匹配，而不是只锚在开头。
 *
 * 只认 `^/admin` 有两个方向的问题：
 *  · 漏检：`/cms/wp-admin`、`/api/.env` 这类子路径下的探测全部看不见；
 *  · 误报（若放宽成单纯 contains）：`/blog/administration` 会被当成探测。
 * 所以要求前后都是段边界（开头 / `/` / 结尾 / `?`）。
 */
const PROBE_SEGMENT = /(?:^|\/)(admin|wp-admin|phpmyadmin|etc\/passwd|\.env|wp-login)(?:\/|$|\?)/i

// 三个检测器（顺序即优先级）：敏感路径探测 / SQL 注入参数 / 异常 UA。都是已知特征的静态识别。
export function detect(line: NginxLine): AnomalyKind | null {
  const path = decodePath(line.path)
  if (PROBE_SEGMENT.test(path)) return 'path-probe'
  if (/(union\s+select|'\s*--|'\s*#|;\s*drop\s+table|\bor\b\s+['"]?\d+['"]?\s*=\s*['"]?\d+)/i.test(path)) return 'sqli'
  if (/python-requests|scrapy|zgrab|masscan|wget\/|curl\//i.test(line.ua)) return 'bad-ua'
  return null
}

function classifyUa(ua: string): string {
  if (/python-requests|scrapy|zgrab|masscan/i.test(ua)) return 'scanner'
  if (/curl\/|wget\//i.test(ua)) return 'script'
  if (!ua) return 'empty'
  return 'browser'
}

// ── 假名化：HMAC 加盐，而不是无盐哈希 ──
//
// 原来是 `sha256(ip)` 无盐。对 IPv4 来说这是**可反推**的：地址空间只有 2^32，
// 离线枚举一遍就能还原出全部来源 IP——拿到日志的人等于拿到真实 IP，"假名化"名不副实。
// 改用 HMAC + 密钥后，没有密钥就无法反推；同值仍得同结果，可聚合性不受影响。
const PROCESS_SECRET = randomBytes(32) // 进程内固定；跨进程关联需要显式配置

let warnedNoSecret = false
function pseudonymSecret(): Buffer {
  const fromEnv = process.env.FIREWALL_IP_HASH_SECRET
  if (fromEnv) return Buffer.from(fromEnv, 'utf8')
  if (!warnedNoSecret) {
    warnedNoSecret = true
    console.warn(
      '[firewall-observe] 未设置 FIREWALL_IP_HASH_SECRET：改用进程内随机密钥。' +
        '假名化仍不可反推，但跨进程无法关联同一 IP；需要长期聚合请显式配置该环境变量。',
    )
  }
  return PROCESS_SECRET
}

/** 假名化一个值：确定性（同值同结果，可聚合），且没有密钥就无法反推。 */
export function pseudonymize(value: string): string {
  return createHmac('sha256', pseudonymSecret()).update(value).digest('hex').slice(0, 12)
}

/**
 * 路径脱敏：保留路径主干与**参数名**（长规则要用的结构信号），参数值一律假名化。
 *
 * 为什么参数值必须脱敏：query 里常带着 token、邮箱、会话标识、重置密码链接
 * （`/reset?token=xxx`、`/search?q=someone@corp.com`）。原来 path 原样保留，
 * 这些真实数据会进模型提示词，并被**永久**写进 dsh 会话日志。
 *
 * 为什么不影响检测与规则生成：检测（detect）在脱敏**之前**就跑完了，用的是原始行，
 * sqli 特征照常识别；规则生成也不依赖"从日志里照抄 payload"——证据里有 kind（类别），
 * 提案的系统提示词给出了各类别该用的特征。
 */
export function sanitizePath(path: string): string {
  const q = path.indexOf('?')
  if (q < 0) return path // 无 query，没有可脱敏的取值
  const base = path.slice(0, q)
  const params = path
    .slice(q + 1)
    .split('&')
    .filter((kv) => kv.length > 0)
    .map((kv) => {
      const eq = kv.indexOf('=')
      if (eq < 0) return kv // 无值参数
      return `${kv.slice(0, eq)}=${pseudonymize(kv.slice(eq + 1))}`
    })
  return params.length > 0 ? `${base}?${params.join('&')}` : base
}

// 脱敏：假名化（ip 与参数值哈希、ua 归类），不是匿名化——保留可聚合的结构（method/path/status/uaClass）。
export function sanitize(raw: RawEvidence): SanitizedEvidence {
  return {
    kind: raw.kind,
    ipHash: pseudonymize(raw.line.ip),
    method: raw.line.method,
    path: sanitizePath(raw.line.path),
    status: raw.line.status,
    uaClass: classifyUa(raw.line.ua),
    hasCookie: raw.line.hasCookie,
    // 小时桶来自 parseLine 解析出的日志时间戳（见 hourBucketOf），不再写死成 'h'。
    // 原注释说"本演示样本无真实时间戳"是假的：access.sample.log 每行都带
    // [10/Oct/2026:12:00:00 +0000]，只是 parseLine 没解析它。解析不出来的行退化到
    // UNKNOWN_BUCKET：它们共用一个桶，于是 perHourCap 对它们**实际是总量上限**
    // （与修复前一致，但注释不再假装它是"每小时"）。
    hourBucket: hourBucketOf(raw.line.time),
  }
}

// 解析 nginx 日志行（自定义格式：IP - - [time] "METHOD path" status size "ua" "cookie"）
export function parseLine(text: string): NginxLine | null {
  const head = text.match(/^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+) [^"]*" (\d+)/)
  if (!head) return null
  const tail = text.match(/"([^"]*)" "([^"]*)"\s*$/)
  const ua = tail ? tail[1] : ''
  const cookie = tail ? tail[2] : ''
  // 分组序号：1=ip 2=time 3=method 4=path 5=status
  // ——把 [time] 从 `[^\]]+` 改成捕获组后，后续分组整体后移了一位。
  return {
    ip: head[1],
    method: head[3],
    path: head[4],
    status: Number(head[5]),
    ua,
    hasCookie: cookie !== '-' && cookie !== '',
    // 时间戳是"每小时上限"的依据（见 hourBucketOf）；解析不出来就是 undefined → 退化到 unknown 桶。
    time: parseNginxTime(head[2]!) ?? undefined,
  }
}

// ── 时间戳 → 小时桶 ──
//
// "每小时上限"要真按小时计数，前提是日志行带时间戳。样本与常见 nginx 配置都带
// （$time_local / $time_iso8601），所以这里把它解析出来，而不是像原来那样写死 'h'
// ——写死的后果：cap 一打满就**永远**不再采任何证据，而 thresholdReached 只看被采样数，
// 进化静默停摆。
const MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
}

/** "+0800" / "-0530" → 相对 UTC 的分钟数。 */
function offsetMinutes(sign: string, hh: string, mm: string): number {
  const total = Number(hh) * 60 + Number(mm)
  return sign === '-' ? -total : total
}

/** 解析 $time_local（10/Oct/2026:12:00:00 +0000）或 $time_iso8601（2026-10-10T12:00:00+08:00）。 */
export function parseNginxTime(text: string): Date | null {
  const s = text.trim()
  const local = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})(?:\s+([+-])(\d{2})(\d{2}))?$/.exec(s)
  if (local) {
    const mon = MONTHS[local[2]!.charAt(0).toUpperCase() + local[2]!.slice(1, 3).toLowerCase()]
    const day = Number(local[1]!)
    const [h, mi, sec] = [Number(local[4]!), Number(local[5]!), Number(local[6]!)]
    if (mon === undefined || day < 1 || day > 31 || h > 23 || mi > 59 || sec > 60) return null
    const utc = Date.UTC(Number(local[3]!), mon, day, h, mi, sec)
    const off = local[7] ? offsetMinutes(local[7]!, local[8]!, local[9]!) * 60_000 : 0
    return new Date(utc - off)
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):?(\d{2}))?$/.exec(s)
  if (iso) {
    const mon = Number(iso[2]!) - 1
    const day = Number(iso[3]!)
    const [h, mi, sec] = [Number(iso[4]!), Number(iso[5]!), Number(iso[6]!)]
    if (mon < 0 || mon > 11 || day < 1 || day > 31 || h > 23 || mi > 59 || sec > 60) return null
    const utc = Date.UTC(Number(iso[1]!), mon, day, h, mi, sec)
    const off = iso[7] ? offsetMinutes(iso[7]!, iso[8]!, iso[9]!) * 60_000 : 0
    return new Date(utc - off)
  }
  return null
}

/** 无时间戳的行共用的桶：perHourCap 对它们**实际是总量上限**（与修复前一致，但注释不再假装是每小时）。 */
export const UNKNOWN_BUCKET = 'unknown'

/** 只保留最近这么多**日历小时**的桶计数：更老的桶不可能再进数据，留着只会让计数无界增长。 */
const HOUR_BUCKET_HISTORY = 24

/**
 * 小时桶名 `YYYY-MM-DDTHH`。取 UTC：桶名不随读取进程所在时区变化，跨机器可复现、测试可断言
 * （真要按本地小时计费，把 getUTC* 换成 get* 即可，但那样桶会依赖进程 TZ）。
 */
export function hourBucketOf(time: Date | undefined): string {
  if (!time) return UNKNOWN_BUCKET
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(time.getUTCFullYear(), 4)}-${p(time.getUTCMonth() + 1)}-${p(time.getUTCDate())}T${p(time.getUTCHours())}`
}

function shiftHourBucket(bucket: string, hours: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(bucket)
  if (!m) return bucket
  const t = Date.UTC(Number(m[1]!), Number(m[2]!) - 1, Number(m[3]!), Number(m[4]!)) + hours * 3_600_000
  return hourBucketOf(new Date(t))
}

export interface ObserveConfig {
  threshold: number // 触发进化所需异常数（演示调低）
  perHourCap: number // 每小时上限
  maxShare: number // 单类异常最大占比（抗挤占）
}

/**
 * 采样遥测。
 *
 * 没有它，证据被丢弃是**完全静默**的：运维只看得到"进化一直没产出候选"，
 * 却看不出到底是日志里没有异常、还是异常全被采样丢掉了、又是丢在哪一层
 * （每小时上限 vs 抗挤占）。这三类原因的处置方式完全不同。
 */
export interface SampleStats {
  /** 检出的异常总数（采样之前）。 */
  seen: number
  /** 真正注入会话、成为证据的。 */
  injected: number
  /** 因"每小时上限"被丢弃的。 */
  droppedByHourCap: number
  /** 因"抗挤占"（单类占比超限）被丢弃的。 */
  droppedByShare: number
}

// ── 增量读进度：(inode, size, byteOffset)，不是"过滤后的行号" ──
//
// 为什么行号不行：行号是**相对当前文件内容**的位置，文件一变它就指向另一批内容。
//  • 轮转后行数变少 → 进度被改成新的小长度 → 下一轮把已读过的行重复注入（证据重复、阈值通胀）；
//  • 轮转后进度仍大于新文件行数 → 新写入的行整段被跳过（静默丢证据）。两者都不报错，最难查。
// 字节偏移是内容的真实位置；inode 用来识别"文件被换掉"（logrotate 的 rename+create 会换 inode）；
// size 变小说明被截断。只有三者同时对上，才算同一份日志的续读。
export interface FileCursor {
  ino: number
  size: number
  byteOffset: number
}

/**
 * 从 byteOffset 读到文件末尾，但**只返回以 \n 结尾的完整行**，并给出本轮可安全推进的字节数。
 *
 * 为什么不能像 split('\n') 那样把最后一块也算进去：最后一行经常只写了一半（nginx 正在写、
 * 还没 flush）。撕裂行要么解析失败、要么解析出残缺字段，而一旦进度推过它，这一行就
 * **永久丢失**——下一轮不会再读它。所以只推进到最后一个 \n 之后，撕裂行留到下一轮等它写完。
 */
function readCompleteLines(file: string, byteOffset: number, size: number): { lines: string[]; consumed: number } {
  const len = Math.max(0, size - byteOffset)
  if (len === 0) return { lines: [], consumed: 0 }
  const fd = openSync(file, 'r')
  let text = ''
  try {
    const buf = Buffer.allocUnsafe(len)
    let read = 0
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, byteOffset + read)
      if (n <= 0) break
      read += n
    }
    text = buf.subarray(0, read).toString('utf8')
  } finally {
    closeSync(fd)
  }
  const lastNl = text.lastIndexOf('\n')
  if (lastNl < 0) return { lines: [], consumed: 0 } // 一行都没写完整：本轮不读、不推进
  const complete = text.slice(0, lastNl + 1)
  // 推进点一定在某个 \n 之后（\n 是单字节 ASCII），所以不会把多字节字符切成两半。
  return { lines: complete.split('\n').filter(Boolean), consumed: Buffer.byteLength(complete, 'utf8') }
}

/** 上次的进度还适用吗？返回本轮该从第几个字节开始读。 */
function resumeByteOffset(cursor: FileCursor | undefined, st: Stats): number {
  if (!cursor) return 0 // 首次读这个文件：从头
  if (cursor.ino !== st.ino) return 0 // 文件被换掉：新 inode 里的字节都是新内容，从头读不会重复
  if (st.size < cursor.byteOffset) return 0 // 被截断：已读位置越过 EOF，只能从头
  return cursor.byteOffset // 同一份日志的续读
}

export interface ObserveOptions {
  /**
   * 把读进度写到 `${file}.offset`，进程重启后从记录位置续读。**默认 false。**
   *
   * 为什么默认不开：演示脚本读的是仓库内的样本文件，默认写伴随文件会把进度落进源码目录。
   * 真实部署（读 /var/log/nginx/access.log）应显式打开它。不开的后果是**进程重启会从头
   * 重读全量并重复注入证据**——这是已知取舍，不是"已支持续读"。
   */
  persistOffset?: boolean
}

function offsetFileOf(file: string): string {
  return `${file}.offset`
}

export class Observer {
  // 每个文件一份进度：原来全局只有一个 offset，换文件读会互相踩。
  private cursors: Map<string, FileCursor> = new Map()
  private perKindCount: Record<string, number> = {}
  private perHourCount: Map<string, number> = new Map()
  private stats: SampleStats = { seen: 0, injected: 0, droppedByHourCap: 0, droppedByShare: 0 }

  constructor(
    private session: ObserveSession,
    private config: ObserveConfig,
    private options: ObserveOptions = {},
  ) {}

  /**
   * 增量读：从上次的字节位置往后读**新增的完整行**，处理完推进进度。
   *
   * 落盘行为见 ObserveOptions.persistOffset：默认**不**落盘，所以进程重启会从头重读全量日志
   * 并重复注入证据——这是已知取舍，注释不假装"重启后从记录位置续读"。
   */
  observeOnce(file: string): SanitizedEvidence[] {
    if (!existsSync(file)) return []
    const st = statSync(file)
    const cursor = this.cursors.get(file) ?? this.loadCursor(file)
    const byteOffset = resumeByteOffset(cursor, st)
    const { lines, consumed } = readCompleteLines(file, byteOffset, st.size)
    const out: SanitizedEvidence[] = []
    for (const text of lines) {
      const line = parseLine(text)
      if (!line) continue
      const kind = detect(line)
      if (!kind) continue
      // 每小时上限：桶来自日志时间戳（不是恒定的 'h'），同小时的数据共用一个配额；
      this.stats.seen++ // 采样**之前**的计数：运维要能看出"日志里有异常、却一条都没进会话"
      // touchBucket 让旧桶过期，所以 cap 真的是"每小时"，而不是进程生命周期总量。
      const bucket = hourBucketOf(line.time)
      this.touchBucket(bucket)
      if ((this.perHourCount.get(bucket) ?? 0) >= this.config.perHourCap) {
        this.stats.droppedByHourCap++
        continue
      }
      // 抗挤占：判断"加入本样本后"该类占比是否超限（避免一类刷屏挤掉其他）。
      // 必须用 totalNow（不含本样本）判断：否则首条样本占比 100%，在 maxShare<1 时必被丢。
      const totalNow = Object.values(this.perKindCount).reduce((a, b) => a + b, 0)
      if (totalNow > 0 && (this.perKindCount[kind] ?? 0) + 1 > this.config.maxShare * (totalNow + 1)) {
        this.stats.droppedByShare++
        continue
      }
      this.perKindCount[kind] = (this.perKindCount[kind] ?? 0) + 1
      const sanitized = sanitize({ kind, line })
      this.stats.injected++
      this.perHourCount.set(bucket, (this.perHourCount.get(bucket) ?? 0) + 1)
      this.session.injectEvidence(sanitized) // 证据以 user/message 注入会话
      out.push(sanitized)
    }
    // 整轮处理完才推进进度：中途抛错时宁可下一轮重复读，也不静默丢行。
    const next: FileCursor = { ino: st.ino, size: st.size, byteOffset: byteOffset + consumed }
    this.cursors.set(file, next)
    this.saveCursor(file, next)
    return out
  }

  /** 登记小时桶，并让早于"当前桶 − 24 日历小时"的桶过期（防止计数无界增长）。 */
  private touchBucket(bucket: string): void {
    if (!this.perHourCount.has(bucket)) this.perHourCount.set(bucket, 0)
    if (bucket === UNKNOWN_BUCKET) return // 无时间戳的行共用一个桶，不参与按时间过期
    // 桶名 `YYYY-MM-DDTHH`（UTC、零填充）可直接按字典序比时间，所以"过期"就是删掉 < cutoff 的键。
    const cutoff = shiftHourBucket(bucket, -HOUR_BUCKET_HISTORY)
    for (const k of [...this.perHourCount.keys()]) {
      if (k !== UNKNOWN_BUCKET && k < cutoff) this.perHourCount.delete(k)
    }
  }

  /** 读进度文件；未开启落盘 / 文件不存在 / 内容损坏 → undefined（从头读）。 */
  private loadCursor(file: string): FileCursor | undefined {
    if (!this.options.persistOffset) return undefined
    const p = offsetFileOf(file)
    if (!existsSync(p)) return undefined
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<FileCursor>
      if (typeof raw.ino !== 'number' || typeof raw.size !== 'number' || typeof raw.byteOffset !== 'number')
        return undefined
      return { ino: raw.ino, size: raw.size, byteOffset: raw.byteOffset }
    } catch {
      return undefined // 进度文件损坏：退化为从头读——重复总好过丢行
    }
  }

  /** 写进度文件；写失败（只读目录/权限）只告警，不让整轮 observe 失败。 */
  private saveCursor(file: string, cursor: FileCursor): void {
    if (!this.options.persistOffset) return
    try {
      writeFileSync(offsetFileOf(file), `${JSON.stringify(cursor)}\n`)
    } catch (err) {
      console.warn(`[firewall-observe] 读进度写盘失败，重启后将重读全量：${String(err)}`)
    }
  }

  /**
   * 采样遥测快照（只读副本）。
   * `seen - injected` 就是被采样丢掉的数量，并可进一步拆到"每小时上限"与"抗挤占"两层。
   */
  sampleStats(): Readonly<SampleStats> {
    return { ...this.stats }
  }

  // 阈值是否达成（演示调低；真实部署阈值由评测门槛决定，见第21讲）。
  thresholdReached(): boolean {
    const total = Object.values(this.perKindCount).reduce((a, b) => a + b, 0)
    return total >= this.config.threshold
  }
}
