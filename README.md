# DeepSeek Harness Cookbook

《DeepSeek Harness 前沿工程实践》各章节配套可运行代码。

## 前置条件

需要先安装 Node.js。

```bash
node -v
npm -v
```

本项目要求：

- Node.js >= 24.4.1
- npm >= 10.0.0

`.npmrc` 中已开启 `engine-strict=true`，如果版本不满足，`npm install` 会直接报错。

> 推荐使用 [nvm](https://github.com/nvm-sh/nvm)（macOS/Linux）或 [nvm-windows](https://github.com/coreybutler/nvm-windows)（Windows）管理 Node.js 版本。

## 快速开始

### 1. 下载项目

```bash
git clone git@github.com:zhangjessey/deepseek-harness-cookbook.git
cd deepseek-harness-cookbook
```

### 2. 安装依赖

```bash
npm install --legacy-peer-deps
```

**必须加 `--legacy-peer-deps`**。

原因：`@deepseek-ai/cordis-plugin-group` 等包的 peer 依赖声明为 `^4.0.2`，而本项目锁定 `@deepseek-ai/cordis@4.0.1`，npm 默认的 ERESOLVE 会判定冲突；`--legacy-peer-deps` 跳过 peer 自动解析，按 `package.json` 锁定的版本安装。

### 3. 运行章节示例

每一章的运行方式见该章目录下的 `README.md`。

当前已包含章节：

| 章节                                                       | 目录        |
| ---------------------------------------------------------- | ----------- |
| 01｜时之可逆：Context、插件与可撤销的 Effect               | `src/ch01/` |
| 02｜空之协同：Service、inject 与响应式依赖                 | `src/ch02/` |
| 03｜事件系统：五种分发模式及其适用场景                     | `src/ch03/` |
| 04｜插件树：声明式配置、isolate 与 HMR                     | `src/ch04/` |
| 05｜能力接入：Capability Seam 与 Tools                     | `src/ch05/` |
| 06｜工具流水线：Code Mode、守卫与执行边界                  | `src/ch06/` |
| 07｜跨平台进程沙箱：Linux、macOS、Windows 的实现与安全边界 | `src/ch07/` |
| 08｜会话日志：Append-Only Log 与 Projection                | `src/ch08/` |
| 09｜会话续接：Fork、Resume 与崩溃修复                      | `src/ch09/` |
| 10｜上下文压缩：Compaction 与裁剪                          | `src/ch10/` |
| 11｜跨会话查询：读取、搜索与谱系追踪                       | `src/ch11/` |
| 12｜上下文边界：工具输出与图片附件的外部持久化             | `src/ch12/` |
| 13｜装配与驱动：Agent 与 AgentLoop                        | `src/ch13/` |
| 14｜工具与人设：Agent Preset 预组装                       | `src/ch14/` |
| 15｜自动续跑：用 Goal 驱动长任务                          | `src/ch15/` |
| 16｜委派任务：Subagent 的创建、协作与回收                 | `src/ch16/` |
| 17｜编排机制：模型驱动 Workflow 与固定策略 Ralph          | `src/ch17/` |
| 18｜规则系统：基于 dsh 扩展点搭建引擎                    | `src/firewall/ch18/` |
| 19｜规则系统：让规则可生成、可审批、可生效               | `src/firewall/ch19/` |
| 20｜Agent 的规则进化：从异常请求中长出候选规则           | `src/firewall/ch20/` |
| 21｜Agent 的规则进化：评测、确认与闭环                   | `src/firewall/ch21/` |

```bash
# 第 01–04 章
npm run start:ch01
npm run start:ch02
npm run start:ch03
npm run start:ch04
npm run start:ch04:tree

# 第 05 章
npm run start:ch05
npm run start:ch05:seam

# 第 06 章
npm run start:ch06
npm run start:ch06:code

# 第 07 章
npm run start:ch07
npm run start:ch07:platforms

# 第 08 章
npm run start:ch08
npm run start:ch08:projection

# 第 09 章
npm run start:ch09:fork
npm run start:ch09:crash

# 第 10 章
npm run start:ch10:compact
npm run start:ch10:prune

# 第 11 章
npm run start:ch11:corpus
npm run start:ch11:search
npm run start:ch11:filter
npm run start:ch11:lineage

# 第 12 章
npm run start:ch12:spill
npm run start:ch12:attachment
npm run start:ch12:admission
```

### 防火墙系列（第 18–21 讲）：一个完整项目

第 18–21 讲构成一个完整的"规则防火墙 + 自治进化"系统，代码统一放在 `src/firewall/` 下，四讲各为一部分；每个讲次既能单独运行测试，也能作为 dsh 插件安装到本地 dsh。四个组合包（每个声明 `dsh.bundle`，入口复用 `src/firewall/chXX` 的引擎，由 esbuild 内联打包进自包含 `lib/`）：

| 组合包 | 讲次 | 说明 |
|---|---|---|
| `dsh-firewall-rule` | 18 | 规则引擎 + 数据面入口 `ctx.ingressAuthz` + 控制面只读工具 `list_rules` / `check_request` |
| `dsh-firewall-governance` | 19 | 账本（会话日志投影）+ 五个自主级别 + 治理工具 `firewall_list` / `level` / `draft` / `approve` / `reject` |
| `dsh-firewall-evolution` | 20 | 日志检测 + 脱敏 + 证据注入会话 + 候选生成工具 `firewall_observe` / `firewall_propose` |
| `dsh-firewall-eval-loop` | 21 | 评测（覆盖/精确/误伤）+ 确认三关卡 + 闭环工具 `firewall_evaluate` / `confirm` / `loop` |

```bash
# 单独运行四讲 demo（无需 dsh、无需 API key）
npm run start:ch18
npm run start:ch19
npm run start:ch20
npm run start:ch21

# 构建四个组合包（各自产出自包含 lib/）
npm run build:firewall-bundles

# 安装一个或多个进本地 dsh 的 profile（先构建出 lib/ 再 add，按需取用）
dsh plugin --profile demo add ./packages/dsh-firewall-rule
dsh plugin --profile demo add ./packages/dsh-firewall-governance
dsh plugin --profile demo add ./packages/dsh-firewall-evolution
dsh plugin --profile demo add ./packages/dsh-firewall-eval-loop
```

每讲的细节、文件清单与"数据面需宿主自接"的说明见各讲目录下的 `README.md`（如 `src/firewall/ch18/README.md`）。四讲代码引用全部来自本仓库同一个 `src/firewall/`，与配套教程正文（含思考题）逐一对应。

> 第 04 章的 HMR 示例需要 `--expose-internals`，没有封装成 npm script，命令见 `src/ch04/README.md`。

## 检查类型

```bash
npm run typecheck
```

正常应无输出（表示通过）。

## 常见问题

### `npm install` 报 `ERESOLVE`

确认加了 `--legacy-peer-deps`：

```bash
npm install --legacy-peer-deps
```

### `npm install` 报 `ENOTSUP` 或 `Unsupported engine`

当前 Node.js 或 npm 版本不满足 `engines` 要求。请升级 Node.js：

```bash
nvm install 24.4.1
nvm use 24.4.1
```

### 运行示例没有输出或报错

1. 确认已经执行 `npm install --legacy-peer-deps`
2. 确认在项目根目录运行命令
3. 确认 Node.js 版本 >= 24.4.1

## 许可证

MIT
