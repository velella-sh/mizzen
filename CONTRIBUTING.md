# Contributing to Mizzen

Thank you for helping. Most contributions are a bug report, a fix, a docs improvement, or a new test.

## Set up

Mizzen needs Node 24 or later, which runs the TypeScript source directly: there is no build step.

```bash
git clone https://github.com/velella-sh/lateen.git
git clone https://github.com/velella-sh/mizzen.git
cd mizzen
npm ci
(cd ../lateen && npm ci)
```

Lateen is checked out beside this repository because the tests and the docs site build with both.

## Before you open a pull request

```bash
npm run typecheck
npm test
```

A change to behavior needs a test beside the others in `test/`. A change to the docs site is checked with `node bin/mizzen.ts check site` and must report 0 errors.

### CI

PRs run type checking and the theme boundary, all tests in two shards (up to four test files at once per runner), package smoke tests, the docs site check, and
social-image checks on Linux, macOS, and Windows in parallel. Nothing is selected by changed paths. Configure branch
protection to require **`ci-required`**, which fails if any correctness job fails, is cancelled, or is skipped.
Superseded runs are cancelled only on the same PR; each `main` commit keeps its own checks and 95% coverage gate.
All theme-dependent jobs check out Lateen's latest `main`; a failure can therefore come from either repository.

The full data benchmark runs nightly at 02:23 UTC, manually from the **data benchmark** workflow (select a branch to
check before merging a performance-sensitive PR), and against the exact release tag before publishing. It retains all
three repetitions and the existing budgets; build outputs are not cached between runs. A failed nightly run opens or
updates an issue through the **benchmark alert** workflow; keep GitHub Issues enabled and subscribe to that issue.
Only npm downloads are cached; installations still use `npm ci`.

## Ground rules

- Use only erasable TypeScript syntax (no `enum`, `namespace`, or parameter properties) and import local files with their `.ts` extension.
- Never commit compiled output.
- Keep a pull request to one change, and describe what it fixes and how you checked it.
- Security problems go through the organization's security policy, not a public issue.

## Releasing

Pushing a tag `v<version>` or publishing a GitHub Release publishes that version to npm. The [`release`](.github/workflows/release.yml) workflow does the rest: it checks that the tag is `v<package.json version>` and is on `main`, runs the tests with the 95% coverage gate, type check, and package smoke test, packs one tarball, checks the full data benchmark, and publishes that exact tarball with provenance. A version with a suffix (`0.4.0-rc.1`) goes to the `next` dist-tag; any other goes to `latest`.

To release: bump `version` in `package.json` (and `src/index.ts`), move the changelog fragments, merge to `main`, then push the tag or create a release on that commit. If a publish fails, run the `release` workflow by hand with the same tag; a version already on npm is skipped.

To publish a pre-release without moving `latest`, use a suffix version such as `0.3.0-next.0` and tag it `v0.3.0-next.0`. It is published under `next` like any other release.

### One-time setup

There is no npm token. npm trusted publishing lets the workflow publish with its own short-lived identity.

1. On npmjs.com, open `@velella/mizzen` → Settings → Trusted publisher → GitHub Actions: organization `velella-sh`, repository `mizzen`, workflow `release.yml`, environment `npm`.
2. In the repository settings, create an environment named `npm`. Optionally add required reviewers to approve each publish, and restrict it to release tags.
3. Optionally set the package's publishing access to "Require two-factor authentication and disallow tokens", so only this workflow can publish.
