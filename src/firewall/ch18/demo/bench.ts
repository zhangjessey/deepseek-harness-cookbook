// src/firewall/ch18/bench.ts —— 性能基准：把"快速、线性、不回退"变成可复现的数字
//
// 第 18 讲对引擎的宣称是"可靠、快速、可解释"。前两条如果只是形容词，读者无法验证；
// 这里给出三组可复现的数字：
//  1) **良性输入的线性性**：耗时随输入长度线性增长——"每千字符耗时"应基本恒定。
//  2) **最坏情况**（关键）：非锚定 + `.*` 前缀 + **不匹配**的长正文。
//     这一组才真正检验复杂度：若匹配退化成"对每个起点重跑一遍 NFA"，它随长度**二次**增长，
//     "每千字符耗时"会随 n 一路上升；单趟多线程则应保持与 1) 同量级的每千字符耗时。
//     （只测 1) 是不够的：模式 `end` 配 `'x'*n` 时每个起点在首字符就失败、单起点 O(1)，
//      曲线必然"水平"——那是输入构造出来的假象，不是引擎的保证。）
//  3) **吞吐**：固定规则集下 evaluate 的 QPS，覆盖命中 deny / 不命中，且**必须含 matches 算子**
//     ——那是唯一有编译开销的算子，不含它等于绕开了要证明的那条路径。
//
// 运行：npm run bench:ch18（不需要 API key）
import { Context } from '@deepseek-ai/cordis'
import { SafeRe2Matcher } from '../re2-matcher'
import { FirewallEngine } from '../firewall'
import type { HttpRequest, PatternMatcher } from '../types'

function pct(n: number): string {
  return n.toFixed(3)
}

/** 跑一组长度，打印单次耗时与"每千字符耗时"（后者恒定 = 线性，随 n 上升 = 二次或更差）。 */
function sweep(label: string, makeText: (n: number) => string, pattern: string, re2: PatternMatcher): void {
  console.log(`=== ${label} ===`)
  for (const n of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000]) {
    const text = makeText(n)
    const p = re2.compile(pattern)
    re2.match(p, text) // warmup，排除首次编译/冷启动
    const t0 = performance.now()
    for (let i = 0; i < 20; i++) re2.match(p, text)
    const perRun = (performance.now() - t0) / 20
    console.log(`  长度=${String(n).padStart(6)}  单次=${pct(perRun)}ms  每千字符=${pct((perRun / n) * 1000)}ms`)
  }
}

async function main(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(SafeRe2Matcher)
  await ctx.plugin(FirewallEngine)
  const re2 = ctx.re2
  const fw = ctx.firewall

  // ── 1) 良性输入：末尾命中 ──
  sweep('1) RE2 匹配：良性输入（末尾命中），每千字符耗时应基本恒定', (n) => 'x'.repeat(n) + 'end', 'end', re2)

  // ── 2) 最坏情况：非锚定 + .* 前缀 + 不匹配 ──
  // 这组是复杂度检验的关键：`.*` 会吃掉整段 'a'，但 'zzz' 始终匹配不上，
  // 于是朴素实现（按起点重跑）每个起点都要扫到结尾 → O(n²)。
  console.log('')
  sweep(
    '2) 最坏情况：非锚定 .*zzz × 不匹配的长正文（每千字符耗时应与 1) 同量级，不随 n 上升）',
    (n) => 'a'.repeat(n),
    '.*zzz',
    re2,
  )

  // ── 3) 引擎吞吐（含 matches 算子）──
  console.log('\n=== 3) 引擎 evaluate 吞吐（命中 / 不命中；规则集含 matches 算子）===')
  fw.loadRules([
    { name: 'block admin scan', action: 'deny', when: { field: 'path', op: 'starts_with', value: '/admin' } },
    { name: 'block sql injection', action: 'deny', when: { field: 'path', op: 'contains', value: "'--" } },
    { name: 'block crawler ua', action: 'deny', when: { field: 'ua', op: 'contains', value: 'scanner' } },
    // matches 是唯一有编译开销的算子：模式在规则装载时就编译好，求值只跑 match。
    { name: 'block backup probe', action: 'deny', when: { field: 'path', op: 'matches', value: '^/\\.git' } },
  ])
  const miss: HttpRequest = { method: 'GET', path: '/api/health', ip: '10.0.0.1', ua: 'browser', headers: {} }
  const hit: HttpRequest = { method: 'GET', path: '/admin/users', ip: '10.0.0.1', ua: 'browser', headers: {} }
  fw.evaluate(miss) // warmup
  fw.evaluate(hit)
  const N = 50_000
  for (const [label, req] of [
    ['不命中', miss],
    ['命中 deny', hit],
  ] as const) {
    const t1 = performance.now()
    for (let i = 0; i < N; i++) fw.evaluate(req)
    const dt = performance.now() - t1
    console.log(
      `  规则数=4  ${label}  请求数=${N}  总耗时=${pct(dt)}ms  吞吐≈${Math.round((N / dt) * 1000).toLocaleString('en-US')} req/s`,
    )
  }

  console.log('\n（模式在规则装载时编译一次、之后求值只跑 match：上面的 QPS 是"已编译"状态下的吞吐。）')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
