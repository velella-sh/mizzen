import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { main } from "../src/cli/index.ts";

/** A temporary site with the given files. */
export function site(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "stale-site-"));
  write(root, files);
  return root;
}

/** Writes files under `root`, replacing any that exist. */
export function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** Runs the CLI and collects what it printed. */
export async function run(args: string[]): Promise<{ code: number; logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const code = await main(args, { log: (m) => void logs.push(m), error: (m) => void errors.push(m) });
  return { code, logs, errors };
}
