# 第 11 章｜跨会话查询：读取、搜索与谱系追踪

## 文件说明

| 文件              | 说明                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `corpus-demo.ts`  | 读取：逻辑语料库的四个入口——`listSessions` 列 header、`readSession` 读完整日志、`listEvents` 列带归属的事件、`readSurface` 读当前 surface 快照 |
| `search-demo.ts`  | 搜索：跨会话 `searchSessions`、会话内 `searchEvents`，以及中文子串改用 `filterEvents` 的 text 过滤                                             |
| `filter-demo.ts`  | 精确过滤：`filterSessions` 按元数据圈定（AND / OR 组合），`filterEvents` 按 surface 与 text 扫描                                               |
| `lineage-demo.ts` | 谱系追踪：`traceSession` 的祖先链与后代树，以及 `traceEvent` / `readEvent` 的事件级追踪与有界读取                                              |

## 依赖

本章用到三个新包（已加入项目 `package.json`）：

- `@deepseek-ai/dsh-session-query` —— 查询 seam 定义
- `@deepseek-ai/dsh-session-query-sqlite` —— SQLite FTS5 后端
- `@deepseek-ai/dsh-session-title` —— 标题折叠（`session-query` 的依赖）

安装：

```bash
npm install --legacy-peer-deps
```

## 运行示例

在**项目根目录**运行：

```bash
# 读取（语料库四入口）
npm run start:ch11:corpus

# 全文搜索
npm run start:ch11:search

# 精确过滤
npm run start:ch11:filter

# 谱系追踪
npm run start:ch11:lineage
```

四个 demo 都把全文索引放在 `:memory:` 里，跑完即弃，不写磁盘。`lineage-demo.ts` 为了造出"事件被替换"的关系会跑一次压缩，用的是假模型（`MockAdapter`），不发起任何真实 LLM 调用。

## 预期输出

### `npm run start:ch11:corpus`

```
--- listSessions：列 header 清单 ---
  共 2 个会话（内存 + 磁盘合并后的结果）
  · sess-a  live=true  persisted=false
  · sess-b  live=true  persisted=false
--- readSession：读完整日志 ---
  sess-a：共 8 条事件
  类型序列：turn/start → user/message → assistant/message → turn/end → turn/start → user/message → assistant/message → turn/end
--- listEvents：列带归属的事件 ---
  seq 0  turn/start  surface=log-only
  seq 1  user/message  surface=current
  seq 2  assistant/message  surface=current
  seq 3  turn/end  surface=log-only
  seq 4  turn/start  surface=log-only
  seq 5  user/message  surface=current
  seq 6  assistant/message  surface=current
  seq 7  turn/end  surface=log-only
--- readSurface：当前 surface 快照 ---
  截到 seq：7
  surface 上还剩 4 条（只剩还在模型眼前的，结构事件不在内）
```

要点：

- `listSessions` 只给 header 和 live / persisted 两个布尔量，**一条事件都不读**。
- `listEvents` 的 `surface` 字段标出每条事件的归属：消息是 `current`，`turn/*` 这种结构事件是 `log-only`。
- `readSurface` 是**现场折叠**出来的，不是存好的；`capturedThroughSeq` 交代它截到日志的哪一条。

### `npm run start:ch11:search`

```
--- 跨会话全文搜索：搜「crash」 ---
  命中 1 个会话
  · sess-b：靠崩溃修复，把 crash 留下的半截 turn 配平。
--- 会话内全文搜索：在 sess-a 里搜「flush」 ---
  命中 1 条
  · seq 2 assistant/message：先写进内存的 events，再 flush 到磁盘。
  每条命中 = 一条事件 + 它自己的 snippet；跨会话搜索的 bestMatch 就是从这里挑的最强一条。
--- 跨会话全文搜索：搜「落盘」（中文子串）---
  命中 0 个会话（搜子串要用过滤器）
```

要点：

- FTS **只匹配整个 token**：英文 `crash`、`flush` 被空格切开、是独立 token，搜得到。
- 中文"日志怎么落盘"整句连成一个 token，搜子串"落盘"命中 0——这不是 bug，是倒排索引"用精度换速度"的代价。
- 中文子串要改用 `filterEvents()` 的 `text` 过滤，它做的是正则扫描。
- 跨会话搜索返回的是**会话命中项**（会话记录 + `bestMatch`），会话内搜索返回的是**事件命中项**（事件 + `snippet`）；前者的 `bestMatch` 就是后者里最强的那条。

### `npm run start:ch11:filter`

```
--- filterSessions：按 parent 找根会话（parent 为 null）---
  根会话：1 个 → sess-root
--- filterSessions：按 parent 找 sess-root 的孩子 ---
  sess-root 的孩子：1 个 → sess-child
--- 数组内是 AND：根会话 + 还在内存里 ---
  两者都满足：1 个 → sess-root
--- values 内是 OR：sess-root 或 sess-child 的孩子 ---
  命中任一：2 个 → sess-child, sess-grandchild
--- filterEvents：只看 surface 上还活着的（current）---
  命中 6 条 → seq 1 user/message, seq 2 assistant/message, seq 6 user/message, seq 7 assistant/message, seq 11 user/message, seq 12 assistant/message
--- filterEvents：结构事件（turn/*）不在语义文档里 ---
  命中 0 条（turn/start 不产生搜索文档，所以是 0）
--- filterEvents：text 过滤兜底 FTS 搜不到的中文子串 ---
  FTS 搜「落盘」：命中 0 个会话
  text 过滤搜「落盘」：命中 1 条（返回文档数组：没有 snippet，也不分页）
    · seq 11 user/message：日志怎么落盘？
--- filterEvents：text 匹配时按空白切段 ---
  · seq 12 assistant/message：顺序是：先写内存的⏎events，再 flush 到磁盘。
  搜索词按空白切成两段、段间用 \s+ 连，所以原文里两段之间隔着换行也能命中；
  而 *、?、( 这些正则特殊字符会被转义，在你手里永远是字面量。
```

要点：

- 组合规则只有两条：**数组内的各项是 AND**，**单个子句里的 `values` 是 OR**。
- `filterEvents` 扫的是"语义文档"，结构事件（`turn/start` 等）压根不产生文档，所以按 type 过滤 `turn/start` 命中 0。
- `text` 的"慢"换来的是"精确 + 安全"：能跨空白匹配，又不会被正则语法注入。
- 会话按"最近创建的在前"返回；本 demo 里几个会话在几毫秒内先后创建，顺序可能不固定，故按 id 展示以保证可复现。

### `npm run start:ch11:lineage`

```
--- 追踪 sess-grandchild 的谱系 ---
  目标：sess-grandchild
  完整：true
  祖先（由近及远）：
    · sess-child
    · sess-root
--- 追踪 sess-root 的后代 ---
  目标：sess-root
  后代树：
    · sess-child
      · sess-grandchild
--- 压缩：制造替换关系 ---
  被遮蔽的 seq：1, 4, 9, 12, 17, 20, 24, 26, 30, 32, 36, 38, 42
--- traceEvent：追 seq 1（被压掉的那条）---
  目标：user/message（surface=shadowed）
  replacedBy（直接替换者）：49
  replacementChain（到最终替换）：49
  replacedEventSeqs（它自己移除的）：（空）
  sourceEventSeqs（它引用的来源）：（空）
  derivedEventSeqs（引用它的）：49
--- readEvent：读 seq 1 前后的窗口 ---
  窗口：seq 0 → 2（共 3 条）
    seq 0  turn/start
    seq 1  user/message
    seq 2  step/start
```

要点：

- `ancestors` 是从直接父级往外排的祖先链，`descendants` 是从直接子级递归嵌套的后代树。
- 谱系追到断点时 `complete` 为 `false`，并给出 `unresolvedParentId`。
- `traceEvent` 的四组关系分两类：`replacedBy` / `replacementChain` / `replacedEventSeqs` 是**位置替换**，`sourceEventSeqs` / `derivedEventSeqs` 是**来源引用**。这里 seq 1 被 seq 49 的 checkpoint 顶掉（`replacedBy`），同时 seq 49 又把它列为来源（`derivedEventSeqs`）。
- `trace` 给**关系**，`read` 给**内容**：先追到 seq，再用 `readEvent` 读它前后的窗口。
