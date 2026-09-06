// D12：从 App.tsx 提取的通知组件（行为/hook 顺序不变，仅移动）。
import { useCallback, useEffect, useRef } from "react";
import { AlertCircle, ShieldCheck, X } from "lucide-react";
import { cancelMotion, runMotion, type ReaderMotionLevel } from "../lib/motion";

export function MotionNotice({
  id,
  message,
  kind = "status",
  motionLevel,
  autoDismiss = false,
  actionLabel,
  onAction,
  onClose,
}: {
  id: number | string;
  message: string;
  kind?: "status" | "error";
  motionLevel: ReaderMotionLevel;
  autoDismiss?: boolean;
  actionLabel?: string;
  onAction?: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closingRef = useRef(false);

  const closeWithMotion = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    const element = ref.current;
    if (!element || motionLevel === "off") {
      onClose();
      return;
    }
    const scale = motionLevel === "full" ? 0.98 : 0.99;
    const animation = runMotion(
      element,
      "notice-exit",
      [
        { opacity: 1, transform: "scale(1)" },
        { opacity: 0, transform: `scale(${scale})` },
      ],
      {
        duration: motionLevel === "full" ? 220 : 180,
        easing: "cubic-bezier(0.4, 0, 1, 1)",
        fill: "forwards",
      },
      motionLevel,
    );
    if (!animation) {
      onClose();
      return;
    }
    void animation.finished.then(onClose).catch(() => undefined);
  }, [motionLevel, onClose]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    closingRef.current = false;
    const scale = motionLevel === "full" ? 0.98 : 0.99;
    runMotion(
      element,
      "notice-enter",
      [
        { opacity: 0, transform: `scale(${scale})` },
        { opacity: 1, transform: "scale(1)" },
      ],
      {
        duration: motionLevel === "full" ? 220 : 180,
        easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      },
      motionLevel,
    );
    return () => cancelMotion(element);
  }, [id, motionLevel]);

  useEffect(() => {
    if (!autoDismiss) return;
    const timer = window.setTimeout(closeWithMotion, 4200);
    return () => window.clearTimeout(timer);
  }, [autoDismiss, closeWithMotion, id]);

  return (
    <div ref={ref} className={`notice${kind === "error" ? " error" : ""}`} role={kind === "error" ? "alert" : "status"}>
      {kind === "error" ? <AlertCircle size={17} aria-hidden="true" /> : <ShieldCheck size={17} aria-hidden="true" />}
      <span>{message}</span>
      {onAction && actionLabel && (
        <button
          className="notice-action"
          type="button"
          onClick={() => {
            onAction();
            closeWithMotion();
          }}
        >
          {actionLabel}
        </button>
      )}
      {kind === "error" && (
        <button className="icon-button" type="button" onClick={closeWithMotion} aria-label="关闭错误提示">
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
