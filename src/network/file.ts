/**
 * The shared network file, `network.json`: its types, and a parser that checks it against
 * `schema/network.schema.json` and the rules a schema cannot state (unique ids, unique single-segment paths).
 * Every problem carries its line, so the check command and `network update` can point at it.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import { isMap, isScalar, LineCounter, parseDocument, type Node } from "yaml";
import type { AnalyticsConfig } from "../contracts/config.ts";

/** One project of the network file. */
export interface NetworkFileProject {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly public: boolean;
  readonly analytics?: AnalyticsConfig;
  readonly manifest?: string;
  readonly search?: string;
}

/** The network file. */
export interface NetworkFile {
  readonly version: 1;
  readonly projects: readonly NetworkFileProject[];
}

/** One problem in the network file. */
export interface NetworkProblem {
  /** Stable id, such as `network.duplicate-id`. */
  readonly id: string;
  readonly message: string;
  /** 1-based line in the file. */
  readonly line: number;
  readonly column: number;
}

/** The default page list path below a project. */
export const DEFAULT_MANIFEST = ".mizzen/manifest.json";

/** The default search index folder below a project. */
export const DEFAULT_SEARCH = "pagefind";

const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const schema = JSON.parse(readFileSync(new URL("../../schema/network.schema.json", import.meta.url), "utf8")) as object;
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

/** `path` as a project path is compared: trimmed of slashes and lower-cased. */
function normalPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "").toLowerCase();
}

/** True when `path` is one plain URL segment. */
export function isSingleSegment(path: string): boolean {
  return path !== "" && path !== "." && path !== ".." && !/[/\\?#\s]/.test(path);
}

/**
 * Parses and checks network file text. `file` is only used by callers for messages. A file with problems still
 * returns what could be read in `network` when its shape is valid, so a caller may decide to go on.
 */
export function parseNetwork(text: string): { readonly network?: NetworkFile; readonly problems: readonly NetworkProblem[] } {
  const source = text.startsWith("﻿") ? text.slice(1) : text;
  const lines = new LineCounter();
  const doc = parseDocument(source, { lineCounter: lines });
  const problems: NetworkProblem[] = [];
  const at = (node: unknown): { line: number; column: number } => {
    const range = (node as Node | null | undefined)?.range;
    if (!range) return { line: 1, column: 1 };
    const pos = lines.linePos(range[0]);
    return { line: pos.line, column: pos.col };
  };
  const report = (id: string, message: string, node: unknown): void => {
    problems.push({ id, message, ...at(node) });
  };

  if (doc.errors.length > 0) {
    for (const error of doc.errors) {
      const pos = error.linePos?.[0];
      problems.push({
        id: "network.invalid-json",
        message: `The network file is not valid JSON: ${error.message.split("\n")[0]}`,
        line: pos?.line ?? 1,
        column: pos?.col ?? 1,
      });
    }
    return { problems };
  }

  const value: unknown = doc.toJS();
  const nodeAt = (path: readonly (string | number)[]): unknown => (path.length === 0 ? doc.contents : doc.getIn(path, true));

  if (!validate(value)) {
    for (const error of validate.errors ?? []) {
      const path = error.instancePath
        .split("/")
        .filter((part) => part !== "")
        .map((part) => (/^\d+$/.test(part) ? Number(part) : part.replace(/~1/g, "/").replace(/~0/g, "~")));
      if (error.keyword === "required") {
        const missing = String(error.params["missingProperty"]);
        const entry = path[0] === "projects" && typeof path[1] === "number" ? (value as { projects?: { id?: unknown }[] }).projects?.[path[1]] : undefined;
        const who = entry !== undefined && typeof entry.id === "string" ? `project "${entry.id}"` : path.length === 0 ? "the network file" : `project ${String(path[1])}`;
        report(missing === "title" ? "network.missing-title" : "network.missing-key", `${who} has no \`${missing}\`.`, nodeAt(path));
      } else if (error.keyword === "additionalProperties") {
        const key = String(error.params["additionalProperty"]);
        const pair = nodeAt(path);
        const found = isMap(pair) ? pair.items.find((item) => isScalar(item.key) && item.key.value === key) : undefined;
        report("network.unknown-key", `Unknown key \`${key}\`.`, found?.key ?? pair);
      } else {
        const where = path.length === 0 ? "the network file" : `\`${path.join(".")}\``;
        report("network.invalid", `${where} ${error.message ?? "is invalid"}.`, nodeAt(path));
      }
    }
    return { problems };
  }

  const network = value as NetworkFile;
  const ids = new Map<string, number>();
  const paths = new Map<string, number>();
  network.projects.forEach((project, index) => {
    const base = ["projects", index] as const;
    const idNode = nodeAt([...base, "id"]);
    const pathNode = nodeAt([...base, "path"]);
    const firstId = ids.get(project.id);
    if (firstId !== undefined) {
      report("network.duplicate-id", `The id "${project.id}" is used by projects ${firstId + 1} and ${index + 1}; ids must be unique.`, idNode);
    } else ids.set(project.id, index);

    if (!isSingleSegment(project.path.replace(/^\/+|\/+$/g, ""))) {
      report(
        "network.path-not-segment",
        `The path "${project.path}" of project "${project.id}" must be one URL segment such as "${project.id}", not a nested path.`,
        pathNode,
      );
    } else if (project.path !== project.path.replace(/^\/+|\/+$/g, "")) {
      report("network.path-slashes", `The path "${project.path}" of project "${project.id}" must have no slash around it.`, pathNode);
    }
    const key = normalPath(project.path);
    const firstPath = paths.get(key);
    if (firstPath !== undefined) {
      report(
        "network.duplicate-path",
        `The path "${project.path}" of project "${project.id}" overlaps the path of project ${firstPath + 1}; each project needs its own path.`,
        pathNode,
      );
    } else paths.set(key, index);
  });

  return { network, problems };
}
