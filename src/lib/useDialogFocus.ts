import { useEffect, type RefObject } from "react";

/** Focus the first control when a dialog opens; restore the opener on close. */
export function useDialogFocus(open: boolean, dialogRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = dialogRef.current;
    const focusable = root?.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();
    return () => {
      opener?.focus();
    };
  }, [open, dialogRef]);
}
