/**
 * Verify a draft and prepare its proof (#1415): check every runnable example, every cited behavior, every link, the
 * documentation coverage after a simulated merge, and the build. The proposal is prepared only with a proved
 * verification and a list of the unknowns that remain for a reviewer.
 *
 * Examples run in the bounded Node runner with the network denied. An `@site/` import specifier is rewritten to the
 * temporary merged site, so a draft can call the real API without carrying a machine path. The simulated merge writes
 * the page into a copy of the site, rebuilds the surface report, and closes the gap only when the item is fully
 * documented there.
 */
import { pathToFileURL } from "node:url";
import type { Nodes, Root } from "mdast";
import type { Site } from "../contracts/index.ts";
import type {
  AuthoringCheck,
  AuthoringDraft,
  AuthoringPreview,
  AuthoringProof,
  AuthoringTask,
  AuthoringUnknown,
  AuthoringVerification,
} from "../contracts/authoring.ts";
import { canonicalJson, sha256 } from "../data/lock.ts";
import { examplesIn } from "../markdown/plugins/example-fence.ts";
import { parseMarkdown } from "../markdown/parse.ts";
import { runNodeExample, type ExampleLang } from "../pipeline/examples/run-node.ts";
import { normalizeExampleOutput } from "../verification/examples.ts";
import { buildMergedSite, removeMergedSite, type MergedSite } from "./build.ts";
import { validateAuthoringDraft } from "./draft.ts";
import { urlWithoutBase } from "./location.ts";

/** What a verification needs. */
export interface AuthoringVerifyOptions {
  readonly root: string;
  readonly site: Site;
  readonly task: AuthoringTask;
  readonly draft: AuthoringDraft;
  readonly themeRoot: string;
  readonly version?: string;
  /** The preview the reviewer saw; its page is not reused, but it proves the draft was previewed. */
  readonly preview?: AuthoringPreview;
}

/** The example languages the runner accepts. */
const EXAMPLE_LANGS: ReadonlySet<string> = new Set(["js", "mjs", "ts"]);

/** One check result. */
function check(id: string, kind: AuthoringCheck["kind"], status: AuthoringCheck["status"], detail?: string): AuthoringCheck {
  return { id, kind, status, ...(detail === undefined ? {} : { detail }) };
}

/** Every link of a Markdown tree, in document order. */
function linksOf(tree: Root): { readonly href: string; readonly text: string }[] {
  const links: { readonly href: string; readonly text: string }[] = [];
  const walk = (node: Nodes): void => {
    if (node.type === "link") {
      const text = "children" in node ? node.children.map((child) => (child.type === "text" ? child.value : "")).join("") : "";
      links.push({ href: node.url, text });
    }
    if ("children" in node) for (const child of node.children) walk(child);
  };
  walk(tree);
  return links;
}

/** True when a link points outside the site. */
function external(href: string): boolean {
  return /^(?:https?:|mailto:|tel:)/iu.test(href) || href.startsWith("#");
}

/** The site-local URL a link names, or `undefined` when it is relative and unusable. */
function siteUrlOf(href: string, pageUrl: string): string | undefined {
  if (href.startsWith("/")) return href;
  if (href.startsWith("#")) return pageUrl;
  try {
    return new URL(href, `https://mizzen.invalid${pageUrl}`).pathname;
  } catch {
    return undefined;
  }
}

/** Runs every example and compares its output. */
async function examplesCheck(merged: MergedSite, draft: AuthoringDraft): Promise<{ readonly check: AuthoringCheck; readonly failures: readonly string[] }> {
  const tree = await parseMarkdown(draft.body, 1);
  const examples = examplesIn(tree).filter((example) => EXAMPLE_LANGS.has(example.lang));
  if (examples.length === 0) {
    return {
      check: check("authoring-examples", "examples", "failed", "The draft has no runnable js, mjs, or ts example."),
      failures: ["The draft needs at least one runnable example."],
    };
  }
  const base = pathToFileURL(merged.root).href;
  const failures: string[] = [];
  for (const example of examples) {
    const code = example.code.replaceAll("@site/", `${base}/`);
    const result = await runNodeExample({
      lang: example.lang as ExampleLang,
      code,
      timeoutMs: 10_000,
      network: "deny",
    });
    const actual = normalizeExampleOutput(result.stdout);
    const expected = example.expected === null ? undefined : normalizeExampleOutput(example.expected);
    if (!result.ok) {
      failures.push(`Example \`${example.id}\` exited ${String(result.exitCode)}${result.stderr === "" ? "" : `: ${result.stderr.split("\n")[0]}`}`);
    } else if (expected !== undefined && actual !== expected) {
      failures.push(`Example \`${example.id}\` printed "${actual}", not "${expected}".`);
    }
  }
  return failures.length === 0
    ? { check: check("authoring-examples", "examples", "passed", `${examples.length} example(s) printed their expected output.`), failures }
    : { check: check("authoring-examples", "examples", "failed", failures.join(" ")), failures };
}

/** Checks that every cited behavior resolved and is verified. */
function behaviorsCheck(
  merged: MergedSite,
  task: AuthoringTask,
  unknowns: AuthoringUnknown[],
): { readonly check: AuthoringCheck; readonly unknowns: readonly AuthoringUnknown[] } {
  const cited = [...new Set(task.requiredEvidence.filter((entry) => entry.kind === "behavior").map((entry) => entry.ref))].sort();
  if (cited.length === 0) {
    return { check: check("authoring-behaviors", "behaviors", "failed", "The task cites no behavior contract."), unknowns };
  }
  const byId = new Map(merged.behavior.behaviors.map((behavior) => [behavior.id, behavior]));
  const failures: string[] = [];
  const added: AuthoringUnknown[] = [];
  for (const id of cited) {
    const behavior = byId.get(id);
    if (behavior === undefined) {
      failures.push(`Behavior \`${id}\` is not in the report.`);
      continue;
    }
    if (behavior.verification.status !== "verified") {
      failures.push(`Behavior \`${id}\` is unverified: ${behavior.verification.reasons.join(", ")}.`);
      added.push({
        id: `behavior-${id}`,
        statement: `Behavior \`${id}\` is unverified: ${behavior.verification.reasons.join(", ")}.`,
        evidence: "The tests and evidence the published policy requires.",
      });
    }
  }
  const mergedUnknowns = [...unknowns];
  for (const unknown of added) if (!mergedUnknowns.some((entry) => entry.id === unknown.id)) mergedUnknowns.push(unknown);
  return {
    check:
      failures.length === 0
        ? check("authoring-behaviors", "behaviors", "passed", `${cited.length} cited behavior(s) are verified.`)
        : check("authoring-behaviors", "behaviors", "failed", failures.join(" ")),
    unknowns: mergedUnknowns.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

/** Checks that every site-local link names a page the merged site builds. */
async function linksCheck(merged: MergedSite, draft: AuthoringDraft): Promise<AuthoringCheck> {
  const tree = await parseMarkdown(draft.body, 1);
  const urls = new Set(merged.model.site.pages.map((page) => urlWithoutBase(page.url, merged.model.site)));
  const failures: string[] = [];
  for (const link of linksOf(tree)) {
    if (external(link.href)) continue;
    const url = siteUrlOf(link.href, "/");
    if (url === undefined) {
      failures.push(`Link \`${link.href}\` is not a path this site can resolve.`);
      continue;
    }
    const path = url.split("#")[0]!;
    if (!urls.has(path.endsWith("/") ? path : `${path}/`)) {
      failures.push(`Link \`${link.href}\` names no page.`);
    }
  }
  return failures.length === 0
    ? check("authoring-links", "links", "passed", "Every site-local link resolves.")
    : check("authoring-links", "links", "failed", failures.join(" "));
}

/** Checks that the simulated merge documents the item completely. */
function coverageCheck(merged: MergedSite, task: AuthoringTask): { readonly check: AuthoringCheck; readonly gapClosed: boolean } {
  const match = merged.surface.matches.find((entry) => entry.item === task.item);
  const gap = merged.surface.gaps.find((entry) => entry.item === task.item);
  const gapClosed = match?.state === "complete" && gap === undefined;
  return {
    check: gapClosed
      ? check("authoring-coverage", "coverage", "passed", `The simulated merge documents \`${task.item}\` completely.`)
      : check(
          "authoring-coverage",
          "coverage",
          "failed",
          `The simulated merge leaves \`${task.item}\` ${match?.state ?? "missing"}${gap === undefined ? "" : ` (${gap.gap})`}.`,
        ),
    gapClosed,
  };
}

/** The build check: no error diagnostics and a written page. */
function buildCheck(merged: MergedSite, task: AuthoringTask): AuthoringCheck {
  if (merged.errors.length > 0) {
    return check(
      "authoring-build",
      "build",
      "failed",
      merged.errors.map((error) => `${error.id}: ${error.message}`).join(" "),
    );
  }
  return merged.html !== undefined
    ? check("authoring-build", "build", "passed", `The build wrote \`${merged.file}\` for \`${task.item}\`.`)
    : check("authoring-build", "build", "failed", `The build wrote no page at \`${merged.file}\`.`);
}

/** A stable failure sentence for one uncited claim. */
function uncitedFailure(line: number): string {
  return `The normative claim at line ${line} has no citation.`;
}

/**
 * Verifies a draft. A draft that does not validate fails before any build. Otherwise the draft is built in a temporary
 * copy of the site, the checks run in a fixed order, and a proof is written only when every check passed.
 */
export async function authoringVerify(options: AuthoringVerifyOptions): Promise<AuthoringVerification> {
  const { task, draft, root, site } = options;
  const validation = validateAuthoringDraft(draft, task, site);
  const base = {
    version: 1 as const,
    item: task.item,
    task: task.task.id,
    snapshot: task.task.snapshot.id,
    uncited: validation.uncited,
  };
  if (!validation.ok) {
    return {
      ...base,
      checks: [
        check("authoring-citations", "citations", "failed", validation.problems.map((problem) => problem.message).join(" ")),
        check("authoring-examples", "examples", "skipped", "The draft did not validate."),
        check("authoring-behaviors", "behaviors", "skipped", "The draft did not validate."),
        check("authoring-links", "links", "skipped", "The draft did not validate."),
        check("authoring-coverage", "coverage", "skipped", "The draft did not validate."),
        check("authoring-build", "build", "skipped", "The draft did not validate."),
      ],
      remainingUnknowns: [...task.unknowns],
      remainingQuestions: [...task.questions],
      failures: [...validation.problems.map((problem) => problem.message), ...validation.uncited.map((claim) => uncitedFailure(claim.line))],
      verdict: "failed",
      ready: false,
    };
  }

  const merged = await buildMergedSite({
    root,
    task,
    draft,
    themeRoot: options.themeRoot,
    ...(options.version === undefined ? {} : { version: options.version }),
  });
  try {
    const examples = await examplesCheck(merged, draft);
    const behaviors = behaviorsCheck(merged, task, [...task.unknowns]);
    const links = await linksCheck(merged, draft);
    const coverage = coverageCheck(merged, task);
    const build = buildCheck(merged, task);
    const checks: AuthoringCheck[] = [
      check("authoring-citations", "citations", "passed", `${validation.citations.length} citation(s) resolve.`),
      examples.check,
      behaviors.check,
      links,
      coverage.check,
      build,
    ];
    const failures = [
      ...examples.failures,
      ...(behaviors.check.status === "passed" ? [] : [behaviors.check.detail ?? "The behavior check failed."]),
      ...(links.status === "passed" ? [] : [links.detail ?? "The link check failed."]),
      ...(coverage.check.status === "passed" ? [] : [coverage.check.detail ?? "The coverage check failed."]),
      ...(build.status === "passed" ? [] : [build.detail ?? "The build check failed."]),
    ];
    const proved = checks.every((entry) => entry.status === "passed") && validation.uncited.length === 0;
    const proof: AuthoringProof | undefined = proved
      ? {
          version: 1,
          item: task.item,
          task: task.task.id,
          snapshot: task.task.snapshot.id,
          citations: validation.citations,
          checks,
          gapClosed: coverage.gapClosed,
          hash: sha256(
            canonicalJson({
              version: 1,
              item: task.item,
              task: task.task.id,
              snapshot: task.task.snapshot.id,
              citations: validation.citations,
              checks,
              gapClosed: coverage.gapClosed,
            }),
          ),
        }
      : undefined;
    return {
      ...base,
      checks,
      ...(proof === undefined ? {} : { proof }),
      remainingUnknowns: behaviors.unknowns,
      remainingQuestions: [...task.questions],
      failures,
      verdict: proved ? "proved" : "failed",
      ready: proved,
    };
  } finally {
    removeMergedSite(merged);
  }
}
