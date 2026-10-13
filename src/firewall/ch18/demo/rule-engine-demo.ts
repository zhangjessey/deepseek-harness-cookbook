// src/firewall/ch18/rule-engine-demo.ts —— cli / 可运行入口（对应脚本 npm run start:ch18）
//
// 一个 dsh 应用 = 把若干插件按数据面 / 控制面分组，再由入口挂上插件树。
// 这里装配三个 bundle：引擎核心 + 数据面（入口 + 规则文件）+ 控制面（只读工具）。
// 跑通后你会看到：(1) 规则从 rules.json 灌入 firewall（Consumer 不关心来源）；
// (2) 数据面 ingress-authz 用 firewall 判定；(3) deny 优先 / unless 例外 / 超长字段入口拒绝。
//
// 注意：本讲演示"纯函数引擎 + 装配"，不接模型、不需要 API key。
import { Context } from '@deepseek-ai/cordis'
import { fileURLToPath } from 'node:url'
import { engineBundle, dataPlaneBundle, controlPlaneBundle } from '../bundles'
import { assertRulesLoaded } from '../rules-file'
import { HttpRequest } from '../types'
import { FIELD_MAX_LEN } from '../rules'

async function main(): Promise<void> {
  // cli 装配：先引擎，再数据面（含 rules.json），再控制面（无 tools 服务时自动跳过）。
  const ctx = new Context()
  await ctx.plugin(engineBundle)
  await ctx.plugin(dataPlaneBundle, { file: fileURLToPath(new URL('../rules.json', import.meta.url)) })
  await ctx.plugin(controlPlaneBundle)
  // 装配后**必须确认规则真的灌进来了**。
  //
  // 规则文件路径写错（或文件被删、被改名）时，`rulesFile` 插件会抛错，但 cordis 只会把该
  // 插件记为失败、**不向调用方传播**——表现为"防火墙正常启动、规则库却是空的"，黑名单
  // 模式下等于**全放行，而且没有任何报错**。这是安全组件最坏的失败形态。
  // 所以这里显式兜住：拿不到规则就拒绝继续，绝不带空规则库上线。
  assertRulesLoaded(ctx, fileURLToPath(new URL('../rules.json', import.meta.url)))

  // 展示规则库（来自 rules.json，通过 rules-file Consumer 灌入 firewall）。
  console.log('=== 规则库（来自 rules.json，经 rules-file Consumer 灌入 firewall）===')
  for (const r of ctx.firewall.listRules()) {
    console.log(`  ${r.id} [${r.action}] ${r.name}`)
  }

  // 逐条请求走数据面入口 ingressAuthz（先做"超长字段入口拒绝"，再 firewall 评估）。
  const samples: HttpRequest[] = [
    { method: 'GET', path: '/api/health', ip: '10.0.0.5', ua: 'Mozilla/5.0', headers: {} },
    { method: 'GET', path: '/admin/users', ip: '10.0.0.5', ua: 'Mozilla/5.0', headers: {} },
    { method: 'GET', path: '/admin/health', ip: '10.0.0.5', ua: 'Mozilla/5.0', headers: {} }, // 命中 when 又命中 unless 例外 → 放行
    { method: 'POST', path: '/login', ip: '10.0.0.9', ua: 'Mozilla/5.0', headers: {}, body: "u=1' OR 1=1 --" }, // 命中 body matches（SQL 注入）
    { method: 'GET', path: '/blog', ip: '10.0.0.9', ua: 'python-requests/2.28', headers: {} }, // 命中 ua matches（爬虫）
    { method: 'GET', path: '/'.padEnd(FIELD_MAX_LEN + 1, 'x'), ip: '10.0.0.9', ua: 'Mozilla/5.0', headers: {} }, // 超长字段 → 入口拒绝
  ]

  console.log('\n=== 逐条请求判定（数据面 ingress-authz）===')
  for (const req of samples) {
    const { decision, rejectedByEntry } = ctx.ingressAuthz.authorize(req)
    const verdict = decision ? `${decision.action} ← ${decision.ruleName}` : 'allow (default)'
    const tag = rejectedByEntry ? ' [entry 拒绝]' : ''
    const displayPath = req.path.length > 20 ? `${req.path.slice(0, 20)}…(len=${req.path.length})` : req.path
    console.log(`  ${req.method.padEnd(4)} ${displayPath.padEnd(14)} -> ${verdict}${tag}`)
  }

  // 白名单模式演示：默认拒绝，命中 allow 才放行（fail-closed）。
  console.log('\n=== 白名单模式（默认拒绝，命中 allow 才放行）===')
  ctx.firewall.setMode('whitelist')
  ctx.firewall.loadRules([
    { name: 'allow internal', action: 'allow', when: { field: 'path', op: 'starts_with', value: '/internal' } },
  ])
  for (const req of [
    { method: 'GET', path: '/internal/api', ip: '10.0.0.5', ua: 'Mozilla/5.0', headers: {} },
    { method: 'GET', path: '/public/health', ip: '10.0.0.5', ua: 'Mozilla/5.0', headers: {} },
  ]) {
    const { decision } = ctx.ingressAuthz.authorize(req)
    const verdict = decision ? `${decision.action} ← ${decision.ruleName}` : 'allow (default)'
    console.log(`  ${req.method.padEnd(4)} ${req.path.padEnd(14)} -> ${verdict}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
