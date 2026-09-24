# 第 14 章｜工具与人设：Agent Preset 预组装

## 文件说明

| 文件             | 说明                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `preset-demo.ts` | 在临时目录里现写两份 preset（`coder` / `writer`），用它们各组装一个 agent，打印各自看得到的工具与人设，最后演示 `copy()` |
| `tool.js`        | preset 里"工具行"引用的本地插件文件：注册一个名字来自 `config.tool` 的工具                                               |

`tool.js` 由 Loader 用 Node 的 ESM 解析器导入，所以它必须是**纯 ESM、不能含 TS 语法**——这也是它单独成一个 `.js` 文件的原因。

## 依赖

本章新增这些包（已加入项目 `package.json`）：

- `@deepseek-ai/dsh-agent-presets` —— preset 的发现与挂载（roster，挂成 `ctx.agentPresets` 服务）
- `@deepseek-ai/dsh-persona` —— 把"人设"做成一个可组装的插件行
- `@deepseek-ai/dsh-atomic-write` —— `dsh-agent-presets` 的 **peer 依赖**

另外用到前面几讲已装好的包：`dsh-llm` / `dsh-session` / `dsh-system-prompt` / `dsh-tools` / `dsh-agent` / `dsh-agent-loop`，以及 cordis 的 `cordis-plugin-loader` 与 `cordis-plugin-include`（preset 的挂载靠 Loader）。

> 因为本项目用 `--legacy-peer-deps` 安装，peer 依赖不会自动装上，`@deepseek-ai/dsh-atomic-write` 必须显式写进 `package.json`，否则运行时会报 `ERR_MODULE_NOT_FOUND`。

安装：

```bash
npm install --legacy-peer-deps
```

## 运行示例

在**项目根目录**运行：

```bash
npm run start:ch14
```

示例会在**系统临时目录**里现写两份 preset（目录名前缀 `dsh-preset-demo-`），跑完不清理，方便你去看一个 preset 到底长什么样（一个目录 + 一份 `agent.cordis.yml`）。代价是每跑一次留下一个目录，反复跑会累积——不需要时直接删掉 `dsh-preset-demo-*` 即可。示例不跑对话、不联网、不需要 API Key。

## 关于示例里的 `ctx.baseUrl`

装配时有这么一句，容易一眼带过：

```ts
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'
```

它却是本示例能跑起来的前提。preset 里 `@deepseek-ai/dsh-persona` 这种**裸包名**是从宿主的 `baseUrl` 解析的，不是从 preset 自己的目录；而本示例的 preset 写在系统临时目录下，Node 向上找 `node_modules` 永远够不到 dsh——没有这一句，每个人设行都会 import 失败。

## 预期输出

### `npm run start:ch14`

```
--- roster 发现了哪些 preset ---
  coder
  writer

--- 用不同 preset 各挂载一个 agent ---
  sess-coder: 工具 [run_command]，人设 "你是个严谨的程序员，写代码一丝不苟。"
  sess-writer: 工具 [write_poem]，人设 "你是个文艺的作家，出口成章。"

--- 宿主 ctx（没挂任何 preset）---
  host: 工具 [无]，人设 "部署默认人设"

--- 再来一个也用 coder 的 agent ---
  sess-coder-2: 工具 [run_command]，人设 "你是个严谨的程序员，写代码一丝不苟。"
  两个 coder 会话看到同一套工具：true

--- 创作 = 复制：copy() 出一个新的 ---
  coder
  coder2
  writer
```

要点：

- **preset 的 id 就是目录名**：roster 从配置的根目录发现它们，所以这里只列出 `coder` 和 `writer`。
- **同一份 dsh，两个会话脾气不同**：`sess-coder` 看到 `run_command` + 程序员人设，`sess-writer` 看到 `write_poem` + 作家人设——差异来自各自 preset 里的"人设行"和"工具行"。
- **宿主 ctx 一个都看不到**：它没加入任何 preset，工具为空，人设退回部署默认（本例配的是"部署默认人设"）。
- **两个 coder 会话共享同一份实例**：常驻挂载只挂一次，后来者通过 scope 认父加入，所以"看到同一套工具：true"。
- **创作即复制**：`copy('coder', 'coder2', '程序员二号')` 之后，名单变成 `coder` / `coder2` / `writer`。

## 关于工具名

`dsh-tools` 保留了少数工具名供 Code Mode 的呈现传输层使用（例如 `run_code`）。把 `config.tool` 改成这些保留名，注册会失败并连带**整次 agent 创建回滚**。

注意本 demo **没有 `try/catch`**：这种失败会以未捕获异常的形式抛出并终止进程，错误信息在堆栈里的 `reason` / `[cause]` 字段（而不是一行干净的报错）。想亲手验证"创建回滚、agent 拿不到"，需要在调用 `on(...)` 的外层自己包一段 `try/catch`。
