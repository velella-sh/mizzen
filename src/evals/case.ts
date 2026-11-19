/**
 * Parsing and validation for the versioned evaluation case and suite formats.
 *
 * The shape is checked against `schema/eval-case.schema.json` and `schema/eval-suite.schema.json`
 * with ajv; every finding carries the JSON Pointer of the value to change. Once the shape is valid,
 * the cross-field rules run: the capability names the expectation, duplicated ids and tool names are
 * refused, every referenced folder or file is relative with forward slashes, and a case either has
 * an expected outcome or a reason it cannot be evaluated yet.
 *
 * Reading is local and synchronous: no model, no network, no clock. Two runs on the same bytes give
 * the same problems in the same order.
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { ErrorObject } from "ajv";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type {
  EvalCase,
  EvalCaseParseResult,
  EvalCapability,
  EvalProblem,
  EvalSuite,
  EvalSuiteParseResult,
} from "../contracts/evals.ts";

// ajv is CommonJS: its default export is the class at run time, but its types name it.
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;

function schemaAt(name: string): object {
  return JSON.parse(readFileSync(new URL(`../../schema/${name}`, import.meta.url), "utf8")) as object;
}

const validateCaseShape = new Ajv2020({ strict: true, strictRequired: false, allErrors: true, verbose: true }).compile(
  schemaAt("eval-case.schema.json"),
);
const validateSuiteShape = new Ajv2020({ strict: true, strictRequired: false, allErrors: true, verbose: true }).compile(
  schemaAt("eval-suite.schema.json"),
);

/** The capabilities that read a recorded agent output from `inputs.agent`. */
const RECORDED: ReadonlySet<EvalCapability> = new Set(["discovery", "answer", "edit", "permission"]);

/** What a missing field should hold, by field name. */
const MISSING_HELP: Readonly<Record<string, string>> = {
  version: "Set `version` to 1, the only evaluation case version.",
  id: "Give the case a stable lower-case `id`, such as `answer.node-version`.",
  capability: "Name the capability the case measures.",
  goal: "Describe the task in `goal` as one sentence.",
  fixture: "Name the site fixture folder, relative to the suite.",
  snapshot: "Label the fixture snapshot the case was written for.",
  permissions: "Give the case `read`, `write`, and `check` permission lists.",
  budget: "Give the case `maxTokens` and `maxToolCalls` limits.",
  criteria: "List the acceptance criteria the case scores.",
  tools: "Pin the tool versions the case expects.",
  expected: "Give the outcome a correct agent produces, or explain why the case is `unavailable`.",
  cases: "List at least one case file, relative to the suite.",
};

/** The JSON Pointer ajv reports, or the document root. */
function pointerOf(path: string): string {
  return path === "" ? "" : path;
}

/** One sentence for an ajv finding, saying what to write instead. */
function problemOf(error: ErrorObject): EvalProblem {
  const path = pointerOf(error.instancePath);
  const parameter = (error.params as Record<string, unknown>)["missingProperty"];
  if (error.keyword === "required" && typeof parameter === "string") {
    return {
      path,
      code: "eval.missing-field",
      message: `${path === "" ? "The document" : path} needs \`${parameter}\`. ${MISSING_HELP[parameter] ?? `Add \`${parameter}\`.`}`,
    };
  }
  if (error.keyword === "additionalProperties" && typeof parameter === "string") {
    return {
      path,
      code: "eval.unknown-field",
      message: `${path === "" ? "The document" : path} has an unknown field \`${parameter}\`; remove it or use a documented field.`,
    };
  }
  if (error.keyword === "enum") {
    return {
      path,
      code: "eval.invalid-value",
      message: `${path === "" ? "The document" : path} must be one of ${String((error.params as Record<string, unknown>)["allowedValues"])}.`,
    };
  }
  if (error.keyword === "pattern" && (path === "/fixture" || path === "/cases" || path.startsWith("/inputs/") || path.startsWith("/cases/"))) {
    return {
      path,
      code: "eval.relative-path",
      message: `${path} must be relative, with forward slashes and no \`..\` segment.`,
    };
  }
  if (error.keyword === "oneOf" || error.keyword === "anyOf") {
    return {
      path,
      code: "eval.invalid-value",
      message: `${path === "" ? "The expected outcome" : path} does not match one of the documented shapes; check its \`kind\` and required fields.`,
    };
  }
  return {
    path,
    code: "eval.invalid-value",
    message: `${path === "" ? "The document" : path} ${error.message ?? "is not valid"}.`,
  };
}

/** True for a relative path with forward slashes and no escape segment. */
function relative(path: string): boolean {
  return (
    path !== "" &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").some((segment) => segment === ".." || segment === "" || segment === ".")
  );
}

/** Reports a repeated value once for each later occurrence. */
function duplicates(
  values: readonly string[],
  path: string,
  label: string,
  problems: EvalProblem[],
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      problems.push({
        path: `${path}/${index}`,
        code: "eval.duplicate",
        message: `${path}/${index} repeats the ${label} \`${value}\`; keep one.`,
      });
    }
    seen.add(value);
  }
}

/** Parses an already-decoded case value. */
export function parseEvalCase(value: unknown): EvalCaseParseResult {
  if (!validateCaseShape(value)) {
    return { problems: (validateCaseShape.errors ?? []).map(problemOf) };
  }
  const parsed = value as EvalCase;
  const problems: EvalProblem[] = [];

  if (!relative(parsed.fixture)) {
    problems.push({
      path: "/fixture",
      code: "eval.relative-path",
      message: "`fixture` must be relative to the suite, with forward slashes and no `..`.",
    });
  }
  for (const key of ["agent", "policy", "transaction", "proof", "input", "handoff"] as const) {
    const path = parsed.inputs?.[key];
    if (path !== undefined && !relative(path)) {
      problems.push({
        path: `/inputs/${key}`,
        code: "eval.relative-path",
        message: `\`inputs.${key}\` must be relative to the suite, with forward slashes and no \`..\`.`,
      });
    }
  }

  const answerable = parsed.unavailable === undefined;
  if (answerable && parsed.expected !== undefined && parsed.expected.kind !== parsed.capability) {
    problems.push({
      path: "/expected/kind",
      code: "eval.capability-mismatch",
      message: `The case measures \`${parsed.capability}\` but expects \`${parsed.expected.kind}\`; make them equal.`,
    });
  }

  duplicates(parsed.criteria.map((criterion) => criterion.id), "/criteria", "criterion id", problems);
  duplicates(parsed.tools.map((tool) => tool.name), "/tools", "tool name", problems);

  if (answerable) {
    if (RECORDED.has(parsed.capability) && parsed.inputs?.agent === undefined) {
      problems.push({
        path: "/inputs/agent",
        code: "eval.missing-input",
        message: `A \`${parsed.capability}\` case needs a recorded agent output in \`inputs.agent\`.`,
      });
    }
    if (parsed.capability === "permission" && parsed.inputs?.policy === undefined) {
      problems.push({
        path: "/inputs/policy",
        code: "eval.missing-input",
        message: "A `permission` case needs the access policy to decide against in `inputs.policy`.",
      });
    }
    if (parsed.capability === "transaction" && parsed.inputs?.transaction === undefined) {
      problems.push({
        path: "/inputs/transaction",
        code: "eval.missing-input",
        message: "A `transaction` case needs the transaction document to apply in `inputs.transaction`.",
      });
    }
    if (parsed.capability === "verification" && (parsed.inputs?.proof === undefined || parsed.inputs?.input === undefined)) {
      problems.push({
        path: "/inputs",
        code: "eval.missing-input",
        message: "A `verification` case needs `inputs.proof` and the verifier's `inputs.input`.",
      });
    }
    if (parsed.capability === "handoff" && parsed.inputs?.handoff === undefined) {
      problems.push({
        path: "/inputs/handoff",
        code: "eval.missing-input",
        message: "A `handoff` case needs the public document to resume in `inputs.handoff`.",
      });
    }
  }

  return problems.length === 0 ? { case: parsed, problems } : { problems };
}

/** Parses an already-decoded suite value. */
export function parseEvalSuite(value: unknown): EvalSuiteParseResult {
  if (!validateSuiteShape(value)) {
    return { problems: (validateSuiteShape.errors ?? []).map(problemOf) };
  }
  const parsed = value as EvalSuite;
  const problems: EvalProblem[] = [];
  duplicates(parsed.cases, "/cases", "case path", problems);
  duplicates((parsed.pins?.tools ?? []).map((tool) => tool.name), "/pins/tools", "tool name", problems);
  for (const [index, path] of parsed.cases.entries()) {
    if (!relative(path)) {
      problems.push({
        path: `/cases/${index}`,
        code: "eval.relative-path",
        message: `\`${path}\` must be relative to the suite, with forward slashes and no \`..\`.`,
      });
    }
  }
  return problems.length === 0 ? { suite: parsed, problems } : { problems };
}

/** Reads one case file; a read or JSON error is a located problem, never a thrown parse. */
export async function readEvalCase(file: string): Promise<EvalCaseParseResult> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    return {
      problems: [
        {
          path: "",
          code: "eval.unreadable",
          message: `${file}: cannot read the case: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
  try {
    return parseEvalCase(JSON.parse(text) as unknown);
  } catch (error) {
    return {
      problems: [
        {
          path: "",
          code: "eval.invalid-json",
          message: `${file}: the case is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}

/** Reads one suite file; a read or JSON error is a located problem, never a thrown parse. */
export async function readEvalSuite(file: string): Promise<EvalSuiteParseResult> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    return {
      problems: [
        {
          path: "",
          code: "eval.unreadable",
          message: `${file}: cannot read the suite: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
  try {
    return parseEvalSuite(JSON.parse(text) as unknown);
  } catch (error) {
    return {
      problems: [
        {
          path: "",
          code: "eval.invalid-json",
          message: `${file}: the suite is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}
