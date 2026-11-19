/**
 * The installable skill package: a manifest, instruction files, and a checksum over exactly the
 * shipped bytes. A client reads the manifest, checks the version and checksum, then installs the
 * entry file. The reader refuses a path that leaves the package, a file the manifest omits, and a
 * checksum that does not match, so a partial or edited copy is never installed as the real one.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillPackageManifest } from "../contracts/clients.ts";
import { CLIENT_CONTRACT_VERSION } from "./version.ts";

/** The skill shipped with this build. */
export const SKILL_PACKAGE_DIR = fileURLToPath(new URL("../../skills/mizzen-client/", import.meta.url));

export class SkillPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillPackageError";
  }
}

export interface SkillPackage {
  readonly manifest: SkillPackageManifest;
  /** The entry file's bytes, exactly as installed. */
  readonly instructions: string;
  /** The SHA-256 of the listed files, in manifest order. */
  readonly checksum: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function relative(raw: string, field: string): string {
  if (raw === "" || isAbsolute(raw) || raw.includes("\\") || raw.split("/").includes("..")) {
    throw new SkillPackageError(`\`${field}\` must be a relative path with forward slashes and no \`..\`, not ${JSON.stringify(raw)}.`);
  }
  return normalize(raw);
}

function manifestOf(value: unknown): SkillPackageManifest {
  if (!isRecord(value)) throw new SkillPackageError("skill.json must be a JSON object.");
  if (value.schemaVersion !== "velella.skill.v1") throw new SkillPackageError(`skill.json schemaVersion must be "velella.skill.v1", not ${JSON.stringify(value.schemaVersion)}.`);
  if (typeof value.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(value.name)) throw new SkillPackageError("skill.json name must be lowercase letters, digits, and hyphens.");
  if (typeof value.version !== "number" || !Number.isInteger(value.version) || value.version < 1) throw new SkillPackageError("skill.json version must be a positive integer.");
  if (!Array.isArray(value.contractVersions) || value.contractVersions.length === 0 || value.contractVersions.some((entry) => !Number.isInteger(entry))) {
    throw new SkillPackageError("skill.json contractVersions must be a non-empty array of integers.");
  }
  if (!(value.contractVersions as readonly number[]).includes(CLIENT_CONTRACT_VERSION)) {
    throw new SkillPackageError(`skill.json teaches contract versions ${value.contractVersions.join(", ")}, which do not include this build's ${CLIENT_CONTRACT_VERSION}.`);
  }
  if (typeof value.entry !== "string") throw new SkillPackageError("skill.json entry must be a path.");
  const entry = relative(value.entry, "entry");
  if (!Array.isArray(value.files) || value.files.length === 0 || value.files.some((file) => typeof file !== "string")) {
    throw new SkillPackageError("skill.json files must be a non-empty array of paths.");
  }
  const files = (value.files as string[]).map((file) => relative(file, "files"));
  if (new Set(files).size !== files.length) throw new SkillPackageError("skill.json files must not repeat a path.");
  if (!files.includes(entry)) throw new SkillPackageError(`skill.json entry ${entry} is not listed in files.`);
  if (!isRecord(value.checksum) || value.checksum.algorithm !== "sha256" || typeof value.checksum.value !== "string" || !/^[0-9a-f]{64}$/.test(value.checksum.value)) {
    throw new SkillPackageError("skill.json checksum must be { algorithm: \"sha256\", value: 64 lowercase hex characters }.");
  }
  return {
    schemaVersion: "velella.skill.v1",
    name: value.name,
    version: value.version,
    contractVersions: value.contractVersions as number[],
    entry,
    files,
    checksum: { algorithm: "sha256", value: value.checksum.value },
  };
}

/** Reads and verifies one installed skill package. */
export async function readSkillPackage(dir: string = SKILL_PACKAGE_DIR): Promise<SkillPackage> {
  let raw: string;
  try {
    raw = await readFile(join(dir, "skill.json"), "utf8");
  } catch {
    throw new SkillPackageError(`No skill.json in ${dir}.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SkillPackageError("skill.json is not valid JSON.");
  }
  const manifest = manifestOf(value);
  const hash = createHash("sha256");
  let instructions: string | undefined;
  for (const file of manifest.files) {
    const bytes = await readFile(join(dir, file)).catch(() => {
      throw new SkillPackageError(`skill.json lists ${file}, which is missing.`);
    });
    hash.update(file);
    hash.update("\0");
    hash.update(bytes);
    if (file === manifest.entry) instructions = bytes.toString("utf8");
  }
  const checksum = hash.digest("hex");
  if (checksum !== manifest.checksum.value) {
    throw new SkillPackageError(`skill package checksum is ${checksum}, but skill.json records ${manifest.checksum.value}; reinstall the package.`);
  }
  return { manifest, instructions: instructions ?? "", checksum };
}
