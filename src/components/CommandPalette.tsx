/**
 * 命令面板浮层（docs/plan-command-palette.md §3.2）：`Ctrl+P` 呼出的
 * 居中 dialog，单输入框 + 结果列表。匹配与排序在 src/lib/commandPalette
 * 的纯函数里；本组件只管 combobox/listbox 键盘交互与渲染。
 *
 * Esc 在此处 stopPropagation 后关闭——不触发 App 全局 Esc 链的其余职责
 * （停朗读、关抽屉等）。条目执行交给 onExecute（App 分发），面板自身
 * 不持有任何动作逻辑。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import {
  filterPaletteEntries,
  type PaletteEntry,
} from "../lib/commandPalette";

export interface CommandPaletteProps<T extends PaletteEntry> {
  open: boolean;
  /** 全部候选（App 已按 文档 → 合集 → 命令 排好默认顺序）。 */
  entries: readonly T[];
  onExecute: (entry: T) => void;
  onClose: () => void;
}

export function CommandPalette<T extends PaletteEntry>({
  open,
  entries,
  onExecute,
  onClose,
}: CommandPaletteProps<T>) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const results = useMemo(
    () => filterPaletteEntries(entries, query),
    [entries, query],
  );
  const activeEntry = results[Math.min(activeIndex, results.length - 1)] ?? null;

  // 打开即重置并聚焦；关闭时状态自然丢弃（条件渲染）。
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    inputRef.current?.focus();
  }, [open]);

  // 结果集变化后选中项夹紧到范围内。
  useEffect(() => {
    setActiveIndex((current) =>
      results.length === 0 ? 0 : Math.min(current, results.length - 1),
    );
  }, [results.length]);

  useEffect(() => {
    if (!open || !activeEntry) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(activeEntry.id)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeEntry, open]);

  if (!open) return null;

  const moveActive = (delta: 1 | -1) => {
    if (results.length === 0) return;
    setActiveIndex((current) => {
      const base = Math.min(current, results.length - 1);
      return (base + delta + results.length) % results.length;
    });
  };

  return (
    <>
      <button
        className="command-palette-backdrop reade-motion-backdrop"
        type="button"
        aria-label="关闭命令面板"
        onClick={onClose}
      />
      <div
        className="command-palette reade-motion-panel"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
      >
        <div className="command-palette-input-row">
          <Search size={15} aria-hidden="true" />
          <input
            ref={inputRef}
            className="command-palette-input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-listbox"
            aria-activedescendant={
              activeEntry ? `palette-option-${activeEntry.id}` : undefined
            }
            aria-label="搜索文档、合集与命令"
            placeholder="搜索文档、合集与命令…"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveActive(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveActive(-1);
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (activeEntry) onExecute(activeEntry);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onClose();
              }
            }}
          />
          <span className="command-palette-hint" aria-hidden="true">
            Esc 关闭
          </span>
        </div>
        <ul
          className="command-palette-results"
          role="listbox"
          id="command-palette-listbox"
          aria-label="匹配结果"
          ref={listRef}
        >
          {results.length === 0 && (
            <li className="command-palette-empty" role="status">
              没有匹配的条目
            </li>
          )}
          {results.map((entry, index) => (
            <li
              key={entry.id}
              id={`palette-option-${entry.id}`}
              data-entry-id={entry.id}
              role="option"
              aria-selected={entry === activeEntry}
              className={`command-palette-option${
                entry === activeEntry ? " active" : ""
              }`}
              onPointerMove={() => setActiveIndex(index)}
              onClick={() => onExecute(entry)}
            >
              <span
                className={`command-palette-badge command-palette-badge--${entry.kind}`}
                aria-hidden="true"
              >
                {entry.badge ?? ""}
              </span>
              <span className="command-palette-title">{entry.title}</span>
              {entry.subtitle && (
                <span className="command-palette-subtitle">{entry.subtitle}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
