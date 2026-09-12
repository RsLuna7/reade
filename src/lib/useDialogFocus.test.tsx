// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useRef, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useDialogFocus } from "./useDialogFocus";

function DialogHost() {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(open, dialogRef);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        打开
      </button>
      <div ref={dialogRef} role="dialog" hidden={!open}>
        <button type="button" onClick={() => setOpen(false)}>
          关闭
        </button>
      </div>
    </div>
  );
}

describe("useDialogFocus", () => {
  it("moves focus into the dialog and restores the opener on close", () => {
    render(<DialogHost />);
    const opener = screen.getByRole("button", { name: "打开" });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole("button", { name: "关闭" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(opener).toHaveFocus();
  });
});
