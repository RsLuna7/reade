<div align="center">
  <img src="docs/screenshots/logo.png" alt="Reade" width="96" height="96">
  <h1>Reade</h1>
  <p><strong>本地优先的 Windows 长文阅读器。</strong></p>
  <p>把装着 Markdown、PDF 与 EPUB 的文件夹交给它。<br>三栏阅读、划线标注、间隔回顾 —— 没有账号，文档也不会离开你的电脑。</p>
  <p>
    <a href="https://github.com/RsLuna7/reade/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/RsLuna7/reade?style=flat-square"></a>
    <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20x64-0078D4?style=flat-square">
    <img alt="Local-first" src="https://img.shields.io/badge/local--first-no%20cloud-2ea44f?style=flat-square">
    <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/RsLuna7/reade?style=flat-square"></a>
  </p>
  <p>
    <a href="https://github.com/RsLuna7/reade/releases/latest"><strong>下载 Windows 版</strong></a>
    ·
    <a href="docs/USER_GUIDE.md">使用说明</a>
    ·
    <a href="README.md">English</a>
  </p>
</div>

<p align="center">
  <img src="docs/screenshots/reading-light.png" alt="Reade 浅色主题阅读界面" width="920">
</p>

## 为什么是 Reade

大多数电子书应用要的是书库、账号和同步。Reade 要的是一个**文件夹**。

指向你已经在用的论文、笔记和书籍目录。它会发现 Markdown、PDF 与可重排 EPUB，然后让开：左边文档树，中间正文，右边章节目录。排版针对中文和英文长文——栏宽、行高、段距——而不是信息流式的扫读。

标注、回顾和阅读统计留在本机 SQLite。Reade 不改写你的原文件，也不会把它们传上云。

## 开始用

1. 从 [Releases](https://github.com/RsLuna7/reade/releases/latest) 下载 Windows 安装包，并核对 SHA-256。
2. 打开 Reade，选择一个装着 `.md`、`.pdf` 或 `.epub` 的文件夹（`Ctrl+O`）。
3. 点一篇文档。文档树、正文和目录已经各就各位。

## 能力一览

| | 你会得到 |
| --- | --- |
| **读你已经有的格式** | `.md` / `.markdown` / `.mdx`、PDF（原版式）、可重排 EPUB。打开文件夹即可递归发现。 |
| **三栏长文布局** | 文档库、正文、目录各自滚动。窗口变窄时侧栏收进按钮，不把正文挤扁。 |
| **检索不挡阅读** | 后台增量 SQLite FTS5 索引。文件树先出现，全文检索随后赶上。 |
| **标注不上云** | 高亮、下划线、短笔记、书签。间隔回顾和挖空闪卡只作用于你主动加入的摘录。 |
| **记得住，而不是堆着** | 金句卡片、PDF 区域引用卡、全书回顾、月度阅读报告、「那年今日」。全部本机渲染。 |
| **读长文也不迷路** | 滚动条旁的文档地图、命令面板（`Ctrl+P`）、阅读回退栈（`Alt+←/→`）、相关段落、合集与封面书架。 |
| **默认私密** | 无账号、无遥测、无自动更新联网。远程图片默认拦截；不执行 raw HTML。 |

<details>
<summary><strong>当前版本里还有</strong></summary>

- GFM、脚注、KaTeX、Shiki，以及懒加载的 Mermaid（strict，输出经消毒后内联）
- 聚焦模式：段落聚焦、打字机滚动、阅读标尺
- 分栏对照阅读
- 实验性竖排（Markdown / EPUB）
- 浅色 / 深色主题，完整动效档下可开墨水扩散过渡
- 封面书架（PDF 首页、EPUB 书内封面、Markdown 生成式封面）
- 阅读统计里的库覆盖率 treemap
- 链接悬停预览与只读双链（含 `[[wiki]]`）
- 可选的静态 Web 构建：把**允许公开**的 Markdown 发布到 GitHub Pages

日常用法见 [使用说明](docs/USER_GUIDE.md)。本页是产品橱窗，不是功能流水账。

</details>

## 截图

<p align="center">
  <img src="docs/screenshots/reading-dark.png" alt="Reade 深色主题阅读界面" width="920">
  <br>
  <em>深色主题：同样的三栏布局</em>
</p>

## 下载

当前版本是 **Reade 0.2.0**，面向 **Windows 10/11 x64**。

1. 从 **[Releases](https://github.com/RsLuna7/reade/releases/latest)** 下载 `Reade_0.2.0_x64-setup.exe`。
2. 运行前核对 SHA-256：

   ```
   5E75445D723BF41022473D1C1FF0523CFB1ADCC7DC8BE795EFF46B8CED37C32F
   ```

3. 需要 Microsoft Edge **WebView2**。大多数 Windows 10/11 已自带。

安装包**没有代码签名**，也**没有自动更新**。Windows SmartScreen 可能提示未知发布者。只有哈希一致、并且你信任本仓库时，才选择继续。

## 隐私

- 文档留在你选择的文件夹里。Reade 只读，不会把书库拷到云上。
- 标注、合集、回顾存在应用数据目录的本地 SQLite，不写入文档库。
- 检索文本是可随时删除的派生缓存，清缓存不会碰到标注和统计。
- 外链需确认后才打开。远程图片默认不请求，除非你允许 HTTPS。
- 没有账号，没有分析，也没有「登录后同步」。

## 文档

- [使用说明](docs/USER_GUIDE.md) — 安装、打开书库、阅读、检索、标注与设置
- [Web 发布](docs/WEB_DEPLOY.md) — 把你愿意公开的 Markdown 建成静态站

桌面版才是产品。Web 构建是冻结的静态发布器，不是第二个 App。

## 本地开发

前置：Node.js 24、pnpm、Rust stable、WebView2，以及 Tauri 2 所需的 Windows C++ build tools。

```powershell
pnpm install
pnpm test
pnpm tauri dev
```

```powershell
pnpm tauri build          # Windows x64 NSIS 安装包
pnpm typecheck
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

技术栈：Tauri 2 / Rust，React 19 / TypeScript / Zustand，PDF.js，以及不执行书内 HTML/CSS 的 EPUB 路径。前端统一走 `src/lib/backend.ts`；文件读取使用相对路径，Rust canonicalize 后确认仍在当前书库内。

示例阅读库：`examples/demo-library`。

## 当前限制

- 目前只有 Windows x64。还没有 macOS、Linux 或移动端。
- EPUB 仅可重排。不支持 DRM、密码 PDF、fixed-layout 与书内 SVG。
- 不做 OCR、打印或 Office 转换。扫描 PDF 会标明缺文本，而不是假装读全了。
- 文档大幅改动后，部分高亮可能定位失效。支持按文档清空与会话内撤销，没有云端对账。
- 安装包未签名。

## 许可证

[MIT](LICENSE)
