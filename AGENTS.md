# Working on Mizzen

A deterministic docs engine with exact source positions: config, content model, Markdown, navigation, render host, outputs, diagnostics, and CLI. The theme lives in Lateen, not here.

Start with the affected build stage or CLI command and its tests. Consult the [CLI reference](README.md#cli) for command behavior, the relevant guide in `docs/` for feature details, and [CONTRIBUTING.md](CONTRIBUTING.md) for CI and release procedures.

## Setup

Node 24 or later. Development has no build step; Node runs the TypeScript source directly.

The test suite reads a Lateen checkout at `../lateen`; CI checks one out there. Clone `velella-sh/lateen` beside this repository, then install both:

```bash
git clone https://github.com/velella-sh/lateen.git ../lateen
npm ci
(cd ../lateen && npm ci)
```

The engine never imports the theme; `test/boundary.test.ts` enforces that. The sibling checkout is for tests and fixtures only.

## Commands

```bash
npm run typecheck
npm test
npm run test:coverage    # fails under 95% lines
npm run build            # tsc -p tsconfig.build.json -> dist
node scripts/bench-data.ts
```

Before a pull request: `npm run typecheck && npm test`.

A docs site change must pass `node bin/mizzen.ts check site` with 0 errors.

## Architecture

A build runs eight stages, each a typed function: config, discover, front matter, Markdown, HTML, site model, render, outputs. Stages talk only through the frozen types in `src/contracts/`. The same input must give byte-identical output, in the same order, with LF line endings.

- `src/contracts/` is the seam. Changing a type there is an API change; check consumers and build.
- The theme boundary is enforced by `test/boundary.test.ts`. No theme code, color, layout, or stylesheet belongs here.
- Keep output deterministic: no timestamps, no unordered map iteration.

## Change rules

- Use only erasable TypeScript syntax (no `enum`, `namespace`, or parameter properties). Import local files with their `.ts` extension and mark type-only imports with `import type`.
- Never commit `dist/` or other compiled output.
- A behavior change needs a test beside the others in `test/`.
- One pull request = one change.
- Release by tag: bump `version` in `package.json` and `src/index.ts`, merge to `main`, then push `v<version>`. Do not publish to npm by hand.
