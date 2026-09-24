// 一行 preset 插件：注册一个名字来自 config 的工具。
// Loader 用 Node 的 ESM 解析器导入它，所以这里必须是纯 ESM、不能有 TS 语法。
export const name = 'demo-tool'

export const inject = ['tools']

export function apply(ctx, config) {
  ctx.effect(() =>
    ctx.tools.register({
      name: config.tool,
      description: config.description ?? `demo tool ${config.tool}`,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      execute: () => Promise.resolve(config.tool),
    }),
  )
}
