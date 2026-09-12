import { describe, expect, it } from "vitest";
import { describeLocalOpenError } from "./localDataStatusDisplay";

const roaming = "C:\\Users\\viper\\AppData\\Roaming\\com.local.reade\\reade-user.sqlite3";
const local = "C:\\Users\\viper\\AppData\\Local\\com.local.reade\\reade-user.sqlite3";

describe("describeLocalOpenError", () => {
  it("turns a post-migration conflict into Chinese copy and two wrapable paths", () => {
    const view = describeLocalOpenError(
      "user",
      `User annotation data is present in both ${roaming} and ${local}, and the old copy changed after it was migrated. Reade refuses to pick a winner automatically; keep one file and rename the other aside, then restart.`,
    );
    expect(view.title).toBe("标注库打开失败");
    expect(view.detail).toContain("不会自动选哪一份");
    expect(view.detail).not.toMatch(/WindowsPath|C:\\Users/);
    expect(view.paths).toEqual([roaming, local]);
  });

  it("unwraps Rust Debug path tokens from older error strings", () => {
    const view = describeLocalOpenError(
      "user",
      `User annotation data is present in both WindowsPath("${roaming.replace(/\\/g, "\\\\")}") and WindowsPath("${local.replace(/\\/g, "\\\\")}") without a trusted migration record. Reade refuses to pick a winner automatically.`,
    );
    expect(view.paths).toEqual([roaming, local]);
    expect(view.detail).toContain("没有可信的迁移记录");
  });

  it("keeps unknown backend errors intact", () => {
    const view = describeLocalOpenError("stats", "Cannot open user database: locked by another process");
    expect(view.title).toBe("统计库打开失败");
    expect(view.detail).toBe("Cannot open user database: locked by another process");
    expect(view.paths).toEqual([]);
  });
});
