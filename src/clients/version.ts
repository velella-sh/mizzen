/**
 * Version compatibility for the client adapter contract. Version 1 is current. A descriptor that
 * carries no version is the pre-versioning shape and is read as version 1 with a migration note;
 * any other number is refused with a sentence that names both versions, so an unknown schema is
 * never guessed into a different meaning.
 */
import type { ClientProblem } from "../contracts/clients.ts";

/** The current adapter contract version. */
export const CLIENT_CONTRACT_VERSION = 1;

/** Every contract version this build reads, newest first. */
export const SUPPORTED_CONTRACT_VERSIONS = [1] as const;

export interface ClientVersionResult {
  /** The version to read with; present exactly when `problems` is empty. */
  readonly version?: 1;
  /** True when the input carried no version and the version 1 defaults applied. */
  readonly migrated: boolean;
  readonly problems: readonly ClientProblem[];
}

/** Checks one `contractVersion` value. Never coerces a string or guesses an unknown number. */
export function checkClientContractVersion(value: unknown): ClientVersionResult {
  if (value === undefined) {
    return {
      version: 1,
      migrated: true,
      problems: [],
    };
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return {
      migrated: false,
      problems: [
        {
          path: "/contractVersion",
          code: "client.version-invalid",
          message: `\`contractVersion\` must be an integer of at least 1, not ${JSON.stringify(value)}; versions are never read from a string.`,
        },
      ],
    };
  }
  if (value > CLIENT_CONTRACT_VERSION) {
    return {
      migrated: false,
      problems: [
        {
          path: "/contractVersion",
          code: "client.version-newer",
          message: `Client contract version ${value} is newer than the supported version ${CLIENT_CONTRACT_VERSION}; update the server, or send contract version ${CLIENT_CONTRACT_VERSION}.`,
        },
      ],
    };
  }
  return { version: 1, migrated: false, problems: [] };
}
