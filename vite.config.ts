import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// App version for the annotation export "generator" field (reade/<version>).
const packageVersion: string = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
).version;

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/**
 * Ship src/theme-boot.ts as its own tiny entry chunk that executes before the
 * main bundle. Vite merges every <script type="module"> it finds in
 * index.html into a single page entry, which would make the pre-paint theme
 * boot wait for the whole app bundle on a cold start. A separate rollup input
 * plus an injected head script keeps it independent; the injected tag stays a
 * same-origin external module, so the desktop CSP (`script-src 'self'`)
 * remains untouched.
 */
function themeBootPlugin(): Plugin {
  let base = "/";
  return {
    name: "reade:theme-boot",
    config(_config, env) {
      if (env.command !== "build") return;
      return {
        build: {
          rollupOptions: {
            input: {
              index: fileURLToPath(new URL("./index.html", import.meta.url)),
              "theme-boot": fileURLToPath(
                new URL("./src/theme-boot.ts", import.meta.url),
              ),
            },
          },
        },
      };
    },
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        // Dev serves the TypeScript source directly; builds reference the
        // emitted hashed chunk (base-aware for the Pages sub-path deploy).
        let bootSrc = "/src/theme-boot.ts";
        if (ctx.bundle) {
          let fileName: string | undefined;
          for (const output of Object.values(ctx.bundle)) {
            if (
              output.type === "chunk" &&
              output.isEntry &&
              typeof output.facadeModuleId === "string" &&
              output.facadeModuleId.replace(/\\/g, "/").endsWith("/src/theme-boot.ts")
            ) {
              fileName = output.fileName;
              break;
            }
          }
          if (!fileName) {
            throw new Error("reade:theme-boot: boot chunk missing from the build output");
          }
          bootSrc = `${base}${fileName}`;
        }
        return [
          {
            tag: "script",
            attrs: { type: "module", crossorigin: true, src: bootSrc },
            injectTo: "head-prepend",
          },
        ];
      },
    },
  };
}

/**
 * Web 构建注入 PWA 安装元数据（docs/plan-web-pwa.md）：`<link rel="manifest">`
 * 只进 web 模式的 index.html，桌面构建的页面保持不变（sw.js/webmanifest
 * 作为 public 静态文件会被两种构建拷贝，但桌面 bundle 不含注册代码，
 * 也没有引用它们的标签）。相对 href 与 Vite 相对 base 一致，兼容 Pages
 * 子路径部署。
 */
function webManifestPlugin(mode: string): Plugin {
  return {
    name: "reade:web-manifest",
    transformIndexHtml: {
      order: "post",
      handler() {
        if (mode !== "web") return [];
        return [
          {
            tag: "link",
            attrs: { rel: "manifest", href: "reade.webmanifest" },
            injectTo: "head",
          },
        ];
      },
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => ({
  plugins: [react(), themeBootPlugin(), webManifestPlugin(mode)],
  // Relative asset URLs work for both user sites and project sites such as /reade/.
  base: mode === "web" ? "./" : undefined,
  define: {
    __READE_RUNTIME__: JSON.stringify(mode === "web" ? "web" : "desktop"),
    __READE_VERSION__: JSON.stringify(packageVersion),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
