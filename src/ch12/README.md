# 第 12 章｜上下文边界：工具输出与图片附件的外部持久化

## 文件说明

| 文件                 | 说明                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------ |
| `spill-demo.ts`      | 溢出存储：工具吐出 60 KB 纯文本，策略插件把它换成首尾预览 + 一句指引，全文另存成文件 |
| `attachment-demo.ts` | 图片附件：存进去拿到引用、看字节落在哪、看日志里留下什么、再取回字节                 |
| `admission-demo.ts`  | 准入与失败：看准入线、校验不落盘、批量先全量校验、收紧限制不影响旧历史               |

## 依赖

本章用到这些包（已加入项目 `package.json`）：

- `@deepseek-ai/dsh-spill` / `dsh-spill-local` / `dsh-spill-policy` —— 溢出存储的 seam、本地后端，以及把它挂到"工具执行完"这个时机的插件
- `@deepseek-ai/dsh-output-retention` —— 预览机制（`TextRetainer`），`dsh-spill-policy` 要用它来裁出头尾预览
- `@deepseek-ai/dsh-attachment` —— 附件 seam 定义
- `@deepseek-ai/dsh-attachment-local` —— 附件的本地后端（依赖原生模块 `sharp`，装的是预编译包）
- `@deepseek-ai/dsh-home-paths` —— `dsh-attachment-local` 的 **peer 依赖**

> 因为本项目用 `--legacy-peer-deps` 安装，peer 依赖不会自动装上，`@deepseek-ai/dsh-home-paths` 必须显式写进 `package.json`，否则运行时会报 `ERR_MODULE_NOT_FOUND`。

安装：

```bash
npm install --legacy-peer-deps
```

## 运行示例

在**项目根目录**运行：

```bash
# 文本外置（溢出存储）
npm run start:ch12:spill

# 图片附件
npm run start:ch12:attachment

# 准入与失败
npm run start:ch12:admission
```

`spill-demo.ts` 会把文件写到系统临时目录，跑完不清理，方便你看落盘路径与权限（另两个示例也一样，各自在系统临时目录里建自己的存储根）；`attachment-demo.ts` 用的那张 8×8 PNG 直接内嵌在源码里（base64），不需要额外素材，也不发起任何真实 LLM 调用。

## 预期输出

### `npm run start:ch12:spill`

```
--- ① 工具跑完，原始输出多大 ---
  纯文本：60016 字节
  阈值 maxInlineBytes：50000   ← 超了，策略插件动手
--- ② 模型眼前那份（换过之后）---
  头：## Section
This document explains how context overflow happens and what to do about it.
## Secti…
  …（中间被预览截掉了）
  尾：…/...-web_fetch.txt. Use read with offset/limit, or grep this path to search within it.)
  替换后：50000 字节
--- ③ 全文存在哪 ---
  定位符（locator）：/var/folders/.../dsh-ch12-spill-.../session-2f1617f23ca8/...-web_fetch.txt
  落盘：60016 字节，权限 600   ← 一个字节都没少
  检索提示（retrievalHint）：Use read with offset/limit, or grep this path to search within it.
```

每次跑会变的是那两段：临时根目录（`dsh-ch12-spill-` 后面那串）和文件名的随机前缀；`session-2f1617f23ca8` 是会话 id 的哈希，同一个会话永远不变。结构始终是：根目录 → 会话目录 → 随机前缀 + 清洗后的文件名。

关键是 ② 和 ③ 的对比：模型眼前那份只有 50000 字节（预览 + 一句通知），而文件里躺着完整的 60016 字节——**外置不是丢弃**。
关键是 ② 和 ③ 的对比：模型眼前那份只有 50000 字节（预览 + 一句通知），而文件里躺着完整的 60016 字节——**外置不是丢弃**。

### `npm run start:ch12:attachment`

```
--- ① 一张图存进去，拿到什么 ---
  attachmentId：sha256:c2ab983c5681efb075d3b64315727791fdcf91bc61338f83f6a327a5ec206a34
  类型 / 尺寸 / 字节：image/png  8x8  95 字节
  name：pixel.png   ← 路径被剥掉了，只剩最后一段

--- ② 字节落在哪 ---
  .../attachments/v1/objects/c2/c2ab983c…206a34
  文件权限 600，目录权限 700
  落盘 95 字节，与 ref.bytes 一致：true

--- ③ 同一张图再存一次 ---
  attachmentId 相同：true   ← 内容寻址，天然去重
  objects 下的对象数：1

--- ④ 日志里存的到底是什么 ---
  {"type":"user/message","seq":0,"time":...,"data":{"content":[{"type":"image","attachment":{"attachmentId":"sha256:c2ab983c5681efb075d3b64315727791fdcf91bc61338f83f6a327a5ec206a34","mediaType":"image/png","width":8,"height":8,"bytes":95,"name":"pixel.png"}}],"source":{"kind":"user"},"role":"user","id":"..."},"surfaceOp":"append"}
  日志字符数 373，图片 95 字节   ← 字节一个都没进日志

--- ⑤ 要发给模型时再取回来 ---
  readImage：95 字节，image/png，8x8
```

要点：

- `attachmentId` 是内容寻址的（`sha256:<摘要>`），同一份字节只存一份。
- `name` 只保留文件名，路径（含 `../`）被剥掉，只剩最后一段。
- 落盘位置是 `<home>/attachments/v1/objects/<摘要前两位>/<完整摘要>`，文件 600、目录 700。

### `npm run start:ch12:admission`

```
--- ① 准入线在哪 ---
  maxImageBytes：5242880
  maxImagesPerMessage：20
  maxMessageImageBytes：104857600
  maxImagePixels：40000000
  mediaTypes：["image/png","image/jpeg","image/webp","image/gif"]

--- ② 校验不落盘 ---
  抛错：Unsupported or malformed image data.（code=INVALID_IMAGE）
  存储根被建出来了吗：false   ← 校验只是看看，一个字节都不写

--- ③ 一批图里有一张坏掉 ---
  抛错：Unsupported or malformed image data.（code=INVALID_IMAGE）
  存储根里已落盘的对象数：0   ← 先全量校验、再按序提交；坏在校验阶段就一个都不落

--- ④ 收紧限制，不影响旧历史 ---
  新限制下再存同一张：Image exceeds the configured byte limit.（code=IMAGE_TOO_LARGE）
  但读回收紧之前那张：95 字节，没问题   ← 准入只在写入时生效
```

要点：

- `validateImage` 只看不写：失败时连存储根都不会被创建。
- `saveImages` 先全量校验再按序提交：坏在校验阶段，一张都不会落盘。
- 准入限制只在**写入时**生效：收紧之后，旧的那张照样读得回来。
