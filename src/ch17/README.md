# 第 17 章｜编排机制：模型驱动 Workflow 与固定策略 Ralph

## 文件说明

| 文件                      | 说明                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `workflow-demo.ts`        | Workflow 那条路：父模型现场写脚本 → workflow 工具 → 编排引擎派子 agent，并打印子 agent 的会话过程       |
| `ralph-demo.ts`           | Ralph 那条路：模型只传目标 → ralph 工具跑写死的循环，每轮一个全新子 agent，靠共享工作区 + 交接跨轮接力   |
| `shared-print-events.ts`  | workflow / ralph 两个演示共用：把会话日志里的事件翻译成人话                                            |

## 依赖

本章新增这些包（已加入项目 `package.json`）：

- `@deepseek-ai/dsh-workflow` —— 编排引擎 seam，挂成 `ctx.workflowEngine`（间接依赖：引擎实现内部使用，代码没直接 import）
- `@deepseek-ai/dsh-workflow-worker-thread` —— 编排引擎实现（脚本跑在 worker 线程的受限 vm 里）
- `@deepseek-ai/dsh-tool-workflow` —— 面向模型的 `workflow` 工具（模型现场写脚本）
- `@deepseek-ai/dsh-tool-ralph` —— 面向模型的 `ralph` 工具（循环脚本写死在工具里）
- `bash` 工具链 —— 子 agent 真去数文件/写工作区靠它：`@deepseek-ai/dsh-subprocess`（间接依赖）+ `@deepseek-ai/dsh-subprocess-local` + `@deepseek-ai/dsh-shell`（间接依赖）+ `@deepseek-ai/dsh-bash-local` + `@deepseek-ai/dsh-shell-env` + `@deepseek-ai/dsh-tool-bash`
- `@deepseek-ai/dsh-llm-deepseek` —— 真模型适配器，连同 peer 依赖 `@deepseek-ai/dsh-credentials`、`@deepseek-ai/dsh-anonymous-user-id`、`@deepseek-ai/dsh-launch-environment`

另有 peer 依赖 `@deepseek-ai/dsh-subagent`、`@deepseek-ai/dsh-subagent-spawn-in-process`（第 16 章已装），`--legacy-peer-deps` 安装时需显式写进 `package.json`。

安装：

```bash
npm install --legacy-peer-deps
```

## 运行示例

本讲示例要**联网调真实模型**，先导出 API Key：

```bash
export DEEPSEEK_API_KEY=sk-xxx
```

在**项目根目录**运行：

```bash
npm run start:ch17:workflow  # Workflow：父模型现场写脚本派子 agent
npm run start:ch17:ralph     # Ralph：模型传目标，写死的循环每轮一个全新子 agent
```

## 预期输出

两个示例都用真实模型，**模型输出每次不同**，所以下面是"示例输出"（一次运行的样子），不是固定结果：

### `npm run start:ch17:workflow`

```
--- Workflow：模型现写脚本，引擎真派子 agent ---
  模型：deepseek-official / deepseek-v4-flash
  工作区：/var/folders/.../ch17-workspace-xxxx
  会话日志：/var/folders/.../ch17-sessions-xxxx

--- 给父模型的提示词 ---
  请用 workflow 工具写一段脚本：派两个子 agent，一个统计 src 目录、一个统计 docs 目录各有多少个文件，最后把两个结果汇总返回。

--- 父模型现场写的脚本（workflow 工具收到的 script）---
  <模型写的脚本，每次可能不同>

--- 子 agent 内部：每一步都留在它自己的会话里 ---
  子 agent #1（会话 xxx）
    第 1 步：等模型回话
      调工具 ...
     ...

--- 编排结果（脚本 return 的值）---
  <脚本 return 的 JSON>
```

### `npm run start:ch17:ralph`

```
--- Ralph：模型只传目标，循环脚本写死在工具里 ---
  模型：deepseek-official / deepseek-v4-flash
  共享工作区：/var/folders/.../ch17-ralph-workspace-xxxx
  会话日志：/var/folders/.../ch17-ralph-sessions-xxxx

--- 模型传了什么（ralph 工具收到的参数）---
  {"objective":"...","maxRounds":2}

--- 每一轮：开一个全新子 agent，它内部发生了什么 ---
  第 1 轮的子 agent（会话 xxx）
    ...

--- 收手：ralph 工具返回的终态 ---
  Ralph worker reported completion after 1 round.
  ...

--- 共享工作区里留下了什么（每轮写的都是同一份）---
  <子 agent 写进工作区的内容>
```

要点：

- **换脚本，行为就变**：Workflow 的编排逻辑全在模型写的脚本里，引擎一行不改；
- **每轮一个全新子 agent**：Ralph 每轮开一个全新的（会话 id 不同），谁也不继承谁；
- **跨轮只靠两样**：共享工作区（文件）存产物、交接（报告）传"干到哪了、下一步干啥"。
