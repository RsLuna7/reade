import { describe, expect, it } from "vitest";
import { ANNOTATION_MIGRATION_FIXTURE } from "./annotationMigrationFixture";
import {
  ANNOTATION_TONES,
  excerptToLegacyAnnotation,
  colorsForTone,
  isToneFilterActive,
  legacyColorToTone,
  migrateLegacyAnnotation,
  projectedLegacyColor,
  readingPlaceToLegacyAnnotation,
  sourceAnchorToLegacyLocator,
  toneToLegacyColor,
  toggleToneFilter,
} from "./annotationModel";

describe("annotation v5 → v6 semantic mapping", () => {
  it("maps every frozen fixture row to exactly one entry and preserves notes", () => {
    for (const library of ANNOTATION_MIGRATION_FIXTURE) {
      const migrated = library.annotations.map((annotation) => migrateLegacyAnnotation(annotation));
      expect(
        migrated.filter((item) => item.excerpt !== null).length +
          migrated.filter((item) => item.place !== null).length,
      ).toBe(library.annotations.length);
      expect(migrated.filter((item) => item.reflection !== null)).toHaveLength(
        library.annotations.filter((annotation) => annotation.note?.trim()).length,
      );
    }
  });

  it("reverse-projects every frozen row byte-for-byte", () => {
    for (const library of ANNOTATION_MIGRATION_FIXTURE) {
      for (const annotation of library.annotations) {
        const migrated = migrateLegacyAnnotation(annotation);
        const projected = migrated.excerpt
          ? excerptToLegacyAnnotation(migrated.excerpt, migrated.reflection)
          : readingPlaceToLegacyAnnotation(migrated.place!, migrated.reflection);
        expect(projected, annotation.id).toEqual(annotation);
      }
    }
  });

  it("maps four legacy colors onto three quiet tones", () => {
    expect(ANNOTATION_TONES).toEqual(["sand", "sage", "slate"]);
    expect(legacyColorToTone("yellow")).toBe("sand");
    expect(legacyColorToTone("pink")).toBe("sand");
    expect(legacyColorToTone("green")).toBe("sage");
    expect(legacyColorToTone("blue")).toBe("slate");
    expect(toneToLegacyColor("sand")).toBe("yellow");
    expect(toneToLegacyColor("sage")).toBe("green");
    expect(toneToLegacyColor("slate")).toBe("blue");
    expect(colorsForTone("sand")).toEqual(["yellow", "pink"]);
    expect(isToneFilterActive(["pink"], "sand")).toBe(true);
    expect(toggleToneFilter([], "sand")).toEqual(["yellow", "pink"]);
    expect(toggleToneFilter(["yellow", "pink", "green"], "sand")).toEqual(["green"]);
  });

  it("keeps legacy pink until the user deliberately recolors", () => {
    const annotation = ANNOTATION_MIGRATION_FIXTURE[0].annotations.find(
      (item) => item.id === "mig-md-pink",
    )!;
    const migrated = migrateLegacyAnnotation(annotation).excerpt!;
    expect(migrated.appearance.tone).toBe("sand");
    expect(projectedLegacyColor(migrated)).toBe("pink");

    const recolored = {
      ...migrated,
      appearance: { ...migrated.appearance, tone: "sage" as const },
    };
    expect(projectedLegacyColor(recolored)).toBe("green");
  });

  it("preserves optional locator hints and PDF page geometry", () => {
    for (const library of ANNOTATION_MIGRATION_FIXTURE) {
      for (const annotation of library.annotations) {
        const migrated = migrateLegacyAnnotation(annotation);
        if (!migrated.excerpt || annotation.locator.kind === "bookmark") continue;
        expect(sourceAnchorToLegacyLocator(migrated.excerpt.anchor)).toEqual(
          annotation.locator,
        );
      }
    }
  });

  it("uses a migration-snapshot revision without pretending it existed at capture", () => {
    const library = ANNOTATION_MIGRATION_FIXTURE[0];
    const annotation = library.annotations[0];
    const revision = {
      contentHash: library.fingerprints.get(annotation.relativePath)!,
      observedAt: 9_000,
      basis: "migrationSnapshot" as const,
    };
    const migrated = migrateLegacyAnnotation(annotation, revision).excerpt!;
    expect(migrated.sourceRevision).toEqual(revision);
  });
});
