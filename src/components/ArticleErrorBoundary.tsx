import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Article-level error boundary for the reading pane.
 *
 * A single rendering/commit error inside the article subtree (markdown,
 * PDF or EPUB renderer) used to unmount the whole application into a white
 * screen, because no boundary existed anywhere. This boundary deliberately
 * wraps only the article content — chrome (sidebar, topbar, panels) never
 * needs it, and one boundary at the failure domain's border beats wrapping
 * every component.
 *
 * Recovery: React already unmounted the crashed subtree before the fallback
 * renders, so「重新载入文档」only has to leave the failed state and let the
 * children mount from scratch; `onRetry` additionally asks the app to
 * re-read the document from the backend. Switching to another document
 * (`resetKey` change) clears a sticky error automatically.
 */

interface ArticleErrorBoundaryProps {
  /** Document identity; a change auto-clears a previous rendering error. */
  resetKey: string | null;
  /** Invoked by the retry button, e.g. to re-read the document content. */
  onRetry?: () => void;
  children: ReactNode;
}

interface ArticleErrorBoundaryState {
  failed: boolean;
}

export class ArticleErrorBoundary extends Component<
  ArticleErrorBoundaryProps,
  ArticleErrorBoundaryState
> {
  state: ArticleErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ArticleErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("[reade] 正文渲染出错", error, info.componentStack);
  }

  componentDidUpdate(previous: ArticleErrorBoundaryProps): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  private readonly retry = (): void => {
    this.setState({ failed: false });
    this.props.onRetry?.();
  };

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="article-error-card" role="alert">
          <strong>文档渲染出错</strong>
          <p>
            本篇内容在渲染时出现异常，已停止显示以保护当前会话。可尝试重新载入文档，或切换到其他文档继续阅读。
          </p>
          <button type="button" onClick={this.retry}>
            重新载入文档
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
