import { Library, ListTree, Moon, MoreHorizontal, Search, Sun } from "lucide-react";

/**
 * Web 窄屏触控语境的底部工具条（docs/plan-web-mobile-gestures.md §3.2）。
 *
 * 仅 Web 运行时由 App 渲染（编译时守卫）；显隐再由 CSS 的
 * `(max-width: 640px) and (pointer: coarse)` 媒体查询 + `data-runtime`
 * 控制，桌面与宽窗零变化。「更多」直达命令面板——主题风格、阅读设置、
 * 朗读、分栏等其余动作全部收纳在那里。
 */
interface MobileToolbarProps {
  /** 向下滚动时半隐（滚动方向感知由 App 计算，MG-D3）。 */
  hidden: boolean;
  themeMode: "light" | "dark";
  /** 当前无文档时目录钮禁用。 */
  hasDocument: boolean;
  onOpenLibrary: () => void;
  onOpenToc: () => void;
  onFocusSearch: () => void;
  onToggleTheme: () => void;
  onOpenMore: () => void;
}

export function MobileToolbar({
  hidden,
  themeMode,
  hasDocument,
  onOpenLibrary,
  onOpenToc,
  onFocusSearch,
  onToggleTheme,
  onOpenMore,
}: MobileToolbarProps) {
  return (
    <nav className="mobile-toolbar" aria-label="移动端快捷工具条" data-hidden={hidden}>
      <button type="button" onClick={onOpenLibrary}>
        <Library size={19} aria-hidden="true" />
        <span>文档</span>
      </button>
      <button type="button" disabled={!hasDocument} onClick={onOpenToc}>
        <ListTree size={19} aria-hidden="true" />
        <span>目录</span>
      </button>
      <button type="button" onClick={onFocusSearch}>
        <Search size={19} aria-hidden="true" />
        <span>搜索</span>
      </button>
      <button
        type="button"
        aria-label={themeMode === "light" ? "切换到深色主题" : "切换到浅色主题"}
        onClick={onToggleTheme}
      >
        {themeMode === "light" ? (
          <Moon size={19} aria-hidden="true" />
        ) : (
          <Sun size={19} aria-hidden="true" />
        )}
        <span>主题</span>
      </button>
      <button type="button" aria-label="更多操作（命令面板）" onClick={onOpenMore}>
        <MoreHorizontal size={19} aria-hidden="true" />
        <span>更多</span>
      </button>
    </nav>
  );
}
