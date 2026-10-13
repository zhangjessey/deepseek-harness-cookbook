// src/firewall/ch18/bundle-assemble.test.ts —— 问题 4"组装上线"的端到端测试
//
// 与 patch-overlay.test.ts 的分工：composition 测 dsh 的 patch"覆盖 config"机制（probe 插件，与防火墙无关）；
// 这里测"防火墙真正组装 / 接入之后，能不能做出正确判定"——覆盖正文问题 4 的两条装配路径
// （纯 demo 的 bundle 组装 + patch insert 无侵入接入），加上问题 1（规则表达）、
// 问题 2（判定可解释）、问题 3（Consumer 有条件存在）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type { ToolDefinition, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { engineBundle, dataPlaneBundle, controlPlaneBundle } from './bundles'
import { toolFirewall } from './tool-firewall'
import type { HttpRequest } from './types'

async function bootDataPlane(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(engineBundle) // re2 + firewall（两个 Provider）
  await ctx.plugin(dataPlaneBundle, { file: fileURLToPath(new URL('rules.json', import.meta.url)) }) // 入口 + 规则来源
  return ctx
}

async function bootFull(): Promise<Context> {
  const ctx = await bootDataPlane()
  await ctx.plugin(controlPlaneBundle) // 只读工具（无 tools 服务时子插件 pending）
  return ctx
}

/** 最小 tools 桩：只记录注册——控制面工具**做什么**在 tool-firewall.test.ts 里测。 */
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

const req = (path: string): HttpRequest => ({ method: 'GET', path, headers: {}, ip: '10.0.0.5', ua: 'Mozilla/5.0' })

test('三个 bundle 组装：rules.json 灌入 → 数据面入口判定（deny 命中 / unless 例外 / 默认放行）', async () => {
  const ctx = await bootFull()

  // rules-file Consumer 把 rules.json 三条规则灌入 firewall
  assert.equal(ctx.firewall.listRules().length, 3, 'rules.json 三条规则经 rules-file 灌入')

  // 数据面入口：deny 命中，且可解释（ruleName 指向规则）
  const hit = ctx.ingressAuthz.authorize(req('/admin/users'))
  assert.equal(hit.decision?.action, 'deny')
  assert.equal(hit.decision?.ruleName, 'block admin scan')

  // unless 例外：/admin/health 命中 when 但被 unless 放行 → 回到默认放行
  const exempt = ctx.ingressAuthz.authorize(req('/admin/health'))
  assert.equal(exempt.decision, null, 'unless 例外 → 默认放行')

  // 未命中任何规则 → 默认放行
  assert.equal(ctx.ingressAuthz.authorize(req('/api/health')).decision, null)
})

test('有 tools 服务：控制面把 list_rules / check_request 两个只读工具真的注册进去', async () => {
  // 没有这个桩，"工具有没有注册"就无处可查——原来的测试正因为缺观测点，
  // 退化成了只断言数据面（与上一个测试完全重复），无法在 inject 纪律被破坏时失败。
  const ctx = await bootDataPlane()
  const registered = provideToolsStub(ctx)
  await ctx.plugin(controlPlaneBundle)
  await settle()

  assert.deepEqual([...registered.keys()].sort(), ['check_request', 'list_rules'], '有 tools 服务 → 两个只读工具都注册')
})

test('无 tools 服务：控制面子插件 pending，主条目仍激活、数据面照常（Consumer 有条件存在）', async () => {
  const ctx = await bootDataPlane()
  await ctx.plugin(controlPlaneBundle) // 不提供 tools 服务
  await settle()

  // 主条目（tool-firewall）本身仍然激活：它没有声明 inject:['tools']——
  // 工具注册放在子插件里，所以"没有 tools"只是跳过注册，不会拖垮整个条目。
  // 这正是 inject 纪律要的效果，也是这条断言存在的理由。
  const runtime = ctx.registry.get(toolFirewall)
  assert.ok(runtime, '无 tools 时主条目仍登记在 cordis 注册表（未整体 pending）')

  // 数据面照常：控制面缺席不影响强制点
  const hit = ctx.ingressAuthz.authorize(req('/admin/users'))
  assert.equal(hit.decision?.action, 'deny')
  assert.equal(hit.decision?.ruleName, 'block admin scan')
})

test('patch insert：防火墙 firewall-plugin.ts 通过 --patch overlay 无侵入接入宿主，ctx.firewall 可用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-patch-'))
  try {
    const pluginPath = fileURLToPath(new URL('./firewall-plugin.ts', import.meta.url))
    const root = join(dir, 'cordis.yml')
    writeFileSync(root, '[]\n') // 空宿主（顶层空数组）：只靠 patch insert 把防火墙挂进来
    const overlay = join(dir, 'overlay.yml')
    writeFileSync(overlay, `- insert:\n  - id: firewall\n    name: "${pluginPath}"\n    config: {}\n`)

    const patches = loadOverlayPatches('dsh-firewall-test', overlay)
    const ctx = await boot('dsh-firewall-test', root, patches)

    assert.ok(ctx.firewall, 'patch insert 后 firewall 服务就绪')
    ctx.firewall.addRule({ name: 'block x', action: 'deny', when: { field: 'path', op: 'eq', value: '/x' } })
    assert.equal(
      ctx.firewall.evaluate({ method: 'GET', path: '/x', headers: {}, ip: '1', ua: 'u' })?.action,
      'deny',
      'patch 接入的防火墙能正常判定',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
