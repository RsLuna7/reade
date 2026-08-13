import { BellRing, X } from "lucide-react";

/**
 * 增量重读的驻留式横幅（plan-incremental-reread IR-D7）：既有 notice
 * 是 4.2s 瞬态 toast，承载不了循环跳转，所以单独做一条覆盖在
 * reading-frame 顶部的常驻条。"下一处"仅 markdown 段级 / EPUB 章级
 * 提供；"知道了"由 App 层负责确认并滚动快照。
 */
export interface RereadBannerProps {
  message: string;
  /** null 时不渲染"下一处"（PDF 页级 / truncated 降级）。 */
  onJump: (() => void) | null;
  onAcknowledge: () => void;
}

export function RereadBanner({ message, onJump, onAcknowledge }: RereadBannerProps) {
  return (
    <div className="reread-banner" role="status" aria-label="重读提示">
      <BellRing size={14} aria-hidden="true" />
      <span className="reread-banner-message">{message}</span>
      {onJump && (
        <button type="button" className="reread-banner-jump" onClick={onJump}>
          下一处
        </button>
      )}
      <button
        type="button"
        className="reread-banner-dismiss"
        onClick={onAcknowledge}
        aria-label="知道了，关闭重读提示"
      >
        <X size={13} aria-hidden="true" />
        知道了
      </button>
    </div>
  );
}

export default RereadBanner;
