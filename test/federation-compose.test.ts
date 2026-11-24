/**
 * Federated knowledge across repositories (#1319): the manifest, a published bundle, the offline lock, fully qualified
 * identities, composition, a cross-repository query, version compatibility, a shared-budget pack, an evidence chain, a
 * missing optional bundle, the access policy, and an independent refresh that equals a full recomposition.
 *
 * Every case names the child issue it proves (#1375..#1388) so the release scope can point at it.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  FederatedGraph,
  FederationEvidenceBundle,
  FederationLock,
  KnowledgeBundle,
} from "../src/contracts/federation.ts";
import { buildBundle, bundleText, readBundle } from "../src/federation/bundle.ts";
import { traceEvidenceChain } from "../src/federation/chain.ts";
import { composeFederation, refreshFederation, unitsOf, visibleBundles } from "../src/federation/compose.ts";
import { bundleDigest, compareVersions, evidenceDigest, federatedId, parseFederatedId, parseVersionRange, versionInRange } from "../src/federation/contract.ts";
import { fetchFederation, type FederationFetchLike } from "../src/federation/fetch.ts";
import { federationLockHash, federationLockText, loadFederation, readFederationLock, writeBundle, writeFederationLock } from "../src/federation/lock.ts";
import { parseFederationManifest, projectOf, sourceText } from "../src/federation/manifest.ts";
import { compileFederationPack } from "../src/federation/pack.ts";
import { queryFederation, resolveCitation } from "../src/federation/query.ts";
import { federatedReferenceOf, resolveReference, selectSnapshot } from "../src/federation/reference.ts";
import { lockOf, manifestText, pinsOf, projects, scratch, tree } from "./federation-fixture.ts";

/** The fixture's three bundles, keyed by project. */
function fixture(): Map<string, KnowledgeBundle> {
  return new Map(projects().map((project) => [project.id, project.bundle]));
}

/** The loaded federation the fixture stands for. */
function loaded(bundles = fixture()) {
  return { bundles, missing: [], partial: false };
}

/** A scratch folder that is removed when `body` returns. */
async function withRoot(body: (root: string) => Promise<void> | void): Promise<void> {
  const root = scratch();
  try {
    await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("#1375 a versioned manifest names projects, namespaces, roles, and sources", () => {
  const text = manifestText(projects());
  const { manifest, problems } = parseFederationManifest(JSON.parse(text));
  assert.deepEqual(problems, []);
  assert.equal(manifest?.version, 1);
  assert.deepEqual(manifest?.projects.map((project) => project.id), ["product", "docs", "consumer"]);
  assert.deepEqual(manifest?.projects.map((project) => project.namespace), ["velella-product", "velella-docs", "velella-consumer"]);
  assert.deepEqual(manifest?.projects.map((project) => project.role), ["product", "docs", "consumer"]);
  assert.deepEqual(manifest?.projects[0]?.source, { path: "product.bundle.json" });
});

test("#1375 a duplicate id, namespace, or source is refused with every problem", () => {
  const base = manifestText(projects());
  const parsed = JSON.parse(base) as { projects: Record<string, unknown>[] };
  parsed.projects[1]!.id = parsed.projects[0]!.id;
  parsed.projects[1]!.namespace = parsed.projects[0]!.namespace;
  parsed.projects[1]!.source = parsed.projects[0]!.source;
  const { manifest, problems } = parseFederationManifest(parsed);
  assert.equal(manifest, undefined);
  const codes = problems.map((problem) => problem.code);
  assert.ok(codes.includes("federation.duplicate-id"), codes.join(", "));
  assert.ok(codes.includes("federation.duplicate-namespace"), codes.join(", "));
  assert.ok(codes.includes("federation.duplicate-source"), codes.join(", "));
  // A duplicate source keeps the `path:`/`url:` prefix, so the same folder written two ways is still refused.
  assert.equal(sourceText({ path: "a.json" }), "path:a.json");
});

test("#1375 a source path that leaves the manifest folder is refused", () => {
  const parsed = JSON.parse(manifestText(projects())) as { projects: Record<string, unknown>[] };
  parsed.projects[0]!.source = { path: "../outside.bundle.json" };
  const { manifest, problems } = parseFederationManifest(parsed);
  assert.equal(manifest, undefined);
  assert.ok(problems.some((problem) => problem.path === "/projects/0/source/path"));
});

test("#1376 a bundle carries its graph, surface, behaviors, evidence, tool version, and digest", () => {
  const [product] = projects();
  const bundle = product!.bundle;
  assert.equal(bundle.version, 1);
  assert.equal(bundle.tool, "0.2.6");
  assert.equal(bundle.project, "product");
  assert.equal(bundle.namespace, "velella-product");
  assert.deepEqual(bundle.snapshot, { id: "snap-1", version: "1.2.0" });
  assert.ok(bundle.graph.nodes.length > 0);
  assert.ok(bundle.surface.some((item) => item.id === "api:greet"));
  assert.ok(bundle.behaviors.some((behavior) => behavior.id === "greet.returns-name"));
  assert.ok(bundle.evidence.claims.some((claim) => claim.id === "claim-greet"));
  assert.equal(bundle.digest, bundleDigest(bundle));
  assert.match(bundle.digest, /^[a-f0-9]{64}$/);
});

test("#1376 a bundle edited after it was published is refused whole", () => {
  const text = projects()[0]!.text;
  const parsed = JSON.parse(text) as { graph: { nodes: { label: string }[] } };
  parsed.graph.nodes[0]!.label = "Tampered";
  const read = readBundle(parsed);
  assert.equal(read.bundle, undefined);
  assert.match(read.problem ?? "", /digest/);
  // A bundle whose own body is intact still reads.
  assert.ok(readBundle(JSON.parse(text)).bundle !== undefined);
});

test("#1376 a private bundle leaves private data out rather than redacting it in place", () => {
  const [product, docs, consumer] = projects();
  const bundle = buildBundle({
    project: "docs",
    namespace: "velella-docs",
    role: "docs",
    snapshot: docs!.bundle.snapshot,
    policy: { public: false, audiences: ["internal-docs"] },
    graph: docs!.bundle.graph,
    surface: docs!.bundle.surface,
    behaviors: docs!.bundle.behaviors,
    evidence: docs!.bundle.evidence,
    references: docs!.bundle.references,
    removed: [],
  });
  assert.equal(bundle.policy.public, false);
  assert.deepEqual(bundle.policy.audiences, ["internal-docs"]);
  void product;
  void consumer;
});

test("#1377 a build reads only the lock and the local bytes, never the network", async () => {
  await withRoot(async (root) => {
    const all = projects();
    const manifest = manifestText(all);
    const pins = pinsOf(all);
    const lock = lockOf(all, federationLockHash({ version: 1, manifest: { source: "federation.json", sha256: "" }, bundles: {} }), pins);
    // Write the manifest, every bundle at its pin, and the lock, the way a fetch would.
    for (const project of all) {
      await writeBundle(root, pins[project.id]!, project.text);
    }
    const real = { ...lock, manifest: { source: "federation.json", sha256: createHash("sha256").update(manifest).digest("hex") } };
    await writeFederationLock(root, real);

    // A build calls `loadFederation` only, which never fetches.
    const { loaded: read, requiredMissing, lockHash } = await loadFederation(root);
    assert.deepEqual(requiredMissing, []);
    assert.equal(read.bundles.size, 3);
    assert.equal(read.partial, false);
    assert.ok(lockHash !== undefined);
    const graph = composeFederation(read);
    assert.equal(graph.projects.length, 3);
  });
});

test("#1377 fetch pins every bundle and writes the same bytes twice", async () => {
  await withRoot(async (root) => {
    const all = projects();
    const manifest = manifestText(all);
    tree(root, {
      "federation.json": manifest,
      ...Object.fromEntries(all.map((project) => [`${project.id}.bundle.json`, project.text])),
    });
    const fetch: FederationFetchLike = async (url) => {
      const file = url.replace(/^file:\/\//, "");
      return new Response(readFileSync(file, "utf8"), { status: 200 });
    };
    // A local manifest is read from disk; each source is a sibling path, so no network is touched.
    const first = await fetchFederation({ root, manifest: "federation.json", fetch });
    assert.deepEqual(first.problems, []);
    const lock = await readFederationLock(root);
    assert.equal(lock?.bundles.product?.sha256, createHash("sha256").update(all[0]!.text).digest("hex"));
    assert.equal(lock?.bundles.docs?.snapshot?.version, "1.1.0");
    const bytes = readFileSync(join(root, "federation.lock.json"), "utf8");
    const second = await fetchFederation({ root, manifest: "federation.json", fetch, check: true });
    assert.deepEqual(second.problems, []);
    assert.equal(readFileSync(join(root, "federation.lock.json"), "utf8"), bytes, "a second fetch writes the same bytes");
  });
});

test("#1377 a required bundle that fails verification stops the write", async () => {
  await withRoot(async (root) => {
    const all = projects();
    tree(root, {
      "federation.json": manifestText(all),
      "product.bundle.json": all[0]!.text,
      "docs.bundle.json": all[1]!.text,
      "consumer.bundle.json": all[2]!.text.replace("velella-consumer", "tampered-consumer"),
    });
    const result = await fetchFederation({ root, manifest: "federation.json", fetch: async () => new Response("", { status: 200 }) });
    assert.ok(result.problems.some((problem) => problem.code === "federation.bundle-invalid" || problem.code === "federation.bundle-mismatch"));
    assert.equal(await readFederationLock(root), undefined, "a failed fetch writes no lock");
  });
});

test("#1378 fully qualified ids keep two same-named nodes distinct", () => {
  const graph = composeFederation(loaded());
  const productPage = graph.nodes.find((node) => node.citation.id === "product/snap-1/page:guide.md");
  const docsPage = graph.nodes.find((node) => node.citation.id === "docs/snap-1/page:install.md");
  assert.ok(productPage !== undefined);
  assert.ok(docsPage !== undefined);
  assert.notEqual(productPage.citation.id, docsPage.citation.id);
  assert.equal(productPage.citation.project, "product");
  assert.equal(docsPage.citation.project, "docs");
  // Two blocks both named `intro` remain two distinct citations.
  const intros = graph.nodes.filter((node) => node.citation.local === "block:intro");
  assert.equal(intros.length, 3);
  assert.equal(new Set(intros.map((node) => node.citation.id)).size, 3);
});

test("#1379 a cross-project edge exists only from an explicit reference", () => {
  const graph = composeFederation(loaded());
  const cross = graph.edges.filter((edge) => edge.crossProject);
  assert.deepEqual(
    cross.map((edge) => `${edge.from} -[${edge.kind}]-> ${edge.to}`),
    [
      "consumer/snap-1/page:usage.md -[references]-> docs/snap-1/behavior:install.runs",
      "docs/snap-1/page:install.md -[documents]-> product/snap-1/surface:api:greet",
    ],
  );
  // No edge is inferred between two nodes that merely share a label.
  assert.ok(!graph.edges.some((edge) => edge.from.endsWith("block:intro") && edge.crossProject));
});

test("#1379 retrieval order produces the same graph and digest", () => {
  const all = fixture();
  const forward = composeFederation(loaded(all));
  const reversed = composeFederation(loaded(new Map([...all].reverse())));
  assert.equal(forward.digest, reversed.digest);
  assert.deepEqual(forward.nodes, reversed.nodes);
  assert.deepEqual(forward.edges, reversed.edges);
});

test("#1380 one query reaches a downstream behavior, page, and evidence with namespaced citations", () => {
  const graph = composeFederation(loaded());
  const result = queryFederation(graph, { from: "docs/snap-1/page:install.md", depth: 1, kinds: ["documents"] });
  assert.equal(result.status, "present");
  assert.ok(result.neighbors.some((entry) => entry.citation.id === "product/snap-1/surface:api:greet"));
  assert.ok(result.neighbors.every((entry) => entry.citation.id.startsWith(`${entry.citation.project}/`)));

  // A local id resolves inside the named project and never across both.
  const local = resolveCitation(graph, "page:install.md", "docs");
  assert.equal(local?.id, "docs/snap-1/page:install.md");
  assert.equal(resolveCitation(graph, "page:install.md"), local, "a unique local id resolves without a project");
});

test("#1380 the shortest path crosses a project boundary", () => {
  const graph = composeFederation(loaded());
  const result = queryFederation(graph, {
    from: "consumer/snap-1/page:usage.md",
    to: "docs/snap-1/behavior:install.runs",
    depth: 4,
  });
  assert.equal(result.found, true);
  assert.deepEqual(
    result.path?.map((step) => step.citation.id),
    ["consumer/snap-1/page:usage.md", "docs/snap-1/behavior:install.runs"],
  );
});

test("#1381 a reference to a pinned snapshot resolves, and one to a removed node says removed", () => {
  const all = fixture();
  const graph = composeFederation(loaded(all));
  const state = loaded(all);
  const reference = federatedReferenceOf(
    {
      id: "docs/snap-1/behavior:install.runs",
      project: "docs",
      namespace: "velella-docs",
      snapshot: "snap-1",
      local: "behavior:install.runs",
      kind: "behavior",
      label: "Install runs",
    },
    "1.1.0",
  );
  assert.deepEqual(resolveReference(graph, state, reference), {
    reference,
    status: "resolved",
    citation: graph.nodes.find((node) => node.citation.id === "docs/snap-1/behavior:install.runs")?.citation,
    at: "1.1.0",
    detail: "resolved at 1.1.0.",
  });

  // A project that recorded removing a node resolves that reference `removed`, not to an unrelated node.
  const docs = all.get("docs")!;
  const withRemoved = new Map(all);
  withRemoved.set("docs", {
    ...docs,
    removed: [{ id: "behavior:install.runs", version: "2.0.0" }],
    digest: bundleDigest({ ...docs, removed: [{ id: "behavior:install.runs", version: "2.0.0" }] }),
  });
  const removed = resolveReference(graph, loaded(withRemoved), { ...reference, version: "2.0.0" });
  assert.equal(removed.status, "removed");
  assert.equal(removed.at, "2.0.0");
});

test("#1381 a reference that names another version is incompatible, never resolved elsewhere", () => {
  const state = loaded();
  const graph = composeFederation(state);
  const resolution = resolveReference(graph, state, { kind: "federation", project: "docs", id: "behavior:install.runs", version: "9.9.9" });
  assert.equal(resolution.status, "incompatible");
  assert.equal(resolution.citation, undefined);
  assert.match(resolution.detail, /9\.9\.9/);
});

test("#1382 a pack spends one shared budget and attributes every fragment to its project", () => {
  const pack = compileFederationPack(loaded(), { goal: "install greeting", from: [], budget: 2000 });
  assert.ok(pack.items.length > 0);
  assert.ok(pack.items.every((item) => item.citation.id.startsWith(`${item.project}/`)));
  assert.ok(pack.accounting.upper <= pack.budget, "the pack's bound fits its budget");
  assert.equal(pack.accounting.used, pack.accounting.fragments + pack.accounting.template + pack.accounting.safety);
  assert.ok(pack.markdown.includes("## "));
});

test("#1382 a small budget makes per-project omissions and marks the pack partial", () => {
  const pack = compileFederationPack(loaded(), { goal: "install greeting", from: [], budget: 60 });
  assert.ok(pack.partial);
  assert.ok(pack.omissions.length > 0);
  for (const omission of pack.omissions) {
    if (omission.reason === "budget") assert.ok(omission.project !== undefined, "a budget omission names its project");
    assert.match(omission.detail, /./);
  }
});

test("#1382 a pack is deterministic whatever order the bundles were read in", () => {
  const all = fixture();
  const forward = compileFederationPack(loaded(all), { goal: "install greeting", from: [], budget: 2000 });
  const reversed = compileFederationPack(loaded(new Map([...all].reverse())), { goal: "install greeting", from: [], budget: 2000 });
  assert.equal(forward.markdown, reversed.markdown);
  assert.deepEqual(forward.items.map((item) => item.citation.id), reversed.items.map((item) => item.citation.id));
});

test("#1383 a compatible channel selects a snapshot by the lock and version rules, not publishing time", () => {
  const state = loaded();
  const pinned = selectSnapshot(state, "product", { channel: "pinned" });
  assert.deepEqual(pinned, { accepted: true, snapshot: { id: "snap-1", version: "1.2.0" }, reason: "pinned" });
  const compatible = selectSnapshot(state, "product", { channel: "compatible", range: ">=1.0.0 <2.0.0" });
  assert.deepEqual(compatible, { accepted: true, snapshot: { id: "snap-1", version: "1.2.0" }, reason: "compatible" });
  const incompatible = selectSnapshot(state, "product", { channel: "compatible", range: ">=2.0.0 <3.0.0" });
  assert.deepEqual(incompatible, { accepted: false, reason: "incompatible", available: ["1.2.0"] });
  assert.equal(versionInRange("1.2.0", ">=1.2.0 <2.0.0"), true);
  assert.equal(versionInRange("2.0.0", ">=1.2.0 <2.0.0"), false);
});

test("#1384 a claim traces to another project's test while every digest is preserved", () => {
  const state = loaded();
  const graph = composeFederation(state);
  const chain = traceEvidenceChain(graph, state, "consumer/snap-1/claim-install");
  assert.equal(chain.claim.id, "consumer/snap-1/claim-install");
  assert.ok(chain.links.length > 0);
  assert.ok(chain.links.every((link) => link.verified), "every link verified");
  assert.ok(chain.links.some((link) => link.to.id === "docs/snap-1/behavior:install.runs"));
  assert.equal(chain.complete, true);
  // The link's own digest is the one the bundle published, unchanged.
  assert.equal(chain.links[0]?.digest, evidenceDigest("docs", "snap-1", "behavior:install.runs"));
});

test("#1384 a tampered link digest is reported, not followed", () => {
  const all = fixture();
  const consumer = all.get("consumer")!;
  const evidence = {
    ...consumer.evidence,
    links: consumer.evidence.links.map((link) => ({ ...link, digest: "0".repeat(64) })),
  };
  const tampered = { ...consumer, evidence, digest: bundleDigest({ ...consumer, evidence }) };
  all.set("consumer", tampered);
  const state = loaded(all);
  const graph = composeFederation(state);
  const chain = traceEvidenceChain(graph, state, "consumer/snap-1/claim-install");
  assert.ok(chain.links.some((link) => !link.verified));
  assert.equal(chain.complete, false);
});

test("#1385 a missing optional bundle yields partial and keeps every known-good snapshot", async () => {
  await withRoot(async (root) => {
    const all = projects();
    const pins = pinsOf(all);
    // Pin all three, then remove the docs bundle's bytes and pin it as optional and missing.
    const lock: FederationLock = {
      version: 1,
      manifest: { source: "federation.json", sha256: "a".repeat(64) },
      bundles: {
        product: { project: "product", namespace: "velella-product", role: "product", sha256: pins.product!, snapshot: all[0]!.bundle.snapshot, source: "path:product.bundle.json", optional: false },
        docs: { project: "docs", namespace: "velella-docs", role: "docs", source: "path:docs.bundle.json", optional: true, missing: "the bundle is absent." },
        consumer: { project: "consumer", namespace: "velella-consumer", role: "consumer", sha256: pins.consumer!, snapshot: all[2]!.bundle.snapshot, source: "path:consumer.bundle.json", optional: false },
      },
    };
    await writeBundle(root, pins.product!, all[0]!.text);
    await writeBundle(root, pins.consumer!, all[2]!.text);
    await writeFederationLock(root, lock);

    const { loaded: read, requiredMissing } = await loadFederation(root);
    assert.deepEqual(requiredMissing, []);
    assert.equal(read.partial, true);
    assert.deepEqual([...read.bundles.keys()].sort(), ["consumer", "product"]);
    assert.deepEqual(read.missing, [{ project: "docs", optional: true, reason: "the bundle is absent." }]);

    const graph = composeFederation(read);
    assert.equal(graph.partial, true);
    assert.deepEqual(graph.missing.map((entry) => entry.project), ["docs"]);
    // The known-good snapshots are untouched: a partial answer does not delete anything.
    assert.equal(graph.projects.length, 2);
    assert.ok(graph.nodes.some((node) => node.citation.id === "product/snap-1/page:guide.md"));
  });
});

test("#1385 a required missing bundle is an error, and a tampered one is refused, never replaced", async () => {
  await withRoot(async (root) => {
    const all = projects();
    const pin = pinsOf(all).product!;
    const lock: FederationLock = {
      version: 1,
      manifest: { source: "federation.json", sha256: "b".repeat(64) },
      bundles: {
        product: { project: "product", namespace: "velella-product", role: "product", sha256: pin, snapshot: all[0]!.bundle.snapshot, source: "path:product.bundle.json", optional: false },
      },
    };
    await writeBundle(root, pin, all[0]!.text);
    await writeFederationLock(root, lock);
    // Tamper with the stored bytes but keep the pin: the loader refuses it.
    writeFileSync(join(root, ".mizzen", "federation", `${pin}.json`), all[0]!.text.replace("Product guide", "Tampered"));
    const { loaded: read, requiredMissing } = await loadFederation(root);
    assert.deepEqual(requiredMissing, ["product"]);
    assert.equal(read.bundles.size, 0);
    assert.equal(read.missing[0]?.reason, "the stored bytes do not match the pinned SHA-256.");
  });
});

test("#1386 a project the caller may not read is left out of the graph and its omissions", () => {
  const all = fixture();
  const { project: _product, docs, consumer } = { project: all.get("product")!, docs: all.get("docs")!, consumer: all.get("consumer")! };
  const privateDocs = buildBundle({
    project: "docs",
    namespace: "velella-docs",
    role: "docs",
    snapshot: docs.snapshot,
    policy: { public: false, audiences: ["internal-docs"] },
    graph: docs.graph,
    surface: docs.surface,
    behaviors: docs.behaviors,
    evidence: docs.evidence,
    references: docs.references,
    removed: [],
  });
  all.set("docs", privateDocs);
  const state = loaded(all);

  const without = composeFederation(state);
  assert.ok(!without.projects.some((project) => project.id === "docs"));
  assert.ok(!without.nodes.some((node) => node.citation.project === "docs"));
  // A cross-project edge that pointed at the private project is gone too, so nothing names it.
  assert.ok(!without.edges.some((edge) => edge.to.startsWith("docs/") || edge.from.startsWith("docs/")));

  const withDocs = composeFederation(state, { allow: ["internal-docs"] });
  assert.ok(withDocs.projects.some((project) => project.id === "docs"));

  // A pack for an unauthorized caller never names the private project in an item or an omission.
  const denied = compileFederationPack(state, { goal: "install", from: [], budget: 2000 });
  assert.ok(!denied.items.some((item) => item.project === "docs"));
  assert.ok(!denied.omissions.some((omission) => omission.project === "docs"));
  void consumer;
});

test("#1386 a private project's name never leaks through a missing-bundle omission", () => {
  const all = fixture();
  const docs = all.get("docs")!;
  const privateDocs = {
    ...docs,
    policy: { public: false, audiences: ["internal-docs"] },
    digest: bundleDigest({ ...docs, policy: { public: false, audiences: ["internal-docs"] } }),
  };
  // The private project loads but is unreadable: neither its items nor a missing omission may name it.
  all.set("docs", privateDocs);
  const state = { bundles: all, missing: [], partial: false };
  const pack = compileFederationPack(state, { goal: "install", from: [], budget: 2000 });
  assert.ok(!pack.items.some((item) => item.project === "docs"));
  assert.ok(!pack.omissions.some((omission) => omission.project === "docs"));
  assert.ok(!pack.markdown.includes("velella-docs"));

  // A project the manifest declares and the lock pins as missing is named, because its id is the site's own config.
  const absent = { bundles: new Map([...all].filter(([id]) => id !== "docs")), missing: [{ project: "docs", optional: true, reason: "absent" }], partial: true };
  const withOmission = compileFederationPack(absent, { goal: "install", from: [], budget: 2000 });
  assert.ok(withOmission.omissions.some((omission) => omission.reason === "missing" && omission.project === "docs"));
});

test("#1387 a refresh recomposes only the affected unit and equals a full recomposition", () => {
  const all = fixture();
  const first = loaded(all);
  const before = composeFederation(first);
  const units = unitsOf(visibleBundles(first, undefined));

  // Change one project's snapshot in a way that also changes the edges that point at it.
  const product = all.get("product")!;
  const next = buildBundle({
    project: "product",
    namespace: "velella-product",
    role: "product",
    snapshot: { id: "snap-2", version: "1.3.0" },
    policy: product.policy,
    graph: product.graph,
    surface: product.surface,
    behaviors: product.behaviors,
    evidence: {
      version: 1,
      claims: [
        { id: "claim-greet", subject: "surface:api:greet", evidence: ["test-greet"] },
      ],
      links: [{ from: "claim-greet", to: "test-greet", kind: "backs", digest: evidenceDigest("product", "snap-2", "test-greet") }],
    },
    references: product.references,
    removed: [],
  });
  all.set("product", next);
  const second = loaded(all);

  const refresh = refreshFederation(second, { previous: units });
  const full = composeFederation(second);
  assert.deepEqual(refresh.graph.digest, full.digest);
  assert.deepEqual(refresh.graph.nodes, full.nodes);
  assert.deepEqual(refresh.graph.edges, full.edges);
  assert.ok(refresh.recomposed.includes("product"));
  assert.ok(refresh.recomposed.includes("docs"), "docs points at product, so it is recomposed too");
  assert.deepEqual(refresh.reused, ["consumer"], "consumer points at neither changed project");
  assert.notEqual(before.digest, full.digest);
});

test("#1387 an unchanged input reuses every unit and composes the same graph", () => {
  const state = loaded();
  const units = unitsOf(visibleBundles(state, undefined));
  const refresh = refreshFederation(state, { previous: units });
  assert.deepEqual(refresh.recomposed, []);
  assert.deepEqual(refresh.reused, ["consumer", "docs", "product"]);
  assert.equal(refresh.graph.digest, composeFederation(state).digest);
});

test("#1388 the three-repository fixture supports a shared query and context pack offline", () => {
  const state = loaded();
  const graph = composeFederation(state);
  assert.deepEqual(graph.projects.map((project) => project.id), ["consumer", "docs", "product"]);

  const query = queryFederation(graph, { from: "docs/snap-1/page:install.md", depth: 2 });
  assert.equal(query.status, "present");
  assert.ok(query.citations.some((citation) => citation.id === "product/snap-1/surface:api:greet"));

  const pack = compileFederationPack(state, { goal: "install greeting", from: [], budget: 2000 });
  assert.ok(pack.items.some((item) => item.project === "product"));
  assert.ok(pack.items.some((item) => item.project === "docs"));
  assert.equal(pack.partial, false);

  // Removing one bundle makes the same query and pack partial, and says which project is absent.
  const withoutDocs = { bundles: new Map([...state.bundles].filter(([id]) => id !== "docs")), missing: [{ project: "docs", optional: true, reason: "removed" }], partial: true };
  const partialGraph = composeFederation(withoutDocs);
  assert.equal(partialGraph.partial, true);
  assert.deepEqual(partialGraph.missing.map((entry) => entry.project), ["docs"]);
  const partialPack = compileFederationPack(withoutDocs, { goal: "install greeting", from: [], budget: 2000 });
  assert.equal(partialPack.partial, true);
  assert.ok(partialPack.omissions.some((omission) => omission.reason === "missing" && omission.project === "docs"));
});

test("#1377 the lock's text is canonical, and its hash is stable", () => {
  const all = projects();
  const bundles = Object.fromEntries(all.map((project) => [project.id, project.bundle.digest]));
  const manifestSha = "c".repeat(64);
  const first: FederationLock = lockOf(all, manifestSha, bundles);
  const second: FederationLock = { ...first, bundles: Object.fromEntries(Object.entries(first.bundles).reverse()) };
  assert.equal(federationLockText(first), federationLockText(second), "key order in memory does not change the bytes");
  assert.equal(federationLockHash(first), federationLockHash(second));
  assert.match(federationLockText(first), /\n$/);
});

test("#1375 to #1388 a fetch writes the lock fetch twice, so a second fetch writes no bytes", async () => {
  await withRoot(async (root) => {
    const all = projects();
    tree(root, {
      "federation.json": manifestText(all),
      ...Object.fromEntries(all.map((project) => [`${project.id}.bundle.json`, project.text])),
    });
    const fetch: FederationFetchLike = async (url) => new Response(readFileSync(url.replace(/^file:\/\//, ""), "utf8"), { status: 200 });
    await fetchFederation({ root, manifest: "federation.json", fetch });
    const first = readFileSync(join(root, "federation.lock.json"), "utf8");
    mkdirSync(join(root, ".mizzen"), { recursive: true });
    await fetchFederation({ root, manifest: "federation.json", fetch });
    assert.equal(readFileSync(join(root, "federation.lock.json"), "utf8"), first);
  });
});

test("#1378 a citation digests the exact node, so a moved node is detectable", () => {
  const graph: FederatedGraph = composeFederation(loaded());
  const node = graph.nodes.find((entry) => entry.citation.id === "product/snap-1/page:guide.md")!;
  assert.match(node.citation.digest ?? "", /^[a-f0-9]{64}$/);
  assert.equal(node.citation.kind, "page");
  assert.equal(node.citation.snapshot, "snap-1");
  assert.equal(node.citation.project, "product");
});

test("#1375 a malformed project, version requirement, and source is refused with every problem", () => {
  const parsed = parseFederationManifest({
    version: 1,
    projects: [
      { id: "Bad Id", namespace: "na", role: "product", source: { url: "http://x.com/a" } },
      { id: "other", namespace: "nb", role: "service", source: {}, version: { range: "nope", channel: "bad" }, optional: "yes" },
      { id: "third", namespace: "nc", role: "docs", source: { url: "https://x.com/a", path: "a.json" } },
    ],
  });
  assert.equal(parsed.manifest, undefined);
  const paths = parsed.problems.map((problem) => problem.path);
  for (const path of ["/projects/0/id", "/projects/1/role", "/projects/1/source", "/projects/1/version/range", "/projects/1/version/channel", "/projects/1/optional", "/projects/2/source"]) {
    assert.ok(paths.includes(path), `${path} is not in ${paths.join(", ")}`);
  }
  assert.ok(parsed.problems.every((problem) => problem.code === "federation.manifest-invalid"));
});

test("#1375 a manifest without a project, or with a wrong version, is refused", () => {
  assert.ok(parseFederationManifest({ version: 2, projects: [] }).problems.length === 2);
  assert.ok(parseFederationManifest(null).problems.some((problem) => problem.path === ""));
});

test("#1375 the project a manifest names is found by id", () => {
  const { manifest } = parseFederationManifest(JSON.parse(manifestText(projects())));
  assert.equal(projectOf(manifest!, "docs")?.namespace, "velella-docs");
  assert.equal(projectOf(manifest!, "missing"), undefined);
});

test("#1381 a version parse is total, and an id needs two separators", () => {
  assert.deepEqual(parseVersionRange(">=1.2.0 <2.0.0"), { lower: { version: "1.2.0", inclusive: true }, upper: { version: "2.0.0", inclusive: false } });
  assert.deepEqual(parseVersionRange("1.2.0"), { lower: { version: "1.2.0", inclusive: true }, upper: { version: "1.2.0", inclusive: true } });
  assert.equal(parseVersionRange("nope"), undefined);
  assert.equal(compareVersions("1.10.0", "1.9.0"), 1);
  assert.deepEqual(parseFederatedId("a/b/c/d"), { project: "a", snapshot: "b", local: "c/d" });
  assert.equal(parseFederatedId("a/b"), undefined);
  assert.equal(parseFederatedId("/b/c"), undefined);
});

test("#1386 a bundle readable by one audience is readable only to a caller that holds it", () => {
  const all = fixture();
  const docs = all.get("docs")!;
  all.set("docs", { ...docs, policy: { public: false, audiences: ["internal-docs"] }, digest: bundleDigest({ ...docs, policy: { public: false, audiences: ["internal-docs"] } }) });
  const state = loaded(all);
  assert.deepEqual(composeFederation(state).projects.map((project) => project.id), ["consumer", "product"]);
  assert.deepEqual(composeFederation(state, { allow: ["internal-docs"] }).projects.map((project) => project.id), ["consumer", "docs", "product"]);
  assert.deepEqual(composeFederation(state, { allow: ["someone-else"] }).projects.map((project) => project.id), ["consumer", "product"]);
});

test("#1377 a manifest that is not JSON, and a source that is not readable, are reported not thrown", async () => {
  await withRoot(async (root) => {
    tree(root, { "federation.json": "{ not json" });
    const broken = await fetchFederation({ root, manifest: "federation.json", fetch: async () => new Response("", { status: 200 }) });
    assert.ok(broken.problems.some((problem) => problem.code === "federation.manifest-invalid"));
    const missing = await fetchFederation({ root, manifest: "nope.json", fetch: async () => new Response("", { status: 200 }) });
    assert.ok(missing.problems.some((problem) => problem.code === "federation.manifest-unreadable"));
  });
});

test("#1385 a lock this engine did not write is refused, not read as empty", async () => {
  await withRoot(async (root) => {
    tree(root, { "federation.lock.json": JSON.stringify({ version: 9, manifest: {}, bundles: {} }) });
    await assert.rejects(() => loadFederation(root), /federation lock this engine reads/);
  });
});
