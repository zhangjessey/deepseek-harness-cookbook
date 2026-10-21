# 规则系统（第 18–21 讲）

四讲代码统一放在 `src/firewall/` 下，构成一个完整项目：

| 目录    | 讲次 | 主题                                     |
| ------- | ---- | ---------------------------------------- |
| `ch18/` | 18   | 规则系统：基于 dsh 扩展点搭建引擎        |
| `ch19/` | 19   | 规则系统：让规则可生成、可审批、可生效    |
| `ch20/` | 20   | Agent 的规则进化：从异常请求中长出候选规则 |
| `ch21/` | 21   | Agent 的规则进化：评测与闭环            |

每讲既有可单独运行的 demo（`npm run start:chXX`），也有可安装到本地 dsh 的组合包（`packages/` 下四个）。
**各讲 README 只讲本讲内容**；构建、安装与边界集中在这里。

跨讲依赖：ch19/20/21 产出的候选规则都遵循 ch18 的规则 DSL，并复用 ch18 的纯函数引擎做判定与回放——四处共用同一个判定内核，这是"回放可复现"的前提。

## 四个组合包

每个声明 `dsh.bundle`，入口复用 `src/firewall/chXX` 的引擎，由 esbuild 内联打包进自包含 `lib/`。

| 组合包                    | 讲次 | 提供的能力                                                                                                                                   |
| ------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `dsh-firewall-rule`       | 18   | 规则引擎 + RE2 匹配器 + 数据面入口 `ctx.ingressAuthz` + 控制面只读工具 `list_rules` / `check_request`                                        |
| `dsh-firewall-governance` | 19   | 账本（会话日志投影）+ 三档自主级别 + 治理工具 `firewall_list` / `firewall_level` / `firewall_draft` / `firewall_approve` / `firewall_reject` |
| `dsh-firewall-evolution`  | 20   | 日志检测 + 脱敏 + 证据注入会话 + 候选生成工具 `firewall_observe` / `firewall_propose`                                                        |
| `dsh-firewall-eval-loop`  | 21   | 评测（覆盖/精确/误伤）+ 候选确认 + 闭环工具 `firewall_evaluate` / `firewall_confirm` / `firewall_loop`                                        |

## 构建

一次产出四个 `lib/`：

```bash
npm run build:firewall-bundles
```

只构建某一讲用 `npm run build:ch18-bundle` 这类单包命令。**必须在仓库根执行**：子包没有自己的 `node_modules`，它的 `prepare` 脚本跑不起来。

产物分别在 `packages/<名>/lib/index.js`，均自包含；`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools` 作为运行时依赖由 dsh 提供（external）。

## 装进 profile

**先构建再装**：仓库不提交构建产物，而 `add` 读的是各包 `package.json` 的 `main`（`lib/index.js`）——先按上一节 `npm run build:firewall-bundles` 构建出 `lib/`，再装（可一次 add 多个，按需取用）：

```bash
dsh plugin --profile demo add -w ./packages/dsh-firewall-rule
dsh plugin --profile demo add -w ./packages/dsh-firewall-governance
# 需要进化 / 评测闭环时再装后两个
dsh plugin --profile demo add -w ./packages/dsh-firewall-evolution
dsh plugin --profile demo add -w ./packages/dsh-firewall-eval-loop
```

- `-w` 是必需的：profile 目录本身是 pnpm workspace root，不带会报 `ERR_PNPM_ADDING_TO_ROOT` 而装不进去。
- 装到本机**不需要发布**，`add` 直接指向 checkout 即可。
- 首次会初始化 profile（`@deepseek-ai/dsh-base` 作为首个组合包），并把各包追加进 `dsh.profile.bundles`。

装完可用 `dsh --profile demo --dump-config` 打印组合结果（不启动 Agent、不需要 API key），各包条目都会出现在配置树里。它和真正启动用的是同一个合成调用（`composeEntries` → `applyEntryPatches`），所以 dump 出的配置树与 `boot()` 实际挂载的内容完全一致，不会出现「看的一个样、跑的另一个样」。另外，patch 写的 id 若不在组合后的树里，dsh 只往 stderr 打一行警告、该层静默不生效——改完 patch 务必用它核对。

## 分发给别人

`add` 的参数就是"从哪装"，三种来源：

| 来源     | 发布侧                        | 安装侧                                          |
| -------- | ----------------------------- | ----------------------------------------------- |
| 本地目录 | 不用发布，直接指向 checkout   | `dsh plugin --profile demo add -w ./packages/…` |
| tarball  | `npm pack`（先构建出 `lib/`） | `dsh plugin --profile demo add ./…tgz`          |
| npm      | `npm publish`（发构建产物）   | `dsh plugin --profile demo add <包名>`          |

从 git 装（`dsh plugin add github:you/your-plugin`）要求**那个仓库的根目录就是包本身**，且 git 拉的是源码——需 author 提供 `prepare` 构建脚本，用户首次 `add` 还会被 pnpm 拦下，要把包键加进 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 授权。本仓库是 monorepo、包在 `packages/` 下，所以这条路走不通；要分发就用上面的本地 checkout，或发 npm / 交 tarball（走预构建，无需授权）。

## 运行每讲 demo（不需要 dsh）

```bash
npm run start:ch18   # 引擎判定（不需要 key）
npm run start:ch19   # 持久化与自治（需 DEEPSEEK_API_KEY）
npm run start:ch20   # 进化（需 DEEPSEEK_API_KEY）
npm run start:ch21   # 评测与闭环（需 DEEPSEEK_API_KEY）
```

`demo/` 只是"把核心逻辑装配起来跑给你看"的入口；真正被单元测试覆盖、可复用、可打进组合包的领域逻辑，在同目录的**非 demo 文件**里（`rules.ts` / `ledger.ts` / `observe.ts` / `evaluate.ts` 等）。想改行为，改那些非 demo 文件；想改"演示什么"，才动 demo。

## 注意事项

用这套组合包，你要做的只有两件：**装进 profile**（命令见上一节）和**运营规则**（谁在哪个自主级别下能批准什么，在你的宿主侧完成）。其余——引擎、账本、级别、工具——四个组合包都已提供，实跑通过，无需改动。

接入时可能撞上三个坑，提前知道能省不少时间：

- **版本要对齐**：`dsh-*` 已统一 `0.1.0-rc.8`。若与 CLI 的传递依赖混装（一边 rc.7、一边 rc.8），会报 `offloadRequestImages` 这类错——看着像包坏了，实为版本没对齐。
- **两条 inject 约束**：① `apply` 里访问 `ctx.tools` 必须声明 `inject`，否则抛 `cannot get property "tools" without inject`；② inject 没有"可选"，主条目声明 `inject: ['tools']` 而宿主无该服务时整个条目 pending——所以工具注册放子插件里，主条目不依赖 tools。
- **patch 静默失效**：patch 的 id 匹配不到、或 `name` 不一致时，dsh 只打警告并跳过这一条、不会报错——改完 patch 记得用 `--dump-config` 核对。
