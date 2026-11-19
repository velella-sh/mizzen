import type { ReadinessFinding, ReadinessReport } from "../contracts/readiness.ts";
import { readinessDigest } from "./report.ts";

/** What a public report must keep out. Every list is a prefix match on a whole path segment. */
export interface RedactOptions {
  /** Page URLs that are not public. Their findings are dropped. */
  readonly privatePages?: readonly string[];
  /** Source files or folders that are not public. A finding about one is dropped. */
  readonly privateSources?: readonly string[];
  /** Collection or symbol names that are not public. */
  readonly privateNames?: readonly string[];
  /** An absolute site root to remove before the generic absolute-path rule. */
  readonly root?: string;
}

/** One redacted string and whether anything changed. */
interface Cleaned {
  readonly text: string;
  readonly changed: boolean;
}

/** True when `value` equals `prefix` or sits under it as a whole segment. */
function under(value: string, prefix: string): boolean {
  const clean = prefix.replace(/\/+$/, "");
  return value === clean || value.startsWith(`${clean}/`);
}

/** Replaces absolute paths that carry a user, home, or temporary folder. */
function stripPaths(text: string, root: string | undefined): Cleaned {
  let result = text;
  if (root !== undefined && root !== "") {
    const slash = root.replace(/\/+$/, "");
    result = result.split(slash).join("<site>");
  }
  result = result.replace(/(?:^|[\s("'`=])(\/(?:Users|home|private|var|tmp|opt|mnt|root|workspace)\/[^\s"'`),]+)/g, (match, path: string) =>
    match.replace(path, "<path>"),
  );
  result = result.replace(/[A-Za-z]:\\[^\s"'`),]+/g, "<path>");
  return { text: result, changed: result !== text };
}

/** Replaces tokens, secrets, signatures, and bearer values, whatever field they appear in. */
function stripSecrets(text: string): Cleaned {
  let result = text;
  result = result.replace(
    /([?&](?:access_token|api[_-]?key|token|secret|password|sig|signature|x-amz-signature)=)[^&\s"'`]+/gi,
    "$1<redacted>",
  );
  result = result.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1<redacted>");
  result = result.replace(/("?(?:access_token|api[_-]?key|token|secret|password)"?\s*:\s*")[^"]+"/gi, "$1<redacted>\"");
  result = result.replace(/(\/\/)[^/@\s]+:[^/@\s]+@/g, "$1<redacted>@");
  return { text: result, changed: result !== text };
}

/** Runs both redactions and counts one change per field, never per occurrence. */
function clean(text: string, root: string | undefined): Cleaned {
  const paths = stripPaths(text, root);
  const secrets = stripSecrets(paths.text);
  return { text: secrets.text, changed: paths.changed || secrets.changed };
}

/** True when a finding names a private page, source, collection, or symbol. */
function privateFinding(finding: ReadinessFinding, options: RedactOptions): boolean {
  const page = finding.scope.page;
  if (page !== undefined && (options.privatePages ?? []).some((prefix) => under(page, prefix))) return true;
  const file = finding.pos?.file;
  if (file !== undefined && (options.privateSources ?? []).some((prefix) => under(file, prefix))) return true;
  const collection = finding.scope.collection;
  if (collection !== undefined && (options.privateNames ?? []).includes(collection)) return true;
  const symbol = finding.scope.symbol;
  if (symbol !== undefined && (options.privateNames ?? []).includes(symbol)) return true;
  return false;
}

/**
 * Produces the public form of a report: findings about private pages, sources, collections, or symbols are dropped,
 * and every remaining string loses machine paths, tokens, secrets, and credentials. The digest is recomputed, so a
 * redacted report still verifies and a badge can only be made from that public form.
 */
export function redactReadinessReport(report: ReadinessReport, options: RedactOptions = {}): ReadinessReport {
  let redacted = 0;
  const findings: ReadinessFinding[] = [];
  for (const finding of report.findings) {
    if (privateFinding(finding, options)) {
      redacted++;
      continue;
    }
    const message = clean(finding.message, options.root);
    const evidence = clean(finding.evidence, options.root);
    const action = clean(finding.remediation.action, options.root);
    const link = stripSecrets(finding.remediation.link);
    let pos = finding.pos;
    let changed = message.changed || evidence.changed || action.changed || link.changed;
    if (pos !== undefined) {
      const file = stripPaths(pos.file, options.root);
      if (file.changed) {
        pos = { ...pos, file: "<redacted>" };
        changed = true;
      }
    }
    if (changed) redacted++;
    findings.push({
      ...finding,
      ...(pos === undefined ? {} : { pos }),
      message: message.text,
      evidence: evidence.text,
      remediation: { action: action.text, link: link.text },
    });
  }

  const cleanedEvidence = report.evidence === undefined ? undefined : stripSecrets(report.evidence);
  if (cleanedEvidence?.changed === true) redacted++;
  const reason = clean(report.evaluations.reason, options.root);
  if (reason.changed) redacted++;
  const unknowns = report.unknowns.map((rule) => {
    if (rule.reason === undefined) return rule;
    const cleanReason = clean(rule.reason, options.root);
    if (cleanReason.changed) redacted++;
    return { ...rule, reason: cleanReason.text };
  });
  const { digest: _digest, ...rest } = report;
  const next: Omit<ReadinessReport, "digest"> = {
    ...rest,
    findings,
    unknowns,
    ...(cleanedEvidence === undefined ? {} : { evidence: cleanedEvidence.text }),
    evaluations: { ...report.evaluations, reason: reason.text },
    privacy: { public: true, redacted },
  };
  return { ...next, digest: readinessDigest(next) };
}
