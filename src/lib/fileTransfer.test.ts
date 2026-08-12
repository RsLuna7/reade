// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadTextFile, MAX_IMPORT_FILE_BYTES, pickTextFile } from "./fileTransfer";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("downloadTextFile", () => {
  it("clicks a temporary anchor pointing at a blob of the contents", () => {
    const createObjectURL = vi.fn((_blob: Blob) => "blob:fake-url");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    downloadTextFile("reade-annotations.json", "{}", "application/json");

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe("application/json");
    expect(click).toHaveBeenCalledTimes(1);
    // The anchor cleans itself up.
    expect(document.querySelector("a")).toBeNull();
  });
});

describe("pickTextFile", () => {
  function pickerInput(): HTMLInputElement {
    const input = document.querySelector<HTMLInputElement>("input[type=file]");
    if (!input) throw new Error("file input missing");
    return input;
  }

  function setFiles(input: HTMLInputElement, files: File[]): void {
    Object.defineProperty(input, "files", {
      configurable: true,
      value: files,
    });
  }

  it("resolves the file name and text on selection", async () => {
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    const promise = pickTextFile({ accept: ".json" });
    const input = pickerInput();
    expect(input.accept).toBe(".json");
    setFiles(input, [new File(["{\"a\":1}"], "backup.json", { type: "application/json" })]);
    input.dispatchEvent(new Event("change"));
    await expect(promise).resolves.toEqual({ fileName: "backup.json", contents: '{"a":1}' });
    expect(document.querySelector("input[type=file]")).toBeNull();
  });

  it("resolves null when the picker is cancelled", async () => {
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    const promise = pickTextFile();
    pickerInput().dispatchEvent(new Event("cancel"));
    await expect(promise).resolves.toBeNull();
    expect(document.querySelector("input[type=file]")).toBeNull();
  });

  it("rejects oversized files before reading them", async () => {
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    const promise = pickTextFile();
    const input = pickerInput();
    const oversized = new File(["x"], "huge.json");
    Object.defineProperty(oversized, "size", { value: MAX_IMPORT_FILE_BYTES + 1 });
    const text = vi.spyOn(oversized, "text");
    setFiles(input, [oversized]);
    input.dispatchEvent(new Event("change"));
    await expect(promise).rejects.toThrow(/过大/);
    expect(text).not.toHaveBeenCalled();
  });
});
