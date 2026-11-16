import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { escapeText, foldLine, nextDay, writeIcs, type IcsCalendar } from "../src/calendar/ics.ts";

test("text escaping covers backslash, semicolon, comma, and line breaks", () => {
  assert.equal(escapeText("a;b,c\\d\r\ne\nf"), "a\;b\\,c\\\\d\\ne\\nf");
  assert.equal(escapeText("tab\there\u0007"), "tab\there");
});

test("a short line is not folded, and a long one folds at 75 octets with a leading space", () => {
  assert.deepEqual(foldLine("x".repeat(75)), ["x".repeat(75)]);
  const folded = foldLine("x".repeat(160));
  assert.deepEqual(folded.map((l) => l.length), [75, 75, 12]);
  assert.ok(folded.slice(1).every((l) => l.startsWith(" ")));
  assert.equal(folded.map((l, i) => (i === 0 ? l : l.slice(1))).join(""), "x".repeat(160));
});

test("folding never splits a multi-byte character", () => {
  const text = "SUMMARY:" + "پایان پشتیبانی نسخه ".repeat(8) + "😀".repeat(30);
  const folded = foldLine(text);
  const encoder = new TextEncoder();
  for (const line of folded) {
    assert.ok(encoder.encode(line).length <= 75, line);
    // A split inside a character would leave a replacement character after decoding.
    assert.ok(!new TextDecoder().decode(encoder.encode(line)).includes("�"));
  }
  assert.equal(folded.map((l, i) => (i === 0 ? l : l.slice(1))).join(""), text);
});

test("nextDay crosses month and year ends", () => {
  assert.equal(nextDay("2026-02-28"), "2026-03-01");
  assert.equal(nextDay("2026-12-31"), "2027-01-01");
  assert.throws(() => nextDay("2026-1-1"));
});

const calendar: IcsCalendar = {
  name: "Runtime end of life",
  events: [
    { uid: "runtimes-node-eol@example.com", stamp: "2026-05-01", start: "2026-04-30", summary: "Node 20, end of life", description: "Upgrade; plan, test.\nSee notes.", url: "https://example.com/runtimes/node/", alarms: [{ days: 30, description: "Node 20 ends in 30 days" }, { days: 7, description: "Node 20 ends in 7 days" }] },
    { uid: "runtimes-node-support@example.com", stamp: "2026-05-01", sequence: 2, start: "2026-12-30", end: "2027-01-02", summary: "پایان پشتیبانی امنیتی نسخه بیست، مدت طولانی برای تست تا خط تا شود" },
  ],
};

test("the calendar matches the golden file, with CRLF line ends and fixed property order", () => {
  const text = writeIcs(calendar);
  const file = new URL("./fixtures/calendar/basic.ics", import.meta.url);
  if (process.env.UPDATE_GOLDEN === "1") writeFileSync(file, text);
  assert.equal(text, readFileSync(file, "utf8"));
  assert.ok(text.endsWith("\r\n"));
  assert.ok(!/[^\r]\n/.test(text));
  assert.equal(writeIcs(calendar), text);
});

test("a one-day event ends the next day, and an end before the start is ignored", () => {
  const text = writeIcs({ events: [{ uid: "a", stamp: "2026-01-01", start: "2026-03-31", end: "2026-03-01", summary: "x" }] });
  assert.match(text, /DTSTART;VALUE=DATE:20260331\r\nDTEND;VALUE=DATE:20260401\r\n/);
  assert.doesNotMatch(text, /SEQUENCE/);
});
