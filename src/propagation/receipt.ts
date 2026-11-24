/**
 * The local receipt ledger. A receipt is derived only from the consumer, the upstream snapshot, and the change set, so
 * reprocessing the same snapshots finds the earlier receipt instead of creating another task or pull request. The file
 * is canonical JSON with no timestamp, so an unchanged run writes the same bytes.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PropagationLedger, PropagationReceipt, PropagationVerification } from "../contracts/propagation.ts";
import { canonicalJson } from "../data/lock.ts";
import { byCodePoint } from "./contract.ts";

/** The ledger file a site writes, relative to its root. */
export const PROPAGATION_LEDGER_FILE = ".mizzen/propagation.json";

/** The empty ledger. */
export function emptyLedger(): PropagationLedger {
  return { version: 1, receipts: [] };
}

/** The ledger's text: canonical JSON, receipts sorted by id, and one trailing line feed. */
export function ledgerText(ledger: PropagationLedger): string {
  const receipts = [...ledger.receipts].sort((a, b) => byCodePoint(a.id, b.id));
  return `${canonicalJson({ version: 1, receipts })}\n`;
}

/** True when `value` has the shape this engine reads as a ledger. */
export function isPropagationLedger(value: unknown): value is PropagationLedger {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const ledger = value as Record<string, unknown>;
  if (ledger.version !== 1 || !Array.isArray(ledger.receipts)) return false;
  return ledger.receipts.every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const receipt = entry as Record<string, unknown>;
    return (
      typeof receipt.id === "string" &&
      typeof receipt.consumer === "string" &&
      typeof receipt.status === "string" &&
      Array.isArray(receipt.tasks) &&
      Array.isArray(receipt.approvedBy)
    );
  });
}

/** Reads the ledger, or the empty one when the site has none. */
export async function readPropagationLedger(root: string): Promise<PropagationLedger> {
  let text: string;
  try {
    text = await readFile(join(root, PROPAGATION_LEDGER_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyLedger();
    throw error;
  }
  const value = JSON.parse(text) as unknown;
  if (!isPropagationLedger(value)) {
    throw new Error(`${PROPAGATION_LEDGER_FILE} is not a propagation ledger this engine reads.`);
  }
  return value;
}

/** Writes the ledger, creating its folder. */
export async function writePropagationLedger(root: string, ledger: PropagationLedger): Promise<void> {
  const path = join(root, PROPAGATION_LEDGER_FILE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, ledgerText(ledger));
}

/** The receipt with this id, or `undefined`. */
export function findReceipt(ledger: PropagationLedger, id: string): PropagationReceipt | undefined {
  return ledger.receipts.find((receipt) => receipt.id === id);
}

/** The ledger with `receipt` added; an existing receipt with the same id is kept unchanged. */
export function recordReceipt(ledger: PropagationLedger, receipt: PropagationReceipt): PropagationLedger {
  if (findReceipt(ledger, receipt.id) !== undefined) return ledger;
  return { version: 1, receipts: [...ledger.receipts, receipt] };
}

/**
 * Marks a receipt verified after its downstream task verifies. A receipt that is already verified or applied is
 * returned unchanged, so verifying twice is a no-op.
 */
export function verifyReceipt(ledger: PropagationLedger, id: string): PropagationVerification | undefined {
  const receipt = findReceipt(ledger, id);
  if (receipt === undefined) return undefined;
  if (receipt.status === "verified" || receipt.status === "applied") {
    return { receipt, unchanged: true };
  }
  const verified: PropagationReceipt = {
    ...receipt,
    status: "verified",
    reason: "The downstream task verified against the change.",
  };
  return { receipt: verified, unchanged: false };
}

/** The ledger with one receipt replaced by a new revision of the same id. */
export function replaceReceipt(ledger: PropagationLedger, receipt: PropagationReceipt): PropagationLedger {
  return {
    version: 1,
    receipts: ledger.receipts.map((entry) => (entry.id === receipt.id ? receipt : entry)),
  };
}

/** The ledger with one receipt replaced after verification. */
export function withVerifiedReceipt(ledger: PropagationLedger, receipt: PropagationReceipt): PropagationLedger {
  return replaceReceipt(ledger, receipt);
}
