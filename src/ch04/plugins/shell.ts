// src/ch04/plugins/shell.ts —— shell 服务的提供方
// 它是个 Service 类插件：new 出来即注册为 ctx.shell，config 是插件配置
import { Context, Service } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    shell: ShellService
  }
}

export interface ShellConfig {
  provider: string
  model: string
}

class ShellService extends Service {
  constructor(
    ctx: Context,
    public config: ShellConfig,
  ) {
    super(ctx, 'shell')
    console.log(`  [shell] 实例就绪：provider=${this.config.provider}, model=${this.config.model}`)
  }

  chat(message: string) {
    return `[${this.config.provider}/${this.config.model}] 回复：${message}`
  }
}

export const name = 'shell'

export function apply(ctx: Context, config: ShellConfig) {
  // Service 构造时会自动把自己注册为 ctx.shell
  new ShellService(ctx, config)
}
