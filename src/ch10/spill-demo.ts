// src/ch10/spill-demo.ts —— 上下文压缩：超大文本存到会话旁的文件里
// 跑法：npm run start:ch10:spill
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import LocalSpillStore from '@deepseek-ai/dsh-spill-local'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function main(): Promise<void> {
  // 存到临时目录，跑完能看到文件落盘的样子
  const root = mkdtempSync(join(tmpdir(), 'dsh-ch10-spill-'))

  const ctx = new Context()
  await ctx.plugin(LocalSpillStore, { root })

  // 模拟一次工具调用返回的超大文本（这里只写 4 行，实际可能几百 KB）
  const bigText = [
    'Fetching https://example.com/docs/intro ...',
    '## Introduction',
    'This document explains how context overflow happens and what to do about it.',
    '... (the full body would be much longer)',
  ].join('\n')

  const ref = await ctx.spillStore.saveText({
    owner: { sessionId: SessionId('sess-demo') },
    source: { toolName: 'web_fetch', callId: CallId('call-1'), label: 'result' },
    suggestedName: 'web_fetch.txt',
    content: bigText,
  })

  console.log('--- 把超大文本交给溢出存储 ---')
  console.log(`  定位符（locator）：${ref.locator}`)
  console.log(`  字节数（bytes）：${ref.bytes}`)
  console.log(`  检索提示（retrievalHint）：${ref.retrievalHint}`)

  // 落盘的文件和内容
  const stat = statSync(ref.locator)
  console.log(`  落盘：${stat.size} 字节，权限 ${(stat.mode & 0o777).toString(8)}`)
  console.log(
    `  内容核对：\n${readFileSync(ref.locator, 'utf8')
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n')}`,
  )
}

main()
