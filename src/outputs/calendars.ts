/**
 * The `calendars` output: one `.ics` file per calendar the site config declares, and one per group value when the
 * calendar has a `groupBy`.
 *
 * Event ids and stamps come from the data (`../calendar/uid.ts`), so two builds of the same data write the same bytes.
 * An empty calendar writes no file and is reported. Calendar apps need absolute links, so a site with calendars but no
 * valid `url` writes none and reports it once.
 */
import { writeIcs } from "../calendar/ics.ts";
import { byCodePoint, calendarEvents, calendarGroups } from "../calendar/build.ts";
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

      for (const group of calendarGroups(name, events, (d) => ctx.report(d))) {
        files.push({
          path: group.file,
          contents: writeIcs({ name: `${title} (${group.value})`, events: group.events.slice(0, limit).map((e) => e.event) }),
        });
      }
    }
    return files.sort((a, b) => byCodePoint(a.path, b.path));
  },
};
