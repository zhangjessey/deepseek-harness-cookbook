// src/ch12/admission-demo.ts —— 上下文边界：附件的准入与失败
// 跑法：npm run start:ch12:admission
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMwTvuPFTEMLQkAqBFmAWlht3MAAAAASUVORK5CYII='
const bytes = new Uint8Array(Buffer.from(PNG_BASE64, 'base64'))
const broken = Uint8Array.of(1, 2, 3) // 不是任何图片格式

function objectCount(home: string): number {
  const root = join(home, 'attachments', 'v1', 'objects')
  if (!existsSync(root)) return 0
  return readdirSync(root).reduce((total, bucket) => total + readdirSync(join(root, bucket)).length, 0)
}

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-ch12-admit-'))
  const ctx = new Context()
  await ctx.plugin(LocalAttachmentStore, { dshHome: home })

  console.log('--- ① 准入线在哪 ---')
  for (const [key, value] of Object.entries(ctx.attachments.imageLimits)) {
    console.log(`  ${key}：${JSON.stringify(value)}`)
  }

  console.log('\n--- ② 校验不落盘 ---')
  const probe = mkdtempSync(join(tmpdir(), 'dsh-ch12-admit-bad-'))
  const ctx2 = new Context()
  await ctx2.plugin(LocalAttachmentStore, { dshHome: probe })
  try {
    await ctx2.attachments.validateImage({ data: broken, mediaType: 'image/png' })
  } catch (error) {
    const failure = error as Error & { code?: string }
    console.log(`  抛错：${failure.message}（code=${failure.code}）`)
  }
  console.log(`  存储根被建出来了吗：${existsSync(join(probe, 'attachments'))}   ← 校验只是看看，一个字节都不写`)

  console.log('\n--- ③ 一批图里有一张坏掉 ---')
  try {
    await ctx.attachments.saveImages([
      { data: bytes, mediaType: 'image/png', name: 'good.png' },
      { data: broken, mediaType: 'image/png', name: 'bad.png' },
    ])
  } catch (error) {
    const failure = error as Error & { code?: string }
    console.log(`  抛错：${failure.message}（code=${failure.code}）`)
  }
  console.log(`  存储根里已落盘的对象数：${objectCount(home)}   ← 先全量校验、再按序提交；坏在校验阶段就一个都不落`)

  console.log('\n--- ④ 收紧限制，不影响旧历史 ---')
  const good = await ctx.attachments.saveImage({ data: bytes, mediaType: 'image/png' })
  const strict = new Context()
  await strict.plugin(LocalAttachmentStore, { dshHome: home, maxImageBytes: 1 })
  try {
    await strict.attachments.saveImage({ data: bytes, mediaType: 'image/png' })
  } catch (error) {
    const failure = error as Error & { code?: string }
    console.log(`  新限制下再存同一张：${failure.message}（code=${failure.code}）`)
  }
  const back = await strict.attachments.readImage(good)
  console.log(`  但读回收紧之前那张：${back.data.length} 字节，没问题   ← 准入只在写入时生效`)
}

main()
