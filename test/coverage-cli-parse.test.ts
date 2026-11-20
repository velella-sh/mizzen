/** CLI parsing branches: data extract/refresh, unexpected arguments, and invalid flag values. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseArgs, resolveThemeRoot } from "../src/cli/index.ts";

/** The options of a parse that succeeded. */
function options(args: readonly string[]): Record<string, unknown> {
  const parsed = parseArgs(args);
  assert.ok("options" in parsed, JSON.stringify(parsed));
  return parsed.options as Record<string, unknown>;
}

/** The error of a parse that failed. */
function error(args: readonly string[]): string {
  const parsed = parseArgs(args);
  assert.ok("error" in parsed, JSON.stringify(parsed));
  return parsed.error;
}

test("parseArgs: data extract accepts a folder and --check, and refuses bad input", () => {
  assert.deepEqual(options(["data", "extract"]), { command: "data-extract", root: ".", check: false });
  assert.deepEqual(options(["data", "extract", "site", "--check"]), {
    command: "data-extract",
    root: "site",
    check: true,
  });
  assert.match(error(["data", "extract", "--nope"]), /unknown option: --nope/);
  assert.match(error(["data", "extract", "a", "b"]), /unexpected argument: b/);
});

test("parseArgs: data refresh requires --report and reads collections", () => {
  assert.match(error(["data", "refresh"]), /data refresh needs --report/);
  assert.deepEqual(options(["data", "refresh", "site", "--report", "r.json", "--json"]), {
    command: "data-refresh",
    root: "site",
    report: "r.json",
    json: true,
  });
  assert.deepEqual(options(["data", "refresh", "--report", "r.json", "--collections", "a, b,a,, c"]), {
    command: "data-refresh",
    root: ".",
    report: "r.json",
    json: false,
    collections: ["a", "b", "c"],
  });
  assert.match(error(["data", "refresh", "--report"]), /--report needs a value/);
  assert.match(error(["data", "refresh", "--report", "-"]), /--report needs a value/);
  assert.match(error(["data", "refresh", "--report", "  "]), /--report needs a value/);
  assert.match(error(["data", "refresh", "--collections", " ", "--report", "r"]), /--collections needs a value/);
  assert.match(error(["data", "refresh", "--report", "r", "--collections", " , "]), /at least one collection name/);
  assert.match(error(["data", "refresh", "--report", "r", "--nope"]), /unknown option: --nope/);
  assert.match(error(["data", "refresh", "a", "b", "--report", "r"]), /unexpected argument: b/);
});

test("parseArgs: unexpected extra positionals are refused across data subcommands", () => {
  assert.match(error(["data", "verify", "a", "b"]), /unexpected argument: b/);
  assert.match(error(["data", "quality", "a", "b"]), /unexpected argument: b/);
  assert.match(error(["data", "snapshot", "name", "a", "b"]), /unexpected argument: b/);
  assert.match(error(["data", "schema", "a", "b"]), /unexpected argument: b/);
  assert.match(error(["data", "fetch", "a", "b"]), /unexpected argument: b/);
  assert.match(error(["data", "transform", "a", "b", "c"]), /unexpected argument: c/);
  assert.match(error(["data", "changes", "--from"]), /--from needs a git ref or a folder/);
  assert.match(error(["data", "changes", "a", "b", "c"]), /unexpected argument: c/);
});

test("parseArgs: data quality validates --as-of and data transform validates --limit", () => {
  assert.deepEqual(options(["data", "quality", "site", "--json", "--write", "--as-of", "2026-01-01"]), {
    command: "data-quality",
    root: "site",
    json: true,
    write: true,
    asOf: "2026-01-01",
  });
  assert.match(error(["data", "quality", "--as-of"]), /--as-of needs a value/);
  assert.match(error(["data", "quality", "--as-of", "not-a-date"]), /--as-of/);
  assert.match(error(["data", "transform", "a", "b", "--limit", "0"]), /--limit needs a whole number/);
  assert.match(error(["data", "transform", "--limit", "x"]), /--limit needs a whole number/);
});

test("parseArgs: init, urls, api, import, and mcp refuse unexpected arguments", () => {
  assert.match(error(["init", "a", "b", "--list"]), /unexpected argument: b/);
  assert.match(error(["urls", "check", "a", "b"]), /unexpected argument: b/);
  assert.match(error(["api", "check", "a", "b", "--against", "x"]), /unexpected argument: b/);
  assert.match(error(["import", "mkdocs", "a", "b"]), /unexpected argument: b/);
  assert.match(error(["mcp", "a", "b"]), /unexpected argument: b/);

  assert.deepEqual(options(["api", "check", "--against", "x", "--theme", "t"]), {
    command: "api-check",
    root: ".",
    against: "x",
    theme: "t",
  });
  assert.deepEqual(options(["import", "mkdocs", "site", "--out", "o", "--fail-on-manual", "--allow", "a,b"]), {
    command: "import",
    name: "mkdocs",
    root: "site",
    out: "o",
    failOnManual: true,
    allow: ["a", "b"],
  });
});

test("parseArgs: mcp validates policy and print-config values", () => {
  assert.match(error(["mcp", "--policy"]), /--policy needs a file/);
  assert.match(error(["mcp", "--theme"]), /--theme needs a value/);
  assert.match(error(["mcp", "--print-config"]), /--print-config needs a value/);
  assert.match(error(["mcp", "--print-config", "nope"]), /--print-config must be one of/);
  assert.match(error(["mcp", "--nope"]), /unknown option for mcp: --nope/);
  const parsed = options(["mcp", "site", "--theme", "t", "--policy", "p.json", "--allow-edits"]);
  assert.equal(parsed.command, "mcp");
  assert.equal(parsed.allowEdits, true);
});

test("parseArgs: diff validates every flag and needs two folders or --base", () => {
  assert.match(error(["diff"]), /diff needs two built folders/);
  assert.match(error(["diff", "a", "b", "--format", "xml"]), /--format for diff must be text, json, or markdown/);
  assert.match(error(["diff", "a", "b", "--fail-on", "nope"]), /--fail-on/);
  assert.match(error(["diff", "a", "b", "--change-type", "nope"]), /--change-type/);
  assert.match(error(["diff", "a", "b", "--max-entries", "0"]), /--max-entries must be a positive whole number/);
  assert.match(error(["diff", "a", "b", "--max-entries", "x"]), /--max-entries/);
  assert.match(error(["diff", "a", "b", "--base"]), /--base needs a value/);
  assert.match(error(["diff", "--base", "main", "a", "b"]), /diff --base takes at most one site folder/);
  assert.match(error(["diff", "a", "b", "--nope"]), /unknown option: --nope/);
  const parsed = options([
    "diff", "a", "b", "--format", "markdown", "--fail-on", "broken-urls", "--change-type", "added",
    "--max-entries", "5", "--link-base", "https://x.test", "--theme", "t",
  ]);
  assert.equal(parsed.command, "diff");
  assert.equal(parsed.maxEntries, 5);
  assert.equal(parsed.base, undefined);
  assert.deepEqual(options(["diff", "--base", "main"]).dirs, ["."]);
});

test("parseArgs: reproduce reads its flags and refuses bad input", () => {
  assert.match(error(["reproduce"]), /reproduce needs a report/);
  assert.match(error(["reproduce", "r.json", "--format", "yaml"]), /--format for reproduce must be text or json/);
  assert.match(error(["reproduce", "r.json", "--nope"]), /unknown option for reproduce: --nope/);
  assert.match(error(["reproduce", "r.json", "a", "b"]), /unexpected argument: b/);
  assert.match(error(["reproduce", "r.json", "--out"]), /--out needs a value/);
  const parsed = options(["reproduce", "r.json", "site", "--out", "o", "--theme", "t", "--check", "--format", "json"]);
  assert.deepEqual(parsed, {
    command: "reproduce",
    manifest: "r.json",
    root: "site",
    out: "o",
    check: true,
    format: "json",
    theme: "t",
  });
});

test("parseArgs: compare needs two reports and validates --format", () => {
  assert.match(error(["compare"]), /compare needs two build reports/);
  assert.match(error(["compare", "a", "b", "--format"]), /--format needs a value/);
  assert.match(error(["compare", "a", "b", "--format", "yaml"]), /--format for compare must be text or json/);
  assert.match(error(["compare", "a", "b", "--nope"]), /unknown option for compare: --nope/);
  assert.deepEqual(options(["compare", "a", "b", "--format", "json"]), {
    command: "compare",
    before: "a",
    after: "b",
    format: "json",
  });
});

test("parseArgs: readiness rejects a bad score, unknown section, and two built folders", () => {
  assert.match(error(["readiness", "--format", "yaml"]), /--format for readiness must be text or json/);
  assert.match(error(["readiness", "--min", "speed"]), /--min needs <section>=<score>/);
  assert.match(error(["readiness", "--min", "speed=90"]), /--min names speed/);
  assert.match(error(["readiness", "--min", "context=101"]), /--min must be a score from 0 to 100/);
  assert.match(error(["readiness", "--min-overall", "-1"]), /--min-overall needs a value/);
  assert.match(error(["readiness", "a", "b"]), /unexpected argument: b/);
  assert.match(error(["readiness", "dist", "--built", "other"]), /readiness takes one built folder/);
  const parsed = options(["readiness", "dist", "--min", "context=90", "--min-overall", "80.5"]);
  assert.equal(parsed.command, "readiness");
  assert.equal(parsed.minOverall, 80.5);
});

test("parseArgs: edit subcommands validate their required file and flags", () => {
  assert.match(error(["edit", "apply"]), /edit apply needs a patch file/);
  assert.match(error(["edit", "apply", "p.json", "--format", "yaml"]), /--format for edit apply must be text or json/);
  assert.match(error(["edit", "apply", "p.json", "--nope"]), /unknown option: --nope/);
  assert.match(error(["edit", "apply", "p.json", "a", "b"]), /unexpected argument: b/);
  assert.match(error(["edit", "apply", "p.json", "--proof"]), /--proof needs a value/);

  assert.match(error(["edit", "transaction"]), /edit transaction needs a file/);
  assert.match(error(["edit", "transaction", "t.json", "--format", "yaml"]), /--format for edit transaction/);
  assert.match(error(["edit", "transaction", "t.json", "a", "b"]), /unexpected argument: b/);
  assert.match(error(["edit", "transaction", "t.json", "--receipt"]), /--receipt needs a value/);

  assert.match(error(["edit", "rollback"]), /edit rollback needs a receipt/);
  assert.match(error(["edit", "rollback", "r.json", "--format", "yaml"]), /--format for edit rollback/);
  assert.match(error(["edit", "rollback", "r.json", "a", "b"]), /unexpected argument: b/);

  assert.match(error(["edit", "verify"]), /edit verify needs a proof file/);
  assert.match(error(["edit", "verify", "p.json", "--format", "yaml"]), /--format for edit verify/);
  assert.match(error(["edit", "verify", "p.json", "extra"]), /unexpected argument: extra/);
  assert.match(error(["edit", "verify", "p.json", "--site"]), /--site needs a value/);

  assert.equal(options(["edit", "transaction", "t.json", "--dry-run", "--rebase", "--approve"]).rebase, true);
  assert.equal(options(["edit", "verify", "p.json", "--doctor", "--input", "i.json"]).doctor, true);
});

test("parseArgs: graph and other pass-through commands document their own help", () => {
  for (const command of ["graph", "versions", "reference-s", "inputs", "trace", "eval", "agent", "stale"]) {
    const name = command === "reference-s" ? "references" : command;
    assert.deepEqual(parseArgs([name, "--help"]), { help: true }, name);
  }
});

test("parseArgs: build and check flags are validated at parse time", () => {
  assert.match(error(["build", "--nope"]), /unknown option: --nope/);
  assert.equal(options(["build", "--update-urls", "--report", "--diagnose", "--update-blocks"]).command, "build");
  assert.match(error(["build", "--base"]), /--base needs a value/);
  assert.match(error(["check", "--update-urls"]), /--update-urls is only valid for build/);
  assert.match(error(["build", "--preview-canonical", "ftp://x"]), /--preview-canonical must be an absolute http/);
  assert.match(error(["build", "--baseline", "  "]), /--baseline needs a folder/);
  assert.match(error(["build", "--commit", "  "]), /--commit needs a value/);
  assert.match(error(["build", "a", "b"]), /unexpected argument: b/);
  assert.match(error(["check", "--format", "yaml"]), /--format must be text, json, or sarif/);
  assert.match(error(["build", "--as-of", "someday"]), /--as-of/);
});

test("resolveThemeRoot: a relative config theme.name resolves from the site root", async () => {
  const root = mkdtempSync(join(tmpdir(), "coverage-theme-"));
  try {
    writeFileSync(join(root, "mizzen.yml"), "title: Demo\ntheme:\n  name: ./theme\n");
    mkdirSync(join(root, "theme"));
    assert.equal(await resolveThemeRoot(root, undefined), join(root, "theme"));
    assert.equal(await resolveThemeRoot(root, "custom"), join(process.cwd(), "custom"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
