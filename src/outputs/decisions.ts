/**
 * Writes the public decision memory of a site: `decisions.json`, the versioned report a tool can read, and
 * `decisions/index.html`, a matrix page listing every decision by status and date with its citation.
 *
 * Both files come from one public projection of the site's records, so the JSON and the HTML name the same decisions.
 * A private source, rationale, or rejected alternative is replaced with its placeholder before either file is written,
 * and a record whose audience the build does not publish is left out entirely.
 *
 * The output reads the site model only: no clock, no network, no disk. A site without decisions writes nothing.
 */
import type { DecisionPublicEntry } from "../contracts/decisions.ts";
import type { Output, OutputFile } from "../contracts/output.ts";
import { decisionReportOf } from "../decisions/report.ts";
import { underBase } from "./manifest.ts";

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Escapes text for an HTML document. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** One table row for one decision: id, title, status, date, and supersession. */
function rowOf(entry: DecisionPublicEntry): string {
  const supersedes = entry.supersedes.length === 0 ? "" : `supersedes ${entry.supersedes.join(", ")}`;
  const supersededBy = entry.supersededBy.length === 0 ? "" : `superseded by ${entry.supersededBy.join(", ")}`;
  const relation = [supersedes, supersededBy].filter((part) => part !== "").join("; ");
  return [
    "<tr>",
    `<td><code>${escapeHtml(entry.id)}</code></td>`,
    `<td>${escapeHtml(entry.title)}</td>`,
    `<td>${escapeHtml(entry.status)}</td>`,
    `<td>${escapeHtml(entry.date)}</td>`,
    `<td>${escapeHtml(relation)}</td>`,
    `<td><code>${escapeHtml(entry.span)}</code></td>`,
    "</tr>",
  ].join("");
}

/** The matrix page: the counts, then one row per decision, in id order. */
export function decisionMatrixHtml(entries: readonly DecisionPublicEntry[], title: string): string {
  const counts = entries.reduce<Record<string, number>>((accumulator, entry) => {
    accumulator[entry.status] = (accumulator[entry.status] ?? 0) + 1;
    return accumulator;
  }, {});
  const summary = ["proposed", "accepted", "superseded", "deprecated", "rejected"]
    .map((status) => `${status} ${counts[status] ?? 0}`)
    .join(", ");
  const rows = [...entries].sort((a, b) => byCodePoint(a.id, b.id)).map(rowOf).join("\n");
  return [
    "<!doctype html>",
    `<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)} decisions</title></head>`,
    "<body>",
    `<h1>${escapeHtml(title)} decisions</h1>`,
    `<p>${escapeHtml(summary)}</p>`,
    "<table>",
    "<thead><tr><th>Id</th><th>Title</th><th>Status</th><th>Date</th><th>Supersession</th><th>Source</th></tr></thead>",
    `<tbody>\n${rows}\n</tbody>`,
    "</table>",
    "</body></html>",
  ].join("\n");
}

/** The decision report output: `decisions.json` and the matrix page, from one public projection. */
export const decisionsOutput: Output = {
  name: "decisions",
  async run(site): Promise<readonly OutputFile[]> {
    const config = site.config.decisions;
    if (config === undefined || !config.publish) return [];
    const records = site.decisions ?? [];
    if (records.length === 0) return [];
    const report = decisionReportOf(records);
    const files: OutputFile[] = [
      { path: underBase("/decisions.json", site.config.base).slice(1), contents: `${JSON.stringify(report, null, 2)}\n` },
      { path: underBase("/decisions/", site.config.base).replace(/^\/+|\/+$/g, "") + "/index.html", contents: `${decisionMatrixHtml(report.entries, site.config.title)}\n` },
    ];
    return files.sort((a, b) => byCodePoint(a.path, b.path));
  },
};
