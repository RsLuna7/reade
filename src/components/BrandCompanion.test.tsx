// @vitest-environment jsdom

import "../test/setup";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BrandCompanion } from "./BrandCompanion";

describe("BrandCompanion", () => {
  it("draws two eyes inside the brand mark svg", () => {
    const { container } = render(<BrandCompanion motionLevel="off" />);
    const svg = container.querySelector("svg.brand-companion");
    const eyes = container.querySelectorAll("ellipse.brand-companion-eye");

    expect(svg).toBeTruthy();
    expect(eyes).toHaveLength(2);
  });
});
