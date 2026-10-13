// src/firewall/shared/json.ts —— 工具输出与 JsonValue 契约的边界
//
// dsh 的 `defineTool` 要求 `execute` 的返回值匹配 `output.schema` 推断出的类型，
// 而防火墙的领域对象（`Rule.when` / `Candidate.when`）是 `unknown`——它不保证可 JSON 化，
// 因此类型上不能直接当 `JsonValue` 交给模型。
//
// 工具给模型的输出本来就是 JSON（`output.render` 里也是 `JSON.stringify`），所以这里做一次
// **真** JSON 往返而不是类型断言：既满足契约，也让 `undefined` / 函数 / 循环引用这类
// 不可序列化的字段在进入模型上下文之前就暴露出来，而不是在序列化时静默消失。
import type { JsonValue } from '@deepseek-ai/dsh-tools'

/** 把领域结果转成可交给模型的 JsonValue（真序列化，不是断言）。 */
export function toJson<T>(value: T): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}
