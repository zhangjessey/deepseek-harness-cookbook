// src/ch12/spill-demo.ts —— 上下文边界：超大文本存到会话旁的文件里
// 跑法：npm run start:ch12:spill
//
// 这个示例把第 12 讲第一节那条时间线真跑一遍：工具返回一大段纯文本，
// 策略插件在 `tools/post-execute` 上把它换成「头尾预览 + 一句去哪儿读全文」，
// 完整的那一份另存到会话旁的文件里。
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LocalSpillStore from '@deepseek-ai/dsh-spill-local'
import * as SpillPolicy from '@deepseek-ai/dsh-spill-policy'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 部署配的那条线：超过这么多字节就外置。 */
const MAX_INLINE_BYTES = 50_000

async function main(): Promise<void> {
  // 存到临时目录，跑完能看到文件落盘的样子
  const root = mkdtempSync(join(tmpdir(), 'dsh-ch12-spill-'))

  const ctx = new Context()
  // 四件套：系统提示（工具运行时要用它）、工具运行时（提供 post-execute 挂点）、存储后端、策略插件
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSpillStore, { root })
  await ctx.plugin(SpillPolicy, { maxInlineBytes: MAX_INLINE_BYTES })

  // 一条约 60 KB 的纯文本输出，模拟工具抓回来的网页正文
  const LINE = '## Section\nThis document explains how context overflow happens and what to do about it.\n'
  const bigText = LINE.repeat(Math.ceil(60_000 / Buffer.byteLength(LINE)))

  ctx.tools.register(
    defineTool({
      name: 'web_fetch',
      description: 'Fetch a document and return its body.',
      parameters: { url: { type: 'string', required: true, description: 'The URL to fetch' } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value as string }],
      },
      async execute() {
        return bigText
      },
    }),
  )

  // 策略插件要认得出会话（它按会话分目录存），所以这里给它一个
  const session = Session.create(SessionId('sess-demo'))

  const result = await ctx.tools.execute({
    callId: CallId('call-1'),
    name: 'web_fetch',
    arguments: { url: 'https://example.com/docs/intro' },
    agent: { session } as never, // 只为让策略插件取到会话 id
    signal: new AbortController().signal,
  })

  const before = Buffer.byteLength(bigText, 'utf8')
  const text = (result.content[0] as { type: 'text'; text: string }).text
  const after = Buffer.byteLength(text, 'utf8')

  console.log('--- ① 工具跑完，原始输出多大 ---')
  console.log(`  纯文本：${before} 字节`)
  console.log(`  阈值 maxInlineBytes：${MAX_INLINE_BYTES}   ← 超了，策略插件动手`)

  console.log('--- ② 模型眼前那份（换过之后）---')
  console.log(`  头：${text.slice(0, 96)}…`)
  console.log('  …（中间被预览截掉了）')
  console.log(`  尾：…${text.slice(-96)}`)
  console.log(`  替换后：${after} 字节`)

  console.log('--- ③ 全文存在哪 ---')
  const locator = /Full formatted result stored at: (\S+?)\.\s/.exec(text)?.[1]
  if (locator) {
    const stat = statSync(locator)
    console.log(`  定位符（locator）：${locator}`)
    console.log(`  落盘：${stat.size} 字节，权限 ${(stat.mode & 0o777).toString(8)}   ← 一个字节都没少`)
  }
  const hint = /Use read[^)]*/.exec(text)?.[0]
  if (hint) console.log(`  检索提示（retrievalHint）：${hint}`)
}

main()
