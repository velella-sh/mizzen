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

## Ground rules

- Use only erasable TypeScript syntax (no `enum`, `namespace`, or parameter properties) and import local files with their `.ts` extension.
- Never commit compiled output.
- Keep a pull request to one change, and describe what it fixes and how you checked it.
- Security problems go through the organization's security policy, not a public issue.

## Releasing

Publishing a GitHub Release publishes the same version to npm. The [`release`](.github/workflows/release.yml) workflow does the rest: it checks that the tag is `v<package.json version>` and is on `main`, runs the tests, type check, and package smoke test, packs one tarball, and publishes that exact tarball with provenance. A version with a suffix (`0.4.0-rc.1`) goes to the `next` dist-tag; any other goes to `latest`.

To release: bump `version` in `package.json`, move the changelog fragments, merge to `main`, then create a release tagged `v<version>` on that commit. If a publish fails, run the `release` workflow by hand with the same tag; a version already on npm is skipped.

### One-time setup

There is no npm token. npm trusted publishing lets the workflow publish with its own short-lived identity.

1. On npmjs.com, open `@velella/mizzen` → Settings → Trusted publisher → GitHub Actions: organization `velella-sh`, repository `mizzen`, workflow `release.yml`, environment `npm`.
2. In the repository settings, create an environment named `npm`. Optionally add required reviewers to approve each publish, and restrict it to release tags.
3. Optionally set the package's publishing access to "Require two-factor authentication and disallow tokens", so only this workflow can publish.
