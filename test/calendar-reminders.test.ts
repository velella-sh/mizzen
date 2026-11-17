import assert from "node:assert/strict";
import { test } from "node:test";
import { alarmsFor, parseReminders, reminderDays } from "../src/calendar/reminders.ts";
import { writeIcs } from "../src/calendar/ics.ts";

test("whole days are accepted; every other form is rejected", () => {
  assert.equal(reminderDays("30d"), 30);
  assert.equal(reminderDays("7d"), 7);
  for (const bad of ["12h", "0d", "1.5d", "-3d", "2w", "30", "d", "", "+3d", 7, null]) {
    assert.equal(reminderDays(bad), undefined, String(bad));
  }
  assert.deepEqual(parseReminders(["7d", "12h", "30d", "7d"]), { days: [30, 7], rejected: ["12h"] });
});

test("no list means no reminders", () => {
  assert.deepEqual(parseReminders(undefined), { days: [], rejected: [] });
  assert.deepEqual(alarmsFor([], "x", {}), []);
});

test("one reminder writes one VALARM, two write two", () => {
  const one = alarmsFor([30], "Node 20 ends", { name: "Node 20" });
  assert.deepEqual(one, [{ days: 30, description: "Node 20 ends in 30 days" }]);
  const two = alarmsFor([30, 7], "Node 20 ends", { name: "Node 20" }, "{name}: {days} days left");
  assert.deepEqual(two.map((a) => a.description), ["Node 20: 30 days left", "Node 20: 7 days left"]);
  const text = writeIcs({ events: [{ uid: "a", stamp: "2026-01-01", start: "2026-04-30", summary: "x", alarms: two }] });
  assert.equal(text.match(/BEGIN:VALARM/g)?.length, 2);
  assert.match(text, /TRIGGER:-P30D/);
  assert.match(text, /TRIGGER:-P7D/);
});
