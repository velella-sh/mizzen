/**
 * Reads a knowledge declaration from untrusted front matter or a collection field, or explains every way it is
 * malformed at the exact span it was written.
 *
 * Parsing is local and synchronous: no file read, no network, no clock. A status outside the five values is refused
 * with its own code, so a typo is never mistaken for a valid status, and an absent declaration is never treated as
 * one of the five: the caller keeps `presence: missing` and reports it as such.
 */
import { createRequire } from "node:module";
import type { ErrorObject } from "ajv";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { Diagnostic } from "../contracts/diagnostic.ts";
import type {
  KnowledgeCitation,
  KnowledgeDeclaration,
  KnowledgeReview,
  KnowledgeReviewReason,
  KnowledgeScope,
  KnowledgeScopeKind,
  KnowledgeState,
  KnowledgeStatus,
} from "../contracts/knowledge.ts";
import type { SourcePos } from "../contracts/source.ts";
import { checkAsOf } from "../dates/as-of.ts";

/** The five statuses, in the order they are reported. */
export const KNOWLEDGE_STATUSES: readonly KnowledgeStatus[] = [
  "unknown",
  "unsupported",
  "unverified",
  "not-applicable",
  "out-of-scope",
];

/** The four scope dimensions, in the order they are reported. */
export const KNOWLEDGE_SCOPE_KINDS: readonly KnowledgeScopeKind[] = [
  "surface",
  "behavior",
  "platform",
  "version",
];

/** The front matter key and the collection field that carry a declaration. */
export const KNOWLEDGE_KEY = "knowledge";

// ajv is CommonJS: its default export is the class at run time, but its types name it.
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const schema = createRequire(import.meta.url)("../../schema/knowledge-status.schema.json") as object;
const validateShape = new Ajv2020({ strict: true, allErrors: true, verbose: true }).compile(schema);

/** True for one of the five statuses. */
export function isKnowledgeStatus(value: unknown): value is KnowledgeStatus {
  return typeof value === "string" && (KNOWLEDGE_STATUSES as readonly string[]).includes(value);
}

/** True for a subject that declares a status at all. */
export function declaresKnowledge(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

/** What reading a declaration needs. */
export interface ParseKnowledgeOptions {
  /** The file the declaration was read from, for diagnostics. */
  readonly file: string;
  /** The span of the `knowledge` key; an absent value falls back to a point at the declaration. */
  readonly span: SourcePos;
  /** A prefix for diagnostic ids, such as `knowledge` or `page`. */
  readonly idPrefix?: string;
}

/** One parse result: the declaration read, or the diagnostics that stopped it. */
export interface ParseKnowledgeResult {
  /** The declaration; present exactly when `diagnostics` holds no error. */
  readonly declaration?: KnowledgeDeclaration;
  /** Every finding, in source order. */
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Reads one declaration from the value written under `knowledge`. A value with no `status` is `unknown`; a status
 * outside the five is refused. A scope entry may be `{ kind, value }` or `kind:value`; an unknown kind or an empty
 * value is refused. `expires` must be a real `YYYY-MM-DD` day.
 */
export function parseKnowledge(
  value: unknown,
  options: ParseKnowledgeOptions,
): ParseKnowledgeResult {
  const prefix = options.idPrefix ?? "knowledge";
  const span = options.span;
  const diagnostics: Diagnostic[] = [];

  if (!validateShape(value)) {
    for (const error of validateShape.errors ?? []) {
      diagnostics.push(diagnosticOf(error, prefix, options.file, span));
    }
  }

  // `status` is required by the schema, but a missing one is read as `unknown` rather than refused: an authored
  // `knowledge:` block with a rationale and no status is the common case, and the point is to publish the gap.
  const record = isMapping(value) ? value : {};
  const rawStatus = record.status;
  let status: KnowledgeStatus = "unknown";
  if (rawStatus !== undefined) {
    if (isKnowledgeStatus(rawStatus)) status = rawStatus;
    else {
      diagnostics.push({
        id: `${prefix}.invalid-status`,
        severity: "error",
        message: `\`knowledge.status\` is "${String(rawStatus)}"; use one of ${KNOWLEDGE_STATUSES.join(", ")}.`,
        pos: span,
        help: "A subject without a declaration is reported as missing, not as one of the five statuses.",
      });
    }
  }

  const scope: KnowledgeScope[] = [];
  if (record.scope !== undefined) {
    if (!Array.isArray(record.scope)) {
      if (rawStatus !== undefined || record.scope !== null) {
        diagnostics.push({
          id: `${prefix}.invalid-scope`,
          severity: "error",
          message: "`knowledge.scope` must be a list of limits.",
          pos: span,
          help: "Write `scope: [platform:windows, version:v2]` or `scope: [{ kind: platform, value: windows }]`.",
        });
      }
    } else {
      for (const entry of record.scope) {
        const parsed = scopeOf(entry);
        if (parsed === undefined) {
          diagnostics.push({
            id: `${prefix}.invalid-scope`,
            severity: "error",
            message: `A \`knowledge.scope\` entry is not a known limit: ${JSON.stringify(entry)}.`,
            pos: span,
            help: `Use one of ${KNOWLEDGE_SCOPE_KINDS.join(", ")} with a non-empty value.`,
          });
          continue;
        }
        scope.push(parsed);
      }
    }
  }

  let rationale: string | undefined;
  if (record.rationale !== undefined) {
    if (typeof record.rationale === "string" && record.rationale.trim() !== "") rationale = record.rationale.trim();
    else diagnostics.push({
      id: `${prefix}.invalid-rationale`,
      severity: "error",
      message: "`knowledge.rationale` must be a non-empty string.",
      pos: span,
    });
  }

  let citation: KnowledgeCitation | undefined;
  if (record.citation !== undefined) {
    citation = citationOf(record.citation);
    if (citation === undefined) {
      diagnostics.push({
        id: `${prefix}.invalid-citation`,
        severity: "error",
        message: "`knowledge.citation` must be a non-empty string or `{ value, public }`.",
        pos: span,
        help: "A citation value is redacted in public output unless it is marked `public: true`.",
      });
    }
  }

  let expires: string | undefined;
  if (record.expires !== undefined) {
    if (typeof record.expires === "string" && /^\d{4}-\d{2}-\d{2}$/.test(record.expires) && checkAsOf(record.expires) === undefined) {
      expires = record.expires;
    } else {
      diagnostics.push({
        id: `${prefix}.invalid-expires`,
        severity: "error",
        message: `\`knowledge.expires\` is not a date: ${JSON.stringify(record.expires)}; use YYYY-MM-DD.`,
        pos: span,
      });
    }
  }

  let evidence: string | undefined;
  if (record.evidence !== undefined) {
    if (typeof record.evidence === "string" && record.evidence.trim() !== "") evidence = record.evidence.trim();
    else diagnostics.push({
      id: `${prefix}.invalid-evidence`,
      severity: "error",
      message: "`knowledge.evidence` must be a non-empty string.",
      pos: span,
    });
  }

  let published: boolean | undefined;
  if (record.public !== undefined) {
    if (typeof record.public === "boolean") published = record.public;
    else diagnostics.push({
      id: `${prefix}.invalid-public`,
      severity: "error",
      message: "`knowledge.public` must be true or false.",
      pos: span,
    });
  }

  if (diagnostics.length > 0) return { diagnostics: sortDiagnostics(diagnostics) };
  return {
    declaration: {
      status,
      scope,
      ...(rationale === undefined ? {} : { rationale }),
      ...(citation === undefined ? {} : { citation }),
      ...(published === undefined ? {} : { public: published }),
      ...(expires === undefined ? {} : { expires }),
      ...(evidence === undefined ? {} : { evidence }),
      span,
    },
    diagnostics: [],
  };
}

/** The knowledge state of a subject that may or may not declare one. */
export function knowledgeStateOf(value: unknown, options: ParseKnowledgeOptions): {
  readonly state: KnowledgeState;
  readonly diagnostics: readonly Diagnostic[];
} {
  if (!declaresKnowledge(value)) return { state: { presence: "missing" }, diagnostics: [] };
  const parsed = parseKnowledge(value, options);
  if (parsed.declaration === undefined) {
    return { state: { presence: "missing" }, diagnostics: parsed.diagnostics };
  }
  return { state: { presence: "declared", declaration: parsed.declaration }, diagnostics: parsed.diagnostics };
}

/**
 * Whether a declaration needs review against a fixed reference date and current evidence value. The clock is never
 * read: a caller passes `asOf` explicitly, so two runs on the same input answer alike.
 */
export function reviewOf(
  declaration: KnowledgeDeclaration,
  options: { readonly asOf?: string; readonly evidence?: string },
): KnowledgeReview {
  const reasons: KnowledgeReviewReason[] = [];
  if (declaration.expires !== undefined && options.asOf !== undefined && options.asOf > declaration.expires) {
    reasons.push("expired");
  }
  if (declaration.evidence !== undefined && options.evidence !== undefined && options.evidence !== declaration.evidence) {
    reasons.push("evidence-changed");
  }
  return {
    required: reasons.length > 0,
    reasons,
    ...(declaration.expires === undefined ? {} : { expires: declaration.expires }),
  };
}

/**
 * Whether a query's scope is covered by a declaration's scope. A declaration with no limits covers every query; a
 * query with no limits is covered only by a declaration that also has none. Otherwise every query limit must be
 * named by a declaration limit, so a claim about `platform:windows` does not answer a question about `platform:linux`.
 */
export function scopeCovers(
  declaration: readonly KnowledgeScope[],
  query: readonly KnowledgeScope[] | undefined,
): boolean {
  if (declaration.length === 0) return true;
  if (query === undefined || query.length === 0) return false;
  return query.every((wanted) =>
    declaration.some((limit) => limit.kind === wanted.kind && limit.value === wanted.value),
  );
}

/** One scope entry, from `{ kind, value }` or `kind:value`. */
function scopeOf(value: unknown): KnowledgeScope | undefined {
  if (typeof value === "string") {
    const at = value.indexOf(":");
    if (at <= 0) return undefined;
    const kind = value.slice(0, at).trim();
    const limit = value.slice(at + 1).trim();
    if (!isScopeKind(kind) || limit === "") return undefined;
    return { kind, value: limit };
  }
  if (!isMapping(value)) return undefined;
  const kind = value.kind;
  const limit = value.value;
  if (!isScopeKind(kind) || typeof limit !== "string" || limit.trim() === "") return undefined;
  return { kind, value: limit.trim() };
}

/** One citation, from a string or `{ value, public }`. */
function citationOf(value: unknown): KnowledgeCitation | undefined {
  if (typeof value === "string") return value.trim() === "" ? undefined : { value: value.trim() };
  if (!isMapping(value)) return undefined;
  if (typeof value.value !== "string" || value.value.trim() === "") return undefined;
  return {
    value: value.value.trim(),
    ...(typeof value.public === "boolean" ? { public: value.public } : {}),
  };
}

/** True for one of the four scope dimensions. */
function isScopeKind(value: unknown): value is KnowledgeScopeKind {
  return typeof value === "string" && (KNOWLEDGE_SCOPE_KINDS as readonly string[]).includes(value);
}

/** A non-array, non-null object. */
function isMapping(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Turns one ajv finding into a located diagnostic. */
function diagnosticOf(error: ErrorObject, prefix: string, file: string, span: SourcePos): Diagnostic {
  const pointer = error.instancePath === "" ? "/" : error.instancePath;
  let message: string;
  if (error.keyword === "additionalProperties") {
    message = `\`knowledge\` has an unknown key \`${String((error.params as { additionalProperty?: string }).additionalProperty ?? "")}\`.`;
  } else if (error.keyword === "enum" && pointer === "/status") {
    message = `\`knowledge.status\` must be one of ${KNOWLEDGE_STATUSES.join(", ")}.`;
  } else if (error.keyword === "required") {
    message = `\`knowledge\` is missing \`${String((error.params as { missingProperty?: string }).missingProperty ?? "")}\`.`;
  } else {
    message = `\`knowledge\` does not match its schema at ${pointer}: ${error.message ?? "invalid value"}.`;
  }
  return {
    id: `${prefix}.invalid`,
    severity: "error",
    message,
    pos: { ...span, file },
  };
}

/** Sorts diagnostics by line, column, and id, keeping a stable order for equal positions. */
function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((a, b) => {
    const pa = a.pos;
    const pb = b.pos;
    if (pa === undefined || pb === undefined) return pa === pb ? 0 : pa === undefined ? 1 : -1;
    return pa.line - pb.line || pa.column - pb.column || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}
