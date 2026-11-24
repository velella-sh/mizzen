import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AccessGrant, AccessPolicy } from "../src/contracts/permissions.ts";
import type { AuthoringDraft, AuthoringQuestion, AuthoringTask, AuthoringTaskList, AuthoringUnknown } from "../src/contracts/authoring.ts";
import type { Site } from "../src/contracts/content.ts";
import type { SurfaceReport } from "../src/contracts/surface.ts";
import { authoringTasksOf, type AuthoringTaskOptions } from "../src/authoring/tasks.ts";
import { parseAuthoringDraft } from "../src/authoring/draft.ts";
import { buildModel } from "../src/model/build.ts";
import { surfaceReportOf } from "../src/surface/report.ts";
import { accessPolicyFingerprint } from "../src/permissions/policy.ts";

/** The committed fixture site. */
export const FIXTURE = fileURLToPath(new URL("../fixtures/authoring/site", import.meta.url));

/** The committed draft. */
export const DRAFT = fileURLToPath(new URL("../fixtures/authoring/draft.json", import.meta.url));

/** A temporary copy of the fixture site. */
export function copyFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "authoring-fixture-"));
  cpSync(FIXTURE, root, { recursive: true });
  return root;
}

/** Removes a fixture copy. */
export function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/** The theme root inside a fixture copy. */
export function themeRootOf(root: string): string {
  return join(root, "theme");
}

/** A draft whose list fields a test may replace. */
export interface MutableDraft {
  version: 1;
  item: string;
  pageType: AuthoringDraft["pageType"];
  title: string;
  description?: string;
  slug: string;
  block: string;
  body: string;
  limitations: string[];
  unknowns: AuthoringUnknown[];
  questions: AuthoringQuestion[];
}

/** The fixture draft, parsed through the public draft parser. */
export function fixtureDraft(): MutableDraft {
  const parsed = parseAuthoringDraft(JSON.parse(readFileSync(DRAFT, "utf8")) as unknown);
  assert.deepEqual(parsed.problems, []);
  assert.ok(parsed.draft !== undefined, "the fixture draft must parse");
  const draft = parsed.draft;
  return {
    version: 1,
    item: draft.item,
    pageType: draft.pageType,
    title: draft.title,
    ...(draft.description === undefined ? {} : { description: draft.description }),
    slug: draft.slug,
    block: draft.block,
    body: draft.body,
    limitations: [...draft.limitations],
    unknowns: draft.unknowns.map((unknown) => ({ ...unknown })),
    questions: draft.questions.map((question) => ({ ...question })),
  };
}

/** A site model and surface report for one fixture copy. */
export async function reportOf(root: string, version = "0.2.7"): Promise<{ site: Site; report: SurfaceReport }> {
  const model = await buildModel(root);
  const { report } = await surfaceReportOf({ root, site: model.site, version });
  return { site: model.site, report };
}

/** The authoring tasks of one fixture copy. */
export async function tasksOf(
  root: string,
  options: Omit<AuthoringTaskOptions, "root" | "site" | "report"> = {},
): Promise<{ tasks: AuthoringTaskList; site: Site; report: SurfaceReport }> {
  const { site, report } = await reportOf(root);
  const result = await authoringTasksOf({ root, site, report, version: "0.2.7", ...options });
  assert.deepEqual(result.problems, []);
  return { tasks: result.list, site, report };
}

/** The one task in a list. */
export function onlyTask(list: AuthoringTaskList, item = "symbol:parseWidget"): AuthoringTask {
  const task = list.tasks.find((entry) => entry.item === item);
  assert.ok(task !== undefined, `the list must hold ${item}`);
  return task;
}

/** A write policy that allows the fixture page and the source it reads, with an approval required. */
export function writePolicy(overrides: Partial<AccessPolicy> = {}): AccessPolicy {
  return {
    version: 1,
    task: "site",
    capabilities: { read: true, write: true, execute: false, network: false, publish: false },
    read: { public: true, audiences: [] },
    write: {
      paths: ["docs/**"],
      scope: { pages: ["/reference/parse-widget/"], blocks: ["parse-widget"], collections: [], files: ["docs/**", "src/index.ts"] },
    },
    check: { runners: [] },
    network: { destinations: [], stages: [] },
    approvals: { read: false, write: true, execute: false, network: false, publish: false },
    ...overrides,
  };
}

/** A valid approval for one policy, snapshot, and page. */
export function approvalFor(policy: AccessPolicy, snapshot: string, file = "docs/reference/parse-widget.md"): AccessGrant {
  return {
    id: "fixture-approval",
    capability: "write",
    principal: "reviewer",
    decision: "approved",
    reason: "The reviewer approved the fixture page.",
    snapshot,
    policy: accessPolicyFingerprint(policy),
    files: [file],
  };
}
