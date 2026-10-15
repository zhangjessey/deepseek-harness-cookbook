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
import { ACTOR, Ledger, type FactLog, type Rule } from './ledger'
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

test('四个子命令都经命令系统生效，而不只是直接调 handle', async () => {
  // 其余几条测的是领域逻辑（cmd.handle 直接调用）。这里要验的是"人敲 /firewall xxx"
  // 这条路本身：rawInput 经 dsh 的 handler 进来，也能落到同一份领域逻辑并真的改状态。
  // 少了这条，命令即使注册了，也可能是个"注册了但转发坏了"的空壳。
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LedgerLogService, { sessionId: 'sess-cmd-all' })
  await ctx.plugin(CommandRuntime)
  const ledger = new Ledger(ctx.ledgerLog, '/tmp/cmd-all.json', 'sess-cmd-all')
  const cmd = new FirewallCommand(ledger)
  mountFirewallCommand(ctx, cmd)
  await new Promise((r) => setImmediate(r))

  const def = ctx.commands.find(agent as never, 'firewall')
  assert.ok(def, '命令已注册')

  // level：调整自主级别
  const lv = await def.handler(invocation(' level 2'))
  assert.equal(lv.kind, 'success')
  assert.match('text' in lv ? (lv.text ?? '') : '', /自主级别已设为 2/)
  assert.equal(cmd.getLevel(), '2', '敲命令真能改级别')

  // approve / reject：先造一个候选
  const edit = new FirewallEdit(ledger)
  const id = await edit.draftCandidate(
    { name: 'block x', action: 'deny', when: { field: 'path', op: 'starts_with', value: '/admin' } },
    { by: ACTOR.agentDraft },
  )
  const approved = await def.handler(invocation(` approve ${id}`))
  assert.equal(approved.kind, 'success')
  assert.equal(ledger.listRules().find((r) => r.id === id)?.state, 'active', '敲命令批准真能改状态')

  const rejected = await def.handler(invocation(` reject ${id} 误伤正常流量`))
  assert.equal(rejected.kind, 'success')
  assert.equal(ledger.listRules().find((r) => r.id === id)?.state, 'rejected', '敲命令驳回真能改状态')
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

test('账本能回答"谁起草的 / 谁批准的"：人命令与 Agent 工具分得开', async () => {
  // 起草（Agent 工具）与批准（人命令）复用同一份 FirewallEdit 实现，所以 `by`
  // 只能由调用方标注。少了它，"这条规则是 Agent 在级别 2 下自己转正的、还是人批的"
  // 事后无从回答——而那正是"人掌握决定权"要能被审计的部分。
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LedgerLogService, { sessionId: 'sess-actor' })
  const ledger = new Ledger(ctx.ledgerLog, '/tmp/actor.json', 'sess-actor')
  const cmd = new FirewallCommand(ledger)
  const edit = new FirewallEdit(ledger)

  const id = await edit.draftCandidate(
    { name: 'block x', action: 'deny', when: { field: 'path', op: 'starts_with', value: '/admin' } },
    { by: ACTOR.agentDraft },
  )
  await cmd.handle(`approve ${id}`)

  const facts = ctx.ledgerLog.facts()
  const added = facts.find((f) => f.type === 'rule.add' && f.id === id)
  const approved = facts.find((f) => f.type === 'rule.update' && f.id === id)
  assert.equal(added?.by, ACTOR.agentDraft, '起草事实要标注 Agent')
  assert.equal(approved?.by, ACTOR.humanApprove, '批准事实要标注人——两者必须能分开看')
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

test('命令带理由驳回：理由与"谁"都进账本，而不是只回显一句"已驳回"', async () => {
  // 理由必须走**命令文本**也能进账本：驳回是留痕归档，"为什么"是事后唯一能回答
  // "这条规则当初该不该下线"的依据。命令参数按空格切开，理由要能被拼回一整句。
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LedgerLogService, { sessionId: 'sess-reject-reason' })
  const ledger = new Ledger(ctx.ledgerLog, '/tmp/reject-reason.json', 'sess-reject-reason')
  const cmd = new FirewallCommand(ledger)
  const edit = new FirewallEdit(ledger)

  const id = await edit.draftCandidate(
    { name: 'block x', action: 'deny', when: { field: 'path', op: 'starts_with', value: '/admin' } },
    { by: ACTOR.agentDraft },
  )
  await cmd.handle(`reject ${id} 误伤正常流量`)

  const rf = ctx.ledgerLog.facts().find((f) => f.type === 'rule.reject' && f.id === id)
  assert.ok(rf, '需要找到驳回事实')
  assert.equal(rf.type === 'rule.reject' ? rf.by : undefined, ACTOR.humanReject, '驳回要标人')
  assert.equal(rf.type === 'rule.reject' ? rf.reason : undefined, '误伤正常流量', '命令给的理由要进账本')
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
