import assert from "node:assert/strict";
import { test } from "node:test";
import { compareReferences, referenceKey, referencesMessage } from "../src/verification/references.ts";
import type { ReferenceSnapshot } from "../src/verification/references.ts";

const BEFORE: ReferenceSnapshot = {
  urls: ["https://example.com/docs/", "https://example.com/install/"],
  blocks: ["install-steps", "faq"],
  redirects: { "/old/": "/guide/", "/legacy/": "/guide/" },
};

test("identical references pass and the result is stable", () => {
  const result = compareReferences(BEFORE, BEFORE);
  assert.equal(result.ok, true);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.changed, []);
  assert.deepEqual(result.invalid, []);
  assert.match(referencesMessage(result), /still resolves/u);
});

test("removing a URL without policy fails a criterion", () => {
  const after: ReferenceSnapshot = { ...BEFORE, urls: ["https://example.com/docs/"] };
  const result = compareReferences(BEFORE, after);
  assert.equal(result.ok, false);
  assert.deepEqual(result.removed, [referenceKey("url", "https://example.com/install/")]);
  assert.ok(result.issues.some((issue) => issue.code === "verification.reference-removed" && issue.kind === "url"));

  const allowed = compareReferences(BEFORE, after, { allowedRemovals: [referenceKey("url", "https://example.com/install/")] });
  assert.equal(allowed.ok, true);
  assert.deepEqual(allowed.removed, [referenceKey("url", "https://example.com/install/")]);
});

test("removing a block reference or a redirect fails unless the policy names it", () => {
  const withoutBlock: ReferenceSnapshot = { ...BEFORE, blocks: ["faq"] };
  assert.equal(compareReferences(BEFORE, withoutBlock).ok, false);
  assert.equal(
    compareReferences(BEFORE, withoutBlock, { allowedRemovals: [referenceKey("block", "install-steps")] }).ok,
    true,
  );

  const withoutRedirect: ReferenceSnapshot = {
    ...BEFORE,
    redirects: { "/legacy/": "/guide/" },
  };
  assert.equal(compareReferences(BEFORE, withoutRedirect).ok, false);
  assert.equal(
    compareReferences(BEFORE, withoutRedirect, { allowedRemovals: [referenceKey("redirect", "/old/")] }).ok,
    true,
  );
});

test("a redirect target change is a change, not a removal, and needs its own policy", () => {
  const after: ReferenceSnapshot = { ...BEFORE, redirects: { "/old/": "/new/", "/legacy/": "/guide/" } };
  const result = compareReferences(BEFORE, after);
  assert.equal(result.ok, false);
  assert.deepEqual(result.changed, [referenceKey("redirect", "/old/")]);
  assert.deepEqual(result.removed, []);
  const allowed = compareReferences(BEFORE, after, { allowedChanges: [{ ref: referenceKey("redirect", "/old/"), to: "/new/" }] });
  assert.equal(allowed.ok, true);
});

test("an invalid URL or redirect path is reported on both sides and never passes", () => {
  const invalid = compareReferences(
    { ...BEFORE, urls: ["not a url", ...BEFORE.urls], redirects: { "old": "/guide/", "/old/": "not a path" } },
    { ...BEFORE, urls: ["not a url", ...BEFORE.urls], redirects: { "old": "/guide/", "/old/": "not a path" } },
  );
  assert.equal(invalid.ok, false);
  assert.equal(invalid.issues.filter((issue) => issue.code === "verification.reference-invalid").length, 6);
  assert.ok(invalid.invalid.includes(referenceKey("url", "not a url")));
  assert.ok(invalid.invalid.includes(referenceKey("redirect", "old")));
});
