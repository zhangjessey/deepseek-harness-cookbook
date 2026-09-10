# 第 08 章｜会话日志：Append-Only Log 与 Projection

## 文件说明

| 文件                 | 说明                                                                         |
| -------------------- | ---------------------------------------------------------------------------- |
| `log-demo.ts`        | 会话日志本体：追加、seq 连号、深冻结、JSON 校验、surface、`deriveMessages()` |
| `projection-demo.ts` | 投影单元：`init` / `apply` / `view` 三个纯函数，以及框架怎么驱动它们         |

## 运行示例

确保已经执行过 `npm install --legacy-peer-deps`，然后在**项目根目录**运行：

```bash
# 会话日志（①~⑤ 段）
npm run start:ch08

# 投影（①~③ 段）
npm run start:ch08:projection
```

## 预期输出

> `time`（毫秒时间戳）和 `id`（消息身份）每次运行都不同，这正好说明它们是运行时生成的。

### `npm run start:ch08`

```text
--- ① 日志：一条条追加，seq 连号 ---
  seq 0  turn/start
  seq 1  step/start
  seq 2  user/message
  seq 3  assistant/message
  seq 4  tool/call
  seq 5  tool/result
  seq 6  step/end
  seq 7  turn/end
小结：日志里现在有 8 条事件，下一条的 seq 将是 8

把 seq 2 这条原样打出来：
{
  "type": "user/message",
  "seq": 2,
  "time": 1788956446767,
  "data": {
    "content": [
      {
        "type": "text",
        "text": "现在几点了？"
      }
    ],
    "source": {
      "kind": "user"
    },
    "role": "user",
    "id": "82f6be0c-ff21-4976-885e-d46a8fd47df6"
  },
  "surfaceOp": "append"
}

--- ② 塞一个无法无损序列化的值 ---
  被拒：session event "turn/start" carries non-JSON-serializable data

--- ③ 试着改一下已经写下的历史 ---
  Object.isFrozen(events[0])      = true
  Object.isFrozen(events[0].data) = true
  events[0].data.turn = 99  →  TypeError: Cannot assign to read only property 'turn' of object '#<Object>'
  events[0].data.turn 仍然是 1

--- ④ surface：只有 3 个节点进得了 ---
  nodes = [2,3,5]，replaceGeneration = 0

--- ⑤ deriveMessages()：从日志算出的消息历史 ---
  user      | 现在几点了？
  assistant | 我来看一下时间。
  user      | <tool-result>
小结：3 条消息，来自 8 条事件
```

五段串起来就是一条线：

- **①** 日志是**平**的一串，seq 连号，事件一旦写下就抽不掉。
- **②** 非无损 JSON 的值在 `append` 时就被拒（`BigInt`、函数、`Date`、`NaN`…），不会等到落盘才炸。
- **③** 事件和它嵌套的 `data` 都被**深冻结**——`isFrozen` 查两层都是 `true`，赋值会抛 `TypeError`。历史改不动。
- **④** 8 条事件里只有 3 条进了 surface（模型看得见的那一层）。
- **⑤** 消息历史是**从事件算出来**的——日志里只有事件，没有"消息"这种东西。8 条事件只算出 3 条消息。

### `npm run start:ch08:projection`

```text
--- ① 一条事件都还没有时的投影 ---
  {"asOfSeq":-1,"values":{"demo/stats":{"userTurns":0,"toolCalls":0}}}

--- ② 追加 5 条事件之后 ---
  {"asOfSeq":4,"values":{"demo/stats":{"userTurns":2,"toolCalls":1}}}
  apply 被调用了 5 次（事件数 = 5）
  但变更通知只发了 3 次

--- ③ 卸载投影单元之后 ---
  {"asOfSeq":4,"values":{}}
```

三段各说一件事：

- **①** 空日志时投影是 `init` 给的初始状态，`asOfSeq` 为 `-1`（水位线：所有值都反映同一个日志位置）。
- **②** `apply` 被调 5 次，通知只发 3 次——`turn/start`、`step/start` 与这个单元无关，`apply` 原样返回**同一个 state 引用**，注册表用 `Object.is` 一比发现没变，就不通知下游。
- **③** 注销单元后 `values` 立刻变空，投影随之消失——注册是一个 effect，卸载干净、不留残余。
