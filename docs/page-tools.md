# Baseline: a browser tool under a documentation base path

Epic: #539. Baseline for #540, before any page-tools change.

## Fixture

One site with `base: /sample`, a theme component `sample-tool` with a `client.ts`, and a site-owned `tool/` folder
holding an `index.html`, a `tool.js`, and a `data.json`. The page renders the component with
`input="/sample/tool/data.json"`. Built with `build({ root, out, themeRoot, defaultLayout: "doc" })` in
`test/page-tools/baseline.test.ts`.

## What already worked

- A theme component with a `client.ts` becomes an island module at
  `assets/theme/islands/components/sample-tool/client.js`, written under the base as `/sample/assets/theme/...`.
- The island is type-stripped and emits a `<script type="module" src="...">` only on pages that render the component.
  A page without the component gets neither the script nor the island reference.
- Site-owned files under `tool/` are copied byte for byte, and their relative URLs (`<script src="tool.js">`,
  `fetch("data.json")`) keep working when the folder is opened directly.

## Confirmed gaps

1. **A page cannot own a tool module.** Only the theme's `client.ts` can become a module. A site's own `tool.js` is
   copied, not linked from the page, so browser behavior has to live in the theme.
2. **A copied tool is not base-aware.** `tool/index.html` and its relative URLs are written unchanged; serving it under
   `/sample/` works only because the folder is self-contained and the page passes absolute input URLs by hand.
3. **Nothing ties the page to the tool.** The page markup and the tool's local input are connected only by a hand-written
   prop; the build has no way to resolve a configured tool asset for a page.

## Minimal fixture for the next steps

Keep the same shape: one site with a base path, one page that configures a tool, one theme-provided client module, and
one site-owned tool folder. #541 can then resolve page-scoped assets, #542 can render the tool, and #543 can verify
scope and local input in a browser.
