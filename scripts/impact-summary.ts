// Prints the Markdown summary of one changed record for a pull request, and writes the full JSON report it links to.
//
// Usage: node scripts/impact-summary.ts <site> <collection>/<id> [--report <path>] [--link <url>]
// The report defaults to `.mizzen/impact/<collection>/<id>.json` under the current folder; the link defaults to the
// report path. A workflow passes a run URL as the link and uploads the report as an artifact.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { impactSummary } from "../src/data/impact.ts";
import { buildModel } from "../src/model/build.ts";
import { buildDependencyGraph, explainAffectedOutputs, recordNodeId } from "../src/pipeline/dependency-graph.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const positional = args.filter((argument, index) => !argument.startsWith("--") && !(args[index - 1] ?? "").startsWith("--"));
const [root, target] = positional;
const slash = target?.indexOf("/") ?? -1;
if (root === undefined || target === undefined || slash <= 0 || slash === target.length - 1) {
  console.error("Usage: node scripts/impact-summary.ts <site> <collection>/<id> [--report <path>] [--link <url>]");
  process.exit(2);
}

const collection = target.slice(0, slash);
const id = target.slice(slash + 1);
const model = await buildModel(root);
const errors = model.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
if (errors.length > 0) {
  for (const error of errors) console.error(`${error.id}: ${error.message}`);
  process.exit(1);
}

const { graph } = await buildDependencyGraph({ root, site: model.site });
const node = recordNodeId(collection, id);
if (!graph.nodes.some((candidate) => candidate.id === node)) {
  console.error(`The record ${target} is not in ${root}.`);
  process.exit(1);
}

const outputs = explainAffectedOutputs(graph, [node]);
const report = flag("--report") ?? join(".mizzen", "impact", collection, `${id}.json`);
mkdirSync(dirname(report), { recursive: true });
writeFileSync(report, `${JSON.stringify({ version: 1, record: target, outputs }, null, 2)}\n`);
process.stdout.write(impactSummary(target, outputs, flag("--link") ?? report));
