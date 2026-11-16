/** `get_diagnostics`: the site's diagnostics, in the JSON the CLI prints (`check --format json`), with `fix` where present. */
import { formatJson } from "../../pipeline/diagnostics.ts";
import { json, type Tool } from "../tool.ts";

interface Input {
  readonly path?: string;
  readonly severity?: "error" | "warning" | "info";
}

export const tool: Tool<Input> = {
  name: "get_diagnostics",
  description:
    "Get the site's build diagnostics as the engine's JSON contract (`version`, `diagnostics[]` with `id`, `severity`, `message`, `pos`, `help`, and a `fix` span when one is known). Rebuilds first when a source file changed. Filter by source `path` prefix and `severity`.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Only findings in files under this site-relative path." },
      severity: { enum: ["error", "warning", "info"], description: "Only findings of this severity." },
    },
    additionalProperties: false,
  },
  async handler(input, { site }) {
    const wanted = input.path?.replace(/\\/g, "/").replace(/^\.\//, "");
    const picked = site.diagnostics.filter(
      (d) =>
        (input.severity === undefined || d.severity === input.severity) &&
        (wanted === undefined || (d.pos?.file.replace(/\\/g, "/") ?? "").startsWith(wanted)),
    );
    const contract = JSON.parse(formatJson(picked)) as Record<string, unknown>;
    return json(contract);
  },
};
