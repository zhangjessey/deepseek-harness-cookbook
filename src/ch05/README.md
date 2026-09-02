# 第 05 章｜能力接入：Capability Seam 与 Tools

## 文件说明

| 文件            | 说明                                          |
| --------------- | --------------------------------------------- |
| `greet-tool.ts` | 用真实 dsh 定义的最小工具                     |
| `tool-main.ts`  | 把 greet 工具跑起来的入口                     |
| `seam-demo.ts`  | seam 三角色：Definition / Provider / Consumer |

## 运行示例

确保已经执行过 `npm install --legacy-peer-deps`，然后在**项目根目录**运行：

```bash
# 运行最小 greet 工具
npm run start:ch05

# 运行 seam 三角色（Provider 可替换）
npm run start:ch05:seam
```

## 预期输出

### `npm run start:ch05`

```text
--- 模型看得见的工具清单 ---
[
  {
    "name": "greet",
    "description": "Greet someone by name.",
    ...
  }
]
--- 调用 greet ---
{ isError: false, content: [ { type: 'text', text: 'Hello, World!' } ], value: 'Hello, World!' }
--- 卸载消费方插件 ---
--- 卸载后再看清单 ---
[]
```

### `npm run start:ch05:seam`

```text
--- 提供方 = local ---
{ value: { platform: 'darwin', node: 'v24.4.1' } }
--- 卸载 Provider 后，剩余工具 ---
[]
--- 换上 fake 后，剩余工具 ---
["env_probe"]
{ value: { platform: '<fake:platform>', node: '<fake:node>' } }
```

> `platform` 和 `node` 字段会随操作系统和 Node.js 版本变化，这是正常的。
