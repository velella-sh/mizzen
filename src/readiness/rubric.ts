import type { ReadinessDimension } from "../contracts/readiness.ts";

/** One scored rule of the public rubric. */
export interface RubricRule {
  /** Stable code, unique across the rubric. */
  readonly code: string;
  /** The dimension the rule scores. */
  readonly dimension: ReadinessDimension;
  /** Points inside the dimension; a dimension's rules sum to its weight. */
  readonly weight: number;
  /** What passing means, in one sentence. */
  readonly title: string;
  /** What the scan needs before it can decide; absent when it always can. */
  readonly prerequisite?: string;
  /** What a finding for this rule tells the reader to do. */
  readonly action: string;
  /** Public documentation for the rule. */
  readonly link: string;
}

/** One dimension of the public rubric. */
export interface RubricDimension {
  /** The dimension's name. */
  readonly id: ReadinessDimension;
  /** A reader-facing title. */
  readonly title: string;
  /** Its weight out of 100. */
  readonly weight: number;
  /** Why this dimension matters to an agent. */
  readonly rationale: string;
  /** True when a failure here blocks the gate whatever the average score says. */
  readonly critical: boolean;
}

/** The public rubric: version, weights, prerequisites, and why each dimension exists. */
export interface ReadinessRubric {
  /** Semantic version; a change to rules, weights, or thresholds bumps it. */
  readonly version: string;
  /** The dimensions, in report order. */
  readonly dimensions: readonly RubricDimension[];
  /** Every rule, grouped by dimension in report order. */
  readonly rules: readonly RubricRule[];
  /** The evaluation suite whose results may score `examples.evaluation`. */
  readonly evaluation: { readonly suite: string; readonly version: string };
}

const DOCS = "https://github.com/velella-sh/mizzen/blob/main/docs/readiness.md";

/** The published rubric, version 1.0.0. Weights sum to 100 across seven dimensions. */
export const RUBRIC: ReadinessRubric = {
  version: "1.0.0",
  evaluation: { suite: "mizzen-readiness", version: "1.0.0" },
  dimensions: [
    {
      id: "structure",
      title: "Structure",
      weight: 20,
      rationale: "An agent can find a page's source, its stable blocks, and the exact span behind every built block.",
      critical: false,
    },
    {
      id: "navigation",
      title: "Navigation",
      weight: 15,
      rationale: "Every index and internal link leads to a file that exists, so an agent can walk the site without guessing.",
      critical: false,
    },
    {
      id: "context",
      title: "Context",
      weight: 15,
      rationale: "A page carries machine-readable context, edit instructions, and packs an agent can paste without reading the site.",
      critical: false,
    },
    {
      id: "examples",
      title: "Examples",
      weight: 15,
      rationale: "Code fences are labelled and runnable examples are checked, and task results come from a matching evaluation suite.",
      critical: false,
    },
    {
      id: "verification",
      title: "Verification",
      weight: 15,
      rationale: "The artifact is the build it claims to be, and trust evidence names the same pages.",
      critical: true,
    },
    {
      id: "permissions",
      title: "Permissions",
      weight: 10,
      rationale: "Every page names the file an agent may edit, and a generated page points at its real source.",
      critical: true,
    },
    {
      id: "maintenance",
      title: "Maintenance",
      weight: 10,
      rationale: "Review coverage is recorded and no page is silently overdue.",
      critical: false,
    },
  ],
  rules: [
    {
      code: "structure.manifest",
      dimension: "structure",
      weight: 5,
      title: "Every page entry names a relative source file, its outputs, and two hashes.",
      action: "Build the site with the manifest output on, and give every page a source file.",
      link: DOCS,
    },
    {
      code: "structure.markdown",
      dimension: "structure",
      weight: 4,
      title: "Every rendered page has a non-empty Markdown twin listed in its manifest entry.",
      action: "Turn the twins output on and rebuild; a page whose URL names no Markdown twin is an app page, not a doc page.",
      link: DOCS,
    },
    {
      code: "structure.sourcemap",
      dimension: "structure",
      weight: 5,
      title: "sourcemap.json names every page, and every section and block has a real source span.",
      action: "Rebuild with the sourcemap output on and fix the page whose span is missing or outside its source.",
      link: DOCS,
    },
    {
      code: "structure.blocks",
      dimension: "structure",
      weight: 3,
      title: "blocks.json agrees with the page HTML and the source map about every stable block id.",
      prerequisite: "A site with stable block ids (mizzen build --update-blocks).",
      action: "Run `mizzen build --update-blocks`, then rebuild and commit blocks.lock.json.",
      link: DOCS,
    },
    {
      code: "structure.ids",
      dimension: "structure",
      weight: 3,
      title: "Block ids are unique across the site and heading anchors are unique within a page.",
      action: "Give every declared block a unique id and rebuild; the lock keeps ids stable after a move.",
      link: DOCS,
    },
    {
      code: "navigation.llms",
      dimension: "navigation",
      weight: 5,
      title: "llms.txt exists and every internal link in it resolves to a built file.",
      action: "Turn the llms output on and rebuild, or remove the site-owned llms.txt entry that points at a missing file.",
      link: DOCS,
    },
    {
      code: "navigation.links",
      dimension: "navigation",
      weight: 5,
      title: "Every internal link in the built HTML resolves to a built file.",
      action: "Fix the broken link in the page named by the finding, or add the missing page, then rebuild.",
      link: DOCS,
    },
    {
      code: "navigation.agents",
      dimension: "navigation",
      weight: 5,
      title: "AGENTS.md exists, has a Pages section, and its page count matches the build.",
      action: "Turn the agents-md output on and rebuild; a site-owned AGENTS.md must state the same page count.",
      link: DOCS,
    },
    {
      code: "context.page-json",
      dimension: "context",
      weight: 5,
      title: "Every page has a JSON twin whose URL and source match the manifest.",
      action: "Turn the page-json output on and rebuild, or fix the page JSON that names another page.",
      link: DOCS,
    },
    {
      code: "context.agent-json",
      dimension: "context",
      weight: 5,
      title: "Agent instruction files parse, name a real page, and carry a source or notes.",
      prerequisite: "A page with an `agent:` front-matter block.",
      action: "Add an `agent` block with `source` or `notes` to a page, or remove an agent.json that names no page.",
      link: DOCS,
    },
    {
      code: "context.packs",
      dimension: "context",
      weight: 5,
      title: "Every context pack parses, names known pages, and carries a source span per item.",
      prerequisite: "A `_data/context-packs.yml` topic.",
      action: "Add a context-packs topic, or fix the pack item whose URL is not a page of this build.",
      link: DOCS,
    },
    {
      code: "examples.fences",
      dimension: "examples",
      weight: 5,
      title: "Every code fence in a Markdown twin declares a language.",
      action: "Add a language tag to every opening fence (` ```js `), then rebuild.",
      link: DOCS,
    },
    {
      code: "examples.report",
      dimension: "examples",
      weight: 4,
      title: "examples.json exists, covers the build's pages, and reports no failed example.",
      prerequisite: "The examples-report output.",
      action: "Turn the examples-report output on, fix every failed example, and rebuild.",
      link: DOCS,
    },
    {
      code: "examples.evaluation",
      dimension: "examples",
      weight: 6,
      title: "Task results come from an evaluation suite whose version and build snapshot match this report.",
      prerequisite: "A matching evaluation report.",
      action: "Run the `mizzen-readiness` suite against this build and pass its JSON report to `mizzen readiness --evals`.",
      link: DOCS,
    },
    {
      code: "verification.digest",
      dimension: "verification",
      weight: 8,
      title: "Hashing the built folder again gives the hash in its manifest.",
      action: "Do not edit a built folder; rebuild it and run readiness on that output.",
      link: DOCS,
    },
    {
      code: "verification.trust",
      dimension: "verification",
      weight: 7,
      title: "trust.json parses, covers every page, and names this build shape.",
      prerequisite: "The trust output and an as-of date.",
      action: "Turn the trust output on, build with `--as-of`, and rebuild after changing content.",
      link: DOCS,
    },
    {
      code: "permissions.edit-target",
      dimension: "permissions",
      weight: 6,
      title: "Every page JSON names the source file an agent would edit.",
      action: "Turn the page-json output on and rebuild, and give generated pages an `agent.source`.",
      link: DOCS,
    },
    {
      code: "permissions.generated",
      dimension: "permissions",
      weight: 4,
      title: "A generated page that forbids edits names the file to edit instead.",
      action: "Set `agent: { edit: false, source: <file> }` on every generated page.",
      link: DOCS,
    },
    {
      code: "maintenance.review",
      dimension: "maintenance",
      weight: 5,
      title: "review-coverage.json exists and names every page of the build.",
      prerequisite: "The review-coverage output.",
      action: "Turn the review-coverage output on and rebuild.",
      link: DOCS,
    },
    {
      code: "maintenance.state",
      dimension: "maintenance",
      weight: 5,
      title: "No page is overdue for review; an unmeasured review state is unknown, never a pass.",
      prerequisite: "A build with `--as-of` and git review history.",
      action: "Review the overdue page, or build with `--as-of` so the review window can be measured.",
      link: DOCS,
    },
  ],
};

/** Compares by code point, never by locale. */
export function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** One dimension by id. */
export function dimensionOf(id: ReadinessDimension): RubricDimension {
  const dimension = RUBRIC.dimensions.find((entry) => entry.id === id);
  if (dimension === undefined) throw new TypeError(`readiness: unknown dimension ${id}`);
  return dimension;
}

/** Every rule of one dimension, in rubric order. */
export function rulesOf(id: ReadinessDimension): readonly RubricRule[] {
  return RUBRIC.rules.filter((rule) => rule.dimension === id);
}

/** One rule by code. */
export function ruleOf(code: string): RubricRule {
  const rule = RUBRIC.rules.find((entry) => entry.code === code);
  if (rule === undefined) throw new TypeError(`readiness: unknown rule ${code}`);
  return rule;
}
