import { describe, expect, it } from "vitest";
import {
  collectLocalBackupPreferences,
  restoreLocalBackupPreferences,
} from "./localBackup";

describe("localBackup preferences snapshot", () => {
  it("packs known keys and restores them without inventing values", () => {
    const store = new Map<string, string>([["reade-device-id", "dev-1"]]);
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    };
    const json = collectLocalBackupPreferences(storage);
    expect(JSON.parse(json)["reade-device-id"]).toBe("dev-1");
    store.clear();
    restoreLocalBackupPreferences(json, storage);
    expect(store.get("reade-device-id")).toBe("dev-1");
    expect(store.has("reade-reader-preferences")).toBe(false);
  });
});
