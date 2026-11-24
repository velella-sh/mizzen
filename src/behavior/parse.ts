/**
 * Reads behavior declarations from a page's front matter and explains every malformed one at its source span.
 *
 * Parsing is local and synchronous: no file read, no network, no clock. A declaration is either the whole shape this
 * module accepts or it is rejected with diagnostics; the caller never receives a partly normalized behavior. Duplicate
 * ids across pages and replacement links are checked by the report, because only it sees every page.
 */
import { isSeq, parseDocument, type Node } from "yaml";
import type { Diagnostic } from "../contracts/diagnostic.ts";
import type { SourcePos } from "../contracts/source.ts";
import type {
  BehaviorDeclaration,
  BehaviorEnvironment,
  BehaviorEvidenceDeclaration,
  BehaviorEvidenceKind,
  BehaviorSupportStatus,
  BehaviorTestDeclaration,
  BehaviorTestOutcome,
  BehaviorVersionHistory,
} from "../contracts/behavior.ts";
import { formatSpan } from "../source/spans.ts";
import { compareBehaviorVersions } from "./version.ts";

/** The four support statuses, in report order. */
export const BEHAVIOR_STATUSES: readonly BehaviorSupportStatus[] = ["supported", "experimental", "deprecated", "removed"];

/** The three expected test outcomes. */
export const BEHAVIOR_TEST_OUTCOMES: readonly BehaviorTestOutcome[] = ["passed", "failed", "skipped"];

/** The four evidence kinds. */
export const BEHAVIOR_EVIDENCE_KINDS: readonly BehaviorEvidenceKind[] = ["test", "ci", "benchmark", "document"];

/** The front matter key that carries behavior declarations. */
export const BEHAVIOR_KEY = "behavior";

/** What one parse reads. */
export interface ParseBehaviorsOptions {
  /** The whole source file, so a declaration's span is exact. */
  readonly text: string;
  /** The file, relative to the repository root, for diagnostics. */
  readonly file: string;
  /** The `behavior` value from the parsed front matter. */
  readonly raw: unknown;
  /** The span of the `behavior` key, used when a YAML node has no range. */
  readonly span: SourcePos;
}

/** One parse result: the declarations read and every finding. */
export interface ParseBehaviorsResult {
  readonly declarations: readonly BehaviorDeclaration[];
  readonly diagnostics: readonly Diagnostic[];
}

/** A non-array, non-null object. */
function isMapping(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty trimmed string, or `undefined` for anything else. */
function textOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text;
}

/** True for one of the four statuses. */
export function isBehaviorStatus(value: unknown): value is BehaviorSupportStatus {
  return typeof value === "string" && (BEHAVIOR_STATUSES as readonly string[]).includes(value);
}

/** Counts the newlines in a prefix of `text`. */
function newlines(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) if (text[index] === "\n") count += 1;
  return count;
}

/** The number of Unicode code points in `text`, which is how a column is counted. */
function width(text: string): number {
  return [...text].length;
}

/** The line and column a zero-based offset falls on, with `startLine` as the first line's number. */
function positionOf(text: string, offset: number, startLine: number, file: string): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const line = startLine + newlines(before);
  const lastBreak = before.lastIndexOf("\n");
  return { line, column: width(before.slice(lastBreak + 1)) + 1 };
}

/** The span of a YAML node within a front matter block, or `undefined` when it has no usable range. */
function spanOfNode(
  node: Node | undefined,
  block: { readonly text: string; readonly line: number },
  file: string,
): SourcePos | undefined {
  const range = (node as { range?: readonly [number, number, number] | null } | undefined)?.range;
  if (range === null || range === undefined) return undefined;
  const start = positionOf(block.text, range[0], block.line, file);
  const inclusiveEnd = Math.max(range[0], range[1] - 1);
  const end = positionOf(block.text, inclusiveEnd, block.line, file);
  return {
    file,
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: Math.max(end.line === start.line ? start.column : 1, end.column),
  };
}

/** The YAML text and first line of a file's `---` fenced front matter, or `undefined` when there is none. */
function frontMatterBlock(text: string): { text: string; line: number } | undefined {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return undefined;
  let close = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---") {
      close = index;
      break;
    }
  }
  if (close < 0) return undefined;
  return { text: `${lines.slice(1, close).join("\n")}\n`, line: 2 };
}

/** One span per raw entry: the YAML node's own range when it has one, else the key's span. */
function entrySpans(options: ParseBehaviorsOptions): readonly SourcePos[] {
  const count = Array.isArray(options.raw) ? options.raw.length : 1;
  const fallback = Array.from({ length: count }, () => options.span);
  const block = frontMatterBlock(options.text);
  if (block === undefined) return fallback;
  let node: Node | undefined;
  try {
    const doc = parseDocument(block.text);
    node = doc.getIn([BEHAVIOR_KEY], true) as Node | undefined;
  } catch {
    return fallback;
  }
  if (node === undefined) return fallback;
  if (Array.isArray(options.raw)) {
    if (!isSeq(node)) return fallback;
    return (node.items as readonly (Node | undefined)[]).map(
      (item, index) => spanOfNode(item, block, options.file) ?? fallback[index] ?? options.span,
    );
  }
  return [spanOfNode(node, block, options.file) ?? options.span];
}

/** Adds one finding to a list and returns it. */
function fail(
  diagnostics: Diagnostic[],
  code: string,
  message: string,
  pos: SourcePos,
  help?: string,
): undefined {
  diagnostics.push({ id: code, severity: "error", message, pos, ...(help === undefined ? {} : { help }) });
  return undefined;
}

/** True when `version` is at or after `floor`. */
function atOrAfter(version: string, floor: string): boolean {
  return compareBehaviorVersions(version, floor) >= 0;
}

/** Reads the versions block and checks its order and its fit with the status. */
function versionsOf(
  value: unknown,
  status: BehaviorSupportStatus,
  pos: SourcePos,
  diagnostics: Diagnostic[],
): BehaviorVersionHistory | undefined {
  if (!isMapping(value)) {
    return fail(diagnostics, "behavior.invalid-versions", "`behavior.versions` must be a mapping with `introduced`.", pos);
  }
  const unknown = Object.keys(value).filter((key) => !["introduced", "changed", "deprecated", "removed"].includes(key));
  if (unknown.length > 0) {
    return fail(diagnostics, "behavior.unknown-version-key", `\`behavior.versions\` has an unknown key: ${unknown.join(", ")}.`, pos);
  }
  const introduced = textOf(value.introduced);
  if (introduced === undefined) {
    return fail(diagnostics, "behavior.invalid-introduced", "`behavior.versions.introduced` must be a non-empty version.", pos);
  }
  const changed: string[] = [];
  if (value.changed !== undefined) {
    if (!Array.isArray(value.changed)) {
      return fail(diagnostics, "behavior.invalid-changed", "`behavior.versions.changed` must be a list of versions.", pos);
    }
    for (const entry of value.changed) {
      const version = textOf(entry);
      if (version === undefined) return fail(diagnostics, "behavior.invalid-changed", "Every `versions.changed` entry must be a non-empty version.", pos);
      if (changed.includes(version)) return fail(diagnostics, "behavior.invalid-changed", `\`versions.changed\` repeats "${version}".`, pos);
      if (!atOrAfter(version, introduced)) return fail(diagnostics, "behavior.version-order", `\`versions.changed\` names "${version}", before the introduction "${introduced}".`, pos);
      changed.push(version);
    }
  }
  const deprecated = value.deprecated === undefined ? undefined : textOf(value.deprecated);
  if (value.deprecated !== undefined && deprecated === undefined) {
    return fail(diagnostics, "behavior.invalid-deprecated", "`behavior.versions.deprecated` must be a non-empty version.", pos);
  }
  const removed = value.removed === undefined ? undefined : textOf(value.removed);
  if (value.removed !== undefined && removed === undefined) {
    return fail(diagnostics, "behavior.invalid-removed", "`behavior.versions.removed` must be a non-empty version.", pos);
  }
  if (deprecated !== undefined && !atOrAfter(deprecated, introduced)) {
    return fail(diagnostics, "behavior.version-order", `Deprecation "${deprecated}" is before the introduction "${introduced}".`, pos);
  }
  if (removed !== undefined && !atOrAfter(removed, introduced)) {
    return fail(diagnostics, "behavior.version-order", `Removal "${removed}" is before the introduction "${introduced}".`, pos);
  }
  if (deprecated !== undefined && removed !== undefined && !atOrAfter(removed, deprecated)) {
    return fail(diagnostics, "behavior.version-order", `Removal "${removed}" is before the deprecation "${deprecated}".`, pos);
  }
  if (status === "deprecated" && deprecated === undefined) {
    return fail(diagnostics, "behavior.missing-deprecated", "A `deprecated` behavior needs `versions.deprecated`.", pos);
  }
  if (status === "removed" && removed === undefined) {
    return fail(diagnostics, "behavior.missing-removed", "A `removed` behavior needs `versions.removed`.", pos);
  }
  if ((status === "supported" || status === "experimental") && (deprecated !== undefined || removed !== undefined)) {
    return fail(diagnostics, "behavior.status-version", `A \`${status}\` behavior cannot already be deprecated or removed; change its status or its versions.`, pos);
  }
  return {
    introduced,
    ...(changed.length === 0 ? {} : { changed }),
    ...(deprecated === undefined ? {} : { deprecated }),
    ...(removed === undefined ? {} : { removed }),
  };
}

/** Reads one environment entry. */
function environmentOf(value: unknown): BehaviorEnvironment | undefined {
  if (!isMapping(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.some((key) => !["os", "language", "runtime"].includes(key))) return undefined;
  const os = value.os === undefined ? undefined : textOf(value.os);
  const language = value.language === undefined ? undefined : textOf(value.language);
  const runtime = value.runtime === undefined ? undefined : textOf(value.runtime);
  if (value.os !== undefined && os === undefined) return undefined;
  if (value.language !== undefined && language === undefined) return undefined;
  if (value.runtime !== undefined && runtime === undefined) return undefined;
  if (os === undefined && language === undefined && runtime === undefined) return undefined;
  return {
    ...(os === undefined ? {} : { os }),
    ...(language === undefined ? {} : { language }),
    ...(runtime === undefined ? {} : { runtime }),
  };
}

/** Reads the environments list; empty or absent means the behavior applies everywhere. */
function environmentsOf(value: unknown, pos: SourcePos, diagnostics: Diagnostic[]): BehaviorEnvironment[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    return fail(diagnostics, "behavior.invalid-environment", "`behavior.environments` must be a list of os, language, or runtime limits.", pos);
  }
  const out: BehaviorEnvironment[] = [];
  for (const entry of value) {
    const environment = environmentOf(entry);
    if (environment === undefined) {
      return fail(diagnostics, "behavior.invalid-environment", "Each environment must name at least one of os, language, or runtime, with non-empty values.", pos);
    }
    out.push(environment);
  }
  return out;
}

/** Reads the surface ids: one non-empty string or a list of them. */
function surfaceOf(value: unknown, pos: SourcePos, diagnostics: Diagnostic[]): string[] | undefined {
  if (value === undefined) return [];
  const entries = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const entry of entries) {
    const id = textOf(entry);
    if (id === undefined) {
      return fail(diagnostics, "behavior.invalid-surface", "`behavior.surface` must name surface item ids such as `command:build`.", pos);
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Reads one test declaration. */
function testOf(value: unknown): BehaviorTestDeclaration | undefined {
  if (!isMapping(value)) return undefined;
  if (Object.keys(value).some((key) => !["file", "name", "outcome", "public"].includes(key))) return undefined;
  const file = textOf(value.file);
  const outcome = value.outcome;
  if (file === undefined || !(BEHAVIOR_TEST_OUTCOMES as readonly unknown[]).includes(outcome)) return undefined;
  if (file.startsWith("/") || file.split("/").includes("..")) return undefined;
  const name = value.name === undefined ? undefined : textOf(value.name);
  if (value.name !== undefined && name === undefined) return undefined;
  if (value.public !== undefined && typeof value.public !== "boolean") return undefined;
  return {
    file,
    ...(name === undefined ? {} : { name }),
    outcome: outcome as BehaviorTestOutcome,
    ...(value.public === undefined ? {} : { public: value.public }),
  };
}

/** Reads the tests list. */
function testsOf(value: unknown, pos: SourcePos, diagnostics: Diagnostic[]): BehaviorTestDeclaration[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    return fail(diagnostics, "behavior.invalid-test", "`behavior.tests` must be a list of `{ file, outcome }` entries.", pos);
  }
  const out: BehaviorTestDeclaration[] = [];
  for (const entry of value) {
    const test = testOf(entry);
    if (test === undefined) {
      return fail(diagnostics, "behavior.invalid-test", "Each test needs a repository-relative `file` and an `outcome` of passed, failed, or skipped.", pos);
    }
    out.push(test);
  }
  return out;
}

/** True for a safe public evidence URL: an `https:` address without credentials, or a root-relative path. */
export function isPublicEvidenceUrl(value: string): boolean {
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

/** Reads one evidence declaration. */
function evidenceOf(value: unknown): BehaviorEvidenceDeclaration | undefined {
  if (!isMapping(value)) return undefined;
  if (Object.keys(value).some((key) => !["id", "url", "title", "kind", "public"].includes(key))) return undefined;
  const id = value.id === undefined ? undefined : textOf(value.id);
  const url = value.url === undefined ? undefined : textOf(value.url);
  if (value.id !== undefined && id === undefined) return undefined;
  if (value.url !== undefined && (url === undefined || !isPublicEvidenceUrl(url))) return undefined;
  if (id === undefined && url === undefined) return undefined;
  const title = value.title === undefined ? undefined : textOf(value.title);
  if (value.title !== undefined && title === undefined) return undefined;
  const kind = value.kind;
  if (kind !== undefined && !(BEHAVIOR_EVIDENCE_KINDS as readonly unknown[]).includes(kind)) return undefined;
  if (value.public !== undefined && typeof value.public !== "boolean") return undefined;
  const resolvedKind: BehaviorEvidenceKind | undefined = kind === undefined ? undefined : (kind as BehaviorEvidenceKind);
  return {
    ...(id === undefined ? {} : { id }),
    ...(url === undefined ? {} : { url }),
    ...(title === undefined ? {} : { title }),
    ...(resolvedKind === undefined ? {} : { kind: resolvedKind }),
    ...(value.public === undefined ? {} : { public: value.public }),
  };
}

/** Reads the evidence list. */
function evidenceListOf(value: unknown, pos: SourcePos, diagnostics: Diagnostic[]): BehaviorEvidenceDeclaration[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    return fail(diagnostics, "behavior.invalid-evidence", "`behavior.evidence` must be a list of `{ id | url, kind? }` entries.", pos);
  }
  const out: BehaviorEvidenceDeclaration[] = [];
  for (const entry of value) {
    const evidence = evidenceOf(entry);
    if (evidence === undefined) {
      return fail(diagnostics, "behavior.invalid-evidence", "Each evidence entry needs an `id` or a public `url` (https or /path); optional keys are title, kind, and public.", pos);
    }
    out.push(evidence);
  }
  return out;
}

/** Reads one declaration, returning it only when every field is valid. */
function declarationOf(
  value: unknown,
  pos: SourcePos,
  diagnostics: Diagnostic[],
): BehaviorDeclaration | undefined {
  if (!isMapping(value)) {
    return fail(diagnostics, "behavior.invalid-shape", "A behavior must be a mapping.", pos);
  }
  const allowed = ["id", "title", "normative", "status", "versions", "replacement", "environments", "surface", "tests", "evidence", "public"];
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    return fail(diagnostics, "behavior.unknown-key", `A behavior has an unknown key: ${unknown.join(", ")}.`, pos);
  }
  const id = textOf(value.id);
  if (id === undefined) return fail(diagnostics, "behavior.invalid-id", "`behavior.id` must be a non-empty stable id.", pos);
  const title = textOf(value.title);
  if (title === undefined) return fail(diagnostics, "behavior.invalid-title", "`behavior.title` must be a non-empty string.", pos);
  const normative = textOf(value.normative);
  if (normative === undefined) return fail(diagnostics, "behavior.invalid-normative", "`behavior.normative` must be a non-empty statement.", pos);
  if (!isBehaviorStatus(value.status)) {
    return fail(diagnostics, "behavior.invalid-status", `\`behavior.status\` must be one of ${BEHAVIOR_STATUSES.join(", ")}.`, pos);
  }
  const versions = versionsOf(value.versions, value.status, pos, diagnostics);
  if (versions === undefined) return undefined;
  const replacement = value.replacement === undefined ? undefined : textOf(value.replacement);
  if (value.replacement !== undefined && replacement === undefined) {
    return fail(diagnostics, "behavior.invalid-replacement", "`behavior.replacement` must be a behavior id.", pos);
  }
  if (replacement !== undefined && value.status !== "deprecated" && value.status !== "removed") {
    return fail(diagnostics, "behavior.invalid-replacement", "Only a deprecated or removed behavior may name a replacement.", pos);
  }
  const environments = environmentsOf(value.environments, pos, diagnostics);
  if (environments === undefined) return undefined;
  const surface = surfaceOf(value.surface, pos, diagnostics);
  if (surface === undefined) return undefined;
  const tests = testsOf(value.tests, pos, diagnostics);
  if (tests === undefined) return undefined;
  const evidence = evidenceListOf(value.evidence, pos, diagnostics);
  if (evidence === undefined) return undefined;
  if (value.public !== undefined && typeof value.public !== "boolean") {
    return fail(diagnostics, "behavior.invalid-public", "`behavior.public` must be true or false.", pos);
  }
  return {
    id,
    title,
    normative,
    source: pos,
    status: value.status,
    versions,
    ...(replacement === undefined ? {} : { replacement }),
    environments,
    surface,
    tests,
    evidence,
    ...(value.public === undefined ? {} : { public: value.public }),
  };
}

/** Sorts diagnostics by file, line, column, end, then id, so a report is deterministic. */
export function sortBehaviorDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((a, b) => {
    const pa = a.pos;
    const pb = b.pos;
    if (pa === undefined || pb === undefined) return pa === pb ? 0 : pa === undefined ? 1 : -1;
    return (
      (pa.file < pb.file ? -1 : pa.file > pb.file ? 1 : 0) ||
      pa.line - pb.line ||
      pa.column - pb.column ||
      pa.endLine - pb.endLine ||
      pa.endColumn - pb.endColumn ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
  });
}

/**
 * Reads every behavior a page declares. `raw` may be one mapping or a list of mappings. An entry with any problem is
 * rejected whole and the others are kept, so one bad behavior does not hide the rest.
 */
export function parseBehaviors(options: ParseBehaviorsOptions): ParseBehaviorsResult {
  const diagnostics: Diagnostic[] = [];
  if (options.raw === undefined || options.raw === null || options.raw === false) {
    return { declarations: [], diagnostics: [] };
  }
  const entries = Array.isArray(options.raw) ? options.raw : [options.raw];
  const spans = entrySpans(options);
  const declarations: BehaviorDeclaration[] = [];
  entries.forEach((entry, index) => {
    const pos = spans[index] ?? options.span;
    const before = diagnostics.length;
    const declaration = declarationOf(entry, pos, diagnostics);
    if (declaration !== undefined && diagnostics.length === before) declarations.push(declaration);
    if (declaration === undefined && diagnostics.length === before) {
      diagnostics.push({
        id: "behavior.invalid-shape",
        severity: "error",
        message: "A behavior entry could not be read.",
        pos,
      });
    }
  });
  return { declarations, diagnostics: sortBehaviorDiagnostics(diagnostics) };
}

/** One duplicate id and every declaration that uses it, so a report can name both source locations. */
export interface DuplicateBehaviorId {
  readonly id: string;
  readonly declarations: readonly BehaviorDeclaration[];
}

/** Every id declared more than once anywhere in the given declarations. */
export function duplicateBehaviorIds(declarations: readonly BehaviorDeclaration[]): DuplicateBehaviorId[] {
  const byId = new Map<string, BehaviorDeclaration[]>();
  for (const declaration of declarations) {
    const list = byId.get(declaration.id);
    if (list === undefined) byId.set(declaration.id, [declaration]);
    else list.push(declaration);
  }
  return [...byId.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([id, list]) => ({ id, declarations: list }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The sentence a duplicate-id finding uses, naming every location. */
export function duplicateLocationText(duplicates: DuplicateBehaviorId): string {
  return duplicates.declarations.map((declaration) => formatSpan(declaration.source)).join(" and ");
}
