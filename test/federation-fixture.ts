/**
 * Fixtures for the federation tests and the acceptance case: three independent projects — a product, its docs, and a
 * consumer — each publishing a small bundle. The docs project references the product's public surface, and the consumer
 * references a docs behavior, so a cross-project query and an evidence chain have something real to follow while the
 * network is disabled.
 *
 * Every bundle is built through the engine's own `buildBundle`, so its digest is verified exactly as a published one
 * would be. Nothing here touches the network.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  FederationEvidenceBundle,
  FederationLock,
  FederationManifest,
  FederationPolicy,
  FederationReference,
  KnowledgeBundle,
} from "../src/contracts/federation.ts";
import type { BehaviorRecord } from "../src/contracts/behavior.ts";
import type { Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { SurfaceItem } from "../src/contracts/surface.ts";
import { buildBundle, bundleText } from "../src/federation/bundle.ts";
import { evidenceDigest } from "../src/federation/contract.ts";
import { buildGraph } from "../src/graph/build.ts";
import { sha256 } from "../src/data/lock.ts";

/** The public policy a fixture bundle publishes. */
export const PUBLIC: FederationPolicy = { public: true, audiences: [] };

/** A private policy readable by one audience, for the access tests. */
export const PRIVATE: FederationPolicy = { public: false, audiences: ["internal-docs"] };

/** The site config a fixture graph is built from. */
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

/** One fixture site: a page, a block, and an optional knowledge declaration. */
function site(source: string, title: string): Site {
  const pos = { file: source, line: 1, column: 1, endLine: 1, endColumn: 5 };
  const page: Page = {
    url: source.replace(/\.md$/, "/"),
    source: pos,
    frontMatter: { title },
    title,
    lang: "en",
    dir: "ltr",
    headings: [],
    blocks: [{ id: "intro", pos, declared: true }],
    html: "",
    markdown: "",
    kind: "doc",
  };
  return { config: CONFIG, pages: [page], nav: {}, collections: {}, data: {} };
}

/** One surface item at a point span. */
function surfaceItem(id: string, name: string, kind: SurfaceItem["kind"] = "symbol"): SurfaceItem {
  return {
    id: `api:${id}`,
    area: "api",
    kind,
    name,
    source: { file: "src/index.ts", line: 1, column: 1, endLine: 1, endColumn: 1 },
    stability: "stable",
  };
}

/** One behavior record with a page, a surface link, and its verification. */
function behavior(id: string, title: string, surface: string): BehaviorRecord {
  return {
    id,
    title,
    normative: `${title} works as documented.`,
    source: { file: "guide.md", line: 1, column: 1, endLine: 1, endColumn: 1 },
    page: { url: "/guide/", source: "guide.md" },
    status: "supported",
    versions: { introduced: "1.0.0" },
    environments: [],
    surface: [{ item: surface, state: "linked" }],
    tests: [],
    evidence: [],
    verification: { status: "verified", reasons: [], required: { tests: 0, evidence: 0, kinds: [] } },
  };
}

/** One bundle built from a site and its references. */
export interface FixtureProject {
  readonly id: string;
  readonly namespace: string;
  readonly role: "product" | "docs" | "consumer";
  readonly snapshot: { readonly id: string; readonly version: string };
  readonly bundle: KnowledgeBundle;
  readonly text: string;
}

/** Builds one project's bundle from its own graph, surface, behaviors, evidence, and references. */
function project(input: {
  id: string;
  namespace: string;
  role: FixtureProject["role"];
  snapshot: FixtureProject["snapshot"];
  source: string;
  title: string;
  surface: readonly SurfaceItem[];
  behaviors: readonly BehaviorRecord[];
  evidence: FederationEvidenceBundle;
  references: readonly FederationReference[];
  policy?: FederationPolicy;
}): FixtureProject {
  const { graph } = buildGraph({ site: site(input.source, input.title), snapshot: `${input.id}-${input.snapshot.id}` });
  const bundle = buildBundle({
    project: input.id,
    namespace: input.namespace,
    role: input.role,
    snapshot: input.snapshot,
    policy: input.policy ?? PUBLIC,
    graph,
    surface: input.surface,
    behaviors: input.behaviors,
    evidence: input.evidence,
    references: input.references,
    removed: [],
  });
  return { id: input.id, namespace: input.namespace, role: input.role, snapshot: input.snapshot, bundle, text: bundleText(bundle) };
}

/** The three fixture projects, with a real cross-project reference in each direction. */
export function projects(options: { readonly privateDocs?: boolean; readonly docsOptional?: boolean } = {}): FixtureProject[] {
  void options.docsOptional;
  const greet = surfaceItem("greet", "greet");
  const productEvidence: FederationEvidenceBundle = {
    version: 1,
    claims: [{ id: "claim-greet", subject: "surface:api:greet", evidence: ["test-greet"] }],
    links: [
      {
        from: "claim-greet",
        to: "test-greet",
        kind: "backs",
        digest: evidenceDigest("product", "snap-1", "test-greet"),
      },
    ],
  };
  const product = project({
    id: "product",
    namespace: "velella-product",
    role: "product",
    snapshot: { id: "snap-1", version: "1.2.0" },
    source: "guide.md",
    title: "Product guide",
    surface: [greet],
    behaviors: [behavior("greet.returns-name", "Greeting returns the name", "api:greet")],
    evidence: productEvidence,
    references: [],
    ...(options.privateDocs === true ? {} : {}),
  });

  const docs = project({
    id: "docs",
    namespace: "velella-docs",
    role: "docs",
    snapshot: { id: "snap-1", version: "1.1.0" },
    source: "install.md",
    title: "Install",
    surface: [],
    behaviors: [behavior("install.runs", "Install runs", "command:install")],
    evidence: { version: 1, claims: [], links: [] },
    references: [
      { from: "page:install.md", to: { project: "product", id: "surface:api:greet" }, kind: "documents" },
    ],
    policy: options.privateDocs === true ? PRIVATE : PUBLIC,
  });

  const consumer = project({
    id: "consumer",
    namespace: "velella-consumer",
    role: "consumer",
    snapshot: { id: "snap-1", version: "0.9.0" },
    source: "usage.md",
    title: "Usage",
    surface: [],
    behaviors: [],
    evidence: {
      version: 1,
      claims: [{ id: "claim-install", subject: "behavior:install.runs", evidence: [] }],
      links: [
        {
          from: "claim-install",
          to: "behavior:install.runs",
          kind: "checks",
          target: { project: "docs", version: "1.1.0" },
          digest: evidenceDigest("docs", "snap-1", "behavior:install.runs"),
        },
      ],
    },
    references: [
      { from: "page:usage.md", to: { project: "docs", id: "behavior:install.runs" }, kind: "references" },
    ],
  });
  return [product, docs, consumer];
}

/** Writes `files` under `root`. */
export function tree(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** A fresh temporary folder. */
export function scratch(prefix = "federation-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** The manifest text the three fixture projects publish. */
export function manifestText(projects: readonly FixtureProject[], optional: readonly string[] = []): string {
  const manifest: FederationManifest = {
    version: 1,
    projects: projects.map((project) => ({
      id: project.id,
      namespace: project.namespace,
      role: project.role,
      source: { path: `${project.id}.bundle.json` },
      ...(optional.includes(project.id) ? { optional: true } : {}),
    })),
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** The SHA-256 of each project's bundle text, which is the pin a lock records and the file name the bytes live at. */
export function pinsOf(projects: readonly FixtureProject[]): Record<string, string> {
  return Object.fromEntries(
    projects
      .map((project) => [project.id, sha256(project.text)] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  );
}

/** The lock a fetch over `projects` with `manifestSha` writes. */
export function lockOf(
  projects: readonly FixtureProject[],
  manifestSha: string,
  bundles: Readonly<Record<string, string>>,
): FederationLock {
  return {
    version: 1,
    manifest: { source: "federation.json", sha256: manifestSha },
    bundles: Object.fromEntries(
      projects
        .map((project) => [
          project.id,
          {
            project: project.id,
            namespace: project.namespace,
            role: project.role,
            sha256: bundles[project.id]!,
            snapshot: project.bundle.snapshot,
            source: `path:${project.id}.bundle.json`,
            optional: false,
          },
        ] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    ),
  };
}
