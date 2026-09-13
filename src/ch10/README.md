# 第 10 章｜上下文压缩：compaction，裁剪与溢出存储

## 文件说明

| 文件              | 说明                                                             |
| ----------------- | ---------------------------------------------------------------- |
| `spill-demo.ts`   | 溢出存储：把超大文本存到会话旁的文件里，模型只拿定位符与检索指引 |
| `compact-demo.ts` | 压缩：用假模型生成摘要，把旧历史压成一个 checkpoint 节点         |
| `prune-demo.ts`   | 裁剪：把超长的工具结果原地裁成"头 + 标记 + 尾"                   |

## 依赖

本章用到几个新包（已加入项目 `package.json`）：

- `@deepseek-ai/dsh-compaction` / `dsh-compaction-basic` —— 压缩 seam 与后端
- `@deepseek-ai/dsh-compaction-tool-result-pruner` —— 工具结果裁剪
- `@deepseek-ai/dsh-spill` / `dsh-spill-local` —— 溢出存储 seam 与本地后端
- `@deepseek-ai/dsh-token-meter` —— token 计量

安装：

```bash
npm install --legacy-peer-deps
```

## 运行示例

在**项目根目录**运行：

```bash
# 溢出存储
npm run start:ch10:spill

# 压缩
npm run start:ch10:compact

# 裁剪
npm run start:ch10:prune
```

`spill-demo.ts` 会把文件写到系统临时目录，跑完不清理，方便你看落盘路径与权限；`compact-demo.ts` 用一个假模型（`MockAdapter`）生成摘要，不发起任何真实 LLM 调用。

## 预期输出

### `npm run start:ch10:spill`

```
--- 把超大文本交给溢出存储 ---
  定位符（locator）：/var/folders/.../dsh-ch10-spill-.../session-2f1617f23ca8/...-web_fetch.txt
  字节数（bytes）：177
  检索提示（retrievalHint）：Use read with offset/limit, or grep this path to search within it.
  落盘：177 字节，权限 600
  内容核对：
    Fetching https://example.com/docs/intro ...
    ## Introduction
    This document explains how context overflow happens and what to do about it.
    ... (the full body would be much longer)
```

每次跑会变的是那两段：临时根目录（`dsh-ch10-spill-` 后面那串）和文件名的随机前缀；`session-2f1617f23ca8` 是会话 id 的哈希，同一个会话永远不变。结构始终是：根目录 → 会话目录 → 随机前缀 + 清洗后的文件名。

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
--- 裁剪后 ---
  裁掉几条：1
  总共裁掉：111 字
  原 seq 3（240 字）→ 新 seq 5（129 字）
  裁后的 tool/result 全文：
    这是一段超长的工具输出，……
    [... tool result middle pruned ...]
    的工具输出，这是一段超长的工具输出，……
```

超长工具结果被裁成"头 + 固定标记 + 尾"，旧的完整事件仍在日志里。
