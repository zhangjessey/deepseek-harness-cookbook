# 第 06 章｜工具流水线：Code Mode、守卫与执行边界

## 文件说明

| 文件                | 说明                                                      |
| ------------------- | --------------------------------------------------------- |
| `pipeline-demo.ts`  | 把「流水线 8 站」跑一遍：守卫、pre/post 改写、环绕计时    |
| `code-mode-demo.ts` | Code Mode：native / code 两种模式对比、生成的 SDK、子调用 |

`pipeline-demo.ts` 直接复用第 05 章的 `../ch05/greet-tool.ts`，所以请先确认第 05 章的代码存在；`code-mode-demo.ts` 不依赖它，自带 `add` / `env_probe` 两个工具。

## 运行示例

确保已经执行过 `npm install --legacy-peer-deps`，然后在**项目根目录**运行：

```bash
# 跑一遍流水线（守卫、pre/post、环绕）
npm run start:ch06

# 跑 Code Mode（两种模式对比 + SDK + 子调用）
npm run start:ch06:code
```

## 预期输出

### `npm run start:ch06`

演示顺序顺着流水线方向：pre-execute（① 站）→ 守卫（② 站）→ execute 环绕（③ 站）→ post-execute（⑥ 站）：

```text
--- 基线：什么关卡都没有 ---
{ isError: false, content: [ { type: 'text', text: 'Hello, World!' } ], value: 'Hello, World!' }

--- pre-execute 决定 ask（本进程没有审批服务）---
{ isError: true, error: { message: '危险操作，需要人工确认' }, content: [ ... ] }

--- pre-execute 决定 deny ---
{ isError: true, error: { message: '该工具已对当前会话下线' }, content: [ ... ] }

--- 挂一个守卫，拒绝问候 "World" ---
{ isError: true, error: { message: '不允许问候 "World"' }, content: [ ... ] }

--- 再挂一个"想放行"的守卫（验证单调性）---
{ isError: true, error: { message: '不允许问候 "World"' }, content: [ ... ] }   ← 照样被拒

--- tools/execute 环绕：给每次调用计时 ---
  [环绕] greet 耗时 0ms，isError=false
{ isError: false, content: [ { type: 'text', text: 'Hello, World!' } ], value: 'Hello, World!' }

--- post-execute 放行但改写呈现（注意：只改呈现，值没动）---
{ isError: false, content: [ { type: 'text', text: '[已折叠]' } ], value: 'Hello, World!' }

--- post-execute 改写值（呈现会被 render 重算）---
{ isError: false, content: [ { type: 'text', text: 'REPLACED' } ], value: 'REPLACED' }

--- post-execute 把成功结果改判为失败 ---
{ isError: true, error: { message: '结果含受限称呼 "World"，已拦截' }, content: [ ... ] }
```

三处值得对照着看：

- **守卫那两段**：后挂的守卫对一切「弃权」，结果**照样被拒**——这就是单调性：弃权 ≠ 允许。
- **「放行但改写呈现」与「改写值」**：一对镜像。前者只换 `content`，`value` 原地不动；后者换了 `value`，`content` 被 `render` 重算了一遍。
- **「环绕」里的 `0ms`** 是本机耗时，你的机器上多半是别的数字，不必纠结。

### `npm run start:ch06:code`

```text
--- native 模式：模型看见的工具 ---
["add","env_probe"]

--- code 模式：模型看见的工具 ---
["run_code"]
```

接着会打印提示词里生成的 SDK（照录真实输出）：

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

interface ToolArgsMap {
  /** Add two numbers. */
  add: {
    /** First addend */
    a: number
    /** Second addend */
    b: number
  } & Record<string, JsonValue>
  /** Report the runtime environment. */
  env_probe: Record<string, JsonValue>
}

interface ToolOutputMap {
  add: number
  env_probe: {
    platform?: string
    node?: string
  }
}

type ToolName = keyof ToolOutputMap

declare class ToolCallError extends Error {
  readonly name: 'ToolCallError'
  readonly toolName: ToolName
}

declare const tools: {
  [K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]>
}
```

然后是"让模型写一段程序，一次跑完"：一次 `run_code` 里调两个工具：

```text
{ "isError": false,
  "content": [ { "type": "text", "text": "platform = darwin\n{\n  \"sum\": 3,\n  \"platform\": \"darwin\"\n}" } ],
  "value": { "logs": ["platform = darwin"],
             "result": { "sum": 3, "platform": "darwin" } } }
```

再后面是「模型绕不过去」：

```text
--- 模型绕过 run_code，直接点名调 env_probe ---
{ "isError": true,
  "error": { "message": "unknown tool \"env_probe\": only `run_code` is callable directly — ...",
             "info": { "name": "ToolNotFoundError", "code": "UNKNOWN_TOOL" } },
  "content": [ ... ] }
```

最后是「守卫管得住程序里的子调用」：

```text
--- 守卫能否管住程序里的子调用 ---
{ "isError": false,
  "value": { "logs": [], "result": { "probe": "caught: env_probe 已被禁用", "sum": 7 } } }
```

> `platform` 会随操作系统变化（macOS 是 `darwin`，Linux 是 `linux`），`node` 随 Node.js 版本变化，这是正常的。
>
> 另外注意 SDK 里 `platform?` / `node?` 带着 `?`：因为 `output.schema` 只写了 `properties`、没写 `required`。SDK 是对 schema 的忠实翻译，连偷懒一起翻译过去。
