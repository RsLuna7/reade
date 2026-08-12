/**
 * Browser-side file IO for the annotation transfer (§5.7): Blob download
 * for exports, a transient `<input type="file">` for imports. Only the Web
 * build uses these; the desktop build drives native dialogs from Rust
 * (`src-tauri/src/transfer.rs`) so no path ever crosses the IPC boundary.
 */

/** Same read cap as the desktop import command (32 MiB). */
export const MAX_IMPORT_FILE_BYTES = 32 * 1024 * 1024;

/** Triggers a Blob download via a temporary object URL (quote card PNGs, …). */
export function downloadBlobFile(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    // Chromium keeps the download alive after revocation; deferring one
    // task avoids racing slower engines.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** Triggers a text download via a temporary object URL. */
export function downloadTextFile(fileName: string, contents: string, mimeType: string): void {
  downloadBlobFile(fileName, new Blob([contents], { type: mimeType }));
}

export interface PickedTextFile {
  fileName: string;
  contents: string;
}

export interface PickTextFileOptions {
  /** `accept` attribute for the file input (e.g. ".json,application/json"). */
  accept?: string;
  maxBytes?: number;
}

/**
 * Opens the browser file picker and resolves with the chosen file's text,
 * `null` when the dialog is dismissed (the `cancel` event, supported by
 * every WebView2/Chromium/Firefox/Safari version Reade targets). Oversized
 * files reject before any content is read.
 */
export function pickTextFile(options: PickTextFileOptions = {}): Promise<PickedTextFile | null> {
  const maxBytes = options.maxBytes ?? MAX_IMPORT_FILE_BYTES;
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    if (options.accept) input.accept = options.accept;
    input.style.display = "none";
    const cleanup = () => input.remove();
    input.addEventListener("change", () => {
      const file = input.files?.[0] ?? null;
      cleanup();
      if (!file) {
        resolve(null);
        return;
      }
      if (file.size > maxBytes) {
        reject(new Error(`导入文件过大（上限 ${Math.floor(maxBytes / (1024 * 1024))} MiB）`));
        return;
      }
      file.text().then(
        (contents) => resolve({ fileName: file.name, contents }),
        (cause) => reject(cause instanceof Error ? cause : new Error(String(cause))),
      );
    });
    input.addEventListener("cancel", () => {
      cleanup();
      resolve(null);
    });
    document.body.appendChild(input);
    input.click();
  });
}
