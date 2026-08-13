/**
 * Service worker 注册守卫（docs/plan-web-pwa.md PW-D4）。
 *
 * 桌面排除发生在 bundle 级：main.tsx 以字面量 `__READE_RUNTIME__ === "web"`
 * 包住对本模块的调用，桌面构建里该分支被编译期常量折叠整体剔除——
 * 本文件的守卫只负责 web 构建内部的"生产 + 能力可用"判定。
 */

export interface ServiceWorkerRegistrationOptions {
  /** 仅生产构建注册（dev server 的模块图与 SW 缓存互相干扰）。 */
  isProduction: boolean;
  /** 应用版本，作为 sw.js 注册 URL 的 `?v=`，驱动壳缓存版本化。 */
  version: string;
}

/** 纯守卫：三个条件都满足才注册（可单测的真值表）。 */
export function shouldRegisterServiceWorker(
  runtime: string,
  isProduction: boolean,
  serviceWorkerAvailable: boolean,
): boolean {
  return runtime === "web" && isProduction && serviceWorkerAvailable;
}

/** 注册 URL：相对路径，scope 即部署子路径（Pages `/repo/` 兼容）。 */
export function serviceWorkerUrl(version: string): string {
  return `sw.js?v=${encodeURIComponent(version)}`;
}

/**
 * 页面 load 后注册（不与首屏抢带宽）。注册失败只失去离线能力，
 * 在线阅读不受影响，因此静默吞掉异常。
 */
export function registerReadeServiceWorker(
  options: ServiceWorkerRegistrationOptions,
): void {
  const available = typeof navigator !== "undefined" && "serviceWorker" in navigator;
  if (!shouldRegisterServiceWorker("web", options.isProduction, available)) return;
  window.addEventListener(
    "load",
    () => {
      navigator.serviceWorker.register(serviceWorkerUrl(options.version)).catch(() => {
        // 离线能力是渐进增强,注册失败不打扰阅读。
      });
    },
    { once: true },
  );
}
