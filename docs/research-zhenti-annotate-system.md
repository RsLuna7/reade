# 英语真题在线 · 标记系统逆向调研报告

> 调研对象：https://zhenti.burningvocabulary.cn/cet6/2025-12/01  
> 调研焦点：标记 / 标注系统（选区、高亮、笔记、侧栏、持久化与同步等，以页面实际能力为准）  
> 目的：复刻交互规格、对照 Reade 标注能力、优化本地方案  
> 边界：只做调研与归纳；不破解、不绕过鉴权、不编写 exploit；不输出可用于攻击的利用步骤  
> 调研时间：2026-08-11  
> 方法：公开页面浏览 + DevTools / 脚本静态分析；第二轮在用户本人专业版登录态下观测接口与 DOM（凭证未写入本文）

---

## 1. 一句话结论

该页的「标记系统」是 **PDF 真题阅读器上的专业版标注能力**：顶栏工具模式（高亮 / 下划线 / 文本输入 / 笔写 / 手指书写 + 撤销 / 橡皮擦），用 **Konva 按页 canvas 覆盖层** 绘制；按页序列化为压缩 Stage JSON，经 `/api/data/get/annotate` 与 `/api/data/update` 按文档路径云同步。未登录或非专业版时工具可见，但点击会弹出会员功能介绍并导向付费。

---

## 2. 标记系统能力清单

| 能力 | 判定 | 说明 |
|------|------|------|
| 选区高亮 | **有（专业版）** | `data-element="Highlight"`，4 色；高亮以 Konva `Image` + `bgColor` 呈现 |
| 下划线 | **有（专业版）** | `UnderLine`，细 `Rect` + 填充色 |
| 文本批注框 | **有（门控 UI；专业版脚本含 FreeText）** | `FreeText`（「文本输入」）；完整手感未深测 |
| 自由笔写 | **有（门控 UI；专业版脚本含 FreeHand）** | `FreeHand`（「笔写」）；点列 `Line` |
| 手指书写 | **有（门控 UI；专业版脚本含 FingerHand）** | `FingerHand` |
| 颜色切换 | **有** | 每类工具独立 4 色；非会员色标渲染为 `#b0b0b0` |
| 撤销 | **有** | 工具条「撤销」；专业版可用 |
| 橡皮擦 | **有（UI + Konva Path 橡皮对象）** | 「橡皮擦」；笔触细节未深测 |
| 清空本卷标注 | **有（专业版）** | `p===1 && aStatus===1` 时注入「清除手写标注」→ `GET /api/data/clear/annotate?urlPath=` |
| 加载态 | **有** | 「获取笔记中…」工具条 loading |
| 标注侧栏列表 / 跳转 | **未见** | 当前产品以页内叠加为主，未见独立标注列表 UI |
| 选区浮动工具条（高亮/笔记） | **无** | 与 Reade 选区条不同；为常驻工具模式 |
| 收藏 | **无（本页未见）** | — |
| 错题本式标记 | **无（作为标注子系统）** | 另有「题号标记答案」，概念不同 |
| 生词 / 查词 | **有（相邻能力）** | 点词查词 + 生词本；不是 PDF 标注工具 |
| 跨设备同步 | **有（宣称 + 接口证实账号侧存储）** | Pro 文案「笔记云同步」；数据走账号 `/api/data/*` |
| 本机离线持久化（免费） | **基本无标注实体** | 未登录 localStorage 无标注数据 |

### 概念区分

1. **试卷内容中的 “mark”**：题干英文 “mark the corresponding letter…” —— 考试指令，不是产品功能。  
2. **PDF.js「查找全部高亮」**：`#findHighlightAll` —— 搜索高亮，非用户标注。  
3. **用户批注 / 手写标注**：`#header-tool` + Konva `.annotate` —— **本调研焦点**；专业版专属。  
4. **题号选答案 / 生词本**：同页相邻学习能力，可共用 `/api/data/*` 通道，但产品定位不是「高亮笔记」。

---

## 3. 用户流程

### A. 未付费 / 未登录

1. 打开 `…/cet6/2025-12/01`，进入定制 PDF.js 阅读器（本卷 8 页）。  
2. 顶部可见标注工具条（色块灰化）。  
3. 点击任一标注工具 → 「功能介绍」对话框（可切到「手写、标注高亮」）。  
4. CTA「解锁会员」→ `/pro?refPath=…&from=featureTour`。  
5. Pro 页标明：**「手写、标注高亮（笔记云同步）」为专业版专属**（约 19.9 元/半年），不在 9.9 高级版权益列表中。  
6. 无法留下可观察的高亮/笔迹；localStorage 无标注实体。

### B. 专业版（已登录实测）

1. `winGlobal.p === 1` 且 `docInfo.aStatus === 1`。  
2. 仅此时加载 `read_zhenti_detail_annotate.js`。  
3. PDF 加载后显示「获取笔记中…」→ `GET /api/data/get/annotate?urlPath=`。  
4. 选择工具与颜色 → 在页上划选/书写/输入。  
5. 变更经 Worker 打包后 `POST /api/data/update`（`isAnnotate: true`）。  
6. 「工具」菜单可出现「清除手写标注」→ 确认 → `GET /api/data/clear/annotate?urlPath=` → 成功后刷新。

### C. 跨页 / 跨卷

- **同套卷内分页**：URL `/cet6/2025-12/01` + PDF.js `#page=&zoom=`；`pdfjs.history` / `bv_pdfhistory` 记阅读位置，**不等于标注持久化**。  
- **标注按页键**：`annotate.{pageNumber}`（如 `annotate.1`）。  
- **跨设备**：账号云端同一 `urlPath` / `doc` 键。

---

## 4. UI / 信息架构要点

- **入口**：PDF 阅读区顶部 `#header-tool` 常驻工具条（非选区气泡）。  
- **主工具**：`View` / `Highlight` / `UnderLine` / `FreeText` / `FreeHand` / `FingerHand`。  
- **子色板**：`.tool-color-container`（随当前工具渲染）。  
- **辅助**：撤销、橡皮擦。  
- **默认色板（脚本）**  
  - Highlight：`rgb(255,205,69)` / `rgb(37,210,209)` / `rgb(0,204,99)` / `rgb(226,161,230)`  
  - UnderLine / FreeText / FreeHand / FingerHand：红 / 蓝 / 黑 / 绿  
- **失效态**：非专业版色标灰化 + 点击弹出功能介绍。  
- **相邻入口**：句子翻译、生词本、听力原文、解析答案、我的作文等。

---

## 5. 技术观测

### 5.1 前端表现

| 观测 | 证据 |
|------|------|
| 定制 PDF.js `2.14.316` | `pdfjsLib.version`；`zhenti.viewer_2-14-316.js` |
| 免费态页结构 | `.page` → `.canvasWrapper` + `.textLayer`；无 annotationEditorLayer |
| 专业版页结构 | 额外 `#annotate_{n}.annotate` → `.konvajs-content` → `<canvas>` |
| 绘制库 | 全局 `Konva`；`window.AnnotateAPI`（`isReady` / `getStage` / `getPageRect` / `clearLayer` 等） |
| 专业版脚本 | `javascripts/read_zhenti_detail_annotate.js`（免费会话不加载） |
| 工具命名 | `data-element` 风格接近 PDFTron/Apryse，实现为自研 Konva 层 |
| 付费拦截（免费） | `!winGlobal.p \|\| 3===docInfo.aStatus` 时 `#header-tool` click → `Wt({featureKey:"annotate"})` |
| 文档身份 | `globalConfig.filePath`；本卷 PDF fingerprint `d658f575eb1b0644b3a704bf3e8f4f1c` |

### 5.2 本地存储（观测）

| Key | 关系 |
|-----|------|
| `_zhenti_visit_count` | 升级按钮样式 |
| `extr_data` | 用量类 |
| `pdfjs.history` / `bv_pdfhistory` | 阅读进度 |
| `local_data` | 通用用户数据命名空间（会员可含更多字段）；标注主权威在服务端 annotate API |
| Cookie `_cuid` 等 | 访客 / 统计；本文不记录敏感值 |

脚本常量：`local_data`、`extr_data`、`__zhenti_uid`。

### 5.3 接口（公开可观测；已在专业版会话验证读写）

| 方法 | 路径 | 用途 |
|------|------|------|
| `GET` | `/api/data/get/annotate?urlPath=` | 拉取该文档全部页标注；成功 `code:"0000"` |
| `POST` | `/api/data/update` | 保存；标注时带 `isAnnotate:true`、`doc`、`data["annotate.{页}"]` |
| `POST` | `/api/data/delete` | 通用删除键 |
| `GET` | `/api/data/clear/annotate?urlPath=` | 清空该文档全部标注后 reload |

相邻非标注接口（同站）：`/api/listening/textGet`、`/api/answerExpansion/textGet`、`/api/answerAnasysis/textSave`、`/api/order/*`、`/api/guide/frame` 等。

### 5.4 保存请求形态（脱敏示例）

```json
{
  "data": {
    "annotate.1": {
      "data": "{'as':{'wh':338,'ht':478,...},'ce':'Se_','cn':[...]}"
    }
  },
  "isAnnotate": true,
  "doc": "/cet6/2025-12/01"
}
```

成功响应示例：

```json
{ "code": "0000", "msg": "success", "data": "<opaque-id>" }
```

加载响应示例结构：

```json
{
  "code": "0000",
  "msg": "success",
  "data": {
    "1": { "data": "{...压缩 Stage JSON...}" }
  }
}
```

### 5.5 压缩字段缩写（脚本 `qt` 映射）

| 缩写 | 含义 |
|------|------|
| `as` | attrs |
| `ce` | className |
| `cn` | children |
| `wh` / `ht` | width / height |
| `ps` | points |
| `se` / `sh` | stroke / strokeWidth |
| `br` | bgColor |
| `fi` | fill |
| `Se_` / `Lr` / `Le` / `Ie` / `Gp_` | Stage / Layer / Line / Image / Group |
| `lp` / `ln` / `tn` | lineCap / lineJoin / tension |
| `rd` | round |

### 5.6 节点类型与工具对应（观测 + 推断）

| 工具 | Konva 表现（已证实 / 推断） |
|------|------------------------------|
| 高亮 | `Image` + `br:{r,g,b}`（从 PDF 画布取样后着色）— **已证实** |
| 下划线 | 细 `Rect` + `fi` — **已证实** |
| 笔写 / 手指 | `Line` + `ps` 点列 — **脚本与空 Line 对象支持；完整笔迹样本未深测** |
| 文本输入 | FreeText / Text 相关 — **脚本有；未深测** |
| 橡皮擦 | 名为 `Eraser` 的 `Path`，`globalCompositeOperation` — **DOM 可见** |

### 5.7 保存管线（脚本推断 + 抓包印证）

1. 页 Stage `toJSON()`（可先临时移除橡皮节点）。  
2. `postMessage({ type: "backupData", data: { stageJSON, currentScale, _pageNumber, urlPath, … } })` 到 Worker。  
3. Worker 回 `backupData_ed`，带 `sdata` 与 `sendDataStr`。  
4. 主线程 `POST /api/data/update`，body 为 `sendDataStr`。  

坐标空间可在「原页尺寸」（如 1550×2193）与「显示尺寸」（如 338×478）之间经 `currentScale` 换算。

---

## 6. 锚定与持久化模型

### 已证实

- 标注绑定专业版账号与 `aStatus`。  
- 文档键：`urlPath` / `doc` = `location.pathname`（如 `/cet6/2025-12/01`）。  
- 页键：`annotate.{pageNumber}` 与 GET 响应的 `data["1"]` 等。  
- 渲染：页级 Konva overlay，不是 Markdown TextQuote / DOM `mark`。  
- 权威存储：服务端 annotate API；非免费 localStorage 独享。

### 推断

1. 锚定以 **页坐标矩形 / 墨迹点列** 为主，而非字符偏移 TextQuote。  
2. 高亮「贴字」来自对 PDF canvas 的取样着色，而非改 textLayer DOM。  
3. `aStatus`：`1`≈专业版标注可用；`3`≈不可用需升级；`2` 出现在其它 UI 着色（高级版相关），不完全确定。  
4. Worker（`read_zhenti_web_worker.js` 等）参与压缩与打包，细节未全文还原。

---

## 7. 可借鉴建议（对照 Reade）

对照基准：Reade 进行中的标注（`highlight` / `bookmark`、TextQuote、PDF `rects`、选区工具条、本地 / Web 存储）。

| 维度 | 真题在线 | Reade | 启发 |
|------|----------|-------|------|
| 载体 | 考试 PDF 原卷 | MD / EPUB / PDF | PDF 用页相对坐标 + overlay；MD 继续 TextQuote |
| 入口 | 常驻顶栏工具模式 | 选区浮动条 | 精读可并存：模式工具条 + 选区条 |
| 工具深度 | 高亮+下划线+文本+笔+手指 | 高亮+笔记+书签 | 对齐「卷面批注」可补下划线 / 墨迹；书签是差异化 |
| 颜色 | 每工具独立 4 色 + 偏好记忆 | 全局 4 色名 | 可按 kind 记住上次颜色 |
| 同步 | 账号云同步（付费） | 本地优先 | 本地产品用「文档相对路径 + 页码」即可类比键设计 |
| 清空 | 整卷一键清除 | 按条删除 | 「清除当前文档全部」+ 二次确认 |
| 门控 UX | 工具可见但讲解权益 | 直接可用 | 工具可见利于发现；本地无需付费墙 |

**风险**：对方声明 UI/源码受保护并反对抄袭界面；借鉴应停在交互规格与架构启发。真题 PDF / 答案等内容有版权，不可当作可复用素材。

---

## 8. 未知项与验证缺口

1. FreeText / 手指书写的完整交互与节点 schema 细节。  
2. 橡皮擦笔触宽度调节与擦除后的精确存盘时序。  
3. 「清除手写标注」确认流的实机验收（避免误清用户数据，未主动点确认）。  
4. 缩放 / 旋转后重锚定的边界情况。  
5. IndexedDB 是否缓存标注（本次以网络 API 为主）。  
6. 是否存在未暴露的标注列表 / 导出能力。

---

## 9. 权限与产品分层（已证实）

| 标志 | 含义（观测） |
|------|----------------|
| `winGlobal.p === 1` | 有效会员 |
| `winGlobal.p === 2` | 过期等（脚本有 `pro_expired` 等分支） |
| `docInfo.aStatus === 1` | 标注可用（与清除按钮注入条件一致） |
| `docInfo.aStatus === 3` | 免费态本页实测；点击工具走 annotate 功能介绍 |
| 专业版权益文案 | 手写、标注高亮（笔记云同步） |
| 高级版（约 9.9） | Pro 页未把标注列入该档权益 |

---

## 10. 参考

### 访问过的 URL

- https://zhenti.burningvocabulary.cn/cet6/2025-12/01  
- https://zhenti.burningvocabulary.cn/pro  
- https://zhenti.burningvocabulary.cn/pro?refPath=%2Fcet6%2F2025-12%2F01&from=featureTour  

### 关键静态资源

- `read_zhenti_detail.js`  
- `read_zhenti_detail_premium.js`  
- `read_zhenti_detail_annotate.js`（专业版）  
- `zhenti.viewer_2-14-316.js`  
- `read_zhenti_web_worker.js`  
- `annotate.mp4`（功能介绍演示）  

### 截图 / 请求摘要

- 免费态：顶栏工具 + 点击高亮 → 功能介绍弹层。  
- 专业版：工具条真彩色、「获取笔记中…」、页内黄高亮可见；`.annotate` Konva 层。  
- 网络：`GET …/get/annotate`、`POST …/update`（含 `isAnnotate`）；无凭证 / Cookie 值写入本文。  

### 调研伦理说明

- 第二轮使用用户本人专业版登录；未记录账号密码。  
- 自动化测试曾短暂写入多余高亮，已用测试前快照经同一 update 接口恢复第 1 页标注。  

---

## 11. 与 Reade 代码对照索引（仓库内）

便于后续落地时跳转：

- `src/lib/annotations.ts` — TextQuote、PDF rects、高亮 / 书签工厂  
- `src/lib/backend.ts` — `Annotation` / `AnnotationLocator` 类型与 IPC  
- `src/components/AnnotationUi.tsx` — 选区工具条与列表 UI  
- `src/lib/useDocumentAnnotations.ts` / `webAnnotations.ts` — 加载与持久化  

---

*文档生成自 Cursor 调研会话；仅供产品 / 技术方案对照，不构成对第三方实现的复制许可。*
