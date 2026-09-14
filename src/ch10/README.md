# 第 10 章｜上下文压缩：Compaction 与裁剪

## 文件说明

| 文件              | 说明                                                     |
| ----------------- | -------------------------------------------------------- |
| `compact-demo.ts` | 压缩：用假模型生成摘要，把旧历史压成一个 checkpoint 节点 |
| `prune-demo.ts`   | 裁剪：把超长的工具结果裁成"头 + 标记 + 尾"               |

## 依赖

本章用到几个新包（已加入项目 `package.json`）：

- `@deepseek-ai/dsh-compaction` / `dsh-compaction-basic` —— 压缩 seam 与后端
- `@deepseek-ai/dsh-compaction-tool-result-pruner` —— 工具结果裁剪
- `@deepseek-ai/dsh-token-meter` —— token 计量

安装：

```bash
npm install --legacy-peer-deps
```

## 运行示例

在**项目根目录**运行：

```bash
# 压缩
npm run start:ch10:compact

# 裁剪
npm run start:ch10:prune
```

`compact-demo.ts` 用一个假模型（`MockAdapter`）生成摘要，不发起任何真实 LLM 调用。

## 预期输出

### `npm run start:ch10:compact`

```
--- 压缩前 ---
  surface 消息数：8（4 轮，每轮一问一答）
  第 1 条（前 20 字）：第 1 轮的问题，内容比较长。第 1 轮…
--- 压缩后 ---
  被遮蔽的事件 seq：1, 4, 8, 10, 14, 16, 20
  估算遮蔽 token 数：362
  surface 消息数：8 → 2
  第 1 条（替换进去的 checkpoint 节点）全文：
    This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. ...
    <compacted-summary>前面几轮在讨论：日志怎么落盘、会话怎么续接、崩溃怎么修复。</compacted-summary>
  第 2 条（保留的最近尾部）：第 4 轮的回答，同样不短。第 4 轮的…
--- 压缩新落的几条事件 ---
  seq 25  compaction/start
  seq 26  compaction/summary
  seq 27  user/message
  seq 28  compaction/end
```

要点：

- 4 轮对话的 8 条消息，压缩成 1 条 checkpoint + 1 条保留的最近尾部。
- checkpoint 节点 = 固定英文框架 + `<compacted-summary>` 包住的模型摘要。
- 三个 `compaction/*` 事件落在日志里，锁住整个过程。

### `npm run start:ch10:prune`

```
--- 裁剪前 ---
  tool/result 文本长度：240 字
  开头：这是一段超长的工具输出，这是一段超长的工具输出，这是一段超长…
--- 裁剪后 ---
  裁掉几条：1
  总共裁掉：111 字
  原 seq 3（240 字）→ 新 seq 5（129 字）
  裁后的 tool/result 全文：
    这是一段超长的工具输出，……
    [... tool result middle pruned ...]
    的工具输出，这是一段超长的工具输出，……
--- 裁剪后的日志 ---
  seq 0  turn/start
  seq 1  user/message
  seq 2  tool/call
  seq 3  tool/result
  seq 4  compaction/prune
  seq 5  tool/result
  seq 6  turn/end
```

超长工具结果被裁成"头 + 固定标记 + 尾"，旧的完整事件仍在日志里。
