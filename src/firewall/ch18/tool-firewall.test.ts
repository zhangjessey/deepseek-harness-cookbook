// src/firewall/ch18/tool-firewall.test.ts —— 控制面（tool-firewall）的单元测试
//
// tool-firewall 是"数据面与控制面共用同一份 firewall 契约"的另一半：把引擎能力以只读工具
// 交给治理 Agent。这里钉三件事：
//  1. 工具注册需要 `tools` 服务（用最小桩提供）。"没有 tools 时主条目仍然激活"那一半
//     在 bundle-assemble.test.ts 里测。
//  2. 只读：list_rules / check_request 都不改规则库。
//  3. 控制面**必须**与数据面同口径：check_request 走数据面入口（强制点），因此超长字段
//     会被边界拒绝、白名单未命中会给出默认拒绝——都与真正拦流量的那一侧一致。
//     （以前它直接调 firewall.evaluate，绕过了这两层，于是同一个"未命中"在控制面读作
//     放行、在数据面读作拒绝。下面两条测试钉住这个一致性，不让口径再次漂移。）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SafeRe2Matcher } from './re2-matcher'
import { FirewallEngine } from './firewall'
import { IngressAuthz } from './ingress-authz'
import { toolFirewall } from './tool-firewall'
import { FIELD_MAX_LEN } from './rules'

type ListRulesOut = { rules: { id: string; name: string; action: string }[] }
type CheckRequestOut = {
  decision: { action: string; ruleId: string; ruleName: string } | null
  rejectedByEntry?: boolean
}

/**
 * 最小 tools 桩：只记录注册。
 * 不实现 dsh 的执行管线（pre-execute / guard / 呈现）——那属于第 19、21 讲；
 * 这里要测的是"工具体注册了什么、execute 做了什么"。
 */
function provideToolsStub(ctx: Context): Map<string, ToolDefinition> {
  const registered = new Map<string, ToolDefinition>()
  ctx.provide('tools', {
    register(def: ToolDefinition) {
      registered.set(def.name, def)
      return () => {}
    },
  } as unknown as ToolRuntime)
  return registered
}

/** cordis 的子插件不是同步挂上的（加载跨微任务），给一个宏任务让它沉降完。 */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

async function boot(): Promise<{ ctx: Context; tools: Map<string, ToolDefinition> }> {
  const ctx = new Context()
  await ctx.plugin(SafeRe2Matcher) // re2 Provider（FirewallEngine 的注入依赖）
  await ctx.plugin(FirewallEngine) // firewall Provider
  await ctx.plugin(IngressAuthz) // 数据面入口：用来与控制面口径对照
  const tools = provideToolsStub(ctx)
  await ctx.plugin(toolFirewall) // 控制面 Consumer（工具注册在 inject:['tools'] 的子插件里）
  await settle()
  return { ctx, tools }
}

/** 直接调工具的 execute：这里测的是工具体本身，不是 dsh 的调用管线。 */
async function callTool<T>(
  tools: Map<string, ToolDefinition>,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const def = tools.get(name)
  assert.ok(def, `工具 ${name} 应已注册（否则说明控制面没挂上）`)
  return (await def.execute(args, {} as never)) as T
}

test('有 tools 服务：list_rules / check_request 两个只读工具被注册', async () => {
  const { tools } = await boot()
  assert.deepEqual([...tools.keys()].sort(), ['check_request', 'list_rules'])
})

test('list_rules 是只读：调用前后规则库不变，且只暴露 id / name / action 三项', async () => {
  const { ctx, tools } = await boot()
  const id = ctx.firewall.addRule({
    name: 'block admin',
    action: 'deny',
    when: { field: 'path', op: 'starts_with', value: '/admin' },
  })
  const before = ctx.firewall.listRules()

  const out = await callTool<ListRulesOut>(tools, 'list_rules')

  assert.equal(ctx.firewall.listRules().length, before.length, '只读工具调用前后规则数不变')
  assert.deepEqual(out.rules, [{ id, name: 'block admin', action: 'deny' }])
  // 只暴露三项：when 条件不通过只读工具外泄——它是给治理 Agent 看的"目录"，不是规则本体
  assert.deepEqual(Object.keys(out.rules[0]).sort(), ['action', 'id', 'name'])
})

test('check_request 命中规则：返回可解释的判定（与数据面一致），且不改规则库', async () => {
  const { ctx, tools } = await boot()
  const id = ctx.firewall.addRule({
    name: 'block admin',
    action: 'deny',
    when: { field: 'path', op: 'starts_with', value: '/admin' },
  })
  const before = ctx.firewall.listRules().length

  const out = await callTool<CheckRequestOut>(tools, 'check_request', {
    method: 'GET',
    path: '/admin/users',
    ip: '1.2.3.4',
    ua: 'curl/8.5.0',
  })
  assert.deepEqual(out.decision, { action: 'deny', ruleId: id, ruleName: 'block admin' })

  // 两个平面共用同一份契约，所以这条上口径一致（这条是基线，不是缺口）
  const viaEntry = ctx.ingressAuthz.authorize({
    method: 'GET',
    path: '/admin/users',
    headers: {},
    ip: '1.2.3.4',
    ua: 'curl/8.5.0',
  })
  assert.equal(viaEntry.decision?.ruleId, id, '同一条请求走数据面入口命中同一条规则')
  assert.equal(ctx.firewall.listRules().length, before, '只读工具不改变规则库')
})

test('check_request 走数据面入口：超长字段被边界拒绝（与数据面同口径）', async () => {
  const { ctx, tools } = await boot()
  const long = 'x'.repeat(FIELD_MAX_LEN + 1)

  // 入口的边界检查必须生效：否则控制面在试算一条真实流量里根本到不了这里的请求，
  // 治理 Agent 据此得出的结论是假的。
  const viaTool = await callTool<CheckRequestOut>(tools, 'check_request', { method: 'GET', path: long })
  assert.equal(viaTool.rejectedByEntry, true, '超长字段必须被入口拒绝')
  assert.equal(viaTool.decision?.ruleId, 'entry')

  // 与数据面**同口径**
  const viaEntry = ctx.ingressAuthz.authorize({ method: 'GET', path: long, headers: {}, ip: '1.2.3.4', ua: 'u' })
  assert.equal(viaEntry.rejectedByEntry, true)
  assert.equal(viaEntry.decision?.ruleId, viaTool.decision?.ruleId, '控制面与数据面结论一致')
})

test('check_request 走数据面入口：白名单未命中同样默认拒绝（不再与数据面结论相反）', async () => {
  const { ctx, tools } = await boot()
  ctx.firewall.setMode('whitelist')
  ctx.firewall.addRule({
    name: 'allow internal',
    action: 'allow',
    when: { field: 'path', op: 'starts_with', value: '/internal' },
  })

  // 以前控制面返回 null（被读作放行），而数据面是 deny —— 治理 Agent 基于试算做决定就会做错。
  const viaTool = await callTool<CheckRequestOut>(tools, 'check_request', { method: 'GET', path: '/public' })
  assert.equal(viaTool.decision?.action, 'deny', '控制面也必须给出默认拒绝（fail-closed）')
  assert.equal(viaTool.decision?.ruleId, 'default')

  const viaEntry = ctx.ingressAuthz.authorize({ method: 'GET', path: '/public', headers: {}, ip: '1.2.3.4', ua: 'u' })
  assert.equal(viaEntry.decision?.action, viaTool.decision?.action, '两条路径结论必须一致')
})

test('check_request 缺可选字段：ip / ua 兜底为空串、headers 兜底为空对象', async () => {
  const { ctx, tools } = await boot()
  ctx.firewall.addRule({
    name: 'block admin',
    action: 'deny',
    when: { field: 'path', op: 'starts_with', value: '/admin' },
  })
  ctx.firewall.addRule({ name: 'block traced', action: 'deny', when: { field: 'header.x-trace', op: 'exists' } })

  // 只给必填的 method / path，其余全部缺省
  const hit = await callTool<CheckRequestOut>(tools, 'check_request', { method: 'GET', path: '/admin/users' })
  assert.equal(hit.decision?.ruleName, 'block admin', '缺 ip / ua 不影响主判定（兜底成空串）')

  const miss = await callTool<CheckRequestOut>(tools, 'check_request', { method: 'GET', path: '/ok' })
  assert.equal(miss.decision, null, 'headers 缺省兜底为 {}：header 规则不命中，也不会因 undefined 而抛异常')
})
