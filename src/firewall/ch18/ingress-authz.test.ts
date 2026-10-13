// src/firewall/ch18/ingress-authz.test.ts —— 数据面入口的单元测试
//
// 钉死"边界"与"引擎"的分工：超长字段在入口拒绝（不进入引擎），
// 正常请求才交给 firewall.evaluate。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SafeRe2Matcher } from './re2-matcher'
import { Firewall, FirewallEngine } from './firewall'
import { IngressAuthz } from './ingress-authz'
import { FIELD_MAX_LEN } from './rules'
import type { HttpRequest } from './types'

async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SafeRe2Matcher)
  await ctx.plugin(FirewallEngine)
  await ctx.plugin(IngressAuthz)
  return ctx
}

const base: HttpRequest = { method: 'GET', path: '/ok', headers: {}, ip: '1.2.3.4', ua: 'u' }

test('强制点：evaluate 抛异常时默认拒绝（fail-closed）', async () => {
  // 异常若从强制点穿透出去，后果是进程崩 → nginx 侧 auth_request 拿到 5xx；
  // 宿主若把错误页转成 200，就等于全放行。所以判定不了必须等于拒绝。
  const ctx = new Context()
  ctx.provide('firewall', {
    evaluate: () => {
      throw new Error('模拟运行期异常')
    },
    getMode: () => 'blacklist',
  } as unknown as Firewall)
  await ctx.plugin(IngressAuthz)
  const r = ctx.ingressAuthz.authorize(base)
  assert.equal(r.decision?.action, 'deny', '判定不了必须拒绝，而不是放行或崩溃')
  assert.equal(r.decision?.ruleId, 'error')
})

test('超长 path 在入口拒绝，不进入引擎', async () => {
  const ctx = await boot()
  const r = ctx.ingressAuthz.authorize({ ...base, path: 'x'.repeat(FIELD_MAX_LEN + 1) })
  assert.equal(r.rejectedByEntry, true)
  assert.equal(r.decision?.ruleId, 'entry')
})

test('超长 body / ua 同样入口拒绝', async () => {
  const ctx = await boot()
  assert.equal(ctx.ingressAuthz.authorize({ ...base, body: 'x'.repeat(FIELD_MAX_LEN + 1) }).rejectedByEntry, true)
  assert.equal(ctx.ingressAuthz.authorize({ ...base, ua: 'x'.repeat(FIELD_MAX_LEN + 1) }).rejectedByEntry, true)
})

test('正常请求交给 firewall.evaluate 判定', async () => {
  const ctx = await boot()
  ctx.firewall.addRule({ name: 'block admin', action: 'deny', when: { field: 'path', op: 'eq', value: '/admin' } })
  const hit = ctx.ingressAuthz.authorize({ ...base, path: '/admin' })
  assert.equal(hit.decision?.action, 'deny')
  assert.equal(hit.decision?.ruleName, 'block admin')
  assert.equal(hit.rejectedByEntry, undefined)

  const miss = ctx.ingressAuthz.authorize({ ...base, path: '/other' })
  assert.equal(miss.decision, null, '黑名单模式未命中默认放行')
})

test('恰好等于上限不被入口拒绝（边界）', async () => {
  const ctx = await boot()
  const r = ctx.ingressAuthz.authorize({ ...base, path: 'x'.repeat(FIELD_MAX_LEN) })
  assert.equal(r.rejectedByEntry, undefined)
})

test('白名单模式：命中 allow 放行，未命中默认拒绝（fail-closed）', async () => {
  const ctx = await boot()
  ctx.firewall.setMode('whitelist')
  ctx.firewall.addRule({
    name: 'allow internal',
    action: 'allow',
    when: { field: 'path', op: 'starts_with', value: '/internal' },
  })

  const hit = ctx.ingressAuthz.authorize({ ...base, path: '/internal/api' })
  assert.equal(hit.decision?.action, 'allow')
  assert.equal(hit.decision?.ruleName, 'allow internal')

  const miss = ctx.ingressAuthz.authorize({ ...base, path: '/public' })
  assert.equal(miss.decision?.action, 'deny', '白名单未命中 → 默认拒绝')
  assert.equal(miss.decision?.ruleId, 'default')
})
