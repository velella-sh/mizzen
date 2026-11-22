import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { parseArgs } from "node:util";
import { attestBundle, policyOf, unreadableAttestation, verifyBundle } from "../published-site/attestation.ts";
import { ed25519Signer } from "../published-site/signing.ts";
import type { PublishedSiteIo } from "./published-site.ts";

export const siteAttestationUsage = `Usage:
  mizzen published-site attest <bundle> <provenance.json> [--key <private.pem>]
  mizzen published-site verify <bundle> <attestation.json> <trust-policy.json>`;

async function readJson(file: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    throw new Error(`expected a readable JSON ${label} file`);
  }
}

export async function runSiteAttestation(args: readonly string[], io: PublishedSiteIo): Promise<number> {
  const [command, ...rest] = args;
  if (rest[0] === "--help" || rest[0] === "-h") {
    io.log(siteAttestationUsage);
    return 0;
  }
  const { positionals, values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { key: { type: "string", multiple: true } },
  });
  const [bundle, input, policyPath] = positionals;
  const keyCount = values.key?.length ?? 0;
  const invalid = command === "attest"
    ? positionals.length !== 2 || keyCount > 1
    : positionals.length !== 3 || !policyPath || keyCount > 0;
  if (!bundle || !input || invalid) {
    io.error(siteAttestationUsage);
    return 2;
  }

  if (command === "attest") {
    const keyPath = values.key?.[0];
    const provenance = await readJson(input, "provenance");
    let signer;
    if (keyPath !== undefined) {
      const key = await realpath(keyPath);
      const path = relative(await realpath(bundle), key);
      if (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`)) {
        throw new Error("the signing key must be outside the public bundle");
      }
      signer = ed25519Signer(await readFile(key, "utf8"));
    }
    io.log(JSON.stringify(await attestBundle(bundle, provenance, signer), null, 2));
    return 0;
  }

  const policy = policyOf(await readJson(policyPath!, "trust policy"));
  let value: unknown;
  try {
    value = await readJson(input, "attestation");
  } catch {
    io.log(JSON.stringify(unreadableAttestation()));
    return 1;
  }
  const result = await verifyBundle(bundle, value, policy);
  io.log(JSON.stringify(result));
  return result.ok ? 0 : 1;
}
