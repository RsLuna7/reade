// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerReadeServiceWorker,
  serviceWorkerUrl,
  shouldRegisterServiceWorker,
} from "./swRegistration";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("shouldRegisterServiceWorker", () => {
  it("only registers for the production web runtime with SW support", () => {
    expect(shouldRegisterServiceWorker("web", true, true)).toBe(true);
    // 桌面运行时绝不注册(PW-D4),其余条件再满足也不行。
    expect(shouldRegisterServiceWorker("desktop", true, true)).toBe(false);
    expect(shouldRegisterServiceWorker("web", false, true)).toBe(false);
    expect(shouldRegisterServiceWorker("web", true, false)).toBe(false);
  });
});

describe("serviceWorkerUrl", () => {
  it("stays relative and versioned for Pages sub-path scopes", () => {
    expect(serviceWorkerUrl("0.1.0")).toBe("sw.js?v=0.1.0");
    // 版本串进 query 必须转义,防注册 URL 被畸形版本破坏。
    expect(serviceWorkerUrl("a b&c")).toBe("sw.js?v=a%20b%26c");
  });
});

describe("registerReadeServiceWorker", () => {
  function stubServiceWorker() {
    const register = vi.fn().mockResolvedValue({});
    vi.stubGlobal("navigator", {
      ...navigator,
      serviceWorker: { register },
    });
    return register;
  }

  it("registers the versioned worker after window load in production", () => {
    const register = stubServiceWorker();
    registerReadeServiceWorker({ isProduction: true, version: "0.1.0" });
    expect(register).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("load"));
    expect(register).toHaveBeenCalledWith("sw.js?v=0.1.0");
  });

  it("does nothing in development builds", () => {
    const register = stubServiceWorker();
    registerReadeServiceWorker({ isProduction: false, version: "0.1.0" });
    window.dispatchEvent(new Event("load"));
    expect(register).not.toHaveBeenCalled();
  });

  it("does nothing when the browser lacks service worker support", () => {
    vi.stubGlobal("navigator", { ...navigator } as Navigator);
    expect(() =>
      registerReadeServiceWorker({ isProduction: true, version: "0.1.0" }),
    ).not.toThrow();
    window.dispatchEvent(new Event("load"));
  });
});
