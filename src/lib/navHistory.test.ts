import { describe, expect, it } from "vitest";
import {
  EMPTY_NAV_HISTORY,
  NAV_HISTORY_LIMIT,
  canNavBack,
  canNavForward,
  popNavBack,
  popNavForward,
  pushNavLocation,
  sameNavLocation,
  type NavHistory,
  type NavLocation,
} from "./navHistory";

function scrollAt(path: string, scrollTop: number): NavLocation {
  return { path, position: { kind: "scroll", scrollTop } };
}

function pdfAt(path: string, page: number, offsetRatio = 0): NavLocation {
  return { path, position: { kind: "pdf", page, offsetRatio } };
}

describe("sameNavLocation", () => {
  it("treats nearby scroll positions in the same document as identical", () => {
    expect(sameNavLocation(scrollAt("a.md", 100), scrollAt("a.md", 120))).toBe(true);
    expect(sameNavLocation(scrollAt("a.md", 100), scrollAt("a.md", 200))).toBe(false);
    expect(sameNavLocation(scrollAt("a.md", 100), scrollAt("b.md", 100))).toBe(false);
  });

  it("compares PDF positions by page and near-equal offset", () => {
    expect(sameNavLocation(pdfAt("x.pdf", 3, 0.5), pdfAt("x.pdf", 3, 0.51))).toBe(true);
    expect(sameNavLocation(pdfAt("x.pdf", 3, 0.5), pdfAt("x.pdf", 4, 0.5))).toBe(false);
    // 位置类型不同(阅读模式滚动 vs 原版式页码)不视为同处。
    expect(sameNavLocation(pdfAt("x.pdf", 3), scrollAt("x.pdf", 0))).toBe(false);
  });
});

describe("pushNavLocation", () => {
  it("pushes departures and clears the forward stack (browser semantics)", () => {
    let history: NavHistory = {
      back: [scrollAt("a.md", 0)],
      forward: [scrollAt("c.md", 50)],
    };
    history = pushNavLocation(history, scrollAt("b.md", 300));
    expect(history.back.map((item) => item.path)).toEqual(["a.md", "b.md"]);
    expect(history.forward).toEqual([]);
  });

  it("dedupes a push that matches the current top", () => {
    const seeded = pushNavLocation(EMPTY_NAV_HISTORY, scrollAt("a.md", 100));
    const again = pushNavLocation(seeded, scrollAt("a.md", 110));
    expect(again.back).toHaveLength(1);
    // 去重路径也要维持"新跳转清空 forward"的语义。
    const withForward: NavHistory = { back: seeded.back, forward: [scrollAt("z.md", 0)] };
    expect(pushNavLocation(withForward, scrollAt("a.md", 110)).forward).toEqual([]);
  });

  it("drops the oldest entry beyond the limit", () => {
    let history: NavHistory = EMPTY_NAV_HISTORY;
    for (let index = 0; index < NAV_HISTORY_LIMIT + 10; index += 1) {
      history = pushNavLocation(history, scrollAt(`doc-${index}.md`, index * 100));
    }
    expect(history.back).toHaveLength(NAV_HISTORY_LIMIT);
    expect(history.back[0].path).toBe("doc-10.md");
    expect(history.back[NAV_HISTORY_LIMIT - 1].path).toBe(
      `doc-${NAV_HISTORY_LIMIT + 9}.md`,
    );
  });
});

describe("popNavBack / popNavForward", () => {
  it("returns null on empty stacks", () => {
    expect(popNavBack(EMPTY_NAV_HISTORY, scrollAt("a.md", 0))).toBeNull();
    expect(popNavForward(EMPTY_NAV_HISTORY, scrollAt("a.md", 0))).toBeNull();
    expect(canNavBack(EMPTY_NAV_HISTORY)).toBe(false);
    expect(canNavForward(EMPTY_NAV_HISTORY)).toBe(false);
  });

  it("moves the current location to the opposite stack and round-trips", () => {
    // A@100 跳到 B,再从 B@40 后退。
    const afterJump = pushNavLocation(EMPTY_NAV_HISTORY, scrollAt("a.md", 100));
    const back = popNavBack(afterJump, scrollAt("b.md", 40));
    expect(back).not.toBeNull();
    expect(back!.target).toEqual(scrollAt("a.md", 100));
    expect(back!.history.back).toEqual([]);
    expect(back!.history.forward).toEqual([scrollAt("b.md", 40)]);
    expect(canNavForward(back!.history)).toBe(true);

    // 前进:回到 B@40,当前 A@100 回到 back 栈——往返对称。
    const forward = popNavForward(back!.history, scrollAt("a.md", 100));
    expect(forward!.target).toEqual(scrollAt("b.md", 40));
    expect(forward!.history.back).toEqual([scrollAt("a.md", 100)]);
    expect(forward!.history.forward).toEqual([]);
  });

  it("skips the opposite-stack push when current is null", () => {
    const seeded = pushNavLocation(EMPTY_NAV_HISTORY, pdfAt("x.pdf", 12, 0.3));
    const back = popNavBack(seeded, null);
    expect(back!.target).toEqual(pdfAt("x.pdf", 12, 0.3));
    expect(back!.history.forward).toEqual([]);
  });

  it("supports multi-step back walks through anchor jumps in one document", () => {
    let history = pushNavLocation(EMPTY_NAV_HISTORY, scrollAt("a.md", 0));
    history = pushNavLocation(history, scrollAt("a.md", 800));
    history = pushNavLocation(history, scrollAt("a.md", 1600));

    const first = popNavBack(history, scrollAt("a.md", 2400))!;
    expect(first.target.position).toEqual({ kind: "scroll", scrollTop: 1600 });
    const second = popNavBack(first.history, first.target)!;
    expect(second.target.position).toEqual({ kind: "scroll", scrollTop: 800 });
    const third = popNavBack(second.history, second.target)!;
    expect(third.target.position).toEqual({ kind: "scroll", scrollTop: 0 });
    expect(popNavBack(third.history, third.target)).toBeNull();
    // 一路后退积累的 forward 栈可原路前进。
    expect(third.history.forward.map((item) => item.position)).toEqual([
      { kind: "scroll", scrollTop: 2400 },
      { kind: "scroll", scrollTop: 1600 },
      { kind: "scroll", scrollTop: 800 },
    ]);
  });
});
