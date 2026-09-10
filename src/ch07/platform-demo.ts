// src/ch07/platform-demo.ts —— 三个平台，三套 runner
// 跑法：npm run start:ch07:platforms
import { basename } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

const policy: SandboxPolicy = { mode: 'read-only', workspaceRoot: process.cwd() }

async function probe(platform: string): Promise<void> {
  console.log(`\n--- platform = ${platform} ---`)

  // 每个平台要一个全新的 provider：runner 的探测结论在 provider 生命周期内缓存
  const root = new Context()
  await root.plugin(LocalSandboxProvider)
  // internals 是 LocalSandboxProvider 暴露的测试钩子，用来替换 process.platform。
  // 真机上不需要这一步——平台就是宿主自己；这里是为了在一台机器上看见三条链。
  const provider = root.sandbox as LocalSandboxProvider
  provider.internals.platform = platform

  try {
    const confined = root.sandbox.confine(['bash', '-c', 'echo hi'], policy)
    const head = basename(confined.argv[0])
    const runner = /^node/.test(head) && confined.argv[1] ? `${head} ${basename(confined.argv[1])}` : head
    console.log('  runner      :', runner)
    console.log('  enforcement :', confined.enforcement)
    console.log('  拒绝方言    :', JSON.stringify(confined.denialSignatures))
    console.log('  包装出的 argv:', JSON.stringify(confined.argv.slice(0, 4)).split(process.cwd()).join('$CWD'))
  } catch (error) {
    const err = error as { name?: string; code?: string; message?: string }
    console.log('  ✗ 抛出      :', err.name, `(code = ${err.code})`)
    console.log('   ', err.message)
  }
}

async function main(): Promise<void> {
  console.log('宿主真实平台 =', process.platform)
  await probe('darwin')
  await probe('linux')
  await probe('win32')
}

main()
