// src/firewall/ch18/firewall.test.ts —— FirewallEngine 判定语义的单元测试
//
// 钉死四个产品决定：deny 优先且与顺序无关、allow 只在白名单模式生效、
// 黑名单默认放行、candidate 不参与判定；外加 loadRules 替换、缓存与替身守卫。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { SafeRe2Matcher } from './re2-matcher'
import { FirewallEngine } from './firewall'
import type { HttpRequest } from './types'

async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SafeRe2Matcher)
  await ctx.plugin(FirewallEngine)
  return ctx
}

const req = (path: string): HttpRequest => ({
  method: 'GET',
  path,
  headers: {},
  ip: '1.2.3.4',
  ua: 'x',
})

test('坏正则模式在装载期就被拒绝，且不留半成品规则库', async () => {
  const ctx = await boot()
  const fw = ctx.firewall
  fw.addRule({ name: 'ok', action: 'deny', when: { field: 'path', op: 'eq', value: '/a' } })
  const before = fw.listRules().length
  // {n,m} 是回溯型构造，RE2 子集不支持。它必须在装载规则时就抛出——
  // 若留到求值期，后果是第一个匹配的请求触发异常、让强制点崩掉（= fail-open）。
  assert.throws(
    () => fw.addRule({ name: 'bad', action: 'deny', when: { field: 'path', op: 'matches', value: 'a{2,3}' } }),
    /回溯型/,
    '装载期必须拒绝坏模式',
  )
  assert.equal(fw.listRules().length, before, '装载失败不应把规则库变成半成品')
  // 已入库的好规则仍然可用：装载失败是"整批拒绝"，不是"留下一条永不生效的规则"。
  assert.equal(fw.evaluate(req('/a'))?.action, 'deny')
})

test('deny 优先且与顺序无关：allow 在前、deny 在后，仍 deny', async () => {
  const ctx = await boot()
  const fw = ctx.firewall
  fw.addRule({ name: 'allow admin', action: 'allow', when: { field: 'path', op: 'starts_with', value: '/admin' } })
  fw.addRule({ name: 'deny admin', action: 'deny', when: { field: 'path', op: 'starts_with', value: '/admin' } })
  const d = fw.evaluate(req('/admin/x'))
  assert.equal(d?.action, 'deny')
  assert.equal(d?.ruleName, 'deny admin')
})

test('deny 与顺序无关：deny 在前、allow 在后，同样 deny', async () => {
  const ctx = await boot()
  const fw = ctx.firewall
  fw.addRule({ name: 'deny admin', action: 'deny', when: { field: 'path', op: 'starts_with', value: '/admin' } })
  fw.addRule({ name: 'allow admin', action: 'allow', when: { field: 'path', op: 'starts_with', value: '/admin' } })
  assert.equal(fw.evaluate(req('/admin/x'))?.action, 'deny')
})

test('黑名单模式：allow 不参与判定，命中 allow 也默认放行（返回 null）', async () => {
  const ctx = await boot()
  const fw = ctx.firewall
  fw.addRule({ name: 'allow admin', action: 'allow', when: { field: 'path', op: 'starts_with', value: '/admin' } })
  assert.equal(fw.evaluate(req('/admin/x')), null)
})

test('白名单模式：allow 生效；未命中 allow 返回 null（上层默认拒绝）', async () => {
  const ctx = await boot()
  const fw = ctx.firewall
  fw.setMode('whitelist')
  fw.addRule({ name: 'allow admin', action: 'allow', when: { field: 'path', op: 'starts_with', value: '/admin' } })
  assert.equal(fw.evaluate(req('/admin/x'))?.action, 'allow')
  assert.equal(fw.evaluate(req('/other')), null)
  assert.equal(fw.getMode(), 'whitelist')
})

test('loadRules 整体替换规则库并清缓存', async () => {
  const ctx = await boot()
  const fw = ctx.firewall
  fw.addRule({ name: 'old', action: 'deny', when: { field: 'path', op: 'eq', value: '/old' } })
  fw.loadRules([{ name: 'new', action: 'deny', when: { field: 'path', op: 'eq', value: '/new' } }])
  assert.equal(fw.listRules().length, 1)
  assert.equal(fw.listRules()[0]?.name, 'new')
  assert.equal(fw.evaluate(req('/old')), null, '旧规则被替换')
  assert.equal(fw.evaluate(req('/new'))?.action, 'deny')
})

test('listRules 返回副本：改副本不影响内部', async () => {
  const ctx = await boot()
  const fw = ctx.firewall
  fw.addRule({ name: 'a', action: 'deny', when: { field: 'path', op: 'eq', value: '/a' } })
  fw.listRules().push({ id: 'x', name: 'x', when: { field: 'path', op: 'eq' }, action: 'deny', state: 'active' })
  assert.equal(fw.listRules().length, 1)
})

test('removeRule 删除后不再命中', async () => {
  const ctx = await boot()
  const fw = ctx.firewall
  const id = fw.addRule({ name: 'a', action: 'deny', when: { field: 'path', op: 'eq', value: '/a' } })
  assert.equal(fw.evaluate(req('/a'))?.action, 'deny')
  fw.removeRule(id)
  assert.equal(fw.evaluate(req('/a')), null)
})

test('candidate 状态不参与判定', async () => {
  const ctx = await boot()
  const fw = ctx.firewall
  fw.addRule({ name: 'a', action: 'deny', when: { field: 'path', op: 'eq', value: '/a' } }, 'candidate')
  assert.equal(fw.evaluate(req('/a')), null, 'candidate 只入库不生效')
})

test('FirewallEngine 构造时拒绝非 RE2 的测试替身', async () => {
  const ctx = new Context()
  class FakeRe2 extends Service {
    constructor(c: Context) {
      super(c, 're2')
    }
  }
  await ctx.plugin(FakeRe2)
  await assert.rejects(async () => {
    await ctx.plugin(FirewallEngine)
  }, /拒绝加载/)
})

test('deny 优先于 allow，且与两条规则的先后顺序无关', async () => {
  // 这一层确实与顺序无关：不论 allow 写在 deny 前面还是后面，只要命中 deny 就拒绝。
  // （多条 deny 之间是按顺序取第一条——那是另一层，见 firewall.ts 的注释；
  //  把两层混在一起说成"与顺序无关"会让人在排查规则冲突时找错方向。）
  const a = await boot()
  a.firewall.addRule({
    name: 'allow all',
    action: 'allow',
    when: { field: 'path', op: 'starts_with', value: '/' },
  })
  a.firewall.addRule({
    name: 'deny admin',
    action: 'deny',
    when: { field: 'path', op: 'starts_with', value: '/admin' },
  })
  assert.equal(a.firewall.evaluate(req('/admin'))?.ruleName, 'deny admin', 'allow 在前也要拒绝')

  const b = await boot()
  b.firewall.addRule({
    name: 'deny admin',
    action: 'deny',
    when: { field: 'path', op: 'starts_with', value: '/admin' },
  })
  b.firewall.addRule({
    name: 'allow all',
    action: 'allow',
    when: { field: 'path', op: 'starts_with', value: '/' },
  })
  assert.equal(b.firewall.evaluate(req('/admin'))?.ruleName, 'deny admin', 'deny 在前同样拒绝')

  // 只命中 allow：黑名单模式下不拦（默认放行）
  assert.equal(b.firewall.evaluate(req('/blog')), null, '黑名单模式下只命中 allow → 默认放行')
})

test('运行时 addRule / loadRules 拒绝空组合（不能只靠文件路径拦住）', async () => {
  const ctx = await boot()
  const fw = ctx.get('firewall') as FirewallEngine
  // 空 and 恒真：能编译（RE2 不拒绝），却在求值时命中一切请求——正是"规则存在但不生效"
  // 那一类失败。文件路径有 readRulesFile 拦，但程序化调用也必须拦，否则能被一条 API 绕过。
  assert.throws(() => fw.addRule({ name: 'x', action: 'deny', when: { and: [] } } as never), /条件树不合法/)
  assert.throws(() => fw.loadRules([{ name: 'y', action: 'deny', when: { or: [] } } as never]), /条件树不合法/)
  // 合法规则不受影响
  const id = fw.addRule({ name: 'ok', action: 'deny', when: { field: 'path', op: 'starts_with', value: '/a' } })
  assert.equal(typeof id, 'string')
})
