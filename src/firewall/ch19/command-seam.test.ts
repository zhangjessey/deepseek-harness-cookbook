// src/firewall/ch19/command-seam.test.ts —— /firewall 命令接入 dsh commands seam 的验证
//
// 断言"人工命令"这条线真的挂上了 dsh，而不是自己解析字符串：
//  · 命令注册进 ctx.commands（find 能解析到，description 进入发现 UI）
//  · handler 执行返回结构化结果（CommandResult），文本来自领域逻辑
//  · approve / reject 真正改账本状态（不再"只回显"）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { LedgerLogService } from './session-log'
import { Ledger, type FactLog, type Rule } from './ledger'
import { FirewallCommand } from './command-firewall'
import { FirewallEdit } from './tool-firewall-edit'
import { mountFirewallCommand } from './command-seam'

// 命令注册是全局的，find/list 只需一个能当 key 的对象。
const agent = { id: 'agent-1' } as never

function invocation(rawInput: string) {
  return {
    commandId: 'cmd-1' as never,
    agent,
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
  } as never
}

test('命令注册进 dsh commands registry，handler 解析执行', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LedgerLogService, { sessionId: 'sess-cmd-1' })
  await ctx.plugin(CommandRuntime)
  const ledger = new Ledger(ctx.ledgerLog, '/tmp/cmd-1.json', 'sess-cmd-1')
  const cmd = new FirewallCommand(ledger)
  mountFirewallCommand(ctx, cmd)
  await new Promise((r) => setImmediate(r))

  const def = ctx.commands.find(agent as never, 'firewall')
  assert.ok(def, '命令已注册进 registry')
  assert.ok(def.description.includes('防火墙'), 'description 进入发现 UI')

  const result = await def.handler(invocation(' list'))
  assert.equal(result.kind, 'success')
  assert.ok('text' in result)
})

test('approve / reject 命令真正改账本状态', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LedgerLogService, { sessionId: 'sess-cmd-2' })
  const ledger = new Ledger(ctx.ledgerLog, '/tmp/cmd-2.json', 'sess-cmd-2')
  const cmd = new FirewallCommand(ledger)
  const edit = new FirewallEdit(ledger)

  // draftCandidate / handle 现在都是异步的，await 即保证发布已落链——
  // 不再需要 `setImmediate` 去"等一下"（那是把时序假设写进测试，负载高时会 flaky）。
  const id = await edit.draftCandidate({
    name: 'block x',
    action: 'deny',
    when: { field: 'path', op: 'starts_with', value: '/admin' },
  })
  assert.equal(ledger.listRules()[0].state, 'candidate', '起草返回时事实已进权威')

  assert.match(await cmd.handle(`approve ${id}`), /已批准/)
  assert.equal(ledger.listRules()[0].state, 'active', 'approve 真正把候选转 active')

  assert.match(await cmd.handle(`reject ${id}`), /已驳回/)
  // 驳回是**归档**而不是删除：规则留在账本里、标成 rejected。
  // 以前直接删掉，于是"这条规则被谁、何时、为什么驳回"再也回答不了。
  assert.equal(ledger.listRules().length, 1, '驳回后规则仍在账本里（留痕）')
  assert.equal(ledger.listRules()[0].state, 'rejected')
})

test('驳回留下痕迹：能从账本事实回答"被谁 / 为什么 / 何时驳回"', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LedgerLogService, { sessionId: 'sess-reject-trace' })
  const ledger = new Ledger(ctx.ledgerLog, '/tmp/reject-trace.json', 'sess-reject-trace')
  const edit = new FirewallEdit(ledger)

  const id = await edit.draftCandidate({
    name: 'block x',
    action: 'deny',
    when: { field: 'path', op: 'starts_with', value: '/admin' },
  })
  await edit.reject(id, { by: '人（安全值班）', reason: '命中正常业务路径' })

  // 规则还在账本里，且状态是 rejected（不是凭空消失）
  const r = ledger.listRules().find((x) => x.id === id)
  assert.ok(r, '驳回后规则仍可查')
  assert.equal(r.state, 'rejected')

  // 事实里能回答"被谁、为什么、什么时候"
  const facts = ctx.ledgerLog.facts()
  const rf = facts.find((f) => f.type === 'rule.reject' && f.id === id)
  assert.ok(rf, `需要在账本事实里找到驳回事件，实际只有 ${facts.map((f) => f.type).join(',')}`)
  assert.equal(rf.type === 'rule.reject' ? rf.by : undefined, '人（安全值班）')
  assert.equal(rf.type === 'rule.reject' ? rf.reason : undefined, '命中正常业务路径')
  assert.equal(typeof rf.at, 'number', '驳回时间要能被记下')

  // 重复驳回必须失败：否则日志里躺着两条一模一样的 reject，
  // "到底驳回了一次还是两次"从此说不清。
  await assert.rejects(() => edit.reject(id), /已经是 rejected/)
})

test('发布失败会传播给调用方，而不是变成 unhandled rejection', async () => {
  // Node ≥15 遇到 unhandled rejection 会**直接终止进程**。若发布是 fire-and-forget
  // （`void publish(...)`），一次写入失败就会把进程带走，而且没有堆栈指向真正的调用点。
  // 所以 handle / draftCandidate 必须把错误如实交给调用方（dsh 的 command handler
  // 会把抛错收敛成 `kind: 'error'`，工具侧则变成 isError 结果）。
  // state() 返回一条规则，让"目标存在性"检查通过——这样才会走到真正的发布，
  // 我们要测的是**发布失败**如何传播。
  const rules: Rule[] = [
    { id: 'r1', name: 'block x', action: 'deny', when: { field: 'path', op: 'eq', value: '/a' }, state: 'candidate' },
  ]
  const boom: FactLog = {
    sessionId: 'sess-m2',
    appendFact() {
      throw new Error('模拟权威写入失败')
    },
    facts: () => [],
    state: () => rules,
  }
  const ledger = new Ledger(boom, '/tmp/never-written-m2.json', 'sess-m2')
  const cmd = new FirewallCommand(ledger)
  const edit = new FirewallEdit(ledger)

  await assert.rejects(() => cmd.handle('approve r1'), /模拟权威写入失败/, 'approve 的失败要交给调用方')
  await assert.rejects(() => cmd.handle('reject r1'), /模拟权威写入失败/, 'reject 的失败要交给调用方')
  await assert.rejects(
    () =>
      edit.draftCandidate({
        name: 'block x',
        action: 'deny',
        when: { field: 'path', op: 'starts_with', value: '/admin' },
      }),
    /模拟权威写入失败/,
    '起草的失败要交给调用方',
  )
  // 目标不存在：必须是明确的失败，而不是"静默成功"。
  // 失败一律**抛错**（由 command seam 收敛成 error 结果），而不是混在成功文本里返回——
  // 否则调用方分不清这句"批准失败"到底是成功回显还是错误。
  await assert.rejects(() => cmd.handle('approve nope'), /批准失败：找不到规则 nope/)
  await assert.rejects(() => cmd.handle('reject nope'), /驳回失败：找不到规则 nope/)
  // list 不写账本，不该被失败影响
  assert.ok((await cmd.handle('list')).includes('r1'))
})

test('起草：非法条件树在写进权威前被拒绝（工具路径不能绕过校验）', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LedgerLogService, { sessionId: 'sess-m7' })
  const ledger = new Ledger(ctx.ledgerLog, '/tmp/m7.json', 'sess-m7')
  const edit = new FirewallEdit(ledger)

  // 校验必须下沉到"写进权威"这一步：工具路径（`firewall_draft`）收到的是模型可控的 JSON，
  // 若只在模型助手那一侧校验，换个调用方（被注入的 Agent）就能写进任意条件树——
  // 包括 `unless`，那正是在一条 deny 规则上开洞的字段。
  await assert.rejects(
    () => edit.draftCandidate({ name: 'x', action: 'deny', when: { field: 'nope', op: 'ne', value: 1 } }),
    /条件树不合法/,
    '未知字段必须拒绝（ne 对未知字段恒真 = 命中一切请求）',
  )
  await assert.rejects(
    () =>
      edit.draftCandidate({
        name: 'x',
        action: 'deny',
        when: { field: 'path', op: 'starts_with', value: '/a' },
        unless: null as never,
      }),
    /条件树不合法/,
    'unless 同样要校验（它能在 deny 规则上开洞）',
  )
  await assert.rejects(
    () => edit.draftCandidate({ name: 'x', action: 'deny', when: {} }),
    /条件树不合法/,
    '空对象不是合法条件树',
  )
  assert.equal(ledger.listRules().length, 0, '被拒绝的起草不应留下任何规则')
})
