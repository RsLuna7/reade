import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Settings2 } from "lucide-react";

interface LibraryOption {
  value: string;
  label: string;
  group?: string;
}

interface LibraryDropdownProps {
  label: string;
  value: string;
  options: LibraryOption[];
  onChange: (value: string) => void;
  active?: boolean;
  scope?: boolean;
  action?: { label: string; onClick: () => void };
}

/** Shared radio menu for library scope, filters and sort; the footer is a separate action. */
export function LibraryDropdown({
  label, value, options, onChange, active = false, scope = false, action,
}: LibraryDropdownProps) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const typeahead = useRef({ text: "", time: 0 });
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 220, maxHeight: 360 });
  const selected = Math.max(0, options.findIndex((option) => option.value === value));
  const initialFocus = useRef(0);
  const restoreFocusOnClose = useRef(false);

  const close = (restoreFocus = false) => {
    restoreFocusOnClose.current = restoreFocus;
    setOpen(false);
  };

  const show = (index = selected) => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(Math.max(scope ? 244 : 200, rect.width), window.innerWidth - 24);
    const below = window.innerHeight - rect.bottom - 20;
    const above = rect.top - 20;
    const upwards = below < 200 && above > below;
    setPosition({
      left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
      top: upwards ? rect.top - 8 : rect.bottom + 8,
      width,
      maxHeight: Math.max(80, Math.min(360, upwards ? above : below)),
    });
    initialFocus.current = index;
    restoreFocusOnClose.current = false;
    typeahead.current = { text: "", time: 0 };
    // Direction is stored on the trigger so the portal can position without a second paint.
    trigger.current!.dataset.upwards = String(upwards);
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (open) items.current[initialFocus.current]?.focus();
    else if (restoreFocusOnClose.current) {
      restoreFocusOnClose.current = false;
      trigger.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
    };
    const onScroll = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  return (
    <>
      <button
        ref={trigger}
        id={`${id}-trigger`}
        type="button"
        className={`library-dropdown-trigger${scope ? " library-dropdown-trigger--scope" : ""}`}
        aria-label={`${label}：${options[selected]?.label ?? label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        data-active={active || undefined}
        onClick={() => open ? close(true) : show()}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            show(event.key === "ArrowUp" ? options.length - 1 : selected);
          }
        }}
      >
        <span title={options[selected]?.label}>{options[selected]?.label ?? label}</span>
        <ChevronDown size={15} strokeWidth={1.7} aria-hidden="true" />
      </button>
      {open && createPortal(
        <div
          ref={menu}
          id={`${id}-menu`}
          role="menu"
          aria-label={label}
          className="library-dropdown-menu"
          style={{ ...position, transform: trigger.current?.dataset.upwards === "true" ? "translateY(-100%)" : undefined }}
          onKeyDown={(event) => {
            const count = options.length + (action ? 1 : 0);
            const current = items.current.findIndex((item) => item === document.activeElement);
            let next: number | undefined;
            if (event.key === "ArrowDown") next = (current + 1) % count;
            if (event.key === "ArrowUp") next = (current - 1 + count) % count;
            if (event.key === "Home") next = 0;
            if (event.key === "End") next = count - 1;
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close(true);
            } else if (event.key === "Tab") {
              // Resume the normal tab order from the trigger, not the portal at body end.
              close();
              trigger.current?.focus();
            } else if (next !== undefined) {
              event.preventDefault();
              items.current[next]?.focus();
            } else if (event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.altKey && !event.metaKey) {
              const now = Date.now();
              const text = (now - typeahead.current.time < 600 ? typeahead.current.text : "") + event.key.toLocaleLowerCase();
              typeahead.current = { text, time: now };
              const query = [...text].every((char) => char === text[0]) ? text[0] : text;
              const labels = [...options.map((option) => option.label), ...(action ? [action.label] : [])];
              for (let step = 1; step <= count; step++) {
                const index = (current + step) % count;
                if (labels[index].toLocaleLowerCase().startsWith(query)) {
                  event.preventDefault();
                  items.current[index]?.focus();
                  break;
                }
              }
            }
          }}
        >
          {options.map((option, index) => (
            <Fragment key={option.value}>
              {option.group && option.group !== options[index - 1]?.group && (
                <div className="library-dropdown-group" role="presentation">{option.group}</div>
              )}
              <button
                ref={(element) => { items.current[index] = element; }}
                type="button"
                role="menuitemradio"
                aria-checked={option.value === value}
                tabIndex={-1}
                className="library-dropdown-option"
                onClick={() => { close(true); onChange(option.value); }}
              >
                <span>{option.label}</span>
                {option.value === value && <Check size={16} strokeWidth={1.8} aria-hidden="true" />}
              </button>
            </Fragment>
          ))}
          {action && (
            <div className="library-dropdown-footer" role="presentation">
              <button
                ref={(element) => { items.current[options.length] = element; }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="library-dropdown-option library-dropdown-action"
                onClick={() => { close(true); action.onClick(); }}
              >
                <Settings2 size={15} strokeWidth={1.7} aria-hidden="true" />
                <span>{action.label}</span>
              </button>
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
