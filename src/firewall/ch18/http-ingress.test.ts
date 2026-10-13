// src/firewall/ch18/http-ingress.test.ts —— 真实 HTTP 流量经过防火墙的端到端测试
//
// 这一条把"真实流量经过它"也钉死：起一个真实 HTTP 服务，用 fetch 发真实请求，
// 断言 403（deny 命中）/ 200（unless 例外 + 默认放行）。与 ingress-authz.test.ts 的
// 进程内判定互补——那一条测的是引擎判定，这一条测的是"真实 HTTP 请求进来，返回真实状态码"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { engineBundle, dataPlaneBundle } from './bundles'
import { createFirewallServer } from './http-ingress'

async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(engineBundle)
  await ctx.plugin(dataPlaneBundle, { file: fileURLToPath(new URL('rules.json', import.meta.url)) })
  return ctx
}

test('真实 HTTP 流量：deny 命中 403 / unless 例外 200 / 默认放行 200 / 坏 UA 403', async () => {
  const ctx = await boot()
  const server = createFirewallServer(ctx)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${port}`

  try {
    // deny 命中 → 403；规则 id 只在响应头，响应体不回显内部规则名
    const denied = await fetch(`${base}/admin/users`)
    assert.equal(denied.status, 403)
    assert.ok(denied.headers.get('x-firewall-rule-id'), '规则 id 供内部排查')
    assert.equal(await denied.text(), '403 Forbidden', '响应体不回显规则名')

    // unless 例外 → 200（命中 when 但被 unless 放行）
    const exempt = await fetch(`${base}/admin/health`)
    assert.equal(exempt.status, 200)

    // 未命中任何规则 → 200（黑名单默认放行）
    const miss = await fetch(`${base}/api/health`)
    assert.equal(miss.status, 200)

    // 坏 UA → 403（ua 字段来自 user-agent 头）
    const crawler = await fetch(`${base}/blog`, { headers: { 'user-agent': 'python-requests/2.28' } })
    assert.equal(crawler.status, 403)
    assert.ok(crawler.headers.get('x-firewall-rule-id'))
  } finally {
    server.close()
  }
})

test('客户端自带的 X-Original-URI 默认不被采信（否则一行 header 绕过全部路径规则）', async () => {
  const ctx = await boot()
  const server = createFirewallServer(ctx)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${port}`
  const prev = process.env.FIREWALL_TRUST_ORIGINAL_URI
  try {
    // 这个端点回答"放不放"，本身就是安全边界。若采信客户端传来的 X-Original-URI，
    // 攻击者发一个 `X-Original-URI: /api/health` 就能让 /admin/users 被判定成放行路径。
    delete process.env.FIREWALL_TRUST_ORIGINAL_URI
    const spoofed = await fetch(`${base}/admin/users`, { headers: { 'x-original-uri': '/api/health' } })
    assert.equal(spoofed.status, 403, '客户端自带该头不能让拦截失效')

    // 只在确知前置是 nginx（且它用 proxy_set_header 覆盖掉客户端值）时才显式开启。
    process.env.FIREWALL_TRUST_ORIGINAL_URI = '1'
    const trusted = await fetch(`${base}/admin/users`, { headers: { 'x-original-uri': '/api/health' } })
    assert.equal(trusted.status, 200, '开启后按传入的 URI 判定')
  } finally {
    if (prev === undefined) delete process.env.FIREWALL_TRUST_ORIGINAL_URI
    else process.env.FIREWALL_TRUST_ORIGINAL_URI = prev
    server.close()
  }
})

test('路径归一：%61dmin 之类的编码不能绕过路径规则', async () => {
  const ctx = await boot()
  const server = createFirewallServer(ctx)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as AddressInfo).port
  try {
    // 上游应用拿到的是解码后的 /admin/users；防火墙若看字面 %61dmin 就会放行——
    // 这是 WAF 的经典绕过。
    const encoded = await fetch(`http://127.0.0.1:${port}/%61dmin/users`)
    assert.equal(encoded.status, 403, '编码后的路径同样要被拦')
  } finally {
    server.close()
  }
})
