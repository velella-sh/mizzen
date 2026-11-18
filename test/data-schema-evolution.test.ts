import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { dataSnapshot } from "../src/cli/data.ts";
import { main, parseArgs } from "../src/cli/index.ts";
import { sha256 } from "../src/data/lock.ts";
import { compareSchemas } from "../src/data/schema-evolution.ts";

function schema(fields: Record<string, { readonly type: string; readonly values?: readonly string[] }>, required: readonly string[] = ["title"]): string {
  return JSON.stringify({
    type: "object",
    required,
    properties: Object.fromEntries(
      Object.entries(fields).map(([name, field]) => [name, { type: field.type, ...(field.values === undefined ? {} : { enum: field.values }) }]),
    ),
  });
}

const BEFORE = schema({ id: { type: "string" }, legacy: { type: "string" }, title: { type: "string" } });
const AFTER = schema({ author: { type: "string" }, id: { type: "string" }, slug: { type: "string" }, title: { type: "string" } }, ["title", "slug"]);

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), "data-schema-evolution-"));
  for (const [path, text] of Object.entries({
    "mizzen.yml": "collections:\n  items:\n    source: _data/items.yml\n    schema: _data/items.schema.json\n  notes:\n    source: _data/notes.yml\n",
    "_data/items.yml": "- id: a\n  title: A\n",
    "_data/items.schema.json": BEFORE,
  })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "add", "-A"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "data"], { cwd: root, stdio: "ignore" });
  return root;
}

async function run(root: string, ...args: string[]): Promise<{ readonly code: number; readonly output: string }> {
  const lines: string[] = [];
  const code = await main(["data", "schema", root, ...args], {
    log: () => {},
    error: (message: string) => void lines.push(message),
    write: (text: string) => void lines.push(text),
  });
  return { code, output: lines.join("") };
}

test("compareSchemas reports an added required field as an error and an added optional field as a warning", () => {
  const baseline = { version: "before", file: "_data/items.schema.json", fields: { id: { required: true }, legacy: { required: false } } };
  const current = {
    version: "after",
    file: "_data/items.schema.json",
    fields: { author: { required: false }, id: { required: true }, slug: { required: true } },
  };
  const changes = compareSchemas(current, baseline);
  assert.deepEqual(
    changes.map(({ id, severity, field, change }) => ({ id, severity, field, change })),
    [
      { id: "data.schema-optional-field-added", severity: "warning", field: "author", change: "added" },
      { id: "data.schema-field-removed", severity: "warning", field: "legacy", change: "removed" },
      { id: "data.schema-required-field-added", severity: "error", field: "slug", change: "added" },
    ],
  );
  assert.match(changes[0]?.message ?? "", /`author` was added as optional; baseline before -> now after/);
  assert.match(changes[2]?.message ?? "", /`slug` is required, and earlier records lack it; baseline before -> now after/);
  assert.deepEqual(compareSchemas(current, current), []);
});

test("data schema reports the fields a schema added and removed, in text and JSON", async () => {
  const root = tree();
  assert.equal((await dataSnapshot({ root, name: "items" })).code, 0);
  writeFileSync(join(root, "_data", "items.schema.json"), AFTER);

  const text = await run(root);
  assert.equal(text.code, 0, text.output);
  assert.match(text.output, /items: _data\/items\.schema\.json, baseline [0-9a-f]{12} -> now [0-9a-f]{12}/);
  assert.match(text.output, / {2}warning data\.schema-optional-field-added: field `author` was added as optional; baseline [0-9a-f]{12} -> now [0-9a-f]{12}/);
  assert.match(text.output, / {2}warning data\.schema-field-removed: field `legacy` was removed; baseline [0-9a-f]{12} -> now [0-9a-f]{12}/);
  assert.match(text.output, / {2}error data\.schema-required-field-added: field `slug` is required, and earlier records lack it; baseline [0-9a-f]{12} -> now [0-9a-f]{12}/);
  assert.match(text.output, /skipped notes: no schema is declared or recorded/);

  const baseline = sha256(BEFORE);
  const now = sha256(AFTER);
  const current = { version: now, file: "_data/items.schema.json" };
  const json = await run(root, "--format", "json");
  assert.equal(json.code, 0, json.output);
  assert.deepEqual(JSON.parse(json.output), {
    collections: [
      {
        collection: "items",
        file: "_data/items.schema.json",
        version: now,
        baseline,
        changes: [
          {
            id: "data.schema-optional-field-added",
            severity: "warning",
            field: "author",
            change: "added",
            message: `field \`author\` was added as optional; baseline ${baseline.slice(0, 12)} -> now ${now.slice(0, 12)}`,
            baseline,
            current,
          },
          {
            id: "data.schema-field-removed",
            severity: "warning",
            field: "legacy",
            change: "removed",
            message: `field \`legacy\` was removed; baseline ${baseline.slice(0, 12)} -> now ${now.slice(0, 12)}`,
            baseline,
            current,
          },
          {
            id: "data.schema-required-field-added",
            severity: "error",
            field: "slug",
            change: "added",
            message: `field \`slug\` is required, and earlier records lack it; baseline ${baseline.slice(0, 12)} -> now ${now.slice(0, 12)}`,
            baseline,
            current,
          },
        ],
      },
    ],
    skipped: [{ collection: "notes", reason: "no schema is declared or recorded" }],
    errors: [],
  });
});

test("a schema equal to its baseline is reported as matching, and the parser refuses an unknown format", async () => {
  const root = tree();
  assert.equal((await dataSnapshot({ root, name: "items" })).code, 0);
  const text = await run(root);
  assert.equal(text.code, 0, text.output);
  assert.match(text.output, new RegExp(`^ok items: _data/items\\.schema\\.json matches baseline ${sha256(BEFORE).slice(0, 12)}`));

  const parsed = parseArgs(["data", "schema", root, "--format", "json"]);
  assert.ok("options" in parsed && parsed.options.command === "data-schema" && parsed.options.format === "json" && parsed.options.root === root);
  const refused = parseArgs(["data", "schema", "--format", "sarif"]);
  assert.ok("error" in refused && /must be text or json/.test(refused.error));
});
