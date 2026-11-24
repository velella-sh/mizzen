/**
 * Read a draft's citation markers and normative claims (#1411), and validate the draft against its task (#1411,
 * #1412, #1413).
 *
 * A citation is an inline marker, `[[surface:symbol:parseWidget]]`, `[[behavior:parseWidget.returns-id]]`,
 * `[[evidence:<id-or-url>]]`, `[[test:<file>]]`, `[[example:<file>]]`, or `[[source:<file>:<line>]]`. A paragraph is
 * normative when it uses a verb such as `returns`, `requires`, or `must`; every normative paragraph must carry at least
 * one citation, and the uncited list is reported before a preview is built. The task's explicit unknowns, reviewer
 * questions, and limitations must survive in the draft unchanged, so a writer cannot resolve an unknown by omission.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import type { Ajv2020 as Ajv2020Class, ErrorObject } from "ajv/dist/2020.js";
import type { Site } from "../contracts/index.ts";
import type {
  AuthoringCitation,
  AuthoringClaim,
  AuthoringDraft,
  AuthoringDraftResult,
  AuthoringDraftValidation,
  AuthoringEvidenceKind,
  AuthoringProblem,
  AuthoringQuestion,
  AuthoringTask,
  AuthoringUnknown,
} from "../contracts/authoring.ts";
import { locationConflicts } from "./location.ts";

// ajv is CommonJS: its default export is the class at run time, but its types name it.
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const schema = JSON.parse(
  readFileSync(new URL("../../schema/authoring-draft.schema.json", import.meta.url), "utf8"),
) as object;
const validateShape = new Ajv2020({ strict: true, allErrors: true, verbose: true }).compile(schema);

/** The normative verbs a claim may use. A paragraph with one must be cited. */
const NORMATIVE = /\b(must|must\s+not|should|should\s+not|never|always|returns?|requires?|supports?|rejects?|throws?|emits?|writes?|reads?|resolves?|accepts?|guarantees?|preserves?|fails?|cannot|only|defaults?|outputs?|reports?|validates?|documents?|records?|produces?|prints?|sends?|receives?|creates?|builds?)\b/iu;

/** The citation marker: a kind and a non-empty reference. */
const MARKER = /\[\[([a-z]+):([^\]\n]+)\]\]/gu;

/** The citation kinds a draft may use. */
const EVIDENCE_KINDS: ReadonlySet<string> = new Set(["surface", "behavior", "test", "example", "evidence", "source"]);

/** True when one paragraph states a normative claim. */
export function isNormativeClaim(text: string): boolean {
  return NORMATIVE.test(text);
}

/** A paragraph's text without its citation markers, for display. */
function withoutMarkers(text: string): string {
  return text.replace(MARKER, "").replace(/\s{2,}/g, " ").trim();
}

/** One buffered paragraph while the body is read. */
interface Paragraph {
  readonly line: number;
  readonly lines: string[];
}

/** Flush a paragraph into the claim list. */
function flush(paragraph: Paragraph | undefined, claims: AuthoringClaim[]): void {
  if (paragraph === undefined) return;
  const text = paragraph.lines.join(" ").trim();
  if (text === "") return;
  const citations: AuthoringCitation[] = [];
  for (const match of text.matchAll(MARKER)) {
    const kind = match[1] as AuthoringEvidenceKind;
    const ref = (match[2] ?? "").trim();
    const claim = withoutMarkers(text);
    citations.push({ kind, ref, line: paragraph.line, claim });
  }
  claims.push({ text, line: paragraph.line, normative: isNormativeClaim(withoutMarkers(text)), citations });
}

/**
 * Every paragraph of a draft body, whether it is normative, and its citations. Fenced code blocks and headings are not
 * claims: they show code or label a section, and a normative verb inside them is not a statement about the product.
 */
export function claimsIn(body: string): readonly AuthoringClaim[] {
  const claims: AuthoringClaim[] = [];
  let paragraph: Paragraph | undefined;
  let fence: string | undefined;
  const lines = body.split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (fence !== undefined) {
      if (trimmed.startsWith(fence)) fence = undefined;
      return;
    }
    if (/^(```|~~~)/u.test(trimmed)) {
      flush(paragraph, claims);
      paragraph = undefined;
      fence = trimmed.slice(0, 3);
      return;
    }
    if (trimmed === "" || /^#{1,6}\s/u.test(trimmed)) {
      flush(paragraph, claims);
      paragraph = undefined;
      return;
    }
    // A list item or a blockquote starts a new claim; a wrapped prose line continues the current one.
    if (/^(?:[-*+]|\d+[.)])\s/u.test(trimmed) || trimmed.startsWith(">")) {
      flush(paragraph, claims);
      paragraph = { line: index + 1, lines: [line] };
      return;
    }
    if (paragraph === undefined) paragraph = { line: index + 1, lines: [line] };
    else paragraph.lines.push(line);
  });
  flush(paragraph, claims);
  return claims;
}

/** Every citation in document order. */
export function citationsIn(claims: readonly AuthoringClaim[]): readonly AuthoringCitation[] {
  return claims.flatMap((claim) => claim.citations);
}

/** A problem at a JSON Pointer or a body line. */
function problem(path: string, code: string, message: string): AuthoringProblem {
  return { path, code, message };
}

/** The JSON Pointer of an ajv finding. */
function pointerOf(error: ErrorObject): string {
  if (error.keyword === "required") {
    const key = String(error.params.missingProperty ?? "");
    return error.instancePath === "" ? `/${key}` : `${error.instancePath}/${key}`;
  }
  return error.instancePath;
}

/** The expected JSON type, as a sentence fragment. */
function expectedType(type: unknown): string {
  switch (type) {
    case "string":
      return "a string";
    case "array":
      return "a list";
    case "object":
      return "an object";
    case "integer":
      return "an integer";
    case "number":
      return "a number";
    case "boolean":
      return "true or false";
    default:
      return String(type);
  }
}

/** Translates one ajv finding into a stable code and a sentence. */
function problemFromAjv(error: ErrorObject): AuthoringProblem {
  const path = pointerOf(error);
  const where = path === "" ? "The draft" : `\`${path}\``;
  switch (error.keyword) {
    case "required":
      return problem(path, "authoring.draft-missing", `${where} is required.`);
    case "additionalProperties":
      return problem(path, "authoring.draft-unknown-key", `${where} is not a key a draft may set.`);
    case "type":
      return problem(path, "authoring.draft-type", `${where} must be ${expectedType(error.params.type)}.`);
    case "const":
      return problem(path, "authoring.draft-version", "Only authoring draft version 1 is supported.");
    case "enum":
      return problem(path, "authoring.draft-enum", `${where} must be one of: ${(error.params.allowedValues as readonly unknown[] | undefined ?? []).map((value) => `\`${String(value)}\``).join(", ")}.`);
    case "pattern":
      return problem(path, "authoring.draft-format", `${where} does not have the required form.`);
    case "minLength":
    case "minItems":
      return problem(path, "authoring.draft-empty", `${where} must not be empty.`);
    default:
      return problem(path, "authoring.draft-invalid", `${where} ${error.message ?? "is invalid"}.`);
  }
}

/** Parses a draft from an already-decoded JSON value. */
export function parseAuthoringDraft(value: unknown): AuthoringDraftResult {
  if (!validateShape(value)) {
    return { problems: (validateShape.errors ?? []).map(problemFromAjv) };
  }
  return { draft: value as AuthoringDraft, problems: [] };
}

/** The id of a missing or changed task unknown. */
function unknownKey(unknown: AuthoringUnknown): string {
  return unknown.id;
}

/** The id of a missing or changed task question. */
function questionKey(question: AuthoringQuestion): string {
  return question.id;
}

/** True when a citation matches one required evidence entry. */
function citationAllowed(citation: AuthoringCitation, task: AuthoringTask): boolean {
  if (!EVIDENCE_KINDS.has(citation.kind)) return false;
  if (citation.kind === "surface") return citation.ref === task.item;
  if (citation.kind === "source") {
    const match = /^(.*):(\d+)$/u.exec(citation.ref);
    if (match === null) return false;
    const file = match[1]!;
    const line = Number(match[2]);
    return (
      file === task.surface.source.file &&
      line >= task.surface.source.line &&
      line <= Math.max(task.surface.source.line, task.surface.source.endLine)
    );
  }
  return task.requiredEvidence.some((entry) => entry.kind === citation.kind && entry.ref === citation.ref);
}

/** The task unknowns a normative claim's citations still leave unsupported. */
function unsupportedByUnknowns(citations: readonly AuthoringCitation[], task: AuthoringTask): readonly string[] {
  const unverified = new Set(
    task.unknowns
      .filter((unknown) => unknown.id.startsWith("behavior-"))
      .map((unknown) => unknown.id.slice("behavior-".length)),
  );
  const out: string[] = [];
  for (const citation of citations) {
    if (citation.kind === "behavior" && unverified.has(citation.ref)) out.push(citation.ref);
  }
  return [...new Set(out)];
}

/**
 * Validates a draft against its task and the site. An uncited normative claim, an unknown citation, a dropped unknown,
 * a changed limitation, a different location, or a location conflict makes `ok` false; every reason is named.
 */
export function validateAuthoringDraft(
  draft: AuthoringDraft,
  task: AuthoringTask,
  site?: Site,
): AuthoringDraftValidation {
  const problems: AuthoringProblem[] = [];
  const claims = claimsIn(draft.body);
  const citations = citationsIn(claims);
  const uncited = claims.filter((claim) => claim.normative && claim.citations.length === 0);

  if (draft.item !== task.item) {
    problems.push(problem("/item", "authoring.item-mismatch", `The draft documents \`${draft.item}\`, not \`${task.item}\`.`));
  }
  if (draft.pageType !== task.pageType.kind) {
    problems.push(
      problem(
        "/pageType",
        "authoring.page-type",
        `The task recommends \`${task.pageType.kind}\`; the draft uses \`${draft.pageType}\`.`,
      ),
    );
  }
  if (draft.slug !== task.location.url) {
    problems.push(problem("/slug", "authoring.location-mismatch", `The task proposes \`${task.location.url}\`, not \`${draft.slug}\`.`));
  }
  if (draft.block !== task.location.block) {
    problems.push(problem("/block", "authoring.location-mismatch", `The task proposes \`${task.location.block}\`, not \`${draft.block}\`.`));
  }
  const marker = `{#${draft.block}}`;
  const firstHeading = draft.body.split(/\r?\n/u).find((line) => /^#{1,6}\s/u.test(line.trim()));
  if (firstHeading === undefined || !firstHeading.includes(marker)) {
    problems.push(
      problem(
        "/body",
        "authoring.block-heading",
        `The first heading must declare the proposed block id with \`${marker}\`.`,
      ),
    );
  }

  for (const citation of citations) {
    if (!EVIDENCE_KINDS.has(citation.kind)) {
      problems.push(problem(`/body:${citation.line}`, "authoring.citation-kind", `\`${citation.kind}\` is not a citation kind.`));
      continue;
    }
    if (!citationAllowed(citation, task)) {
      problems.push(
        problem(
          `/body:${citation.line}`,
          "authoring.citation-unknown",
          `Citation \`[[${citation.kind}:${citation.ref}]]\` is not evidence the task requires.`,
        ),
      );
    }
  }

  for (const claim of uncited) {
    problems.push(
      problem(
        `/body:${claim.line}`,
        "authoring.uncited-claim",
        `The normative claim at line ${claim.line} has no citation: "${withoutMarkers(claim.text)}"`,
      ),
    );
  }
  for (const claim of claims.filter((entry) => entry.normative)) {
    const unsupported = unsupportedByUnknowns(claim.citations, task);
    if (unsupported.length > 0) {
      problems.push(
        problem(
          `/body:${claim.line}`,
          "authoring.unsupported-claim",
          `The claim at line ${claim.line} cites behavior(s) the task marks unverified: ${unsupported.join(", ")}.`,
        ),
      );
    }
  }

  const draftUnknowns = new Map(draft.unknowns.map((unknown) => [unknownKey(unknown), unknown]));
  for (const required of task.unknowns) {
    const found = draftUnknowns.get(required.id);
    if (found === undefined) {
      problems.push(problem("/unknowns", "authoring.unknown-dropped", `The draft drops the explicit unknown \`${required.id}\`.`));
    } else if (found.statement !== required.statement) {
      problems.push(
        problem("/unknowns", "authoring.unknown-changed", `The draft changes the statement of \`${required.id}\`; keep it as the task wrote it.`),
      );
    }
  }
  const draftQuestions = new Map(draft.questions.map((question) => [questionKey(question), question]));
  for (const required of task.questions) {
    const found = draftQuestions.get(required.id);
    if (found === undefined) {
      problems.push(problem("/questions", "authoring.question-dropped", `The draft drops the reviewer question \`${required.id}\`.`));
    } else if (found.question !== required.question) {
      problems.push(
        problem("/questions", "authoring.question-changed", `The draft changes the question \`${required.id}\`; keep it as the task wrote it.`),
      );
    }
  }
  for (const required of task.limitations) {
    if (!draft.limitations.includes(required)) {
      problems.push(problem("/limitations", "authoring.limitation-dropped", `The draft drops the limitation "${required}".`));
    }
  }

  const conflicts = site === undefined ? task.conflicts : [...task.conflicts, ...locationConflicts(task.location, site)];
  return {
    version: 1,
    item: draft.item,
    draft,
    pageType: draft.pageType,
    claims,
    citations,
    uncited,
    problems,
    conflicts: conflicts
      .filter((conflict, index, all) => all.findIndex((entry) => entry.kind === conflict.kind && entry.value === conflict.value) === index)
      .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.value < b.value ? -1 : a.value > b.value ? 1 : 0)),
    unknowns: draft.unknowns,
    questions: draft.questions,
    limitations: draft.limitations,
    ok: problems.length === 0 && uncited.length === 0 && conflicts.length === 0,
  };
}

/** The source text a draft writes: front matter, a blank line, then the body. */
export function renderDraftSource(draft: AuthoringDraft): string {
  const quote = (value: string): string => JSON.stringify(value);
  const lines = ["---", `title: ${quote(draft.title)}`];
  if (draft.description !== undefined) lines.push(`description: ${quote(draft.description)}`);
  lines.push("layout: doc", `permalink: ${quote(draft.slug)}`, "---", "", draft.body.replace(/\s+$/u, ""), "");
  return lines.join("\n");
}
