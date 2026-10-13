// src/firewall/ch21/loop.test.ts —— 闭环生命周期的单元测试（node:test）
//
// 覆盖第 21 讲"上线后持续平衡"的四个转移：初始阶段、灰度转 active、误伤自动回退、老化移出。
// 其中最后一条是回归测试：老化曾按"累计命中数是否为 0"判断，
// 导致命中过一次的规则永远不会老化，与"避免规则库膨胀"的意图相反。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RuleLifecycle } from './loop'

const cfg = { fpThreshold: 0.02, staleHits: 3 }

test('自主级别 off / 0 / manual 不自动转正', () => {
  for (const level of ['off', '0', 'manual'] as const) {
    const lc = new RuleLifecycle({ ...cfg, autonomyLevel: level })
    assert.equal(lc.init(true), 'proposed', `${level} 应停在 proposed`)
  }
})

test('级别 1 进 shadow；级别 2 且风险已过则直接灰度', () => {
  assert.equal(new RuleLifecycle({ ...cfg, autonomyLevel: '1' }).init(false), 'shadow')
  assert.equal(new RuleLifecycle({ ...cfg, autonomyLevel: '2' }).init(true), 'canary')
  assert.equal(new RuleLifecycle({ ...cfg, autonomyLevel: '2' }).init(false), 'shadow')
})

test('灰度命中达标后转 active', () => {
  const lc = new RuleLifecycle({ ...cfg, autonomyLevel: '2' })
  lc.init(true)
  lc.observe(true, true)
  lc.observe(true, true)
  lc.observe(true, true)
  assert.equal(lc.getStage(), 'active')
})

test('灰度期误伤率超阈值 → 自动回退（止损不靠人盯）', () => {
  // minGoodTotal: 1 —— 让单条样本就能触发回退判定，钉住"误伤超阈值即回退"这条主路径
  // （默认 20 门槛另有单独测试，见下）。
  const lc = new RuleLifecycle({ ...cfg, autonomyLevel: '2', minGoodTotal: 1 })
  lc.init(true)
  lc.observe(true, false) // 拦下了一条正常请求
  assert.equal(lc.getStage(), 'rolled_back')
})

test('样本不足时不回退（minGoodTotal 门槛防止单条噪声判死）', () => {
  // goodTotal=1 的一次误伤算出来是 100%，若没有门槛会直接判死——而回退是终态，
  // 落盘后连重启都救不回来。所以样本不足时只记录原因、继续观察。
  const lc = new RuleLifecycle({ ...cfg, autonomyLevel: '2' }) // 默认 minGoodTotal=20
  lc.init(true)
  lc.observe(true, false)
  assert.equal(lc.getStage(), 'canary', '样本不足时不回退，继续观察')
  assert.match(lc.getReason(), /不足 20/, '原因里要能看出是样本不足')
})

test('连续无命中 → 老化移出', () => {
  const lc = new RuleLifecycle({ ...cfg, autonomyLevel: '1', staleHits: 3 })
  lc.init(true)
  lc.observe(false, false)
  lc.observe(false, false)
  lc.observe(false, false)
  assert.equal(lc.getStage(), 'aged_out')
})

test('回归：命中过之后长期不命中，仍要老化', () => {
  const lc = new RuleLifecycle({ ...cfg, autonomyLevel: '2', staleHits: 2 })
  lc.init(true)
  lc.observe(true, true) // 先命中一次
  assert.equal(lc.getSignal().hits, 1)
  lc.observe(false, false)
  lc.observe(false, false) // 连续 2 次没命中
  assert.equal(lc.getStage(), 'aged_out', '老化看的是连续未命中，不是累计命中数')
})

test('promote：补上原先缺失的 shadow → canary 边（级别 1 不会永远卡在 shadow）', () => {
  // 这条边原先在代码里**根本不存在**：能落到 canary 的只有 init，于是级别 1 下的候选
  // 会一直停在 shadow 直到被老化移出——README 主打的"shadow → 灰度 → active"根本跑不通。
  const lc = new RuleLifecycle({ ...cfg, autonomyLevel: '1' })
  assert.equal(lc.init(true), 'shadow')
  assert.ok(lc.canPromote('canary'), 'shadow 必须能推进到灰度')
  assert.equal(lc.promote('canary'), 'canary')
  lc.observe(true, true)
  lc.observe(true, true)
  lc.observe(true, true)
  assert.equal(lc.getStage(), 'active', '走完 shadow → 灰度 → active 主链路')
})

test('promote：proposed 也能由人推进（off / 0 / manual 下不是死端）', () => {
  const lc = new RuleLifecycle({ ...cfg, autonomyLevel: 'off' })
  assert.equal(lc.init(true), 'proposed')
  assert.equal(lc.promote('shadow'), 'shadow')
  assert.equal(lc.promote('canary'), 'canary')
})

test('非法转移被拒绝：终态不可复活，也不能跳过观察直接 active', () => {
  // 终态复活会让"刚被自动回退的规则"靠一次观测又活过来，等于守卫形同虚设。
  const lc = new RuleLifecycle({ ...cfg, autonomyLevel: '2', minGoodTotal: 1 })
  lc.init(true)
  lc.observe(true, false) // 拦下正常请求 → 误伤 → 回退
  assert.equal(lc.getStage(), 'rolled_back')
  assert.throws(() => lc.promote('canary'), /非法阶段转移/, '回退后不能复活')
  assert.throws(() => lc.promote('active'), /非法阶段转移/)

  // 越级：proposed 不能一步到 active，必须先走影子/灰度观察。
  const fresh = new RuleLifecycle({ ...cfg, autonomyLevel: 'off' })
  fresh.init(true)
  assert.throws(() => fresh.promote('active'), /非法阶段转移/, '不能跳过观察直接 active')
})

test('信号只读：拿到的快照改不动内部状态', () => {
  const lc = new RuleLifecycle({ ...cfg, autonomyLevel: '2' })
  lc.init(true)
  lc.observe(true, true)
  assert.equal(lc.getSignal().hits, 1)
  // 每次返回副本（不是内部引用），所以外部改不动 hits 来伪造"灰度达标"。
  assert.notStrictEqual(lc.getSignal(), lc.getSignal(), '返回的是副本')
})

test('误伤率的分母是"见到的正常请求"，不是"命中数"（两套定义给出相反结论）', () => {
  const lc = new RuleLifecycle({ ...cfg, autonomyLevel: '2', fpThreshold: 0.3 })
  lc.init(true)
  lc.observe(true, true) // 命中坏请求
  lc.observe(true, true)
  lc.observe(true, true) // hits=3
  lc.observe(true, false) // 误伤：拦了一条正常请求 → fp=1, goodTotal=1
  // 按"误伤 / 见到的正常" = 1/1 = 100% > 30% → 必须回退。
  // 若错按"误伤 / 命中数" = 1/4 = 25% ≤ 30% → 反而不回退。两者结论相反，
  // 所以这条断言能真正钉住定义，与评测里的 falsePositiveRate 保持一致。
  assert.equal(lc.getStage(), 'rolled_back', '误伤率 100% 必须回退（分母是正常请求数）')
})
