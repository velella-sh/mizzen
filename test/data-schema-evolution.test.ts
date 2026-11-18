import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { dataSnapshot } from "../src/cli/data.ts";
import { main, parseArgs } from "../src/cli/index.ts";
import { loadConfig } from "../src/config/load.ts";
import { loadCollections } from "../src/data/collections.ts";
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

const BEFORE = schema({
  id: { type: "string" },
  legacy: { type: "string" },
  status: { type: "string", values: ["draft", "published"] },
  title: { type: "string" },
});
const AFTER = schema(
  {
    author: { type: "string" },
    id: { type: "number" },
    slug: { type: "string" },
    status: { type: "string", values: ["published"] },
    title: { type: "string" },
  },
  ["title", "slug"],
);

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

async function migrate(root: string, ...args: string[]): Promise<{ readonly code: number; readonly output: string }> {
  const lines: string[] = [];
  const code = await main(["data", "migrate", ...args, root], {
    log: () => {},
    error: (message: string) => void lines.push(`${message}\n`),
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

test("compareSchemas reports a mapped rename once, while an unmapped pair stays a removal and an addition", () => {
  const baseline = { version: "before", file: "_data/items.schema.json", fields: { path: { required: true }, title: { required: true } } };
  const current = { version: "after", file: "_data/items.schema.json", fields: { slug: { required: true }, title: { required: true } } };
  const changes = compareSchemas(current, baseline, { slug: "path" });
  assert.deepEqual(
    changes.map(({ id, severity, field, change }) => ({ id, severity, field, change })),
    [{ id: "data.schema-field-renamed", severity: "warning", field: "slug", change: "renamed" }],
  );
  assert.match(changes[0]?.message ?? "", /`path` was renamed to `slug`; baseline before -> now after/);
  assert.deepEqual(
    compareSchemas(current, baseline).map(({ id, field, change }) => ({ id, field, change })),
    [
      { id: "data.schema-field-removed", field: "path", change: "removed" },
      { id: "data.schema-required-field-added", field: "slug", change: "added" },
    ],
  );
});

test("schemaRenames moves an old field's value and spans before validation and warns when both names are present", async () => {
  const root = mkdtempSync(join(tmpdir(), "data-schema-renames-"));
  try {
    for (const [path, text] of Object.entries({
      "mizzen.yml":
        "collections:\n  items:\n    source: _data/items.yml\n    schema: _data/items.schema.json\n    schemaRenames:\n      slug: legacy\n",
      "_data/items.schema.json": schema({ id: { type: "string" }, slug: { type: "string" }, title: { type: "string" } }, ["title", "slug"]),
      "_data/items.yml": "- id: a\n  title: A\n  legacy: old-a\n- id: b\n  title: B\n  slug: new-b\n  legacy: old-b\n",
    })) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }

    const { config } = loadConfig(root);
    const result = await loadCollections({ root, config });
    const [a, b] = result.collections["items"]!.records;
    assert.deepEqual(a!.fields, { id: "a", title: "A", slug: "old-a" });
    assert.deepEqual(a!.fieldPositions["slug"], { file: "_data/items.yml", startLine: 3, startColumn: 11, endLine: 3, endColumn: 15 });
    assert.deepEqual(a!.keyPositions?.["slug"], { file: "_data/items.yml", startLine: 3, startColumn: 3, endLine: 3, endColumn: 8 });
    assert.deepEqual(b!.fields, { id: "b", title: "B", slug: "new-b" });
    assert.deepEqual(
      result.diagnostics.filter((diagnostic) => diagnostic.id === "data.schema-rename-conflict").map(({ severity, pos }) => ({ severity, pos })),
      [{ severity: "warning", pos: { file: "_data/items.yml", line: 7, column: 3, endLine: 7, endColumn: 8 } }],
    );
    assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.severity === "error"), "the renamed records validate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compareSchemas reports a type change and each removed enum value with both versions", () => {
  const fields = { id: { required: true, type: "string" }, status: { required: false, type: "string", enum: ["draft", "published", "archived"] } };
  const currentFields = { id: { required: true, type: "number" }, status: { required: false, type: "string", enum: ["published"] } };
  const changes = compareSchemas(
    { version: "after", file: "_data/items.schema.json", fields: currentFields },
    { version: "before", file: "_data/items.schema.json", fields },
  );
  assert.deepEqual(
    changes.map(({ id, severity, field, change }) => ({ id, severity, field, change })),
    [
      { id: "data.schema-type-change", severity: "error", field: "id", change: "type-changed" },
      { id: "data.schema-enum-removed", severity: "error", field: "status", change: "enum-removed" },
      { id: "data.schema-enum-removed", severity: "error", field: "status", change: "enum-removed" },
    ],
  );
  assert.match(changes[0]?.message ?? "", /`id` changed type from `string` to `number`; baseline before -> now after/);
  assert.deepEqual(
    changes.slice(1).map((change) => change.message),
    [
      'field `status` no longer accepts "archived"; baseline before -> now after',
      'field `status` no longer accepts "draft"; baseline before -> now after',
    ],
  );
});

test("data schema reports the fields a schema added and removed, in text and JSON", async () => {
  const root = tree();
  assert.equal((await dataSnapshot({ root, name: "items" })).code, 0);
  writeFileSync(join(root, "_data", "items.schema.json"), AFTER);

  const text = await run(root);
  assert.equal(text.code, 0, text.output);
  assert.match(text.output, /items: _data\/items\.schema\.json, baseline [0-9a-f]{12} -> now [0-9a-f]{12}/);
  assert.match(text.output, / {2}warning data\.schema-optional-field-added: field `author` was added as optional; baseline [0-9a-f]{12} -> now [0-9a-f]{12}/);
  assert.match(text.output, / {2}error data\.schema-type-change: field `id` changed type from `string` to `number`; baseline [0-9a-f]{12} -> now [0-9a-f]{12}/);
  assert.match(text.output, / {2}warning data\.schema-field-removed: field `legacy` was removed; baseline [0-9a-f]{12} -> now [0-9a-f]{12}/);
  assert.match(text.output, / {2}error data\.schema-required-field-added: field `slug` is required, and earlier records lack it; baseline [0-9a-f]{12} -> now [0-9a-f]{12}/);
  assert.match(text.output, / {2}error data\.schema-enum-removed: field `status` no longer accepts "draft"; baseline [0-9a-f]{12} -> now [0-9a-f]{12}/);
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
            id: "data.schema-type-change",
            severity: "error",
            field: "id",
            change: "type-changed",
            message: `field \`id\` changed type from \`string\` to \`number\`; baseline ${baseline.slice(0, 12)} -> now ${now.slice(0, 12)}`,
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
          {
            id: "data.schema-enum-removed",
            severity: "error",
            field: "status",
            change: "enum-removed",
            message: `field \`status\` no longer accepts "draft"; baseline ${baseline.slice(0, 12)} -> now ${now.slice(0, 12)}`,
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

test("data migrate previews a renamed record and a rejected one by line without writing the file", async () => {
  const root = mkdtempSync(join(tmpdir(), "data-migrate-"));
  try {
    for (const [path, text] of Object.entries({
      "mizzen.yml":
        "collections:\n  items:\n    source: _data/items.yml\n    schema: _data/items.schema.json\n    schemaRenames:\n      slug: legacy\n",
      "_data/items.schema.json": schema({ id: { type: "string" }, slug: { type: "string" }, title: { type: "string" } }, ["title", "slug"]),
      "_data/items.yml": "- id: a\n  title: A\n  legacy: old-a\n- id: b\n  title: 2\n  slug: b\n",
    })) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const before = readFileSync(join(root, "_data/items.yml"));

    const result = await migrate(root, "items");
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /items: _data\/items\.yml, schema _data\/items\.schema\.json/);
    assert.match(result.output, / {2}2 records, 1 renamed, 1 rejected/);
    assert.match(result.output, / {2}sample \{"id":"a","title":"A","slug":"old-a"\}/);
    assert.match(result.output, / {2}error _data\/items\.yml:5: data\.record-invalid: Field "title" of record "b" in "items" must be a string\./);
    const loaded = await loadCollections({ root, config: loadConfig(root).config });
    const invalid = loaded.diagnostics.filter((diagnostic) => diagnostic.id === "data.record-invalid");
    assert.equal(invalid.length, 1, JSON.stringify(loaded.diagnostics));
    const pos = invalid[0]!.pos!;
    assert.ok(invalid[0]!.message.startsWith("Field \"title\" of record \"b\""));
    assert.ok(result.output.includes(`${pos.file}:${pos.line}: data.record-invalid`), result.output);
    assert.deepEqual(readFileSync(join(root, "_data/items.yml")), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("data migrate refuses a source outside the site root", async () => {
  const parent = mkdtempSync(join(tmpdir(), "data-migrate-outside-"));
  const root = join(parent, "site");
  try {
    mkdirSync(join(root, "_data"), { recursive: true });
    writeFileSync(
      join(root, "mizzen.yml"),
      "collections:\n  items:\n    source: ../outside.yml\n    schema: _data/items.schema.json\n",
    );
    writeFileSync(join(root, "_data", "items.schema.json"), schema({ id: { type: "string" } }, ["id"]));
    writeFileSync(join(parent, "outside.yml"), "- id: outside\n");

    const result = await migrate(root, "items");
    assert.equal(result.code, 1);
    assert.match(result.output, /items: "\.\.\/outside\.yml" is outside the site root\./);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
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
  const migrateParsed = parseArgs(["data", "migrate", "items", root]);
  assert.ok(
    "options" in migrateParsed &&
      migrateParsed.options.command === "data-migrate" &&
      migrateParsed.options.name === "items" &&
      migrateParsed.options.root === root,
  );
});

test("the build fails on an incompatible schema change, warns with onSchemaChange: warn, and is clean after a renamed snapshot", async () => {
  const root = tree();
  try {
    writeFileSync(join(root, "_data/items.yml"), "- id: a\n  title: A\n  legacy: old-a\n");
    execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qam", "legacy"], { cwd: root, stdio: "ignore" });
    assert.equal((await dataSnapshot({ root, name: "items" })).code, 0);
    const typeChanged = schema({
      id: { type: "number" },
      legacy: { type: "string" },
      status: { type: "string", values: ["draft", "published"] },
      title: { type: "string" },
    });
    writeFileSync(join(root, "_data", "items.schema.json"), typeChanged);

    const failed = await loadCollections({ root, config: loadConfig(root).config });
    const errors = failed.diagnostics.filter((diagnostic) => diagnostic.id === "data.schema-type-change");
    assert.equal(errors.length, 1, JSON.stringify(failed.diagnostics));
    assert.equal(errors[0]!.severity, "error");
    assert.match(errors[0]!.message, /^Collection "items" field "id" field `id` changed type from `string` to `number`; baseline [0-9a-f]{12} -> now [0-9a-f]{12}$/);
    assert.equal(errors[0]!.pos?.file, "mizzen.yml");
    assert.match(errors[0]!.help ?? "", /`mizzen data snapshot items`/);
    assert.match(errors[0]!.help ?? "", /`collections\.items\.onSchemaChange: warn`/);

    writeFileSync(
      join(root, "mizzen.yml"),
      "collections:\n  items:\n    source: _data/items.yml\n    schema: _data/items.schema.json\n    onSchemaChange: warn\n  notes:\n    source: _data/notes.yml\n",
    );
    const warned = await loadCollections({ root, config: loadConfig(root).config });
    assert.deepEqual(
      warned.diagnostics.filter((diagnostic) => diagnostic.id === "data.schema-type-change").map(({ severity }) => severity),
      ["warning"],
    );

    writeFileSync(
      join(root, "mizzen.yml"),
      "collections:\n  items:\n    source: _data/items.yml\n    schema: _data/items.schema.json\n    schemaRenames:\n      slug: legacy\n  notes:\n    source: _data/notes.yml\n",
    );
    writeFileSync(
      join(root, "_data", "items.schema.json"),
      schema({ id: { type: "string" }, slug: { type: "string" }, status: { type: "string", values: ["draft", "published"] }, title: { type: "string" } }, ["title", "slug"]),
    );

    const mapped = await loadCollections({ root, config: loadConfig(root).config });
    assert.deepEqual(mapped.diagnostics.filter((diagnostic) => diagnostic.id.startsWith("data.schema-")), []);
    assert.equal((await dataSnapshot({ root, name: "items" })).code, 0);

    const renamed = await loadCollections({ root, config: loadConfig(root).config });
    assert.deepEqual(renamed.diagnostics.filter((diagnostic) => diagnostic.id.startsWith("data.schema-")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
