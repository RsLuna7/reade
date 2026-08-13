/**
 * Read-only document links panel (docs/plan-backlinks.md §3.4, decision
 * BL-D3): the fourth side-panel tab. Backlinks grouped per source document
 * (title + first link text + mention count), outgoing links (documents jump
 * through `selectDocument`, assets and missing targets stay static, wiki
 * ambiguity shows the candidate count), plus the broken-link counter.
 *
 * Everything rendered here is untrusted document text — plain text nodes
 * only. Clicks never leave the library: the only navigation callback is
 * `onSelectDocument(path)` for targets present in the current scan.
 */

import type { DocumentLinks } from "../lib/backend";

export type LinksPanelState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: DocumentLinks };

export function LinksPanel({
  state,
  onSelectDocument,
  onPreviewTarget,
  onPreviewCancel,
}: {
  state: LinksPanelState;
  onSelectDocument: (relativePath: string) => void;
  /**
   * 悬停/聚焦预览意图(plan-hover-preview HP-D5):wiki 链接在阅读面按
   * 纯文本渲染,这里的出链/反链行是它们唯一的交互面。不挂时零变化。
   */
  onPreviewTarget?: (
    relativePath: string,
    anchor: HTMLElement,
    trigger: "hover" | "focus",
  ) => void;
  onPreviewCancel?: () => void;
}) {
  const previewHandlers = (relativePath: string) =>
    onPreviewTarget
      ? {
          onMouseEnter: (event: { currentTarget: HTMLElement }) =>
            onPreviewTarget(relativePath, event.currentTarget, "hover" as const),
          onMouseLeave: onPreviewCancel,
          onFocus: (event: { currentTarget: HTMLElement }) =>
            onPreviewTarget(relativePath, event.currentTarget, "focus" as const),
          onBlur: onPreviewCancel,
        }
      : {};
  if (state.status === "idle" || state.status === "loading") {
    return <p className="toc-empty">正在读取链接…</p>;
  }
  if (state.status === "error") {
    // Web >500 篇的降级文案(BL-D4)也走这里,原样呈现。
    return (
      <p className="toc-empty" role="status">
        {state.message}
      </p>
    );
  }

  const { backlinks, outgoing, brokenCount } = state.data;
  if (backlinks.length === 0 && outgoing.length === 0) {
    return <p className="toc-empty">本文档没有库内链接。</p>;
  }
  const backlinkTotal = backlinks.reduce((sum, entry) => sum + entry.count, 0);

  return (
    <div className="links-panel">
      {brokenCount > 0 && (
        <p className="links-panel-broken" role="status">
          {brokenCount} 条出链目标缺失（仅统计文档链接）
        </p>
      )}

      <section className="links-panel-section" aria-label="反向链接">
        <h3 className="links-panel-heading">
          反向链接
          {backlinkTotal > 0 ? <span className="side-panel-count">{backlinkTotal}</span> : null}
        </h3>
        {backlinks.length === 0 ? (
          <p className="toc-empty">还没有其他文档链接到本文档。</p>
        ) : (
          <ol className="links-panel-list">
            {backlinks.map((entry) => (
              <li key={entry.sourcePath}>
                <button
                  type="button"
                  className="links-panel-entry"
                  title={entry.sourcePath}
                  onClick={() => onSelectDocument(entry.sourcePath)}
                  {...previewHandlers(entry.sourcePath)}
                >
                  <span className="links-panel-entry-head">
                    <span className="links-panel-entry-title">{entry.sourceTitle}</span>
                    {entry.count > 1 ? (
                      <span className="side-panel-count">{entry.count}</span>
                    ) : null}
                  </span>
                  {entry.linkText ? (
                    <span className="links-panel-entry-excerpt">{entry.linkText}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="links-panel-section" aria-label="出链">
        <h3 className="links-panel-heading">
          出链
          {outgoing.length > 0 ? (
            <span className="side-panel-count">{outgoing.length}</span>
          ) : null}
        </h3>
        {outgoing.length === 0 ? (
          <p className="toc-empty">本文档没有指向库内的链接。</p>
        ) : (
          <ol className="links-panel-list">
            {outgoing.map((entry, index) => {
              const label = entry.linkText || entry.rawTarget;
              const clickable =
                entry.kind !== "asset" && entry.present && entry.targetPath !== null;
              return (
                <li key={`${entry.rawTarget}:${index}`}>
                  {clickable ? (
                    <button
                      type="button"
                      className="links-panel-entry"
                      title={entry.targetPath ?? entry.rawTarget}
                      onClick={() => onSelectDocument(entry.targetPath as string)}
                      {...previewHandlers(entry.targetPath as string)}
                    >
                      <span className="links-panel-entry-head">
                        <span className="links-panel-entry-title">{label}</span>
                        {entry.kind === "wiki" ? (
                          <span className="links-panel-tag">[[wiki]]</span>
                        ) : null}
                      </span>
                      <span className="links-panel-entry-excerpt">{entry.rawTarget}</span>
                    </button>
                  ) : (
                    <div
                      className="links-panel-entry links-panel-entry--static"
                      title={entry.rawTarget}
                    >
                      <span className="links-panel-entry-head">
                        <span className="links-panel-entry-title">{label}</span>
                        {entry.kind === "asset" ? (
                          <span className="links-panel-tag">资产</span>
                        ) : entry.ambiguousCount > 1 ? (
                          <span className="links-panel-tag">{entry.ambiguousCount} 个候选</span>
                        ) : (
                          <span className="links-panel-tag links-panel-tag--missing">
                            目标不在库中
                          </span>
                        )}
                      </span>
                      <span className="links-panel-entry-excerpt">{entry.rawTarget}</span>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}

export default LinksPanel;
