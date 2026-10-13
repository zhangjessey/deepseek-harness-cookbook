// src/firewall/ch18/re2-matcher.test.ts —— RE2 教学子集（NFA，无回溯）的单元测试
//
// 覆盖"正则只用 RE2、不回退 RegExp"这条产品决定的两面：
//   · 支持的语法要正确匹配（字面量 / 量词 / 分组 / 选择 / 字符类 / 锚点 / 转义）
//   · 回溯型构造要拒绝（{n,m}、语法错误），且大小写不敏感
//   · assertRealRe2 拒绝被换成 RegExp 实现的测试替身
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { assertRealRe2, Re2Matcher, Re2Unsupported, SafeRe2Matcher } from './re2-matcher'

async function matcher(): Promise<Re2Matcher> {
  const ctx = new Context()
  await ctx.plugin(SafeRe2Matcher)
  return ctx.re2
}

test('字面量精确匹配', async () => {
  const m = await matcher()
  assert.ok(m.match(m.compile('admin'), 'admin'))
  assert.ok(!m.match(m.compile('admin'), 'admi'))
})

test('匹配大小写不敏感（WAF 常见做法）', async () => {
  const m = await matcher()
  assert.ok(m.match(m.compile('admin'), 'ADMIN'))
  assert.ok(m.match(m.compile('ADMIN'), 'admin'))
})

test('. 匹配任意非换行', async () => {
  const m = await matcher()
  assert.ok(m.match(m.compile('a.c'), 'abc'))
  assert.ok(!m.match(m.compile('a.c'), 'a\nc'))
})

test('* + ? 量词', async () => {
  const m = await matcher()
  assert.ok(m.match(m.compile('ab*c'), 'ac'))
  assert.ok(m.match(m.compile('ab*c'), 'abbc'))
  assert.ok(!m.match(m.compile('ab+c'), 'ac'))
  assert.ok(m.match(m.compile('ab+c'), 'abc'))
  assert.ok(m.match(m.compile('ab?c'), 'ac'))
  assert.ok(m.match(m.compile('ab?c'), 'abc'))
})

test('分组 (ab)+', async () => {
  const m = await matcher()
  assert.ok(m.match(m.compile('(ab)+'), 'abab'))
  assert.ok(!m.match(m.compile('(ab)+'), 'a'))
})

test('选择 cat|dog', async () => {
  const m = await matcher()
  assert.ok(m.match(m.compile('cat|dog'), 'dog'))
  assert.ok(m.match(m.compile('cat|dog'), 'cat'))
  assert.ok(!m.match(m.compile('cat|dog'), 'bird'))
})

test('字符类 [abc]、否定 [^abc]、范围 [a-z]', async () => {
  const m = await matcher()
  assert.ok(m.match(m.compile('[abc]'), 'b'))
  assert.ok(!m.match(m.compile('[abc]'), 'd'))
  assert.ok(m.match(m.compile('[^abc]'), 'd'))
  assert.ok(!m.match(m.compile('[^abc]'), 'a'))
  assert.ok(m.match(m.compile('[a-z]'), 'm'))
  assert.ok(m.match(m.compile('[a-z]'), 'M'), '大小写不敏感：M 归一为 m 后落在 [a-z]')
})

test('转义 \\d \\s \\w', async () => {
  const m = await matcher()
  assert.ok(m.match(m.compile('\\d'), '5'))
  assert.ok(!m.match(m.compile('\\d'), 'x'))
  assert.ok(m.match(m.compile('\\s'), ' '))
  assert.ok(!m.match(m.compile('\\s'), 'x'))
  assert.ok(m.match(m.compile('\\w'), '_'))
})

test('锚点 ^ 与 $', async () => {
  const m = await matcher()
  assert.ok(m.match(m.compile('^admin'), 'admin/x'))
  assert.ok(!m.match(m.compile('^admin'), 'x/admin'))
  assert.ok(m.match(m.compile('admin$'), 'x/admin'))
  assert.ok(!m.match(m.compile('admin$'), 'admin/x'))
})

test('Re2Unsupported：{n,m} 回溯型量词拒绝', async () => {
  const m = await matcher()
  assert.throws(() => m.compile('a{1,3}'), Re2Unsupported)
})

test('不支持的构造一律抛错，绝不静默当字面量', async () => {
  const m = await matcher()
  // 下面每一条在修复前都会被**静默错译**：编译"成功"、规则入库、但永不命中——
  // 防火墙于是全放行，且规则作者（或起草 Agent）得不到任何报错。这是安全组件最坏的失败形态。
  // 其中 .+? / .*? 是 WAF 规则里最常见的写法，写进去就静默失效。
  const mustReject: Array<[string, string]> = [
    ['.*?', '惰性量词（会变成 .* + 字面问号）'],
    ['a+?', '惰性量词'],
    ['a??', '惰性量词'],
    ['a**', '双重量词'],
    ['*', '孤立量词'],
    ['a|*', '孤立量词'],
    ['(?=.*admin)', '环视（会变成字面串 "(?=.*admin)"）'],
    ['(?:abc)', '非捕获组'],
    ['(?i)abc', '内联修饰符'],
    ['\\1', '反向引用（会变成字面数字 1）'],
    ['(a)\\1', '分组 + 反向引用'],
    ['\\b', '单词边界（未支持的字母转义）'],
    ['\\p{L}', 'Unicode 类（未支持）'],
    ['a^b', '中间的锚点'],
    ['[\\1]', '字符类里的反向引用'],
  ]
  for (const [pattern, why] of mustReject) {
    assert.throws(() => m.compile(pattern), Re2Unsupported, `${pattern}（${why}）必须抛 Re2Unsupported`)
  }
})

test(String.raw`字面量转义的标点不被误伤（\. \( \+ \\ 本来就该是字面量）`, async () => {
  const m = await matcher()
  assert.ok(m.match(m.compile('a\\.b'), 'a.b'), '\\. 是字面点')
  assert.ok(!m.match(m.compile('a\\.b'), 'axb'), '\\. 不是任意字符')
  assert.ok(m.match(m.compile('a\\+b'), 'a+b'))
  assert.ok(m.match(m.compile('\\(a\\)'), '(a)'))
  assert.ok(m.match(m.compile('[\\-\\.]'), '-'), '字符类里的标点转义仍是字面量')
})

test('非锚定匹配的最坏情况不是 O(n²)', async () => {
  const m = await matcher()
  // 这是"对每个起点重跑一遍 NFA"那种朴素实现的病态输入：非锚定 + `.*` 前缀 +
  // 长正文且**不匹配**。8KB（正好是入口允许的上限）在 O(n²) 下约 3300 万步，秒级。
  // 单趟多线程应当远快于此——这条断言只为抓住"退回按起点重跑"这类回归，上界取得很宽松。
  const text = 'a'.repeat(8192)
  const p = m.compile('.*zzz')
  const t0 = Date.now()
  assert.equal(m.match(p, text), false, '这本就不该匹配上')
  const ms = Date.now() - t0
  assert.ok(ms < 1000, `8KB 非匹配文本耗时应远低于 O(n²)，实测 ${ms}ms`)
})

test('单趟多线程：非锚定 / $ 锚定 / 零宽量词的语义都正确', async () => {
  const m = await matcher()
  // 非锚定：中间出现即命中
  assert.ok(m.match(m.compile('admin'), 'x/admin/y'))
  assert.ok(!m.match(m.compile('admin'), 'x/adm/y'))
  // 非锚定 + 结尾锚定
  assert.ok(m.match(m.compile('admin$'), 'x/admin'))
  assert.ok(!m.match(m.compile('admin$'), 'admin/x'))
  // 开头锚定
  assert.ok(m.match(m.compile('^admin'), 'admin/x'))
  assert.ok(!m.match(m.compile('^admin'), 'x/admin'))
  // 零宽：a* 在空串与任意文本上都成立
  assert.ok(m.match(m.compile('a*'), ''), '零宽匹配空串')
  assert.ok(m.match(m.compile('a*'), 'bbb'), '零宽匹配任意文本')
  // 交替 + 量词组合。非锚定：`+` 只要求存在一段连续匹配，不要求覆盖整个字符串。
  assert.ok(m.match(m.compile('(ab|cd)+'), 'abcdab'))
  assert.ok(m.match(m.compile('(ab|cd)+'), 'abxcd'), '非锚定：子串 "ab" 即成立')
  assert.ok(!m.match(m.compile('(ab|cd)+'), 'xyzw'))
  // 要覆盖整个字符串，必须两端都锚定——这组对照同时验证了 ^ 与 $ 的语义。
  assert.ok(m.match(m.compile('^(ab|cd)+$'), 'abcdab'))
  assert.ok(!m.match(m.compile('^(ab|cd)+$'), 'abxcd'))
})

test('\\n \\r \\t 与 \\d \\s \\w 都可用', async () => {
  const m = await matcher()
  assert.ok(m.match(m.compile('a\\db'), 'a1b'))
  assert.ok(m.match(m.compile('a\\sb'), 'a b'))
  assert.ok(m.match(m.compile('\\w+'), 'ab_1'))
  assert.ok(m.match(m.compile('a\\nb'), 'a\nb'), '\\n 是换行，不是字面 n')
  assert.ok(!m.match(m.compile('a\\nb'), 'anb'))
  assert.ok(m.match(m.compile('a\\tb'), 'a\tb'))
})

test('Re2Unsupported：语法错误（多余 ) / 缺少 ] / 缺少 )）', async () => {
  const m = await matcher()
  assert.throws(() => m.compile('a)'), Re2Unsupported, '多余的 )')
  assert.throws(() => m.compile('[abc'), Re2Unsupported, '缺少 ]')
  assert.throws(() => m.compile('(abc'), Re2Unsupported, '缺少 )')
})

test('assertRealRe2：拒绝 RegExp 测试替身', async () => {
  const ctx = new Context()
  const fake = new (class extends Re2Matcher {
    compile() {
      return {} as never
    }
    match() {
      return false
    }
  })(ctx)
  assert.throws(() => assertRealRe2(fake), /拒绝加载/, '非 SafeRe2Matcher 被拒绝')
})

test('assertRealRe2：接受真实现', async () => {
  const ctx = new Context()
  await ctx.plugin(SafeRe2Matcher)
  assert.doesNotThrow(() => assertRealRe2(ctx.re2), '真实现通过守卫')
})

test('assertRealRe2：用 RegExp 实现的替身（继承 SafeRe2Matcher）也会被拒绝', () => {
  // `instanceof SafeRe2Matcher` 挡不住这种：它确实是子类实例。行为指纹能——
  // RegExp 接受 {n,m} 这类回溯型构造，而 RE2 子集必须拒绝它。
  const ctx = new Context()
  const evil = new (class extends SafeRe2Matcher {
    override compile(pattern: string) {
      new RegExp(pattern) // 非法模式这里就会抛（但 {n,m} 对 RegExp 是合法的，不会抛）
      return { source: pattern } as never
    }
    override match(compiled: never, text: string): boolean {
      return new RegExp((compiled as { source: string }).source).test(text)
    }
  })(ctx)
  assert.ok(evil instanceof SafeRe2Matcher, '前提：它确实是子类实例（instanceof 会放行）')
  assert.throws(() => assertRealRe2(evil), /回溯型构造|拒绝加载/, '行为指纹必须挡住 RegExp 替身')
})
