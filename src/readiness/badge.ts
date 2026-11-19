import type { ReadinessReport } from "../contracts/readiness.ts";
import { verifyReadinessReport } from "./report.ts";

/** Thrown when a badge is asked for a report whose digest does not match its content. */
export class ReadinessBadgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadinessBadgeError";
  }
}

/** Escapes the five characters that end XML text or an attribute. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** The badge's one-line value, preserving the score, the rubric version, and the unknown count. */
export function badgeValue(report: ReadinessReport): string {
  const score = report.overall === undefined ? "unknown" : report.overall.toFixed(1);
  const unknown = report.unknowns.length === 0 ? "" : ` · ${report.unknowns.length} unknown`;
  return `${score}${unknown}`.trim();
}

/** The badge's accessible title, with the build, rubric, and status. */
export function badgeTitle(report: ReadinessReport): string {
  return `readiness ${badgeValue(report)} · ${report.status} · rubric ${report.rubric.version} · build ${report.build.hash.slice(0, 12)}`;
}

const COLORS: Readonly<Record<ReadinessReport["status"], string>> = {
  pass: "#2f855a",
  fail: "#c53030",
  unknown: "#718096",
};

/**
 * A deterministic SVG badge. It is produced only from a report whose digest matches its content, so a hand-edited
 * score cannot be published. The score, rubric version, unknown count, and status stay visible; when the report names
 * public evidence, the badge links to it.
 */
export function badgeSvg(report: ReadinessReport): string {
  if (!verifyReadinessReport(report)) {
    throw new ReadinessBadgeError("a badge needs a readiness report whose digest matches its content");
  }
  const label = `readiness v${report.rubric.version}`;
  const value = badgeValue(report);
  const title = badgeTitle(report);
  const left = 132;
  const right = Math.max(96, 16 + value.length * 7);
  const width = left + right;
  const body = [
    `<title>${escapeXml(title)}</title>`,
    `<desc>${escapeXml(`${report.status}; ${report.unknowns.length} unknown rule(s); build ${report.build.hash}`)}</desc>`,
    `<rect width="${width}" height="20" rx="3" fill="#2d3748"/>`,
    `<rect x="${left}" width="${right}" height="20" rx="3" fill="${COLORS[report.status]}"/>`,
    `<text x="${left / 2}" y="14" fill="#ffffff" font-family="Verdana,Geneva,sans-serif" font-size="11" text-anchor="middle">${escapeXml(label)}</text>`,
    `<text x="${left + right / 2}" y="14" fill="#ffffff" font-family="Verdana,Geneva,sans-serif" font-size="11" text-anchor="middle">${escapeXml(value)}</text>`,
  ];
  const inner = report.evidence === undefined ? body.join("") : `<a href="${escapeXml(report.evidence)}">${body.join("")}</a>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${escapeXml(title)}">${inner}</svg>\n`;
}

/**
 * A Markdown badge for a README. It points at the SVG this report produces and, when the report names public
 * evidence, links the badge to that evidence. It is derived from the same verified report as {@link badgeSvg}.
 */
export function badgeMarkdown(report: ReadinessReport, svgHref = "readiness.svg"): string {
  if (!verifyReadinessReport(report)) {
    throw new ReadinessBadgeError("a badge needs a readiness report whose digest matches its content");
  }
  const alt = `readiness v${report.rubric.version}: ${badgeValue(report)} (${report.status})`;
  const image = `![${alt}](${svgHref})`;
  return `${report.evidence === undefined ? image : `[${image}](${report.evidence})`}\n`;
}
