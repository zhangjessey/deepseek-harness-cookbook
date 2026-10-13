# 第 19 讲 · 规则系统：让规则可生成，可修改，可持久化

本讲在 ch18 引擎之上，把"规则如何被 Agent 起草、被人把关、从内存落盘、以会话日志为准留存"串成一条可审计、可并发安全的链路。

## 文件清单

- `agent-draft.ts` —— **受约束起草**：把自然语言意图交给真实 DeepSeek 模型，产出结构化候选；第一稿一律是**候选（candidate）**，不直接生效。`isValidRuleWhen` 限定 `field`/`op`/`value` 取值，把生成关在契约内。
- `ledger.ts` —— **账本**：四类事件（`rule.add` / `rule.update` / `rule.reject` / `rule.remove`）折叠成状态；发布串行（`writeChain`，**只保证同一进程内**——跨进程/多实例指向同一投影文件时仍需文件锁或收归单进程）；原子写（临时文件 + rename）；带外修改补记；重启从会话日志重折叠恢复。领域逻辑，不 import cordis。
- `facts.ts` —— **verifyFacts**：重新折叠事件，与文件中投影的 `rules` 比对，校验"账本（权威）"与"文件（产物）"一致。
- `command-firewall.ts` —— `/firewall` 命令的领域逻辑（list / level / approve / reject）+ 五个自主级别（`0` 与 `manual` 同义、`1` 默认、`2`、`off`）。纯领域逻辑，不碰命令注册。
- `tool-firewall-edit.ts` —— 审批工具：起草候选（第一稿不直接 active）、批准、驳回。提供纯函数供 demo/ 下的入口与 demo/real-model-run.ts 调用。
- `services.ts` —— **dsh 接线层**：`LedgerService`（Provider，提供 `ctx.ledger`）+ `ControlService`（Consumer，`inject: ['ledger']`）。领域逻辑（ledger/command/edit）不 import cordis，接线集中在本文件。
- `session-log.ts` —— **账本落在 dsh 会话日志上**：事实以插件注入的 `user/message`（来源 `plugin:firewall-ledger`）写进 `dsh-session`；读回只采信本插件来源并校验形状；状态只由折叠得到。
- `session-projection.ts` —— **投影**：注册 `firewall-ledger` 单元（`init`/`apply`/`view` + `stateVersion`），从会话日志增量得到状态；工具与命令、界面、prompt 片段共用同一个折叠函数。
- `session-prompt.ts` —— **system prompt 片段**：`firewall:ledger`（order 60）。`text` 是函数，每次组装时从折叠状态渲染，**不读规则文件**——否则恢复或分叉会话后模型看到的是"现在的文件"。
- `approval.ts` —— **审批与工具白名单**：`tools/pre-execute` 是 waterfall（必须 `await next()`，结果默认拒绝）+ `tools.guard` 单调守卫（只按白名单收紧，不放行别人拒绝的）。
- `command-seam.ts` —— **`/firewall` 接入 dsh `commands` seam**：注册进 `ctx.commands`（不是自己解析字符串），handler 收 `rawInput` 交给领域逻辑；随插件卸载一起消失。
- `bundles.ts` —— `edgeBundle`（数据面，注册账本服务）/ `controlBundle`（控制面，注册控制面服务，并在有 `tools` 服务时挂审批）——对应两个平面；两 bundle 只通过服务名耦合，无模块级全局变量。
- `demo/firewall-demo.ts` —— 可运行入口（`npm run start:ch19`）：装配 edge + control，跑完整链路。
- `rules.ledger.json` —— 账本的文件投影产物（数据面只读）。删掉它再跑即为"首次运行"，可复现下面的输出。

## 运行

```bash
npm run start:ch19
```

需要 `DEEPSEEK_API_KEY`：本讲"Agent 起草候选"由真实 DeepSeek 模型把自然语言意图起草成规则候选（见 `agent-draft.ts`）；其余 ledger / 审批 / facts / 重启恢复机制为纯确定性代码，与模型无关。

跨讲依赖：本讲产出的候选规则遵循 ch18 的规则 DSL（`agent-draft.e2e.test.ts` 直接引 `../ch18/rules` / `../ch18/types` 做求值校验）；ch21 的评测同样直接复用 ch18 的纯函数引擎做历史流量回放——三处共用同一个判定内核，这是"回放可复现"的前提。

测试（Node 内置 test runner，无需额外依赖）：

- `agent-draft.test.ts` —— `isValidRuleWhen`：合法叶子通过；field 拼错 / op 不在契约 / 空 value / 非对象拒绝
- `ledger.test.ts` —— fold 三种事件、未给 state 默认 candidate、发布串行、启动对账、sessionId 不一致拒绝
- `approval.test.ts` —— 写操作在 off / 0 / manual 下被拦、级别 1/2 不拦、白名单内外、写操作集合是白名单子集
- `command-seam.test.ts` —— 命令注册进 dsh commands registry；approve / reject 真正改账本状态
- `session-log.test.ts` —— 事实写进会话日志并能读回；读回只采信本插件来源；形状不合法被忽略
- `session-projection.test.ts` —— 投影 `apply` 增量累积；注册进 dsh 投影注册表后 snapshot 读到同一个值
- `session-prompt.test.ts` —— 片段渲染的是折叠结果；注册后进入 dsh 组装出的 system prompt
- `session-restart.test.ts` —— 重启恢复：权威落盘后，新进程从 JSONL 恢复出同样的状态
- `approval-e2e.test.ts` —— 审批闸端到端（**真实 `tools.execute`** 的 pre-execute / 单调 guard 管线）
- `agent-loop.test.ts` —— 真模型在**真实 agent-loop** 里调写工具：级别 2 放行（候选落账本）/ off 被审批闸 deny（账本无候选）〔需 key〕
- `agent-draft.e2e.test.ts` —— **真模型**起草 → 人审批 → facts 一致（端到端）〔需 key，无 key 自动跳过〕

```bash
npm test
```

## 预期输出

删掉 `rules.ledger.json` 后首次运行的输出（其余机制输出固定；"Agent 起草候选"与"真实模型 Agent 测试"两步走真实模型，规则名/条件、token 用量每次运行可能不同）：

```
=== Agent 起草候选 -> 人审批 -> 发布（真实模型）===
模型原始回复: {"name":"block ip 1.2.3.4","action":"deny","when":{"field":"ip","op":"eq","value":"1.2.3.4"}}
模型 token 用量: in=175 out=60
草稿 rule-gznkluul 起草为候选: {"name":"block ip 1.2.3.4","action":"deny","when":{"field":"ip","op":"eq","value":"1.2.3.4"}}
人审批后 rule-gznkluul 已 active

=== 带外修改：人直接改文件，补记对账 ===
带外新增 rule-outofband 已补记

=== facts 校验 ===
一致=true，事件数=3，当前规则数=2

=== 重启恢复（新进程从磁盘上的 JSONL 恢复权威）===
恢复后规则数=2

=== 账本事实写进 dsh 会话日志（会话日志是权威，文件只是产物）===
  权威：会话日志内事实=3 条，折叠出规则数=2
  投影 firewall-ledger：规则数=2（与上面折叠一致）
  prompt 片段 firewall:ledger（order=60）已装配：含当前规则，总长=172

=== 真实模型 Agent 测试 ===
模型起草候选（intent="阻止所有访问 /admin 路径的探测请求"）→ {"name":"block admin probe","action":"deny","when":{"field":"path","op":"starts_with","value":"/admin"}}
模型 token 用量: in=172 out=49
Agent 起草候选 rule-7cglh6ve（state=candidate）
人审批后 rule-7cglh6ve state=active
facts 一致=true，事件数=5
```

## 实现细节

### 为什么账本事实用插件注入的 `user/message`，而不是自定义事件类型

账本事实要**真的写进 dsh 会话日志**，做法是选 dsh 已知的三种载体之一——本讲用插件注入的 `user/message`（来源标成 `plugin:firewall-ledger`）。

为什么不用自定义事件类型：dsh 推荐用声明合并扩展 `SessionEventMap`，但**仓库外插件**写入的自定义事件会让重启后的会话无法加载。所以宁可用已知载体。

代价是读回时必须自己校验：只采信来源为 `firewall-ledger` 的事件，形状不合法的直接忽略，状态只由折叠得到——这就是"权威在日志、文件只是产物"能成立的前提。

### 投影的 `stateVersion` 改了为什么要 bump

折叠语义或序列化字段变了必须 bump `stateVersion`。否则持久化的旧缓存行会继续被套用到新语义上，得到垃圾状态——投影不是"重新算一遍"就完事，缓存行是按 `stateVersion` 判定是否可复用的。

### 带外补记与"logged → 可重建"的单向性

`logged → 可重建` 这条保证**只有一个方向**：日志里记的，一定能从日志重建；但模型当时"看到"的不一定都落了日志。

崩溃恢复：发布顺序是**先写权威（会话日志）、再把折叠结果投影成文件**——文件只是产物，不是权威（顺序反过来看见的文件状态就可能是假的）。重启时由账本从会话日志重放、幂等重建（已实测"重启从 JSONL 恢复状态"）。

投影文件只在一种情况下参与启动：会话日志为空、而文件里有内容（例如上一次运行的产物，或人直接改过文件）——此时 `adoptProjection` 会把文件里的规则**补记**回权威，再由新的权威重新投影。文件若读不出来（损坏/无权限），它会隔离一份副本并拒绝启动，而不是当作"空规则库"（那会让下一步用空内容覆盖磁盘上的真实数据）。

## 本讲的组合包

`dsh-firewall-governance`：装上后提供账本（`ctx.ledger`）、五个自主级别与治理工具 `firewall_list` / `firewall_level` / `firewall_draft` / `firewall_approve` / `firewall_reject`。
构建、安装、分发与边界见 [规则系统 README](../README.md)。

## 两个平面怎么接

- **数据面 `edgeBundle`**：挂起会话日志权威（`dsh-session` + JSONL 持久化 + 重启恢复），再注册账本服务（`ctx.ledger`，权威 + 文件投影）。数据面只认账本。
- **控制面 `controlBundle`**：注册 `ControlService`（`inject: ['ledger']`，即"消费账本服务"），并在**有 `tools` 服务时**才挂审批与工具白名单——数据面不跑 Agent，没有 `tools` 服务，用 `inject` 就不会因为缺服务而加载失败。控制面只改账本。

两者只通过服务名耦合、无模块级全局变量——这正是能力 seam 的意义：换掉账本实现，控制面一行都不用改；也正因为耦合是可替换的服务引用，两个平面才可能真的拆成两个进程。

