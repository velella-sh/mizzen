import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { AuthoringSurfaceItem } from "../src/contracts/authoring.ts";
import type { SurfaceItem } from "../src/contracts/surface.ts";
import { locationConflicts, proposeLocation } from "../src/authoring/location.ts";
import { cleanup, copyFixture, onlyTask, reportOf, tasksOf } from "./authoring-fixture.ts";

/** The task's own view of a report item. */
function surfaceOf(item: SurfaceItem): AuthoringSurfaceItem {
  return {
    id: item.id,
    area: item.area,
    kind: item.kind,
    name: item.name,
    stability: item.stability,
    source: item.source,
    ...(item.signature === undefined ? {} : { signature: item.signature }),
    introduced: item.version?.introduced ?? "unknown",
  };
}

test("#1413 a proposed page has a stable URL, block id, and navigation placement", async () => {
  const root = copyFixture();
  try {
    const { tasks } = await tasksOf(root, { items: ["symbol:parseWidget"] });
    const task = onlyTask(tasks);
    assert.deepEqual(task.location, {
      url: "/reference/parse-widget/",
      source: "docs/reference/parse-widget.md",
      block: "parse-widget",
      nav: { list: "docs", title: "parseWidget", parent: "Reference", after: "documented" },
    });
    assert.deepEqual(task.conflicts, []);
  } finally {
    cleanup(root);
  }
});

test("#1413 an existing URL is rejected as a slug conflict", async () => {
  const root = copyFixture();
  try {
    mkdirSync(join(root, "docs/reference"), { recursive: true });
    writeFileSync(
      join(root, "docs/reference/parse-widget.md"),
      "---\ntitle: parseWidget\npermalink: /reference/parse-widget/\n---\n\n# parseWidget {#parse-widget}\n\n`parseWidget` exists.\n",
    );
    const { site, report } = await reportOf(root);
    const raw = report.items.find((item) => item.id === "symbol:parseWidget");
    assert.ok(raw !== undefined);
    const location = proposeLocation(surfaceOf(raw), "reference", site);
    const conflicts = locationConflicts(location, site);
    assert.ok(conflicts.some((conflict) => conflict.kind === "slug" && conflict.value === "/reference/parse-widget/"));
  } finally {
    cleanup(root);
  }
});

test("#1413 an existing block id is rejected before writing", async () => {
  const root = copyFixture();
  try {
    writeFileSync(
      join(root, "docs/other.md"),
      "---\ntitle: Other\n---\n\n# Other {#parse-widget}\n\nA different page owns this block.\n",
    );
    const { site, report } = await reportOf(root);
    const raw = report.items.find((item) => item.id === "symbol:parseWidget");
    assert.ok(raw !== undefined);
    const location = proposeLocation(surfaceOf(raw), "reference", site);
    const conflicts = locationConflicts(location, site);
    assert.ok(conflicts.some((conflict) => conflict.kind === "block" && conflict.value === "parse-widget"));
  } finally {
    cleanup(root);
  }
});

test("#1413 an existing navigation URL is rejected", async () => {
  const root = copyFixture();
  try {
    writeFileSync(
      join(root, "_data/navigation.yml"),
      [
        "docs:",
        "  - title: Documentation",
        "    url: /docs/",
        "  - title: Reference",
        "    children:",
        "      - title: parseWidget",
        "        url: /reference/parse-widget/",
        "",
      ].join("\n"),
    );
    const { site, report } = await reportOf(root);
    const raw = report.items.find((item) => item.id === "symbol:parseWidget");
    assert.ok(raw !== undefined);
    const location = proposeLocation(surfaceOf(raw), "reference", site);
    const conflicts = locationConflicts(location, site);
    assert.ok(conflicts.some((conflict) => conflict.kind === "nav"));
  } finally {
    cleanup(root);
  }
});

test("#1413 two items with one slug both carry the conflict", async () => {
  const root = copyFixture();
  try {
    writeFileSync(
      join(root, "src/index.ts"),
      [
        "/** Returns the value it was given. */",
        "export function documented(value: string): string {",
        "  return value;",
        "}",
        "",
        "export function parseWidget(name: string): { id: string } {",
        "  return { id: name.trim().toLowerCase() };",
        "}",
        "",
        "export function parse_widget(name: string): { id: string } {",
        "  return { id: name.trim().toLowerCase() };",
        "}",
        "",
      ].join("\n"),
    );
    const { tasks } = await tasksOf(root, { items: ["symbol:parseWidget", "symbol:parse_widget"] });
    assert.equal(tasks.tasks.length, 2);
    for (const task of tasks.tasks) {
      assert.ok(
        task.conflicts.some((conflict) => conflict.kind === "slug" && conflict.value === "/reference/parse-widget/"),
        `${task.item} carries the slug conflict`,
      );
    }
  } finally {
    cleanup(root);
  }
});
