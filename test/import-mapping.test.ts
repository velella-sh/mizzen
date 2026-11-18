import assert from "node:assert/strict";
import { test } from "node:test";
import { MAPPING_DESTINATION, MAPPING_VERSION, mappingRecord, type ImportMapping } from "../src/import/mapping.ts";

test("the mapping record is versioned, sorted by source, and round-trips", () => {
  const mappings: ImportMapping[] = [
    { source: "z.md", kind: "content", destination: "z.md", url: "/z/" },
    { source: "a.png", kind: "asset", destination: "img/a.png", url: "/img/a.png" },
    { source: "gone.txt", kind: "unsupported", reason: "not supported by the importer" },
    { source: "b.yml", kind: "config", destination: "mizzen.yml", reason: "merged into mizzen.yml" },
  ];
  const text = mappingRecord(mappings);

  assert.equal(MAPPING_DESTINATION, ".mizzen-import.json");
  assert.equal(text, mappingRecord([...mappings].reverse()));
  assert.ok(text.endsWith("}\n"));
  assert.deepEqual(JSON.parse(text), {
    version: MAPPING_VERSION,
    files: [
      { source: "a.png", kind: "asset", destination: "img/a.png", url: "/img/a.png" },
      { source: "b.yml", kind: "config", destination: "mizzen.yml", reason: "merged into mizzen.yml" },
      { source: "gone.txt", kind: "unsupported", reason: "not supported by the importer" },
      { source: "z.md", kind: "content", destination: "z.md", url: "/z/" },
    ],
  });
});
