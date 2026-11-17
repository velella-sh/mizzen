/**
 * Snapshots copy the current docs and navigation into a new version folder (#594): the pages, the rewritten
 * navigation, every refusal, and the all-or-nothing write.
 */
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createSnapshot, SnapshotError, type SnapshotErrorCode } from "../../src/versions/snapshot.ts";

const FIXTURE = fileURLToPath(new URL("../../fixtures/docs-versions/", import.meta.url));

/** A temporary copy of the read-only fixture; the caller removes its parent folder. */
function copyFixture(): string {
  const root = join(mkdtempSync(join(tmpdir(), "docs-versions-snapshot-")), "site");
  cpSync(FIXTURE, root, { recursive: true });
  return root;
}

/** A temporary site with these files; the caller removes its parent folder. */
function writeSite(files: Readonly<Record<string, string>>): string {
  const root = join(mkdtempSync(join(tmpdir(), "docs-versions-snapshot-")), "site");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function remove(root: string): void {
  rmSync(dirname(root), { recursive: true, force: true });
}

/** Every file under `folder`, relative and sorted, with `/` separators. */
function filesOf(folder: string): string[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(folder.length + 1).split("\\").join("/"))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The staging folders a failed snapshot must clean up. */
function stagingFolders(root: string): string[] {
  return readdirSync(root).filter((name) => name.startsWith(".mizzen-snapshot-"));
}

async function refuses(promise: Promise<unknown>, code: SnapshotErrorCode): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof SnapshotError && error.code === code);
}

test("a snapshot copies every current page and the navigation, and later edits do not reach it", async () => {
  const root = copyFixture();
  try {
    const result = await createSnapshot({ root, version: "v3" });
    assert.equal(result.version, "v3");
    assert.equal(result.folder, join(root, "v3"));
    assert.deepEqual(result.files, ["README.md", "_data/navigation.yml", "guide/install.md", "guide/upgrade.md"]);
    assert.deepEqual(filesOf(join(root, "v3")), result.files);

    for (const page of ["guide/install.md", "guide/upgrade.md"]) {
      assert.equal(readFileSync(join(root, "v3", page), "utf8"), readFileSync(join(root, page), "utf8"), page);
    }
    assert.equal(
      readFileSync(join(root, "v3/_data/navigation.yml"), "utf8"),
      [
        "main:",
        "  - title: Guide",
        "    children:",
        "      - title: Install",
        "        url: /v3/guide/install/",
        "      - title: Upgrade",
        "        url: /v3/guide/upgrade/",
        "",
      ].join("\n"),
    );

    const v2Navigation = readFileSync(join(root, "v2/_data/navigation.yml"), "utf8");
    const releasedInstall = readFileSync(join(root, "v3/guide/install.md"), "utf8");
    writeFileSync(join(root, "guide/install.md"), "---\ntitle: Install\n---\n\nChanged after the release.\n");
    assert.equal(readFileSync(join(root, "v3/guide/install.md"), "utf8"), releasedInstall);
    assert.doesNotMatch(readFileSync(join(root, "v3/guide/install.md"), "utf8"), /Changed after the release/);
    assert.equal(readFileSync(join(root, "v2/_data/navigation.yml"), "utf8"), v2Navigation);
  } finally {
    remove(root);
  }
});

test("navigation rewrites only links to snapshotted pages, keeps comments, quotes, and line endings", async () => {
  const root = writeSite({
    "mizzen.yml": "title: Snapshot test\ndefaults:\n  - path: \"\"\n    values:\n      layout: doc\nexclude: [private]\n",
    "_data/navigation.yml": [
      "# Kept comment",
      "main:",
      "  - title: Guide",
      "    url: /guide/          # section home",
      "    match: /guide",
      "  - title: Setup",
      "    url: \"/guide/setup/\"",
      "  - title: Anchor",
      "    url: /guide/setup/#install",
      "  - title: External",
      "    url: https://example.com/docs/",
      "  - title: Missing",
      "    url: /guide/missing/",
      "  - title: Draft",
      "    url: /draft/",
      "",
    ].join("\n"),
    "guide/index.md": "---\ntitle: Guide\n---\n\nGuide.\n",
    "guide/setup.md": "---\ntitle: Setup\n---\n\nLine one.\r\nLine two.\r\n",
    "draft.md": "---\ntitle: Draft\npublished: false\n---\n\nDraft.\n",
    "private/secret.md": "---\ntitle: Secret\n---\n\nNot part of the build.\n",
    "v9/old.md": "---\ntitle: Old\n---\n\nA released page.\n",
  });
  try {
    const result = await createSnapshot({ root, version: "v10" });
    assert.deepEqual(result.files, ["_data/navigation.yml", "guide/index.md", "guide/setup.md"]);
    assert.deepEqual(filesOf(join(root, "v10")), result.files);

    const navigation = readFileSync(join(root, "v10/_data/navigation.yml"), "utf8");
    assert.match(navigation, /^# Kept comment$/m);
    assert.match(navigation, /url: \/v10\/guide\/          # section home/);
    assert.match(navigation, /match: \/v10\/guide$/m);
    assert.match(navigation, /url: "\/v10\/guide\/setup\/"$/m);
    assert.match(navigation, /url: \/guide\/setup\/#install$/m);
    assert.match(navigation, /url: https:\/\/example\.com\/docs\/$/m);
    assert.match(navigation, /url: \/guide\/missing\/$/m);
    assert.match(navigation, /url: \/draft\/$/m);

    assert.doesNotMatch(readFileSync(join(root, "v10/guide/setup.md"), "utf8"), /\r/);
  } finally {
    remove(root);
  }
});

test("a duplicate or an older name is refused before anything is written", async () => {
  const root = copyFixture();
  try {
    const before = filesOf(join(root, "v2"));
    await refuses(createSnapshot({ root, version: "v2" }), "snapshot.exists");
    await refuses(createSnapshot({ root, version: "v0" }), "snapshot.not-newer");
    assert.deepEqual(filesOf(join(root, "v2")), before);
    assert.equal(existsSync(join(root, "v0")), false);
    assert.deepEqual(stagingFolders(root), []);
  } finally {
    remove(root);
  }
});

test("a missing navigation file is a missing input, and nothing is written", async () => {
  const root = copyFixture();
  try {
    rmSync(join(root, "_data/navigation.yml"));
    await refuses(createSnapshot({ root, version: "v3" }), "snapshot.missing");
    assert.equal(existsSync(join(root, "v3")), false);
    assert.deepEqual(stagingFolders(root), []);
  } finally {
    remove(root);
  }
});

test("a write failure leaves no partial version, and the retry is atomic", async () => {
  const root = copyFixture();
  try {
    const v1 = filesOf(join(root, "v1"));
    const v2 = filesOf(join(root, "v2"));
    await refuses(
      createSnapshot({
        root,
        version: "v3",
        hooks: {
          beforeCommit: () => {
            throw new Error("the disk is full");
          },
        },
      }),
      "snapshot.write-failed",
    );
    assert.equal(existsSync(join(root, "v3")), false);
    assert.deepEqual(stagingFolders(root), []);
    assert.deepEqual(filesOf(join(root, "v1")), v1);
    assert.deepEqual(filesOf(join(root, "v2")), v2);

    const result = await createSnapshot({ root, version: "v3" });
    assert.deepEqual(filesOf(join(root, "v3")), result.files);
    assert.deepEqual(stagingFolders(root), []);
  } finally {
    remove(root);
  }
});
