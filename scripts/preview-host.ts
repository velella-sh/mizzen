// Hosts bundled previews: `node scripts/preview-host.ts <bundlesDir> --activate <name>` checks a bundle's files against
// its `bundle.json` and points `current` at it; `--port <n>` serves whatever `current` names. Rolling back is another
// `--activate`: every bundle keeps its own manifest beside its files.
import { readFile, realpath, rename, rm, symlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { byCodePoint, fingerprint, isIdentityPath } from "../src/outputs/build-hash.ts";

/** What a preview sends for the extensions its output uses; anything else is bytes. */
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

/**
 * Verifies `<bundlesDir>/<name>/bundle.json` against the files beside it, then points `<bundlesDir>/current` at `name`
 * with a temporary link renamed into place, so a reader sees either the old bundle or the new one, never half a swap.
 */
export async function activate(bundlesDir: string, name: string): Promise<void> {
  if (!isIdentityPath(name)) throw new Error(`preview-host: "${name}" is not a bundle name.`);
  const dir = join(bundlesDir, name);
  let text: string;
  try {
    text = await readFile(join(dir, "bundle.json"), "utf8");
  } catch (err) {
    throw new Error(`preview-host: no readable bundle.json in "${dir}"; bundle the preview first.`, { cause: err });
  }
  let manifest: { files?: unknown };
  try {
    manifest = JSON.parse(text) as typeof manifest;
  } catch (err) {
    throw new Error(`preview-host: bundle.json in "${dir}" is not JSON.`, { cause: err });
  }
  const listed = manifest.files;
  if (listed === null || typeof listed !== "object" || Array.isArray(listed)) {
    throw new Error(`preview-host: bundle.json in "${dir}" does not list its files; bundle the preview again.`);
  }

  const record = await fingerprint(join(dir, "files"));
  const files = listed as Record<string, unknown>;
  for (const path of Object.keys(files).sort(byCodePoint)) {
    if (record.files[path] !== files[path]) {
      throw new Error(`preview-host: "${name}" does not match its bundle.json at "${path}"; bundle it again.`);
    }
  }
  if (Object.keys(record.files).length !== Object.keys(files).length) {
    throw new Error(`preview-host: "${name}" holds files its bundle.json does not list; bundle it again.`);
  }

  const temp = join(bundlesDir, `.current-${process.pid}`);
  await rm(temp, { force: true });
  await symlink(name, temp, "dir");
  await rename(temp, join(bundlesDir, "current"));
}

/** Writes a small response; HEAD gets the headers and no body. */
function reply(req: IncomingMessage, res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8"): void {
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") res.end();
  else res.end(body);
}

/** Serves the active bundle: `/bundle.json` from the bundle root, everything else from its `files/`. */
async function handle(bundlesDir: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    reply(req, res, 405, "405\n");
    return;
  }
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    reply(req, res, 400, "400\n");
    return;
  }

  let bundle: string;
  try {
    bundle = await realpath(join(bundlesDir, "current"));
  } catch {
    reply(req, res, 503, "no bundle is active\n");
    return;
  }

  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    reply(req, res, 404, "404\n");
    return;
  }
  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment === "." || segment === ".." || segment.includes("\\") || /[\u0000-\u001f\u007f]/.test(segment))) {
    reply(req, res, 404, "404\n");
    return;
  }
  let file: string;
  if (url.pathname === "/bundle.json") {
    file = join(bundle, "bundle.json");
  } else {
    let relative = segments.join("/");
    if (relative === "" || path.endsWith("/")) relative = relative === "" ? "index.html" : `${relative}/index.html`;
    file = join(bundle, "files", relative);
  }

  // The bundle's own files were verified at activation; following a link now could still read outside it.
  let real: string;
  try {
    real = await realpath(file);
  } catch {
    reply(req, res, 404, "404\n");
    return;
  }
  if (!real.startsWith(`${bundle}${sep}`)) {
    reply(req, res, 404, "404\n");
    return;
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(real);
  } catch {
    reply(req, res, 404, "404\n");
    return;
  }
  const type = TYPES[extname(real).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": bytes.byteLength,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") res.end();
  else res.end(bytes);
}

/** Serves the active bundle on 127.0.0.1; each request resolves `current` again, so an activation needs no restart. */
export async function serve(bundlesDir: string, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    handle(bundlesDir, req, res).catch(() => {
      if (!res.headersSent) reply(req, res, 500, "500\n");
      else res.destroy();
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (err: Error): void => rejectListen(err);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolveListen();
    });
  });
  return server;
}

const SELF = fileURLToPath(import.meta.url);

if (process.argv[1] !== undefined && fileURLToPath(new URL(`file://${process.argv[1]}`)) === SELF) {
  const argv = process.argv.slice(2);
  const usage: () => never = () => {
    process.stderr.write("Usage: preview-host <bundlesDir> [--activate <name>] [--port <n>]\n");
    process.exit(1);
  };
  let bundlesDir: string | undefined;
  let name: string | undefined;
  let port: number | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const value = (): string => argv[++index] ?? usage();
    if (arg === "--activate") name = value();
    else if (arg === "--port") {
      const raw = value();
      port = Number(raw);
      if (!Number.isInteger(port) || port < 0 || port > 65535) usage();
    } else if (bundlesDir === undefined && !arg.startsWith("-")) bundlesDir = arg;
    else usage();
  }
  if (bundlesDir === undefined || (name === undefined && port === undefined)) usage();

  if (name !== undefined) {
    await activate(bundlesDir, name);
    process.stdout.write(`preview-host: current -> ${name}\n`);
  }
  if (port !== undefined) {
    const server = await serve(bundlesDir, port);
    const address = server.address();
    const bound = typeof address === "object" && address !== null ? address.port : port;
    process.stdout.write(`preview-host: http://127.0.0.1:${bound}/\n`);
  }
}
