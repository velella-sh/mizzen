/** `mizzen mcp`: serve one site to an AI client over MCP on stdio, or print the client's configuration for it. */
import { fileURLToPath } from "node:url";
import { createServer } from "../mcp/server.ts";
import { loadTools } from "../mcp/registry.ts";
import { declaresCollections, SiteState } from "../mcp/site.ts";

/** The clients `--print-config` knows, each with the top-level key its configuration file uses. */
export const CLIENTS = {
  "claude-code": "mcpServers",
  "claude-desktop": "mcpServers",
  cursor: "mcpServers",
  vscode: "servers",
} as const;
export type Client = keyof typeof CLIENTS;

export function isClient(name: string): name is Client {
  return Object.prototype.hasOwnProperty.call(CLIENTS, name);
}

/** The folder the tools are loaded from. */
const TOOLS_DIR = fileURLToPath(new URL("../mcp/tools/", import.meta.url));

/** The configuration a client needs to start this server for `root`; the same input gives the same text. */
export function clientConfig(client: Client, root: string, allowEdits: boolean): string {
  const args = ["-y", "@velella/mizzen", "mcp", root, ...(allowEdits ? ["--allow-edits"] : [])];
  const server = { command: "npx", args };
  return `${JSON.stringify({ [CLIENTS[client]]: { mizzen: server } }, null, 2)}\n`;
}

export interface McpOptions {
  readonly root: string;
  readonly themeRoot: string;
  readonly allowEdits: boolean;
  readonly version: string;
  readonly defaultLayout?: string;
}

/** Serves the site on stdin and stdout until stdin ends. Logs go to `log` (stderr), never to stdout. */
export async function serveMcp(options: McpOptions, log: (message: string) => void): Promise<number> {
  const collections = declaresCollections(options.root);
  const registry = await loadTools(TOOLS_DIR, { allowEdits: options.allowEdits, collections });
  const site = await SiteState.open({
    root: options.root,
    themeRoot: options.themeRoot,
    ...(options.defaultLayout === undefined ? {} : { defaultLayout: options.defaultLayout }),
  });
  try {
    log(`mizzen mcp: serving ${registry.tools.length} tools${options.allowEdits ? " (edits allowed)" : " (read-only)"}`);
    const server = createServer({ site, registry, info: { name: "mizzen", version: options.version }, log });
    await server.serve(process.stdin, process.stdout);
    return 0;
  } finally {
    await site.close();
  }
}
