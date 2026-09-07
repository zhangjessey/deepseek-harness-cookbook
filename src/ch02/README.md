# 第 02 章｜空之协同：Service、inject 与响应式依赖

## 文件说明

| 文件              | 说明                                     |
| ----------------- | ---------------------------------------- |
| `hello-inject.ts` | 最小服务注入：服务上下线，消费方自动跟随 |

## 运行示例

确保已经执行过 `npm install --legacy-peer-deps`，然后在**项目根目录**运行：

```bash
npm run start:ch02
```

## 预期输出

```text
[greeter:v1] 已上线
[consumer] [v1] Hello, world!
--- 撤销 greeter ---
[greeter:v1] 已下线
--- 新 greeter 上线 ---
[consumer] [v2] Hello, world!
```

注意中间那段：撤销 `greeter` 时，依赖它的 `consumer` 会**自动停止**，而不是留着一个
指向空服务的插件；等新的 greeter 上线，`consumer` 又自动恢复，并且拿到的是 v2。
这种「依赖方随被依赖方一起生灭」就是响应式依赖。
