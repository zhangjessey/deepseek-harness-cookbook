// src/firewall/ch21/loop-task.test.ts —— 后台任务的验证
//
// 三条断言对应第 21 讲"老化是确定性的后台任务"（回退则由 observe 随请求触发）：
//  · 定时器真的在跑，老化由它推进
//  · 停止后不再推进（显式 stop）
//  · **随插件卸载停止**——这不是"同一条路径"：stop 是调用方主动，卸载是 effect 自动，
//     两者必须分别验证（原来只测了前者，却宣称覆盖了后者）
//  · 人在掌握控制时暂停推进
//  · 单次失败不停循环
//
// 每个测试收尾都显式 stop()：定时器会让事件循环一直活跃，不清掉测试进程不会退出。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { RuleLifecycle } from './loop'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoopTaskService, mountLoopTask } from './loop-task'
import { mountLoopLog, type LifecycleEvent } from './loop-log'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

test('后台任务推进老化：连续未命中到阈值后移出', async () => {
  const ctx = new Context()
  await mountLoopTask(ctx, { intervalMs: 10, autonomyLevel: '2' })
  const task = ctx.firewallLoopTask
  try {
    const lc = new RuleLifecycle({ autonomyLevel: '2', fpThreshold: 0.9, staleHits: 3 })
    lc.init(true)
    task.track(lc)

    await sleep(120)
    assert.equal(lc.getStage(), 'aged_out', '后台任务把长期无命中的规则老化移出')
  } finally {
    task.stop()
  }
})

test('停止后定时器不再推进', async () => {
  const ctx = new Context()
  await mountLoopTask(ctx, { intervalMs: 10, autonomyLevel: '2' })
  const task = ctx.firewallLoopTask
  const lc = new RuleLifecycle({ autonomyLevel: '2', fpThreshold: 0.9, staleHits: 999 })
  lc.init(true)
  task.track(lc)

  await sleep(60)
  const ticksBefore = task.ticks
  assert.ok(ticksBefore > 0, '定时器在跑')

  task.stop()
  await sleep(60)
  assert.equal(task.ticks, ticksBefore, '停止后不再 tick')
})

test('人在掌握控制时暂停推进（off / manual / 0）', async () => {
  const ctx = new Context()
  await mountLoopTask(ctx, { intervalMs: 10, autonomyLevel: 'off' })
  const task = ctx.firewallLoopTask
  try {
    assert.equal(task.paused, true, 'off 级别下后台任务暂停')
    await sleep(50)
    assert.equal(task.ticks, 0, '暂停时不推进')
  } finally {
    task.stop()
  }
})

test('随插件卸载停止：卸载后定时器不再推进（不会继续改状态）', async () => {
  // 这条验证的是 effect 自动清理，与显式 stop() 不是一回事：
  // 卸载路径若失效，定时器会在插件消失后继续跑，继续改已经没人管理的闭环状态。
  const ctx = new Context()
  await mountLoopTask(ctx, { intervalMs: 5, autonomyLevel: '2' })
  const task = ctx.firewallLoopTask
  await sleep(50)
  const ticksBefore = task.ticks
  assert.ok(ticksBefore > 0, '挂载后定时器确实在推进')

  ctx.registry.delete(LoopTaskService)
  await sleep(50)
  assert.equal(task.ticks, ticksBefore, '卸载后不再新增 tick（effect 已清理定时器）')
})

test('单次失败不停循环：一个 lifecycle 抛错后，后台任务继续推进', async () => {
  // 一次意外（比如某条规则状态异常）不能让"自动回退"这张安全网整个停摆。
  const ctx = new Context()
  await mountLoopTask(ctx, { intervalMs: 5, autonomyLevel: '2' })
  const task = ctx.firewallLoopTask
  try {
    const boom = new RuleLifecycle({ autonomyLevel: '2', fpThreshold: 0.02, staleHits: 3 })
    boom.init(true)
    boom.observe = () => {
      throw new Error('模拟一次观测失败')
    }
    task.track(boom)

    await sleep(60)
    assert.ok(task.ticks > 1, `一次失败后仍要继续下一轮，实际 ticks=${task.ticks}`)
  } finally {
    task.stop()
  }
})

test('终态对象被移出活跃集：跟踪数组不再只增不减（无界增长）', async () => {
  // 不清理的话，老化/回退的规则会永远留在数组里每 tick 遍历一次，
  // 长时间运行就是内存与每 tick 开销双双随时间线性上涨。
  const ctx = new Context()
  await mountLoopTask(ctx, { intervalMs: 1000, autonomyLevel: '2' }) // 间隔取大，避免自动 tick 干扰
  const task = ctx.firewallLoopTask
  try {
    const lc = new RuleLifecycle({ autonomyLevel: '2', fpThreshold: 0.02, staleHits: 2 }, 'rule-a')
    lc.init(true)
    task.track(lc)
    assert.equal(task.tracked().length, 1)

    task.tick() // 连续未命中 1
    task.tick() // 连续未命中 2 → aged_out
    assert.equal(lc.getStage(), 'aged_out')
    assert.equal(task.tracked().length, 0, '终态对象必须被移出活跃集')

    // 移出不是"抹掉历史"：退出要留下记录，能回答哪条规则退出了、为什么。
    const retired = task.retiredRecords()
    assert.equal(retired.length, 1)
    assert.equal(retired[0].ruleId, 'rule-a')
    assert.equal(retired[0].stage, 'aged_out')
  } finally {
    task.stop()
  }
})

test('同一条规则不会被重复跟踪（否则每 tick 推进两次，老化速度凭空翻倍）', async () => {
  const ctx = new Context()
  await mountLoopTask(ctx, { intervalMs: 1000, autonomyLevel: '2' })
  const task = ctx.firewallLoopTask
  try {
    const a = new RuleLifecycle({ autonomyLevel: '2', fpThreshold: 0.02, staleHits: 2 }, 'rule-same')
    const b = new RuleLifecycle({ autonomyLevel: '2', fpThreshold: 0.02, staleHits: 2 }, 'rule-same')
    task.track(a)
    task.track(b)
    assert.equal(task.tracked().length, 1, '同一 id 只跟踪一次')
  } finally {
    task.stop()
  }
})

test('已判死（回退 / 老化）的规则不能重新进入闭环', async () => {
  const ctx = new Context()
  await mountLoopTask(ctx, { intervalMs: 1000, autonomyLevel: '2' })
  const task = ctx.firewallLoopTask
  try {
    const first = new RuleLifecycle({ autonomyLevel: '2', fpThreshold: 0.02, staleHits: 2 }, 'rule-doomed')
    first.init(true)
    task.track(first)
    task.tick()
    task.tick()
    assert.equal(first.getStage(), 'aged_out')

    // 换一个新实例、用同一个 id 试图重新灰度——这就是"重启后同一条规则被重新灰度"
    // 的同进程等价物。允许它就等于自动回退这张安全网被绕过了一次。
    const again = new RuleLifecycle({ autonomyLevel: '2', fpThreshold: 0.02, staleHits: 2 }, 'rule-doomed')
    again.init(true)
    task.track(again)
    assert.equal(task.tracked().length, 0, '已被判死的规则不得重新进入闭环')
  } finally {
    task.stop()
  }
})

test('闭环日志：重启后仍记得"这条规则已被判死"（不会重新灰度）', async () => {
  // 这是闭环持久化要堵住的那个洞：状态只活在内存里时，进程一重启，
  // 一条刚被回退/老化过的规则换个实例就能重新走一遍灰度——
  // 等于自动回退这张安全网在最需要它的时候（刚回退完、还没修好）失效。
  const root = mkdtempSync(join(tmpdir(), 'loop-log-'))
  try {
    // ── 第一个进程：一条规则被老化 ──
    const ctx1 = new Context()
    await mountLoopTask(ctx1, {
      intervalMs: 1000, // 间隔取大，避免自动 tick 干扰
      autonomyLevel: '2',
      log: { sessionId: 'sess-loop-restart', root },
    })
    const task1 = ctx1.firewallLoopTask
    assert.equal(task1.persistent, true, '挂了日志就是持久化模式')

    const lc = new RuleLifecycle({ autonomyLevel: '2', fpThreshold: 0.02, staleHits: 2 }, 'rule-doomed')
    lc.init(true)
    task1.track(lc)
    task1.tick()
    task1.tick()
    assert.equal(lc.getStage(), 'aged_out', '本进程里它已退出闭环')
    task1.stop()

    // ── 等落盘 ──
    // 轮询而不是固定 sleep：固定值在机器负载高时会不够，让测试随机失败。
    const deadline = Date.now() + 3000
    let landed = false
    let facts: LifecycleEvent[] = []
    while (Date.now() < deadline) {
      const probe = new Context()
      await mountLoopLog(probe, { sessionId: 'sess-loop-restart', root })
      facts = probe.loopLog.facts()
      if (facts.length > 0) {
        landed = true
        break
      }
      await sleep(20)
    }
    assert.ok(landed, '闭环事实必须真的落盘（否则重启后什么都不记得）')
    assert.ok(
      facts.some((f) => f.ruleId === 'rule-doomed' && f.type === 'lifecycle.aged_out'),
      `落盘的事实里要有这条规则的退出记录，实际：${JSON.stringify(facts)}`,
    )

    // ── 第二个进程（模拟重启）：同一 root + 同一 sessionId ──
    const ctx2 = new Context()
    await mountLoopTask(ctx2, {
      intervalMs: 1000,
      autonomyLevel: '2',
      log: { sessionId: 'sess-loop-restart', root },
    })
    const task2 = ctx2.firewallLoopTask
    try {
      assert.ok(
        task2.retiredRecords().some((r) => r.ruleId === 'rule-doomed'),
        `重启后必须记得这条规则已被判死，实际：${JSON.stringify(task2.retiredRecords())}`,
      )
      // 于是"重新灰度"会被拒绝
      const again = new RuleLifecycle({ autonomyLevel: '2', fpThreshold: 0.02, staleHits: 2 }, 'rule-doomed')
      again.init(true)
      task2.track(again)
      assert.equal(task2.tracked().length, 0, '已被判死的规则不得重新进入闭环')
    } finally {
      task2.stop()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('闭环日志：没挂日志是降级模式（persistent=false），不是等价方案', async () => {
  // 降级必须**看得出来**：若静默降级，运维会以为已持久化，
  // 于是在最需要它的时候发现安全网没了。
  const ctx = new Context()
  await mountLoopTask(ctx, { intervalMs: 1000, autonomyLevel: '2' })
  const task = ctx.firewallLoopTask
  try {
    assert.equal(task.persistent, false, '没挂日志就是内存模式')
  } finally {
    task.stop()
  }
})

test('退出事实的归因是真实的（人工回退不会被记成“误伤率超阈值”）', async () => {
  // 以前后台任务把 reason 硬编码成"灰度期误伤率超过阈值"，于是**人工**回退
  // （或 active 期的回退）落盘后都会显示成误伤回退——审计日志里出现假归因。
  // 现在原因由产生这次转移的那一方给出，后台任务只做搬运。
  const root = mkdtempSync(join(tmpdir(), 'loop-reason-'))
  const ctx = new Context()
  try {
    await mountLoopTask(ctx, {
      intervalMs: 3_600_000,
      autonomyLevel: '2',
      log: { sessionId: 'sess-loop-reason', root },
    })
    const task = ctx.firewallLoopTask
    const lc = new RuleLifecycle({ autonomyLevel: '2', fpThreshold: 0.02, staleHits: 99 }, 'rule-manual')
    lc.init(true)
    task.track(lc)
    // 人工回退，并给出这一次的真实原因
    lc.promote('rolled_back', '人判断这条规则过宽')
    task.tick() // 触发 reap → 落盘

    const facts = ctx.loopLog.facts()
    const rf = facts.find((f) => f.type === 'lifecycle.rollback' && f.ruleId === 'rule-manual')
    assert.ok(rf, `回退事实要落盘，实际：${JSON.stringify(facts)}`)
    const reason = rf.type === 'lifecycle.rollback' ? rf.reason : undefined
    assert.equal(reason, '人判断这条规则过宽', '落盘的原因必须是人工给出的那条')
    assert.ok(!String(reason).includes('误伤率'), '不能把人工回退记成误伤回退')

    // 老化路径同样要带真实原因
    const aged = new RuleLifecycle({ autonomyLevel: '2', fpThreshold: 0.02, staleHits: 1 }, 'rule-aged')
    aged.init(true)
    task.track(aged)
    task.tick() // 1 次无命中即老化
    assert.equal(aged.getReason(), '连续 1 次无命中', '老化的原因要能看出判定依据')
  } finally {
    ctx.registry.delete(LoopTaskService)
    rmSync(root, { recursive: true, force: true })
  }
})

test('定时器滴答不污染误伤率分母（回退不会被自己的心跳稀释）', async () => {
  // 若滴答被当成 observe(false, false)，goodTotal 会被灌到几百，真实误伤被稀释到
  // 阈值以下 → **永不回退**；运行越久稀释越强，这条守卫等于被自己的心跳关掉。
  const ctx = new Context()
  await mountLoopTask(ctx, { intervalMs: 3_600_000, autonomyLevel: '2' })
  const task = ctx.firewallLoopTask
  try {
    // minGoodTotal: 1 —— 这个测试只关心"滴答不进分母"，不该被 minGood 门槛干扰
    // （门槛本身有单独的测试钉住）。staleHits 取极大，让滴答不会触发老化。
    const lc = new RuleLifecycle({ autonomyLevel: '2', fpThreshold: 0.02, staleHits: 9999, minGoodTotal: 1 }, 'rule-fp')
    lc.init(true)
    // 一次真实观测：拦下了，但那是正常请求（误伤）
    lc.observe(true, false)
    // 大量定时器滴答（老化阈值 9999，不会因此老化）
    for (let i = 0; i < 500; i++) lc.noteIdle()

    const s = lc.getSignal()
    assert.equal(s.goodTotal, 1, '滴答不该计入误伤率的分母')
    assert.equal(s.falsePositives, 1)
    assert.equal(lc.getStage(), 'rolled_back', '误伤率 100% 应当已经回退（没被 500 次滴答稀释）')
    assert.match(lc.getReason(), /误伤率 100\.0%/, '归因要能看出判定依据')
  } finally {
    task.stop()
  }
})
