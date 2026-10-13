// src/firewall/ch20/demo/rule-evolve-demo.ts —— cli / 可运行入口（对应脚本 npm run start:ch20）
//
// 演示"从异常请求中长出候选规则"的前半链：增量读 nginx 日志 → 三个检测器 → 脱敏 →
// 证据注入会话 → 阈值达成 → propose 长出三类候选 + 两阶段校验。
// 需要 DEEPSEEK_API_KEY：候选由真实模型从脱敏证据中长出（约束仍写在 propose 工具的参数 schema 里）。
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { Observer, ObserveSession } from '../observe'
import { mountObserveSession } from '../session-observe'
import { proposeFromEvidence, validateStage1, validateStage2 } from '../propose'

async function main(): Promise<void> {
  const file = fileURLToPath(new URL('../access.sample.log', import.meta.url))
  const session = new ObserveSession()
  // 演示阈值调低（threshold=2），perHourCap / maxShare 放宽以在样本上可见效果。
  const observer = new Observer(session, { threshold: 2, perHourCap: 100, maxShare: 0.9 })

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
  const ctx = new Context()
  await mountObserveSession(ctx, { sessionId: 'sess-observe' })
  for (const e of evidences) ctx.observeSession.injectEvidence(e)
  console.log(`  dsh 会话日志内的证据数：${ctx.observeSession.evidences().length}`)

  console.log('\n=== 阈值是否达成 ===')
  console.log(`thresholdReached=${observer.thresholdReached()}（演示阈值调低为 2）`)

  console.log('\n=== Agent 长出候选规则（真实模型）===')
  const { candidates, rejected, ok, error, raw, usage } = await proposeFromEvidence(evidences)
  // 模型不可用 / 输出不是 JSON 时，propose 会降级为空候选而不是抛错。
  // 这里必须把原因打出来：只看到"0 条候选"会让人以为"模型看过了、没问题"。
  if (!ok) console.log(`⚠ 本轮未拿到候选（现有防护规则不受影响）：${error}`)
  // 被结构校验拒绝的候选也要呈现：模型产出了 5 条却只交付 3 条、又不说另 2 条为什么没了，
  // 是最难查的一类问题。这里连原因一起打印。
  if (rejected.length > 0) {
    console.log(`模型产出中被结构校验拒绝：${rejected.length} 条`)
    for (const r of rejected) console.log(`  · ${r.name}：${r.why}`)
  }
  console.log(`模型原始回复: ${raw}`)
  console.log(`模型 token 用量: in=${usage.inputTokens} out=${usage.outputTokens}`)
  for (const c of candidates) {
    const s1 = validateStage1(c)
    const s2 = validateStage2(c)
    console.log(`  ${c.id} [${c.name}] when=${JSON.stringify(c.when)} 阶段1=${s1} 阶段2=${s2.ok}`)
    for (const n of s2.notes) console.log(`      · ${n}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
