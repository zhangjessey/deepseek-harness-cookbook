// src/firewall/ch18/rules-file.test.ts —— rules-file Consumer 的端到端测试
//
// 验证"规则从文件读入 → 灌进 firewall 服务"这条 Consumer 链路，
// 以及文件缺失 / 结构非法时的失败路径。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SafeRe2Matcher } from './re2-matcher'
import { FirewallEngine } from './firewall'
import { assertRulesLoaded, rulesFile } from './rules-file'

async function bootWithFile(file: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SafeRe2Matcher)
  await ctx.plugin(FirewallEngine)
  await ctx.plugin(rulesFile, { file })
  return ctx
}

test('rules-file：从 JSON 文件读规则灌入 firewall 并参与判定', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-'))
  const file = join(dir, 'rules.json')
  writeFileSync(
    file,
    JSON.stringify({
      rules: [
        { name: 'block admin', action: 'deny', when: { field: 'path', op: 'starts_with', value: '/admin' } },
        { name: 'block ua', action: 'deny', when: { field: 'ua', op: 'contains', value: 'python' } },
      ],
    }),
  )
  const ctx = await bootWithFile(file)
  assert.equal(ctx.firewall.listRules().length, 2)

  const d = ctx.firewall.evaluate({ method: 'GET', path: '/admin/x', headers: {}, ip: '1', ua: 'u' })
  assert.equal(d?.action, 'deny')
  assert.equal(d?.ruleName, 'block admin')
  rmSync(dir, { recursive: true, force: true })
})

test('rules-file：文件不存在抛错', async () => {
  const ctx = new Context()
  await ctx.plugin(SafeRe2Matcher)
  await ctx.plugin(FirewallEngine)
  await assert.rejects(async () => {
    await ctx.plugin(rulesFile, { file: '/nonexistent-rules.json' })
  }, /规则文件不存在/)
})

test('rules-file：顶层无 rules 数组抛错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-'))
  const file = join(dir, 'bad.json')
  writeFileSync(file, JSON.stringify({ foo: 1 }))
  const ctx = new Context()
  await ctx.plugin(SafeRe2Matcher)
  await ctx.plugin(FirewallEngine)
  await assert.rejects(async () => {
    await ctx.plugin(rulesFile, { file })
  }, /rules 数组/)
  rmSync(dir, { recursive: true, force: true })
})

test('assertRulesLoaded：空规则库是合法起始状态，不被误伤（按模式区分）', async () => {
  // 这是重写该守卫的动机：旧实现只要 `listRules()` 为空就一律抛错，于是
  // `{"rules": []}` 这种合法的"还没配规则"会让进程拒绝启动——运维为了绕过，
  // 只能塞一条占位规则，而占位规则最容易写成 `{or: []}` 这类静默失效的形状。
  const dir = mkdtempSync(join(tmpdir(), 'rf-empty-'))
  try {
    const file = join(dir, 'rules.json')
    writeFileSync(file, JSON.stringify({ rules: [] }))
    const ctx = new Context()
    await ctx.plugin(SafeRe2Matcher)
    await ctx.plugin(FirewallEngine)

    // 黑名单模式：空规则库 = 默认放行，是合法起始状态 → 不拒绝（只告警）
    assert.doesNotThrow(() => assertRulesLoaded(ctx, file), '黑名单模式下空规则库不该被拒绝')

    // 白名单模式：空规则库 = 拒绝全部请求 → 必须拒绝启动
    ctx.firewall.setMode('whitelist')
    assert.throws(() => assertRulesLoaded(ctx, file), /白名单模式/, '白名单模式下空规则库要拒绝')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('assertRulesLoaded：文件里有规则却一条都没载入 → 硬失败（抓插件加载失败）', async () => {
  // 这正是 cordis 会吞掉异常的那个场景：文件好好的，但插件没挂上。
  const dir = mkdtempSync(join(tmpdir(), 'rf-notloaded-'))
  try {
    const file = join(dir, 'rules.json')
    writeFileSync(
      file,
      JSON.stringify({
        rules: [{ name: 'block admin', action: 'deny', when: { field: 'path', op: 'starts_with', value: '/admin' } }],
      }),
    )
    const ctx = new Context()
    await ctx.plugin(SafeRe2Matcher)
    await ctx.plugin(FirewallEngine)
    // 故意**不挂** rules-file：模拟"插件加载失败"被 cordis 吞掉的情形
    assert.throws(() => assertRulesLoaded(ctx, file), /一条都没载入/, '有规则却没进引擎必须失败')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
