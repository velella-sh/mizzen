/** `mizzen mcp`: serve one site to an AI client over MCP on stdio, or print the client's configuration for it. */
import { fileURLToPath } from "node:url";
import type { AccessPolicy } from "../contracts/permissions.ts";
import { clientConfig, clientReport, CLIENTS, isClient, type Client } from "../clients/index.ts";
import { createServer } from "../mcp/server.ts";
import { loadTools } from "../mcp/registry.ts";
import { declaresCollections, SiteState } from "../mcp/site.ts";

export { CLIENTS, clientConfig, isClient, type Client };

/** The folder the tools are loaded from. */
const TOOLS_DIR = fileURLToPath(new URL("../mcp/tools/", import.meta.url));

export interface McpOptions {
  readonly root: string;
  readonly themeRoot: string;
  readonly allowEdits: boolean;
  readonly version: string;
  readonly defaultLayout?: string;
  /** The access policy every tool call is held to; absent means public read only. */
  readonly access?: AccessPolicy;
}

/** Serves the site on stdin and stdout until stdin ends. Logs go to `log` (stderr), never to stdout. */
export async function serveMcp(options: McpOptions, log: (message: string) => void): Promise<number> {
  const collections = declaresCollections(options.root);
  const registry = await loadTools(TOOLS_DIR, { allowEdits: options.allowEdits, collections });
  const site = await SiteState.open({
    root: options.root,
    themeRoot: options.themeRoot,
    ...(options.defaultLayout === undefined ? {} : { defaultLayout: options.defaultLayout }),
    ...(options.access === undefined ? {} : { access: options.access }),
  });
  try {
    log(`mizzen mcp: serving ${registry.tools.length} tools${options.allowEdits ? " (edits allowed)" : " (read-only)"}`);
    const server = createServer({
      site,
      registry,
      info: { name: "mizzen", version: options.version },
      log,
      onClient: (profile) => log(`mizzen mcp: ${clientReport(profile)}`),
    });
    await server.serve(process.stdin, process.stdout);
    return 0;
  } finally {
    await site.close();
  }
}
