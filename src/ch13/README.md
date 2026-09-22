# 第 13 章｜装配与驱动：Agent 与 AgentLoop

## 文件说明

| 文件                 | 说明                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------- |
| `agent-loop-demo.ts` | 装配六个包、创建 agent、跑两轮，把每一步留在会话日志里的事件按 seq 打出来，最后拆掉循环 |
| `echo-tool.ts`       | 一个最小的工具 `echo`：把参数原样吐回来，用来观察循环怎么分发工具调用                   |

## 依赖

本章用到这些包（已加入项目 `package.json`）：

- `@deepseek-ai/dsh-agent-loop` —— 循环驱动：本讲的主角，也是 dsh 里唯一含循环逻辑的包
- `@deepseek-ai/dsh-settings` —— `dsh-agent-loop` 的 **peer 依赖**
- `@deepseek-ai/dsh-agent` —— `Agent` 接口、注册表与 `agent/*` 事件词汇（不含循环逻辑）
- `@deepseek-ai/dsh-llm` / `dsh-session` / `dsh-system-prompt` / `dsh-tools` —— 循环依赖的其余四个服务

> 因为本项目用 `--legacy-peer-deps` 安装，peer 依赖不会自动装上，`@deepseek-ai/dsh-settings` 必须显式写进 `package.json`，否则运行时会报 `ERR_MODULE_NOT_FOUND`。

安装：

```bash
npm install --legacy-peer-deps
```

## 运行示例

在**项目根目录**运行：

```bash
npm run start:ch13
```

示例不需要任何 API Key：模型是一个按脚本回答的假适配器（`ScriptedAdapter`）——**第 1 次被调用时请求 `echo` 工具，之后一律直接给文字答案**，且它不读输入内容，只按调用次数回答。所以第 2 轮的"再说一遍"拿到的仍是脚本里那句"没有别的新东西，还是「你好」"，这是预期行为。

## 预期输出

### `npm run start:ch13`

```
--- 装配：一轮要流的几个包 ---
  llm → sessions → system-prompt → tools → agents → agent-loop
  循环声明它依赖哪些服务（AgentLoop.inject）：agents, sessions, llm, tools, systemPrompt
  一次最多并行几个工具调用：10

--- 第 1 轮：模型先要工具，再给答案 ---
  seq 0  agent/inbox/spliced
  seq 1  turn/start
  seq 2  agent/inbox/spliced
  seq 3  step/start
  seq 4  user/message
  seq 5  request/header
  seq 6  request/context
  seq 7  assistant/chunk
  seq 8  assistant/chunk
  seq 9  assistant/chunk
  seq 10  assistant/chunk
  seq 11  assistant/message
  seq 12  tool/call
  seq 13  tool/result
  seq 14  step/end
  seq 15  step/start
  seq 16  assistant/chunk
  seq 17  assistant/chunk
  seq 18  assistant/chunk
  seq 19  assistant/chunk
  seq 20  assistant/message
  seq 21  step/end
  seq 22  turn/end
  agent/status 变化：running → idle

--- 第 1 轮结束时的 surface（模型下一轮能看到的消息）---
  [user] 帮我把「你好」回显一遍
  [assistant] [tool-call]
  [user] [tool-result]
  [assistant] 回显出来了：「你好」

--- 第 2 轮：同一个 agent 再来一次 ---
  seq 23  agent/inbox/spliced
  seq 24  turn/start
  seq 25  agent/inbox/spliced
  seq 26  step/start
  seq 27  user/message
  seq 28  assistant/chunk
  seq 29  assistant/chunk
  seq 30  assistant/chunk
  seq 31  assistant/chunk
  seq 32  assistant/message
  seq 33  step/end
  seq 34  turn/end
  agent/status 变化：running → idle
  surface 消息数：4 → 6

--- 注册表：agent 不止一条，得知道自己在问谁 ---
  ctx.agents.list()：1 个 agent
  ctx.agents.roots()：1 个（没有父级的那些）
  ctx.agents.get('sess-loop') 就是它本人：true

--- 两轮之后，日志一共这么多条 ---
  事件数：35（第 1 轮前 0 条）

--- 收尾：只拆循环这一个 fiber，看 agent 怎么退场 ---
  生命周期事件：created(sess-loop) → session-start(source=startup) → disposed(sess-loop)
  ctx.agents.list()：1 → 0
```

要点：

- **第 1 轮有两个 step**：先请求 `echo` 工具（step 1），拿到结果后再答一次（step 2）；第 2 轮模型直接给答案，只有一个 step。两轮的事件形状几乎一样，差别只在起点（又一条 `followup`）与长度（多出一个 step）。
- **`agent/inbox/spliced` 成对出现**：一次是提示词**入队**（seq 0），一次是循环把它**取走**（seq 2）——取出发生在 `turn/start` 之后。
- **`agent/status` 每轮翻转一次**：`running → idle`，两轮各一次。
- **收尾只拆循环那一个 fiber**：随之发出 `agent/disposed`，agent 从注册表摘掉（`list()` 从 1 变 0）。注意生命周期事件里没有配对的 `session-end`——收尾就发 `disposed`。
