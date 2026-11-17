import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config/load.ts";
import { main, parseArgs } from "../src/cli/index.ts";
import { checkAsOf, missingAsOf, readAsOfFlag, resolveAsOf, todayOf } from "../src/dates/as-of.ts";
import { buildModel } from "../src/model/build.ts";

function site(config: string): string {
  const root = mkdtempSync(join(tmpdir(), "as-of-"));
  writeFileSync(join(root, "mizzen.yml"), config);
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "index.md"), "---\ntitle: Home\n---\n\nHello\n");
  return root;
}

test("the flag wins over the key, and neither set gives none", () => {
  assert.deepEqual(resolveAsOf("2026-05-01", "2026-01-01"), { date: "2026-05-01", source: "flag" });
  assert.deepEqual(resolveAsOf(undefined, "2026-01-01"), { date: "2026-01-01", source: "config" });
  assert.equal(resolveAsOf(undefined, undefined), undefined);
});

test("a flag value is a real day or today", () => {
  assert.deepEqual(readAsOfFlag("2026-02-28", () => assert.fail("no clock")), { ok: true, date: "2026-02-28", today: false });
  assert.equal(readAsOfFlag("2026-02-30", () => "x").ok, false);
  assert.equal(readAsOfFlag("2026-02", () => "x").ok, false);
  assert.equal(readAsOfFlag("tomorrow", () => "x").ok, false);
  assert.deepEqual(readAsOfFlag("today", () => "2030-01-02"), { ok: true, date: "2030-01-02", today: true });
  assert.equal(checkAsOf("2024-02-29"), undefined);
});

test("todayOf writes the local calendar date of a faked clock", () => {
  assert.equal(todayOf(new Date(2026, 10, 5, 23, 59)), "2026-11-05");
  assert.equal(todayOf(new Date(2026, 0, 1, 0, 0)), "2026-01-01");
});

test("a missing date is reported at the place that needs it", () => {
  const pos = { file: "a.md", line: 3, column: 2, endLine: 3, endColumn: 9 };
  const d = missingAsOf("The derived value `daysLeft`", pos);
  assert.equal(d.id, "dates.no-as-of");
  assert.equal(d.severity, "error");
  assert.deepEqual(d.pos, pos);
  assert.match(d.message, /needs an as-of date/);
  assert.match(d.help ?? "", /--as-of/);
});

test("parseArgs takes --as-of for build, check, and watch only", () => {
  assert.deepEqual(parseArgs(["build", "--as-of", "2026-05-01"]), {
    options: { command: "build", root: ".", out: "dist", asOf: "2026-05-01" },
  });
  const check = parseArgs(["check", "--as-of", "today"]);
  assert.ok("options" in check && check.options.command === "check" && check.options.asOf === "today");
  const watch = parseArgs(["watch", "--as-of", "2026-05-01"]);
  assert.ok("options" in watch && watch.options.command === "watch" && watch.options.asOf === "2026-05-01");
  assert.ok("error" in parseArgs(["verify", "--as-of", "2026-05-01"]));
  assert.ok("error" in parseArgs(["build", "--as-of", "2026-02-30"]));
  assert.ok("error" in parseArgs(["build", "--as-of"]));
});

test("the config key and the dates calendar load; a bad day is reported at the key", () => {
  const good = loadConfig(site("asOf: 2026-05-01\ndates:\n  calendar: jalali\n"));
  assert.deepEqual(good.diagnostics, []);
  assert.equal(good.config.asOf, "2026-05-01");
  assert.equal(good.config.dates?.calendar, "jalali");

  const none = loadConfig(site("title: X\n"));
  assert.equal(none.config.asOf, undefined);
  assert.equal(none.config.dates, undefined);

  const impossible = loadConfig(site("asOf: 2026-02-30\n"));
  const d = impossible.diagnostics.find((x) => x.id === "config.as-of");
  assert.ok(d);
  assert.equal(d.pos?.line, 1);
  assert.equal(impossible.config.asOf, undefined);

  const shape = loadConfig(site("asOf: 2026-05\ndates:\n  calendar: hijri\n"));
  assert.ok(shape.diagnostics.length >= 2);
});

test("the model carries the flag over the key", async () => {
  const root = site("asOf: 2026-01-01\n");
  const withKey = await buildModel(root);
  assert.equal(withKey.site.config.asOf, "2026-01-01");
  const withFlag = await buildModel(root, { asOf: "2026-05-01" });
  assert.equal(withFlag.site.config.asOf, "2026-05-01");
});

test("--as-of today reads the faked clock once and prints the date", async () => {
  const root = site("title: X\n");
  const errors: string[] = [];
  let reads = 0;
  const code = await main(["check", root, "--as-of", "today", "--format", "json"], {
    log: () => {},
    error: (m) => errors.push(m),
    now: () => {
      reads += 1;
      return new Date(2031, 2, 9, 12);
    },
  });
  assert.equal(reads, 1);
  assert.ok(errors.some((m) => m.includes("as-of date 2031-03-09 (today)")), errors.join("\n"));
  assert.ok(code === 0 || code === 1);
});

test("a fixed --as-of never reads the clock", async () => {
  const root = site("title: X\n");
  await main(["check", root, "--as-of", "2031-03-09"], {
    log: () => {},
    error: () => {},
    now: () => assert.fail("the clock was read"),
  });
});
