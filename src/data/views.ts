/**
 * Resolves a collection's named views for one record: which template and layout each page uses, and the URL each view
 * gets from the same record fields the main page uses. A view is another rendering of one record, never a record of
 * its own, so a view URL that cannot be filled is a finding at that record and the view is left out.
 */
import type { CollectionConfig, Diagnostic, RecordPos } from "../contracts/index.ts";
import { recordUrl } from "./permalink.ts";
import type { Template } from "./template.ts";

/** One view of a collection, paired with its loaded template. */
export interface View {
  /** The view's name, as the config key writes it. */
  readonly name: string;
  /** The view's own template. */
  readonly template: Template;
  /** URL pattern of the view page. */
  readonly permalink: string;
  /** Layout named by the config, when it names one. */
  readonly layout?: string;
}

/** The views a collection declares that also loaded a template, in config order. */
export function viewsOf(
  entry: CollectionConfig,
  templates: Readonly<Record<string, Template>>,
): readonly View[] {
  const views: View[] = [];
  for (const [name, view] of Object.entries(entry.views ?? {})) {
    const template = templates[name];
    if (template === undefined) continue;
    views.push({
      name,
      template,
      permalink: view.permalink,
      ...(view.layout === undefined ? {} : { layout: view.layout }),
    });
  }
  return views;
}

/** The URL of every view of one record, keyed by view name; a view whose pattern cannot be filled is reported. */
export function viewUrls(
  views: readonly View[],
  collection: string,
  record: { readonly id: string; readonly position: RecordPos },
  fields: Readonly<Record<string, unknown>>,
  options: { readonly base: string; readonly prefix: string },
  diagnostics: Diagnostic[],
): Readonly<Record<string, string>> {
  const urls: Record<string, string> = {};
  for (const view of views) {
    const filled = recordUrl(collection, record.id, fields, { permalink: view.permalink }, {
      base: options.base,
      prefix: options.prefix,
      position: record.position,
    });
    if (filled.diagnostic !== undefined) {
      diagnostics.push(filled.diagnostic);
      continue;
    }
    if (filled.url !== undefined) urls[view.name] = filled.url;
  }
  return urls;
}
