# 方案定稿：Web 段落级分享深链

- 日期：2026-08-13（基线查证日）；2026-08-13 复核基线并升级定稿（随实现落地）
- 状态：**已实施**
- 定稿决策：DL-D1 取 `#text=<encoded>` hash 段；DL-D2 复制截 120 code point、解析钳 200；DL-D3 取 CSS Custom Highlight 第二注册名 `reade-deeplink`（渐隐从简：2.4s 后直接移除注册，不做两段交替）；DL-D4 未命中提示 + 不滚动、URL 保留。
- 实施落点：`src/lib/textLocate.ts`（归一定位纯函数，新建）、`src/lib/webRouting.ts`（textFragment 解析/构造，`buildWebRouteUrl` 第三参演进为 `string | { heading?, text? }` 兼容旧调用）、`src/App.tsx`（定位重试 2×600ms、复制入口、`replaceWebRoute` 保留 `#text=`）、`src/components/AnnotationUi.tsx`（Web-only「链接」按钮）、`src/App.css`（`::highlight(reade-deeplink)`）。
- 与草案的偏离：截断按 Unicode code point（而非 UTF-16 码元）计数，避免劈开 emoji 代理对；其余按草案。
- 定位：Web 版自实现 `#text=<encoded>` 参数：打开链接时定位到含该文本的段落并短暂高亮。选区工具条新增"复制段落链接"（仅 Web 运行时）。Reade 自己控制渲染与滚动，不依赖浏览器原生 Text Fragments（`#:~:text=`）。
- 关联：与既有 `?doc=` 路由组合（`webRouting.ts`）；文本定位复用标注体系的 `buildTextIndex`/文本检索原语（`annotations.ts`）；短暂高亮沿 `runMotion` 动效档纪律。

> 一句话：`buildWebRouteUrl` 扩展第三参 `textFragment`（`#text=<encodeURIComponent(片段)>`，与 heading hash 互斥）；打开时 `parseWebRoute` 解出目标文本 → 文档渲染完成后在正文文本索引中检索首个匹配 → `rangeFromTextIndex` 建 Range → 滚动居中 + 2.4s 渐隐高亮（CSS Custom Highlight，与 TTS 同 API 不同名）；找不到时顶部一条"链接指向的段落未找到（文档可能已更新）"的降级提示。纯 Web 前端，桌面不出该按钮。

---

## 1. 现状基线（已核实于 2026-08-13，行号允许漂移）

| 事实 | 位置 |
|------|------|
| Web 路由：`parseWebRoute` 解析 `?doc=` 与 hash heading；`buildWebRouteUrl(currentUrl, documentPath, heading?)` 构造分享 URL 保留其他 query；更新用 `history.replaceState` | `src/lib/webRouting.ts` L86-99、L105-123；`src/App.tsx` L2944-2945 |
| 路径规格化安全：`normalizeWebDocumentPath` 拒绝绝对路径/协议/控制字符 | `src/lib/webRouting.ts`（normalize 一族） |
| 文本索引原语：`buildTextIndex(root)` 扁平化正文文本、`rangeFromTextIndex(index, start, end)` 由偏移建 Range——**深链定位 = 索引内 indexOf + 建 Range，零新原语** | `src/lib/annotations.ts` L298-309、L333-346 |
| 短暂强调先例：EPUB 定位命中用 `runMotion(highlighted, "locator-highlight", ...)` 720-880ms | `src/components/EpubReader.tsx` L274-297 |
| CSS Custom Highlight API 已在用（TTS `::highlight(reade-tts-active)`）——深链高亮注册第二个名字即可，不包 DOM | `src/lib/sentenceHighlight.ts` L65-76；`src/App.css` L2640-2642 |
| 选区数据：`pendingSelection { text, locator, rect }`，文本已 `clampSelectionText`（2000 上限） | `src/lib/annotations.ts` L39-43 |
| 选区工具条按钮扩展先例：相关/卡片按钮均为可选 props | `src/components/AnnotationUi.tsx` L30-48 |
| 运行时判定：`APP_RUNTIME === "web"`（编译时常量）——按钮 Web-only 的守卫方式 | `src/lib/backend.ts` L241-242 |
| 剪贴板写入先例：`copyTextToClipboard`（App 内已有） | `src/App.tsx`（copyText 一族） |
| 既有 heading hash 跳转在文档渲染后执行（含重试语义，标注跳转 `scheduleAnnotationJump` 的重试模式可参照） | `src/App.tsx`（jump 一族） |

## 2. 目标与非目标

**目标**

1. 选区工具条（Web）新"复制段落链接"钮：取选区文本前 120 字符（去首尾空白、空白归一）构造 `?doc=<path>#text=<encoded>`，写剪贴板 + toast。
2. 打开带 `#text=` 的 URL：文档载入渲染完成后定位首个匹配 → 平滑滚动至视口 1/3 处 → 高亮 2.4s 渐隐（`motionLevel=off` 则瞬时滚动 + 短暂静态高亮）。
3. 未命中（文档更新/跨文档粘贴）：不滚动，顶部通知条降级提示；URL 保留（用户可再分享）。
4. 与 heading hash 互斥：`#text=` 存在时优先；`?doc=` 缺失时忽略 `#text=`。

**非目标（明确不做）**

- 不用浏览器原生 `#:~:text=`（行为不可控、Firefox 支持迟、且无法给降级提示）。
- 不做模糊匹配/前后缀语法（`text=prefix-,target,-suffix` 式复杂语法收益低；120 字符精确子串已足够唯一）。
- 桌面版不出复制按钮（桌面无可分享 URL 语义）；但桌面**打开**带 text 参数的 URL 无此场景，不处理。
- 不持久化深链高亮（一次性强调）。

## 3. 设计

### 3.1 URL 契约（`webRouting.ts` 扩展）

- `WebRoute` 增 `textFragment?: string`；解析：`location.hash` 以 `#text=` 前缀时 `decodeURIComponent` 其余部分（try/catch 解码失败按无处理），长度钳制 ≤200 字符（超长丢弃，防 URL 武器化）；构造：`buildWebRouteUrl(url, path, { heading?, text? })` 签名演进（既有调用点同步）。
- 编码：`encodeURIComponent` 全量转义；空白归一后再编码，减少 `%0A` 类噪音；最终 URL 长度 >2000 字符时截短文本到 120 字符已保证不会触及。

### 3.2 定位与高亮

- 文档内容渲染完成（markdown/EPUB；Web 无 PDF）后：`buildTextIndex(articleRoot)` → 空白归一的 `indexOf`（索引与查询同归一，需要偏移映射——复用/对齐 cloze 方案的归一映射工具）→ `rangeFromTextIndex` → `new Highlight(range)` 注册 `reade-deeplink`；滚动用既有容器滚动原语。
- 渲染时序：沿标注跳转的重试模式（Shiki/图片异步导致索引偏移的场景，重试 2 次 × 600ms）。
- `::highlight(reade-deeplink) { background: var(--selection) }` + 2.4s 后 `clearHighlight`（渐隐由两段 Highlight 交替或直接移除 + runMotion 遮罩，实施定稿取简者）。

### 3.3 入口

- `SelectionToolbar` 增可选 `onCopyDeepLink`（App 仅 Web 传入）；点击后取 `pendingSelection.text` 处理并复制，toast"已复制段落链接"。

## 4. 改动清单（预估）

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src/lib/webRouting.ts` + 测试 | textFragment 解析/构造/钳制 | S-M |
| 2 | `src/lib/textLocate.ts`（新）+ 测试 | 归一化 indexOf + 偏移映射纯函数 | M |
| 3 | `src/App.tsx` | 打开时定位流程（重试）、复制入口接线、降级提示 | M |
| 4 | `src/components/AnnotationUi.tsx` | 工具条按钮（Web） | S |
| 5 | `src/App.css`、`docs/USER_GUIDE.md` | 高亮样式 + 文档 | S |

## 5. 验收标准（草案级）

- [ ] 路由测试：编解码往返、解码失败容忍、200 钳制、与 heading 互斥、`?doc=` 缺失忽略。
- [ ] 定位测试：归一化映射（换行/连续空格/全角空格）、首个匹配、未命中返回 null。
- [ ] 运行时（`pnpm dev:web`）：复制链接 → 新标签打开 → 滚动+高亮正确；修改文档使文本消失 → 降级提示；长 CJK 选区 URL 可在聊天工具粘贴往返。
- [ ] 桌面无按钮；明/暗截图；`pnpm test`、`tsc --noEmit`、`pnpm build:web` 回归。

## 6. 决策点

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| DL-D1 | 参数形态 | **`#text=<encoded>`（hash 段，自实现）**——hash 不进服务器日志、不触发 Pages 路由，控制权全在前端 | query 参数 `?t=`（改 URL 语义面大）；原生 `#:~:text=`（不可控、无降级提示） |
| DL-D2 | 文本长度 | **复制时截 120 字符、解析时钳 200** | 全选区（URL 爆长）；前后缀语法（复杂度不成比例） |
| DL-D3 | 高亮机制 | **CSS Custom Highlight 第二注册名**（零 DOM 侵入，与 TTS 同技术栈） | wrapRange 临时 mark（要清理 DOM、与标注 mark 混淆风险） |
| DL-D4 | 未命中行为 | **提示 + 不滚动** | 静默（用户以为链接坏了）；模糊匹配跳"最像"处（错误定位比不定位更糟） |

## 7. 风险

- 文本在文档更新后失效是本机制的固有属性：降级提示 + URL 保留是诚实做法；文案明示"文档可能已更新"。
- `#text=` 与既有 heading hash 共用 hash 位：互斥规则必须进路由测试，防止 heading 跳转回归。
- 归一化偏移映射是本案唯一有算法含量的点，与 cloze 方案共享工具函数可摊薄成本，但两案若并行实施需协调归属（先落地者建 `textLocate.ts`）。
