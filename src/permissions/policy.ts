/**
 * Parsing and defaults for the versioned access policy.
 *
 * The shape is checked against `../../schema/access-policy.schema.json` with ajv; every finding carries the JSON
 * Pointer of the value to change. Once the shape is valid, the cross-field rules run: a granted write needs both a
 * path and a scope, a granted execute needs a named runner, a granted network needs a destination and a stage, and a
 * field allowlist must belong to an allowed collection. The normalizer trims strings and sorts field keys, so two
 * runs on the same document produce the same bytes and the same fingerprint.
 *
 * An absent policy is not an error: {@link defaultAccessPolicy} grants public read only and denies write, execute,
 * network, and publish.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { ErrorObject } from "ajv";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type {
  AccessApprovalPolicy,
  AccessCheckPolicy,
  AccessPolicy,
  AccessPolicyParseResult,
  AccessPolicyProblem,
  AccessReadPolicy,
  AccessRunnerGrant,
  AccessStage,
  AccessWritePolicy,
  AccessWriteScope,
} from "../contracts/permissions.ts";
import { anyReferenceMatches, byCodePoint, destinationOf, referencesWithin } from "./match.ts";

/** The only access-policy version this parser accepts. */
export const ACCESS_POLICY_VERSION = 1;

/** The stages a network grant can name, in the order the parser writes them. */
export const ACCESS_STAGES: readonly AccessStage[] = ["build", "verify", "replay", "publish"];

// ajv is CommonJS: its default export is the class at run time, but its types name it.
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const schema = JSON.parse(
  readFileSync(new URL("../../schema/access-policy.schema.json", import.meta.url), "utf8"),
) as object;
const validateShape = new Ajv2020({ strict: true, allErrors: true, verbose: true }).compile(schema);

/** The least-privilege policy: public read only; write, execute, network, and publish denied. */
export function defaultAccessPolicy(task = "site"): AccessPolicy {
  return {
    version: ACCESS_POLICY_VERSION,
    task,
    capabilities: { read: true, write: false, execute: false, network: false, publish: false },
    read: { public: true, audiences: [] },
    write: { paths: [], scope: { pages: [], blocks: [], collections: [], files: [] } },
    check: { runners: [] },
    network: { destinations: [], stages: [] },
    approvals: { read: false, write: true, execute: true, network: true, publish: true },
  };
}

/** What validation leaves optional. */
interface RawCapabilities {
  readonly read?: boolean;
  readonly write?: boolean;
  readonly execute?: boolean;
  readonly network?: boolean;
  readonly publish?: boolean;
}

interface RawRead {
  readonly public?: boolean;
  readonly audiences?: readonly string[];
  readonly pages?: readonly string[];
  readonly blocks?: readonly string[];
  readonly collections?: readonly string[];
  readonly fields?: Readonly<Record<string, readonly string[]>>;
}

interface RawWriteScope {
  readonly pages?: readonly string[];
  readonly blocks?: readonly string[];
  readonly collections?: readonly string[];
  readonly files?: readonly string[];
}

interface RawWrite {
  readonly paths: readonly string[];
  readonly scope: RawWriteScope;
}

interface RawRunner {
  readonly name: string;
  readonly inputs: readonly string[];
  readonly resources: readonly string[];
}

interface RawCheck {
  readonly runners: readonly RawRunner[];
}

interface RawNetwork {
  readonly destinations: readonly string[];
  readonly stages: readonly AccessStage[];
}

interface RawPolicy {
  readonly version: 1;
  readonly task?: string;
  readonly capabilities?: RawCapabilities;
  readonly read?: RawRead;
  readonly write?: RawWrite;
  readonly check?: RawCheck;
  readonly network?: RawNetwork;
  readonly approvals?: Partial<AccessApprovalPolicy>;
}

/** Parses an already-decoded policy value such as `JSON.parse(text)`. */
export function parseAccessPolicy(value: unknown): AccessPolicyParseResult {
  if (!validateShape(value)) {
    return { problems: problemsFromAjv(validateShape.errors ?? []) };
  }
  return normalize(value as RawPolicy);
}

/** Parses policy text, prefixing every problem with the file it came from. */
export function parseAccessPolicyText(text: string, file: string): AccessPolicyParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      problems: [
        {
          path: "",
          code: "access-policy.json",
          message: `${file}: the policy is not JSON: ${error instanceof Error ? error.message : String(error)}.`,
        },
      ],
    };
  }
  const parsed = parseAccessPolicy(value);
  return {
    ...(parsed.policy === undefined ? {} : { policy: parsed.policy }),
    problems: parsed.problems.map((problem) => ({
      ...problem,
      message: `${file}: ${problem.message}`,
    })),
  };
}

/** Fills the defaults, trims every string, and checks the rules one field cannot express. */
function normalize(raw: RawPolicy): AccessPolicyParseResult {
  const problems: AccessPolicyProblem[] = [];
  const task = textOf(raw.task) || "site";
  const capabilities = {
    read: raw.capabilities?.read ?? true,
    write: raw.capabilities?.write ?? false,
    execute: raw.capabilities?.execute ?? false,
    network: raw.capabilities?.network ?? false,
    publish: raw.capabilities?.publish ?? false,
  };
  const read = readOf(raw.read, problems);
  const write = writeOf(raw.write, problems);
  const check = checkOf(raw.check, problems);
  const network = networkOf(raw.network, problems);
  const approvals: AccessApprovalPolicy = {
    read: raw.approvals?.read ?? false,
    write: raw.approvals?.write ?? true,
    execute: raw.approvals?.execute ?? true,
    network: raw.approvals?.network ?? true,
    publish: raw.approvals?.publish ?? true,
  };

  if (capabilities.write && (write.paths.length === 0 || scopeSize(write.scope) === 0)) {
    problems.push({
      path: "/capabilities/write",
      code: "access-policy.write-unscoped",
      message:
        "A granted write needs `write.paths` and at least one `write.scope` entry; both the path and the scope must allow a write.",
    });
  }
  if (capabilities.execute && check.runners.length === 0) {
    problems.push({
      path: "/capabilities/execute",
      code: "access-policy.execute-unscoped",
      message: "A granted execute needs at least one named runner in `check.runners`; a check never runs an arbitrary command.",
    });
  }
  if (capabilities.network && (network.destinations.length === 0 || network.stages.length === 0)) {
    problems.push({
      path: "/capabilities/network",
      code: "access-policy.network-unscoped",
      message: "A granted network needs both a `network.destinations` entry and a `network.stages` entry.",
    });
  }
  if (read.collections !== undefined) {
    for (const name of Object.keys(read.fields ?? {})) {
      if (!read.collections.some((entry) => anyReferenceMatches([entry], name))) {
        problems.push({
          path: `/read/fields/${name}`,
          code: "access-policy.field-collection",
          message: `The field allowlist for "${name}" names a collection that \`read.collections\` does not allow.`,
        });
      }
    }
  } else if (read.fields !== undefined && Object.keys(read.fields).length > 0) {
    problems.push({
      path: "/read/fields",
      code: "access-policy.field-collection",
      message: "A `read.fields` allowlist needs `read.collections`; without it the policy reads no collection data.",
    });
  }

  if (problems.length > 0) return { problems };
  return {
    policy: {
      version: ACCESS_POLICY_VERSION,
      task,
      capabilities,
      read,
      write,
      check,
      network,
      approvals,
    },
    problems: [],
  };
}

/** The read policy with trimmed lists and sorted field keys. */
function readOf(raw: RawRead | undefined, problems: AccessPolicyProblem[]): AccessReadPolicy {
  const pages = unique(raw?.pages, "/read/pages", problems);
  const blocks = unique(raw?.blocks, "/read/blocks", problems);
  const collections = unique(raw?.collections, "/read/collections", problems);
  const fields: Record<string, readonly string[]> = {};
  for (const name of Object.keys(raw?.fields ?? {}).sort(byCodePoint)) {
    fields[name] = unique(raw?.fields?.[name] ?? [], `/read/fields/${name}`, problems) ?? [];
  }
  return {
    public: raw?.public ?? true,
    audiences: unique(raw?.audiences ?? [], "/read/audiences", problems) ?? [],
    ...(pages === undefined ? {} : { pages }),
    ...(blocks === undefined ? {} : { blocks }),
    ...(collections === undefined ? {} : { collections }),
    ...(Object.keys(fields).length === 0 ? {} : { fields }),
  };
}

/** The write policy with trimmed lists. */
function writeOf(raw: RawWrite | undefined, problems: AccessPolicyProblem[]): AccessWritePolicy {
  return {
    paths: unique(raw?.paths, "/write/paths", problems) ?? [],
    scope: {
      pages: unique(raw?.scope.pages, "/write/scope/pages", problems) ?? [],
      blocks: unique(raw?.scope.blocks, "/write/scope/blocks", problems) ?? [],
      collections: unique(raw?.scope.collections, "/write/scope/collections", problems) ?? [],
      files: unique(raw?.scope.files, "/write/scope/files", problems) ?? [],
    },
  };
}

/** The check policy, with each runner's names trimmed. */
function checkOf(raw: RawCheck | undefined, problems: AccessPolicyProblem[]): AccessCheckPolicy {
  const runners: AccessRunnerGrant[] = [];
  const seen = new Set<string>();
  (raw?.runners ?? []).forEach((runner, index) => {
    const name = textOf(runner.name);
    if (seen.has(name)) {
      problems.push({
        path: `/check/runners/${index}/name`,
        code: "access-policy.duplicate",
        message: `Runner "${name}" is granted twice; one grant per runner.`,
      });
    }
    seen.add(name);
    runners.push({
      name,
      inputs: unique(runner.inputs, `/check/runners/${index}/inputs`, problems) ?? [],
      resources: unique(runner.resources, `/check/runners/${index}/resources`, problems) ?? [],
    });
  });
  return { runners };
}

/** The network policy: destinations reduced to an origin, and stages in a stable order. */
function networkOf(raw: RawNetwork | undefined, problems: AccessPolicyProblem[]): AccessPolicy["network"] {
  const seen = new Set<string>();
  const destinations: string[] = [];
  (raw?.destinations ?? []).forEach((value, index) => {
    const destination = destinationOf(value);
    if (seen.has(destination.toLowerCase())) {
      problems.push({
        path: `/network/destinations/${index}`,
        code: "access-policy.duplicate",
        message: `Destination "${destination}" is listed twice; one entry per destination.`,
      });
    }
    seen.add(destination.toLowerCase());
    destinations.push(destination);
  });
  const stages = [...new Set(raw?.stages ?? [])].sort(
    (a, b) => ACCESS_STAGES.indexOf(a) - ACCESS_STAGES.indexOf(b),
  );
  return { destinations, stages };
}

/** Trims a list, refuses a value that repeats after trimming, and preserves the first spelling. */
function unique(
  values: readonly string[] | undefined,
  prefix: string,
  problems: AccessPolicyProblem[],
): readonly string[] | undefined {
  if (values === undefined) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  values.forEach((value, index) => {
    const text = textOf(value);
    if (seen.has(text)) {
      problems.push({
        path: `${prefix}/${index}`,
        code: "access-policy.duplicate",
        message: `${whereOf(`${prefix}/${index}`)} repeats \`${text}\`; remove the duplicate.`,
      });
      return;
    }
    seen.add(text);
    out.push(text);
  });
  return out;
}

/** A trimmed string, or empty. */
function textOf(value: string | undefined): string {
  return (value ?? "").trim();
}

/** A JSON Pointer as a person reads it. */
function whereOf(path: string): string {
  return path === "" ? "the document" : `\`${path}\``;
}

/** How many references a scope holds. */
export function scopeSize(scope: AccessWriteScope): number {
  return scope.pages.length + scope.blocks.length + scope.collections.length + scope.files.length;
}

/** Every problem ajv reported, as a located sentence. */
function problemsFromAjv(errors: readonly ErrorObject[]): readonly AccessPolicyProblem[] {
  return errors.map((error) => {
    const path = error.instancePath === "" ? `/${String(error.params.missingProperty ?? "")}` : error.instancePath;
    const where = whereOf(error.instancePath);
    const extra =
      error.keyword === "additionalProperties"
        ? ` Remove \`${String(error.params.additionalProperty)}\`.`
        : error.keyword === "required"
          ? ` Add \`${String(error.params.missingProperty)}\`.`
          : "";
    return {
      path,
      code: `access-policy.${error.keyword}`,
      message: `${where} ${error.message ?? "is invalid"}.${extra}`,
    };
  });
}

/** A stable, order-independent fingerprint of a normalized policy, used to expire approvals. */
export function accessPolicyFingerprint(policy: AccessPolicy): string {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

/** True when every reference a child policy adds is already allowed by the parent. */
export function readPolicyWithin(parent: AccessReadPolicy, child: AccessReadPolicy): boolean {
  if (child.public && !parent.public) return false;
  if (!referencesWithin(parent.audiences, child.audiences)) return false;
  for (const key of ["pages", "blocks", "collections"] as const) {
    const parentList = parent[key];
    const childList = child[key];
    if (parentList === undefined || childList === undefined) continue;
    if (!referencesWithin(parentList, childList)) return false;
  }
  for (const [name, fields] of Object.entries(child.fields ?? {})) {
    const allowed = parent.fields?.[name];
    if (allowed === undefined) {
      if (parent.collections === undefined) continue;
      return false;
    }
    if (!referencesWithin(allowed, fields)) return false;
  }
  return true;
}
