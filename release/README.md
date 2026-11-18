# Release scope and the acceptance gate

`scope.json` lists every feature of the release that `package.json` names. Each entry is one of:

- `shipped`: a user-facing feature that a user can reach through the CLI, public configuration, or the exported
  contracts. It names a stable case id from `scripts/acceptance/cases.ts`. The case runs in PR CI and again from the
  exact tarball the publish job uploads, so a feature that a module implements but the CLI cannot reach fails the
  release.
- `deferred`: a feature that is not part of this release. It carries a reason and must not be mentioned as shipped in
  the changelog section for this version; the gate reads `CHANGELOG.md` and fails when it is.

Run the same gate locally before a release:

```bash
node scripts/acceptance.ts --mizzen bin/mizzen.ts
```

Add a case instead of pointing a new feature at an old one. Case ids are stable: the summary and old release runs name
them, so renaming one hides the history.

The release workflow runs the gate twice. In `verify` it installs the one tarball that will be published and runs
`--release --candidate "$GITHUB_SHA" --digest <sha256> --tarball <file>`; a missing candidate, a different digest, or a
failed case stops the workflow before `publish`. After `publish`, `acceptance-published` installs
`@velella/mizzen@<version>` from npm and runs the same shipped cases again; a failure fails that run, and the release
epic stays open until a post-publish run passes.
