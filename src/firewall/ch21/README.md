# 第 21 讲 · Agent 的规则进化：评测与闭环

本讲是规则自进化的后半：候选长出来后，评测（覆盖率/精确率/误伤率）、候选确认（命名/意图/风险）、闭环（shadow/灰度/自动回退/老化/连续实验），并与 RSI 划清界限。前半（从异常长出候选）在第 20 讲。

## 文件清单

- `evaluate.ts` —— `evaluate` 评测三件事（覆盖率/精确率/误伤率）、`loadHistoricalTraffic`（用 ch20 检测器作 Oracle 标注历史日志）、事实校验（回放计数自洽）、从候选 `when` 逆推它针对哪类异常。
- `confirm.ts` —— `confirmCandidate` 候选确认（命名 / 意图 / 风险）；确认是**工具代码里的确定性函数**，不是让模型自评。
- `loop.ts` —— `RuleLifecycle` 生命周期：shadow → 灰度 → active，自动回退守卫，老化移出，连续实验（误伤与放过都变成反馈信号）；转正的"自动/灰度"程度由 ch19 的自主级别控制。
- `loop-task.ts` —— **后台任务**：老化由定时器驱动（`ctx.setInterval`，effect 版，随插件卸载停止）；单次失败不停循环；人在掌握控制时暂停。
- `feedback.ts` —— `feedMissedToEvidence` 把漏拦的坏请求脱敏后喂回证据库，**返回喂回的证据本身**（数组），供下一轮提案与原有证据合并。
- `traffic.sample.log` —— 历史回放样本（正常 + 异常混合），nginx 格式——评测的"固定外部事实"就来自它。
- `demo/rule-eval-demo.ts` —— 可运行入口（`npm run start:ch21`）：ch20 长出候选 → 评测 → 确认 → 闭环，跑通整条后半链路。

## 运行

```bash
npm run start:ch21
```

需要 `DEEPSEEK_API_KEY`（候选由 ch20 的 `proposeFromEvidence` 用真实模型生成）；评测、候选确认、闭环为确定性代码（候选确认写进工具代码，回放是固定样本），与模型无关。

跨讲依赖（本讲是四讲的收口，直接复用前三讲）：

- **ch18 纯函数引擎**：历史流量回放复用 `evaluateRequest`，确定性、可复现——这是"回放能当客观锚点"的前提。
- **ch19 自主级别**：闭环转正的"自动 / 灰度"程度由 `AutonomyLevel` 控制。
- **ch20 候选与证据**：本讲直接消费 ch20 的 `propose`（长候选）与 `observe`（检测器作 Oracle 标注）。

测试（Node 内置 test runner，无需额外依赖）：

- `evaluate.test.ts` —— 评测三指标（覆盖率 / 精确率 / 误伤率）、事实校验、从候选逆推证据
- `confirm.test.ts` —— 候选确认（命名 / 意图 / 风险），含高风险被拦下
- `loop.test.ts` —— 生命周期转移（shadow → 灰度 → active / 老化 / 自动回退）
- `loop-task.test.ts` —— 后台任务：定时器驱动、单次失败不停循环、随插件卸载停止
- `pipeline.e2e.test.ts` —— **真模型**候选 → 评测 → 候选确认 → 闭环推进的完整流水线〔需 key，无 key 自动跳过〕

```bash
npm test
```

## 预期输出

回放、评测、候选确认、闭环为确定性步骤；候选条目与 token 用量每次运行可能不同，这是一次代表性运行：

```
=== 历史流量（回放样本）===
请求数=19  该拦(bad)=9  正常(good)=10
（ch20 真实模型提案回复节选: [ { "name": "block admin probe", … } …；token in=134 out=257）

=== 评测三件事（覆盖率 / 精确率 / 误伤率）+ 事实校验 ===
  cand-1 [block admin probe] 覆盖率=22.2% 精确率=100.0% 误伤率=0.0% 逆推=[path-probe] 事实校验=ok
  ...（cand-2 ~ cand-6 同样 精确率=100.0% 误伤率=0.0% 事实校验=ok）
  cand-7 [block ua scanner] 覆盖率=0.0% 精确率=0.0% 误伤率=0.0% 逆推=[bad-ua] 事实校验=ok  ⚠ 未命中任何流量
  trap-1 [block ua browser] 覆盖率=33.3% 精确率=23.1% 误伤率=100.0% 逆推=[bad-ua] 事实校验=ok

=== 候选确认（命名 / 意图 / 风险）===
  cand-1 [block admin probe] 命名=ok 意图=ok 风险=ok → 通过
  ...（cand-2 ~ cand-6 同样候选确认全过 → 通过）
  cand-7 [block ua scanner] 命名=ok 意图=ok 风险=FAIL → 不通过
      · 回放样本里命中 0 次（覆盖率 0.0%）：该候选拦不住任何东西，无法据此评估风险，需人确认
  trap-1 [block ua browser] 命名=ok 意图=ok 风险=FAIL → 不通过
      · 误伤率 100.0% 过高，需人确认

=== 闭环：shadow → 灰度 → active（自主级别 2，候选确认通过）===
  初始: canary
  observe(拦,true) → stage=canary hits=1 误伤=0 放过=0
  observe(拦,true) → stage=canary hits=2 误伤=0 放过=0
  observe(拦,true) → stage=active hits=3 误伤=0 放过=0

=== 闭环：老化（长期无命中）===
  tick（无命中）→ stage=canary hits=0 误伤=0 放过=0
  tick（无命中）→ stage=canary hits=0 误伤=0 放过=0
  tick（无命中）→ stage=aged_out hits=0 误伤=0 放过=0

=== 闭环：自动回退（过宽候选灰度期误伤超阈值）===
  误拦正常请求后: stage=rolled_back hits=1 误伤=1 放过=0

=== 漏拦 → 喂回证据库 ===
  窄候选（只拦 /admin）回放后: stage=canary hits=2 误伤=0 放过=7
  漏拦 7 条 → 脱敏后喂回证据库 7 条
  证据库: 9 条 → 16 条
  再喂一次: 0 条（drain 后不再重复）

=== 喂回 → 下一轮提案（漏掉的异常请求变成候选）===
  下一轮提案输入 16 条证据（原 9 条 + 喂回 7 条）；token in=… out=…
  cand-8 [block admin probe] 覆盖率=22.2% 精确率=100.0% 误伤率=0.0%
  ...（cand-9 ~ cand-d：/wp-admin、/wp-login、/phpmyadmin、/etc/passwd 等路径候选）
```

两个值得盯住的真实案例，都是"看起来合法、实际不能用"的候选：

- `cand-7 [block ua scanner]`：结构合法、事实校验也 ok、误伤率 0.0%，但**命中 0 次**——一条拦不住任何东西的规则。它"零误伤"只是因为一次都没生效，所以风险检查据此判 FAIL（原因见下面实现细节）。
- `trap-1 [block ua browser]`：覆盖率 33.3% 看着不低，但**误伤率=100.0%**——把正常浏览器全拦了，被风险检查判 FAIL，标"不通过 · 需人确认"。

这正是评测与确认存在的意义：光看候选的 JSON 挑不出毛病，只有回放 + 候选确认能暴露它们。

## 实现细节

### 为什么评测必须锚在"历史流量回放"这个固定外部事实上

评测不能让模型自己给自己打分——那等于没有外部参照。本讲的外部事实是**固定的历史回放样本**（`traffic.sample.log`）+ ch20 检测器作的 Oracle 标注：同一批候选、同一个样本，跑多少次结果都一样。

有了这个锚点，"覆盖率 / 精确率 / 误伤率"才是客观指标，而不是模型的一次自我陈述。

### 为什么候选确认要写成工具代码里的确定性函数

模型在本讲的职责是**受约束地生成候选**；判断"这条能不能转正"不交给模型。命名 / 意图 / 风险三道检查是工具代码里的确定性函数，其中风险检查直接吃评测算出的误伤率——所以 `trap-1` 误伤 100% 会被确定性判 FAIL，而不是"模型觉得可以"。

高风险必须**人确认**，不能自动转正——这是"人始终在环"的落点。

### `block ua scanner` 为什么命中 0（归类值 vs 原始字符串）

ch20 的 `propose` 按**归类值**生成候选：UA 被脱敏归类为 `scanner`，于是候选的 `when` 是 `ua eq 'scanner'`。但 ch18 引擎匹配的是**原始 ua 字符串**（真实请求里是 `python-requests/2.28` 之类），`eq 'scanner'` 匹配不到任何流量，故命中 0。

这条不是 bug，而是"脱敏边界"的自然结果——也正好演示了评测的价值：如果只看 JSON，这条候选挑不出任何毛病。真实部署要把这类候选改回匹配原始 ua（例如 `ua contains`）。

### 为什么不是 RSI（递归自我改进）

RSI 的区分点是"能不能改进**产生改进的机制本身**"。本讲改进的是**产物**（规则）与**上下文**（证据），机制（检测器、校验器、确认、回放）一行没改——它不会因为跑了几轮就自己长出新检测器。

再加上三条约束：人始终在环、受约束生成、固定回放评测——所以是"在可控范围内持续试错"，不是 RSI。

## 本讲的组合包

`dsh-firewall-eval-loop`：装上后提供评测（覆盖率/精确率/误伤率）、候选确认与闭环工具 `firewall_evaluate` / `firewall_confirm` / `firewall_loop`。
构建、安装、分发与边界见 [规则系统 README](../README.md)。

## 闭环工具与后台任务怎么接

- **评测 / 确认 / 生命周期**（`evaluate.ts` / `confirm.ts` / `loop.ts`）是确定性领域逻辑，不依赖 cordis，可直接当普通 TS 模块调用。
- **后台任务**（`loop-task.ts`）用 `ctx.setInterval` 的 effect 版驱动老化（回退由 `observe` 即时触发）：单次失败不停循环（避免一次抖动就让整条闭环停摆），且**随插件卸载停止**——这是 cordis effect 的生命周期保证，不是靠手动 clear。
- **两个正确性坑**：定时器的**滴答不能当成一次请求观测**（要走 `noteIdle()` 而不是 `observe(false, false)`，否则每次滴答都被计进误伤率的分母，真实误伤被稀释到阈值以下、守卫等于被自己的心跳关掉）；**没挂闭环日志时是降级模式、必须出声**（此时 `persistent` 为 `false`，已回退的规则重启后会被忘掉、重新进入灰度——代码明确告警，不让运维误以为已持久化）。
- 三个工具 `firewall_evaluate` / `firewall_confirm` / `firewall_loop` 只在**有 `tools` 服务**时注册（工具注册放在子插件里，主条目不依赖 tools）；无 `tools` 服务时子插件 pending（等价于跳过），主条目仍正常激活。

