import { useEffect, useRef } from "react";
import { ArrowRight, X } from "lucide-react";
import type { DocumentFormat } from "../lib/backend";
import { cancelMotion, runMotion, type ReaderMotionLevel } from "../lib/motion";
import { READ_NEXT_REASON_LABEL, type ReadNextReason } from "../lib/readNext";

/**
 * 读完接着读的轻卡片（plan-read-next §3.2）：fixed 右下、与朗读条同
 * 区位（朗读中由 App 不渲染本组件）；主按钮打开、次按钮关闭（本文档
 * 会话内不再出现）。
 */
export function ReadNextCard({
  title,
  format,
  reason,
  estimate,
  motionLevel,
  onOpen,
  onDismiss,
}: {
  title: string;
  format: DocumentFormat;
  reason: ReadNextReason;
  /** 阅读时长预估文案（如「约 4 分钟」）；无预估时为 null。 */
  estimate: string | null;
  motionLevel: ReaderMotionLevel;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    runMotion(
      element,
      "read-next-enter",
      [
        { opacity: 0, transform: "translateY(8px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      {
        duration: motionLevel === "full" ? 240 : 180,
        easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      },
      motionLevel,
    );
    return () => cancelMotion(element);
  }, [motionLevel]);

  return (
    <div
      ref={rootRef}
      className="read-next-card"
      role="complementary"
      aria-label="接着读推荐"
    >
      <div className="read-next-head">
        <span className="read-next-reason">{READ_NEXT_REASON_LABEL[reason]}</span>
        <button
          className="icon-button read-next-dismiss"
          type="button"
          aria-label="关闭推荐（本文档本次会话不再出现）"
          title="关闭推荐"
          onClick={onDismiss}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <p className="read-next-lead">读完了，接着读：</p>
      <button className="read-next-open" type="button" onClick={onOpen}>
        <span className="read-next-title">{title}</span>
        <span className="read-next-meta">
          <span className="read-next-format">
            {format === "markdown" ? "MD" : format.toUpperCase()}
          </span>
          {estimate && <span className="read-next-estimate">{estimate}</span>}
          <ArrowRight size={14} aria-hidden="true" />
        </span>
      </button>
    </div>
  );
}
