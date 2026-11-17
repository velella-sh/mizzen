import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const page = readFileSync(new URL("../site/data/calendars.md", import.meta.url), "utf8");
const navigation = readFileSync(new URL("../site/_data/navigation.yml", import.meta.url), "utf8");
type Schema = { properties?: Record<string, Schema>; $defs?: Record<string, Schema> };
const config = JSON.parse(readFileSync(new URL("../schema/config.schema.json", import.meta.url), "utf8")) as Schema;
const defs = config.$defs!;

/** The first-column keys of the table under the heading `heading`. */
function documentedKeys(heading: string): string[] {
  const start = page.indexOf(`${heading}\n`);
  assert.notEqual(start, -1, `the page has a "${heading}" section`);
  const keys: string[] = [];
  for (const line of page.slice(start).split("\n").slice(1)) {
    if (line.startsWith("#")) break;
    const match = /^\| `([^`]+)` \|/.exec(line);
    if (match !== null) keys.push(match[1]!);
  }
  return keys.sort();
}

test("the calendar keys the page documents are the keys of the calendar schema", () => {
  assert.deepEqual(documentedKeys("## Declare a calendar"), Object.keys(defs.calendar!.properties!).sort());
});

test("the event keys the page documents are the keys of the event schema", () => {
  assert.deepEqual(documentedKeys("### Events"), Object.keys(defs.calendarEvent!.properties!).sort());
});

test("the window keys the page documents are the keys of the feed window schema", () => {
  assert.deepEqual(documentedKeys("## A feed of what ends soon"), Object.keys(defs.feed!.properties!.window!.properties!).sort());
});

test("the page covers ids, reminders, subscribing, and the window feed", () => {
  for (const word of ["UID", "DTSTAMP", "updated", "reminders", "VALARM", "calendar.ics", "webcal", "llms.txt", "dates.no-as-of", "--as-of", "asOf", "referenceDate"]) {
    assert.ok(page.includes(word), word);
  }
});

test("the calendars page is in the data navigation", () => {
  assert.ok(navigation.includes("url: /data/calendars/"));
});
