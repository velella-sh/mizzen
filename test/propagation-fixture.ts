/**
 * Fixtures for the propagation tests and the acceptance case: small verified bundles for an upstream product, the
 * public decisions beside one snapshot, and the consumer manifests that declare what they depend on. Every bundle is
 * built through the engine's own `buildBundle`, so its digest is verified exactly as a published one would be.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BehaviorRecord } from "../src/contracts/behavior.ts";
import type { Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { DecisionLink, DecisionRecord, DecisionStatus } from "../src/contracts/decisions.ts";
import type {
  FederationEvidenceBundle,
  FederationPolicy,
  KnowledgeBundle,
} from "../src/contracts/federation.ts";
import type { ConsumerDeclaration, PropagationManifest, SnapshotView } from "../src/contracts/propagation.ts";
import type { SurfaceItem } from "../src/contracts/surface.ts";
import { buildBundle, bundleText } from "../src/federation/bundle.ts";
import { buildGraph } from "../src/graph/build.ts";
import { snapshotOfBundle } from "../src/propagation/snapshot.ts";

/** A source position used by every fixture record. */
export const POS = { file: "guide/install.md", line: 1, column: 1, endLine: 1, endColumn: 5 };

/** The public policy a fixture bundle publishes. */
export const PUBLIC: FederationPolicy = { public: true, audiences: [] };

/** A private policy readable by one audience. */
export const PRIVATE: FederationPolicy = { public: false, audiences: ["internal-docs"] };

const CONFIG: SiteConfig = {
  title: "Fixture",
  base: "",
  lang: "en",
  dir: "ltr",
  languages: [],
  source: ".",
  include: [],
  exclude: [],
  navigation: "_data/navigation.yml",
  collections: {},
  feeds: {},
  defaults: [],
  theme: { options: {} },
  search: {},
  redirects: {},
  outputs: {},
};

/** A minimal site the graph is built from. */
function site(source: string, title: string): Site {
  const page: Page = {
    url: source.replace(/\.md$/, "/"),
    source: POS,
    frontMatter: { title },
    title,
    lang: "en",
    dir: "ltr",
    headings: [],
    blocks: [{ id: "intro", pos: POS, declared: true }],
    html: "",
    markdown: "",
    kind: "doc",
  };
  return { config: CONFIG, pages: [page], nav: {}, collections: {}, data: {} };
}

/** One surface item. */
export function surfaceItem(name: string, options: {
  readonly id?: string;
  readonly area?: SurfaceItem["area"];
  readonly kind?: SurfaceItem["kind"];
  readonly signature?: string;
  readonly stability?: SurfaceItem["stability"];
  readonly parent?: string;
} = {}): SurfaceItem {
  return {
    id: options.id ?? `api:${name}`,
    area: options.area ?? "api",
    kind: options.kind ?? "symbol",
    name,
    source: POS,
    stability: options.stability ?? "stable",
    ...(options.signature === undefined ? {} : { signature: options.signature }),
    ...(options.parent === undefined ? {} : { parent: options.parent }),
  };
}

/** One behavior contract. */
export function behavior(id: string, options: {
  readonly title?: string;
  readonly normative?: string;
  readonly status?: BehaviorRecord["status"];
  readonly surface?: string;
  readonly page?: BehaviorRecord["page"];
  readonly tests?: BehaviorRecord["tests"];
} = {}): BehaviorRecord {
  return {
    id,
    title: options.title ?? id,
    normative: options.normative ?? `${id} works as documented.`,
    source: POS,
    page: options.page ?? { url: "/guide/install/", source: "guide/install.md" },
    status: options.status ?? "supported",
    versions: { introduced: "1.0.0" },
    environments: [],
    surface: options.surface === undefined ? [] : [{ item: options.surface, state: "linked" }],
    tests: options.tests ?? [],
    evidence: [],
    verification: { status: "verified", reasons: [], required: { tests: 0, evidence: 0, kinds: [] } },
  };
}

/** One public decision. */
export function decision(id: string, options: {
  readonly title?: string;
  readonly status?: DecisionStatus;
  readonly rationale?: string;
  readonly public?: boolean;
  readonly links?: readonly DecisionLink[];
  readonly behavior?: string;
} = {}): DecisionRecord {
  const links: DecisionLink[] = options.links === undefined
    ? options.behavior === undefined
      ? []
      : [{ kind: "behavior", id: options.behavior, raw: `behavior:${options.behavior}` }]
    : [...options.links];
  return {
    id,
    title: options.title ?? id,
    status: options.status ?? "accepted",
    date: "2026-01-01",
    source: { value: `https://example.test/${id}`, public: true },
    supersedes: [],
    supersededBy: [],
    validity: {},
    links,
    evidence: [],
    context: { text: "Context.", span: POS },
    decision: { text: "Decision.", span: POS },
    ...(options.rationale === undefined ? {} : { rationale: { text: options.rationale, span: POS } }),
    alternatives: [],
    audience: [],
    public: options.public ?? true,
    span: POS,
  };
}

/** One evidence bundle with a claim backed by a test link. */
export function evidence(claim: string, subject: string, digest: string): FederationEvidenceBundle {
  return {
    version: 1,
    claims: [{ id: claim, subject, evidence: ["test"] }],
    links: [{ from: claim, to: "test", kind: "backs", digest }],
  };
}

/** One verified bundle for the upstream product. */
export function bundle(input: {
  readonly project?: string;
  readonly namespace?: string;
  readonly version: string;
  readonly surface?: readonly SurfaceItem[];
  readonly behaviors?: readonly BehaviorRecord[];
  readonly evidence?: FederationEvidenceBundle;
  readonly policy?: FederationPolicy;
}): KnowledgeBundle {
  const project = input.project ?? "product";
  const namespace = input.namespace ?? "velella-product";
  const { graph } = buildGraph({ site: site("guide/install.md", "Guide"), snapshot: `${project}-${input.version}` });
  return buildBundle({
    project,
    namespace,
    role: "product",
    snapshot: { id: `snap-${input.version}`, version: input.version },
    policy: input.policy ?? PUBLIC,
    graph,
    surface: input.surface ?? [],
    behaviors: input.behaviors ?? [],
    evidence: input.evidence ?? { version: 1, claims: [], links: [] },
    references: [],
    removed: [],
  });
}

/** One snapshot view with its decisions. */
export function view(input: Parameters<typeof bundle>[0] & { readonly decisions?: readonly DecisionRecord[] }): SnapshotView {
  return snapshotOfBundle(bundle(input), input.decisions);
}

/** One consumer declaration, with a policy that creates tasks on a breaking or review change. */
export function consumer(input: {
  readonly id: string;
  readonly project?: string;
  readonly consumes: ConsumerDeclaration["consumes"];
  readonly range?: string;
  readonly approval?: ConsumerDeclaration["approval"];
  readonly allowEvidence?: readonly string[];
  readonly denyEvidence?: readonly string[];
  readonly onBreaking?: ConsumerDeclaration["policy"]["onBreaking"];
  readonly onReview?: ConsumerDeclaration["policy"]["onReview"];
}): ConsumerDeclaration {
  return {
    id: input.id,
    project: input.project ?? "product",
    policy: {
      ...(input.range === undefined ? {} : { range: input.range }),
      ...(input.range === undefined ? {} : { channel: "compatible" as const }),
      ...(input.onBreaking === undefined ? {} : { onBreaking: input.onBreaking }),
      ...(input.onReview === undefined ? {} : { onReview: input.onReview }),
    },
    approval: input.approval ?? { mode: "automatic", approvers: [] },
    evidence: {
      allow: input.allowEvidence ?? ["*"],
      deny: input.denyEvidence ?? [],
    },
    consumes: input.consumes,
  };
}

/** One manifest. */
export function manifest(consumers: readonly ConsumerDeclaration[]): PropagationManifest {
  return { version: 1, consumers };
}

/** Writes a bundle and its optional decisions beside it. */
export function writeSnapshot(root: string, value: KnowledgeBundle, decisions?: readonly DecisionRecord[]): void {
  const file = join(root, `${value.project}.bundle.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bundleText(value));
  if (decisions !== undefined) {
    writeFileSync(join(root, `${value.project}.decisions.json`), `${JSON.stringify(decisions, null, 2)}\n`);
  }
}

/** Writes a manifest. */
export function writeManifest(root: string, value: PropagationManifest): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "propagation.json"), `${JSON.stringify(value, null, 2)}\n`);
}
