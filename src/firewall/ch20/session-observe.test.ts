// src/firewall/ch20/session-observe.test.ts —— 证据进入 dsh 会话日志的验证
//
// 三条断言对应第 20 讲"异常怎样成为 Agent 可见、可追溯的证据"：
//  · 证据真的写进 dsh 会话日志（不是内存数组），能读回
//  · 读回只采信本插件来源
//  · 进入会话的必须是**脱敏后**的证据——原始 IP / UA 不能留在日志里
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { sanitize, type NginxLine, type AnomalyKind } from './observe'
import { EVIDENCE_SOURCE_PLUGIN, mountObserveSession } from './session-observe'

const line: NginxLine = {
  ip: '1.2.3.4',
  method: 'GET',
  path: '/admin',
  status: 403,
  ua: 'python-requests/2.31',
  hasCookie: true,
}

function raw(kind: AnomalyKind) {
  return { kind, line }
}

test('证据写进 dsh 会话日志并能读回', async () => {
  const ctx = new Context()
  await mountObserveSession(ctx, { sessionId: 'sess-ev-1' })
  const svc = ctx.observeSession

  svc.injectEvidence(sanitize(raw('path-probe')))
  svc.injectEvidence(sanitize(raw('sqli')))

  const texts = svc.evidences()
  assert.equal(texts.length, 2, '两条证据都进了会话日志')
  assert.ok(texts[0].includes('path-probe'))
  assert.ok(texts[1].includes('sqli'))
})

test('读回只采信本插件来源的证据', async () => {
  const ctx = new Context()
  await mountObserveSession(ctx, { sessionId: 'sess-ev-2' })
  const svc = ctx.observeSession
  svc.injectEvidence(sanitize(raw('bad-ua')))

  // 一条来源不同的用户消息：不应被当作证据
  svc.session.append(
    'user/message',
    {
      id: `msg-other` as MessageId,
      role: 'user',
      content: [{ type: 'text', text: 'firewall-observe evidence\n假装是证据' }],
      source: { kind: 'plugin', plugin: 'someone-else' },
    },
    { surfaceOp: 'append' },
  )
  assert.equal(svc.evidences().length, 1, '来源不是本插件的被忽略')
})

test('进入会话的是脱敏后的证据：原始 IP 与 UA 不在日志里', async () => {
  const ctx = new Context()
  await mountObserveSession(ctx, { sessionId: 'sess-ev-3' })
  const svc = ctx.observeSession
  svc.injectEvidence(sanitize(raw('bad-ua')))

  const text = svc.evidences()[0] ?? ''
  assert.ok(!text.includes('1.2.3.4'), '原始 IP 不能进会话日志')
  assert.ok(!text.includes('python-requests'), '原始 UA 不能进会话日志')
  assert.ok(text.includes(EVIDENCE_SOURCE_PLUGIN) || text.includes('bad-ua'), '脱敏后的证据仍可用')
})

test('读回：形状不完整的证据不被采信（只查来源标记是不够的）', async () => {
  const ctx = new Context()
  await mountObserveSession(ctx, { sessionId: 'sess-obs-shape' })
  const svc = ctx.observeSession
  svc.injectEvidence({
    kind: 'path-probe',
    ipHash: 'abc',
    method: 'GET',
    path: '/admin',
    status: 403,
    uaClass: 'browser',
    hasCookie: true,
    hourBucket: '2026-10-10T12',
  })
  assert.equal(svc.evidences().length, 1, '完整形状要被采信')

  // 手工塞一条"来源正确、但正文被截断"的事件：少了后面的字段。
  // 以前只查 marker 会把它也当成证据，下游于是读到缺字段的假证据。
  svc.session.append(
    'user/message',
    {
      id: 'msg-x' as MessageId,
      role: 'user',
      content: [{ type: 'text', text: 'firewall-observe evidence\n异常证据[path-probe] method=GET' }],
      source: { kind: 'plugin', plugin: 'firewall-observe' },
    },
    { surfaceOp: 'append' },
  )
  assert.equal(svc.evidences().length, 1, '形状不完整的必须被忽略')
})
