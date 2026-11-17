/**
 * Compares the API claims a page attaches to code references (`api-contract-check`).
 *
 * A claim is the inline code in a reference's paragraph (#614); the public name it states is resolved
 * through local re-exports (#615), and the signature the page writes is compared with the declaration
 * by the current signature comparison in `symbols.ts`. The comparison answers one state per claim:
 *
 * - `match` when the documented form and the declaration agree. A change inside a function body never
 *   makes one, because signatures normalize bodies away.
 * - `mismatch` when a stated parameter, member, type, generic, or return type differs, as
 *   `drift.signature-mismatch`.
 * - `missing` when the cited file no longer provides the name, as `drift.missing-symbol`.
 * - `moved` when the direct declaration exists but the cited line misses every declaration and overload
 *   line by more than the tolerance, as `drift.moved-symbol`.
 * - `unchecked` when the API cannot be read or the documented form cannot be compared, such as an
 *   inferred const, an enum, an ambiguous re-export, or a spread argument, as
 *   `drift.signature-unchecked` with the reason.
 *
 * A claim whose symbol resolves through a re-export is compared with the declaration it reaches; the
 * cited line is checked only when the claim cites the declaring file, since an entry file's line cannot
 * name a line in another module. A reference without a claim stays a path/line reference and is not
 * promoted here; `compare.ts` keeps that comparison. Findings point at the documentation claim and come
 * in page order, then reference order, with one result per claim and citation.
 */
import type { Diagnostic, Page } from "../contracts/index.ts";
import { DEFAULT_TOLERANCE } from "./compare.ts";
import { contractRefsOf, type ContractRef } from "./contract-refs.ts";
import { resolveContractSymbol, type ContractResolution } from "./contract-resolver.ts";
import { checkDocumentedSignature, documentedClaim } from "./symbols.ts";

/** What the comparison found for one documented API claim. */
export type ContractState = "match" | "mismatch" | "missing" | "moved" | "unchecked";

/** One claim's result, with the finding when it did not match. */
export interface ContractCheck {
  /** The documentation claim and citation that were judged. */
  readonly ref: ContractRef;
  /** Whether the claim agrees with the code, or why it could not be judged. */
  readonly state: ContractState;
  /** The finding to report; absent only for `match`. */
  readonly diagnostic?: Diagnostic;
}

/** How far a cited line may miss a declaration, and the site root references resolve inside. */
export interface ContractCompareOptions {
  /** Site root the cited paths and local re-exports resolve inside. */
  readonly root: string;
  /** How many lines the cited line may differ from a declaration line. Defaults to 5. */
  readonly tolerance?: number;
}

/**
 * Every API claim in `pages`, in page and reference order, each judged against the code. One claim is
 * reported once even when it attaches to several parameters or members. Reads only; no state is kept
 * between calls.
 */
export async function compareContractClaims(
  pages: readonly Page[],
  options: ContractCompareOptions,
): Promise<ContractCheck[]> {
  const tolerance = normalizeTolerance(options.tolerance);
  const checks: ContractCheck[] = [];
  const seen = new Set<string>();

  for (const page of pages) {
    for (const ref of await contractRefsOf(page)) {
      const key = claimKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      checks.push(await compareContractClaim(ref, options.root, tolerance));
    }
  }

  return checks;
}

/** One claim's state and finding. */
async function compareContractClaim(
  ref: ContractRef,
  root: string,
  tolerance: number,
): Promise<ContractCheck> {
  const documented = documentedClaim(ref.text);
  if (documented === null) {
    return { ref, state: "unchecked", diagnostic: unchecked(ref, "the claim does not name a symbol") };
  }

  const resolution = await resolveContractSymbol(ref.path, ref.symbol, { root });
  if (resolution.state === "missing") {
    return { ref, state: "missing", diagnostic: missing(ref) };
  }
  if (resolution.state === "ambiguous") {
    return { ref, state: "unchecked", diagnostic: unchecked(ref, ambiguousReason(resolution)) };
  }
  if (resolution.state === "unsupported") {
    return { ref, state: "unchecked", diagnostic: unchecked(ref, resolution.reason) };
  }

  const symbol = resolution.symbol;
  if (resolution.file === ref.path && !nearDeclaration(ref, symbol, tolerance)) {
    return { ref, state: "moved", diagnostic: moved(ref, symbol.line, tolerance) };
  }

  const check = checkDocumentedSignature(documented, symbol);
  if (check.state === "match") return { ref, state: "match" };
  if (check.state === "mismatch") {
    return { ref, state: "mismatch", diagnostic: mismatched(ref, symbol.signatures ?? [], symbol.name, symbol.kind) };
  }
  return { ref, state: "unchecked", diagnostic: unchecked(ref, check.reason) };
}

/** Identifies one claim attached to one citation, so its stated parameters and members are judged once. */
function claimKey(ref: ContractRef): string {
  const pos = ref.pos;
  return [
    pos.file,
    pos.line,
    pos.column,
    pos.endLine,
    pos.endColumn,
    ref.path,
    ref.line,
    ref.endLine ?? "",
    ref.text,
  ].join("\u0000");
}

/** True when the cited range reaches the declaration or one of its overloads. */
function nearDeclaration(
  ref: ContractRef,
  symbol: { readonly line: number; readonly signatures?: readonly { readonly line: number }[] },
  tolerance: number,
): boolean {
  if (distanceTo(ref, symbol.line) <= tolerance) return true;
  return (symbol.signatures ?? []).some((signature) => distanceTo(ref, signature.line) <= tolerance);
}

/** How many lines separate a declaration from the cited range; zero when the range reaches it. */
function distanceTo(ref: ContractRef, line: number): number {
  const last = ref.endLine ?? ref.line;
  if (line < ref.line) return ref.line - line;
  if (line > last) return line - last;
  return 0;
}

/** The tolerance as a whole number of lines, never negative. */
function normalizeTolerance(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TOLERANCE;
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.trunc(value);
}

/** The page names a symbol the cited file no longer exports. */
function missing(ref: ContractRef): Diagnostic {
  return {
    id: "drift.missing-symbol",
    severity: "warning",
    message: `"${ref.path}" does not export "${ref.symbol}", which this page claims at line ${ref.line}.`,
    pos: ref.pos,
    help: "Update the reference to the symbol's new name, or remove it.",
  };
}

/** The page documents a signature that does not match the declaration. */
function mismatched(
  ref: ContractRef,
  signatures: readonly { readonly text: string; readonly line: number }[],
  name: string,
  kind: string,
): Diagnostic {
  const actual = signatures.map((signature) => `"${signature.text}" (line ${signature.line})`);
  return {
    id: "drift.signature-mismatch",
    severity: "warning",
    message: `"${ref.path}" declares "${name}" as ${actual.length === 0 ? `a ${kind}` : actual.join(" or ")}, but this page documents "${ref.text}" at line ${ref.pos.line}.`,
    pos: ref.pos,
    help: "Update this documentation to match the declaration, or change the code.",
  };
}

/** The page documents a signature the check cannot compare. */
function unchecked(ref: ContractRef, reason: string): Diagnostic {
  return {
    id: "drift.signature-unchecked",
    severity: "warning",
    message: `Cannot check the signature "${ref.text}" at line ${ref.pos.line} against "${ref.path}": ${withoutPeriod(reason)}.`,
    pos: ref.pos,
    help: "Write the signature in a form this check can compare, or cite the declaration by name only.",
  };
}

/** The page names a symbol that exists, but its declaration moved outside the tolerance. */
function moved(ref: ContractRef, line: number, tolerance: number): Diagnostic {
  return {
    id: "drift.moved-symbol",
    severity: "warning",
    message: `"${ref.path}" declares "${ref.symbol}" at line ${line}; the cited line is ${ref.line}, outside the ${tolerance}-line tolerance.`,
    pos: ref.pos,
    help: `Point the reference at line ${line}, or update the page to match the code.`,
  };
}

/** Why an ambiguous re-export states no comparable API. */
function ambiguousReason(resolution: Extract<ContractResolution, { readonly state: "ambiguous" }>): string {
  return `"${resolution.name}" is provided by more than one re-export (${resolution.candidates.join(", ")})`;
}

/** A resolver reason without its own final period, so the finding reads as one sentence. */
function withoutPeriod(reason: string): string {
  return reason.endsWith(".") ? reason.slice(0, -1) : reason;
}
