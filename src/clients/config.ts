/**
 * Generate a client's MCP configuration from the shared adapter descriptor. The output holds a
 * command, its arguments, and nothing secret; a value that could be a credential is refused rather
 * than written. The same client, folder, and flags always produce the same bytes.
 */
import { CLIENT_ADAPTERS, CLIENT_IDS, adapterOf, type ClientId } from "./registry.ts";

/** The top-level configuration key of each supported client, derived from its adapter. */
export const CLIENTS = Object.fromEntries(CLIENT_ADAPTERS.map((entry) => [entry.id, entry.config.key])) as Record<ClientId, string>;

export type Client = ClientId;

export function isClient(name: string): name is Client {
  return adapterOf(name) !== undefined;
}

/** One server entry in a client's configuration file. */
export interface ClientServerConfig {
  readonly command: string;
  readonly args: readonly string[];
}

/** The configuration object a client reads; the only shape this build writes. */
export function clientConfigValue(client: Client, root: string, allowEdits: boolean): { readonly [key: string]: { readonly [name: string]: ClientServerConfig } } {
  const adapter = adapterOf(client);
  if (adapter === undefined) throw new Error(`Unknown client: ${client}`);
  const args = ["-y", "@velella/mizzen", "mcp", root, ...(allowEdits ? ["--allow-edits"] : [])];
  return { [adapter.config.key]: { [adapter.config.name]: { command: "npx", args } } };
}

/** The configuration a client needs to start this server for `root`; no secret is ever read. */
export function clientConfig(client: Client, root: string, allowEdits: boolean): string {
  return `${JSON.stringify(clientConfigValue(client, root, allowEdits), null, 2)}\n`;
}

/** Every supported client id, in help order. */
export const supportedClients: readonly ClientId[] = CLIENT_IDS;
