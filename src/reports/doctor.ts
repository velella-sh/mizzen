import { createHash } from "node:crypto";
import { isAbsolute, win32 } from "node:path";
import { doctorReport, type DoctorOptions } from "../cli/doctor.ts";
import { SKIPPED_CHECK } from "../cli/doctor-report.ts";
import type { ReportFinding, ReportRun } from "../contracts/report.ts";
import { redactAuditText } from "../edits/audit.ts";
import { version } from "../index.ts";

/** Explicit metadata for a saved doctor run. Scope names the check target and settings. */
export type DoctorRunMeta = Pick<ReportRun, "id" | "scope" | "revision" | "date" | "evidence">;

/** Runs doctor, projecting its structured output to report-set v1. Review findings before publication. */
export async function collectDoctorRun(options: DoctorOptions, meta: DoctorRunMeta): Promise<ReportRun> {
  const report = await doctorReport(options);
  const findings: ReportFinding[] = [];
  const occurrences = new Map<string, number>();
  for (const diagnostic of report.diagnostics) {
    if (diagnostic.id === SKIPPED_CHECK) continue;
    const pos = diagnostic.pos;
    const location = pos === undefined || isAbsolute(pos.file) || win32.isAbsolute(pos.file) || pos.file.split(/[\\/]/).includes("..")
      ? undefined
      : { path: pos.file, line: pos.line, column: pos.column };
    const message = redactAuditText(diagnostic.message);
    const rule = diagnostic.id;
    const key = createHash("sha256").update(JSON.stringify([rule, location?.path, message])).digest("hex");
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);
    findings.push({
      id: `doctor-${key}-${occurrence}`, rule, message, severity: diagnostic.severity,
      ...(location === undefined ? {} : { location }),
    });
  }
  return {
    ...meta,
    tool: "Mizzen doctor",
    toolVersion: version,
    coverage: report.checks.some(({ state }) => state === "skipped") ? "partial" : "complete",
    checks: report.checks.map((check) => ({
      id: check.id, status: check.state,
      ...("reason" in check ? { detail: redactAuditText(check.reason) } : {}),
    })),
    findings,
    metrics: [],
  };
}
