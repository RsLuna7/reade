// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { applyThemeMutation } from "./themeTransition";

// jsdom does not implement the View Transitions API; the tests install and
// remove a mock through this untyped optional view of the document (the DOM
// lib types the method as required, so a plain Document cast would reject
// both the mock assignment and the delete).
type MutableDocument = { startViewTransition?: unknown };
const mutableDocument = document as unknown as MutableDocument;

afterEach(() => {
  delete mutableDocument.startViewTransition;
});

function mockStartViewTransition() {
  // Real API runs the update callback inside the transition; the mock keeps
  // that contract so the mutation must land through it, not around it.
  return vi.fn((update: () => void) => {
    update();
    return {};
  });
}

describe("applyThemeMutation (M3/D5)", () => {
  it("wraps the mutation in exactly one view transition at full motion", () => {
    const startViewTransition = mockStartViewTransition();
    mutableDocument.startViewTransition = startViewTransition;
    const mutate = vi.fn();

    applyThemeMutation(mutate, "full");

    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("applies instantly without calling the API at off and subtle", () => {
    const startViewTransition = mockStartViewTransition();
    mutableDocument.startViewTransition = startViewTransition;

    for (const level of ["off", "subtle"] as const) {
      const mutate = vi.fn();
      applyThemeMutation(mutate, level);
      expect(mutate).toHaveBeenCalledTimes(1);
    }

    expect(startViewTransition).not.toHaveBeenCalled();
  });

  it("falls back to a direct write when the API is missing", () => {
    expect(typeof mutableDocument.startViewTransition).toBe("undefined");
    const mutate = vi.fn();

    expect(() => applyThemeMutation(mutate, "full")).not.toThrow();
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});
