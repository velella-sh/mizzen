import { checkDescriptions } from "./plugins/check-descriptions.ts";
import { numberSections } from "./plugins/number-sections.ts";
import { writePageIndex } from "./plugins/write-page-index.ts";

export default { plugins: [checkDescriptions, numberSections, writePageIndex] };
