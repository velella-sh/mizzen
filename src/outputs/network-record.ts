import type { Site } from "../contracts/content.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";

/**
 * Records which locked network a build was made against, in `.mizzen/network.json`: the project, the lock's hash, and
 * the public projects. The build hash covers this file, so a changed lock changes the hash even when no page text
 * changed. A site with no `network` key writes nothing.
 */
export const networkRecord: Output = {
  name: "network-record",
  async run(site: Site, _ctx: OutputContext): Promise<readonly OutputFile[]> {
    const network = site.network;
    if (network === undefined) return [];
    const record = { version: 1, project: network.current, lock: network.lock, projects: network.projects.map((p) => p.id) };
    return [{ path: ".mizzen/network.json", contents: `${JSON.stringify(record, null, 2)}\n` }];
  },
};
