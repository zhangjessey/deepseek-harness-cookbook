// src/firewall/shared/llm.test.ts —— 模型输出解析与失败归类的单元测试（不需要 API key）
//
// extractJson 是"模型文本 → 结构化候选"的入口。它解析错时，症状是"候选非法/被截断"，
// 而真正的原因在扫描逻辑里——所以这里把扫描的边界单独钉死。
//
// classifyLlmError 是整条链唯一按消息字符串判定的地方：框架抛的错误不带 code，
// 只能退而求其次。它判错不会改变重试次数（auth 与 unknown 都不可重试），
// 但会让排障方向跑偏——所以两条边界都要钉住：真实鉴权消息不能漏成 unknown。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyLlmError, extractJson } from './llm.ts'

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

test('classifyLlmError：无效 key 的三种说法都归成 auth', () => {
  // 第三条是本讲踩过的坑：DeepSeek 的真实消息里 "invalid" 在 key 之后，
  // 只按 `invalid ... key` 的顺序匹配会漏成 unknown。
  assert.equal(
    classifyLlmError('Authentication Fails, Your api key: ****abc**** is invalid, please check your api key.'),
    'auth',
  )
  assert.equal(classifyLlmError('Invalid API key'), 'auth')
  assert.equal(classifyLlmError('401 Unauthorized'), 'auth')
})

test('classifyLlmError：超时与网络各归其位', () => {
  assert.equal(classifyLlmError('ETIMEDOUT'), 'timeout')
  assert.equal(classifyLlmError('fetch failed'), 'network')
  assert.equal(classifyLlmError('ECONNRESET'), 'network')
  assert.equal(classifyLlmError('某个没见过的错误'), 'unknown')
})

test('classifyLlmError：含"超时"字样的空内容消息会被判成 timeout——这正是要带 code 的原因', () => {
  // 这条消息是 `ask` 自己抛的 LlmError('empty')，本不该再走字符串归类；
  // 但一旦它落到按消息判定，就会因为那句"连接中断或超时"被判成 timeout 而反复重试。
  // 钉在这里，是为了让"错误码必须自己带"这件事有据可查。
  const msg =
    '模型返回内容为空（usage: in=0 out=0）。可能原因：① API key 无效或额度耗尽；② 流被截断；③ 连接中断或超时。'
  assert.equal(classifyLlmError(msg), 'timeout')
})
