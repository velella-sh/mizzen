import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, sha256 } from "../data/lock.ts";
import { readEnvelope, readEvidenceLock, type Envelope, type EvidenceLock } from "./format.ts";
import { testFindings } from "./tests.ts";

const STORE = ".mizzen/evidence";
export const EVIDENCE_LOCK_FILE = "evidence.lock.json";

export interface LockedEvidence {
  readonly lock: EvidenceLock;
  readonly entries: ReadonlyMap<string, Envelope>;
  readonly fingerprint: string;
}

async function writeStored(dir: string, file: string, contents: string | Uint8Array): Promise<void> {
  const temp = await mkdtemp(join(dir, ".stage-"));
  try {
    await writeFile(join(temp, file), contents);
    await rename(join(temp, file), join(dir, file));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/** Validate the supplied evidence, then publish the envelope only after its artifact is in place. */
export async function ingestEvidence(root: string, file: string, artifactFile: string | undefined): Promise<string> {
  const envelope = readEnvelope(JSON.parse(await readFile(file, "utf8")));
  const dir = join(root, STORE);
  if (envelope.kind === "test") testFindings(envelope.payload);
  if (envelope.kind === "ci") {
    if (artifactFile === undefined) throw new Error("CI evidence needs the original artifact file.");
    const artifact = await readFile(artifactFile);
    if (sha256(artifact) !== envelope.payload.artifactSha256) throw new Error("CI artifact SHA-256 does not match.");
    await mkdir(dir, { recursive: true });
    await writeStored(dir, `${envelope.payload.artifactSha256}.artifact`, artifact);
  } else if (artifactFile !== undefined) {
    throw new Error("Only CI evidence takes an artifact file.");
  }
  const bytes = `${canonicalJson(envelope)}\n`;
  const hash = sha256(bytes);
  await mkdir(dir, { recursive: true });
  await writeStored(dir, `${hash}.json`, bytes);
  return hash;
}

/** Recheck the lock and all pinned bytes on every build, including cache hits. */
export async function loadLockedEvidence(root: string): Promise<LockedEvidence | undefined> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(root, EVIDENCE_LOCK_FILE));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const lock = readEvidenceLock(JSON.parse(bytes.toString("utf8")));
  const dir = join(root, STORE);
  const entries = new Map<string, Envelope>();
  for (const id of Object.keys(lock.pins).sort()) {
    const pin = lock.pins[id]!;
    try {
      const stored = await readFile(join(dir, `${pin.sha256}.json`));
      if (sha256(stored) !== pin.sha256) throw new Error("envelope SHA-256 does not match its pin.");
      const envelope = readEnvelope(JSON.parse(stored.toString("utf8")));
      if (envelope.id !== id) throw new Error(`the pinned envelope belongs to "${envelope.id}".`);
      if (envelope.kind === "ci") {
        const hash = envelope.payload.artifactSha256;
        const artifact = await readFile(join(dir, `${hash}.artifact`));
        if (sha256(artifact) !== hash) throw new Error("artifact SHA-256 does not match.");
      }
      entries.set(id, envelope);
    } catch (error) {
      const detail = (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "pinned envelope or artifact is missing from the local store."
        : error instanceof Error ? error.message : String(error);
      throw new Error(`Evidence "${id}": ${detail}`);
    }
  }
  return { lock, entries, fingerprint: sha256(canonicalJson(lock)) };
}
