// src/firewall/shared/llm.test.ts —— 模型输出解析的单元测试（不需要 API key）
//
// extractJson 是"模型文本 → 结构化候选"的入口。它解析错时，症状是"候选非法/被截断"，
// 而真正的原因在扫描逻辑里——所以这里把扫描的边界单独钉死。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractJson } from './llm.ts'

test('extractJson：字符串里的括号不会提前闭合（sqli 候选的 value 含 } 也要能解析）', () => {
  // 逐字符数括号而不管字符串的话，"'}--" 里的 } 会让它以为 JSON 到此结束 → 截断成非法 JSON。
  const raw = `好的，候选如下：
[{"name":"block sqli","when":{"field":"path","op":"contains","value":"'}--"}}]
以上。`
  const got = extractJson<Array<{ name: string; when: { value: string } }>>(raw)
  assert.equal(got.length, 1, '整条数组都要解析出来，不能截断')
  assert.equal(got[0].when.value, "'}--")
})

test('extractJson：转义引号不会提前结束字符串', () => {
  const got = extractJson<{ v: string }>('{"v":"a\\"b"}')
  assert.equal(got.v, 'a"b')
})

test('extractJson：字符串里的 [ ] 也不当结构', () => {
  const got = extractJson<{ v: string }>('{"v":"x[y]z"}')
  assert.equal(got.v, 'x[y]z')
})

test('extractJson：容忍模型附带的解释文字（只取其中的 JSON）', () => {
  assert.deepEqual(extractJson<{ a: number }>('说明：\n{"a":1}\n结束'), { a: 1 })
})

test('extractJson：没有 JSON / 未闭合时抛出可行动错误', () => {
  assert.throws(() => extractJson('抱歉，我无法回答'), /模型未返回 JSON/)
  assert.throws(() => extractJson('{"a":1'), /模型返回 JSON 未闭合/)
})
