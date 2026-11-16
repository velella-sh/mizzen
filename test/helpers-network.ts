import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type NetworkLock, writeNetworkLock } from "../src/network/lock.ts";

export const H = "a".repeat(64);

/** A lock with two public projects and one hidden one. */
export function lockOf(over: Partial<NetworkLock> = {}): NetworkLock {
  return {
    version: 1,
    source: "https://example.org/network.json",
    sha256: H,
    projects: [
      { id: "docs", path: "docs", title: "Docs", public: true, manifest: { url: "https://example.org/docs/.mizzen/manifest.json", sha256: H, pages: [{ path: "/", title: "Home", sha256: H }] } },
      { id: "blog", path: "blog", title: "Blog", public: true, search: "find", manifest: { url: "https://example.org/blog/.mizzen/manifest.json", sha256: H, pages: [{ path: "/post/", title: "A post", sha256: H }] } },
      { id: "internal", path: "internal", title: "Internal", public: false },
    ],
    ...over,
  };
}

export async function networkSite(extra = "", lock: NetworkLock | null = lockOf(), project = "docs"): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "mizzen-netbuild-"));
  writeFileSync(join(root, "mizzen.yml"), `title: Demo\nurl: https://example.org\nnetwork:\n  source: https://example.org/network.json\n  project: ${project}\n${extra}`);
  writeFileSync(join(root, "index.md"), "---\ntitle: Home\n---\n# Home\n\nHello.\n");
  mkdirSync(join(root, "guide"));
  writeFileSync(join(root, "guide", "index.md"), "---\ntitle: Guide\n---\n# Guide\n\nText.\n");
  if (lock !== null) await writeNetworkLock(root, lock);
  return root;
}

