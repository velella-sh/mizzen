/**
 * The `calendars` output: one `.ics` file per calendar the site config declares, and one per group value when the
 * calendar has a `groupBy`.
 *
 * Event ids and stamps come from the data (`../calendar/uid.ts`), so two builds of the same data write the same bytes.
 * An empty calendar writes no file and is reported. Calendar apps need absolute links, so a site with calendars but no
 * valid `url` writes none and reports it once.
 */
import { writeIcs } from "../calendar/ics.ts";
import { byCodePoint, calendarEvents } from "../calendar/build.ts";
import { slugOf } from "../data/slug.ts";
import type { Site } from "../contracts/index.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";
import { originOf } from "../feeds/model.ts";

/** Writes the declared calendars, sorted by path. */
export const calendars: Output = {
  name: "calendars",
  async run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]> {
    const declared = site.config.calendars ?? {};
    const names = Object.keys(declared);
    if (names.length === 0) return [];

    const origin = originOf(site.config.url);
    if (origin === undefined) {
      ctx.report({
        id: "calendars.no-url",
        severity: "warning",
        message: "The site declares calendars, but has no valid `url`, so no event can carry a stable id or an absolute link.",
        help: "Set `url: https://example.com` in the site config.",
      });
      return [];
    }

    const files: OutputFile[] = [];
    for (const name of names) {
      const calendar = declared[name]!;
      const { events, skipped } = calendarEvents(site, name, calendar, origin, (d) => ctx.report(d));
      if (skipped > 0) {
        ctx.report({
          id: "calendars.skipped",
          severity: "info",
          message: `The calendar "${name}" skipped ${skipped} event${skipped === 1 ? "" : "s"} whose record has no date for it.`,
        });
      }
      const limit = calendar.limit ?? Number.POSITIVE_INFINITY;
      const title = `${site.config.title}: ${name}`;
      if (events.length === 0) {
        ctx.report({
          id: "calendars.empty",
          severity: "warning",
          message: `The calendar "${name}" has no events, so no file is written.`,
          help: "Check its `where` and the date fields of its events.",
        });
        continue;
      }
      files.push({ path: `calendars/${name}.ics`, contents: writeIcs({ name: title, events: events.slice(0, limit).map((e) => e.event) }) });

      if (calendar.groupBy === undefined) continue;
      const groups = new Map<string, typeof events>();
      for (const item of events) {
        for (const value of item.groups) groups.set(value, [...(groups.get(value) ?? []), item]);
      }
      const used = new Map<string, string>();
      for (const value of [...groups.keys()].sort(byCodePoint)) {
        const slug = slugOf(value);
        const clash = used.get(slug);
        if (slug === "" || clash !== undefined) {
          ctx.report({
            id: "calendars.group-name",
            severity: "warning",
            message:
              slug === ""
                ? `The group "${value}" of the calendar "${name}" has no letters or digits for a file name, so it has no file.`
                : `The groups "${clash}" and "${value}" of the calendar "${name}" give the same file name "${slug}.ics"; the second has no file.`,
          });
          continue;
        }
        used.set(slug, value);
        files.push({
          path: `calendars/${name}/${slug}.ics`,
          contents: writeIcs({ name: `${title} (${value})`, events: groups.get(value)!.slice(0, limit).map((e) => e.event) }),
        });
      }
    }
    return files.sort((a, b) => byCodePoint(a.path, b.path));
  },
};
