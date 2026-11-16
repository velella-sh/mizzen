/** Reads files of the two builds on demand, once each: the diff opens a file only when a hash says it must. */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Build } from "./builds.ts";

export class Reader {
  readonly #cache = new Map<string, Promise<string | undefined>>();
  /** How many files were read; the determinism test uses it to show unchanged pages are never opened. */
  reads = 0;

  /** The file's text, or `undefined` when the build does not list it or it cannot be read. */
  text(build: Build, path: string | undefined): Promise<string | undefined> {
    if (path === undefined || build.files[path] === undefined) return Promise.resolve(undefined);
    const key = `${build.dir}\0${path}`;
    let found = this.#cache.get(key);
    if (found === undefined) {
      this.reads += 1;
      found = readFile(join(build.dir, path), "utf8").catch(() => undefined);
      this.#cache.set(key, found);
    }
    return found;
  }

  /** The file parsed as a JSON object, or `undefined`. */
  async json(build: Build, path: string | undefined): Promise<Record<string, unknown> | undefined> {
    const text = await this.text(build, path);
    if (text === undefined) return undefined;
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }

  /** The file's size in bytes, or `undefined` when the build does not list it. */
  async size(build: Build, path: string): Promise<number | undefined> {
    if (build.files[path] === undefined) return undefined;
    try {
      return (await stat(join(build.dir, path))).size;
    } catch {
      return undefined;
    }
  }
}
