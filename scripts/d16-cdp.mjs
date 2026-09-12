#!/usr/bin/env node
/**
 * D16 helper: evaluate JS in the running Tauri WebView2 via CDP.
 * Requires WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
 *
 *   node scripts/d16-cdp.mjs eval "1+1"
 *   node scripts/d16-cdp.mjs open "D:/path/to/library"
 *   node scripts/d16-cdp.mjs screenshot output/hardening/d16/welcome.png
 */
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.READE_CDP_PORT || 9222);
const BASE = `http://127.0.0.1:${PORT}`;

async function listTargets() {
  const response = await fetch(`${BASE}/json/list`);
  if (!response.ok) {
    throw new Error(`CDP list failed: ${response.status}`);
  }
  return response.json();
}

async function waitForTarget(timeoutMs = 60_000) {
  const started = Date.now();
  let lastError = "no target";
  while (Date.now() - started < timeoutMs) {
    try {
      const targets = await listTargets();
      const page = targets.find((target) => target.type === "page") ?? targets[0];
      if (page?.webSocketDebuggerUrl) {
        return page;
      }
      lastError = `targets=${targets.length}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Timed out waiting for WebView2 CDP on ${BASE} (${lastError})`);
}

function cdpSession(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter(message);
    }
  });
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", () => reject(new Error("CDP websocket error")));
  });
  async function send(method, params) {
    await ready;
    const id = nextId;
    nextId += 1;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 120_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
    if (result.error) {
      throw new Error(`${method}: ${JSON.stringify(result.error)}`);
    }
    return result.result;
  }
  return { send, close: () => socket.close() };
}

async function evaluate(expression, awaitPromise = true) {
  const target = await waitForTarget();
  const session = cdpSession(target.webSocketDebuggerUrl);
  await session.send("Runtime.enable");
  const result = await session.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  session.close();
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || JSON.stringify(result.exceptionDetails));
  }
  return result.result?.value;
}

const [command, ...rest] = process.argv.slice(2);
if (command === "wait") {
  const target = await waitForTarget();
  console.log(JSON.stringify({ title: target.title, url: target.url, id: target.id }, null, 2));
} else if (command === "eval") {
  const value = await evaluate(rest.join(" ") || "document.title");
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
} else if (command === "click-key") {
  const key = rest.join(" ");
  const script = `(async () => {
    const key = ${JSON.stringify(key)};
    const node = document.querySelector('[data-tree-key="' + key + '"] button.document-tree__item');
    if (!node) return { ok: false, key };
    node.click();
    return { ok: true, key };
  })()`;
  console.log(JSON.stringify(await evaluate(script), null, 2));
} else if (command === "open") {
  const rootPath = rest.join(" ");
  const script = `(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const result = await invoke("open_library", { rootPath: ${JSON.stringify(rootPath)} });
    return { rootKey: result.rootKey, count: result.documents.length, formats: [...new Set(result.documents.map((d) => d.format))] };
  })()`;
  const value = await evaluate(script);
  console.log(JSON.stringify(value, null, 2));
} else if (command === "metrics") {
  const script = `(async () => {
    const entries = performance.getEntriesByType("navigation");
    const nav = entries[0];
    const longTasks = performance.getEntriesByType("longtask") || [];
    return {
      title: document.title,
      readyState: document.readyState,
      duration: nav ? nav.duration : null,
      domContentLoaded: nav ? nav.domContentLoadedEventEnd : null,
      firstPaint: performance.getEntriesByName("first-paint")[0]?.startTime ?? null,
      longTaskCount: longTasks.length,
      longTaskMax: longTasks.reduce((max, task) => Math.max(max, task.duration), 0),
    };
  })()`;
  console.log(JSON.stringify(await evaluate(script), null, 2));
} else if (command === "screenshot") {
  const dest = rest[0] || "output/hardening/d16/webview.png";
  const width = rest[1] ? Number(rest[1]) : 0;
  const height = rest[2] ? Number(rest[2]) : 0;
  const target = await waitForTarget();
  const session = cdpSession(target.webSocketDebuggerUrl);
  await session.send("Page.enable");
  if (width > 0 && height > 0) {
    await session.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }
  const shot = await session.send("Page.captureScreenshot", { format: "png" });
  if (width > 0 && height > 0) {
    await session.send("Emulation.clearDeviceMetricsOverride");
  }
  session.close();
  const out = path.resolve(dest);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log(out);
} else {
  console.error("Usage: node scripts/d16-cdp.mjs wait|eval|open|metrics|screenshot");
  process.exit(1);
}
