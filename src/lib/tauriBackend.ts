import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  AssetPayload,
  DocumentInfo,
  SearchResult,
} from "./backend";

export async function chooseLibraryDirectory(): Promise<string | null> {
  const selection = await open({
    directory: true,
    multiple: false,
    title: "选择 Markdown 文档库",
  });

  return typeof selection === "string" ? selection : null;
}

export function openLibrary(rootPath: string): Promise<DocumentInfo[]> {
  return invoke<DocumentInfo[]>("open_library", { rootPath });
}

export function refreshLibrary(): Promise<DocumentInfo[]> {
  return invoke<DocumentInfo[]>("refresh_library");
}

export function readDocument(relativePath: string): Promise<string> {
  return invoke<string>("read_document", { relativePath });
}

export function searchDocuments(
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  return invoke<SearchResult[]>("search_documents", { query, limit });
}

export function readAsset(relativePath: string): Promise<AssetPayload> {
  return invoke<AssetPayload>("read_asset", { relativePath });
}

export function openExternalLink(href: string): Promise<void> {
  return openUrl(href);
}

export function onLibraryChanged(
  handler: () => void | Promise<void>,
): Promise<UnlistenFn> {
  return listen("library-changed", () => {
    void handler();
  });
}
