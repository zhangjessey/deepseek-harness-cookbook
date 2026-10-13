// src/firewall/ch18/nginx-auth.test.ts —— nginx auth_request 旁路接线的端到端验证
//
// 验证生产真实形态：起防火墙 HTTP 服务，用 nginx 的 auth_request 旁路指向它，
// 请求经 nginx → 防火墙判定 → nginx 据此放行/拦截（200 放行、403 拦截）。
//
// 两路执行（按顺序 fallback，都没有才 skip，不破坏"npm install 即可跑"）：
//   1. 本机装了 nginx  → 直接 spawn nginx，proxy_pass 到 127.0.0.1
//   2. 本机有 Docker   → docker run nginx:alpine，proxy_pass 到宿主机局域网 IP
//      （容器访问宿主机要用局域网 IP：Docker Desktop 的 host.docker.internal
//        在部分环境解析成 IPv6 而连不上 IPv4 服务，实测 getHostIp() 的稳定）
//
// 配置里两个真踩过的坑（改配置前务必看）：
//   · `return` 在 REWRITE 阶段就返回响应，会跳过 ACCESS 阶段的 auth_request
//     → 放行后必须走到 CONTENT 阶段（这里用静态文件 try_files）
//   · auth_request 子请求的 URI 是 /_auth，不携带客户端原始 URI
//     → 必须用 X-Original-URI 把原始 URI 传过去，toHttpRequest() 会优先读它
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { fileURLToPath } from 'node:url'
import { engineBundle, dataPlaneBundle } from './bundles'
import { createFirewallServer } from './http-ingress'

const hasNginx = spawnSync('nginx', ['-v'], { encoding: 'utf8' }).status === 0
const hasDocker = !hasNginx && spawnSync('docker', ['info'], { encoding: 'utf8' }).status === 0
const mode: 'local' | 'docker' | 'none' = hasNginx ? 'local' : hasDocker ? 'docker' : 'none'

function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

// 容器访问宿主机用的局域网 IPv4（非 internal 的第一个）。
function getHostIp(): string | undefined {
  for (const name of Object.keys(networkInterfaces())) {
    for (const net of networkInterfaces()[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address
    }
  }
  return undefined
}

async function waitForPort(port: number, timeoutMs = 20000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(`http://127.0.0.1:${port}/`)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  throw new Error('nginx 未在超时内就绪')
}

test('nginx auth_request 旁路：经 nginx 的请求被防火墙 403 / 200 拦放', { skip: mode === 'none' }, async () => {
  const ctx = new Context()
  await ctx.plugin(engineBundle)
  await ctx.plugin(dataPlaneBundle, { file: fileURLToPath(new URL('rules.json', import.meta.url)) })
  // nginx 旁路正是"确知前置是 nginx"的场景：nginx 用 `proxy_set_header X-Original-URI
  // $request_uri;` 覆盖掉客户端自带的值，所以这里显式开启信任。默认是关的——端点若被直连，
  // 一行 header 就能绕过全部路径规则（见 http-ingress.test.ts 里"客户端自带该头不生效"）。
  const prevTrust = process.env.FIREWALL_TRUST_ORIGINAL_URI
  process.env.FIREWALL_TRUST_ORIGINAL_URI = '1'

  const server = createFirewallServer(ctx)
  await new Promise<void>((r) => server.listen(0, r)) // 监听 0.0.0.0，容器也能连
  const firewallPort = (server.address() as AddressInfo).port

  // 用 /tmp 而不是 os.tmpdir()：后者在 macOS 是 /var/folders/...，
  // 不在 Docker Desktop 的文件共享范围里，容器挂载不到（nginx 会起不来）。
  const dir = mkdtempSync(join('/tmp', 'nginx-fw-'))
  const nginxPort = await getFreePort()
  const containerName = `nginx-fw-${process.pid}`
  const hostIp = getHostIp()
  // 本机 nginx 走回环；容器要走宿主机局域网 IP
  const upstream = mode === 'local' ? `http://127.0.0.1:${firewallPort}/` : `http://${hostIp}:${firewallPort}/`

  // 放行后返回静态文件（不能用 return，见文件头说明）。
  // docker 模式用 nginx:alpine 自带的 /usr/share/nginx/html，并且**只挂载配置文件**：
  // macOS Docker Desktop 挂载 /tmp 下的整个目录会失败（nginx 起不来：error.log 打不开）。
  if (mode === 'local') writeFileSync(join(dir, 'index.html'), 'upstream ok')
  const rootLine = mode === 'local' ? `    root ${dir};` : '    root /usr/share/nginx/html;'
  const conf = join(dir, 'nginx.conf')
  writeFileSync(
    conf,
    [
      'worker_processes 1;',
      ...(mode === 'local' ? [`error_log ${join(dir, 'error.log')};`, `pid ${join(dir, 'nginx.pid')};`] : []),
      'events { worker_connections 64; }',
      'http {',
      ...(mode === 'local' ? [`  access_log ${join(dir, 'access.log')};`] : []),
      '  server {',
      `    listen ${mode === 'local' ? `127.0.0.1:${nginxPort}` : '80'};`,
      rootLine,
      '    location / {',
      '      auth_request /_auth;',
      '      try_files /index.html =404;',
      '    }',
      '    location = /_auth {',
      '      internal;',
      `      proxy_pass ${upstream};`,
      '      proxy_pass_request_body off;',
      '      proxy_set_header Content-Length "";',
      '      proxy_set_header X-Original-URI $request_uri;',
      '    }',
      '  }',
      '}',
    ].join('\n'),
  )

  let proc: ReturnType<typeof spawn> | null = null
  try {
    if (mode === 'local') {
      proc = spawn('nginx', ['-c', conf, '-p', dir])
    } else {
      proc = spawn('docker', [
        'run',
        '--rm',
        '-d',
        '--name',
        containerName,
        '-p',
        `${nginxPort}:80`,
        '-v',
        `${conf}:/etc/nginx/nginx.conf:ro`,
        'nginx:alpine',
      ])
    }
    await waitForPort(nginxPort)

    // 经 nginx：deny 命中 → 防火墙 403 → nginx 返回 403
    const denied = await fetch(`http://127.0.0.1:${nginxPort}/admin/users`)
    assert.equal(denied.status, 403)

    // 经 nginx：unless 例外 → 防火墙 200 → nginx 放行（返回静态 index.html）
    const exempt = await fetch(`http://127.0.0.1:${nginxPort}/admin/health`)
    assert.equal(exempt.status, 200)

    // 经 nginx：默认放行 → 200
    const miss = await fetch(`http://127.0.0.1:${nginxPort}/api/health`)
    assert.equal(miss.status, 200)
  } finally {
    if (prevTrust === undefined) delete process.env.FIREWALL_TRUST_ORIGINAL_URI
    else process.env.FIREWALL_TRUST_ORIGINAL_URI = prevTrust
    if (mode === 'local') {
      proc?.kill('SIGTERM')
    } else {
      spawnSync('docker', ['rm', '-f', containerName], { encoding: 'utf8' })
    }
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
