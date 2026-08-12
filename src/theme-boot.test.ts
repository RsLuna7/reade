// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { BOOT_STORAGE_KEY, bootTheme } from "./theme-boot";
import { READER_PREFERENCES_STORAGE_KEY } from "./store/useReaderStore";

function mockPrefersDark(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query === "(prefers-color-scheme: dark)" && matches,
      media: query,
    })),
  });
}

function metaThemeColor(): string | null {
  return (
    document
      .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      ?.getAttribute("content") ?? null
  );
}

describe("theme boot script", () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
    document.querySelector('meta[name="theme-color"]')?.remove();
    const meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    meta.setAttribute("content", "#f5f1e8");
    document.head.appendChild(meta);
    mockPrefersDark(false);
  });

  it("reads the same storage key as the zustand persist store", () => {
    expect(BOOT_STORAGE_KEY).toBe(READER_PREFERENCES_STORAGE_KEY);
  });

  it("applies a persisted theme before paint, mapping legacy v3 ids", () => {
    localStorage.setItem(
      BOOT_STORAGE_KEY,
      JSON.stringify({ state: { theme: "dark" }, version: 3 }),
    );

    bootTheme();

    expect(document.documentElement.dataset.theme).toBe("paper-dark");
    expect(metaThemeColor()).toBe("#1a1d1b");
  });

  it("applies current two-part ids as-is", () => {
    localStorage.setItem(
      BOOT_STORAGE_KEY,
      JSON.stringify({ state: { theme: "paper-dark" }, version: 4 }),
    );

    bootTheme();

    expect(document.documentElement.dataset.theme).toBe("paper-dark");
    expect(metaThemeColor()).toBe("#1a1d1b");
  });

  it("falls back to the system color scheme when storage is corrupt", () => {
    localStorage.setItem(BOOT_STORAGE_KEY, "{not json");
    mockPrefersDark(true);

    bootTheme();

    expect(document.documentElement.dataset.theme).toBe("paper-dark");
  });

  it("rejects unknown theme ids and falls back to the system scheme", () => {
    localStorage.setItem(
      BOOT_STORAGE_KEY,
      JSON.stringify({ state: { theme: "sepia" }, version: 4 }),
    );
    mockPrefersDark(false);

    bootTheme();

    expect(document.documentElement.dataset.theme).toBe("paper-light");
    expect(metaThemeColor()).toBe("#f5f1e8");
  });

  it("defaults to paper-light when even matchMedia is unavailable", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: undefined,
    });

    bootTheme();

    expect(document.documentElement.dataset.theme).toBe("paper-light");
  });
});
