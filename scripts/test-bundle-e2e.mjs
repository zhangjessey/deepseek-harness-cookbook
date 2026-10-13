// scripts/test-bundle-e2e.mjs
//
// 真实 dsh 运行时集成测试，分两部分：
//
//  Part A —— 加载 / 层组合（与 dsh `plugin add` 同机制）
//    用 @deepseek-ai/cordis-plugin-loader（dsh 真实使用的 loader）按真实 cordis.patch.yml
//    把四个防火墙组合包作为 dsh 插件层增量装载（dsh 也是逐个 bundle 添加）。验证四包能无错地
//    叠在一起（只有 ch18 提供 firewall/re2/ingressAuthz，其余只注册工具，无冲突）。
//    注：这里不在 root 上预挂 tools，仅验证"装载 + 组合"本身零报错（工具注册在 Part B 验证）。
//
//  Part B —— 功能 / 数据面（真实 cordis 运行时）
//    用 dsh 调用 bundle 的同款方式：await ctx.plugin(apply) 把 ch18 组合包插到上下文，再用
//    属性 getter（ctx.firewall / ctx.ingressAuthz / ctx.tools，与 ch18 demo 完全一致）验证：
//    服务可用、防火墙工具已注册、ingress-authz 用真实 rules.json 判定 deny/allow。
//
// 运行：node scripts/test-bundle-e2e.mjs
import { Context } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import yaml from 'js-yaml'
import { readFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const cookbookRoot = resolve(here, '..')

const failures = []
function check(cond, label) {
  if (cond) console.log('  PASS', label)
  else { console.log('  FAIL', label); failures.push(label) }
}

async function main() {
  process.env.FIREWALL_RULES_FILE = resolve(cookbookRoot, 'src/firewall/ch18/rules.json')

  // ===== Part A：loader 增量装载四包（与 dsh plugin add 一致）=====
  console.log('\n[Part A] 真实 loader 增量装载四个组合包（加载 + 层组合）')
  const root = new Context()
  // 正规插件生命周期装配 loader（baseUrl 让 . 相对导入可解析；不传会触发 loader 的 Cyclic __proto__）
  root.plugin(Loader, { baseUrl: fileURLToPath(import.meta.url) })
  await root.fiber.await()
  const loader = root.loader
  check(!!loader && !!loader.root, 'loader 实例可用')
  const bundleNames = [
    'dsh-firewall-rule',
    'dsh-firewall-governance',
    'dsh-firewall-evolution',
    'dsh-firewall-eval-loop',
  ]
  const base = []
  for (const n of bundleNames) {
    const parsed = yaml.load(readFileSync(resolve(cookbookRoot, 'packages', n, 'cordis.patch.yml'), 'utf8'))
    const p = parsed[0] // 每个 patch 文件是单元素数组
    p.insert[0].id = n   // 用包名作 entry id，避免与 firewall 等同名服务在 isolate 处理上冲突
    if (n === 'dsh-firewall-governance') {
      const tmpDir = resolve('/tmp/firewall-e2e')
      mkdirSync(tmpDir, { recursive: true })
      p.insert[0].config = { file: resolve(tmpDir, 'ledger.json'), sessionId: 'sess-firewall', agentsSessionId: 'sess-firewall' }
    }
    base.push(p)
    try {
      await loader.root.update(applyEntryPatches([], base, () => {}))
      await root.fiber.await()
      console.log('  loaded', n, '-> OK')
    } catch (e) {
      console.log('  loaded', n, '-> FAIL:', e.message)
      failures.push(`加载 ${n} 报错: ${e.message}`)
    }
  }
  check(failures.filter((f) => f.startsWith('加载')).length === 0, '四个组合包全部无错装载（加载 + 层组合）')

  // ===== Part B：用 dsh 调用 bundle 的同款方式装载 ch18 包，验证功能与数据面 =====
  console.log('\n[Part B] await ctx.plugin(apply) 装载 ch18 包并验证防火墙能力（真实运行时）')
  const fwPkg = await import('../packages/dsh-firewall-rule/src/index.ts') // { name, apply }
  const ctx = new Context()
  await ctx.plugin(ToolRuntime)       // 提供 tools 服务（在 loader 树外单独提供，模拟 dsh base）
  await ctx.plugin(fwPkg)             // dsh 调用 bundle：传模块命名空间 { name, apply }，勿传裸 apply 函数
  await ctx.fiber.await()

  const firewall = ctx.firewall
  const ingressAuthz = ctx.ingressAuthz
  const tools = ctx.tools
  check(!!firewall, 'firewall 服务可用')
  check(!!ingressAuthz, 'ingressAuthz 服务可用')
  check(!!tools, 'tools 服务可用')
  const names = (tools ? tools.schemas() : []).map((s) => s.name).sort()
  console.log('    已注册工具:', names.join(', '))
  check(names.includes('list_rules') && names.includes('check_request'), '防火墙工具 list_rules/check_request 已注册')

  console.log('\n[Part B] 数据面：ingress-authz 用真实规则库判定')
  const deny = ingressAuthz.authorize({ method: 'GET', path: '/admin/users', ip: '10.0.0.5', ua: 'Mozilla/5.0', headers: {} })
  check(deny.decision && deny.decision.action === 'deny', '/admin/users -> deny (规则命中)')
  const allow = ingressAuthz.authorize({ method: 'GET', path: '/api/health', ip: '10.0.0.5', ua: 'Mozilla/5.0', headers: {} })
  check(!allow.decision || allow.decision.action === 'allow', '/api/health -> allow (默认放行)')
  const rules = firewall.listRules()
  check(Array.isArray(rules) && rules.length > 0, `firewall 规则库已灌入 (${rules.length} 条)`)

  console.log('\n==== 结果 ====')
  if (failures.length === 0) { console.log('ALL PASS'); process.exit(0) }
  console.log('FAILURES:', failures.length)
  failures.forEach((f) => console.log(' -', f))
  process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
