# 第 15 章｜自动续跑：用 Goal 驱动长任务

## 文件说明

| 文件           | 说明                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------- |
| `goal-demo.ts` | 用脚本假模型跑一遍：定义目标 → 驱动器在 idle 时自动续跑 → 模型把目标标成完成 → 看日志怎么记 |

## 依赖

本章新增这些包（已加入项目 `package.json`）：

- `@deepseek-ai/dsh-goal` —— 目标状态服务，挂成 `ctx.goals`
- `@deepseek-ai/dsh-tool-goal` —— 面向模型的 `get_goal` / `create_goal` / `update_goal` 三个工具
- `@deepseek-ai/dsh-goal-round-driver` —— 同会话续行驱动器，每次 idle 检查目标、自动排下一轮
- `@deepseek-ai/dsh-typert-protocol` —— peer 依赖（本讲不展开）

> 因为本项目用 `--legacy-peer-deps` 安装，peer 依赖不会自动装上，`@deepseek-ai/dsh-typert-protocol` 必须显式写进 `package.json`，否则运行时会报 `ERR_MODULE_NOT_FOUND`。

安装：

```bash
npm install --legacy-peer-deps
```

## 运行示例

在**项目根目录**运行：

```bash
npm run start:ch15
```

示例用一个按脚本回答的假模型，**不联网、不需要 API Key**。

## 预期输出

### `npm run start:ch15`

```
--- 定义一个目标 ---
  objective: 把文档里的错别字全部改完
  phase: active，activation: armed，roundsStarted: 0 / 5

--- 驱动器在 idle 时自动排下一轮 ---
  第 1 次回到 idle：phase=active，roundsStarted=0
  第 2 次回到 idle：phase=active，roundsStarted=1
  第 3 次回到 idle：phase=complete，roundsStarted=2

--- 会话日志里的 goal 与轮次事件 ---
  seq 0  goal/change（create）
  seq 2  turn/start
  seq 5  user/message（goal，round 1）
  seq 14  turn/end
  seq 16  turn/start
  seq 19  user/message（goal，round 2）
  seq 26  goal/change（complete）
  seq 39  turn/end

--- 最终状态 ---
  phase: complete，roundsStarted: 2 / 5
```

要点：

- **第 1 次 idle**：目标刚建好、第一轮还没开始（0 / 5）；
- **第 2 次 idle**：第 1 轮干完、驱动器自动排了第 2 轮（1 / 5）；
- **第 3 次 idle**：第 2 轮把目标标成 complete，驱动器随即停手（2 / 5）。
- 日志里 `goal/change` 只在**变更**时出现（create 与 complete 各一条），两个 `turn/start`/`turn/end` 之间就是被自动续出来的那一轮。
- 中间那两条 `user/message`（seq 5、19）是驱动器排进来的续跑消息，`source.kind` 是 `goal` 而不是 `user`。
