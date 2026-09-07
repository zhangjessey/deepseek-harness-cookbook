// src/ch04/main.ts —— 让 cordis.yml 长成一棵插件树
// 三步就位：建根 → 挂 Loader（在 ctx 上建一棵空的配置树）→
// 把 include 插件作为配置树的第一根枝条挂上去（它的 config 指向 cordis.yml）
import { Context } from '@deepseek-ai/cordis'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Loader from '@deepseek-ai/cordis-plugin-loader'

const baseUrl = pathToFileURL(fileURLToPath(new URL('.', import.meta.url))).href

const ctx = new Context() // ① 造出根
ctx.baseUrl = baseUrl //   告诉它相对路径从哪找

// ② 挂上 Loader：在 ctx 上建一棵空的配置树
await ctx.plugin(Loader, { baseUrl })

// ③ 把 include 插件本身当成配置树的第一根枝条挂上去：
//    它的 config 指向 cordis.yml——include 读文件、解析成条目列表、
//    再把这整棵配置树挂载成运行时插件树
try {
  await ctx.loader.create({
    name: '@deepseek-ai/cordis-plugin-include',
    config: { path: './cordis.yml' },
  })
} catch (error) {
  console.error('[main] 配置树挂载失败：', error)
  process.exit(1)
}

// 等所有条目挂完再退出
await new Promise((resolve) => setTimeout(resolve, 300))
