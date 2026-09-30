# 第 16 章｜委派任务：Subagent 的创建、协作与回收

## 文件说明

| 文件               | 说明                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `subagent-demo.ts` | 父 agent 用 spawn 委派一个子 agent 去"数文件"，看子会话、委派深度、结果与回收 |

## 依赖

本章新增这些包（已加入项目 `package.json`）：

- `@deepseek-ai/dsh-subagent` —— 委派 seam，挂成 `ctx.subagents`
- `@deepseek-ai/dsh-subagent-spawn-in-process` —— spawn 提供方（本示例用的进程内后端）
- `@deepseek-ai/dsh-subagent-in-process-driver` —— 进程内一次性 run 的共享驱动器
- `@deepseek-ai/dsh-tool-subagent` —— 面向模型的 `subagent` 工具（本示例不经过它，直接调 `ctx.subagents.start`）

另有 peer 依赖 `@deepseek-ai/dsh-jobs`、`@deepseek-ai/dsh-session-projection-cache`（本讲不展开），`--legacy-peer-deps` 安装时需显式写进 `package.json`。

安装：

```bash
npm install --legacy-peer-deps
```

## 运行示例

在**项目根目录**运行：

```bash
npm run start:ch16
```

示例用一个按脚本回答的假模型，**不联网、不需要 API Key**。

## 预期输出

### `npm run start:ch16`

```
--- 委派：父 agent 把活交给子 agent ---
  父会话：sess-parent
  子会话是新会话：true（spawn 看不到父的历史）
  子 agent 的委派深度：1

--- 子 agent 的结果 ---
  stopReason: completed
  output: 仓库里一共 42 个文件。

--- 回收 ---
  子 agent 已 dispose（回收完成）
```

要点：

- **spawn 空历史起步**：子会话是新会话（`true`），看不到父的对话；
- **委派深度 1**：父是 0，子 agent 记 `delegationDepth = 1`，套娃时逐层 +1；
- **`start()` 先发布、`result` 才结算**：`stopReason: completed`、`output` 是子 agent 的最终文本；
- **`dispose()` 收尾**：回收完成。
