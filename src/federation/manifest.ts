/**
 * The federation manifest: a versioned list of projects, each with a namespace, a snapshot role, and where it publishes
 * its bundle. Parsing validates every field and reports each problem at its JSON Pointer, so a bad manifest is refused
 * whole with every reason rather than a partial prefix. A duplicate project id, namespace, or source is refused,
 * because a federation whose identities collide cannot keep two projects' same-named nodes apart.
 */
import type {
  FederationManifest,
  FederationProject,
  FederationRole,
  FederationSource,
  FederationVersionRequirement,
} from "../contracts/federation.ts";
import { isVersionRange } from "./contract.ts";

/** The manifest's file name at a site root. */
export const FEDERATION_MANIFEST_FILE = "federation.json";

/** One located problem, with a JSON Pointer into the manifest. */
export interface FederationProblem {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

/** A parsed manifest, or every reason it was refused. */
export interface FederationManifestResult {
  readonly manifest?: FederationManifest;
  readonly problems: readonly FederationProblem[];
}

/** One role the manifest may name. */
export const FEDERATION_ROLES: readonly FederationRole[] = ["product", "docs", "consumer"];

/** A project id or namespace: lowercase words joined by dashes, so it never contains the `/` of a qualified id. */
const NAME = /^[a-z][a-z0-9-]*$/;

/** True for a plain JSON object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for a non-empty string after trimming. */
function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** A relative path that stays inside the manifest's folder: no absolute path, no drive letter, no `..` segment. */
function isRelativePath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return false;
  return !normalized.split("/").some((segment) => segment === "..");
}

/** True for an `https:` URL without credentials. */
function isSecureUrl(value: string): boolean {
  const url = URL.parse(value);
  return url !== null && url.protocol === "https:" && url.username === "" && url.password === "";
}

/** The source a project publishes at, or the reason it is not one. */
function sourceOf(value: unknown, path: string, problems: FederationProblem[]): FederationSource | undefined {
  if (!isObject(value)) {
    problems.push({ path, code: "federation.manifest-invalid", message: "A project source must be an object with `url` or `path`." });
    return undefined;
  }
  const hasUrl = value.url !== undefined;
  const hasPath = value.path !== undefined;
  if (hasUrl === hasPath) {
    problems.push({ path, code: "federation.manifest-invalid", message: "A project source names exactly one of `url` or `path`." });
    return undefined;
  }
  if (hasUrl) {
    if (!isText(value.url) || !isSecureUrl(value.url)) {
      problems.push({ path: `${path}/url`, code: "federation.manifest-invalid", message: "A source URL must be an HTTPS address without credentials." });
      return undefined;
    }
    return { url: value.url };
  }
  if (!isText(value.path) || !isRelativePath(value.path)) {
    problems.push({ path: `${path}/path`, code: "federation.manifest-invalid", message: "A source path must be relative to the manifest and stay inside its folder." });
    return undefined;
  }
  return { path: value.path.replace(/\\/g, "/") };
}

/** The version requirement a project declares, or the reason it is not one. */
function requirementOf(value: unknown, path: string, problems: FederationProblem[]): FederationVersionRequirement | undefined {
  if (!isObject(value)) {
    problems.push({ path, code: "federation.manifest-invalid", message: "A version requirement must be an object." });
    return undefined;
  }
  let invalid = false;
  if (value.range !== undefined && (!isText(value.range) || !isVersionRange(value.range))) {
    problems.push({ path: `${path}/range`, code: "federation.manifest-invalid", message: "A version range must look like `>=1.2.0 <2.0.0`." });
    invalid = true;
  }
  if (value.channel !== undefined && value.channel !== "pinned" && value.channel !== "compatible") {
    problems.push({ path: `${path}/channel`, code: "federation.manifest-invalid", message: "A channel must be `pinned` or `compatible`." });
    invalid = true;
  }
  if (invalid) return undefined;
  return {
    ...(value.range === undefined ? {} : { range: value.range as string }),
    ...(value.channel === undefined ? {} : { channel: value.channel as "pinned" | "compatible" }),
  };
}

/** One project, or the reasons it is not one. */
function parseProject(value: unknown, path: string, problems: FederationProblem[]): FederationProject | undefined {
  if (!isObject(value)) {
    problems.push({ path, code: "federation.manifest-invalid", message: "A project must be an object." });
    return undefined;
  }
  const before = problems.length;
  if (!isText(value.id) || !NAME.test(value.id)) {
    problems.push({ path: `${path}/id`, code: "federation.manifest-invalid", message: "A project id must be lowercase words joined by dashes." });
  }
  if (!isText(value.namespace) || !NAME.test(value.namespace)) {
    problems.push({ path: `${path}/namespace`, code: "federation.manifest-invalid", message: "A namespace must be lowercase words joined by dashes." });
  }
  if (!FEDERATION_ROLES.includes(value.role as FederationRole)) {
    problems.push({ path: `${path}/role`, code: "federation.manifest-invalid", message: `A role must be one of ${FEDERATION_ROLES.join(", ")}.` });
  }
  const source = sourceOf(value.source, `${path}/source`, problems);
  const requirement = value.version === undefined ? undefined : requirementOf(value.version, `${path}/version`, problems);
  if (value.optional !== undefined && typeof value.optional !== "boolean") {
    problems.push({ path: `${path}/optional`, code: "federation.manifest-invalid", message: "`optional` must be true or false." });
  }
  if (problems.length > before || source === undefined) return undefined;
  return {
    id: value.id as string,
    namespace: value.namespace as string,
    role: value.role as FederationRole,
    source,
    ...(requirement === undefined ? {} : { version: requirement }),
    ...(value.optional === undefined ? {} : { optional: value.optional as boolean }),
  };
}

/** The source as one comparable string, so two projects publishing to the same place are refused. */
export function sourceText(source: FederationSource): string {
  return source.url === undefined ? `path:${source.path}` : `url:${source.url}`;
}

/**
 * Parses and validates a manifest. The result names every problem; a manifest with any problem returns none, so a
 * caller never acts on a partial federation.
 */
export function parseFederationManifest(value: unknown): FederationManifestResult {
  const problems: FederationProblem[] = [];
  if (!isObject(value)) {
    return { problems: [{ path: "", code: "federation.manifest-invalid", message: "The manifest must be a JSON object." }] };
  }
  if (value.version !== 1) {
    problems.push({ path: "/version", code: "federation.manifest-version", message: "The manifest version must be 1." });
  }
  if (!Array.isArray(value.projects) || value.projects.length === 0) {
    problems.push({ path: "/projects", code: "federation.manifest-invalid", message: "The manifest must list at least one project." });
    return { problems };
  }

  const projects: FederationProject[] = [];
  value.projects.forEach((entry, index) => {
    const project = parseProject(entry, `/projects/${index}`, problems);
    if (project !== undefined) projects.push(project);
  });

  const ids = new Map<string, string>();
  const namespaces = new Map<string, string>();
  const sources = new Map<string, string>();
  projects.forEach((project, index) => {
    const path = `/projects/${index}`;
    const seenId = ids.get(project.id);
    if (seenId !== undefined) {
      problems.push({ path: `${path}/id`, code: "federation.duplicate-id", message: `The project id "${project.id}" is already used by ${seenId}.` });
    } else {
      ids.set(project.id, path);
    }
    const seenNamespace = namespaces.get(project.namespace);
    if (seenNamespace !== undefined) {
      problems.push({ path: `${path}/namespace`, code: "federation.duplicate-namespace", message: `The namespace "${project.namespace}" is already used by ${seenNamespace}.` });
    } else {
      namespaces.set(project.namespace, path);
    }
    const source = sourceText(project.source);
    const seenSource = sources.get(source);
    if (seenSource !== undefined) {
      problems.push({ path: `${path}/source`, code: "federation.duplicate-source", message: `The source "${source}" is already used by ${seenSource}.` });
    } else {
      sources.set(source, path);
    }
  });

  if (problems.length > 0) return { problems };
  return { manifest: { version: 1, projects }, problems: [] };
}

/** The project a manifest names, or `undefined`. */
export function projectOf(manifest: FederationManifest, id: string): FederationProject | undefined {
  return manifest.projects.find((project) => project.id === id);
}
