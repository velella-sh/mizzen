# Preview rollback

Bundle each release, activate the one to serve, and roll back by activating the release before it. The host serves
whatever `current` points at, so an activation takes effect on the next request without a restart.

```bash
# Build and bundle two releases. The output folder is temporary: the bundle copies what a host needs.
node bin/mizzen.ts build site --out .previews/v1 --base /preview/pr-1 --preview-canonical https://preview.example.com/
node scripts/bundle.ts .previews/v1 previews/v1

node bin/mizzen.ts build site --out .previews/v2 --base /preview/pr-1 --preview-canonical https://preview.example.com/
node scripts/bundle.ts .previews/v2 previews/v2

# Serve the newer release on 127.0.0.1:8787, then check it in a browser.
node scripts/preview-host.ts previews --activate v2
node scripts/preview-host.ts previews --port 8787
```

Roll back to the release before it. No rebuild and no restart are needed:

```bash
node scripts/preview-host.ts previews --activate v1
```

`previews/v1/bundle.json` stays beside `previews/v1/files/`, and activation checks every file against it before
`current` moves, so the old release is served with the hash it was packaged with. A bundle that changed on disk since
it was packaged is refused; bundle the release again instead of editing the files by hand.
