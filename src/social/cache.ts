import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SlotOutcome } from "./render.ts";

/** Bumped when anything that is not in the key changes what an image looks like. */
const FORMAT = "1";

/** One cached image. */
export interface CachedImage {
  readonly png: Uint8Array;
  readonly outcomes: readonly SlotOutcome[];
}

/**
 * The key of one image: the template's bytes, the fonts' bytes and order, and the slot values. Nothing else can change
 * a picture, so nothing else is in it.
 */
export function imageKey(templateHash: string, fontsKey: string, values: Readonly<Record<string, string>>): string {
  const sorted = Object.keys(values).sort().map((field) => [field, values[field]]);
  return createHash("sha256").update(`${FORMAT}\0${templateHash}\0${fontsKey}\0${JSON.stringify(sorted)}`).digest("hex");
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

/** True for bytes that look like a whole PNG, so a half-written or damaged entry is a miss and not a bad image. */
function looksComplete(bytes: Buffer): boolean {
  return bytes.length > 20 && bytes.subarray(0, 8).equals(SIGNATURE) && bytes.subarray(bytes.length - 12).equals(IEND);
}

function isOutcomes(value: unknown): value is SlotOutcome[] {
  return (
    Array.isArray(value) &&
    value.every((v) => typeof v === "object" && v !== null && typeof (v as SlotOutcome).field === "string" && typeof (v as SlotOutcome).truncated === "boolean")
  );
}

/** A folder of finished images, keyed by {@link imageKey}. Any failure to read or write it is a miss, never an error. */
export class ImageCache {
  readonly #dir: string;

  constructor(cacheDir: string) {
    this.#dir = join(cacheDir, "social-images");
  }

  #paths(key: string): { png: string; meta: string } {
    const base = join(this.#dir, key.slice(0, 2), key);
    return { png: `${base}.png`, meta: `${base}.json` };
  }

  async get(key: string): Promise<CachedImage | undefined> {
    const paths = this.#paths(key);
    try {
      const png = await readFile(paths.png);
      const outcomes: unknown = JSON.parse(await readFile(paths.meta, "utf8"));
      if (!looksComplete(png) || !isOutcomes(outcomes)) return undefined;
      return { png: new Uint8Array(png), outcomes };
    } catch {
      return undefined;
    }
  }

  async set(key: string, image: CachedImage): Promise<void> {
    const paths = this.#paths(key);
    const suffix = `.${String(process.pid)}.${createHash("sha256").update(key + String(performance.now())).digest("hex").slice(0, 8)}.tmp`;
    try {
      await mkdir(join(this.#dir, key.slice(0, 2)), { recursive: true });
      // The picture goes last: an entry with a picture is an entry with its notes.
      await writeFile(paths.meta + suffix, JSON.stringify(image.outcomes));
      await rename(paths.meta + suffix, paths.meta);
      await writeFile(paths.png + suffix, image.png);
      await rename(paths.png + suffix, paths.png);
    } catch {
      await rm(paths.meta + suffix, { force: true }).catch(() => undefined);
      await rm(paths.png + suffix, { force: true }).catch(() => undefined);
    }
  }
}
