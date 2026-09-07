// src/ch04/plugins/logger.ts —— 一个普通叶子插件
import { Context } from '@deepseek-ai/cordis'

export const name = 'logger'

export function apply(ctx: Context, config: { level: string }) {
  console.log(`[logger] 启动（level=${config.level}）`)
}
