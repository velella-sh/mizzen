import type { Plugin } from "@velella/mizzen/contracts";

/** Numbers every second-level heading; the hook runs before parsing and keeps every line where it was. */
export const numberSections: Plugin = {
  name: "number-sections",
  inputs: [],
  markdown(source) {
    let section = 0;
    return source.markdown.replace(/^## /gmu, () => {
      section += 1;
      return `## ${section}. `;
    });
  },
};
