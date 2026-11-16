/**
 * Compares two builds of the data API and reports what a consumer of the older one would lose.
 *
 * Within a version a field may be added, never removed or retyped (`docs/design/data-api.md`). The comparison reads
 * only the published files, so it holds for a built folder, a git ref built into one, or a deployed copy: for each
 * version of the baseline it needs that version's `index.json` and the published schemas the index links.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** One breaking change: the file a consumer reads, the field when one is concerned, and how to repair it. */
export interface ApiBreak {
  readonly file: string;
  readonly field?: string;
  readonly message: string;
  readonly fix: string;
}

interface IndexFile {
  readonly status: string;
  readonly collections: readonly { readonly name: string; readonly fields: readonly string[]; readonly json: string }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(dir: string, path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(dir, path), "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** The version folders under `<dir>/api`, sorted. */
async function versionsOf(dir: string): Promise<string[]> {
  try {
    const names: string[] = [];
    for (const entry of await readdir(join(dir, "api"), { withFileTypes: true })) {
      if (entry.isDirectory() && /^v[1-9][0-9]*$/.test(entry.name)) names.push(entry.name);
    }
    return names.sort();
  } catch {
    return [];
  }
}

function indexOf(value: unknown): IndexFile | undefined {
  if (!isRecord(value) || !Array.isArray(value.collections)) return undefined;
  const collections: IndexFile["collections"][number][] = [];
  for (const entry of value.collections) {
    if (!isRecord(entry) || typeof entry.name !== "string" || !Array.isArray(entry.fields)) return undefined;
    collections.push({
      name: entry.name,
      fields: entry.fields.filter((f): f is string => typeof f === "string"),
      json: typeof entry.json === "string" ? entry.json : "",
    });
  }
  return { status: typeof value.status === "string" ? value.status : "current", collections };
}

/** The type of each property of a published schema, as a canonical string, or `undefined` when it names none. */
function typesOf(schema: unknown): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  if (!isRecord(schema) || !isRecord(schema.properties)) return out;
  for (const [name, property] of Object.entries(schema.properties)) {
    const type = isRecord(property) ? property.type : undefined;
    out.set(name, typeof type === "string" ? type : Array.isArray(type) ? [...type].map(String).sort().join("|") : undefined);
  }
  return out;
}

/** Compares the API of the built folder `base` with that of `head`; empty when nothing a consumer relies on is gone. */
export async function compareApi(base: string, head: string): Promise<ApiBreak[]> {
  const breaks: ApiBreak[] = [];
  const headVersions = new Set(await versionsOf(head));
  for (const version of await versionsOf(base)) {
    const indexPath = `api/${version}/index.json`;
    const before = indexOf(await readJson(base, indexPath));
    if (before === undefined) continue;
    if (!headVersions.has(version)) {
      // A version may go once an earlier release marked it deprecated; removing it in the release that deprecates it, or while it is current, breaks its readers.
      if (before.status !== "deprecated") {
        breaks.push({
          file: indexPath,
          message: `version ${version} is still current in the baseline and is no longer published`,
          fix: `keep ${version} under api.versions, and mark it \`deprecated: true\` with a sunset and a successor; remove it in a later release`,
        });
      }
      continue;
    }
    const after = indexOf(await readJson(head, indexPath));
    if (after === undefined) {
      breaks.push({ file: indexPath, message: "the index is missing or unreadable", fix: "build the site with the api output on" });
      continue;
    }
    for (const collection of before.collections) {
      const file = `api/${version}/${collection.name}.json`;
      const now = after.collections.find((c) => c.name === collection.name);
      if (now === undefined) {
        breaks.push({
          file,
          message: `collection "${collection.name}" is no longer published`,
          fix: `list "${collection.name}" under api.collections again, or move consumers to a new version`,
        });
        continue;
      }
      const oldTypes = typesOf(await readJson(base, `api/${version}/schemas/${collection.name}.json`));
      const newTypes = typesOf(await readJson(head, `api/${version}/schemas/${collection.name}.json`));
      for (const field of collection.fields) {
        if (!now.fields.includes(field)) {
          breaks.push({
            file,
            field,
            message: `field "${field}" was removed from "${collection.name}"`,
            fix: `add "${field}" back to api.collections.${collection.name}.fields, or publish a new version`,
          });
          continue;
        }
        const was = oldTypes.get(field);
        const is = newTypes.get(field);
        if (was !== undefined && is !== undefined && was !== is) {
          breaks.push({
            file,
            field,
            message: `field "${field}" of "${collection.name}" changed type from ${was} to ${is}`,
            fix: `keep the type of "${field}" as ${was}, or publish the new type under a new field or version`,
          });
        }
      }
    }
  }
  return breaks;
}
