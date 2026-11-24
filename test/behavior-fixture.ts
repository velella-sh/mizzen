/**
 * Fixtures for the behavior-contract tests: a small site whose public surface is one package entry, whose docs page
 * declares behaviors, and whose `test/` files are excluded from content discovery.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Writes `files` under a fresh temporary folder and returns it. */
export function behaviorTree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "behavior-contracts-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Indents every non-empty line of `text` by `spaces`, keeping blank lines empty. */
export function indent(text: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.trim() === "" ? line : `${prefix}${line}`))
    .join("\n");
}

/** A docs page that declares `entries` under `behavior:` and documents `greet` and `farewell`. */
export function behaviorPage(entries: readonly string[], body = ""): string {
  return [
    "---",
    "title: API",
    "behavior:",
    ...entries.map((entry) => indent(entry, 2)),
    "---",
    "# API",
    "",
    "Call `greet` and `farewell`.",
    body,
    "",
  ].join("\n");
}

/** The config both fixture versions share: a package entry, docs folder, and an excluded test folder. */
export const FIXTURE_CONFIG = [
  "title: Behavior fixture",
  "exclude: [test]",
  "surface:",
  "  package: pkg/index.ts",
  "  docs: [docs]",
  "",
].join("\n");

/** One exported symbol with a JSDoc line, so the surface adapter records it. */
export function symbol(name: string, signature: string): string {
  return [`/** ${name}. */`, `export function ${name}${signature} { return name; }`].join("\n");
}

/** A test file whose name is searchable, so a behavior's `name` resolves. */
export function testFile(name: string): string {
  return [`import { test } from "node:test";`, `test(${JSON.stringify(name)}, () => {});`, ""].join("\n");
}

/** The one behavior entry used by most fixtures. */
export function behavior(options: {
  readonly id: string;
  readonly title?: string;
  readonly status?: string;
  readonly introduced?: string;
  readonly changed?: readonly string[];
  readonly deprecated?: string;
  readonly removed?: string;
  readonly replacement?: string;
  readonly surface?: readonly string[];
  readonly testFile?: string;
  readonly testName?: string;
  readonly testOutcome?: string;
  readonly testPublic?: boolean;
  readonly evidenceUrl?: string;
  readonly evidenceId?: string;
  readonly evidenceKind?: string;
  readonly evidencePublic?: boolean;
  readonly public?: boolean;
  readonly environments?: readonly string[];
  readonly normative?: string;
}): string {
  const lines = [
    `- id: ${options.id}`,
    `  title: ${options.title ?? options.id}`,
    `  normative: ${options.normative ?? `The product does ${options.id}.`}`,
    `  status: ${options.status ?? "supported"}`,
    "  versions:",
    `    introduced: ${options.introduced ?? "1.0.0"}`,
  ];
  if (options.changed !== undefined) lines.push(`    changed: [${options.changed.join(", ")}]`);
  if (options.deprecated !== undefined) lines.push(`    deprecated: ${options.deprecated}`);
  if (options.removed !== undefined) lines.push(`    removed: ${options.removed}`);
  if (options.replacement !== undefined) lines.push(`  replacement: ${options.replacement}`);
  lines.push(`  surface: [${(options.surface ?? ["symbol:greet"]).map((id) => `"${id}"`).join(", ")}]`);
  if (options.environments !== undefined && options.environments.length > 0) {
    lines.push("  environments:");
    for (const environment of options.environments) lines.push(`    - ${environment}`);
  }
  if (options.testFile !== undefined) {
    lines.push("  tests:");
    lines.push(`    - file: ${options.testFile}`);
    if (options.testName !== undefined) lines.push(`      name: ${JSON.stringify(options.testName)}`);
    lines.push(`      outcome: ${options.testOutcome ?? "passed"}`);
    if (options.testPublic !== undefined) lines.push(`      public: ${options.testPublic}`);
  }
  if (options.evidenceUrl !== undefined || options.evidenceId !== undefined) {
    lines.push("  evidence:");
    lines.push("    -");
    if (options.evidenceId !== undefined) lines.push(`      id: ${options.evidenceId}`);
    if (options.evidenceUrl !== undefined) lines.push(`      url: ${options.evidenceUrl}`);
    lines.push(`      kind: ${options.evidenceKind ?? "ci"}`);
    if (options.evidencePublic !== undefined) lines.push(`      public: ${options.evidencePublic}`);
  }
  if (options.public !== undefined) lines.push(`  public: ${options.public}`);
  return lines.join("\n");
}

/** A minimal valid evidence lock with one pinned envelope id claimed by one behavior. */
export function evidenceLock(id: string, behaviorId = "greet.locked"): string {
  return `${JSON.stringify(
    {
      version: 1,
      snapshot: { id: "snapshot-1", commit: "a".repeat(64), configSha256: "b".repeat(64) },
      maxAgeDays: 14,
      pins: { [id]: { sha256: "c".repeat(64) } },
      surfaces: ["symbol:greet", "symbol:farewell"],
      claims: [
        {
          id: `claim-${behaviorId}`,
          subject: { kind: "behavior", id: behaviorId },
          surface: "symbol:greet",
          behavior: behaviorId,
          evidence: [id],
        },
      ],
    },
    null,
    2,
  )}\n`;
}
