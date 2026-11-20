/** CLI dispatch branches: command wiring, early errors, and failure paths through `main`. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli/index.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "coverage-dispatch-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function capture() {
  const writes: string[] = [];
  const errors: string[] = [];
  const logs: string[] = [];
  return {
    writes,
    errors,
    logs,
    io: {
      write: (text: string) => {
        writes.push(text);
      },
      error: (message: string) => {
        errors.push(message);
      },
      log: (message: string) => {
        logs.push(message);
      },
    },
  };
}

function site(extra: Record<string, string> = {}): string {
  return tree({
    "mizzen.yml": "title: Demo\n",
    "page.md": "# Page\n\nInstall the engine with Node 24.\n",
    ...extra,
  });
}

test("compare reports an unreadable report instead of throwing", async () => {
  const root = site();
  try {
    const c = capture();
    assert.equal(await main(["compare", join(root, "a.json"), join(root, "b.json")], c.io), 2);
    assert.match(c.errors.join("\n"), /cannot be read/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("urls and graph report a site that cannot be read", async () => {
  const missing = join(tmpdir(), "coverage-no-such-site");
  const urls = capture();
  assert.equal(await main(["urls", "check", missing], urls.io), 2);
  assert.match(urls.errors.join("\n"), /ENOENT/);

  const graph = capture();
  assert.equal(await main(["graph", missing, "--from", "page:x"], graph.io), 2);
  assert.match(graph.errors.join("\n"), /ENOENT/);
});

test("pack --out names a path it cannot create", async () => {
  const root = site({
    "request.json": JSON.stringify({ version: 1, task: { goal: "install" }, budget: { maxTokens: 800 } }),
  });
  try {
    const c = capture();
    assert.equal(
      await main(["pack", root, "--request", join(root, "request.json"), "--out", join(root, "mizzen.yml", "pack.md")], c.io),
      2,
    );
    assert.deepEqual(c.writes, []);
    assert.match(c.errors.join("\n"), /EEXIST|ENOTDIR/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mcp prints a client config without serving", async () => {
  const root = site();
  try {
    const c = capture();
    assert.equal(await main(["mcp", root, "--print-config", "claude-code"], c.io), 0);
    assert.equal(c.writes.length, 1);
    assert.match(c.writes[0]!, /mizzen/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mcp refuses a missing theme and reports a site it cannot open", async () => {
  const root = tree({ "mizzen.yml": "title: Demo\ntheme:\n  name: definitely-missing-theme-package\n" });
  try {
    const noTheme = capture();
    assert.equal(await main(["mcp", root], noTheme.io), 2);
    assert.match(noTheme.errors.join("\n"), /no theme found/);

    const badRoot = capture();
    assert.equal(await main(["mcp", join(tmpdir(), "coverage-no-such-site")], badRoot.io), 2);
    assert.match(badRoot.errors.join("\n"), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mcp refuses an access policy that cannot be read", async () => {
  const root = site();
  try {
    const c = capture();
    assert.equal(await main(["mcp", root, "--theme", root, "--policy", join(root, "absent.json")], c.io), 2);
    assert.match(c.errors.join("\n"), /cannot read the access policy/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("references reports a file it cannot read", async () => {
  const root = site();
  try {
    const c = capture();
    assert.equal(await main(["references", "check", join(root, "absent.json")], c.io), 2);
    assert.match(c.errors.join("\n"), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("init --list and import name their result without a theme", async () => {
  const root = site();
  try {
    const init = capture();
    assert.equal(await main(["init", root, "--list"], init.io), 0);
    assert.ok(init.logs.length > 0, "init lists the starters");

    const imported = capture();
    const code = await main(["import", "mkdocs", root], imported.io);
    assert.equal(code, 1);
    assert.ok(imported.logs.length > 0 || imported.errors.length > 0, "the import says why it cannot proceed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("edit apply, transaction, rollback, and verify refuse bad input", async () => {
  const root = site();
  try {
    const apply = capture();
    assert.equal(await main(["edit", "apply", join(root, "p.json"), "--policy", join(root, "absent.json")], apply.io), 2);
    assert.match(apply.errors.join("\n"), /cannot read the access policy/);

    const transactionPolicy = capture();
    assert.equal(
      await main(["edit", "transaction", join(root, "t.json"), "--policy", join(root, "absent.json")], transactionPolicy.io),
      2,
    );
    assert.match(transactionPolicy.errors.join("\n"), /cannot read the access policy/);

    const transaction = capture();
    assert.equal(await main(["edit", "transaction", join(root, "t.json"), root], transaction.io), 2);
    assert.match(transaction.errors.join("\n"), /cannot read the transaction/);

    const rollback = capture();
    assert.equal(await main(["edit", "rollback", join(root, "r.json")], rollback.io), 2);
    assert.match(rollback.errors.join("\n"), /receipt/);

    const verify = capture();
    assert.equal(await main(["edit", "verify", join(root, "proof.json")], verify.io), 2);
    assert.match(verify.errors.join("\n"), /not a valid proof/);

    const verifyJson = capture();
    assert.equal(await main(["edit", "verify", join(root, "proof.json"), "--format", "json"], verifyJson.io), 2);
    assert.equal(verifyJson.writes.length, 0);
    assert.equal(verifyJson.logs.length, 1);
    JSON.parse(verifyJson.logs[0]!);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verify reports a missing built folder", async () => {
  const root = site();
  try {
    const c = capture();
    assert.equal(await main(["verify", join(root, "dist")], c.io), 1);
    assert.match(c.errors.join("\n"), /is not a folder/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("data commands reach their implementation and report a file that is not a site", async () => {
  const root = site();
  const file = join(root, "page.md");
  try {
    const refresh = capture();
    assert.equal(await main(["data", "refresh", root, "--report", join(root, "r.json"), "--json"], refresh.io), 0);
    assert.match(refresh.writes.join("\n"), /collections/);

    const verify = capture();
    assert.equal(await main(["data", "verify", root], verify.io), 0);

    const schema = capture();
    assert.equal(await main(["data", "schema", root, "--format", "json"], schema.io), 0);
    assert.ok(schema.writes[0]!.startsWith("{"));

    const quality = capture();
    assert.equal(await main(["data", "quality", root], quality.io), 0);

    for (const [args, message] of [
      [["data", "snapshot", "x", root], /collection/i],
      [["data", "changes", root], /collection/i],
      [["data", "transform", root], /collection/i],
      [["data", "explain", "c", "i", root, "--field", "f"], /collection/i],
      [["data", "migrate", file], /collection|baseline/i],
      [["data", "transform-diff", join(root, "a.yml"), join(root, "b.yml"), root], /baseline/i],
    ] as const) {
      const c = capture();
      const code = await main(args as unknown as string[], c.io);
      assert.notEqual(code, 0, String(args));
      assert.match(c.errors.join("\n"), message);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor reports a site it cannot read", async () => {
  const root = site();
  try {
    const c = capture();
    assert.equal(await main(["doctor", join(root, "page.md")], c.io), 2);
    assert.match(c.errors.join("\n"), /ENOTDIR|ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reproduce reports a report it cannot read", async () => {
  const root = site();
  try {
    const c = capture();
    assert.equal(await main(["reproduce", join(root, "report.json"), root, "--theme", root], c.io), 2);
    assert.match(c.errors.join("\n"), /cannot be read/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("build reports an output folder it cannot create", async () => {
  const root = site();
  try {
    const c = capture();
    assert.equal(await main(["build", root, "--theme", root, "--out", join(root, "mizzen.yml")], c.io), 2);
    assert.match(c.errors.join("\n"), /output folder|ENOTDIR|EEXIST/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
