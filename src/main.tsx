import React from "react";
import ReactDOM from "react-dom/client";
import "katex/dist/katex.min.css";
import "./styles/theme-tokens.css";
import App from "./App";
import { registerReadeServiceWorker } from "./lib/swRegistration";

// PWA 离线化仅限 Web 运行时(plan-web-pwa PW-D4):字面量守卫让桌面
// 构建在编译期整体剔除注册分支,桌面 bundle 不含 serviceWorker 代码。
if (__READE_RUNTIME__ === "web") {
  registerReadeServiceWorker({
    isProduction: import.meta.env.PROD,
    version: __READE_VERSION__,
  });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
