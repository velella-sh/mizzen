/**
 * The federation contracts are published as strict JSON Schemas: a `knowledge.bundle.json` a repository publishes, and
 * the `federation.lock.json` a build reads. The fixture's real bundle and lock validate, and each schema refuses a
 * document that drops a required field or adds an unknown one, so a publisher and a reader cannot drift silently.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import { lockOf, manifestText, projects } from "./federation-fixture.ts";
import { federationLockText } from "../src/federation/lock.ts";

const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;

/** The compiled validator of one schema, resolving the graph and surface schemas from disk. */
function validator(name: string): (value: unknown) => boolean {
  const schema = JSON.parse(readFileSync(new URL(`../schema/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;
  const graph = JSON.parse(readFileSync(new URL("../schema/graph.schema.json", import.meta.url), "utf8")) as object;
  const surface = JSON.parse(readFileSync(new URL("../schema/surface-report.schema.json", import.meta.url), "utf8")) as object;
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajv.addSchema(graph);
  ajv.addSchema(surface);
  const validate = ajv.compile(schema);
  return (value: unknown): boolean => validate(value) === true;
}

test("the lock schema accepts the committed lock and refuses an unknown field", () => {
  const all = projects();
  const lock = lockOf(all, "d".repeat(64), Object.fromEntries(all.map((project) => [project.id, project.bundle.digest])));
  const validate = validator("federation-lock.schema.json");
  assert.equal(validate(JSON.parse(federationLockText(lock))), true);
  assert.equal(validate({ ...lock, extra: true }), false);
  assert.equal(validate({ version: 1, manifest: lock.manifest }), false, "a lock without bundles is refused");
});

test("the bundle schema accepts every fixture bundle and refuses a body without a digest", () => {
  const validate = validator("knowledge-bundle.schema.json");
  for (const project of projects()) {
    const bundle = JSON.parse(project.text) as Record<string, unknown>;
    assert.equal(validate(bundle), true, `${project.id}: ${JSON.stringify((validate as unknown as { errors?: unknown }).errors ?? "")}`);
    const { digest: _digest, ...withoutDigest } = bundle;
    assert.equal(validate(withoutDigest), false, "a bundle without a digest is refused");
    assert.equal(validate({ ...bundle, extra: true }), false, "an unknown field is refused");
  }
});

test("a bundle whose policy is private still validates, with the audiences it names", () => {
  const validate = validator("knowledge-bundle.schema.json");
  const [product] = projects();
  const bundle = JSON.parse(product!.text) as Record<string, unknown>;
  assert.equal(validate({ ...bundle, policy: { public: false, audiences: ["internal-docs"] } }), true);
  assert.equal(validate({ ...bundle, policy: { public: false, audiences: [""] } }), false, "an empty audience is refused");
});

test("the manifest the fixture publishes is the one the lock names", () => {
  const all = projects();
  const manifest = manifestText(all);
  assert.match(manifest, /"version": 1/);
  assert.ok(manifest.includes('"product"') && manifest.includes('"docs"') && manifest.includes('"consumer"'));
});
