import type { Diagnostic, Plugin } from "@velella/mizzen/contracts";

/** A page without a description is harder to find; report it without failing the build. */
export const checkDescriptions: Plugin = {
  name: "check-descriptions",
  inputs: [],
  validate(page) {
    if (page.kind !== "doc" || page.frontMatter.description !== undefined) return [];
    const finding: Diagnostic = {
      id: "example.missing-description",
      severity: "warning",
      message: `${page.source.file} has no description.`,
      pos: page.source,
    };
    return [finding];
  },
};
