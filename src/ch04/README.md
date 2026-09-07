# 第 04 章｜插件树：声明式配置、isolate 与 HMR

## 文件说明

| 文件                            | 说明                                               |
| ------------------------------- | -------------------------------------------------- |
| `isolate-demo.ts`               | isolate：同一个服务在不同作用域解析到不同实例      |
| `main.ts`                       | 让 `cordis.yml` 长成一棵插件树（Loader + include） |
| `hmr-main.ts`                   | 热更新版入口：改配置或插件文件即时生效             |
| `cordis.yml` / `cordis-hmr.yml` | 声明式配置树（顶层 YAML 数组，每个元素是一个节点） |
| `plugins/logger.ts`             | 叶子插件：日志                                     |
| `plugins/shell.ts`              | 叶子插件：shell 服务（可被 intercept 改写配置）    |
| `plugins/chat.ts`               | 叶子插件：消费 shell                               |

## 运行示例

确保已经执行过 `npm install --legacy-peer-deps`，然后在**项目根目录**运行：

```bash
# isolate：同一服务，三个作用域三种解析结果
npm run start:ch04

# 声明式配置树：读 cordis.yml 长出运行时插件树
npm run start:ch04:tree

# 热更新（需要 --expose-internals，故不封装成 npm script）
npx node@24 --expose-internals --import tsx src/ch04/hmr-main.ts
```

## 预期输出

### `npm run start:ch04`

```text
=== 根上下文：提供默认 llm（deepseek） ===

=== 创建两个隔离的作用域，各自提供不同的 llm ===

=== 作用域 A：提供自己的 llm（mock），挂载 chat 插件 ===
[chat] 我看到的 llm 是：【mock】关于「你好」，这是我的回答（占位实现）

=== 作用域 B：提供自己的 llm（gpt），挂载 chat 插件 ===
[chat] 我看到的 llm 是：【gpt】关于「你好」，这是我的回答（占位实现）

=== 根上下文：挂载 chat 插件（看到的是根级的 deepseek） ===
[chat] 我看到的 llm 是：【deepseek】关于「你好」，这是我的回答（占位实现）

=== 收尾 ===
demo 已退出
```

同一个 `chat` 插件，挂在三个作用域里看到三个不同的 llm——`isolate('llm')` 切断了
向上穿透，让每个作用域用自己的实例。

### `npm run start:ch04:tree`

```text
[logger] 启动（level=info）
  [shell] 实例就绪：provider=deepseek, model=deepseek-chat
  [shell] 实例就绪：provider=mock, model=mock-chat
  [shell] 实例就绪：provider=b-provider, model=b-model
[chat] 收到：[mock/mock-chat] 回复：你好
[chat] 收到：[b-provider/b-model] 回复：你好（我看到 shell 配置：{"model":"intercept-model"}）
```

三个 shell 实例彼此独立：租户 A 的 chat 拿到本组的 `mock`，租户 B 的 chat 拿到
`b-provider`，但被 `intercept` 把 `model` 改写成了 `intercept-model`。

> 两个 chat 的先后顺序因异步竞争每次可能不同（谁先挂载谁先打印），不影响结论。

### npx node@24 --expose-internals --import tsx src/ch04/hmr-main.ts

这条是 HMR 版入口（要 `--expose-internals` 才能跑，所以没封成 npm script）。
前面 6 行跟 `start:ch04:tree` 一模一样——因为 `cordis-hmr.yml` 用嵌套 include 复用了 `cordis.yml`，
业务部分一行没重复。区别只在末尾多两行，且进程不退出：

```text
[logger] 启动（level=info）
  [shell] 实例就绪：provider=deepseek, model=deepseek-chat
  [shell] 实例就绪：provider=mock, model=mock-chat
  [shell] 实例就绪：provider=b-provider, model=b-model
[chat] 收到：[mock/mock-chat] 回复：你好
[chat] 收到：[b-provider/b-model] 回复：你好（我看到 shell 配置：{"model":"intercept-model"}）
HMR 已就绪，试着改改 src/ch04/cordis.yml 或插件文件，看输出变化
（按 Ctrl+C 退出）
```

起来之后进程不会退出（`setInterval` 保活）。这时去改 `cordis-hmr.yml` 或 `plugins/` 下任一文件，
树会按改动重新挂载，不用重启进程。
