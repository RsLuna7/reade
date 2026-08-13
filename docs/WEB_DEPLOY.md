# Reade Web 部署到 GitHub Pages

Reade Web 是纯静态阅读站：Markdown 在构建时打包到 `dist`，浏览器端不连接 Tauri/Rust 后端，也不需要部署 API、数据库或文件服务。仓库内的 workflow 默认发布 `examples/demo-library`，便于先验证整条部署链路。

> GitHub Pages 上的构建产物可被访问者下载。只应部署允许公开的 Markdown 和图片；不要把私密文档、令牌、私有仓库凭据或未脱敏数据放进内容目录。生成器当前只复制 `.md`、`.markdown`、`.mdx` 与 AVIF/GIF/JPEG/PNG/WebP 图片，其他附件默认不发布。

## 默认配置

[`.github/workflows/deploy-pages.yml`](../.github/workflows/deploy-pages.yml) 在推送到 `main` 或手动触发时执行：

1. 使用 Node.js 24 和 pnpm 10；
2. 运行 `pnpm install --frozen-lockfile`；
3. 运行 `pnpm build:web`；
4. 把 `dist` 上传为 Pages artifact；
5. 通过 GitHub Pages environment 部署。

构建使用两个环境变量：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `READE_CONTENT_DIR` | `examples/demo-library` | Markdown 内容目录，相对于仓库根目录，也可以是绝对路径 |
| `READE_SITE_TITLE` | `Reade` | Web 站点标题 |

本地 PowerShell 验证示例：

```powershell
$env:READE_CONTENT_DIR = "examples/demo-library"
$env:READE_SITE_TITLE = "Reade"
pnpm install --frozen-lockfile
pnpm build:web
pnpm preview:web
```

构建完成后，最终可部署内容必须位于 `dist`。本地检查结束后可以移除当前终端中的临时变量：

```powershell
Remove-Item Env:READE_CONTENT_DIR
Remove-Item Env:READE_SITE_TITLE
```

## 选择内容来源

### 内容与 Reade 在同一仓库

把公开文档放在仓库内的固定目录，例如 `content`，然后只修改 workflow 的构建环境：

```yaml
env:
  READE_CONTENT_DIR: content
  READE_SITE_TITLE: 我的文档库
```

内容目录应随同应用代码提交。`pnpm build:web` 会在构建期读取该目录；Pages 运行时无法访问仓库中的其他文件或桌面上的本地文件夹。

### 使用独立内容仓库

如果内容有独立的发布节奏，可在安装依赖前增加第二个 checkout，并让 `READE_CONTENT_DIR` 指向其 checkout 目录：

```yaml
- name: Check out public content
  uses: actions/checkout@v5
  with:
    repository: owner/public-docs
    ref: main
    path: web-content

# Build Reade Web
env:
  READE_CONTENT_DIR: web-content
  READE_SITE_TITLE: 我的文档库
run: pnpm build:web
```

公开内容仓库可以使用默认 `GITHUB_TOKEN` 读取。读取私有内容仓库时，需要一个仅有目标仓库只读权限的 fine-grained token，并通过 repository secret 传给第二个 checkout 的 `token` 参数；不要把 token 写入 workflow 或 Markdown。无论源仓库是否私有，部署到公开 Pages 后，生成内容都应视为公开数据。

## 启用 GitHub Pages

1. 把本仓库推送到 GitHub，确认默认分支名称为 `main`；若不是，修改 workflow 的 `on.push.branches`。
2. 打开仓库的 **Settings → Pages**。
3. 在 **Build and deployment → Source** 选择 **GitHub Actions**。
4. 打开 **Actions**，运行 **Deploy Reade Web to GitHub Pages**，或向 `main` 推送一次提交。
5. 首次部署完成后，从 workflow 的 `deploy` job 或 **Settings → Pages** 打开站点地址。

仓库需允许 GitHub Actions 运行；组织策略或 `github-pages` environment 的保护规则可能要求人工批准部署。项目 Pages 通常位于 `https://<owner>.github.io/<repository>/`，用户/组织主页仓库则通常位于站点根路径。

GitHub 官方配置说明：[Configuring a publishing source for your GitHub Pages site](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)。

## PWA 与离线阅读

Web 版是可安装的 PWA：构建产物自带 `sw.js`（手写 service worker，零运行时依赖）、`reade.webmanifest` 与两枚图标，全部为静态文件，随 `dist` 一并部署，无需额外配置。行为要点：

- service worker 只在生产构建注册（`sw.js?v=<应用版本>`，相对路径注册，scope 即 Pages 子路径）；桌面版不注册。
- 缓存策略：页面导航 network-first（离线回落缓存的应用壳）；带内容哈希的构建资源 cache-first；`reade-web/**`（manifest/search/文档/图片）stale-while-revalidate，访问过的文档离线可读，内容缓存条目上限 200。
- 版本更新：`package.json` 的 `version` 变化会改变注册 URL，新 worker 激活时把旧版应用壳缓存迁移到新缓存后清理；更新后的首次在线访问自动换到新版。
- 离线时打开未缓存过的文档会提示「联网打开一次后即可离线阅读」，不会静默失败。

部署 PWA 变更后的验证（本地也可先验证：`pnpm build:web` 后用静态服务器把 `dist` 挂在子路径上模拟 Pages）：

1. 打开站点，DevTools → Application → Service Workers 确认 worker 已激活、scope 为站点子路径；
2. Application → Cache Storage 应出现 `reade-shell-v<版本>` 与 `reade-content-v1`；
3. 浏览一两篇文档后断网（DevTools Network → Offline）刷新：应用壳与读过的文档仍可打开，未读过的文档给出离线提示；
4. 需要强制所有访问者刷新应用壳时，提升 `package.json` 的 `version` 并重新部署（回滚场景同理：revert 后如缓存行为异常，bump 版本即可强制换壳）。

## 部署验证

每次部署至少检查：

- `build` 与 `deploy` 两个 job 均成功，artifact 上传目录确实为 `dist`；
- Pages 地址和刷新后的入口页面均能打开，没有资源路径 404；
- 左侧文档树能列出预期文件，默认示例库至少包含 README、长文阅读和检索说明；
- 文档切换、目录定位、全文搜索、主题切换正常；
- 公式、代码块、Mermaid 和图片按内容库实际用法抽样验证；
- 浏览器 Network 面板没有指向本机、Tauri IPC 或私有内容源的请求；
- 用无登录的隐私窗口打开站点，确认公开访问效果与内容暴露范围符合预期。

GitHub Pages 只负责托管本次 artifact。内容更新、索引更新和站点标题变化都需要重新运行构建部署；它不是动态 Markdown 后端，也不会监视桌面文件夹。

## 回滚

优先采用可审计的源码回滚：

1. 找到最后一个正常部署对应的 commit；
2. 对错误变更执行 `git revert`，不要改写共享分支历史；
3. 将 revert commit 推送到 `main`，等待 workflow 生成并部署新 artifact；
4. 按上面的部署验证清单复查。

如果问题来自暂时性的 GitHub Actions/Pages 故障，可在 Actions 页面重新运行最后一个正常 commit 对应的 workflow。重新运行会使用该次 workflow 的 commit 与配置，但仍应检查生成 artifact，而不要仅凭 job 变绿判断内容正确。紧急停止公开访问时，可以在 **Settings → Pages** 取消发布；这会下线站点，不等同于恢复旧版本。
