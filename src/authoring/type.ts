/**
 * Recommend a reference, guide, example, or runbook page for one gap, and record why (#1408).
 *
 * The purpose is the deciding rule: a lookup becomes a reference, a description becomes a guide, a demonstration
 * becomes an example, and an operational procedure becomes a runbook. The purpose comes from the surface kind and the
 * gap, unless the caller states it. The matched rule ids and the sentence are kept on the choice, so a reviewer can
 * disagree with a rule instead of guessing.
 */
import type { AuthoringPageType, AuthoringPageTypeChoice, AuthoringPurpose, AuthoringSurfaceItem } from "../contracts/authoring.ts";
import type { SurfaceGapKind } from "../contracts/surface.ts";

/** The surface kinds a reader looks up by name rather than following as a procedure. */
const LOOKUP_KINDS: ReadonlySet<string> = new Set([
  "symbol",
  "operation",
  "parameter",
  "response",
  "config-key",
  "collection",
  "field",
  "version",
  "flag",
  "argument",
]);

/** The command names that perform an operational procedure rather than describe a workflow. */
const OPERATIONAL_COMMANDS: ReadonlySet<string> = new Set([
  "build",
  "check",
  "clean",
  "deploy",
  "dev",
  "doctor",
  "extract",
  "fetch",
  "import",
  "init",
  "install",
  "migrate",
  "publish",
  "recover",
  "refresh",
  "release",
  "repair",
  "restore",
  "rollback",
  "upgrade",
  "verify",
  "watch",
]);

/** The page type each purpose recommends. */
const TYPE_BY_PURPOSE: Readonly<Record<AuthoringPurpose, AuthoringPageType>> = {
  lookup: "reference",
  describe: "guide",
  demonstrate: "example",
  operate: "runbook",
};

/** Why the purpose of one item, without an explicit override. */
export function defaultPurpose(item: AuthoringSurfaceItem, gap: SurfaceGapKind): { readonly purpose: AuthoringPurpose; readonly rules: readonly string[] } {
  if (gap === "partial") return { purpose: "describe", rules: ["gap.partial"] };
  if (item.kind === "command") {
    return OPERATIONAL_COMMANDS.has(item.name)
      ? { purpose: "operate", rules: ["surface.command", "command.operational"] }
      : { purpose: "describe", rules: ["surface.command", "command.workflow"] };
  }
  if (LOOKUP_KINDS.has(item.kind)) return { purpose: "lookup", rules: ["surface.lookup-kind"] };
  return { purpose: "describe", rules: ["surface.default"] };
}

/** A sentence naming the item, purpose, and page type. */
function reasonOf(item: AuthoringSurfaceItem, purpose: AuthoringPurpose, pageType: AuthoringPageType): string {
  const what: Readonly<Record<AuthoringPurpose, string>> = {
    lookup: "a reader looks this item up by name",
    describe: "a reader needs the item explained in context",
    demonstrate: "a reader learns the item by running it",
    operate: "a reader follows the item as an operational procedure",
  };
  return `${item.id} is ${item.kind} and ${what[purpose]}, so a ${pageType} page is recommended.`;
}

/**
 * Recommends one page type. An explicit purpose wins over the derived one; both the purpose rule and the page-type
 * rule are recorded, so the reason is reproducible.
 */
export function recommendPageType(
  item: AuthoringSurfaceItem,
  gap: SurfaceGapKind,
  purpose?: AuthoringPurpose,
): AuthoringPageTypeChoice {
  const derived = defaultPurpose(item, gap);
  const selected = purpose ?? derived.purpose;
  const rules = [...derived.rules, purpose === undefined ? "purpose.derived" : "purpose.explicit", `page-type.${selected}`];
  return {
    kind: TYPE_BY_PURPOSE[selected],
    purpose: selected,
    reason: reasonOf(item, selected, TYPE_BY_PURPOSE[selected]),
    rules,
  };
}
