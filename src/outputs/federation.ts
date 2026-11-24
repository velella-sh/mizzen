/**
 * Writes `.mizzen/federation.json` when the site's config declares a `federation` key: the lock's hash, every pinned
 * bundle with its snapshot and digest, the composed graph's digest, and every project whose bundle is missing. A site
 * with no `federation` key writes nothing, so a build that does not use the feature keeps its bytes.
 *
 * The file is written from the lock alone, so it is the record a build actually read: a missing optional bundle appears
 * as `partial` rather than being hidden, and the composed digest is the one a query over the same lock would return.
 */
import type { Site } from "../contracts/content.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";
import { composeFederation } from "../federation/compose.ts";
import { byCodePoint } from "../federation/contract.ts";
import { loadFederation } from "../federation/lock.ts";

/** The record file, relative to the output folder. */
export const FEDERATION_RECORD_FILE = ".mizzen/federation.json";

/** One bundle as the record names it. */
interface BundleRow {
  readonly project: string;
  readonly namespace: string;
  readonly role: string;
  readonly snapshot: { readonly id: string; readonly version: string };
  readonly digest: string;
}

/**
 * Writes the federation record when the config declares `federation`. A missing required bundle is a diagnostic, so
 * `mizzen check` fails on it; a missing optional one only marks the record partial.
 */
export const federation: Output = {
  name: "federation",
  async run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]> {
    if (site.config.federation === undefined) return [];
    const root = ctx.build?.root;
    if (root === undefined) return [];
    const { loaded, requiredMissing } = await loadFederation(root);
    if (loaded.lock === undefined) return [];
    for (const project of requiredMissing) {
      ctx.report({
        id: "federation.bundle-missing",
        severity: "error",
        message: `The federation pins "${project}", but its bundle is missing or failed verification.`,
        help: "Run `mizzen federation fetch` to pin it again.",
      });
    }
    const graph = composeFederation(loaded);
    const bundles: BundleRow[] = [...loaded.bundles.values()]
      .sort((a, b) => byCodePoint(a.project, b.project))
      .map((bundle) => ({
        project: bundle.project,
        namespace: bundle.namespace,
        role: bundle.role,
        snapshot: bundle.snapshot,
        digest: bundle.digest,
      }));
    const record = {
      version: 1,
      manifest: loaded.lock.manifest,
      fingerprint: loaded.fingerprint,
      partial: loaded.partial,
      graph: graph.digest,
      bundles,
      missing: loaded.missing,
    };
    return [{ path: FEDERATION_RECORD_FILE, contents: `${JSON.stringify(record, null, 2)}\n` }];
  },
};
