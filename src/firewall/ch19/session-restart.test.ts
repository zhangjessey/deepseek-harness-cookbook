// src/firewall/ch19/session-restart.test.ts —— 重启恢复的实测
//
// 挂上 JSONL 持久化之后，"会话日志是账本"才真的成立：
// 进程退出 → 新进程从磁盘上的 JSONL 恢复 → 折叠出同样的状态。
//
// 这条断言跨**两个 Context**（等价于两次进程），走的是真实磁盘而不是内存复用——
// 不挂持久化时，第二个 Context 里权威是空的，测试会失败。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountLedgerLog } from './session-log'

const input = { name: 'block x', action: 'deny' as const, when: { field: 'path', op: 'starts_with', value: '/admin' } }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

test('重启恢复：权威落盘后，新进程从 JSONL 恢复出同样的状态', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ledger-restart-'))
  try {
    // 第一个进程：把事实写进权威
    const ctx1 = new Context()
    await mountLedgerLog(ctx1, { sessionId: 'sess-restart', root })
    ctx1.ledgerLog.appendFact({ type: 'rule.add', id: 'a', input, at: 1, state: 'candidate' })
    ctx1.ledgerLog.appendFact({ type: 'rule.update', id: 'a', patch: {}, at: 2, state: 'active' })
    const before = ctx1.ledgerLog.state()
    assert.equal(before.length, 1, '原进程里有 1 条规则')

    // 第二个进程：模拟重启，只带同样的 root 与 sessionId（这里不销毁 ctx1：
    // 关键点是**新 Context 从磁盘读**，而不是复用旧 Context 的内存）。
    //
    // 等持久化把最后一帧落盘：原来是固定 `sleep(300)`，机器负载高时会不够而使测试
    // **随机**失败——flaky 测试会掩盖真正的失败。改成轮询重试、超时才算失败：
    // 既不依赖具体时长，也仍然在验证"新进程能从磁盘恢复出同样的状态"。
    let after: typeof before = []
    const deadline = Date.now() + 5_000
    for (;;) {
      const ctx2 = new Context()
      await mountLedgerLog(ctx2, { sessionId: 'sess-restart', root })
      after = ctx2.ledgerLog.state()
      if (after.length === before.length) break
      if (Date.now() > deadline) {
        throw new Error(`等待持久化落盘超时：期望 ${before.length} 条规则，实际 ${after.length} 条`)
      }
      await sleep(20)
    }

    assert.equal(after.length, before.length, '恢复出的规则数与原进程一致')
    assert.equal(after[0]?.state, 'active', '恢复出的状态与原进程一致')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
