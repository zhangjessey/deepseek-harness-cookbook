// src/ch04/hmr-main.ts —— 在 main.ts 基础上启用 HMR
// 与 main.ts 唯一的两处不同：
//   ① 加载的是 cordis-hmr.yml（timer/hmr 都在配置里声明，代码里一行不提）
//   ② 末尾进程常驻——HMR 要盯着文件，进程退出就没人监视了
import { Context } from '@deepseek-ai/cordis'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Loader from '@deepseek-ai/cordis-plugin-loader'

const baseUrl = pathToFileURL(fileURLToPath(new URL('.', import.meta.url))).href

const ctx = new Context()
ctx.baseUrl = baseUrl

// ① 挂上 loader 服务：它在 ctx 上建一棵空的「配置树」（EntryTree）
await ctx.plugin(Loader, { baseUrl })

// ② 把 include 插件本身当成配置树的第一根枝条挂上去，
//    它的 config 指向 cordis-hmr.yml —— include 会读文件、解析成条目列表、
//    然后把这整棵配置树挂载成运行时插件树
try {
  await ctx.loader.create({
    name: '@deepseek-ai/cordis-plugin-include',
    config: { path: './cordis-hmr.yml' },
  })
} catch (error) {
  console.error('[main] 配置树挂载失败：', error)
  process.exit(1)
}

// ③ 进程常驻：让 HMR 有机会工作
//    这一行留在代码里是合理的——它属于「进程/宿主」层面，不属于应用装配
setInterval(() => {}, 1000)

console.log('HMR 已就绪，试着改改 src/ch04/cordis.yml 或插件文件，看输出变化')
console.log('（按 Ctrl+C 退出）')
