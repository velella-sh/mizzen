/**
 * Expected stdout and stderr comparison (#1329). The whitespace rule is documented and applied the same way to both
 * streams: CRLF folds to LF, trailing spaces go, trailing newlines drop; a pattern mode matches a regular expression.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { compilePattern, matchOutput, normalizeOutput, WHITESPACE_RULE } from "../src/examples/match.ts";

test("exact comparison normalizes line endings and trailing whitespace and newlines", () => {
  assert.equal(normalizeOutput("a\r\nb\r\n"), "a\nb");
  assert.equal(normalizeOutput("a  \nb\t\n\n"), "a\nb");
  const result = matchOutput("hello\n", "hello\r\n", "exact");
  assert.equal(result.ok, true);
  assert.equal(result.expected, "hello");
  assert.equal(result.actual, "hello");
});

test("an internal blank line and leading indentation are significant", () => {
  assert.equal(matchOutput("a\n\nb", "a\nb", "exact").ok, false);
  assert.equal(matchOutput("  a", "a", "exact").ok, false);
  assert.equal(matchOutput("  a", "  a\n", "exact").ok, true);
});

test("a mismatch reports a bounded first difference", () => {
  const result = matchOutput("expected value", "actual value", "exact");
  assert.equal(result.ok, false);
  assert.ok(result.difference);
  assert.equal(typeof result.difference?.offset, "number");
  assert.match(result.difference?.expected ?? "", /expected/);
});

test("pattern mode matches a regular expression over the normalized text", () => {
  const ok = matchOutput("value: \\d+", "value: 42\n", "pattern");
  assert.equal(ok.ok, true);
  const no = matchOutput("^value: \\d+$", "nope", "pattern");
  assert.equal(no.ok, false);
  assert.equal(no.problem, "no-match");
});

test("pattern mode anchors to lines because the whole text is multiline and searched", () => {
  assert.equal(matchOutput("^second$", "first\nsecond\nthird", "pattern").ok, true);
});

test("an invalid pattern is a distinct problem, not a mismatch", () => {
  const result = matchOutput("(unclosed", "anything", "pattern");
  assert.equal(result.ok, false);
  assert.equal(result.problem, "invalid-pattern");
  const compiled = compilePattern("(unclosed");
  assert.ok("error" in compiled);
});

test("the whitespace rule is stated once, for the diagnostic help", () => {
  assert.match(WHITESPACE_RULE, /CRLF/);
  assert.match(WHITESPACE_RULE, /regular expression/);
});

test("the same inputs always give the same result", () => {
  const args = ["a\nb", "a\nc", "exact"] as const;
  assert.deepEqual(matchOutput(...args), matchOutput(...args));
});
