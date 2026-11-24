/**
 * #1357–#1366, the public surface: the `decisions` output writes `decisions.json` and the matrix page from one public
 * projection, and the `mizzen decisions` command reports, gates, applies a policy, and writes to a file.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli/index.ts";
import { buildModel } from "../src/model/build.ts";
import { decisionMatrixHtml, decisionsOutput } from "../src/outputs/decisions.ts";

/** A temporary site holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "decisions-output-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const SITE = {
  "mizzen.yml": "title: Example\ndecisions:\n  dir: docs/decisions\n",
  "index.md": "# Home\n",
  "docs/decisions/0001.md":
    "---\nid: ADR-0001\ntitle: A decision\nstatus: accepted\ndate: 2025-01-10\nsource:\n  value: https://example.test/1\n  public: true\npublic: true\n---\n\n## Decision\n\nDo the thing.\n\n## Rationale\n\nBecause it works.\n\n## Alternatives\n\n- **Other** — rejected because it does not.\n",
};

/** Collects the CLI's stdout and stderr. */
function capture(): { readonly io: { readonly log: (m: string) => void; readonly error: (m: string) => void }; readonly out: string; readonly err: string } {
  const logs: string[] = [];
  const errors: string[] = [];
  const state = { logs, errors };
  return {
    io: { log: (m: string) => state.logs.push(m), error: (m: string) => state.errors.push(m) },
    get out() {
      return state.logs.join("\n");
    },
    get err() {
      return state.errors.join("\n");
    },
  };
}

test("the decisions output writes the report and a matrix page from one projection", async () => {
  const root = tree(SITE);
  try {
    const { site } = await buildModel(root);
    const files = await decisionsOutput.run(site, { report: () => {}, renderPage: async () => "" } as never);
    assert.deepEqual(files.map((file) => file.path), ["decisions.json", "decisions/index.html"]);
    const report = JSON.parse(String(files[0]!.contents)) as { entries: { id: string }[] };
    assert.equal(report.entries[0]?.id, "ADR-0001");
    assert.match(String(files[1]!.contents), /<td>accepted<\/td>/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the output writes nothing without a decisions config or publish false", async () => {
  const root = tree({ "mizzen.yml": "title: T\n", "index.md": "# Home\n" });
  try {
    const { site } = await buildModel(root);
    assert.deepEqual(await decisionsOutput.run(site, { report: () => {} } as never), []);
    const off = { ...site, config: { ...site.config, decisions: { dir: "docs/decisions", publish: false } } };
    assert.deepEqual(await decisionsOutput.run(off, { report: () => {} } as never), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the matrix page escapes text and summarises the counts", () => {
  const html = decisionMatrixHtml(
    [
      {
        id: "ADR-<1>",
        title: "A & B",
        status: "accepted",
        date: "2025-01-01",
        source: "[source withheld]",
        supersedes: [],
        supersededBy: ["ADR-2"],
        validity: {},
        links: [],
        evidence: [],
        alternatives: [],
        redacted: false,
        span: "a.md:1:1-1:1",
      },
    ],
    "Example",
  );
  assert.match(html, /ADR-&lt;1&gt;/);
  assert.match(html, /A &amp; B/);
  assert.match(html, /accepted 1/);
  assert.match(html, /superseded by ADR-2/);
});

test("the CLI gates on a status, writes a file, and applies a policy", async () => {
  const root = tree(SITE);
  const out = join(root, "report.json");
  try {
    const gated = capture();
    const code = await main(["decisions", root, "--fail-on", "accepted"], gated.io);
    assert.equal(code, 1);
    assert.match(gated.err, /1 accepted/);

    const written = capture();
    const ok = await main(["decisions", root, "--json", "--out", out], written.io);
    assert.equal(ok, 0, written.err);
    assert.equal((JSON.parse(readFileSync(out, "utf8")) as { version: number }).version, 1);

    // A policy that closes public read leaves no record in the report.
    const policyPath = join(root, "policy.json");
    writeFileSync(policyPath, JSON.stringify({ version: 1, read: { public: false, audiences: [] } }));
    const scoped = capture();
    const scopedCode = await main(["decisions", root, "--policy", policyPath, "--json"], scoped.io);
    assert.equal(scopedCode, 0, scoped.err);
    assert.equal((JSON.parse(scoped.out) as { entries: unknown[] }).entries.length, 0);

    const bad = capture();
    const badCode = await main(["decisions", root, "--policy", join(root, "missing.json")], bad.io);
    assert.equal(badCode, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI prints help and rejects an unknown option", async () => {
  const help = capture();
  assert.equal(await main(["decisions", "--help"], help.io), 0);
  // `--help` prints the whole command list, which names the decisions command.
  assert.match(help.out, /decisions \[dir\]/);
  const unknown = capture();
  assert.equal(await main(["decisions", "--nope", "x"], unknown.io), 2);
  assert.match(unknown.err, /unknown option: --nope/);
});
