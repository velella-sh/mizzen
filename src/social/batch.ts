/**
 * Draws a batch of social images, in worker threads when the build has them. A worker holds its own copy of the
 * renderer and draws a contiguous share of the jobs, and the results are put back in job order, so one worker or four
 * give the same bytes in the same order. A worker that fails leaves its share to this thread. This is its own pool, not
 * the page-render pool of `src/pipeline/parallel.ts`: that one is bound to the theme and to pages.
 *
 * The file is both the pool and the worker entry: Node starts it in a thread, and the {@link isMainThread} guard at
 * the bottom turns it into a worker.
 */
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { OWN_EXTENSION } from "../runtime/modules.ts";
import { renderTemplate, SocialRenderer, type RenderFont, type SlotOutcome } from "./render.ts";
import type { SocialTemplate } from "./template.ts";

/** One image to draw. */
export interface ImageJob {
  /** The name of the template, a key of {@link BatchInput.templates}. */
  readonly template: string;
  /** The slot values. */
  readonly values: Readonly<Record<string, string>>;
}

/** One drawn image. */
export interface ImageResult {
  readonly png: Uint8Array;
  readonly outcomes: readonly SlotOutcome[];
}

/** What every worker needs to start. */
export interface BatchInput {
  readonly fonts: readonly RenderFont[];
  readonly templates: Readonly<Record<string, SocialTemplate>>;
}

/** Fewer jobs than this are drawn here: starting a thread costs more than it saves. */
const MIN_JOBS_PER_WORKER = 4;

async function drawHere(input: BatchInput, jobs: readonly ImageJob[], renderer?: SocialRenderer): Promise<ImageResult[]> {
  const drawer = renderer ?? (await SocialRenderer.create(input.fonts));
  return jobs.map((job) => renderTemplate(input.templates[job.template]!, job.values, drawer));
}

function drawInWorker(input: BatchInput, jobs: readonly ImageJob[]): Promise<ImageResult[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(`./batch${OWN_EXTENSION}`, import.meta.url), { workerData: { input, jobs } });
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      action();
    };
    worker.once("message", (message: { results: ImageResult[] }) => finish(() => resolve(message.results)));
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", (code) => finish(() => reject(new Error(`the image worker stopped (exit ${String(code)})`))));
  });
}

/**
 * Draws every job and returns the results in the order of `jobs`.
 *
 * @param workers The most threads to use; `1` draws in this thread.
 * @returns The results, and how many jobs a failed worker left to this thread.
 */
export async function drawImages(
  input: BatchInput,
  jobs: readonly ImageJob[],
  workers: number,
): Promise<{ readonly results: readonly ImageResult[]; readonly fellBack: number }> {
  if (jobs.length === 0) return { results: [], fellBack: 0 };
  const count = Math.min(Math.max(1, Math.floor(workers)), Math.floor(jobs.length / MIN_JOBS_PER_WORKER));
  if (count <= 1) return { results: await drawHere(input, jobs), fellBack: 0 };

  const size = Math.ceil(jobs.length / count);
  const shares: ImageJob[][] = [];
  for (let at = 0; at < jobs.length; at += size) shares.push(jobs.slice(at, at + size));
  let fellBack = 0;
  let local: SocialRenderer | undefined;
  const drawn = await Promise.all(
    shares.map(async (share) => {
      try {
        return await drawInWorker(input, share);
      } catch {
        fellBack += share.length;
        local ??= await SocialRenderer.create(input.fonts);
        return drawHere(input, share, local);
      }
    }),
  );
  return { results: drawn.flat(), fellBack };
}

if (!isMainThread && parentPort !== null && workerData !== null && typeof workerData === "object" && "jobs" in workerData) {
  const data = workerData as { input: BatchInput; jobs: ImageJob[] };
  const port = parentPort;
  void drawHere(data.input, data.jobs).then((results) => port.postMessage({ results }));
}
