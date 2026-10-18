// src/firewall/ch20/demo/rule-evolve-demo.ts —— cli / 可运行入口（对应脚本 npm run start:ch20）
//
// 演示"从异常请求中长出候选规则"的前半链：增量读 nginx 日志 → 三个检测器 → 脱敏 →
// 证据注入会话 → 阈值达成 → propose 长出三类候选 + 三关校验。
// 需要 DEEPSEEK_API_KEY：候选由真实模型从脱敏证据中长出（约束写在 propose 的代码校验
// `isValidCondition` 里——见 ch18/condition.ts，不是参数 schema、也不是提示词）。
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Observer, ObserveSession } from '../observe'
import { mountObserveSession } from '../session-observe'
import { proposeFromEvidence, validateStage1, validateStage2 } from '../propose'

async function main(): Promise<void> {
  const file = fileURLToPath(new URL('../access.sample.log', import.meta.url))
  const session = new ObserveSession()
  // 演示阈值调低，perHourCap / maxShare 放宽以在样本上可见效果。
  // 阈值提成常量：思考题会让读者改它，输出的说明文案必须跟着变——否则就会出现
  // "thresholdReached=false（演示阈值调低为 2）"这种自相矛盾的输出。
  const THRESHOLD = 2
  const observer = new Observer(session, { threshold: THRESHOLD, perHourCap: 100, maxShare: 0.9 })

  const evidences = observer.observeOnce(file)

  console.log('=== 增量读 nginx 日志 + 检测 + 脱敏 ===')
  console.log(`检测到的异常（脱敏后注入会话）：${evidences.length} 条`)
  // 采样遥测：光看"注入了几条"看不出采样丢了多少、丢在哪一层。
  // 这三类原因（日志里没异常 / 每小时上限 / 抗挤占）处置方式完全不同，必须分开呈现。
  const st = observer.sampleStats()
  console.log(
    `采样遥测：检出 ${st.seen} 条 → 注入 ${st.injected} 条` +
      `（每小时上限丢弃 ${st.droppedByHourCap} / 抗挤占丢弃 ${st.droppedByShare}）`,
  )
  for (const e of evidences) {
    console.log(
      `  [${e.kind}] ${e.method} ${e.path} status=${e.status} uaClass=${e.uaClass} ipHash=${e.ipHash} cookie=${e.hasCookie}`,
    )
  }

  console.log('\n=== 证据进入会话（user/message）===')
  console.log(`会话内证据消息数：${session.messages().length}`)
  for (const m of session.messages().slice(0, 3)) console.log(`  ${m.role}: ${m.content}`)

  // 上面是内存里的会话（演示形态）；同一批证据也写进 **dsh 真实的会话日志**：
  // 以插件注入的 user/message 落盘，重启后可加载，满足 model-visible ← logged。
  // 每次运行用新的落盘目录：保证输出可复现（证据不累积上一次运行的内容）。
  const root = mkdtempSync(join(tmpdir(), 'firewall-ch20-'))
  const ctx = new Context()
  await mountObserveSession(ctx, { sessionId: 'sess-observe', root })
  for (const e of evidences) ctx.observeSession.injectEvidence(e)
  console.log(`  dsh 会话日志内的证据数：${ctx.observeSession.evidences().length}`)

  console.log('\n=== 阈值是否达成 ===')
  console.log(`thresholdReached=${observer.thresholdReached()}（演示阈值调低为 ${THRESHOLD}）`)

  // 这里不能写"Agent 长出"：本讲是**一次模型调用**，不是 Agent 循环（正文专门澄清过），
  // 写 Agent 会和正文自相矛盾——读者看到输出块就会困惑"到底有没有 Agent"。
  console.log('\n=== 模型长出候选规则（真实 DeepSeek）===')
  const { candidates, rejected, ok, error, raw, usage } = await proposeFromEvidence(evidences)
  // 模型不可用 / 输出不是 JSON 时，propose 会降级为空候选而不是抛错。
  // 这里必须把原因打出来：只看到"0 条候选"会让人以为"模型看过了、没问题"。
  if (!ok) console.log(`⚠ 本轮未拿到候选（现有防护规则不受影响）：${error}`)
  // 未过前两关（输出结构 / 条件树）的候选也要呈现：模型产出了 5 条却只交付 3 条、又不说
  // 另 2 条为什么没了，是最难查的一类问题。这里连原因一起打印。
  if (rejected.length > 0) {
    console.log(`模型产出中未过前两关：${rejected.length} 条`)
    for (const r of rejected) console.log(`  · ${r.name}：${r.why}`)
  }
  console.log(`模型原始回复: ${raw}`)
  console.log(`模型 token 用量: in=${usage.inputTokens} out=${usage.outputTokens}`)
  // 第一关"输出结构"在 proposeFromEvidence 内部过完：非数组抛 LlmError('malformed') 降级（ok=false，
  // 上面已打印原因）、非对象进 rejected（上面已打印）。这里逐候选过剩下两关并打印结果：
  // 条件树（validateStage1）、命中全部请求（validateStage2）。
  for (const c of candidates) {
    const s1 = validateStage1(c)
    const s2 = validateStage2(c)
    console.log(`  ${c.id} [${c.name}] when=${JSON.stringify(c.when)} 条件树=${s1 ? '通过' : '拒绝'} 命中全部请求=${s2.ok ? '否' : '是'}`)
    for (const n of s2.notes) console.log(`      · ${n}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
