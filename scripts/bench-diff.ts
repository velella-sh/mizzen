/**
 * Times `mizzen diff` on two synthetic builds of N pages (default 10000) where a few percent of the pages changed.
 * Run: node scripts/bench-diff.ts [pages]. It prints the time and how many files the diff opened; the diff should
 * open files only for the pages that changed, so the count stays small while N grows.
 */
import { performance } from "node:perf_hooks";
import { readBuild } from "../src/diff/builds.ts";
import { diffReadBuilds } from "../src/diff/index.ts";
import { Reader } from "../src/diff/reader.ts";
import { cleanup, writeBuild } from "../test/site-diff-builds.ts";

const count = Number(process.argv[2] ?? 10000);
const pages = Array.from({ length: count }, (_, i) => ({ url: `/p${i}/`, title: `P${i}`, md: `# P${i}\n\nbody ${i}\n` }));
const changed = pages.map((page, i) => (i % 50 === 0 ? { ...page, md: `${page.md}\nchanged\n` } : page));

const a = await writeBuild({ pages });
const b = await writeBuild({ pages: changed });
const [base, head] = [await readBuild(a, "a"), await readBuild(b, "b")];
const reader = new Reader();
const start = performance.now();
const diff = await diffReadBuilds(base, head, reader);
const ms = performance.now() - start;
console.log(`${count} pages, ${diff.summary.pages.changed} changed: ${ms.toFixed(0)} ms, ${reader.reads} files opened`);
cleanup(a, b);
