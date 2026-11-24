/**
 * `mizzen federation` through the public CLI and the output unit: a site whose `mizzen.yml` declares the federation,
 * with the three fixture bundles pinned by `fetch` and read by every subcommand. Nothing here touches the network.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OutputContext } from "../src/contracts/output.ts";
import { buildModel } from "../src/model/build.ts";
import { federation as federationOutput } from "../src/outputs/federation.ts";
import { runFederation } from "../src/cli/federation.ts";
import { manifestText, pinsOf, projects, scratch, tree } from "./federation-fixture.ts";

/** A captured IO. */
function capture() {
  const logs: string[] = [];
  const errors: string[] = [];
  return { logs, errors, io: { log: (message: string) => logs.push(message), error: (message: string) => errors.push(message) } };
}

/** A site root with a config, a manifest, and every fixture bundle, pinned the way a fetch would. */
function siteRoot(): string {
  const root = scratch("federation-cli-");
  const all = projects();
  const pins = pinsOf(all);
  const config = [
    "title: Federated docs",
    "federation:",
    "  manifest: federation.json",
    "  project: docs",
    "",
  ].join("\n");
  tree(root, {
    "mizzen.yml": config,
    "federation.json": manifestText(all),
    ...Object.fromEntries(all.map((project) => [`${project.id}.bundle.json`, project.text])),
  });
  // The fetch subcommand pins the bundles; run it once so every other subcommand has a lock to read.
  return root;
}

/** Runs one subcommand and returns its exit code and output. */
async function run(root: string, args: readonly string[]): Promise<{ readonly status: number; readonly out: string; readonly errors: string }> {
  const { logs, errors, io } = capture();
  const status = await runFederation([args[0]!, root, ...args.slice(1)], io);
  return { status, out: logs.join("\n"), errors: errors.join("\n") };
}

test("federation fetch pins every bundle and status reports them", async () => {
  const root = siteRoot();
  try {
    const fetched = await run(root, ["fetch"]);
    assert.equal(fetched.status, 0, fetched.errors);
    assert.ok(existsSync(join(root, "federation.lock.json")));
    assert.match(fetched.out, /pinned product/);

    const status = await run(root, ["status", "--json"]);
    assert.equal(status.status, 0, status.errors);
    const report = JSON.parse(status.out) as { bundles: { project: string; snapshot: { version: string } }[]; partial: boolean };
    assert.deepEqual(report.bundles.map((bundle) => bundle.project), ["consumer", "docs", "product"]);
    assert.equal(report.partial, false);

    // A second check writes nothing and says the lock is up to date.
    const checked = await run(root, ["fetch", "--check"]);
    assert.equal(checked.status, 0, checked.errors);
    assert.match(checked.out, /up to date/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("federation graph, query, pack, chain, and resolve answer from the lock", async () => {
  const root = siteRoot();
  try {
    assert.equal((await run(root, ["fetch"])).status, 0);

    const graph = await run(root, ["graph"]);
    assert.equal(graph.status, 0, graph.errors);
    const composed = JSON.parse(graph.out) as { projects: { id: string }[]; digest: string; partial: boolean };
    assert.deepEqual(composed.projects.map((project) => project.id), ["consumer", "docs", "product"]);
    assert.equal(composed.partial, false);

    const query = await run(root, ["query", "--from", "docs/snap-1/page:install.md", "--depth", "1"]);
    assert.equal(query.status, 0, query.errors);
    const answer = JSON.parse(query.out) as { status: string; citations: { id: string }[] };
    assert.equal(answer.status, "present");
    assert.ok(answer.citations.some((citation) => citation.id === "product/snap-1/surface:api:greet"));

    const pack = await run(root, ["pack", "--goal", "install greeting", "--budget", "2000"]);
    assert.equal(pack.status, 0, pack.errors);
    assert.match(pack.out, /^# Federated context: install greeting/m);

    const chain = await run(root, ["chain", "--claim", "consumer/snap-1/claim-install", "--json"]);
    assert.equal(chain.status, 0, chain.errors);
    const traced = JSON.parse(chain.out) as { complete: boolean; links: { verified: boolean }[] };
    assert.equal(traced.complete, true);
    assert.ok(traced.links.every((link) => link.verified));

    const reference = join(root, "reference.json");
    writeFileSync(reference, `${JSON.stringify({ kind: "federation", project: "docs", id: "behavior:install.runs", version: "1.1.0", channel: "pinned" })}\n`);
    const resolved = await run(root, ["resolve", "--reference", reference]);
    assert.equal(resolved.status, 0, resolved.errors);
    assert.equal((JSON.parse(resolved.out) as { status: string }).status, "resolved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("federation graph is partial and names the missing project after its bundle is removed", async () => {
  const root = siteRoot();
  try {
    assert.equal((await run(root, ["fetch"])).status, 0);
    // Drop the docs bundle and pin it as optional and missing, the way a fetch of an unreachable optional project does.
    const lock = JSON.parse(readFileSync(join(root, "federation.lock.json"), "utf8")) as {
      version: 1;
      manifest: { source: string; sha256: string };
      bundles: Record<string, Record<string, unknown>>;
    };
    lock.bundles.docs = {
      project: "docs",
      namespace: "velella-docs",
      role: "docs",
      source: "path:docs.bundle.json",
      optional: true,
      missing: "the bundle is absent.",
    };
    writeFileSync(join(root, "federation.lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
    rmSync(join(root, "docs.bundle.json"));

    const graph = await run(root, ["graph"]);
    assert.equal(graph.status, 0, graph.errors);
    const composed = JSON.parse(graph.out) as { partial: boolean; missing: { project: string }[]; projects: { id: string }[] };
    assert.equal(composed.partial, true);
    assert.deepEqual(composed.missing.map((entry) => entry.project), ["docs"]);
    assert.deepEqual(composed.projects.map((project) => project.id), ["consumer", "product"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the federation output writes a record only when the config declares the key", async () => {
  const root = siteRoot();
  try {
    assert.equal((await run(root, ["fetch"])).status, 0);
    const model = await buildModel(root);
    const reported: unknown[] = [];
    const ctx: OutputContext = {
      renderPage: () => Promise.reject(new Error("the federation record never renders")),
      report: (diagnostic) => reported.push(diagnostic),
      build: { root, workers: 1 },
    };
    const files = await federationOutput.run(model.site, ctx);
    assert.equal(files.length, 1);
    const record = JSON.parse(String(files[0]!.contents)) as { partial: boolean; graph: string; bundles: { project: string }[] };
    assert.equal(record.partial, false);
    assert.match(record.graph, /^fed:/);
    assert.deepEqual(record.bundles.map((bundle) => bundle.project), ["consumer", "docs", "product"]);
    assert.deepEqual(reported, []);

    // A site without the key writes nothing.
    const plain = scratch("federation-plain-");
    try {
      mkdirSync(plain, { recursive: true });
      writeFileSync(join(plain, "mizzen.yml"), "title: Plain\n");
      const plainModel = await buildModel(plain);
      assert.deepEqual(await federationOutput.run(plainModel.site, { renderPage: ctx.renderPage, report: () => {} }), []);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
