/**
 * Read checks for site content: a page, its blocks, and the record fields it renders.
 *
 * The policy is evaluated against semantic ids, never against rendered text. A hidden page is reported as denied
 * without naming its title, URL, source path, or block ids, so an omission can say "not allowed" without becoming
 * a directory of what exists.
 */
import type { Page } from "../contracts/content.ts";
import type { AccessPolicy, AccessResource } from "../contracts/permissions.ts";
import { readRule } from "./evaluate.ts";

/** The audiences a front matter value names: one string, a list of strings, or none. */
export function audiencesOf(value: unknown): readonly string[] {
  if (typeof value === "string") return value.trim() === "" ? [] : [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
}

/** The read resource a page stands for. */
export function pageResource(page: Page): AccessResource {
  return {
    kind: "page",
    id: page.source.file,
    page: page.url,
    audiences: audiencesOf(page.frontMatter.audience),
  };
}

/**
 * Whether a page may be read. A page is denied when its audience, page, or rendered collection field is denied.
 *
 * A policy that restricts blocks or fields is conservative for a whole-page read: a page holding one restricted
 * block or one restricted record field is denied rather than partially rendered, so a pack can never echo the
 * private part through a heading, anchor, or trim omission.
 *
 * shortcut: block and field restrictions deny the whole page instead of trimming its body; upgrade when the pack
 * compiler can splice an exact source span out of a page's Markdown.
 */
export function readablePage(policy: AccessPolicy, page: Page): boolean {
  if (!readRule(policy, pageResource(page)).allowed) return false;
  if (policy.read.blocks !== undefined) {
    for (const block of page.blocks ?? []) {
      if (!readRule(policy, { kind: "block", id: block.id, page: page.url }).allowed) return false;
    }
  }
  const record = page.record;
  if (record !== undefined && policy.read.fields !== undefined) {
    const fields = policy.read.fields[record.collection];
    if (fields !== undefined) {
      const source = page.frontMatter;
      for (const field of Object.keys(source)) {
        if (!readRule(policy, { kind: "field", id: field, collection: record.collection, field }).allowed) return false;
      }
    }
  }
  return true;
}
