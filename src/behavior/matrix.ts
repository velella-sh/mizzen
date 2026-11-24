/**
 * The public behavior matrix: one HTML page that lists every public behavior by version, environment, support status,
 * and verification, with links to the documentation page and to public evidence. Private behaviors and private evidence
 * values never reach this page; the report they came from already removed them.
 *
 * The page is deterministic and self-contained: a fixed row order, escaped text, no clock, no random id, and no theme
 * asset. A root-relative evidence URL is written under the site's `base`, as every other engine URL is.
 */
import type { BehaviorEvidenceLink, BehaviorRecord, BehaviorReport } from "../contracts/behavior.ts";
import { formatSpan } from "../source/spans.ts";
import { environmentListText } from "./format.ts";
import { versionHistoryText } from "./report.ts";

/** What the matrix needs besides the report. */
export interface BehaviorMatrixOptions {
  /** The site base path, such as `/mizzen`; empty at a domain root. */
  readonly base?: string;
}

/** Escapes text for HTML, in both element content and a quoted attribute. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The stable fragment a behavior or replacement link points at. */
export function behaviorAnchor(id: string): string {
  return `behavior-${id.replace(/[^A-Za-z0-9_.:-]/g, "-")}`;
}

/** The href of a public evidence URL, or `undefined` when it is not one this page may link. */
function evidenceHref(url: string | undefined, base: string): string | undefined {
  if (url === undefined) return undefined;
  if (url.startsWith("/") && !url.startsWith("//")) return `${base}${url}`;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" ? url : undefined;
  } catch {
    return undefined;
  }
}

/** One evidence entry as a list item: a link, a pinned id, or a withheld placeholder. */
function evidenceItem(link: BehaviorEvidenceLink, base: string): string {
  if (link.redacted === true) return "<li>evidence withheld</li>";
  const href = evidenceHref(link.url, base);
  if (href !== undefined) {
    const text = escapeHtml(link.title ?? link.url ?? href);
    return `<li><a href="${escapeHtml(href)}">${text}</a> <code>${escapeHtml(link.kind)}</code></li>`;
  }
  if (link.id !== undefined) return `<li><code>${escapeHtml(link.id)}</code> <code>${escapeHtml(link.kind)}</code></li>`;
  return `<li>unresolved <code>${escapeHtml(link.kind)}</code></li>`;
}

/** One test entry as a list item. */
function testItem(test: BehaviorRecord["tests"][number]): string {
  const name = test.name === undefined ? "" : ` &ldquo;${escapeHtml(test.name)}&rdquo;`;
  const state = test.state === "found" ? "" : " (missing)";
  return `<li><code>${escapeHtml(test.file)}</code>${name}: ${escapeHtml(test.outcome)}${state}</li>`;
}

/** One surface item as a list item, with its signature when it has one. */
function surfaceItem(link: BehaviorRecord["surface"][number]): string {
  const signature = link.signature === undefined ? "" : ` <code>${escapeHtml(link.signature)}</code>`;
  const state = link.state === "missing" ? " (missing)" : "";
  return `<li><code>${escapeHtml(link.item)}</code>${signature}${state}</li>`;
}

/** One row of the matrix. */
function rowOf(behavior: BehaviorRecord, base: string): string {
  const effective = behavior.statusAtVersion ?? behavior.status;
  const status = behavior.statusAtVersion === undefined || behavior.statusAtVersion === behavior.status
    ? escapeHtml(effective)
    : `${escapeHtml(effective)} <small>(current: ${escapeHtml(behavior.status)})</small>`;
  const replacement = behavior.replacement === undefined
    ? ""
    : `<br><small>replaced by <a href="#${escapeHtml(behaviorAnchor(behavior.replacement))}"><code>${escapeHtml(behavior.replacement)}</code></a></small>`;
  const verification = behavior.verification.status === "verified"
    ? "verified"
    : `unverified <small>(${behavior.verification.reasons.map(escapeHtml).join(", ")})</small>`;
  return [
    `<tr id="${escapeHtml(behaviorAnchor(behavior.id))}">`,
    `<td><code>${escapeHtml(behavior.id)}</code><br><small>${escapeHtml(formatSpan(behavior.source))}</small></td>`,
    `<td><strong>${escapeHtml(behavior.title)}</strong><p>${escapeHtml(behavior.normative)}</p><a href="${escapeHtml(behavior.page.url)}">documentation</a></td>`,
    `<td>${status}${replacement}</td>`,
    `<td>${escapeHtml(versionHistoryText(behavior))}</td>`,
    `<td>${escapeHtml(environmentListText(behavior.environments))}</td>`,
    `<td><ul>${behavior.surface.map(surfaceItem).join("")}</ul></td>`,
    `<td><ul>${behavior.tests.map(testItem).join("")}</ul></td>`,
    `<td><ul>${behavior.evidence.map((entry) => evidenceItem(entry, base)).join("")}</ul></td>`,
    `<td>${verification}</td>`,
    "</tr>",
  ].join("");
}

/**
 * The public matrix page. A behavior the author kept private is already absent from `report`, and the counts in the
 * header name how many were withheld. The JSON link points at the report beside this page.
 */
export function behaviorMatrixHtml(report: BehaviorReport, options: BehaviorMatrixOptions = {}): string {
  const base = options.base ?? "";
  const { coverage } = report;
  const findings = report.findings.length === 0
    ? "<p>No structural findings.</p>"
    : [
        "<h2>Findings</h2>",
        "<ul>",
        ...report.findings.map(
          (finding) =>
            `<li><code>${escapeHtml(finding.code)}</code> ${escapeHtml(finding.message)}</li>`,
        ),
        "</ul>",
      ].join("");
  const rows = report.behaviors.map((behavior) => rowOf(behavior, base)).join("\n");
  const version = report.source.version === undefined ? "" : ` at ${escapeHtml(report.source.version)}`;
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>Behavior contracts</title>",
    "</head>",
    "<body>",
    `<h1>Behavior contracts${version}</h1>`,
    `<p>${coverage.total} behaviors: ${coverage.verified} verified, ${coverage.unverified} unverified; ${coverage.private} private withheld. Surface: ${coverage.surface.linked} linked, ${coverage.surface.missing} missing. <a href="../behavior.json">JSON</a></p>`,
    "<table>",
    "<thead><tr><th>ID</th><th>Behavior</th><th>Status</th><th>Versions</th><th>Environments</th><th>Surface</th><th>Tests</th><th>Evidence</th><th>Verification</th></tr></thead>",
    "<tbody>",
    rows,
    "</tbody>",
    "</table>",
    findings,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
