import assert from "node:assert/strict";
import { test } from "node:test";
import { fitText, isRtl } from "../src/social/text.ts";

/** Every character is half the font size wide, so the arithmetic is checkable by hand. */
const measure = (text: string, size: number): number => [...text].length * size * 0.5;
const base = { width: 400, maxSize: 40, minSize: 20, maxLines: 3, measure };

test("a short title stays on one line at the largest size", () => {
  const fit = fitText({ ...base, text: "Hello world" });
  assert.deepEqual(fit.lines, ["Hello world"]);
  assert.equal(fit.size, 40);
  assert.equal(fit.truncated, false);
});

test("a long title shrinks until it fits", () => {
  const text = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen";
  const fit = fitText({ ...base, text });
  assert.ok(fit.size < 40 && fit.size >= 20);
  assert.ok(fit.lines.length <= 3);
  assert.equal(fit.lines.join(" "), text);
  for (const line of fit.lines) assert.ok(measure(line, fit.size) <= 400);
  assert.equal(fit.truncated, false);
});

test("a text too long for any size is cut with an ellipsis on the last line", () => {
  const fit = fitText({ ...base, text: "word ".repeat(80) });
  assert.equal(fit.size, 20);
  assert.equal(fit.lines.length, 3);
  assert.equal(fit.truncated, true);
  assert.ok(fit.lines[2]!.endsWith("…"));
  assert.ok(measure(fit.lines[2]!, 20) <= 400);
});

test("a single very long word is broken instead of overflowing", () => {
  const fit = fitText({ ...base, text: "x".repeat(70) });
  assert.equal(fit.truncated, false);
  assert.ok(fit.lines.length > 1);
  assert.equal(fit.lines.join(""), "x".repeat(70));
  for (const line of fit.lines) assert.ok(measure(line, fit.size) <= 400);
  const cut = fitText({ ...base, text: "x".repeat(400) });
  assert.equal(cut.truncated, true);
  assert.equal(cut.lines.length, 3);
});

test("white space collapses and empty text gives no lines", () => {
  assert.deepEqual(fitText({ ...base, text: "  a \n\t b  " }).lines, ["a b"]);
  assert.deepEqual(fitText({ ...base, text: "   " }).lines, []);
});

test("Persian text is marked right to left and wraps like any other", () => {
  const text = "نصب همیشه‌سبز روی یک دستگاه تازه در کمتر از پنج دقیقه";
  const fit = fitText({ ...base, text });
  assert.equal(fit.rtl, true);
  assert.equal(fit.lines.join(" "), text);
  assert.equal(isRtl("Install"), false);
  assert.equal(isRtl("123 نصب"), true);
  assert.equal(isRtl("Node نصب"), false);
});

test("the same input always gives the same lines", () => {
  const input = { ...base, text: "alpha beta gamma delta epsilon zeta eta theta iota kappa" };
  assert.deepEqual(fitText(input), fitText(input));
});
