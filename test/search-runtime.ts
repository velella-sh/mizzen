import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { OutputFile } from "../src/contracts/index.ts";
import type { ModelResult } from "../src/model/build.ts";
import { buildModel } from "../src/model/build.ts";
import { search } from "../src/outputs/search.ts";
import { site } from "./data-record-site.ts";

interface ResultData {
  readonly url: string;
  readonly meta: Record<string, string>;
  readonly filters: Record<string, string[]>;
  readonly excerpt?: string;
}

interface SearchResult {
  readonly results: readonly { data(): Promise<ResultData> }[];
}

/** The generated search runtime, as much of it as the tests use. */
export interface Runtime {
  options(options: { basePath?: string }): Promise<void>;
  init(): Promise<void>;
  search(
    term: string,
    options?: { filters?: Record<string, string | string[]>; sort?: Record<string, "asc" | "desc"> },
  ): Promise<SearchResult>;
}

/** Writes the output's files under a temporary folder, so Pagefind's runtime can be imported from it. */
async function writeFiles(files: readonly OutputFile[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "data-search-"));
  for (const file of files) {
    const abs = join(dir, file.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, file.contents);
  }
  return dir;
}

/**
 * Loads the generated `pagefind.js` in Node. Pagefind's runtime fetches the index, which Node's `fetch` refuses for
 * `file:` URLs and for a site path, so the test answers those requests from the temporary folder and restores the
 * real fetch afterwards. The base path is `/pagefind/`, as on a published site, so result URLs stay site-relative.
 */
export async function loadRuntime(dir: string): Promise<{ runtime: Runtime; restore: () => void }> {
  const original = globalThis.fetch;
  const runtimeBase = "/pagefind/";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (typeof input === "string") {
      const url = new URL(input, pathToFileURL(`${dir}/`));
      if (url.pathname.startsWith(runtimeBase)) {
        return new Response(await readFile(join(dir, "pagefind", decodeURIComponent(url.pathname.slice(runtimeBase.length)))));
      }
      if (url.protocol === "file:") return new Response(await readFile(fileURLToPath(url)));
    }
    return original(input, init);
  }) as typeof fetch;
  try {
    const runtime = (await import(pathToFileURL(join(dir, "pagefind", "pagefind.js")).href)) as Runtime;
    await runtime.options({ basePath: runtimeBase });
    await runtime.init();
    return { runtime, restore: () => (globalThis.fetch = original) };
  } catch (error) {
    globalThis.fetch = original;
    throw error;
  }
}

/**
 * Builds a site, runs the search output on its model, and hands the callback the model and the loaded runtime. The
 * temporary site and index are removed afterwards, and the runtime is restored even when a test fails.
 */
export async function withIndexedSite(
  files: Readonly<Record<string, string>>,
  run: (result: ModelResult, runtime: Runtime) => Promise<void> | void,
): Promise<void> {
  const root = site(files);
  let dir: string | undefined;
  let restore: (() => void) | undefined;
  try {
    const result = await buildModel(root);
    dir = await writeFiles(await search.run(result.site, { renderPage: async () => "", report: () => {} }));
    const loaded = await loadRuntime(dir);
    restore = loaded.restore;
    await run(result, loaded.runtime);
  } finally {
    restore?.();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}

/** The URLs of a search's results, in order. */
export async function urlsOf(found: SearchResult): Promise<string[]> {
  return Promise.all(found.results.map(async (result) => (await result.data()).url));
}
