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
| 10｜上下文压缩：compaction，裁剪与溢出存储                 | `src/ch10/` |
| 11｜跨会话查询：读取、搜索与谱系追踪                       | `src/ch11/` |

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
npm run start:ch10:spill
npm run start:ch10:compact
npm run start:ch10:prune

# 第 11 章
npm run start:ch11:corpus
npm run start:ch11:search
npm run start:ch11:filter
npm run start:ch11:lineage
```

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
