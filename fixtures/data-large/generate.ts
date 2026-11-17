// Writes a data site with a chosen number of records, from a fixed seed. The site has three collections (regions,
// components, releases) with references between them, two list pages, and one feed. Nothing reads the clock or an
// unseeded random source, so two runs with the same arguments write identical files. The output is not committed.
//
// Usage: node fixtures/data-large/generate.ts --records 10000 [--out <dir>] [--seed 1]
// Default out: fixtures/data-large/.generated/<records>/ (ignored by git).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SEED = 1;

/** mulberry32: a tiny seeded generator, so the records never change between runs. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STATUSES = ["stable", "beta", "deprecated"];
const WORDS = ["button", "dialog", "tooltip", "banner", "table", "stepper", "menu", "tab", "badge", "card", "field", "toggle"];
const VERBS = ["starts", "shows", "hides", "groups", "labels", "confirms", "filters", "orders"];

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

/** The date `offset` days after 2024-01-01, as `YYYY-MM-DD`, computed without a clock. */
function day(offset: number): string {
  return new Date(Date.UTC(2024, 0, 1 + offset)).toISOString().slice(0, 10);
}

export interface Sizes {
  readonly regions: number;
  readonly components: number;
  readonly releases: number;
}

/** Splits `records` over the three collections: a few regions, then half and half. They add up to `records`. */
export function sizes(records: number): Sizes {
  const regions = Math.min(50, Math.max(1, Math.ceil(records / 200)));
  const rest = records - regions;
  const components = Math.ceil(rest / 2);
  return { regions, components, releases: rest - components };
}

/** Every generated file as `[relative path, contents]`, sorted by path. */
export function generate(records: number, seed: number = SEED): Array<[string, string]> {
  if (!Number.isInteger(records) || records < 3) throw new Error(`records must be an integer of at least 3, got ${records}`);
  const random = seeded(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const n = sizes(records);
  const files: Array<[string, string]> = [];

  const regionIds = Array.from({ length: n.regions }, (_, i) => `region-${pad(i + 1, 3)}`);
  const regionRows = ["id,name,zone"];
  for (const [i, id] of regionIds.entries()) regionRows.push(`${id},Region ${i + 1},zone-${1 + Math.floor(random() * 5)}`);
  files.push(["_data/regions.csv", `${regionRows.join("\n")}\n`]);

  const componentIds = Array.from({ length: n.components }, (_, i) => `component-${pad(i + 1, 5)}`);
  const components: string[] = [];
  for (const [i, slug] of componentIds.entries()) {
    const word = pick(WORDS);
    components.push(
      `- slug: ${slug}\n  name: ${word} ${i + 1}\n  summary: |\n    A **${word}** ${pick(VERBS)} one thing. Variant ${Math.floor(random() * 1000)}.\n\n    - Use it ${pick(VERBS)}.\n  status: ${pick(STATUSES)}\n  released: ${day(Math.floor(random() * 700))}\n  region: ${pick(regionIds)}`,
    );
  }
  files.push(["_data/components.yml", `${components.join("\n")}\n`]);

  const releases: Record<string, unknown> = {};
  for (let i = 0; i < n.releases; i++) {
    const id = `${1 + Math.floor(i / 1000)}.${Math.floor(i / 10) % 100}.${i % 10}-${pad(i, 5)}`;
    releases[id] = {
      date: day(Math.floor(random() * 700)),
      status: pick(STATUSES),
      summary: `Release ${i + 1} touches the ${pick(WORDS)}. Change ${Math.floor(random() * 1000)}.`,
      component: pick(componentIds),
    };
  }
  files.push(["_data/releases.json", `${JSON.stringify(releases, null, 2)}\n`]);

  files.push([
    "mizzen.yml",
    `title: Large data site
description: ${records} generated records, for benchmarks.
lang: en
url: https://example.com
collections:
  regions:
    source: _data/regions.csv
    template: _templates/regions.md
    permalink: /regions/{id}/
  components:
    source: _data/components.yml
    id: slug
    template: _templates/components.md
    permalink: /components/{slug}/
    markdown: [summary]
    dates: [released]
    references:
      region: regions
  releases:
    source: _data/releases.json
    template: _templates/releases.md
    permalink: /releases/{id}/
    dates: [date]
    references:
      component: components
feeds:
  releases:
    collection: releases
    date: date
    limit: 50
`,
  ]);
  files.push(["_templates/regions.md", `---\ntitle: "{name}"\nlayout: doc\n---\n# :field[name]\n\nZone: :field[zone]\n`]);
  files.push([
    "_templates/components.md",
    `---\ntitle: "{name}"\ndescription: "The {name} component."\nlayout: doc\n---\n# :field[name]\n\n:field[summary]\n\nStatus: :field[status] · Released: :field[released] · Region: :field[region]\n`,
  ]);
  files.push(["_templates/releases.md", `---\ntitle: "Release {id}"\nlayout: doc\n---\n# Release :field[id]\n\n:field[summary]\n\nDate: :field[date] · Status: :field[status] · Component: :field[component]\n`]);
  files.push(["index.md", `---\ntitle: Large data site\n---\n# Large data site\n\nGenerated records: ${records}.\n\n- [Components](/components/)\n- [Releases](/releases/)\n`]);
  files.push([
    "components.md",
    `---\ntitle: Components\nlayout: doc\nlist:\n  collection: components\n  sort: [released desc, name]\n  perPage: 100\n  fields: [name, status, released]\n---\n# Components\n`,
  ]);
  files.push([
    "releases.md",
    `---\ntitle: Releases\nlayout: doc\nlist:\n  collection: releases\n  sort: [date desc]\n  perPage: 100\n  fields: [date, status, component]\n---\n# Releases\n`,
  ]);
  return files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Writes the site into `out`, replacing what was there. */
export function write(out: string, records: number, seed: number = SEED): void {
  rmSync(out, { recursive: true, force: true });
  for (const [path, text] of generate(records, seed)) {
    const abs = join(out, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const valueOf = (flag: string, fallback: string): string => {
    const index = args.indexOf(flag);
    return index === -1 ? fallback : (args[index + 1] ?? fallback);
  };
  const records = Number(valueOf("--records", "1000"));
  const seed = Number(valueOf("--seed", String(SEED)));
  const out = resolve(valueOf("--out", join(fileURLToPath(new URL(".", import.meta.url)), ".generated", String(records))));
  write(out, records, seed);
  console.log(`wrote ${records} records to ${out}`);
}
