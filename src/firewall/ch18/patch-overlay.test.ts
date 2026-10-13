// src/firewall/ch18/patch-overlay.test.ts —— 用 boot() 走 dsh 真实的 patch 叠加路径
//
// 为什么要有这个测试：手工 `ctx.plugin(...)` 装配**测不到 patch 的叠加顺序**——
// 手工装配时是谁先写谁先挂，而真实部署里条目是按
//   bundle patch → profile 的 cordis.patch.yml → $DSH_HOME patch → 每个 --patch
// 四层叠出来的，后层按 id 胜出。这条链路只能靠 `boot()` 验证。
//
// 这里断言三件事（都是讲正文里写明、但光看代码看不出来的）：
//  1. overlay 按 id 覆盖 config
//  2. 覆盖是**整体替换**，不是增量合并
//  3. config 里的 !!js 会被求值
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

const BIN = 'dsh-firewall-test'

/** 探针插件：把实际收到的 config 记下来，供断言读取。 */
function writeProbe(dir: string): string {
  const file = join(dir, 'probe.mjs')
  writeFileSync(
    file,
    ['export const seen = {}', 'export function apply(ctx, config) { seen.config = config }', ''].join('\n'),
  )
  return file
}

async function bootWithOverlay(overlay: string, rootConfig: string) {
  const patches = loadOverlayPatches(BIN, overlay)
  await boot(BIN, rootConfig, patches)
}

test('boot()：overlay 按 id 覆盖 config，且是整体替换而不是合并', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'compose-'))
  try {
    const probe = writeProbe(dir)
    const root = join(dir, 'cordis.yml')
    writeFileSync(root, '- id: probe\n  name: ./probe.mjs\n  config:\n    a: 1\n    b: 2\n')
    const overlay = join(dir, 'overlay.yml')
    writeFileSync(overlay, '- id: probe\n  config:\n    a: 99\n')

    await bootWithOverlay(overlay, root)
    const mod: { seen: { config?: unknown } } = await import(pathToFileURL(probe).href)
    assert.deepEqual(mod.seen.config, { a: 99 }, '整体替换：原 config 里的 b 消失，不是合并进来')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('boot()：config 里的 !!js 会被求值', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'compose-js-'))
  try {
    const probe = writeProbe(dir)
    const root = join(dir, 'cordis.yml')
    writeFileSync(root, '- id: probe\n  name: ./probe.mjs\n  config:\n    a: 1\n')
    const overlay = join(dir, 'overlay.yml')
    writeFileSync(overlay, '- id: probe\n  config:\n    a: !!js process.env.COMPOSE_TEST_VALUE\n')
    process.env['COMPOSE_TEST_VALUE'] = 'from-env'

    await bootWithOverlay(overlay, root)
    const mod: { seen: { config?: { a?: unknown } } } = await import(pathToFileURL(probe).href)
    assert.equal(mod.seen.config?.a, 'from-env', '!!js 在 config 里求值')
  } finally {
    delete process.env['COMPOSE_TEST_VALUE']
    rmSync(dir, { recursive: true, force: true })
  }
})
