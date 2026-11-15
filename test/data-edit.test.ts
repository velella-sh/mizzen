import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildModel } from "../src/model/build.ts";
import { applyPatch } from "../src/edits/patch.ts";
import { EditPlanError, planRecordFieldEdit } from "../src/edits/plan.ts";
import { createProof } from "../src/edits/proof.ts";
import { site } from "./data-record-site.ts";

const files = {
  "mizzen.yml":
    "collections:\n" +
    "  components:\n" +
    "    source: _data/components.yml\n" +
    "    template: _templates/components.md\n" +
    "    permalink: /components/{id}/\n" +
    "    schema: components.schema.json\n" +
    "  releases:\n" +
    "    source: _data/releases.json\n" +
    "    template: _templates/releases.md\n" +
    "    permalink: /releases/{id}/\n",
  "components.schema.json": JSON.stringify({
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  }),
  "_data/components.yml": "- id: button\n  name: Button\n",
  "_data/releases.json": '{\n  "one": {\n    "name": "One"\n  }\n}\n',
  "_templates/components.md": "---\ntitle: \"{name}\"\nlayout: record\n---\nBody.\n",
  "_templates/releases.md": "---\ntitle: \"{id}\"\nlayout: record\n---\nBody.\n",
};

test("a YAML field edit changes only the span, and the proof records before and after", async () => {
  const root = site(files);
  try {
    const result = await buildModel(root);
    const source = readFileSync(join(root, "_data/components.yml"), "utf8");
    const patch = planRecordFieldEdit({
      site: result.site,
      root,
      source,
      url: "/components/button/",
      field: "name",
      newText: "Big Button",
    });
    const after = applyPatch(source, patch);
    assert.equal(after, "- id: button\n  name: Big Button\n");
    const proof = createProof({
      siteRoot: root,
      files: ["_data/components.yml"],
      before: { "_data/components.yml": source },
      after: { "_data/components.yml": after },
      spans: { "_data/components.yml": [patch.span] },
    });
    assert.notEqual(proof.files[0]!.before, proof.files[0]!.after);
    assert.equal(proof.files[0]!.spans?.length, 1);
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(root, { recursive: true, force: true });
  }
});

test("a JSON field edit changes only the string", async () => {
  const root = site(files);
  try {
    const result = await buildModel(root);
    const source = readFileSync(join(root, "_data/releases.json"), "utf8");
    const patch = planRecordFieldEdit({
      site: result.site,
      root,
      source,
      url: "/releases/one/",
      field: "name",
      newText: '"First"',
    });
    const after = applyPatch(source, patch);
    assert.equal(after, '{\n  "one": {\n    "name": "First"\n  }\n}\n');
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(root, { recursive: true, force: true });
  }
});

test("an edit that would not parse, or would make the record invalid, is refused", async () => {
  const root = site(files);
  try {
    const result = await buildModel(root);
    const source = readFileSync(join(root, "_data/components.yml"), "utf8");
    assert.throws(
      () =>
        planRecordFieldEdit({
          site: result.site,
          root,
          source,
          url: "/components/button/",
          field: "name",
          newText: '"unclosed',
        }),
      (error: unknown) =>
        error instanceof EditPlanError &&
        (error.code === "edit.unparseable" || error.code === "edit.invalid-record"),
    );
    assert.throws(
      () =>
        planRecordFieldEdit({
          site: result.site,
          root,
          source,
          url: "/components/button/",
          field: "name",
          newText: "123",
        }),
      (error: unknown) => error instanceof EditPlanError && error.code === "edit.invalid-record",
    );
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(root, { recursive: true, force: true });
  }
});

test("a JSON string field refuses an unquoted replacement as unparseable", async () => {
  const root = site(files);
  try {
    const result = await buildModel(root);
    const source = readFileSync(join(root, "_data/releases.json"), "utf8");
    assert.throws(
      () =>
        planRecordFieldEdit({
          site: result.site,
          root,
          source,
          url: "/releases/one/",
          field: "name",
          newText: "First",
        }),
      (error: unknown) => error instanceof EditPlanError && error.code === "edit.unparseable",
    );
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(root, { recursive: true, force: true });
  }
});
