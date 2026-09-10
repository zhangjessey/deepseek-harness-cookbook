// src/ch07/sandbox-demo.ts —— 沙箱：把 argv 包起来再 spawn
// 跑法：npm run start:ch07
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import type { ConfinedSandboxMode } from '@deepseek-ai/dsh-sandbox'

async function main(): Promise<void> {
  const root = new Context()
  await root.plugin(LocalSandboxProvider)

  // 一个临时目录当作"工作区根目录"，HOME 下的文件当作"工作区外"
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-workspace-'))
  const outside = join(homedir(), '_dsh_should_not_exist.txt')
  // 输出时把长路径换成别名，否则 Seatbelt profile 会被真实路径淹没
  const shorten = (text: string) =>
    text
      .split('/private' + workspace)
      .join('$WORKSPACE')
      .split(workspace)
      .join('$WORKSPACE')
      .split('/private' + tmpdir())
      .join('$TMPDIR')
      .split(tmpdir())
      .join('$TMPDIR')

  // 按指定模式把命令包一层，spawn 包装后的 argv，返回包装结果与运行结果
  function attempt(mode: ConfinedSandboxMode, command: string) {
    const confined = root.sandbox.confine(['bash', '-c', command], { mode, workspaceRoot: workspace })
    const ran = spawnSync(confined.argv[0], confined.argv.slice(1), { encoding: 'utf8' })
    return { confined, ran }
  }

  console.log('--- ① read-only：往工作区外写 ---')
  {
    const { confined, ran } = attempt('read-only', `echo hi > ${outside}`)
    console.log('  包装后的 argv :', shorten(JSON.stringify(confined.argv)))
    console.log('  退出码        :', ran.status, '| stderr:', ran.stderr?.trim())
  }

  console.log('\n--- ② workspace-write：往工作区里写 ---')
  {
    const { confined, ran } = attempt('workspace-write', `echo hi > ${join(workspace, 'ok.txt')} && echo written`)
    console.log('  包装后的 argv :', shorten(JSON.stringify(confined.argv)))
    console.log('  退出码        :', ran.status, '| stdout:', ran.stdout?.trim())
  }

  console.log('\n--- ③ workspace-write：往工作区外写 ---')
  {
    const { ran } = attempt('workspace-write', `echo hi > ${outside}`)
    console.log('  退出码        :', ran.status, '| stderr:', ran.stderr?.trim())
  }

  console.log('\n--- ④ read-only：只读命令（不该被拦）---')
  {
    const { ran } = attempt('read-only', 'echo read-ok')
    console.log('  退出码        :', ran.status, '| stdout:', ran.stdout?.trim())
  }

  console.log('\n--- ⑤ 同一个命令，不套沙箱 ---')
  {
    // 对照组：直接 spawn 原始 argv，不经过 confine
    const ran = spawnSync('bash', ['-c', `echo hi > ${outside}`], { encoding: 'utf8' })
    console.log('  退出码        :', ran.status, '（对比 ① 的 1：没被拦住，文件真的写出了）')
  }

  console.log('\n--- ⑥ confine 还带回了什么 ---')
  {
    const confined = root.sandbox.confine(['bash', '-c', 'true'], {
      mode: 'read-only',
      workspaceRoot: workspace,
    })
    console.log('  enforcement        :', confined.enforcement)
    console.log('  denialSignatures   :', JSON.stringify(confined.denialSignatures))
    console.log('  runnerFailureRules :', JSON.stringify(confined.runnerFailureRules))
  }

  if (existsSync(outside)) rmSync(outside, { force: true })
  rmSync(workspace, { recursive: true, force: true })
}

main()
