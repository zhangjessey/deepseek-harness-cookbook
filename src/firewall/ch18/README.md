# 第 18 讲 · 规则系统：基于 dsh 扩展点搭建引擎

这一讲搭建防火墙的**规则引擎**：用 dsh 的扩展点（能力 seam）把"纯函数规则引擎"组装成一个可运行的 dsh 应用。规则用 JSON 条件树描述，匹配器是纯函数，对 HTTP 请求求值；模式匹配走 RE2 子集（线性时间、不回退 RegExp）。

## 文件清单

- `types.ts` —— 共享类型（请求、DSL 条件树、规则、判定、PatternMatcher 契约）。
- `condition.ts` —— **条件树的唯一一份结构化校验**：字段白名单（`isKnownField`）、算子白名单、空组合拒绝、叶子视图（`leavesOf`）、无环检测（`isValidCondition` / `assertValidCondition`）。ch19/20/21 复用同一份，跨讲契约只认这里。
- `rules.ts` —— **纯函数引擎**：先编译后求值，清洗是全函数；不依赖 cordis、永不直接 `new RegExp`。
- `re2-matcher.ts` —— **Service Provider**：RE2 风格匹配器（Thompson NFA），含"测试替身拒绝加载"守卫。
- `firewall.ts` —— **Service Definition（能力 seam 契约）**：`Firewall` 抽象类 + `FirewallEngine`（Provider，注入 re2-matcher）。deny 优先、与顺序无关；unless 例外写进 deny 规则本身。
- `rules-file.ts` —— **Consumer（数据面规则来源）**：从 `rules.json` 读入规则，灌进 firewall。
- `ingress-authz.ts` —— **Consumer（数据面入口）**：入口先拒绝超长字段，再交给 firewall 评估。
- `http-ingress.ts` —— **真实 HTTP 数据面入口**：用 Node `http` 起服务，把真实 HTTP 请求交给 `ingressAuthz` 判定（200/403）；生产 nginx `auth_request` 问的就是它。注意：真实 HTTP 入口**不读 body**（`toHttpRequest` 只取 method/path/query/headers/ip/ua），`body` 规则只在 demo 内存构造里演示——真实部署要命中 body 规则，需自行流式读 body（带大小上限）再交引擎。
- `tool-firewall.ts` —— **Consumer（控制面只读工具）**：把 firewall 以只读工具暴露给治理 Agent（无 tools 服务时自动跳过）。
- `bundles.ts` —— 三个 bundle（引擎核心 / 数据面 / 控制面）。
- `demo/rule-engine-demo.ts` —— 可运行入口（`npm run start:ch18`）：装配三 bundle 并跑演示。
- `demo/http-server-demo.ts` —— 可运行入口（`npm run start:ch18:http`）：起真实 HTTP 防火墙服务（默认 8787，可用 `PORT` 覆盖），可直接 curl 体验，也是 nginx `auth_request` 的上游。
- `demo/bench.ts` —— 性能基准（`npm run bench:ch18`）：匹配耗时随输入长度线性增长（无灾难性回溯）+ 引擎吞吐。
- `firewall-plugin.ts` + `cordis.patch.yml` —— 开发调试用：用 cordis patch 无侵入接入 dsh 宿主（与组合包安装互补）。

## 运行

```bash
npm run start:ch18
```

不需要 API key（纯函数匹配 + 装配演示）。

单元测试（Node 内置 test runner，无需额外依赖）：

- `patch-overlay.test.ts` —— 用 `boot()` 走 dsh 真实组合路径：patch 叠加顺序、整体替换、`!!js` 求值
- `condition.test.ts` —— 条件树校验器：字段白名单、算子白名单、空组合/空集合拒绝、无环检测、叶子视图
- `rules.test.ts` —— 纯函数引擎：清洗、算子（eq/contains/starts_with/…）、and/or/not、`unless` 例外、字段语法
- `re2-matcher.test.ts` —— RE2 子集：字面量/量词/分组/选择/字符类/锚点/大小写不敏感 + 回溯型构造拒绝 + 替身守卫
- `firewall.test.ts` —— 判定语义：deny 优先、白名单/黑名单、candidate 不生效、缓存、替身守卫
- `ingress-authz.test.ts` —— 数据面入口：超长字段拒绝 + 边界
- `http-ingress.test.ts` —— 真实 HTTP 流量端到端：起 HTTP 服务 + fetch 发真实请求，断言 403/200
- `bundle-assemble.test.ts` —— 组装上线端到端：三 bundle 组装 → 数据面判定；无 tools 时控制面 pending；patch `insert` 接入宿主
- `nginx-auth.test.ts` —— nginx 旁路端到端：用本机 nginx（或 Docker 的 `nginx:alpine`）做 `auth_request`，断言经 nginx 转发的请求 403/200；两者都没有才自动跳过
- `rules-file.test.ts` —— 规则来源 Consumer：文件读入、失败路径

```bash
npm test
```

性能基准：

```bash
npm run bench:ch18
```

## 预期输出

下面是 `npm run start:ch18` 的真实输出（数字与顺序稳定，可逐行对照）：

```
=== 规则库（来自 rules.json，经 rules-file Consumer 灌入 firewall）===
  rule-1 [deny] block admin scan
  rule-2 [deny] block sql injection
  rule-3 [deny] block crawler ua

=== 逐条请求判定（数据面 ingress-authz）===
  GET  /api/health    -> allow (default)
  GET  /admin/users   -> deny ← block admin scan
  GET  /admin/health  -> allow (default)        # 命中 unless 例外
  POST /login         -> deny ← block sql injection   # body matches 命中
  GET  /blog          -> deny ← block crawler ua      # ua matches 命中
  GET  /xxxxx…(len=8193) -> deny ← entry: 字段超过上限，入口拒绝 [entry 拒绝]

=== 白名单模式（默认拒绝，命中 allow 才放行）===
  GET  /internal/api  -> allow ← allow internal
  GET  /public/health -> deny ← whitelist: 未命中 allow，默认拒绝
```

（行尾 `# …` 是为阅读加的注解，不是程序输出。）

## 规则 DSL

```json
{
  "name": "block admin scan",
  "action": "deny",
  "when": { "field": "path", "op": "starts_with", "value": "/admin" },
  "unless": { "field": "path", "op": "eq", "value": "/admin/health" }
}
```

- 字段 `field`：`method` / `path` / `body` / `ip` / `ua` / `header.<name>` / `query.<name>`（`header.<name>` 大小写不敏感——Node 给的头名是全小写，规则里按 HTTP 惯例写 `X-Forwarded-For` 也能匹配）
- 未知字段会被**拒绝**（不是静默失效）：未知字段让取值变成 undefined，于是 `ne` 恒真（命中一切 → 全站 403）、`eq`/`contains` 恒假（规则永不生效 → 全放行），两种都是静默失效
- 操作符 `op`：`eq` / `ne` / `contains` / `starts_with` / `ends_with` / `matches`(RE2) / `in` / `exists`
- 组合：`{ and: [...] }` / `{ or: [...] }` / `{ not: {...} }`
- `unless`：例外写进 deny 规则本身（命中 when 且命中 unless 则该规则不触发）
- **字符串算子一律大小写不敏感**（WAF 常见做法）：`eq` / `ne` / `contains` / `starts_with` / `ends_with` / `in` / `matches` 都一样。统一是刻意的——若一半敏感一半不敏感，`starts_with "/admin"` 这条规则会被 `GET /ADMIN/users` 直接绕过：规则写对了、界面上也有，实际却拦不住。非字符串值（数字、布尔）仍按严格相等。
- `matches` 走 RE2 子集，RE2 不回退 RegExp

## 实现细节

### 为什么刻意用 RE2 子集、不用 JS 正则

规则里唯一走正则的算子是 `matches`，它由**注入的匹配器**完成，引擎本身永不直接 `new RegExp`（`rules.ts`）。配套匹配器 `re2-matcher` 是一个 **RE2 风格子集**：用 Thompson NFA 做线性时间匹配，没有回溯，因此不存在"正则灾难"（ReDoS）。

**推理依据**：NFA 一趟扫完文本，耗时是 O(文本长度 × 模式规模)，**不随输入内容退化**——这是与 PCRE 的关键差别：PCRE 支持回溯引用、环视等构造，恶意输入能让匹配退化成指数时间，把防火墙自己拖垮。RE2 子集直接拒绝这些构造（不是"静默当字面量"——那会让规则入库即失效、防火墙全放行且无报错，见 `re2-matcher.test.ts` 的拒绝清单）。`npm run bench:ch18` 给出良性输入与最坏情况（非锚定 `.*` 前缀 × 不匹配长文本）两组数字，后者才是复杂度检验的关键。

为了把这条决定焊死，引擎在加载时做自检：`assertRealRe2`（定义在 `re2-matcher.ts`，在 `firewall.ts` 里被调用）检查注入的匹配器是不是真正的 RE2 实现——**一旦治理 Agent 的工具被换成用 `RegExp` 实现的"测试替身"，引擎直接拒绝加载**。该行为由 `firewall.test.ts` 的「FirewallEngine 构造时拒绝非 RE2 的测试替身」钉住。

## 本讲的组合包

`dsh-firewall-rule`：装上后提供数据面入口 `ctx.ingressAuthz` 与控制面只读工具 `list_rules` / `check_request`。
构建、安装、分发与边界见 [规则系统 README](../README.md)。

## 两个平面怎么接

- **控制面（已就绪）**：组合包注册了只读 / 治理工具（工具注册在声明了 `inject: ['tools']` 的子插件里，无 `tools` 服务时子插件 pending、主条目照常激活），治理 Agent 可直接调用。
- **数据面（已提供可运行入口）**：ch18 组合包注册了 `ctx.ingressAuthz`（强制点）；`http-ingress.ts` 用 Node `http` 模块起服务、把请求交给 `authorize`，返回 200/403。真实部署把 nginx `auth_request` 指向这个端点即可（`http-ingress.test.ts` 用真实 fetch 请求验证了这条链路；`nginx-auth.test.ts` 验证完整旁路——它优先用本机 nginx，没有则起 Docker 的 `nginx:alpine`，两者都没有才跳过）。

#### nginx `auth_request` 旁路配置（两个真实踩过的坑）

```nginx
# 先起防火墙服务：npm run start:ch18:http（默认 8787）
server {
    listen 80;
    root /usr/share/nginx/html;
    location / {
        auth_request /_auth;
        try_files /index.html =404;   # ← 坑 1：这里不能用 return
    }
    location = /_auth {
        internal;
        proxy_pass http://127.0.0.1:8787/;   # 同机；跨机/容器换成可达的宿主机 IP
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header X-Original-URI $request_uri;   # ← 坑 2：必带
    }
}
```

- **坑 1：`return` 会跳过 `auth_request`。** `return` 在 REWRITE 阶段就立刻返回响应，而 `auth_request` 在 ACCESS 阶段执行——所以写成 `auth_request ...; return 200;` 时子请求**永远不会发出**，所有请求都会被放行（实测：把 `proxy_pass` 指向一个不存在的端口，仍然返回 200）。放行后必须走到 CONTENT 阶段：用静态文件、`proxy_pass` 到真实上游，或 `try_files`。
- **坑 2：`auth_request` 子请求不携带客户端原始 URI。** 子请求的 URI 是 `/_auth`，不是 `/admin/users`——防火墙直接看 `req.url` 的话永远看到 `/`。所以要用 `X-Original-URI $request_uri` 把原始 URI 传过去，`http-ingress.ts` 的 `toHttpRequest()` 会优先读这个头作为判定用的 path。
- 另注：用 curl 自测时，默认 UA 是 `curl/x.x`，会被 `block crawler ua`（`ua matches "curl/"`）拦掉；想验证放行请加 `-A 'Mozilla/5.0'`。

