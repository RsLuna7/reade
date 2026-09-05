import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

export interface DocumentTreeMenuProps {
  x: number;
  y: number;
  pinned: boolean;
  canReset: boolean;
  canReveal: boolean;
  canMarkRead: boolean;
  markedRead: boolean;
  onPin: () => void;
  onUnpin: () => void;
  onReset: () => void;
  onReveal: () => void;
  onMarkRead: () => void;
  onUnmarkRead: () => void;
  onClose: () => void;
}

export function DocumentTreeMenu({
  x,
  y,
  pinned,
  canReset,
  canReveal,
  canMarkRead,
  markedRead,
  onPin,
  onUnpin,
  onReset,
  onReveal,
  onMarkRead,
  onUnmarkRead,
  onClose,
}: DocumentTreeMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const pad = 8;
    let left = x;
    let top = y;
    if (left + rect.width > window.innerWidth - pad) {
      left = window.innerWidth - pad - rect.width;
    }
    if (top + rect.height > window.innerHeight - pad) {
      top = window.innerHeight - pad - rect.height;
    }
    element.style.left = `${Math.max(pad, left)}px`;
    element.style.top = `${Math.max(pad, top)}px`;
  }, [x, y]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [onClose]);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
  }, []);

  const activate = (action: () => void) => {
    action();
    onClose();
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ?? [])];
    const index = items.indexOf(event.target as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length === 0) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next = items[(index + delta + items.length) % items.length];
      next?.focus();
    }
  };

  return createPortal(
    <div
      ref={ref}
      className="document-tree-menu reade-motion-panel"
      role="menu"
      aria-label="文档树操作"
      style={{ left: x, top: y }}
      onKeyDown={onMenuKeyDown}
    >
      {pinned ? (
        <button
          type="button"
          role="menuitem"
          className="document-tree-menu__item"
          onClick={() => activate(onUnpin)}
        >
          取消置顶
        </button>
      ) : (
        <button
          type="button"
          role="menuitem"
          className="document-tree-menu__item"
          onClick={() => activate(onPin)}
        >
          置顶
        </button>
      )}
      {canReveal ? (
        <button
          type="button"
          role="menuitem"
          className="document-tree-menu__item"
          onClick={() => activate(onReveal)}
        >
          在资源管理器中显示
        </button>
      ) : null}
      {canMarkRead ? (
        markedRead ? (
          <button
            type="button"
            role="menuitem"
            className="document-tree-menu__item"
            onClick={() => activate(onUnmarkRead)}
          >
            取消已阅
          </button>
        ) : (
          <button
            type="button"
            role="menuitem"
            className="document-tree-menu__item"
            onClick={() => activate(onMarkRead)}
          >
            已阅
          </button>
        )
      ) : null}
      {canReset ? (
        <button
          type="button"
          role="menuitem"
          className="document-tree-menu__item"
          onClick={() => activate(onReset)}
        >
          恢复此文件夹默认排序
        </button>
      ) : null}
    </div>,
    document.body,
  );
}
