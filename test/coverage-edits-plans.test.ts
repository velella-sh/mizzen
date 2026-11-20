import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Site } from "../src/contracts/index.ts";
import { applyPatch, type PatchSpan } from "../src/edits/patch.ts";
import { planCodeFenceEdit, planLinkEdit, TargetPlanError } from "../src/edits/target-plans.ts";
import { buildModel } from "../src/model/build.ts";

/** Writes a throwaway site, reads its model, and removes the tree again. */
async function siteOf(files: Record<string, string>): Promise<Site> {
  const root = mkdtempSync(join(tmpdir(), "coverage-target-plans-"));
  try {
    const all = "mizzen.yml" in files ? files : { "mizzen.yml": "title: T\n", ...files };
    for (const [path, text] of Object.entries(all)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return (await buildModel(root)).site;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A source span in `guide.md`. */
function span(line: number, column: number, endLine: number, endColumn: number): PatchSpan {
  return { file: "guide.md", line, column, endLine, endColumn };
}

/** The span of the whole source, which every single-block fixture starts at column 1. */
function whole(source: string): PatchSpan {
  const lines = source.replace(/\n$/, "").split("\n");
  return span(1, 1, lines.length, Array.from(lines.at(-1) ?? "").length);
}

/** The refusal a plan must raise, by code. */
function refused(code: TargetPlanError["code"]): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof TargetPlanError, `expected a TargetPlanError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

test("an unknown page and an autolink are refused without guessing a destination", async () => {
  const source = "See <https://example.com/a> now\n";
  const site = await siteOf({ "guide.md": source });
  assert.throws(
    () => planLinkEdit({ site, source, url: "/nope/", target: span(1, 5, 1, 27), newDestination: "/x" }),
    refused("edit.unknown-page"),
  );
  assert.throws(
    () => planLinkEdit({ site, source, url: "/guide/", target: span(1, 5, 1, 27), newDestination: "/x" }),
    refused("edit.source-mismatch"),
  );
});

test("an escaped angle destination and a nested-parenthesis destination are located", async () => {
  const escaped = "See [a](<../x\\>y.md>) now\n";
  const escapedSite = await siteOf({ "guide.md": escaped });
  const angled = planLinkEdit({
    site: escapedSite,
    source: escaped,
    url: "/guide/",
    target: span(1, 5, 1, 21),
    newDestination: "/new/",
  });
  assert.equal(angled.expected, "../x\\>y.md");
  assert.equal(applyPatch(escaped, angled), "See [a](</new/>) now\n");

  const nested = "See [a](../x(y).md) now\n";
  const nestedSite = await siteOf({ "guide.md": nested });
  const parentheses = planLinkEdit({
    site: nestedSite,
    source: nested,
    url: "/guide/",
    target: span(1, 5, 1, 19),
    newDestination: "/new/",
  });
  assert.equal(parentheses.expected, "../x(y).md");
  assert.equal(applyPatch(nested, parentheses), "See [a](/new/) now\n");
});

test("a quoted title and a parenthesized title are skipped to find the destination", async () => {
  const quoted = 'See [a](../x.md "t\\"x") now\n';
  const quotedSite = await siteOf({ "guide.md": quoted });
  const withQuote = planLinkEdit({
    site: quotedSite,
    source: quoted,
    url: "/guide/",
    target: span(1, 5, 1, 23),
    newDestination: "/new/",
  });
  assert.equal(withQuote.expected, "../x.md");
  assert.equal(applyPatch(quoted, withQuote), 'See [a](/new/ "t\\"x") now\n');

  const parenthesized = "See [a](../x.md (title)) now\n";
  const parenthesizedSite = await siteOf({ "guide.md": parenthesized });
  const withTitle = planLinkEdit({
    site: parenthesizedSite,
    source: parenthesized,
    url: "/guide/",
    target: span(1, 5, 1, 24),
    newDestination: "/new/",
  });
  assert.equal(withTitle.expected, "../x.md");
  assert.equal(applyPatch(parenthesized, withTitle), "See [a](/new/ (title)) now\n");
});

test("a link definition's angle and nested-parenthesis destinations are located", async () => {
  const escaped = "[d]: <../a\\>b.md>\n";
  const escapedSite = await siteOf({ "guide.md": escaped });
  const angled = planLinkEdit({
    site: escapedSite,
    source: escaped,
    url: "/guide/",
    target: whole(escaped),
    newDestination: "/d/",
  });
  assert.equal(angled.expected, "../a\\>b.md");
  assert.equal(applyPatch(escaped, angled), "[d]: </d/>\n");

  const nested = "[d]: ../a(b).md\n";
  const nestedSite = await siteOf({ "guide.md": nested });
  const parentheses = planLinkEdit({
    site: nestedSite,
    source: nested,
    url: "/guide/",
    target: whole(nested),
    newDestination: "/d/",
  });
  assert.equal(parentheses.expected, "../a(b).md");
  assert.equal(applyPatch(nested, parentheses), "[d]: /d/\n");
});

test("a heading is not a link or a fence, and a partial code target is a mismatch", async () => {
  const source = "## Heading\n";
  const site = await siteOf({ "guide.md": source });
  assert.throws(
    () => planLinkEdit({ site, source, url: "/guide/", target: whole(source), newDestination: "/x" }),
    refused("edit.source-mismatch"),
  );
  assert.throws(
    () => planCodeFenceEdit({ site, source, url: "/guide/", target: whole(source), newBody: "x" }),
    refused("edit.source-mismatch"),
  );
  assert.throws(
    () => planCodeFenceEdit({ site, source, url: "/guide/", target: span(1, 2, 1, 5), newBody: "x" }),
    refused("edit.source-mismatch"),
  );
});

test("an empty fence at end of file gains a body without losing its final code point", async () => {
  const source = "Intro\n\n```😀";
  const site = await siteOf({ "guide.md": source });
  const added = planCodeFenceEdit({
    site,
    source,
    url: "/guide/",
    target: span(3, 1, 3, 4),
    newBody: "x",
  });
  assert.equal(added.expected, "😀");
  assert.equal(added.replacement, "😀\nx");
  assert.equal(applyPatch(source, added), "Intro\n\n```😀\nx");

  const plain = "Intro\n\n```ts";
  const plainSite = await siteOf({ "guide.md": plain });
  const empty = planCodeFenceEdit({
    site: plainSite,
    source: plain,
    url: "/guide/",
    target: span(3, 1, 3, 5),
    newBody: "",
  });
  assert.equal(empty.expected, "s");
  assert.equal(empty.replacement, "s");
});

test("removing a fence body leaves only the two fence lines", async () => {
  const source = "```ts\nbody\n```\n";
  const site = await siteOf({ "guide.md": source });
  const cleared = planCodeFenceEdit({
    site,
    source,
    url: "/guide/",
    target: whole(source),
    newBody: "",
  });
  assert.equal(cleared.expected, "\nbody\n");
  assert.equal(cleared.replacement, "\n");
});

test("a fenced block inside a blockquote cannot be re-read as a plain fence", async () => {
  const source = "> ```\n> x\n> ```\n";
  const site = await siteOf({ "guide.md": source });
  assert.throws(
    () =>
      planCodeFenceEdit({
        site,
        source,
        url: "/guide/",
        target: span(1, 3, 3, 5),
        newBody: "y",
      }),
    refused("edit.source-mismatch"),
  );
});
