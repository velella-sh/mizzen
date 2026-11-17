/**
 * The size budget of the API files. A file over `api.maxFileBytes` gets a warning that names it and its size and says
 * what to read instead; it is still written whole. Cutting a collection to fit would hand a reader a partial answer
 * that looks complete, so the budget advises and never truncates.
 */
import type { Diagnostic } from "../contracts/index.ts";
import type { OutputFile } from "../contracts/output.ts";

/** Reports each file of `files` larger than `maxBytes`; returns nothing when the site sets no budget. */
export function overBudget(files: readonly OutputFile[], maxBytes: number | undefined, report: (diagnostic: Diagnostic) => void): void {
  if (maxBytes === undefined) return;
  for (const file of files) {
    const size = Buffer.byteLength(file.contents, "utf8");
    if (size <= maxBytes) continue;
    const ndjson = file.path.endsWith(".json") && !file.path.includes("/schemas/") && file.path.split("/").length === 3 && !file.path.endsWith("/index.json") && !file.path.endsWith("/openapi.json");
    report({
      id: "api.file-too-large",
      severity: "warning",
      message: `${file.path} is ${size} bytes, over the api.maxFileBytes limit of ${maxBytes}.`,
      help: ndjson
        ? `Read ${file.path.replace(/\.json$/, ".ndjson")} instead, one record per line, or fetch single records from the record files. The file is written whole.`
        : "Publish fewer fields for this collection, or raise api.maxFileBytes. The file is written whole.",
    });
  }
}
