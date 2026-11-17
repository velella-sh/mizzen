import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { expandIncludes, type ExpandIncludesOptions } from "../../src/content/includes.ts";
import type { Diagnostic, SourcePos } from "../../src/contracts/index.ts";

/** A temporary folder holding `files`; the caller removes it. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "include-params-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Expands `body` of `file` under `root`, with the defaults the engine's build uses. */
function expand(root: string, file: string, body: string, extra: Partial<ExpandIncludesOptions> = {}) {
  return expandIncludes({ body, bodyLine: 1, file, sourceDir: root, ...extra });
}

/** The one finding with `id`, so a test can assert its position. */
function finding(diagnostics: readonly Diagnostic[], id: string): Diagnostic & { readonly pos: SourcePos } {
  const found = diagnostics.filter((diagnostic) => diagnostic.id === id);
  assert.equal(found.length, 1, `expected one ${id}, got ${diagnostics.map((d) => d.id).join(", ") || "none"}`);
  const one = found[0]!;
  assert.ok(one.pos !== undefined, `${id} has a position`);
  return one as Diagnostic & { readonly pos: SourcePos };
}

const INSTALL = `---
params:
  product: Beacon
  package: "@acme/beacon"
  edition: Standard
  support:
---
## Install {{product}}

The {{edition}} edition installs with \`npm install {{package}}\`.

Questions go to {{support}}.
`;

test("a fragment without params ignores extra attributes and keeps every placeholder", async () => {
  const root = tree({ "s/note.md": "---\ntitle: Note\n---\nHello {{product}}.\n" });
  try {
    const result = await expand(root, "page.md", '::include[s/note.md]{product="Orbit"}\n');
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.body, "Hello {{product}}.\n");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("defaults fill the body, the call site overrides them, and a value is Markdown source", async () => {
  const root = tree({ "s/install.md": INSTALL });
  try {
    const defaults = await expand(
      root,
      "guide/beacon.md",
      'Beacon runs on Node 24.\n\n::include[../s/install.md]{support="the *Beacon* team"}\n',
    );
    assert.deepEqual(defaults.diagnostics, []);
    assert.equal(
      defaults.body,
      `Beacon runs on Node 24.\n\n## Install Beacon\n\nThe Standard edition installs with \`npm install @acme/beacon\`.\n\nQuestions go to the *Beacon* team.\n`,
    );

    const overrides = await expand(
      root,
      "guide/orbit.md",
      '::include[../s/install.md]{product="Orbit" package="@acme/orbit" edition="Team" support="the Orbit team"}\n',
    );
    assert.deepEqual(overrides.diagnostics, []);
    assert.equal(
      overrides.body,
      `## Install Orbit\n\nThe Team edition installs with \`npm install @acme/orbit\`.\n\nQuestions go to the Orbit team.\n`,
    );
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a required parameter without a value reports at the call site and leaves its placeholder", async () => {
  const root = tree({ "s/install.md": INSTALL });
  try {
    const body = 'Intro.\n\n::include[s/install.md]{product="Orbit"}\n';
    const result = await expand(root, "page.md", body);
    const diagnostic = finding(result.diagnostics, "include.param-missing");
    assert.deepEqual(diagnostic.pos, { file: "page.md", line: 3, column: 1, endLine: 3, endColumn: 40 });
    assert.match(result.body, /Questions go to \{\{support\}\}\.\n$/);
    assert.match(result.body, /## Install Orbit/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("an unknown attribute of a declaring fragment reports at the call site and is ignored", async () => {
  const root = tree({ "s/install.md": INSTALL });
  try {
    const result = await expand(
      root,
      "page.md",
      '::include[s/install.md]{support="the team" colour="blue"}\n',
    );
    const diagnostic = finding(result.diagnostics, "include.param-unknown");
    assert.equal(diagnostic.pos.line, 1);
    assert.match(diagnostic.message, /colour/);
    assert.match(result.body, /## Install Beacon/);
    assert.doesNotMatch(result.body, /blue/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a reserved declared name is an error on the line that declares it", async () => {
  const root = tree({
    "s/bad.md": "---\nparams:\n  path: x\n  lines: 1\n---\nbody\n",
  });
  try {
    const result = await expand(root, "page.md", "::include[s/bad.md]\n");
    const reserved = result.diagnostics.filter((diagnostic) => diagnostic.id === "include.param-reserved");
    assert.equal(reserved.length, 2);
    assert.deepEqual(reserved.map((diagnostic) => diagnostic.pos?.line), [3, 4]);
    assert.equal(reserved[0]?.pos?.file, "s/bad.md");
    assert.equal(result.body, "body\n");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("params that is not a mapping, a bad name, and a non-string default are errors", async () => {
  const root = tree({
    "s/list.md": "---\nparams: [a, b]\n---\nbody\n",
    "s/number.md": "---\nparams:\n  version: 2\n---\nbody\n",
    "s/name.md": "---\nparams:\n  1bad: x\n---\nbody\n",
    "s/multi.md": "---\nparams:\n  who: |\n    two\n    lines\n---\nbody\n",
  });
  try {
    const list = await expand(root, "page.md", "::include[s/list.md]\n");
    assert.equal(finding(list.diagnostics, "include.param-invalid").pos.line, 2);

    const number = await expand(root, "page.md", "::include[s/number.md]\n");
    const invalid = finding(number.diagnostics, "include.param-invalid");
    assert.equal(invalid.pos.line, 3);
    assert.match(invalid.message, /version/);

    const name = await expand(root, "page.md", "::include[s/name.md]\n");
    assert.equal(finding(name.diagnostics, "include.param-invalid").pos.line, 3);

    const multi = await expand(root, "page.md", "::include[s/multi.md]\n");
    assert.equal(finding(multi.diagnostics, "include.param-invalid").pos.line, 3);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("escaping follows the odd/even backslash rule and the result is never scanned again", async () => {
  const root = tree({
    "s/note.md": "---\nparams:\n  product: \"{{product}}\"\n---\nA {{product}} B\nC \\{{product}} D\nE \\\\{{product}} F\nG {{product}} {{product}}\nH {{other}}\n",
  });
  try {
    const result = await expand(root, "page.md", "::include[s/note.md]\n");
    assert.deepEqual(result.diagnostics, []);
    assert.equal(
      result.body,
      "A {{product}} B\nC \\{{product}} D\nE \\{{product}} F\nG {{product}} {{product}}\nH {{other}}\n",
    );
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a nested include passes no values and is not visited by the outer fragment", async () => {
  const root = tree({
    "s/outer.md": "---\nparams:\n  name: Outer\n---\nOuter {{name}}\n::include[inner.md]{name=\"Nested\"}\nAfter {{name}}\n",
    "s/inner.md": "Inner {{name}}\n",
  });
  try {
    const result = await expand(root, "page.md", '::include[s/outer.md]{name="Given"}\n');
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.body, "Outer Given\nInner {{name}}\nAfter Given\n");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("lines slices the body while the declaration still comes from the whole front matter", async () => {
  const root = tree({
    "s/note.md": "---\nparams:\n  who: World\n---\none {{who}}\ntwo {{who}}\nthree\n",
  });
  try {
    const result = await expand(root, "page.md", "::include[s/note.md]{lines=1}\n");
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.body, "one World\n");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("the content-includes fixture expands to the documented two pages", async () => {
  const sourceDir = join(import.meta.dirname, "../../fixtures/content-includes");
  const beacon = await expand(
    sourceDir,
    "guide/beacon.md",
    'Beacon runs on Node 24.\n\n::include[../_snippets/install.md]{support="the *Beacon* team"}\n',
    { bodyLine: 4 },
  );
  assert.deepEqual(beacon.diagnostics, []);
  assert.equal(
    beacon.body,
    `Beacon runs on Node 24.\n\n## Install Beacon\n\nThe Standard edition installs with:\n\n\`\`\`sh\nnpm install @acme/beacon\n\`\`\`\n\n> Upgrades keep the same package name for every edition.\n\nQuestions go to the *Beacon* team. Write \`\\{{product}}\` to show the literal placeholder.\n`,
  );

  const orbit = await expand(
    sourceDir,
    "guide/orbit.md",
    'Orbit runs on Node 24.\n\n::include[../_snippets/install.md]{product="Orbit" package="@acme/orbit" edition="Team" support="the Orbit team"}\n',
    { bodyLine: 4 },
  );
  assert.deepEqual(orbit.diagnostics, []);
  assert.match(orbit.body, /## Install Orbit/);
  assert.match(orbit.body, /The Team edition installs with:/);
  assert.match(orbit.body, /npm install @acme\/orbit/);
  assert.match(orbit.body, /Questions go to the Orbit team\./);
});
