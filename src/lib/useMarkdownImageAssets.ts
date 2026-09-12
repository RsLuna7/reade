/**
 * React hook behind the markdown local-image pipeline shared by the main
 * pane and the secondary pane: the asset-url map, sanitized inline-SVG
 * assets, per-image load failures, in-flight read dedupe, and batched
 * state writes.
 *
 * Why batching: each loaded asset used to call setState on its own, so a
 * document with dozens of images re-rendered the whole markdown subtree
 * (plus AnnotatedMarkdown's full-DOM text paint check) once per image.
 * Loads here coalesce into one flush per ~50ms burst instead.
 *
 * Library `.svg` files are never turned into data URLs (safeUrlTransform
 * rejects those by policy); they are decoded, run through the same
 * sanitizer as Mermaid output, and rendered as inline SVG instead.
 *
 * Generation guard: `reset` rebuilds the in-flight map, so reads that
 * settle after a document switch are dropped instead of leaking assets
 * into the next document's map under a same-named key.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { readAsset, assetDataUrl } from "./backend";
import {
  describeAssetLoadFailure,
  isSafeImageMimeType,
  normalizeMarkdownUrlKey,
} from "./markdownImages";
import { resolveLibraryPath } from "./documentLinks";
import { decodeBase64Text, sanitizeLibrarySvg } from "./mermaidSvg";

export interface MarkdownImageAssets {
  /** 归一化 src → data URL，供 resolveMarkdownImageSrc 查找。 */
  assetUrls: Record<string, string>;
  /** 归一化 src → 已消毒的内联 SVG 标记，供 resolveLocalSvg 查找。 */
  svgAssets: Record<string, string>;
  /** 归一化 src → 失败原因，供拦截占位符展示具体原因。 */
  imageErrors: Record<string, string>;
  /** 读取一张库内图片；预加载清单与渲染器按需兜底共用，幂等可重入。 */
  load: (documentPath: string, source: string) => void;
  /** 换文档/换内容时调用：作废在途读取并清空三张表。 */
  reset: () => void;
}

type PendingAssetWrite = { kind: "url"; url: string } | { kind: "svg"; markup: string };
const IMAGE_LOAD_CONCURRENCY = 4;

export function useMarkdownImageAssets(): MarkdownImageAssets {
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const [svgAssets, setSvgAssets] = useState<Record<string, string>>({});
  const [imageErrors, setImageErrors] = useState<Record<string, string>>({});
  /** (文档路径, 归一化 key) → 在途 readAsset；同一加载并发只发一次请求。 */
  const imageLoadsRef = useRef(new Map<string, Promise<void>>());
  const pendingWritesRef = useRef(new Map<string, PendingAssetWrite>());
  const flushTimerRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const activeLoadsRef = useRef(0);
  const queuedLoadsRef = useRef<Array<() => void>>([]);

  const recordImageError = useCallback((key: string, message: string, generation: number) => {
    if (!mountedRef.current || generation !== generationRef.current) return;
    setImageErrors((current) =>
      generation !== generationRef.current || current[key] === message
        ? current : { ...current, [key]: message },
    );
  }, []);

  const flushPendingWrites = useCallback((generation: number) => {
    if (!mountedRef.current || generation !== generationRef.current) return;
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const pending = pendingWritesRef.current;
    if (pending.size === 0) return;
    pendingWritesRef.current = new Map();
    const svgs = new Map<string, string>();
    const urls = new Map<string, string>();
    for (const [key, write] of pending) {
      if (write.kind === "svg") svgs.set(key, write.markup);
      else urls.set(key, write.url);
    }
    if (urls.size > 0) {
      const nextUrls = Object.fromEntries(urls);
      setAssetUrls((current) => {
        return generation === generationRef.current ? { ...current, ...nextUrls } : current;
      });
    }
    if (svgs.size > 0) {
      const nextSvgs = Object.fromEntries(svgs);
      setSvgAssets((current) => {
        return generation === generationRef.current ? { ...current, ...nextSvgs } : current;
      });
    }
  }, []);

  const scheduleFlush = useCallback((generation: number) => {
    if (generation !== generationRef.current) return;
    // 大批量(整文档图片几乎同时返回)直接冲刷；零散到达合并进 50ms 窗口。
    if (pendingWritesRef.current.size >= 16) {
      flushPendingWrites(generation);
      return;
    }
    if (flushTimerRef.current === null) {
      flushTimerRef.current = window.setTimeout(() => flushPendingWrites(generation), 50);
    }
  }, [flushPendingWrites]);

  const pumpLoadQueue = useCallback(() => {
    if (!mountedRef.current) return;
    while (
      activeLoadsRef.current < IMAGE_LOAD_CONCURRENCY &&
      queuedLoadsRef.current.length > 0
    ) {
      queuedLoadsRef.current.shift()?.();
    }
  }, []);

  const load = useCallback(
    (documentPath: string, source: string) => {
      if (!mountedRef.current) return;
      const generation = generationRef.current;
      const key = normalizeMarkdownUrlKey(source);
      const relativePath = resolveLibraryPath(source, documentPath);
      if (!relativePath) {
        recordImageError(key, "路径无法解析或越出文档库", generation);
        return;
      }
      const loadKey = `${documentPath}\u0000${key}`;
      if (imageLoadsRef.current.has(loadKey)) return;
      let resolveLoad!: () => void;
      const loadPromise = new Promise<void>((resolve) => {
        resolveLoad = resolve;
      });
      imageLoadsRef.current.set(loadKey, loadPromise);
      queuedLoadsRef.current.push(() => {
        if (generation !== generationRef.current) {
          if (imageLoadsRef.current.get(loadKey) === loadPromise) {
            imageLoadsRef.current.delete(loadKey);
          }
          resolveLoad();
          pumpLoadQueue();
          return;
        }
        activeLoadsRef.current += 1;
        void readAsset(relativePath)
          .then((asset) => {
            if (
              generation !== generationRef.current ||
              imageLoadsRef.current.get(loadKey) !== loadPromise
            ) return;
            if (asset.mimeType.trim().toLowerCase() === "image/svg+xml") {
              const markup = sanitizeLibrarySvg(decodeBase64Text(asset.data));
              if (markup) {
                pendingWritesRef.current.set(key, { kind: "svg", markup });
                scheduleFlush(generation);
              } else {
                recordImageError(key, "SVG 内容未通过安全检查", generation);
              }
              return;
            }
            if (!isSafeImageMimeType(asset.mimeType)) {
              recordImageError(key, `格式 ${asset.mimeType} 不在安全图片白名单内`, generation);
              return;
            }
            pendingWritesRef.current.set(key, { kind: "url", url: assetDataUrl(asset) });
            scheduleFlush(generation);
          })
          .catch((error: unknown) => {
            recordImageError(key, describeAssetLoadFailure(error), generation);
          })
          .finally(() => {
            if (imageLoadsRef.current.get(loadKey) === loadPromise) {
              imageLoadsRef.current.delete(loadKey);
            }
            activeLoadsRef.current -= 1;
            resolveLoad();
            pumpLoadQueue();
          });
      });
      pumpLoadQueue();
    },
    [pumpLoadQueue, recordImageError, scheduleFlush],
  );

  const reset = useCallback(() => {
    generationRef.current += 1;
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    pendingWritesRef.current = new Map();
    imageLoadsRef.current = new Map();
    queuedLoadsRef.current = [];
    setAssetUrls((current) => (Object.keys(current).length === 0 ? current : {}));
    setSvgAssets((current) => (Object.keys(current).length === 0 ? current : {}));
    setImageErrors((current) => (Object.keys(current).length === 0 ? current : {}));
  }, []);

  useEffect(
    () => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        generationRef.current += 1;
        if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
        pendingWritesRef.current = new Map();
        imageLoadsRef.current = new Map();
        queuedLoadsRef.current = [];
      };
    },
    [],
  );

  return { assetUrls, svgAssets, imageErrors, load, reset };
}
