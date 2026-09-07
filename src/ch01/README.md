# 第 01 章｜时之可逆：Context、插件与可撤销的 Effect

## 文件说明

| 文件           | 说明                                      |
| -------------- | ----------------------------------------- |
| `lifo-demo.ts` | Effect 的撤销顺序：后注册的先清理（LIFO） |

## 运行示例

确保已经执行过 `npm install --legacy-peer-deps`，然后在**项目根目录**运行：

```bash
npm run start:ch01
```

## 预期输出

```text
--- 卸载 cleanupPlugin ---
清理顺序： cleanup: 停止轮询 -> cleanup: 断开连接 -> cleanup: 关闭文件
```

三个清理动作按注册的**逆序**执行：最后注册的「停止轮询」最先被撤销。这就是 Effect 的
LIFO 语义——先做的事后收，保证依赖它的东西先停下来。
