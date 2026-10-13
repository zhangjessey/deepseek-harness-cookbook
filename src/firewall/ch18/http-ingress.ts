// src/firewall/ch18/http-ingress.ts —— 真实 HTTP 数据面入口：把真实 HTTP 请求送进防火墙判定
//
// 正文里"数据面入口"在 demo 中是进程内占位（直接调 ctx.ingressAuthz.authorize(req)）；
// 这里补上"真实流量"这一层：用 Node 的 http 模块起一个最小 HTTP 服务，把进来的 HTTP 请求
// 转成 HttpRequest，交给 ingressAuthz 判定，返回 200（放行）/ 403（拦截）。
//
// 生产里这一步正是 nginx 的 auth_request 旁路：nginx 对每个请求发一个子请求问这个服务
// "放不放"，200 就放行、403 就拦（防火墙不可用时 fail-closed）。本文件就是那个
// "回答 nginx 问询"的端点——所以它不是另一个 demo，而是真实数据面接线的最后一公里。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { HttpRequest } from './types'

/**
 * 是否信任客户端传来的 `X-Original-URI`。默认**不信任**。
 *
 * nginx auth_request 的子请求 URI 是自己那个 /_auth（不是客户端原始 URI），所以要由 nginx
 * 把原始 URI 用这个头传进来。但反过来看：若这个端点能被直接访问，攻击者只要发一个
 * `X-Original-URI: /api/health`，就能让防火墙去判定一个**完全不同的路径**——全部路径规则
 * 一行 header 就被绕过。
 *
 * 所以默认忽略该头，只有确知前置是 nginx、且它用 `proxy_set_header X-Original-URI
 * $request_uri;` 覆盖掉客户端自带的值时，才用环境变量显式开启。
 */
export function trustOriginalUri(): boolean {
  return process.env.FIREWALL_TRUST_ORIGINAL_URI === '1'
}

/**
 * Node 的 headers 值可能是 `string[]`（重复头）或 undefined。
 * `as Record<string, string>` 是类型谎言：重复头会变成数组，取出来后 `typeof !== 'string'`，
 * 于是 eq / contains 静默返回 false——规则不命中，在黑名单模式下就是**放行**。
 * 这里把数组 join 成字符串，保证引擎拿到的始终是字符串。
 */
function flattenHeaders(raw: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue
    out[k] = Array.isArray(v) ? v.join(', ') : v
  }
  return out
}

// 把 Node 的 HTTP 请求转成引擎认识的 HttpRequest。
// body 未读：本演示聚焦路径/方法/UA 判定；真实部署要流式读 body（带大小上限）再交引擎。
export function toHttpRequest(req: IncomingMessage): HttpRequest {
  const originalUri = trustOriginalUri() ? req.headers['x-original-uri'] : undefined
  const target = typeof originalUri === 'string' ? originalUri : (req.url ?? '/')
  let url: URL
  try {
    url = new URL(target, 'http://localhost')
  } catch {
    // 畸形 URI 无法解析。抛出的 TypeError 若穿透到 handler，会让进程崩、nginx 侧拿到 5xx；
    // 宿主若把错误页转成 200 就等于全放行。所以转成显式错误交给下面的兜底去拒绝。
    throw new Error(`无法解析请求 URI：${target}`)
  }
  const headers = flattenHeaders(req.headers)
  return {
    method: req.method ?? 'GET',
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    headers,
    ip: req.socket.remoteAddress ?? '',
    // ua 也从 flattenHeaders 的结果取：直接 `req.headers['user-agent']` 在重复头时是
    // string[]，`as string` 是类型谎言——数组进入 eq/contains 会因 `typeof !== 'string'`
    // 静默 false，UA 规则失效（黑名单下=放行）。flattenHeaders 已把数组 join 成字符串。
    ua: headers['user-agent'] ?? '',
  }
}

// 最小 HTTP 入口：200 放行 / 403 拦截。nginx auth_request 问的正是这个端点。
export function createFirewallServer(ctx: Context) {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      const { decision } = ctx.ingressAuthz.authorize(toHttpRequest(req))
      if (decision?.action === 'deny') {
        // 只回状态码：规则名是内部信息，回显给对端等于把规则库交给对方逐条探测。
        // 旁路模式下 nginx 只关心状态码，规则 id 放进响应头供内部排查（不会流到客户端）。
        res.writeHead(403, {
          'content-type': 'text/plain; charset=utf-8',
          'x-firewall-rule-id': decision.ruleId,
        })
        res.end('403 Forbidden')
      } else {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('200 OK')
      }
    } catch (err) {
      // 兜底：解析失败或判定异常一律拒绝。异常穿透出去会让进程崩、nginx 侧拿到 5xx，
      // 宿主若把错误页转成 200 就等于全放行——安全组件判定不了必须等于拒绝。
      ctx.logger?.warn?.(`[firewall-http] 判定异常，默认拒绝：${err instanceof Error ? err.message : String(err)}`)
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'x-firewall-rule-id': 'error' })
      res.end('403 Forbidden')
    }
  })
}
