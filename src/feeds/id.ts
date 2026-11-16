/**
 * Entry ids for collection feeds: a tag URI built from the site's host, the collection, and the record id.
 *
 * The id never contains the record's page URL, so renaming a record's URL keeps its feed entry. An `idField` adds the
 * field's value to the id, so a new event of the same record is a new entry.
 */
export function entryId(origin: string, collection: string, record: string, extra?: string): string {
  const host = new URL(origin).hostname;
  const suffix = extra === undefined || extra.trim() === "" ? "" : `/${encodeURIComponent(extra.trim())}`;
  return `tag:${host}:${encodeURIComponent(collection)}/${encodeURIComponent(record)}${suffix}`;
}
