import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CLIENT_ADAPTERS,
  CLIENTS,
  checkClientContractVersion,
  clientConfig,
  clientConfigValue,
  clientReport,
  detectClient,
  envReference,
  fallbacksOf,
  readSkillPackage,
  redactClientConfig,
  resolveEnvReferences,
  supportedClients,
  validateClientDescriptor,
} from "../src/clients/index.ts";
import type { ClientCapabilities } from "../src/contracts/clients.ts";

const SKILL = fileURLToPath(new URL("../skills/mizzen-client/", import.meta.url));

const full: ClientCapabilities = {
  tools: true,
  resources: true,
  notifications: true,
  progress: true,
  longRunningTasks: true,
  approvals: true,
  editing: true,
  cursors: true,
};

const limited: ClientCapabilities = {
  tools: true,
  resources: false,
  notifications: false,
  progress: false,
  longRunningTasks: false,
  approvals: false,
  editing: false,
  cursors: false,
};

test("every shipped adapter validates and shares the protocol list", () => {
  assert.equal(CLIENT_ADAPTERS.length, 4);
  for (const descriptor of CLIENT_ADAPTERS) {
    const checked = validateClientDescriptor(descriptor);
    assert.deepEqual(checked.problems, [], descriptor.id);
    assert.equal(checked.descriptor?.config.format, "mcp-json");
    assert.equal(CLIENTS[descriptor.id as keyof typeof CLIENTS], descriptor.config.key);
  }
  assert.deepEqual(supportedClients, CLIENT_ADAPTERS.map((adapter) => adapter.id));
});

test("validation locates every problem instead of guessing", () => {
  const source = CLIENT_ADAPTERS[0]!;
  const broken = {
    ...source,
    id: "Bad Id",
    transport: "http",
    capabilities: { ...source.capabilities, editing: "yes", teleport: true },
    config: { ...source.config, key: "" },
  };
  const checked = validateClientDescriptor(broken);
  assert.equal(checked.descriptor, undefined);
  const paths = checked.problems.map((problem) => problem.path);
  for (const path of ["/id", "/transport", "/capabilities/editing", "/capabilities/teleport", "/config/key"]) {
    assert.ok(paths.includes(path), `${path} in ${paths.join(", ")}`);
  }
  const notObject = validateClientDescriptor([]);
  assert.equal(notObject.problems[0]?.code, "client.not-object");
});

test("a version is accepted, migrated when absent, and never guessed", () => {
  assert.deepEqual(checkClientContractVersion(1), { version: 1, migrated: false, problems: [] });
  const legacy = checkClientContractVersion(undefined);
  assert.equal(legacy.version, 1);
  assert.equal(legacy.migrated, true);
  assert.equal(legacy.problems.length, 0);
  const newer = checkClientContractVersion(2);
  assert.equal(newer.version, undefined);
  assert.match(newer.problems[0]!.message, /newer than the supported version 1/);
  const text = checkClientContractVersion("1");
  assert.equal(text.problems[0]?.code, "client.version-invalid");
  assert.equal(checkClientContractVersion(0).problems[0]?.code, "client.version-invalid");
});

test("one shared contract generates each client's configuration with no secret", () => {
  const before = process.env.MIZZEN_TOKEN;
  process.env.MIZZEN_TOKEN = "sk-live-abcdefghijklmnop";
  try {
    for (const id of supportedClients) {
      const text = clientConfig(id, "my/site", true);
      const config = JSON.parse(text);
      const key = CLIENTS[id];
      assert.deepEqual(Object.keys(config), [key]);
      assert.deepEqual(config[key].mizzen.args, ["-y", "@velella/mizzen", "mcp", "my/site", "--allow-edits"]);
      assert.equal(config[key].mizzen.command, "npx");
      assert.equal(text, clientConfig(id, "my/site", true), "the same input gives the same bytes");
      assert.ok(!text.includes("sk-live-abcdefghijklmnop"));
      assert.equal(JSON.stringify(clientConfigValue(id, ".", false)).includes("--allow-edits"), false);
    }
  } finally {
    if (before === undefined) delete process.env.MIZZEN_TOKEN;
    else process.env.MIZZEN_TOKEN = before;
  }
});

test("redaction and environment references keep secrets out of logs and files", () => {
  const redacted = redactClientConfig({
    headers: { Authorization: "Bearer sk-live-abcdefghijklmnop", Accept: "application/json" },
    env: { MIZZEN_TOKEN: "${MIZZEN_TOKEN}", OTHER: "plain" },
  });
  assert.deepEqual(redacted, {
    env: { MIZZEN_TOKEN: "${MIZZEN_TOKEN}", OTHER: "plain" },
    headers: { Accept: "application/json", Authorization: "[redacted]" },
  });
  assert.equal(envReference("MIZZEN_TOKEN"), "${MIZZEN_TOKEN}");
  assert.throws(() => envReference("bad-name"));
  const resolved = resolveEnvReferences("Authorization: Bearer ${MIZZEN_TOKEN}; ${OTHER}", { MIZZEN_TOKEN: "secret-value" }, ["MIZZEN_TOKEN"]);
  assert.equal(resolved.text, "Authorization: Bearer secret-value; ${OTHER}");
  assert.deepEqual(resolved.missing, []);
  assert.deepEqual(resolveEnvReferences("${MIZZEN_TOKEN}", {}, ["MIZZEN_TOKEN"]), { text: "${MIZZEN_TOKEN}", missing: ["MIZZEN_TOKEN"] });
});

test("fallbacks name what happens instead and why", () => {
  assert.deepEqual(fallbacksOf(full), []);
  const fallbacks = fallbacksOf(limited);
  assert.deepEqual(
    fallbacks.map((fallback) => fallback.capability),
    ["resources", "notifications", "progress", "long-running-tasks", "approvals", "editing", "cursors"],
  );
  for (const fallback of fallbacks) {
    assert.ok(fallback.fallback.length > 20, fallback.capability);
    assert.ok(fallback.reason.length > 20, fallback.capability);
  }
  assert.match(fallbacks.find((fallback) => fallback.capability === "editing")!.fallback, /propose_edit/);
  assert.match(fallbacks.find((fallback) => fallback.capability === "cursors")!.fallback, /nextOffset/);
});

test("a hello upgrades standard capabilities and applies a declared block", () => {
  const profile = detectClient({
    protocolVersion: "2025-06-18",
    clientInfo: { name: "claude-code", version: "1" },
    capabilities: {
      tasks: { requests: { tools: { call: {} } } },
      elicitation: {},
      experimental: { mizzen: { contractVersion: 1, capabilities: { resources: true, notifications: true, progress: true, editing: true, cursors: true } } },
    },
  });
  assert.equal(profile.client.id, "claude-code");
  assert.equal(profile.capabilities.longRunningTasks, true);
  assert.equal(profile.capabilities.approvals, true);
  assert.deepEqual(profile.fallbacks, []);
  assert.deepEqual(profile.problems, []);
  assert.match(clientReport(profile), /all declared capabilities available/);

  const downgraded = detectClient({
    clientInfo: { name: "minimal-agent" },
    capabilities: { experimental: { mizzen: { contractVersion: 1, capabilities: limited } } },
  });
  assert.equal(downgraded.client.id, "generic");
  assert.equal(downgraded.capabilities.editing, false);
  assert.equal(downgraded.fallbacks.length, 7);
  assert.match(clientReport(downgraded), /unavailable:/);
});

test("an unreadable hello block is reported, not guessed, and a legacy block migrates", () => {
  const unknown = detectClient({
    clientInfo: { name: "cursor" },
    capabilities: { experimental: { mizzen: { contractVersion: 2, capabilities: limited } } },
  });
  assert.equal(unknown.capabilities.editing, true, "the version 1 default was kept");
  assert.equal(unknown.capabilities.progress, false);
  assert.equal(unknown.problems[0]?.code, "client.version-newer");
  assert.match(unknown.problems[0]!.path, /^\/capabilities\/experimental\/mizzen\/contractVersion$/);

  const legacy = detectClient({
    clientInfo: { name: "cursor" },
    capabilities: { experimental: { mizzen: { capabilities: { progress: true } } } },
  });
  assert.equal(legacy.migrated, true);
  assert.equal(legacy.capabilities.progress, true);

  const oldProtocol = detectClient({ protocolVersion: "1999-01-01", capabilities: {} });
  assert.equal(oldProtocol.protocolVersion, "2025-06-18");
  assert.equal(oldProtocol.problems[0]?.code, "client.protocol-version-fallback");
});

test("the installable skill verifies its version, files, and checksum", async () => {
  const pkg = await readSkillPackage(SKILL);
  assert.equal(pkg.manifest.name, "mizzen-client");
  assert.equal(pkg.manifest.version, 1);
  assert.deepEqual(pkg.manifest.contractVersions, [1]);
  assert.equal(pkg.checksum, pkg.manifest.checksum.value);
  for (const topic of ["Register the task", "Pack the context", "propose_edit", "apply_edit", "Verify", "Hand off", "_meta.mizzen", "nextOffset"]) {
    assert.ok(pkg.instructions.includes(topic), topic);
  }
  assert.doesNotMatch(pkg.instructions, /\/Users\/|\/home\/|[A-Za-z]:\\/);
});

test("a tampered or incomplete skill package is refused", async () => {
  const copy = mkdtempSync(join(tmpdir(), "skill-test-"));
  try {
    cpSync(SKILL, copy, { recursive: true });
    const original = await readSkillPackage(copy);
    writeFileSync(join(copy, "SKILL.md"), `${original.instructions}\n`, "utf8");
    await assert.rejects(readSkillPackage(copy), /checksum is .* but skill.json records/);
    rmSync(join(copy, "README.md"));
    await assert.rejects(readSkillPackage(copy), /which is missing/);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});
