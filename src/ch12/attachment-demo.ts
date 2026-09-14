// src/ch12/attachment-demo.ts —— 上下文边界：图片附件的外部持久化
// 跑法：npm run start:ch12:attachment
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { mkdtempSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 一张 8x8 的合法 PNG（95 字节），直接内嵌，跑这个 demo 不需要额外素材。 */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMwTvuPFTEMLQkAqBFmAWlht3MAAAAASUVORK5CYII='
const bytes = new Uint8Array(Buffer.from(PNG_BASE64, 'base64'))

/** 列出 objects/ 下的全部对象（两级：桶目录 → 对象文件）。 */
function objects(root: string): string[] {
  return readdirSync(root).flatMap((bucket) => readdirSync(join(root, bucket)).map((name) => `${bucket}/${name}`))
}

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-ch12-attach-'))
  const ctx = new Context()
  await ctx.plugin(LocalAttachmentStore, { dshHome: home })

  console.log('--- ① 一张图存进去，拿到什么 ---')
  const ref = await ctx.attachments.saveImage({
    data: bytes,
    mediaType: 'image/png',
    name: '/Users/alice/secret/pixel.png', // 故意带上绝对路径
  })
  console.log(`  attachmentId：${ref.attachmentId}`)
  console.log(`  类型 / 尺寸 / 字节：${ref.mediaType}  ${ref.width}x${ref.height}  ${ref.bytes} 字节`)
  console.log(`  name：${ref.name}   ← 传进去的是 /Users/alice/secret/pixel.png，路径被剥掉了`)

  console.log('\n--- ② 字节落在哪 ---')
  const objectRoot = join(home, 'attachments', 'v1', 'objects')
  const bucket = readdirSync(objectRoot)[0]!
  const name = readdirSync(join(objectRoot, bucket))[0]!
  const objectPath = join(objectRoot, bucket, name)
  console.log(`  .../attachments/v1/objects/${bucket}/${name.slice(0, 8)}…${name.slice(-6)}`)
  console.log(
    `  文件权限 ${(statSync(objectPath).mode & 0o777).toString(8)}，目录权限 ${(statSync(join(objectRoot, bucket)).mode & 0o777).toString(8)}`,
  )
  console.log(`  落盘 ${statSync(objectPath).size} 字节，与 ref.bytes 一致：${statSync(objectPath).size === ref.bytes}`)

  console.log('\n--- ③ 同一张图再存一次 ---')
  const again = await ctx.attachments.saveImage({ data: bytes, mediaType: 'image/png' })
  console.log(`  attachmentId 相同：${again.attachmentId === ref.attachmentId}   ← 内容寻址，天然去重`)
  console.log(`  objects 下的对象数：${objects(objectRoot).length}`)

  console.log('\n--- ④ 日志里存的到底是什么 ---')
  const message = { type: 'user/message', content: [{ type: 'image', attachment: ref }] }
  const asText = JSON.stringify(message)
  console.log(`  ${asText}`)
  console.log(`  日志字符数 ${asText.length}，图片 ${ref.bytes} 字节   ← 字节一个都没进日志`)

  console.log('\n--- ⑤ 要发给模型时再取回来 ---')
  const stored = await ctx.attachments.readImage(ref)
  console.log(
    `  readImage：${stored.data.length} 字节，${stored.ref.mediaType}，${stored.ref.width}x${stored.ref.height}`,
  )
}

main()
