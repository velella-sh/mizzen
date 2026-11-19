/** Shared setup of the MCP tests: a copy of a fixture site and a server over it, called without a transport. */
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTools } from "../src/mcp/registry.ts";
import { createServer, type Server } from "../src/mcp/server.ts";
import { declaresCollections, SiteState } from "../src/mcp/site.ts";
import type { Limits } from "../src/mcp/limits.ts";

export const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));
export const TOOLS = fileURLToPath(new URL("../src/mcp/tools/", import.meta.url));
export const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

/** A copy of fixture `name` in a temp folder, so a test may write to it. */
export function copyFixture(name: string): string {
  const root = mkdtempSync(join(tmpdir(), "mcp-test-"));
  cpSync(join(FIXTURES, name), root, { recursive: true });
  return root;
}

export interface Harness {
  readonly root: string;
  readonly site: SiteState;
  readonly server: Server;
  /** Calls a tool and returns its decoded JSON answer (or the raw text when it is not JSON) with the error flag. */
  call(name: string, args?: Record<string, unknown>, meta?: Record<string, unknown>): Promise<{ data: any; text: string; isError: boolean }>;
  /** Sends one JSON-RPC request and returns its response. */
  rpc(method: string, params?: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

export async function harness(root: string, options: { allowEdits?: boolean; limits?: Partial<Limits> } = {}): Promise<Harness> {
  const allowEdits = options.allowEdits ?? false;
  const registry = await loadTools(TOOLS, { allowEdits, collections: declaresCollections(root) });
  const site = await SiteState.open({ root, themeRoot: THEME, defaultLayout: "doc" });
  const server = createServer({ site, registry, info: { name: "mizzen", version: "test" }, ...(options.limits === undefined ? {} : { limits: options.limits }) });
  let id = 0;
  const rpc = async (method: string, params: Record<string, unknown> = {}) => (await server.handle({ jsonrpc: "2.0", id: ++id, method, params })) as any;
  return {
    root,
    site,
    server,
    rpc,
    async call(name, args = {}, meta) {
      const response: any = await rpc("tools/call", { name, arguments: args, ...(meta === undefined ? {} : { _meta: meta }) });
      const result = response.result;
      const text: string = result?.content?.[0]?.text ?? "";
      let data: unknown = text;
      try {
        data = JSON.parse(text);
      } catch {
        /* plain text answer */
      }
      return { data, text, isError: result?.isError === true };
    },
    close: async () => {
      await server.close();
      await site.close();
    },
  };
}
