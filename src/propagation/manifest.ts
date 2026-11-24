/**
 * The consumer manifest: a versioned list of consumers, the upstream project each depends on, the public dependencies
 * it declares, its version policy, its evidence policy, and who must approve a change. Parsing validates every field
 * and reports each problem at its JSON Pointer, so a manifest with one invalid dependency is refused whole rather than
 * partially applied. A dependency whose id cannot name anything the upstream snapshot can publish is refused.
 */
import type {
  ConsumedDependency,
  ConsumerApproval,
  ConsumerDeclaration,
  ConsumerEvidencePolicy,
  ConsumerVersionPolicy,
  DependencyKind,
  PropagationAction,
  PropagationManifest,
  PropagationManifestResult,
  PropagationProblem,
} from "../contracts/propagation.ts";
import { isVersionRange } from "../federation/contract.ts";

/** The manifest file name at a site root. */
export const PROPAGATION_MANIFEST_FILE = "propagation.json";

/** Every dependency kind a consumer may declare. */
export const DEPENDENCY_KINDS: readonly DependencyKind[] = [
  "surface",
  "behavior",
  "collection",
  "page",
  "symbol",
  "decision",
  "evidence",
];

/** Every action a version policy may ask for. */
export const PROPAGATION_ACTIONS: readonly PropagationAction[] = ["none", "acknowledge", "task", "pull-request", "review"];

/** A consumer id or namespace: lowercase words joined by dashes, so it never contains the `/` of a qualified id. */
const NAME = /^[a-z][a-z0-9-]*$/;

/** True for a plain JSON object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for a non-empty string after trimming. */
function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** A relative path that stays inside the consumer's tree: no absolute path, no drive letter, no `..` segment. */
function isRelativePath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return false;
  return !normalized.split("/").some((segment) => segment === "..");
}

/** A list of strings, or the reason it is not one. */
function stringList(value: unknown, path: string, problems: PropagationProblem[]): readonly string[] | undefined {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim() !== "")) {
    problems.push({ path, code: "propagation.invalid-manifest", message: "Expected a list of non-empty strings." });
    return undefined;
  }
  return value as readonly string[];
}

/** One action, or the reason it is not one. */
function actionOf(value: unknown, path: string, problems: PropagationProblem[]): PropagationAction | undefined {
  if (!PROPAGATION_ACTIONS.includes(value as PropagationAction)) {
    problems.push({
      path,
      code: "propagation.invalid-policy",
      message: `An action must be one of ${PROPAGATION_ACTIONS.join(", ")}.`,
    });
    return undefined;
  }
  return value as PropagationAction;
}

/** The version policy, or the reason it is not one. */
function policyOf(value: unknown, path: string, problems: PropagationProblem[]): ConsumerVersionPolicy | undefined {
  if (!isObject(value)) {
    problems.push({ path, code: "propagation.invalid-policy", message: "A version policy must be an object." });
    return undefined;
  }
  const before = problems.length;
  if (value.range !== undefined && (!isText(value.range) || !isVersionRange(value.range))) {
    problems.push({ path: `${path}/range`, code: "propagation.invalid-policy", message: "A version range must look like `>=1.2.0 <2.0.0`." });
  }
  if (value.channel !== undefined && value.channel !== "pinned" && value.channel !== "compatible") {
    problems.push({ path: `${path}/channel`, code: "propagation.invalid-policy", message: "A channel must be `pinned` or `compatible`." });
  }
  if (value.channel === "compatible" && value.range === undefined) {
    problems.push({ path: `${path}/range`, code: "propagation.invalid-policy", message: "A compatible channel needs a version range." });
  }
  const onCompatible = value.onCompatible === undefined ? undefined : actionOf(value.onCompatible, `${path}/onCompatible`, problems);
  const onBreaking = value.onBreaking === undefined ? undefined : actionOf(value.onBreaking, `${path}/onBreaking`, problems);
  const onReview = value.onReview === undefined ? undefined : actionOf(value.onReview, `${path}/onReview`, problems);
  if (problems.length > before) return undefined;
  return {
    ...(value.range === undefined ? {} : { range: value.range as string }),
    ...(value.channel === undefined ? {} : { channel: value.channel as "pinned" | "compatible" }),
    ...(onCompatible === undefined ? {} : { onCompatible }),
    ...(onBreaking === undefined ? {} : { onBreaking }),
    ...(onReview === undefined ? {} : { onReview }),
  };
}

/** The approval policy, or the reason it is not one. */
function approvalOf(value: unknown, path: string, problems: PropagationProblem[]): ConsumerApproval | undefined {
  if (!isObject(value)) {
    problems.push({ path, code: "propagation.invalid-approval", message: "An approval policy must be an object." });
    return undefined;
  }
  if (value.mode !== "automatic" && value.mode !== "required") {
    problems.push({ path: `${path}/mode`, code: "propagation.invalid-approval", message: "An approval mode must be `automatic` or `required`." });
  }
  const approvers = stringList(value.approvers, `${path}/approvers`, problems);
  if (approvers === undefined || (value.mode !== "automatic" && value.mode !== "required")) return undefined;
  return { mode: value.mode, approvers };
}

/** The evidence policy, or the reason it is not one. */
function evidencePolicyOf(value: unknown, path: string, problems: PropagationProblem[]): ConsumerEvidencePolicy | undefined {
  if (value === undefined) return { allow: ["*"], deny: [] };
  if (!isObject(value)) {
    problems.push({ path, code: "propagation.invalid-evidence", message: "An evidence policy must be an object." });
    return undefined;
  }
  const allow = value.allow === undefined ? ["*"] : stringList(value.allow, `${path}/allow`, problems);
  const deny = value.deny === undefined ? [] : stringList(value.deny, `${path}/deny`, problems);
  if (allow === undefined || deny === undefined) return undefined;
  return { allow, deny };
}

/** One dependency, or the reasons it is not one. */
function dependencyOf(value: unknown, path: string, problems: PropagationProblem[]): ConsumedDependency | undefined {
  if (!isObject(value)) {
    problems.push({ path, code: "propagation.invalid-dependency", message: "A dependency must be an object." });
    return undefined;
  }
  const before = problems.length;
  if (!DEPENDENCY_KINDS.includes(value.kind as DependencyKind)) {
    problems.push({
      path: `${path}/kind`,
      code: "propagation.invalid-dependency",
      message: `A dependency kind must be one of ${DEPENDENCY_KINDS.join(", ")}.`,
    });
  }
  if (!isText(value.id)) {
    problems.push({ path: `${path}/id`, code: "propagation.invalid-dependency", message: "A dependency needs a non-empty id." });
  } else if (value.kind === "page" && !isRelativePath(value.id)) {
    problems.push({ path: `${path}/id`, code: "propagation.invalid-dependency", message: "A page dependency must name a relative page path inside the consumer." });
  } else if (value.kind === "page" && !/\.(md|mdx)$/.test(value.id)) {
    problems.push({ path: `${path}/id`, code: "propagation.invalid-dependency", message: "A page dependency must name a Markdown page, such as `guide/install.md`." });
  }
  const pages = value.pages === undefined ? undefined : stringList(value.pages, `${path}/pages`, problems);
  const files = value.files === undefined ? undefined : stringList(value.files, `${path}/files`, problems);
  for (const [index, entry] of (pages ?? []).entries()) {
    if (!isRelativePath(entry)) {
      problems.push({ path: `${path}/pages/${index}`, code: "propagation.invalid-dependency", message: "A page must stay inside the consumer's tree." });
    }
  }
  for (const [index, entry] of (files ?? []).entries()) {
    if (!isRelativePath(entry)) {
      problems.push({ path: `${path}/files/${index}`, code: "propagation.invalid-dependency", message: "A file must stay inside the consumer's tree." });
    }
  }
  if (problems.length > before) return undefined;
  return {
    kind: value.kind as DependencyKind,
    id: (value.id as string).trim(),
    ...(pages === undefined ? {} : { pages }),
    ...(files === undefined ? {} : { files }),
  };
}

/** One consumer, or the reasons it is not one. */
function consumerEntryOf(value: unknown, path: string, problems: PropagationProblem[]): ConsumerDeclaration | undefined {
  if (!isObject(value)) {
    problems.push({ path, code: "propagation.invalid-consumer", message: "A consumer must be an object." });
    return undefined;
  }
  const before = problems.length;
  if (!isText(value.id) || !NAME.test(value.id)) {
    problems.push({ path: `${path}/id`, code: "propagation.invalid-consumer", message: "A consumer id must be lowercase words joined by dashes." });
  }
  if (!isText(value.project)) {
    problems.push({ path: `${path}/project`, code: "propagation.invalid-consumer", message: "A consumer must name the upstream project it depends on." });
  }
  if (value.namespace !== undefined && (!isText(value.namespace) || !NAME.test(value.namespace))) {
    problems.push({ path: `${path}/namespace`, code: "propagation.invalid-consumer", message: "A namespace must be lowercase words joined by dashes." });
  }
  const policy = policyOf(value.policy, `${path}/policy`, problems);
  const approval = approvalOf(value.approval, `${path}/approval`, problems);
  const evidence = evidencePolicyOf(value.evidence, `${path}/evidence`, problems);
  if (!Array.isArray(value.consumes) || value.consumes.length === 0) {
    problems.push({ path: `${path}/consumes`, code: "propagation.invalid-consumer", message: "A consumer must declare at least one dependency." });
    return undefined;
  }
  const consumes: ConsumedDependency[] = [];
  value.consumes.forEach((entry, index) => {
    const dependency = dependencyOf(entry, `${path}/consumes/${index}`, problems);
    if (dependency !== undefined) consumes.push(dependency);
  });
  const seen = new Map<string, number>();
  consumes.forEach((dependency, index) => {
    const key = `${dependency.kind}:${dependency.id}`;
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      problems.push({
        path: `${path}/consumes/${index}`,
        code: "propagation.duplicate-dependency",
        message: `The dependency \`${key}\` is already declared at /consumers/${index === earlier ? index : earlier}.`,
      });
    } else {
      seen.set(key, index);
    }
  });
  if (problems.length > before || policy === undefined || approval === undefined || evidence === undefined) return undefined;
  return {
    id: value.id as string,
    project: value.project as string,
    ...(value.namespace === undefined ? {} : { namespace: value.namespace as string }),
    policy,
    approval,
    evidence,
    consumes,
  };
}

/**
 * Parses and validates a manifest. Every problem is reported; a manifest with any problem returns none, so a caller
 * never acts on a partial list of consumers.
 */
export function parsePropagationManifest(value: unknown): PropagationManifestResult {
  const problems: PropagationProblem[] = [];
  if (!isObject(value)) {
    return { problems: [{ path: "", code: "propagation.invalid-manifest", message: "The manifest must be a JSON object." }] };
  }
  if (value.version !== 1) {
    problems.push({ path: "/version", code: "propagation.invalid-manifest", message: "The manifest version must be 1." });
  }
  if (!Array.isArray(value.consumers) || value.consumers.length === 0) {
    problems.push({ path: "/consumers", code: "propagation.invalid-manifest", message: "The manifest must list at least one consumer." });
    return { problems };
  }

  const consumers: ConsumerDeclaration[] = [];
  value.consumers.forEach((entry, index) => {
    const consumer = consumerEntryOf(entry, `/consumers/${index}`, problems);
    if (consumer !== undefined) consumers.push(consumer);
  });

  const ids = new Map<string, string>();
  consumers.forEach((consumer, index) => {
    const path = `/consumers/${index}`;
    const seen = ids.get(consumer.id);
    if (seen !== undefined) {
      problems.push({ path: `${path}/id`, code: "propagation.duplicate-consumer", message: `The consumer id "${consumer.id}" is already used by ${seen}.` });
    } else {
      ids.set(consumer.id, path);
    }
  });

  if (problems.length > 0) return { problems };
  return { manifest: { version: 1, consumers }, problems: [] };
}

/** The consumer a manifest names, or `undefined`. */
export function consumerOf(manifest: PropagationManifest, id: string): ConsumerDeclaration | undefined {
  return manifest.consumers.find((consumer) => consumer.id === id);
}
