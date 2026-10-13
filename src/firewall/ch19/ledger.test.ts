// src/firewall/ch19/ledger.test.ts —— 账本的单元测试（权威在会话日志，文件只是产物）
//
// 断言第 19 讲那条主线的可测部分：
//  1) 事件折叠（logged → 可重建）
//  2) 缺省 state 必须是 candidate（"第一稿不直接生效"是硬约束）
//  3) 发布是"先写权威、再投影产物"，且两者一致
//  4) 并发发布不丢事件
//  5) 启动时对账：文件有内容而会话日志为空 → 补记进权威（此后文件只作投影）
//  6) sessionId 与 agents 条目不一致时拒绝构造
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { fold, isValidRuleEvent, Ledger, readProjection, readProjectionFile, type FactLog } from './ledger'
import { LedgerLogService } from './session-log'

const input = { name: 'block x', action: 'deny' as const, when: { field: 'path', op: 'starts_with', value: '/admin' } }

async function boot(sessionId: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LedgerLogService, { sessionId })
  return ctx
}

function tempFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'))
  return { dir, file: join(dir, 'rules.ledger.json') }
}

test('fold：add / update / remove 三种事件折叠成当前状态', () => {
  const rules = fold([
    { type: 'rule.add', id: 'a', input, at: 1, state: 'candidate' },
    { type: 'rule.update', id: 'a', patch: {}, at: 2, state: 'active' },
    { type: 'rule.add', id: 'b', input, at: 3 },
    { type: 'rule.remove', id: 'b', at: 4 },
  ])
  assert.equal(rules.length, 1)
  assert.equal(rules[0].state, 'active')
})

test('fold：未显式给 state 时默认 candidate，而不是直接生效', () => {
  const rules = fold([{ type: 'rule.add', id: 'a', input, at: 1 }])
  assert.equal(rules[0].state, 'candidate', '缺省必须是更安全的 candidate')
})

test('发布：先写会话日志（权威），再投影成文件（产物），两者一致', async () => {
  const { dir, file } = tempFile()
  try {
    const ctx = await boot('sess-ledger-1')
    const ledger = new Ledger(ctx.ledgerLog, file, 'sess-ledger-1')
    await ledger.publish({ type: 'rule.add', id: 'a', input, at: 1, state: 'candidate' })

    assert.equal(ctx.ledgerLog.facts().length, 1, '权威里有这条事实')
    const onDisk = readProjection(file)
    assert.equal(onDisk.length, 1, '产物里有投影出的规则')
    assert.deepEqual(ledger.listRules(), onDisk, '权威与产物一致')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('投影文件损坏：绝不当成"空"，且绝不覆盖磁盘内容', async () => {
  const { dir, file } = tempFile()
  try {
    writeFileSync(file, '{ 这不是合法 JSON') // 模拟写坏/写一半
    // 三态读取必须区分"读不出来"与"没有文件"：当成空会让下一步用 [] 覆盖真实数据。
    const read = readProjectionFile(file)
    assert.equal(read.kind, 'corrupt', '损坏必须识别为 corrupt，而不是 missing 或空')
    assert.ok(read.kind === 'corrupt' && read.reason.length > 0, '要给出可行动的原因')

    // 启动对账必须拒绝继续，而不是"以空权威启动 → 把空状态投影覆盖上去"。
    const ctx = await boot('sess-ledger-corrupt')
    const ledger = new Ledger(ctx.ledgerLog, file, 'sess-ledger-corrupt')
    await assert.rejects(() => ledger.adoptProjection(), /投影文件|无法解析/, '对账失败必须抛错')

    // 关键：原文件必须原样保留（并留一份副本供人工恢复），绝不能被覆盖成 []
    assert.equal(readProjectionFile(file).kind, 'corrupt', '原文件未被覆盖')
    assert.ok(existsSync(`${file}.corrupt`), '已隔离一份副本供人工恢复')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('投影文件不存在：视为首次运行，对账静默通过（只有损坏才报错）', async () => {
  const { dir, file } = tempFile()
  try {
    const ctx = await boot('sess-ledger-fresh')
    const ledger = new Ledger(ctx.ledgerLog, file, 'sess-ledger-fresh')
    assert.equal(readProjectionFile(file).kind, 'missing')
    await ledger.adoptProjection() // 首次运行不应抛错
    assert.equal(ledger.listRules().length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('两次 publish 串行生效，事件不丢失', async () => {
  const { dir, file } = tempFile()
  try {
    const ctx = await boot('sess-ledger-2')
    const ledger = new Ledger(ctx.ledgerLog, file, 'sess-ledger-2')
    await Promise.all([
      ledger.publish({ type: 'rule.add', id: 'a', input, at: 1, state: 'candidate' }),
      ledger.publish({ type: 'rule.add', id: 'b', input, at: 2, state: 'candidate' }),
    ])
    assert.equal(ledger.listRules().length, 2, '并发发布不能互相覆盖')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('启动时对账：文件有内容而会话日志为空 → 补记进权威', async () => {
  const { dir, file } = tempFile()
  try {
    // 上一次运行留下的产物（或人直接改过），此时权威还是空的
    writeFileSync(
      file,
      JSON.stringify({
        rules: [
          {
            id: 'legacy',
            name: 'old rule',
            action: 'deny',
            when: { field: 'path', op: 'starts_with', value: '/admin' },
            state: 'active',
          },
        ],
      }),
    )
    const ctx = await boot('sess-ledger-3')
    const ledger = new Ledger(ctx.ledgerLog, file, 'sess-ledger-3')
    await ledger.adoptProjection()

    assert.equal(ledger.listRules().length, 1, '旧产物被补记成权威里的事实')
    assert.equal(ctx.ledgerLog.facts().length, 1, '补记后权威里有一条')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sessionId 与 agents 条目不一致时拒绝构造', async () => {
  const ctx = await boot('sess-ledger-4')
  assert.throws(() => new Ledger(ctx.ledgerLog, '/tmp/whatever.json', 'sess-other'), /sessionId/)
})

test('带外补记与并发 publish 交错：期间新增的规则不会被误删', async () => {
  // diff 必须与补记在同一段写链里：否则快照算完后、补记执行前插入的新规则，
  // 会被那份陈快照判成"文件里没有"而发出 rule.remove —— 静默删掉它。
  const { dir, file } = tempFile()
  try {
    const ctx = await boot('sess-m3')
    const ledger = new Ledger(ctx.ledgerLog, file, 'sess-m3')
    await ledger.publish({ type: 'rule.add', id: 'a', input, at: 1, state: 'candidate' })
    await ledger.publish({ type: 'rule.add', id: 'b', input, at: 2, state: 'candidate' })

    // 带外：文件里只保留 a（diff 会移除 b）；同时并发新增 c
    const outOfBand = ledger.applyOutOfBand([
      { id: 'a', name: 'block x', action: 'deny', when: input.when, state: 'candidate' },
    ])
    const added = ledger.publish({ type: 'rule.add', id: 'c', input, at: 3, state: 'candidate' })
    await Promise.all([outOfBand, added])

    assert.deepEqual(
      ledger
        .listRules()
        .map((r) => r.id)
        .sort(),
      ['a', 'c'],
      'b 被带外移除，c 必须保留',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('写侧校验：非法事实在唯一写入口就被拒绝（不留一条读不回来的事实）', async () => {
  const ctx = await boot('sess-m6w')
  const log = ctx.ledgerLog
  // when 缺 op/value，不是 ch18 认可的合法条件树。写侧若放行，它会进日志、读回时又被丢弃
  // ——于是规则"静默蒸发"：日志里有这条事实、权威里却没有这条规则，verifyFacts 永久不一致。
  const bad = {
    type: 'rule.add',
    id: 'x',
    input: { name: 'x', action: 'deny', when: { field: 'ip' } },
    at: 1,
  } as never
  assert.throws(() => log.appendFact(bad), /形状不合法/, '写入口必须拒绝非法事实')
  assert.equal(log.facts().length, 0, '被拒绝的事实不应出现在日志里')

  // 另一类非法：state 任取（"ACTIVE"）会让折叠出的规则状态非法，判定行为不可预测。
  assert.throws(
    () => log.appendFact({ type: 'rule.add', id: 'y', input, at: 1, state: 'ACTIVE' } as never),
    /形状不合法/,
    '非法的 state 也要拒',
  )
})

test('读写同用一份校验器：写进去的事实都能读回来（无静默蒸发）', async () => {
  const ctx = await boot('sess-m6r')
  const log = ctx.ledgerLog
  const good = { type: 'rule.add' as const, id: 'g', input, at: 1, state: 'candidate' as const }
  log.appendFact(good)
  const facts = log.facts()
  assert.equal(facts.length, 1, '合法事实写进去就必须能读回来')
  assert.deepEqual(facts[0], good, '读回来的是同一条')
  assert.equal(fold(facts).length, 1, '折叠出的权威里也要有这条规则')
  // 这是"两侧不漂移"的守卫：一旦读写各用一套校验器且出现分歧，这里就会红。
  assert.ok(isValidRuleEvent(facts[0]), '读回侧也认这条事实')
})

test('投影文件逐条校验：state 非法的规则报 corrupt，并指出是第几条', () => {
  const { dir, file } = tempFile()
  try {
    writeFileSync(
      file,
      JSON.stringify({
        sessionId: 's',
        rules: [
          { id: 'a', name: 'ok', action: 'deny', when: { field: 'path', op: 'eq', value: '/a' }, state: 'candidate' },
          { id: 'b', name: 'bad', action: 'deny', when: { field: 'path', op: 'eq', value: '/b' }, state: 'ACTIVE' },
        ],
      }),
    )
    const read = readProjectionFile(file)
    assert.equal(read.kind, 'corrupt', 'state 非法必须被识别为 corrupt，而不是当成空')
    const reason = read.kind === 'corrupt' ? read.reason : ''
    assert.ok(reason.includes('第 2 条'), `报错要指向具体那一条，实际：${reason}`)
    assert.ok(reason.includes('state'), `报错要说清是 state 的问题，实际：${reason}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('投影文件逐条校验：when 非法的规则报 corrupt（candidate / active / rejected 都合法）', () => {
  const { dir, file } = tempFile()
  try {
    const ok = (id: string, state: string) => ({
      id,
      name: `r-${id}`,
      action: 'deny',
      when: { field: 'path', op: 'starts_with', value: '/admin' },
      state,
    })
    // 三种状态都要能被读回：rejected 是归档态，投影里必然会出现它。
    writeFileSync(
      file,
      JSON.stringify({ sessionId: 's', rules: [ok('a', 'candidate'), ok('b', 'active'), ok('c', 'rejected')] }),
    )
    const good = readProjectionFile(file)
    assert.equal(good.kind, 'ok')
    assert.equal(good.kind === 'ok' ? good.rules.map((r) => r.state).join(',') : '', 'candidate,active,rejected')

    // when 不合法（未知字段）→ corrupt
    writeFileSync(
      file,
      JSON.stringify({
        sessionId: 's',
        rules: [{ id: 'd', name: 'x', action: 'deny', when: { field: 'nope', op: 'eq' }, state: 'candidate' }],
      }),
    )
    const bad = readProjectionFile(file)
    assert.equal(bad.kind, 'corrupt', 'when 非法必须识别为 corrupt')
    assert.ok((bad.kind === 'corrupt' ? bad.reason : '').includes('第 1 条'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('写链可自愈：一次写入失败不会让后续 publish 永久失败', async () => {
  // 原来 `writeChain = writeChain.then(...)` 把 rejected 的 promise 赋回链上，于是
  // **一次瞬时故障就把这个 Ledger 实例永久废掉**：之后每次 publish / applyOutOfBand
  // 都直接返回第一次那条陈旧错误，而且 `then` 的回调根本不执行——
  // 起草、批准、驳回、带外补记全部失效，报的还都不是当下的错。
  const ctx = await boot('sess-chain')
  const real = ctx.ledgerLog
  let failOnce = true
  const flaky: FactLog = {
    sessionId: 'sess-chain',
    appendFact(f) {
      if (failOnce) {
        failOnce = false
        throw new Error('模拟一次瞬时写入失败')
      }
      real.appendFact(f)
    },
    facts: () => real.facts(),
    state: () => fold(real.facts()),
  }
  const ledger = new Ledger(flaky, '/tmp/never-written-chain.json', 'sess-chain')

  await assert.rejects(
    () => ledger.publish({ type: 'rule.add', id: 'r1', input, at: 1, state: 'candidate' }),
    /瞬时写入失败/,
    '第一次失败要如实交给调用方',
  )
  // 关键：下一次 publish 必须能正常成功（链路已自愈）
  await ledger.publish({ type: 'rule.add', id: 'r2', input, at: 2, state: 'candidate' })
  assert.ok(
    ledger.listRules().some((r) => r.id === 'r2'),
    '一次故障后必须能继续写入（否则整个账本实例被永久废掉）',
  )
})

test('写侧校验：unless 非法同样拒绝（它是在 deny 规则上开洞的字段）', async () => {
  // `unless` 的作用是在一条 deny 规则上开口子。它若形状非法（未知字段 + `ne`），
  // 取值会变成 undefined → `ne` 恒真 → 例外恒命中 → **那条 deny 永不触发 → 全放行**。
  // 只校验 when 不校验 unless，闸门就开了一半：`applyOutOfBand`（带外补记 / 启动时
  // adoption）正是绕过这条闸门的调用方。
  const ctx = await boot('sess-unless')
  const log = ctx.ledgerLog

  const bad = {
    type: 'rule.add' as const,
    id: 'x',
    input: {
      name: 'block x',
      action: 'deny' as const,
      when: { field: 'path', op: 'starts_with', value: '/admin' },
      unless: { field: 'nope', op: 'ne', value: 1 },
    },
    at: 1,
  }
  assert.throws(() => log.appendFact(bad as never), /形状不合法/, '非法的 unless 必须拒绝写入')
  assert.equal(log.facts().length, 0, '被拒的事实不应出现在日志里')

  // 合法的 unless 要放行（别把正常的例外一起拒了）
  const good = { ...bad, input: { ...bad.input, unless: { field: 'path', op: 'eq', value: '/admin/health' } } }
  log.appendFact(good as never)
  assert.equal(log.facts().length, 1, '合法的 unless 应当被写入')
})
