# 第 09 章｜会话续接：Fork、Resume 与崩溃修复

## 文件说明

| 文件                   | 说明                                                       |
| ---------------------- | ---------------------------------------------------------- |
| `fork-demo.ts`         | 从父会话分叉：默认 fork、指定 boundary、非法 boundary 被拒 |
| `crash-resume-demo.ts` | 崩溃与恢复：写一半崩了，新进程 load 回来接着干             |

## 依赖

本章用到两个新包（已加入项目 `package.json`）：

- `@deepseek-ai/dsh-session-persistence` —— 持久化 seam 的抽象定义（`ctx.sessionPersistence`）
- `@deepseek-ai/dsh-session-persistence-jsonl` —— JSONL 后端实现

安装：

```bash
npm install --legacy-peer-deps
```

## 运行示例

确保已经执行过 `npm install --legacy-peer-deps`，然后在**项目根目录**运行：

```bash
# fork：把一份历史分叉出去
npm run start:ch09:fork

# 崩溃与恢复
npm run start:ch09:crash
```

`crash-resume-demo.ts` 会在系统临时目录下建一个随机存储根目录（每次运行都不同），跑完不清理，方便你去看落盘的文件长什么样。

## 预期输出

### `npm run start:ch09:fork`

```text
--- ① 父会话：两轮对话，8 条事件 ---
  seq 0  turn/start
  seq 1  step/start
  seq 2  user/message
  seq 3  step/end
  seq 4  turn/end
  seq 5  turn/start
  seq 6  user/message
  seq 7  turn/end

--- ② fork 一份出去（不指定 boundary）---
  子会话 9 条，seedLength = 8，parent = parent
  最后一条：seq 8  session/end-seed   ← 种子边界
  消息历史 2 条（全是继承来的）

--- ③ 只要第一轮（boundary = 4）---
  子会话 6 条，seedLength = 5
  消息历史 1 条

--- ④ boundary 落在开放轮次内（seq 2 正卡在第一轮中间）---
  被拒：fork boundary 2 in session "parent" ends inside open turn 1
```

四段各看一件事：

- **①** 父会话是完整闭合的两轮，8 条事件。
- **②** 默认 fork 到最后一个事件：子会话 9 条 = 继承 8 条 + 一条 `session/end-seed` 边界；`seedLength` 记着继承了多少。
- **③** 指定 `boundary = 4`，只带走第一轮：6 条，`seedLength = 5`。
- **④** `boundary` 落在还没闭合的轮次里，直接被拒——不会静默截断。

### `npm run start:ch09:crash`

```text
--- ① 场景一：问到一半崩了（磁盘 3 条，turn 没闭合）---

--- ② 新进程 load 场景一：5 条 ---
  seq 0  turn/start
  seq 1  step/start
  seq 2  user/message
  seq 3  step/end
  seq 4  turn/end  {"turn":1,"reason":{"kind":"interrupted"}}

--- ③ 场景二：工具调用已发出，崩了（磁盘 5 条）---

--- ④ 新进程 load 场景二：8 条 ---
  seq 0  turn/start
  seq 1  step/start
  seq 2  user/message
  seq 3  assistant/message
  seq 4  tool/call
  seq 5  tool/result  error.code = TOOL_OUTCOME_UNKNOWN
      「The tool call was interrupted after it was rec…」
  seq 6  step/end
  seq 7  turn/end  {"turn":1,"reason":{"kind":"interrupted"}}

--- ⑤ 续接：seedLength = 8，事件 12 条 ---
  消息历史 4 条：
    user | 查一下天气
    assistant | <tool-call>
    user | <tool-result>
    user | 那算了，换个问题
```

五段看两件事。

先看**配平**：

- **①** 写了 3 条就崩了，`turn/start` 没有配对的 `turn/end`。
- **②** 全新进程 `load`：不是 3 条而是 **5 条**——后端补了一条 `step/end` 和一条 `turn/end`，后者的结束原因是 `interrupted`。**它没有截断日志**，而是把没闭合的轮次配平。
- **③④** 更棘手的情形：模型要求了一次工具调用，`tool/call` 已写进日志，工具没回来就崩了。这时除了补 `step/end` / `turn/end`，还多补了一条 `tool/result`，`error.code` 是 `TOOL_OUTCOME_UNKNOWN`——**它不编造结果**，而是明确告诉模型"结果未知，可能有副作用的操作先核实再重试"。

再看**续接**：

- **⑤** 拿场景二这 8 条当种子造一个新会话，再追加一轮。事件 12 条 = 继承 8 条 + 一条 `session/end-seed` + 新写 3 条；消息历史 4 条，模型能看见"上一次调用没拿到结果"这个事实。
