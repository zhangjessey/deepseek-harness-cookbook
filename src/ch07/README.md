# 第 07 章｜跨平台进程沙箱：Linux、macOS、Windows 的实现与安全边界

## 文件说明

| 文件               | 说明                                                     |
| ------------------ | -------------------------------------------------------- |
| `sandbox-demo.ts`  | 把 argv 包一层再 spawn：三种模式下的拦截对照             |
| `platform-demo.ts` | 同一条命令换三个平台：三套 runner、三种 enforcement 强度 |

## 运行示例

确保已经执行过 `npm install --legacy-peer-deps`，然后在**项目根目录**运行：

```bash
# 沙箱拦截对照（含"不套沙箱"的对照组）
npm run start:ch07

# 三个平台各自的 runner
npm run start:ch07:platforms
```

## 预期输出

> 下面两份输出都跑在 **macOS** 上。沙箱是宿主能力，Linux 用 bubblewrap / Landlock，
> Windows 用受限令牌，runner 名字和 enforcement 强度会不一样——这正是 `platform-demo.ts`
> 要展示的。真实路径已替换成 `$HOME` / `$WORKSPACE` / `$CWD`。

### `npm run start:ch07`

```text
--- ① read-only：往工作区外写 ---
  包装后的 argv : ["sandbox-exec","-p","(version 1) (allow default) (deny file-write*) (allow file-write* (literal \"/dev/null\"))","--","bash","-c","echo hi > $HOME/_dsh_should_not_exist.txt"]
  退出码        : 1 | stderr: bash: $HOME/_dsh_should_not_exist.txt: Operation not permitted

--- ② workspace-write：往工作区里写 ---
  包装后的 argv : ["sandbox-exec","-p","(version 1) (allow default) (deny file-write*) (allow file-write* (literal \"/dev/null\")) (allow file-write* (subpath \"$WORKSPACE\") (subpath \"/private/tmp\") (subpath \"$TMPDIR\"))","--","bash","-c","echo hi > $WORKSPACE/ok.txt && echo written"]
  退出码        : 0 | stdout: written

--- ③ workspace-write：往工作区外写 ---
  退出码        : 1 | stderr: bash: $HOME/_dsh_should_not_exist.txt: Operation not permitted

--- ④ read-only：只读命令（不该被拦）---
  退出码        : 0 | stdout: read-ok

--- ⑤ 同一个命令，不套沙箱 ---
  退出码        : 0 （对比 ① 的 1：没被拦住，文件真的写出了）

--- ⑥ confine 还带回了什么 ---
  enforcement        : full
  denialSignatures   : ["operation not permitted"]
  runnerFailureRules : [{"fatalSignatures":["sandbox-exec: "]}]
```

四组对照值得盯住：

- **① 对 ⑤**：同一条命令，套沙箱被拒（退出码 1），不套就写成功了。沙箱确实在起作用，不是摆设。
- **② 对 ③**：`workspace-write` 只放行工作区**内**，工作区外照样拒——它不等于"随便写"。
- **④**：只读命令在 `read-only` 下正常通过，说明拦截是**按意图最小化**的，不是一刀切。
- **⑥** 里 `enforcement: full` 表示这条 runner 覆盖完整；`runnerFailureRules` 是"runner 自己起不来"的判据——沙箱没启动 ≠ 命令能跑，这一条防止"沙箱失效后被静默降级成裸奔"。

### `npm run start:ch07:platforms`

```text
宿主真实平台 = darwin

--- platform = darwin ---
  runner      : sandbox-exec
  enforcement : full
  拒绝方言    : ["operation not permitted"]
  包装出的 argv: ["sandbox-exec","-p","(version 1) (allow default) (deny file-write*) (allow file-write* (literal \"/dev/null\"))","--"]

--- platform = linux ---
  ✗ 抛出      : SandboxUnavailableError (code = SANDBOX_UNAVAILABLE)
    sandbox mode "read-only" is requested but no sandbox backend is usable on this host; refusing to run the command unconfined. Install bubblewrap or run a Landlock-enforcing kernel (Linux), ensure sandbox-exec is usable (macOS), or ensure the ACL restricted-token runner can start (Windows) — otherwise switch the consumer to danger-full-access.

--- platform = win32 ---
  runner      : node runner.js
  enforcement : partial
  拒绝方言    : ["access is denied","access to the path","permission denied"]
  包装出的 argv: ["$NODE","$CWD/node_modules/@deepseek-ai/dsh-sandbox-windows-acl/lib/runner.js","--workspace","$CWD"]
```

三个平台的差异一眼可见：

| 平台     | runner              | enforcement | 说明                                 |
| -------- | ------------------- | ----------- | ------------------------------------ |
| `darwin` | `sandbox-exec`      | `full`      | 系统自带 Seatbelt，内核级拦截        |
| `linux`  | bubblewrap/Landlock | —           | 本机没有可用后端，于是**抛错**       |
| `win32`  | `node runner.js`    | `partial`   | 受限令牌，靠 ACL，能力覆盖不如前两者 |

注意 `linux` 那段是**抛异常而不是降级**：宿主没有可用沙箱后端时，dsh 拒绝"裸奔执行"，
宁可报 `SANDBOX_UNAVAILABLE` 也不悄悄去掉约束——这是前几讲反复出现的 fail closed。
`platform-demo.ts` 里用 `provider.internals.platform` 强行改写了平台，所以在一台机器上
能看到三条链；真机上平台就是宿主自己，不需要这一步。
