import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generate, sizes, write } from "../fixtures/data-large/generate.ts";

for (const records of [1000, 10000]) {
  test(`the generator gives identical files for ${records} records`, () => {
    const first = generate(records);
    const second = generate(records);
    assert.deepEqual(second, first);
    const paths = first.map(([path]) => path);
    assert.deepEqual(paths, [...paths].sort());
  });
}

test("the three collections add up to the requested records", () => {
  for (const records of [3, 1000, 10000]) {
    const { regions, components, releases } = sizes(records);
    assert.equal(regions + components + releases, records);
  }
});

test("a different seed changes the data, and too few records is refused", () => {
  assert.notDeepEqual(generate(100, 2), generate(100, 1));
  assert.throws(() => generate(2), /at least 3/);
});

test("written files are identical between two runs", () => {
  const parent = mkdtempSync(join(tmpdir(), "mizzen-data-large-"));
  try {
    write(join(parent, "a"), 1000);
    write(join(parent, "b"), 1000);
    const list = (dir: string) => (readdirSync(dir, { recursive: true }) as string[]).sort();
    const a = list(join(parent, "a"));
    assert.deepEqual(list(join(parent, "b")), a);
    for (const rel of a) {
      if (statSync(join(parent, "a", rel)).isFile()) {
        assert.equal(readFileSync(join(parent, "b", rel), "utf8"), readFileSync(join(parent, "a", rel), "utf8"));
      }
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
