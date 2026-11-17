import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvidenceClaims } from "../../src/data/evidence/validate.ts";
import { applyEvidence, type EvidenceScope } from "../../src/data/evidence/render.ts";

const FIELDS = {
  statement: "Node 18 reaches end of life.",
  eol: "2025-04-30",
  openWorkflows: 1204,
};

const CLAIMS: EvidenceClaims = {
  eol: [
    {
      id: "node-18-schedule",
      title: "Node.js release schedule",
      url: "https://nodejs.org/en/about/previous-releases#release-schedule",
    },
    {
      id: "node-18-announcement",
      title: "Node.js 18 release announcement",
      url: "https://nodejs.org/en/blog/announcements/v18-release-announce",
    },
  ],
  openWorkflows: [
    {
      id: "workflow-inventory",
      title: "Workflow inventory, 2026-03-01",
      url: "https://offing.example.org/runs/2026-03-01/workflows.json",
    },
  ],
};

const SCOPE: EvidenceScope = { record: { id: "ebb-node-18", fields: FIELDS }, file: "_templates/finding.md" };

/** A `:evidence[field]` node as the Markdown parser gives it. */
function directive(field: string) {
  return {
    position: { start: { line: 7, column: 20 }, end: { line: 7, column: 31 + field.length } },
    children: [{ type: "text", value: field }],
  };
}

/** The HTML a result puts in the page. */
function htmlOf(result: ReturnType<typeof applyEvidence>): string {
  return (result.replacement as { readonly value: string }).value;
}

test("each claim renders beside its own field, in list order", () => {
  const eol = applyEvidence(directive("eol"), SCOPE, CLAIMS);
  assert.deepEqual(eol.diagnostics, []);
  assert.equal(
    htmlOf(eol),
    '<a href="https://nodejs.org/en/about/previous-releases#release-schedule">Node.js release schedule</a>, ' +
      '<a href="https://nodejs.org/en/blog/announcements/v18-release-announce">Node.js 18 release announcement</a>',
  );
  assert.doesNotMatch(htmlOf(eol), /workflow-inventory|Workflow inventory/);

  const workflows = applyEvidence(directive("openWorkflows"), SCOPE, CLAIMS);
  assert.equal(
    htmlOf(workflows),
    '<a href="https://offing.example.org/runs/2026-03-01/workflows.json">Workflow inventory, 2026-03-01</a>',
  );
  assert.doesNotMatch(htmlOf(workflows), /Node\.js release schedule/);
});

test("the label is the readable title, and the id stays out of the page", () => {
  const result = applyEvidence(directive("eol"), SCOPE, CLAIMS);
  const html = htmlOf(result);
  assert.match(html, />Node\.js release schedule<\/a>/);
  assert.doesNotMatch(html, /node-18-schedule|node-18-announcement/);
  assert.equal(result.twin.includes("[Node.js release schedule](https://nodejs.org/en/about/previous-releases#release-schedule)"), true);
});

test("a page without evidence writes nothing", () => {
  const result = applyEvidence(directive("eol"), SCOPE, {});
  assert.equal(result.replacement, undefined);
  assert.equal(result.twin, "");
  assert.deepEqual(result.diagnostics, []);

  const emptyList = applyEvidence(directive("openWorkflows"), SCOPE, { openWorkflows: [] });
  assert.equal(emptyList.replacement, undefined);
  assert.equal(emptyList.twin, "");
  assert.deepEqual(emptyList.diagnostics, []);
});

test("a field the record does not have is unknown, as with :field", () => {
  const result = applyEvidence(directive("missing"), SCOPE, CLAIMS);
  assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.id), ["data.unknown-field"]);
  assert.equal(result.diagnostics[0]!.pos?.file, "_templates/finding.md");
  assert.equal(result.diagnostics[0]!.pos?.line, 7);
  assert.equal(result.twin, ":evidence[missing]");
  assert.match(htmlOf(result), /^:evidence\[missing\]$/);
});

test("a title with HTML characters stays text, and a query URL stays one attribute", () => {
  const claims: EvidenceClaims = {
    eol: [{ id: "a&b", title: "A & B <C>", url: "/reports/2026-03.json?kind=date&lang=en" }],
  };
  const html = htmlOf(applyEvidence(directive("eol"), SCOPE, claims));
  assert.equal(html, '<a href="/reports/2026-03.json?kind=date&amp;lang=en">A &amp; B &lt;C&gt;</a>');
});
