// src/firewall/ch20/observe.test.ts —— 检测 / 脱敏 / 解析 / 采样的单元测试
//
// 覆盖"从访问日志发现异常 → 脱敏成证据"这条链路的每个纯函数，
// 以及 Observer 的增量读、每小时上限、抗挤占采样、阈值达成。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  detect,
  hourBucketOf,
  ObserveSession,
  Observer,
  parseLine,
  sanitize,
  UNKNOWN_BUCKET,
  type NginxLine,
} from './observe'

const line: NginxLine = {
  ip: '1.2.3.4',
  method: 'GET',
  path: '/admin',
  status: 403,
  ua: 'python-requests/2.31',
  hasCookie: true,
}

// 时间戳可指定：小时桶的测试要造出**不同小时**的样本。
const nginxAt = (time: string, path: string, ua = 'Mozilla/5.0'): string =>
  `1.2.3.4 - - [${time}] "GET ${path} HTTP/1.1" 403 1024 "-" "${ua}" "-"`

const nginx = (path: string, ua = 'Mozilla/5.0'): string => nginxAt('10/Oct/2026:12:00:00 +0000', path, ua)

/** 建一个含若干日志行的临时目录，返回目录路径（access.log 在目录内）。 */
function tmpDir(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'obs-'))
  writeFileSync(join(dir, 'access.log'), lines.join('\n') + '\n')
  return dir
}

test('detect：敏感路径探测（含大小写不敏感）', () => {
  assert.equal(detect({ ...line, path: '/admin' }), 'path-probe')
  assert.equal(detect({ ...line, path: '/wp-admin/x' }), 'path-probe')
  assert.equal(detect({ ...line, path: '/.env' }), 'path-probe')
  assert.equal(detect({ ...line, path: '/etc/passwd' }), 'path-probe')
  assert.equal(detect({ ...line, path: '/ADMIN' }), 'path-probe')
})

test('detect：SQL 注入参数', () => {
  assert.equal(detect({ ...line, path: '/x?id=1 union select 1' }), 'sqli')
  assert.equal(detect({ ...line, path: "/x?id=1'--" }), 'sqli')
  assert.equal(detect({ ...line, path: '/x?id=1; drop table users' }), 'sqli')
})

test('detect：异常 UA', () => {
  assert.equal(detect({ ...line, path: '/ok', ua: 'python-requests/2.31' }), 'bad-ua')
  assert.equal(detect({ ...line, path: '/ok', ua: 'curl/7.68.0' }), 'bad-ua')
  assert.equal(detect({ ...line, path: '/ok', ua: 'zgrab/0.2' }), 'bad-ua')
})

test('detect：正常请求返回 null', () => {
  assert.equal(detect({ ...line, path: '/ok', ua: 'Mozilla/5.0' }), null)
})

test('sanitize：ip 哈希（原始 ip 不进证据）、ua 归类，保留可聚合结构', () => {
  const s = sanitize({ kind: 'path-probe', line })
  assert.equal(s.ipHash.length, 12)
  assert.ok(!s.ipHash.includes('1.2.3.4'), '原始 ip 不进证据')
  assert.equal(s.uaClass, 'scanner')
  assert.equal(s.kind, 'path-probe')
  assert.equal(s.path, '/admin')
  assert.equal(s.method, 'GET')
  assert.equal(s.status, 403)
})

test('sanitize：假名化确定性（同 ip 同哈希，可聚合）', () => {
  assert.equal(
    sanitize({ kind: 'path-probe', line }).ipHash,
    sanitize({ kind: 'sqli', line }).ipHash,
    '同 ip 哈希一致，保证跨证据可聚合',
  )
})

test('sanitize：query 参数值被假名化，路径主干与参数名保留', () => {
  // query 里常带 token / 邮箱 / 会话标识 / 重置链接。原来 path 原样保留，这些真实数据
  // 会进模型提示词，并被**永久**写进 dsh 会话日志。现在只保留长规则要用的结构信号。
  const s = sanitize({
    kind: 'path-probe',
    line: { ...line, path: '/reset?token=SUPERSECRET&user=bob@example.com' },
  })
  assert.ok(!s.path.includes('SUPERSECRET'), 'token 不能进证据')
  assert.ok(!s.path.includes('bob@example.com'), '邮箱不能进证据')
  assert.ok(s.path.startsWith('/reset?'), '路径主干保留（攻击面信号）')
  assert.ok(s.path.includes('token=') && s.path.includes('user='), '参数名保留（结构信号）')
})

test('sanitize：参数值假名化是确定性的（同值同结果，仍可聚合）', () => {
  const a = sanitize({ kind: 'sqli', line: { ...line, path: "/search?q=1'--" } }).path
  const b = sanitize({ kind: 'sqli', line: { ...line, path: "/search?q=1'--" } }).path
  const c = sanitize({ kind: 'sqli', line: { ...line, path: "/search?q=2'--" } }).path
  assert.equal(a, b, '同一取值必须得同一假名，否则无法聚合')
  assert.notEqual(a, c, '不同取值应得不同假名')
})

test('sanitize：ipHash 依赖密钥——换密钥后同一 ip 得不同假名', () => {
  // 无盐 sha256 对 IPv4 是可反推的：地址空间只有 2^32，离线枚举即可还原真实 IP。
  // 加盐后没有密钥就无法反推——这条断言确保它真的依赖密钥，而不是退化成无盐哈希。
  const prev = process.env.FIREWALL_IP_HASH_SECRET
  try {
    process.env.FIREWALL_IP_HASH_SECRET = 'secret-a'
    const a = sanitize({ kind: 'path-probe', line }).ipHash
    process.env.FIREWALL_IP_HASH_SECRET = 'secret-b'
    const b = sanitize({ kind: 'path-probe', line }).ipHash
    assert.notEqual(a, b, '换密钥必须得到不同假名（否则等于没加盐）')
    // 同一密钥下仍要确定性
    process.env.FIREWALL_IP_HASH_SECRET = 'secret-a'
    assert.equal(sanitize({ kind: 'path-probe', line }).ipHash, a, '同密钥下确定性，可聚合')
  } finally {
    if (prev === undefined) delete process.env.FIREWALL_IP_HASH_SECRET
    else process.env.FIREWALL_IP_HASH_SECRET = prev
  }
})

test('sanitize：ua 归类 scanner / script / browser', () => {
  assert.equal(sanitize({ kind: 'bad-ua', line: { ...line, ua: 'python-requests' } }).uaClass, 'scanner')
  assert.equal(sanitize({ kind: 'bad-ua', line: { ...line, ua: 'curl/7' } }).uaClass, 'script')
  assert.equal(sanitize({ kind: 'bad-ua', line: { ...line, ua: 'Mozilla/5.0' } }).uaClass, 'browser')
})

test('parseLine：解析 nginx 行', () => {
  const p = parseLine(nginx('/admin'))
  assert.equal(p?.ip, '1.2.3.4')
  assert.equal(p?.method, 'GET')
  assert.equal(p?.path, '/admin')
  assert.equal(p?.status, 403)
  assert.equal(p?.ua, 'Mozilla/5.0')
})

test('parseLine：格式不符返回 null', () => {
  assert.equal(parseLine('not a nginx line'), null)
})

test('Observer 增量读：推进 offset，第二次读不重复', () => {
  const dir = tmpDir([nginx('/admin')])
  const obs = new Observer(new ObserveSession(), { threshold: 2, perHourCap: 100, maxShare: 1 })
  assert.equal(obs.observeOnce(join(dir, 'access.log')).length, 1)
  assert.equal(obs.observeOnce(join(dir, 'access.log')).length, 0, 'offset 已推进，不重复读')
  rmSync(dir, { recursive: true, force: true })
})

test('Observer perHourCap：每小时上限，超出丢弃', () => {
  const dir = tmpDir([nginx('/admin'), nginx('/wp-admin'), nginx('/.env')])
  const obs = new Observer(new ObserveSession(), { threshold: 3, perHourCap: 2, maxShare: 1 })
  assert.equal(obs.observeOnce(join(dir, 'access.log')).length, 2, 'cap=2 只采 2 条')
  rmSync(dir, { recursive: true, force: true })
})

test('Observer maxShare：首样本不丢，同类占比超限才挤占', () => {
  // 顺序：path-probe / path-probe / sqli；maxShare=0.5
  // 首条 path-probe 通过；sqli 通过（1/2 不超）；第二条 path-probe（2/3≈0.67）超限被挤占
  const dir = tmpDir([nginx('/admin'), nginx('/wp-admin'), nginx("/search?q=1'--")])
  const obs = new Observer(new ObserveSession(), { threshold: 3, perHourCap: 100, maxShare: 0.5 })
  const kinds = obs
    .observeOnce(join(dir, 'access.log'))
    .map((e) => e.kind)
    .sort()
  assert.deepEqual(kinds, ['path-probe', 'sqli'])
  rmSync(dir, { recursive: true, force: true })
})

test('Observer thresholdReached：异常数达阈值', () => {
  const dir = tmpDir([nginx('/admin'), nginx('/wp-admin')])
  const obs = new Observer(new ObserveSession(), { threshold: 2, perHourCap: 100, maxShare: 1 })
  obs.observeOnce(join(dir, 'access.log'))
  assert.equal(obs.thresholdReached(), true)
  rmSync(dir, { recursive: true, force: true })
})

test('parseLine：解析出 $time_local 时间戳（每小时上限的依据）', () => {
  // 旧的 parseLine 把 [time] 整段丢掉，于是小时桶只能写死。样本每行都带时间戳，必须解析出来。
  const p = parseLine(nginx('/admin'))
  assert.deepEqual(p?.time, new Date(Date.UTC(2026, 9, 10, 12, 0, 0)))
  assert.equal(hourBucketOf(p?.time), '2026-10-10T12')
  // 带时区偏移也要算对：13:00 +0800 的 UTC 小时桶是 05
  assert.equal(hourBucketOf(parseLine(nginxAt('10/Oct/2026:13:00:00 +0800', '/admin'))?.time), '2026-10-10T05')
})

test('parseLine：时间戳缺失或格式不对 → 退化到 unknown 桶（如实说明，不再恒为 h）', () => {
  const bad = parseLine('1.2.3.4 - - [???] "GET /admin HTTP/1.1" 403 1 "-" "curl/8" "-"')
  assert.equal(bad?.time, undefined, '解析不出来就是没有时间戳')
  assert.equal(hourBucketOf(bad?.time), UNKNOWN_BUCKET, '无时间戳的行共用一个桶')
})

test('sanitize：hourBucket 是日志时间戳的小时桶，不再恒为 h', () => {
  const a = sanitize({ kind: 'path-probe', line: { ...line, time: new Date(Date.UTC(2026, 9, 10, 12, 0, 0)) } })
  const b = sanitize({ kind: 'path-probe', line: { ...line, time: new Date(Date.UTC(2026, 9, 10, 13, 0, 0)) } })
  assert.equal(a.hourBucket, '2026-10-10T12')
  assert.equal(b.hourBucket, '2026-10-10T13')
  assert.equal(sanitize({ kind: 'path-probe', line }).hourBucket, UNKNOWN_BUCKET, '无时间戳 → unknown 桶')
})

test('Observer 日志轮转（换成新文件，文件变小）：新行要读到，旧内容不重复注入', () => {
  const dir = tmpDir([nginx('/admin'), nginx('/wp-admin')])
  const file = join(dir, 'access.log')
  const session = new ObserveSession()
  const obs = new Observer(session, { threshold: 9, perHourCap: 100, maxShare: 1 })
  assert.equal(obs.observeOnce(file).length, 2)
  // 模拟 logrotate 的 rename + create：旧文件改名，新文件是**新 inode** 且内容更少。
  // 旧实现的进度是过滤后行号（此时 =2），新文件只有 1 行 → slice(2) 为空 → 这条新证据被静默丢掉。
  renameSync(file, join(dir, 'access.log.1'))
  // 新行必须本身是可检出的异常（/wp-login 命中 path-probe 检测器），否则测的就不是"有没有读到"
  writeFileSync(file, nginx('/wp-login') + '\n')
  const got = obs.observeOnce(file)
  assert.equal(got.length, 1, '轮转后新写入的行必须被读到（旧实现返回 0，静默丢证据）')
  assert.equal(got[0]?.path, '/wp-login', '读到的是新文件里的行')
  assert.equal(session.messages().length, 3, '旧文件的 2 条不重复注入：2 + 1 = 3')
  rmSync(dir, { recursive: true, force: true })
})

test('Observer 文件被截断变小：新写入的行不被整段跳过（不静默丢证据）', () => {
  const dir = tmpDir([nginx('/admin'), nginx('/wp-admin'), nginx('/.env')])
  const file = join(dir, 'access.log')
  const obs = new Observer(new ObserveSession(), { threshold: 9, perHourCap: 100, maxShare: 1 })
  assert.equal(obs.observeOnce(file).length, 3)
  // 同一个 inode 上被截断重写成更短（size < byteOffset：已读位置越过了 EOF）。
  // 旧实现：进度是行号 3 > 新文件行数 1 → 整段跳过 → 这条新证据静默丢失。
  writeFileSync(file, nginx('/phpmyadmin') + '\n')
  assert.deepEqual(
    obs.observeOnce(file).map((e) => e.path),
    ['/phpmyadmin'],
    '变小后新写入的行必须被读到（旧实现返回 []，静默丢证据）',
  )
  rmSync(dir, { recursive: true, force: true })
})

test('Observer 撕裂行：最后一行没写完时进度不推进，下一轮能读到', () => {
  const dir = mkdtempSync(join(tmpdir(), 'obs-'))
  const file = join(dir, 'access.log')
  const lineA = nginx('/admin')
  const lineB = nginxAt('10/Oct/2026:13:00:00 +0000', '/.env')
  // 第一行完整，第二行只写了一半（连请求行都没闭合，没有结尾的 \n）——nginx 正在写时的常见形态。
  writeFileSync(file, `${lineA}\n${lineB.slice(0, 55)}`)
  const obs = new Observer(new ObserveSession(), { threshold: 9, perHourCap: 100, maxShare: 1 })
  assert.deepEqual(
    obs.observeOnce(file).map((e) => e.path),
    ['/admin'],
    '撕裂行本轮不产出，也不能推进进度',
  )
  // 补齐这一行。旧实现上一轮已把进度推过它（行号 2），这一行**永久丢失**。
  writeFileSync(file, `${lineA}\n${lineB}\n`)
  assert.deepEqual(
    obs.observeOnce(file).map((e) => e.path),
    ['/.env'],
    '补齐后下一轮能读到（旧实现返回 []，该行永久丢失）',
  )
  rmSync(dir, { recursive: true, force: true })
})

test('Observer perHourCap 按小时桶各自计数（不是进程生命周期总量上限）', () => {
  const dir = tmpDir([
    nginxAt('10/Oct/2026:12:00:00 +0000', '/admin'),
    nginxAt('10/Oct/2026:12:10:00 +0000', '/wp-admin'),
    nginxAt('10/Oct/2026:12:20:00 +0000', '/.env'),
    nginxAt('10/Oct/2026:13:00:00 +0000', '/admin'),
    nginxAt('10/Oct/2026:13:10:00 +0000', '/wp-admin'),
    nginxAt('10/Oct/2026:13:20:00 +0000', '/.env'),
  ])
  const obs = new Observer(new ObserveSession(), { threshold: 9, perHourCap: 2, maxShare: 1 })
  const buckets = obs.observeOnce(join(dir, 'access.log')).map((e) => e.hourBucket)
  // 旧实现所有行共用恒为 'h' 的桶：cap=2 打满后**永远**不再采任何证据，
  // 而 thresholdReached 只看被采样数 → 进化静默停摆。修复后每个小时各 2 条。
  assert.deepEqual(buckets, ['2026-10-10T12', '2026-10-10T12', '2026-10-10T13', '2026-10-10T13'])
  rmSync(dir, { recursive: true, force: true })
})

test('Observer persistOffset：开启后新建实例从记录位置续读；默认不落盘（如实写明）', () => {
  const dir = tmpDir([nginx('/admin')])
  const file = join(dir, 'access.log')
  const cfg = { threshold: 9, perHourCap: 100, maxShare: 1 }
  const a = new Observer(new ObserveSession(), cfg, { persistOffset: true })
  assert.equal(a.observeOnce(file).length, 1)
  assert.ok(existsSync(`${file}.offset`), '开启后写伴随进度文件')
  // 新实例 ≈ 进程重启：从落盘位置续读，不重复注入。
  const b = new Observer(new ObserveSession(), cfg, { persistOffset: true })
  assert.equal(b.observeOnce(file).length, 0, '续读：不重复注入')
  // 默认不落盘 → 新实例重读全量。这是明确取舍，不是"已支持续读"（见 ObserveOptions 注释）。
  const c = new Observer(new ObserveSession(), cfg)
  assert.equal(c.observeOnce(file).length, 1, '默认不落盘 → 重启后重读全量（已知取舍）')
  rmSync(dir, { recursive: true, force: true })
})

test('采样遥测：被丢弃的证据要能被看见，且能看出丢在哪一层', () => {
  // 以前丢弃是**完全静默**的：运维只看得到"进化一直没产出候选"，
  // 却分不清是日志里没异常、还是异常全被采样丢了、又是丢在哪一层。
  const dir = tmpDir([
    nginxAt('10/Oct/2026:12:00:00 +0000', '/admin'),
    nginxAt('10/Oct/2026:12:10:00 +0000', '/admin'),
    nginxAt('10/Oct/2026:12:20:00 +0000', '/admin'),
    nginxAt('10/Oct/2026:12:30:00 +0000', '/admin'),
  ])
  const obs = new Observer(new ObserveSession(), { threshold: 100, perHourCap: 2, maxShare: 1 })
  try {
    const injected = obs.observeOnce(join(dir, 'access.log'))
    const s = obs.sampleStats()
    assert.equal(s.seen, 4, '采样前的检出总数')
    assert.equal(injected.length, 2, '每小时上限 2')
    assert.equal(s.injected, 2)
    assert.equal(s.droppedByHourCap, 2, '要能看出是"每小时上限"这一层丢的')
    assert.equal(s.droppedByShare, 0, '本例不触发抗挤占')
    assert.equal(s.seen - s.injected, s.droppedByHourCap + s.droppedByShare, '丢弃数可对账')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('采样遥测：抗挤占丢弃单独计数（与每小时上限分开）', () => {
  // 同一类异常占比过高会被抗挤占丢弃——它与"每小时上限"是两层不同的原因，处置方式也不同。
  const dir = tmpDir([
    nginxAt('10/Oct/2026:12:00:00 +0000', '/admin'),
    nginxAt('10/Oct/2026:12:01:00 +0000', '/admin'),
    nginxAt('10/Oct/2026:12:02:00 +0000', '/admin'),
    nginxAt('10/Oct/2026:12:03:00 +0000', '/admin'),
    nginxAt('10/Oct/2026:12:04:00 +0000', '/search?q=1%27--'),
  ])
  const obs = new Observer(new ObserveSession(), { threshold: 100, perHourCap: 100, maxShare: 0.5 })
  try {
    obs.observeOnce(join(dir, 'access.log'))
    const s = obs.sampleStats()
    assert.equal(s.droppedByHourCap, 0, 'cap 给足，不该因上限丢弃')
    assert.ok(s.droppedByShare > 0, `抗挤占应有丢弃，实测 ${JSON.stringify(s)}`)
    assert.equal(s.seen - s.injected, s.droppedByShare)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('detect：编码过的路径也要能检出（先解码再匹配）', () => {
  // 不解码的话，攻击者只要换个编码就能让进化永远看不见这类攻击：
  // 检测不到 → 不产生证据 → 规则长不出来（引擎侧会解码并拦下流量，所以不影响当前防护）。
  assert.equal(detect({ ...line, path: '/%61dmin' }), 'path-probe', '%61dmin 解码后就是 /admin')
  assert.equal(detect({ ...line, path: '/%2Eenv' }), 'path-probe', '编码过的 .env')
  assert.equal(detect({ ...line, path: '/%77p-login' }), 'path-probe')
  // 畸形编码解不出来：保持原样，不该抛异常
  assert.doesNotThrow(() => detect({ ...line, path: '/%zz' }))
  assert.equal(detect({ ...line, path: '/%zz', ua: 'Mozilla/5.0' }), null)
})

test('detect：子路径下的敏感路径不漏（不能只锚在开头）', () => {
  // 只认 `^/admin` 会让这些全部漏检——而它们恰恰是常见的探测形态。
  assert.equal(detect({ ...line, path: '/cms/wp-admin' }), 'path-probe')
  assert.equal(detect({ ...line, path: '/api/.env' }), 'path-probe')
  assert.equal(detect({ ...line, path: '/shop/admin/orders' }), 'path-probe')
  assert.equal(detect({ ...line, path: '/blog/../../etc/passwd' }), 'path-probe')
})

test('detect：名字相近的正常路径不误伤（放宽后必须更准，而不是更松）', () => {
  // 若把匹配简单放宽成 contains，下面这些正常路径都会被当成探测。
  // 所以要求敏感词前后都是段边界（开头 / `/` / 结尾 / `?`）。
  assert.equal(detect({ ...line, path: '/blog/administration', ua: 'Mozilla/5.0' }), null, 'administration 不是 admin')
  assert.equal(detect({ ...line, path: '/admin-panel-info', ua: 'Mozilla/5.0' }), null)
  assert.equal(detect({ ...line, path: '/my-wp-admin-tips', ua: 'Mozilla/5.0' }), null)
})
