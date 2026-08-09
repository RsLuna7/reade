import { WebLibraryClient } from "./webLibrary";

export interface DocumentInfo {
  relativePath: string;
  title: string;
  size: number;
  modified: number;
  isMdx: boolean;
}

export interface SearchResult {
  relativePath: string;
  title: string;
  snippet: string;
  score: number;
}

export interface LibrarySnapshot {
  rootPath: string;
  documents: DocumentInfo[];
}

export interface DocumentContent {
  relativePath: string;
  markdown: string;
}

export interface AssetPayload {
  relativePath: string;
  mimeType: string;
  data: string;
}

const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export const APP_RUNTIME = __READE_RUNTIME__;
export const DEFAULT_LIBRARY_ROOT =
  APP_RUNTIME === "web" ? "reade-web" : "";

type UnlistenFn = () => void;

const webLibrary = APP_RUNTIME === "web" ? new WebLibraryClient() : null;
let tauriBackendPromise: Promise<typeof import("./tauriBackend")> | null = null;

function getWebLibrary(): WebLibraryClient {
  if (!webLibrary) throw new Error("Web 文档库仅在 Web 构建中可用");
  return webLibrary;
}

function getTauriBackend(): Promise<typeof import("./tauriBackend")> {
  if (APP_RUNTIME === "web") {
    return Promise.reject(new Error("Tauri 后端在 Web 构建中不可用"));
  }
  tauriBackendPromise ??= import("./tauriBackend");
  return tauriBackendPromise;
}

export async function chooseLibraryDirectory(): Promise<string | null> {
  if (APP_RUNTIME === "web") return DEFAULT_LIBRARY_ROOT;
  return (await getTauriBackend()).chooseLibraryDirectory();
}

export async function openLibrary(rootPath: string): Promise<LibrarySnapshot> {
  if (APP_RUNTIME === "web") {
    const manifest = await getWebLibrary().loadManifest();
    return { rootPath: manifest.title, documents: manifest.documents };
  }
  const documents = await (await getTauriBackend()).openLibrary(rootPath);
  return { rootPath, documents };
}

export async function refreshLibrary(rootPath: string): Promise<LibrarySnapshot> {
  if (APP_RUNTIME === "web") {
    const client = getWebLibrary();
    client.clearCache();
    const manifest = await client.loadManifest(true);
    return { rootPath: manifest.title, documents: manifest.documents };
  }
  const documents = await (await getTauriBackend()).refreshLibrary();
  return { rootPath, documents };
}

export async function readDocument(relativePath: string): Promise<DocumentContent> {
  if (APP_RUNTIME === "web") {
    return getWebLibrary().loadDocument(relativePath);
  }
  const markdown = await (await getTauriBackend()).readDocument(relativePath);
  return { relativePath, markdown };
}

export async function searchDocuments(
  query: string,
  limit = 100,
): Promise<SearchResult[]> {
  if (APP_RUNTIME === "web") return getWebLibrary().search(query, limit);
  return (await getTauriBackend()).searchDocuments(query, limit);
}

export async function readAsset(relativePath: string): Promise<AssetPayload> {
  if (APP_RUNTIME === "web") return getWebLibrary().loadAsset(relativePath);
  return (await getTauriBackend()).readAsset(relativePath);
}

export function assetDataUrl(asset: AssetPayload): string {
  return `data:${asset.mimeType};base64,${asset.data}`;
}

export async function openExternalLink(href: string): Promise<void> {
  let url: URL;

  try {
    url = new URL(href);
  } catch {
    throw new Error("无法打开无效链接");
  }

  if (!ALLOWED_EXTERNAL_PROTOCOLS.has(url.protocol)) {
    throw new Error(`不允许打开 ${url.protocol} 链接`);
  }

  if (APP_RUNTIME === "web") {
    window.open(url.toString(), "_blank", "noopener,noreferrer");
    return;
  }
  await (await getTauriBackend()).openExternalLink(url.toString());
}

export async function onLibraryChanged(
  handler: () => void | Promise<void>,
): Promise<UnlistenFn> {
  if (APP_RUNTIME === "web") return () => undefined;
  return (await getTauriBackend()).onLibraryChanged(handler);
}
