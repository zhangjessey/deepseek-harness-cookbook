// src/firewall/ch18/http-server-demo.ts —— 可运行入口：起防火墙 HTTP 服务（真实流量）
//
// 运行：npm run start:ch18:http（默认端口 8787，可用 PORT 覆盖）
// 起好后可以 curl 体验真实流量，也可以配 nginx auth_request 旁路指向它。
import { Context } from '@deepseek-ai/cordis'
import { fileURLToPath } from 'node:url'
import { engineBundle, dataPlaneBundle } from '../bundles'
import { assertRulesLoaded } from '../rules-file'
import { createFirewallServer, trustOriginalUri } from '../http-ingress'

async function main(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(engineBundle)
  await ctx.plugin(dataPlaneBundle, { file: fileURLToPath(new URL('../rules.json', import.meta.url)) })
  // 同 rule-engine-demo：装配后必须确认规则真的灌进来了（插件失败会被 cordis 吞掉）。
  assertRulesLoaded(ctx, fileURLToPath(new URL('../rules.json', import.meta.url)))

  const port = Number(process.env.PORT ?? 8787)
  // 默认只监听回环：这个端点回答"放不放"，它本身就是安全边界，不该暴露给外部网络。
  // 需要内网可达（nginx 在别的机器）时用 HOST 显式指定，并自行确保只有 nginx 能访问它。
  const host = process.env.HOST ?? '127.0.0.1'
  createFirewallServer(ctx).listen(port, host, () => {
    console.log(`防火墙 HTTP 服务已就绪：http://${host}:${port}（仅 ${host} 可达）`)
    if (!trustOriginalUri()) {
      console.log('  注意：默认忽略客户端传来的 X-Original-URI（否则一行 header 就能绕过全部路径规则）；')
      console.log(
        '        nginx 旁路请配 proxy_set_header X-Original-URI $request_uri; 并设 FIREWALL_TRUST_ORIGINAL_URI=1',
      )
    }
    console.log(`  拦截示例：  curl -i http://127.0.0.1:${port}/admin/users    （应 403）`)
    console.log(`  例外示例：  curl -i http://127.0.0.1:${port}/admin/health   （应 200，unless）`)
    console.log(`  放行示例：  curl -i http://127.0.0.1:${port}/api/health     （应 200）`)
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
