# 第 20 讲 · Agent 的规则进化：从异常请求中长出候选规则

本讲进入规则自进化的前半：从 nginx 访问日志发现异常 → 假名化脱敏 → 注入会话成为可追溯证据 → `propose` 长出候选规则并做三关校验。后半（评测与闭环）在第 21 讲。

## 文件清单

- `observe.ts` —— `Observer` + `detect` + `sanitize` + `ObserveSession`：增量读 nginx 日志、三检测器（path-probe / sqli / bad-ua）、抗挤占采样 + 每小时上限、假名化脱敏。领域逻辑，不 import cordis。
- `session-observe.ts` —— **证据写进 dsh 会话日志**：以插件注入的 `user/message`（来源 `plugin:firewall-observe`）落盘，重启后可加载；读回只采信本插件来源；与 ch19 账本同一方式。
- `propose.ts` —— `proposeFromEvidence` 三种候选（路径前缀 / 参数模式 / UA）、约束在工具代码里（`isValidCondition`）、三关校验（输出结构内联 / `validateStage1` 条件树 / `validateStage2` 命中全部请求）。
- `access.sample.log` —— 样本 nginx 日志（正常 + 异常混合），自定义格式：`IP - - [time] "METHOD path" status size "ua" "cookie"`。
- `demo/rule-evolve-demo.ts` —— 可运行入口（`npm run start:ch20`）：装配 observe + propose，跑完整前半链路。

## 运行

```bash
npm run start:ch20
```

需要 `DEEPSEEK_API_KEY`：候选由真实 DeepSeek 模型从脱敏证据中长出（约束写在 `propose` 的代码校验——`isValidCondition`，见 `ch18/condition.ts`——而不是提示词里）；检测、脱敏、采样、注入会话这几步是纯确定性代码，与模型无关。

跨讲依赖：本讲产出的候选规则遵循 **ch18 的条件树形状**（`when` 结构）；候选经第 21 讲评测后才会落进 **ch19 的账本**（本讲只读日志与会话，不写账本）——所以三讲共用同一个判定内核与形状契约。

测试（Node 内置 test runner，无需额外依赖）：

- `observe.test.ts` —— 三检测器（path-probe / sqli / bad-ua）识别、假名化脱敏、日志行解析、增量读、抗挤占采样与每小时上限
- `propose.test.ts` —— 三关校验（条件树 / 命中全部请求）
- `session-observe.test.ts` —— 证据以 `user/message` 写进 dsh 会话日志并能读回；读回只采信本插件来源
- `propose.e2e.test.ts` —— **真模型**从脱敏证据长出候选 → 三关校验全过〔需 key，无 key 自动跳过〕

```bash
npm test
```

## 预期输出

检测、脱敏、采样、注入为确定性步骤；下面"模型原始回复"与候选条目每次运行可能不同（名称、条数、是否漏掉某一类都可能变），这是一次代表性运行（模型一次给出 7 条候选，此处节选前两条，其余同样条件树=通过 命中全部请求=否）：

```
=== 模型长出候选规则（真实 DeepSeek）===
模型原始回复: [
  { "name": "block admin probe", "when": { "field": "path", "op": "starts_with", "value": "/admin" } },
  { "name": "block wp-login probe", "when": { "field": "path", "op": "starts_with", "value": "/wp-login" } },
  ...（本次共 7 条：admin / wp-login / wp-admin / phpmyadmin / etc/passwd / sqli / ua-scanner）
]
模型 token 用量: in=446 out=267
  cand-1 [block admin probe] when={"field":"path","op":"starts_with","value":"/admin"} 条件树=通过 命中全部请求=否
  cand-2 [block wp-login probe] when={"field":"path","op":"starts_with","value":"/wp-login"} 条件树=通过 命中全部请求=否
  ...（cand-3 ~ cand-7 同样 条件树=通过 命中全部请求=否）
```

提示词要求候选覆盖三类异常，但模型不保证照办——这次恰好三类都齐了；换一次运行，名称、条数、是否漏掉某一类都可能变（给不给 UA 类、给几条每次都不同）。这正是"约束只能放在代码侧、不能指望提示词"的例证。

## 实现细节

### 为什么证据也用插件注入的 `user/message`，而不是自定义事件类型

与 ch19 账本同理：`dsh` 推荐用声明合并扩展 `SessionEventMap`，但**仓库外插件**写入的自定义事件会让重启后的会话无法加载。所以宁可用已知载体（插件注入的 `user/message`，来源标 `plugin:firewall-observe`）。

代价同样是读回必须自己校验：只采信来源为 `firewall-observe` 的事件，形状不合法的忽略。

### 脱敏为什么是"假名化"而不是"匿名化"

要保留**可聚合性**：ip 做哈希、ua 做归类，于是还能聚合出"某类 UA 在扫""某个 ip 在撞哪些路径"——这正是长候选需要的信号。代价是拿不到原始 ip 和原文 UA（模型看不到真实身份，也就不可能把敏感信息带进候选或回话里）。

换句话说：匿名化会连"能长出规则的信号"一起抹掉，假名化只抹身份、留信号。

### 哈希为什么要加盐，以及为什么参数值也要脱敏

两条都是"看起来脱敏了、实际没有"的坑：

- **无盐 `sha256(ip)` 对 IPv4 是可反推的**：地址空间只有 2³²，离线枚举一遍就能还原出全部来源 IP，拿到日志的人等于拿到真实 IP。所以改用 **HMAC + 密钥**（`FIREWALL_IP_HASH_SECRET`）；未配置该环境变量时退化为**进程内随机密钥**并打印告警——仍然不可反推，代价只是跨进程无法关联同一 IP。
- **query 参数值含真实敏感数据**：`/reset?token=xxx`、`/search?q=someone@corp.com` 会进模型提示词，并被**永久**写进会话日志。所以参数值一律假名化，只保留"路径主干 + 参数名"——那才是长规则真正需要的结构信号。

注意脱敏**不影响检测**：`detect` 在脱敏之前就用原始日志行跑完了，sqli 特征照常识别；证据里也有 `kind` 告诉模型这是哪一类异常，规则生成不必"从日志里照抄 payload"。

### 增量读的进度：默认不落盘，且记的是字节偏移

两点容易踩：

- **`persistOffset` 默认 `false`**：演示脚本读的是仓库内的样本文件，落盘会把进度写进源码目录。**不开的代价是进程重启会从头重读全量、并重复注入证据**——这是已知取舍，不是"已支持续读"。真实部署（读 `/var/log/nginx/access.log`）应显式打开它。
- **进度记 `(inode, size, 字节偏移)` 三元组，不用行号**：行号是相对当前文件内容的位置，一旦轮转（logrotate 的 rename+create 会换 inode）或截断，同样行号就指向另一批内容，轻则重复注入、重则新写入的行整段被跳过（静默丢证据）。三者全对上才算同一份日志的续读；最后一行没写完（撕裂行）也不推进进度。

同理，"每小时"这个采样桶必须来自**日志时间戳**（`$time_local` / `$time_iso8601`）：写死成一个桶的话，配额一打满就永远不再采任何证据，而阈值只看被采样数——进化会**静默停摆**、日志里却看不出原因。

### 为什么要抗挤占采样 + 每小时上限

两层节流都是防"证据被单一异常灌满"：抗挤占是单类异常占比上限（否则一个扫描器刷屏会把其他异常全挤掉，进化就只看得到一种异常），每小时上限是总量兜底（也防日志被灌爆）。

## 本讲的组合包

`dsh-firewall-evolution`：装上后提供日志检测、脱敏与候选生成工具 `firewall_observe` / `firewall_propose`。
构建、安装、分发与边界见 [规则系统 README](../README.md)。

## 工具与检测能力怎么接

- **检测与脱敏**（`observe.ts`）是纯领域逻辑、不依赖 cordis，因此既可以当普通 TS 模块直接调，也可以包成工具供 Agent 用。
- **候选生成**必须**有 `tools` 服务**才注册（工具注册在子插件里，主条目不依赖 tools）——与 ch19 同理：数据面不跑 Agent 时没有 `tools` 服务，用 `inject` 就不会因缺服务而加载失败。
- 两个工具 `firewall_observe` / `firewall_propose` 随包注册：无 `tools` 服务时由子插件 pending（等价于跳过），主条目仍正常激活。
