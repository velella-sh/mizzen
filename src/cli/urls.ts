/**
 * `mizzen urls check [dir] [--format text|json]`: compares every record page's URL with `urls.lock.json` and reports
 * what is new, what changed, and what is gone. It writes nothing, not the lock and not the site.
 *
 * Exit 0 is a site whose published URLs are all still what the lock holds (a new record is fine), 1 is a changed URL
 * with no redirect or a removed record with no `onRemoved` policy.
 */
import type { UrlsPlan } from "../data/urls-lock.ts";

/** What {@link urlsReport} found, ready for the CLI to print. */
export interface UrlsCheckResult {
  /** 0 when the lock is still accurate, 1 when a URL changed or a record is gone without a policy. */
  readonly code: number;
  /** The report: one summary line and one line per change in text, the whole report in JSON. */
  readonly output: string;
}

/** Counts a noun, so a summary reads `1 record` and `2 records`. */
function counted(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** The report for a site, in the requested format. */
export function urlsReport(plan: UrlsPlan, format: "text" | "json"): UrlsCheckResult {
  const errors = plan.diagnostics.filter((finding) => finding.severity === "error");
  const code = errors.length === 0 ? 0 : 1;
  if (format === "json") {
    return {
      code,
      output: `${JSON.stringify({
        lock: plan.locked,
        checked: plan.checked,
        added: plan.added.map((entry) => ({ collection: entry.collection, id: entry.id, url: entry.url })),
        changed: plan.changed.map((change) => ({
          collection: change.collection,
          id: change.id,
          from: change.from,
          to: change.to,
        })),
        removed: plan.removed.map((entry) => ({ collection: entry.collection, id: entry.id, urls: entry.urls })),
        errors: errors.map((finding) => ({ id: finding.id, message: finding.message })),
      })}\n`,
    };
  }
  const lines = [
    plan.locked
      ? `${counted(plan.checked, "record")} checked against urls.lock.json: ${plan.added.length} new, ${plan.changed.length} changed, ${plan.removed.length} removed.`
      : `No urls.lock.json yet: ${counted(plan.checked, "record")} would publish a URL.`,
  ];
  for (const change of plan.changed) {
    lines.push(`changed ${change.collection}.${change.id}: ${change.from} -> ${change.to}`);
  }
  for (const entry of plan.removed) {
    lines.push(`removed ${entry.collection}.${entry.id}: ${entry.urls.join(", ")}`);
  }
  return { code, output: `${lines.join("\n")}\n` };
}
