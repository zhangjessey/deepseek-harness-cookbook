// src/firewall/ch18/rules.test.ts —— 规则引擎纯函数的单元测试
//
// 规则引擎是本系列的地基：编译、匹配、deny 优先、unless 例外、字段语法、
// 清洗全函数——这些一旦错了，后面三讲全部跟着错。这里逐算子钉死。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileCondition, compileRule, evaluateRequest, ruleMatches, sanitizeRequest } from './rules'
import type { Condition, HttpRequest, PatternMatcher, Rule } from './types'

// 用最简单的 matcher 验证"matches 走注入的 matcher"这条契约，不测 RE2 本身（那在 re2-matcher.test.ts）。
const matcher: PatternMatcher = {
  engine: 're2',
  compile: (p) => p,
  match: (compiled, text) => String(text).includes(String(compiled)),
}

const req: HttpRequest = {
  method: 'POST',
  path: '/admin/login',
  query: { debug: '1', role: 'admin' },
  headers: { 'x-forwarded-for': '9.9.9.9', 'content-type': 'application/json' },
  body: 'password=secret',
  ip: '1.2.3.4',
  ua: 'python-requests/2.31',
}

function evalCond(cond: Condition, r: HttpRequest = req): boolean {
  return compileCondition(cond, matcher).test(r)
}

test('sanitizeRequest 做 NFC 归一化，且不修改原请求（全函数）', () => {
  const decomposed = 'e\u0301' // e + 组合重音
  const out = sanitizeRequest({ ...req, body: decomposed })
  assert.equal(out.body, 'é')
  assert.equal(req.body, 'password=secret', '原请求不被修改')
})

test('eq / ne 精确比较；字符串一律大小写不敏感', () => {
  assert.ok(evalCond({ field: 'method', op: 'eq', value: 'POST' }))
  assert.ok(evalCond({ field: 'method', op: 'ne', value: 'GET' }))
  // 字符串算子统一不敏感：否则 `starts_with '/admin'` 这类规则会被 `/ADMIN` 直接绕过——
  // 规则写对了、界面上也显示有这条规则，实际却拦不住，而且没有任何提示。
  assert.ok(evalCond({ field: 'method', op: 'eq', value: 'post' }), 'eq 忽略大小写')
  assert.ok(!evalCond({ field: 'method', op: 'ne', value: 'post' }), 'ne 同样按不敏感比较')
  // 非字符串仍按严格相等，不把 1 与 '1' 混为一谈
  assert.ok(!evalCond({ field: 'method', op: 'eq', value: 1 }))
})

test('contains 大小写不敏感', () => {
  assert.ok(evalCond({ field: 'path', op: 'contains', value: 'ADMIN' }))
  assert.ok(evalCond({ field: 'path', op: 'contains', value: 'admin' }))
  assert.ok(!evalCond({ field: 'path', op: 'contains', value: 'adm1n' }))
})

test('starts_with / ends_with', () => {
  assert.ok(evalCond({ field: 'path', op: 'starts_with', value: '/admin' }))
  assert.ok(evalCond({ field: 'path', op: 'ends_with', value: '/login' }))
  assert.ok(!evalCond({ field: 'path', op: 'starts_with', value: '/api' }))
  assert.ok(!evalCond({ field: 'path', op: 'ends_with', value: '/admin' }))
})

test('starts_with / ends_with 大小写不敏感（/ADMIN 不能绕过 /admin 规则）', () => {
  assert.ok(evalCond({ field: 'path', op: 'starts_with', value: '/ADMIN' }))
  assert.ok(evalCond({ field: 'path', op: 'starts_with', value: '/Admin' }))
  assert.ok(evalCond({ field: 'path', op: 'ends_with', value: '/LOGIN' }))
  assert.ok(!evalCond({ field: 'path', op: 'starts_with', value: '/api' }))
})

test('路径归一：百分号编码 / . / .. / 重复斜杠都不能绕过路径前缀规则', () => {
  // WAF 经典绕过：上游应用拿到的是解码后的 /admin，防火墙若看字面 "%61dmin" 就拦不住。
  // 归一发生在 sanitizeRequest 里，所以这里显式走 sanitize 后的请求。
  const compiled = compileCondition({ field: 'path', op: 'starts_with', value: '/admin' }, matcher)
  const hit = (path: string): boolean => compiled.test(sanitizeRequest({ ...req, path }))
  assert.ok(hit('/admin/login'), '正常路径仍命中')
  assert.ok(hit('/%61dmin/login'), '%61dmin 归一为 /admin')
  assert.ok(hit('/x/../admin/login'), '.. 被解析掉')
  assert.ok(hit('//admin/login'), '重复斜杠被合并')
  assert.ok(!hit('/%zz'), '畸形编码保留原样（不会"变成"另一个路径，故不构成绕过）')
})

test('header.<name> 大小写不敏感（规则作者按 HTTP 惯例写 X-Forwarded-For）', () => {
  assert.ok(evalCond({ field: 'header.X-Forwarded-For', op: 'eq', value: '9.9.9.9' }))
  assert.ok(evalCond({ field: 'header.x-forwarded-for', op: 'eq', value: '9.9.9.9' }))
  assert.ok(evalCond({ field: 'header.Content-Type', op: 'contains', value: 'JSON' }))
})

test('in / exists', () => {
  assert.ok(evalCond({ field: 'method', op: 'in', value: ['GET', 'POST'] }))
  assert.ok(!evalCond({ field: 'method', op: 'in', value: ['PUT', 'DELETE'] }))
  assert.ok(evalCond({ field: 'body', op: 'exists' }))
  assert.ok(!evalCond({ field: 'query.missing', op: 'exists' }))
})

test('matches 走注入的 matcher（引擎自己不碰正则）', () => {
  assert.ok(evalCond({ field: 'path', op: 'matches', value: 'admin' }))
  assert.ok(!evalCond({ field: 'path', op: 'matches', value: 'nomatch' }))
})

test('header.<name> 与 query.<name> 字段语法', () => {
  assert.ok(evalCond({ field: 'header.x-forwarded-for', op: 'eq', value: '9.9.9.9' }))
  assert.ok(evalCond({ field: 'query.role', op: 'eq', value: 'admin' }))
  assert.ok(!evalCond({ field: 'query.missing', op: 'eq', value: 'x' }))
})

test('and / or / not 组合', () => {
  assert.ok(
    evalCond({
      and: [
        { field: 'method', op: 'eq', value: 'POST' },
        { field: 'path', op: 'starts_with', value: '/admin' },
      ],
    }),
  )
  assert.ok(
    !evalCond({
      and: [
        { field: 'method', op: 'eq', value: 'GET' },
        { field: 'path', op: 'starts_with', value: '/admin' },
      ],
    }),
  )
  assert.ok(
    evalCond({
      or: [
        { field: 'method', op: 'eq', value: 'GET' },
        { field: 'path', op: 'starts_with', value: '/admin' },
      ],
    }),
  )
  assert.ok(evalCond({ not: { field: 'method', op: 'eq', value: 'GET' } }))
})

test('ruleMatches：unless 例外命中则不触发', () => {
  const rule: Rule = {
    id: 'r1',
    name: 'block admin except debug',
    state: 'active',
    when: { field: 'path', op: 'starts_with', value: '/admin' },
    action: 'deny',
    unless: { field: 'query.debug', op: 'eq', value: '1' },
  }
  const compiled = compileRule(rule, matcher)
  assert.equal(ruleMatches(compiled, req), false, 'unless 命中 → 不触发')
  assert.equal(ruleMatches(compiled, { ...req, query: {} }), true, 'unless 未命中 → 触发')
})

test('evaluateRequest：清洗 → 编译 → 求值一体化', () => {
  const rule: Rule = {
    id: 'r1',
    name: 'block admin',
    state: 'active',
    when: { field: 'path', op: 'starts_with', value: '/admin' },
    action: 'deny',
  }
  assert.equal(evaluateRequest(rule, req, matcher), true)
  assert.equal(evaluateRequest(rule, { ...req, path: '/api' }, matcher), false)
})
