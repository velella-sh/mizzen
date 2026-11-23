/**
 * Gathers every explicit knowledge declaration a site holds: one per authored page and one per collection record.
 * A generated page (a record page, an API reference page, a list page's later pages) is not a subject of its own:
 * its knowledge is the record's, or the page it was generated from. This keeps the report from counting one authored
 * statement many times as generated pages.
 */
import type { Page, Site } from "../contracts/index.ts";
import type { KnowledgeScope, KnowledgeSubject } from "../contracts/knowledge.ts";
import type { SourcePos } from "../contracts/source.ts";

/** One subject with the declaration it holds, if any. */
export interface KnowledgeSubjectEntry {
  readonly subject: KnowledgeSubject;
  /** The declaration's span, or the subject's own span when it declares none. */
  readonly span: SourcePos;
  /** The declaration, when the subject declares one. */
  readonly declaration?: import("../contracts/knowledge.ts").KnowledgeDeclaration;
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whether a page is an authored subject: a doc page that is not generated from a record or an API operation. */
function isAuthoredPage(page: Page): boolean {
  if (page.kind !== "doc") return false;
  if (page.record !== undefined) return false;
  const api = page.frontMatter.apiReference;
  return !(typeof api === "object" && api !== null && !Array.isArray(api));
}

/** Every subject of the site, sorted by kind then id. */
export function knowledgeSubjectsOf(site: Site): readonly KnowledgeSubjectEntry[] {
  const entries: KnowledgeSubjectEntry[] = [];
  for (const page of site.pages) {
    if (!isAuthoredPage(page)) continue;
    entries.push({
      subject: { kind: "page", id: page.source.file },
      span: page.knowledge?.span ?? page.source,
      ...(page.knowledge === undefined ? {} : { declaration: page.knowledge }),
    });
  }
  for (const name of Object.keys(site.collections).sort(byCodePoint)) {
    const collection = site.collections[name]!;
    for (const record of collection.records) {
      entries.push({
        subject: { kind: "record", id: `${name}/${record.id}` },
        span: record.knowledge?.span ?? {
          file: record.position.file,
          line: record.position.startLine,
          column: record.position.startColumn,
          endLine: record.position.endLine,
          endColumn: record.position.endColumn,
        },
        ...(record.knowledge === undefined ? {} : { declaration: record.knowledge }),
      });
    }
  }
  return entries.sort(
    (a, b) => byCodePoint(a.subject.kind, b.subject.kind) || byCodePoint(a.subject.id, b.subject.id),
  );
}

/** A query's scope: the dimensions a caller is asking about. */
export type KnowledgeQueryScope = readonly KnowledgeScope[];

/** The one-line description of a scope, such as `platform:windows, version:v2`. */
export function scopeText(scope: readonly KnowledgeScope[]): string {
  return scope.map((limit) => `${limit.kind}:${limit.value}`).join(", ");
}
