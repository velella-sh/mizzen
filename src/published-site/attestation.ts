import { lstat } from "node:fs/promises";
import { canonicalJson } from "../data/lock.ts";
import { checkAsOf } from "../dates/as-of.ts";
import {
  buildHashOf, byCodePoint, fingerprint, isIdentityPath, UnsupportedEntryError, type BuildRecord,
} from "../outputs/build-hash.ts";
import { trustedKeys, verifiesSignature, type Signing, type SigningAdapter } from "./signing.ts";

export const ATTESTATION_FORMAT = 1;

interface Provenance {
  readonly site: string;
  readonly sourceCommit: string;
  readonly snapshot: string;
  readonly engine: string;
  readonly theme: { readonly name: string; readonly version: string };
  readonly builtOn: string;
}

type FileHashes = Readonly<Record<string, string>>;

interface Payload extends Provenance {
  readonly format: typeof ATTESTATION_FORMAT;
  readonly build: BuildRecord;
  readonly evidence: { readonly snapshot: string; readonly files: FileHashes };
  readonly signing: Signing;
}

interface Attestation {
  readonly payload: Payload;
  readonly signature: string | null;
}

interface Finding {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

type Decision = "allow" | "reject";
const digest = /^[a-f0-9]{64}$/;
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const themeName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const release = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/;
const commit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value) && !/[\r\n]/.test(value);
}

function isDay(value: unknown): value is string {
  return matches(value, /^\d{4}-\d{2}-\d{2}$/) && checkAsOf(value) === undefined;
}

function provenanceOf(value: Record<string, unknown>): Provenance | undefined {
  const { site, sourceCommit, snapshot, engine, theme, builtOn } = value;
  if (!matches(site, identifier) || !matches(sourceCommit, commit) || !matches(snapshot, identifier) ||
      !matches(engine, release) || !isDay(builtOn) || !isRecord(theme) ||
      !matches(theme.name, themeName) || !matches(theme.version, release)) return undefined;
  return { site, sourceCommit, snapshot, engine, theme: { name: theme.name, version: theme.version }, builtOn };
}

function isHashMap(value: unknown): value is FileHashes {
  return isRecord(value) && Object.entries(value).every(([path, hash]) => isIdentityPath(path) && matches(hash, digest));
}

function attestationOf(value: Record<string, unknown>): Attestation | undefined {
  const { payload, signature } = value;
  if (!isRecord(payload) || payload.format !== ATTESTATION_FORMAT || Object.keys(value).length !== 2) return undefined;
  const identity = provenanceOf(payload);
  const { build, evidence, signing, theme } = payload;
  if (identity === undefined || !isRecord(build) || !matches(build.hash, digest) || !isHashMap(build.files) ||
      !isRecord(evidence) || !matches(evidence.snapshot, identifier) || !isHashMap(evidence.files) ||
      !isRecord(signing) || !isRecord(theme)) return undefined;
  // Every named field above is required. Extra fields require a new format version.
  if (Object.keys(payload).length !== 10 || Object.keys(theme).length !== 2 ||
      Object.keys(build).length !== 2 || Object.keys(evidence).length !== 2) return undefined;

  let signer: Signing;
  if (signing.algorithm === "none" && signature === null && Object.keys(signing).length === 1) {
    signer = { algorithm: "none" };
  } else if (signing.algorithm === "ed25519" && matches(signing.keyId, digest) && typeof signature === "string" &&
      Object.keys(signing).length === 2) {
    signer = { algorithm: "ed25519", keyId: signing.keyId };
  } else {
    return undefined;
  }

  return {
    payload: {
      ...identity,
      format: ATTESTATION_FORMAT,
      build: { hash: build.hash, files: build.files },
      evidence: { snapshot: evidence.snapshot, files: evidence.files },
      signing: signer,
    },
    signature,
  };
}

function isDecision(value: unknown): value is Decision {
  return value === "allow" || value === "reject";
}

export function policyOf(value: unknown) {
  if (!isRecord(value)) throw new Error("the trust policy must be an object");
  const { site, snapshot, formats, minimumEvidence, unsigned, freshness, keys } = value;
  if (!matches(site, identifier) || (snapshot !== undefined && !matches(snapshot, identifier)) ||
      !Array.isArray(formats) || formats.length === 0 || !formats.every((format) => Number.isSafeInteger(format) && format > 0) ||
      typeof minimumEvidence !== "number" || !Number.isSafeInteger(minimumEvidence) || minimumEvidence < 0 ||
      !isDecision(unsigned) || !Array.isArray(keys) || !keys.every((key) => typeof key === "string")) {
    throw new Error("the trust policy needs a site, allowed formats, minimumEvidence, an unsigned decision, and keys");
  }
  let freshnessRule: { notBefore: string; stale: Decision } | undefined;
  if (freshness !== undefined) {
    if (!isRecord(freshness) || !isDay(freshness.notBefore) || !isDecision(freshness.stale) ||
        Object.keys(freshness).length !== 2) {
      throw new Error("freshness needs a notBefore day and a stale decision");
    }
    freshnessRule = { notBefore: freshness.notBefore, stale: freshness.stale };
  }
  if (Object.keys(value).some((key) =>
    !["site", "snapshot", "formats", "minimumEvidence", "unsigned", "freshness", "keys"].includes(key))) {
    throw new Error("the trust policy contains unknown fields");
  }
  return { site, snapshot, formats, minimumEvidence, unsigned, freshness: freshnessRule, keys: trustedKeys(keys) };
}

function signingBytes(payload: Payload): Uint8Array {
  return Buffer.from(`mizzen-site-attestation\0${canonicalJson(payload)}`);
}

async function bundleFingerprint(dir: string): Promise<BuildRecord> {
  if (!(await lstat(dir)).isDirectory()) throw new Error("the bundle must be a directory");
  return fingerprint(dir, undefined, { allFiles: true });
}

export async function attestBundle(dir: string, provenance: unknown, signer?: SigningAdapter): Promise<Attestation> {
  const identity = isRecord(provenance) ? provenanceOf(provenance) : undefined;
  if (identity === undefined || !isRecord(provenance)) {
    throw new Error("provenance needs a site, full source commit, snapshot, engine and theme versions, and build day");
  }
  const evidence = provenance.publicEvidence;
  if (!isRecord(evidence) || !Array.isArray(evidence.paths) ||
      !evidence.paths.every((path) => typeof path === "string" && isIdentityPath(path)) ||
      new Set(evidence.paths).size !== evidence.paths.length) {
    throw new Error("publicEvidence needs a snapshot and a unique list of relative bundle paths");
  }
  if (evidence.snapshot !== identity.snapshot) throw new Error("publicEvidence.snapshot must match the build snapshot");
  const build = await bundleFingerprint(dir);
  const files = Object.fromEntries(evidence.paths.slice().sort(byCodePoint).map((path: string) => {
    const hash = build.files[path];
    if (hash === undefined) throw new Error(`public evidence is missing from the bundle: ${path}`);
    return [path, hash];
  }));
  const payload: Payload = {
    ...identity,
    format: ATTESTATION_FORMAT,
    build,
    evidence: { snapshot: identity.snapshot, files },
    signing: signer?.identity ?? { algorithm: "none" },
  };
  return { payload, signature: signer === undefined ? null : Buffer.from(signer.sign(signingBytes(payload))).toString("base64") };
}

function report(issues: readonly Finding[], warnings: readonly Finding[] = [], payload?: Payload) {
  return {
    format: 1,
    ok: issues.length === 0,
    ...(payload === undefined ? {} : {
      site: payload.site, snapshot: payload.snapshot, buildHash: payload.build.hash, signing: payload.signing,
    }),
    issues,
    warnings,
  };
}

export function unreadableAttestation() {
  return report([{ code: "attestation-unreadable", path: "attestation", message: "Expected a readable JSON attestation." }]);
}

export async function verifyBundle(dir: string, value: unknown, policy: ReturnType<typeof policyOf>) {
  const reject = (code: string, path: string, message: string) => report([{ code, path, message }]);
  if (!isRecord(value) || !isRecord(value.payload) || !Number.isSafeInteger(value.payload.format)) {
    return reject("attestation-malformed", "payload", "Expected a versioned attestation.");
  }
  if (value.payload.format !== ATTESTATION_FORMAT || !policy.formats.includes(value.payload.format)) {
    return reject("format-rejected", "payload.format", "The attestation format is unsupported or disallowed by policy.");
  }
  const attestation = attestationOf(value);
  if (attestation === undefined) return reject("attestation-malformed", "attestation", "Invalid version 1 fields.");
  const { payload, signature } = attestation;
  const issues: Finding[] = [];
  const warnings: Finding[] = [];

  if (payload.signing.algorithm === "none") {
    const finding = { code: "unsigned", path: "payload.signing", message: "The attestation provides no signer authentication." };
    if (policy.unsigned === "reject") return report([finding]);
    warnings.push(finding);
  } else {
    const key = policy.keys.get(payload.signing.keyId);
    if (key === undefined) return reject("signer-untrusted", "payload.signing.keyId", "No policy key matches this signer.");
    if (signature === null || !verifiesSignature(key, signingBytes(payload), signature)) {
      return reject("signature-invalid", "signature", "The signature does not authenticate the payload.");
    }
  }

  if (payload.site !== policy.site) {
    issues.push({ code: "site-mismatch", path: "payload.site", message: "The attestation is for a different site." });
  }
  if (policy.snapshot !== undefined && payload.snapshot !== policy.snapshot) {
    issues.push({ code: "snapshot-mismatch", path: "payload.snapshot", message: "The attestation is for a different snapshot." });
  }
  if (policy.freshness !== undefined && payload.builtOn < policy.freshness.notBefore) {
    const findings = policy.freshness.stale === "reject" ? issues : warnings;
    findings.push({ code: "stale", path: "payload.builtOn", message: `The build predates ${policy.freshness.notBefore}.` });
  }
  if (payload.build.hash !== buildHashOf(payload.build.files)) {
    issues.push({ code: "build-hash-mismatch", path: "payload.build.hash", message: "The build hash does not match the file manifest." });
  }

  const evidenceFiles = Object.keys(payload.evidence.files).sort(byCodePoint);
  if (evidenceFiles.length < policy.minimumEvidence) {
    issues.push({ code: "evidence-insufficient", path: "payload.evidence.files", message: `Policy requires at least ${policy.minimumEvidence} evidence files.` });
  }
  if (payload.evidence.snapshot !== payload.snapshot) {
    for (const path of evidenceFiles.length === 0 ? ["payload.evidence.snapshot"] : evidenceFiles) {
      issues.push({ code: "evidence-snapshot-mismatch", path, message: "The evidence manifest belongs to a different snapshot." });
    }
  }
  for (const path of evidenceFiles) {
    if (!Object.hasOwn(payload.build.files, path) || payload.evidence.files[path] !== payload.build.files[path]) {
      issues.push({ code: "evidence-detached", path, message: "The evidence hash is not bound to this build." });
    }
  }

  let actual: BuildRecord;
  try {
    actual = await bundleFingerprint(dir);
  } catch (error) {
    issues.push(error instanceof UnsupportedEntryError
      ? { code: "bundle-entry-unsupported", path: error.path, message: error.message }
      : { code: "bundle-unreadable", path: ".", message: "Expected a readable local bundle directory." });
    return report(issues, warnings, payload);
  }

  const paths = [...new Set([...Object.keys(payload.build.files), ...Object.keys(actual.files)])].sort(byCodePoint);
  for (const path of paths) {
    const expected = Object.hasOwn(payload.build.files, path) ? payload.build.files[path] : undefined;
    const found = actual.files[path];
    if (expected === found) continue;
    if (expected === undefined) {
      issues.push({ code: "file-added", path, message: "The file is absent from the attested file manifest." });
    } else {
      const kind = Object.hasOwn(payload.evidence.files, path) ? "evidence" : "file";
      issues.push(found === undefined
        ? { code: `${kind}-missing`, path, message: "The manifest lists a file missing from the bundle." }
        : { code: `${kind}-changed`, path, message: "The bundle file has a different hash." });
    }
  }
  return report(issues, warnings, payload);
}
