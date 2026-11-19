/**
 * Reading an access policy from a file. Every refusal names the file and the JSON Pointer, so a CLI user can fix the
 * policy without guessing which value was wrong. Nothing here reads the site; the file is the whole input.
 */
import { readFile } from "node:fs/promises";
import type { AccessPolicy } from "../contracts/permissions.ts";
import { parseAccessPolicyText } from "./policy.ts";

/** A loaded policy, or every reason the file was refused. */
export interface AccessPolicyFileResult {
  readonly policy?: AccessPolicy;
  readonly problems: readonly string[];
}

/** Reads and parses one policy file. */
export async function readAccessPolicyFile(file: string): Promise<AccessPolicyFileResult> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    return {
      problems: [`${file}: cannot read the access policy: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const parsed = parseAccessPolicyText(text, file);
  return {
    ...(parsed.policy === undefined ? {} : { policy: parsed.policy }),
    problems: parsed.problems.map((problem) => problem.message),
  };
}
