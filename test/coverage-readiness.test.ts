/**
 * Coverage for the readiness scan's failure branches: every rubric rule is checked against a real build
 * that has been broken in one deliberate way. Each case copies the built fixture, so cases never share state.
 */
import assert from "node:assert/strict";
import { readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { RUBRIC } from "../src/readiness/rubric.ts";
import { dimensionOfCode, pageScope, rubricRules, scanBuild, scanHasBuild, type ScanResult } from "../src/readiness/scan.ts";
import { buildFixture, copyBuild, type BuiltFixture } from "./readiness-fixture.ts";

interface ManifestPage {
  url: string;
  source: string;
  title: string;
  layout: string | null;
  outputs: string[];
  hashes: { source: string; html: string };
}
interface Manifest {
  version: number;
  base: string;
  pages: ManifestPage[];
  build: { hash: string; files: Record<string, string> };
}
interface SourceSection {
  id: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}
interface SourceBlock extends SourceSection {
  file: string;
}
interface SourcePage {
  url: string;
  source: string;
  sections: SourceSection[];
  blocks: SourceBlock[];
}
interface SourceMap {
  version: number;
  pages: SourcePage[];
}
interface BlocksFile {
  version: number;
  blocks: Record<string, { file?: string; line?: number; url?: string }>;
}
interface TrustFile {
  version: number;
  build: { id: string; pages: number };
  pages: Record<string, { source: string }>;
}
interface ReviewFile {
  version: number;
  pages: Record<string, { source: string; state?: string }>;
}
interface ExamplesFile {
  pages: { url: string; failed?: number }[];
}
interface AgentFile {
  url: string;
  source: string;
  agent: { source?: string; notes?: string; edit?: boolean };
}
interface PackFile {
  version: number;
  build: { id: string };
  items: unknown[];
}

let built: BuiltFixture;

before(async () => {
  built = await buildFixture();
});

after(() => built.cleanup());

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value));
}

function editJson<T>(path: string, change: (value: T) => void): void {
  const value = readJson<T>(path);
  change(value);
  writeJson(path, value);
}

function manifestOf(dir: string): Manifest {
  return readJson<Manifest>(join(dir, ".mizzen/manifest.json"));
}

function editManifest(dir: string, change: (value: Manifest) => void): void {
  editJson<Manifest>(join(dir, ".mizzen/manifest.json"), change);
}

/** The guide page's Markdown twin. */
function guideTwin(dir: string): string {
  return join(dir, "guide/index.md");
}

/** A finding of one rule whose message or evidence contains `text`. */
function finding(result: ScanResult, code: string, text: string) {
  return result.findings.find((entry) => entry.code === code && (entry.message.includes(text) || entry.evidence.includes(text)));
}

/** The status of one rule, or `undefined`. */
function statusOf(result: ScanResult, code: string): string | undefined {
  return result.outcomes.find((outcome) => outcome.code === code)?.status;
}

interface Case {
  readonly name: string;
  readonly mutate: (dir: string) => void;
  readonly check: (result: ScanResult) => void;
}

const CASES: readonly Case[] = [
  {
    name: "manifest is missing",
    mutate: (dir) => unlinkSync(join(dir, ".mizzen/manifest.json")),
    check: (result) => {
      assert.ok(finding(result, "structure.manifest", "no readable manifest"), "missing manifest");
      assert.equal(scanHasBuild(result), false);
    },
  },
  {
    name: "manifest is not an object",
    mutate: (dir) => writeJson(join(dir, ".mizzen/manifest.json"), []),
    check: (result) => {
      assert.ok(finding(result, "structure.manifest", "not a JSON object"), "not a JSON object");
      assert.equal(result.build.hash, "0".repeat(64));
    },
  },
  {
    name: "manifest is malformed",
    mutate: (dir) => writeJson(join(dir, ".mizzen/manifest.json"), { version: 1 }),
    check: (result) => {
      assert.ok(finding(result, "structure.manifest", "malformed"), "malformed manifest");
    },
  },
  {
    name: "page entries name unsafe sources and bad hashes",
    mutate: (dir) =>
      editManifest(dir, (manifest) => {
        manifest.pages[0]!.source = "../escape.md";
        manifest.pages[1]!.hashes.html = "nope";
      }),
    check: (result) => {
      assert.ok(finding(result, "structure.manifest", "safe relative source"), "unsafe source");
      assert.ok(finding(result, "structure.manifest", "SHA-256"), "bad hash");
    },
  },
  {
    name: "a page has no Markdown twin",
    mutate: (dir) =>
      editManifest(dir, (manifest) => {
        manifest.pages[0]!.outputs = manifest.pages[0]!.outputs.filter((path) => path !== "guide/index.md");
      }),
    check: (result) => {
      assert.ok(finding(result, "structure.markdown", "no Markdown twin"), "missing twin");
    },
  },
  {
    name: "a page has an empty Markdown twin",
    mutate: (dir) => writeFileSync(guideTwin(dir), ""),
    check: (result) => {
      assert.ok(finding(result, "structure.markdown", "Markdown twin is empty"), "empty twin");
    },
  },
  {
    name: "source map is missing",
    mutate: (dir) => unlinkSync(join(dir, "sourcemap.json")),
    check: (result) => {
      assert.ok(finding(result, "structure.sourcemap", "no readable source map"), "missing map");
    },
  },
  {
    name: "source map has the wrong shape",
    mutate: (dir) => writeJson(join(dir, "sourcemap.json"), { version: 1 }),
    check: (result) => {
      assert.ok(finding(result, "structure.sourcemap", "is malformed"), "malformed map");
    },
  },
  {
    name: "source map omits one page",
    mutate: (dir) =>
      editJson<SourceMap>(join(dir, "sourcemap.json"), (map) => {
        map.pages = map.pages.filter((page) => page.url !== "/guide/");
      }),
    check: (result) => {
      assert.ok(finding(result, "structure.sourcemap", "no source map entry"), "missing map entry");
    },
  },
  {
    name: "source map names another source, repeats an anchor, repeats a block, and names a ghost page",
    mutate: (dir) =>
      editJson<SourceMap>(join(dir, "sourcemap.json"), (map) => {
        const guide = map.pages[0]!;
        const reference = map.pages[1]!;
        guide.source = "guide/other.md";
        guide.sections.push({ ...guide.sections[0]! });
        reference.blocks.push({ ...guide.blocks[0]!, file: "reference/index.md" });
        map.pages.push({ url: "/ghost/", source: "ghost/index.md", sections: [], blocks: [] });
      }),
    check: (result) => {
      assert.ok(finding(result, "structure.sourcemap", "names another source file"), "source mismatch");
      assert.ok(finding(result, "structure.sourcemap", "does not contain"), "ghost page");
      assert.ok(finding(result, "structure.ids", "heading anchor repeats"), "repeated anchor");
      assert.ok(finding(result, "structure.ids", "used by more than one page"), "repeated block");
    },
  },
  {
    name: "blocks.json is missing",
    mutate: (dir) => unlinkSync(join(dir, "blocks.json")),
    check: (result) => assert.equal(statusOf(result, "structure.blocks"), "unknown"),
  },
  {
    name: "blocks.json has the wrong shape",
    mutate: (dir) => writeJson(join(dir, "blocks.json"), { version: 2 }),
    check: (result) => {
      assert.ok(finding(result, "structure.blocks", "malformed"), "malformed blocks");
    },
  },
  {
    name: "block records are incomplete, unknown, disagree with the map, and disagree with the HTML",
    mutate: (dir) => {
      editJson<BlocksFile>(join(dir, "blocks.json"), (blocks) => {
        blocks.blocks["BAD ID"] = { file: "guide/index.md", line: 1, url: "/guide/" };
        blocks.blocks["b-0000000000"] = { file: "ghost.md", line: 1, url: "/ghost/" };
      });
      editJson<SourceMap>(join(dir, "sourcemap.json"), (map) => {
        map.pages[0]!.blocks = map.pages[0]!.blocks.filter((block) => block.id !== "b-5b46415702");
      });
      const guideHtml = join(dir, "guide/index.html");
      writeFileSync(guideHtml, readFileSync(guideHtml, "utf8").replace("</body>", '<div data-block="b-unknown"></div></body>'));
      const referenceHtml = join(dir, "reference/index.html");
      writeFileSync(referenceHtml, readFileSync(referenceHtml, "utf8").replace(' data-block="b-dfd7ac2d74"', ""));
    },
    check: (result) => {
      assert.ok(finding(result, "structure.blocks", "malformed"), "incomplete block");
      assert.ok(finding(result, "structure.blocks", "does not contain"), "unknown page");
      assert.ok(finding(result, "structure.blocks", "disagree about a block id"), "map disagreement");
      assert.ok(finding(result, "structure.blocks", "did not record"), "unrecorded HTML block");
      assert.ok(finding(result, "structure.blocks", "does not appear in the page HTML"), "recorded block missing");
    },
  },
  {
    name: "llms.txt is missing",
    mutate: (dir) => unlinkSync(join(dir, "llms.txt")),
    check: (result) => {
      assert.ok(finding(result, "navigation.llms", "no readable llms.txt"), "missing llms");
    },
  },
  {
    name: "llms.txt links nowhere and omits a twin",
    mutate: (dir) => {
      const path = join(dir, "llms.txt");
      const lines = readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => !line.includes("guide/index.md"));
      lines.push("- [Lost](https://example.test/lost/)");
      writeFileSync(path, lines.join("\n"));
    },
    check: (result) => {
      assert.ok(finding(result, "navigation.llms", "links to a path the build does not contain"), "unresolved link");
      assert.ok(finding(result, "navigation.llms", "does not list a page's Markdown twin"), "unlisted twin");
    },
  },
  {
    name: "rendered links use missing paths, malformed escapes, and extensionless paths",
    mutate: (dir) => {
      const path = join(dir, "guide/index.html");
      writeFileSync(
        path,
        readFileSync(path, "utf8").replace(
          "</body>",
          '<a href="/missing/">x</a><a href="http://[">y</a><a href="/guide">z</a><a href="/404">w</a><a href="%E0%A4%A">v</a></body>',
        ),
      );
    },
    check: (result) => {
      assert.equal(result.findings.filter((entry) => entry.code === "navigation.links").length, 2);
      assert.ok(finding(result, "navigation.links", "unresolved /missing/"), "missing link");
      assert.ok(finding(result, "navigation.links", "unresolved %E0%A4%A"), "malformed escape");
    },
  },
  {
    name: "AGENTS.md is missing",
    mutate: (dir) => unlinkSync(join(dir, "AGENTS.md")),
    check: (result) => {
      assert.ok(finding(result, "navigation.agents", "no readable AGENTS.md"), "missing AGENTS.md");
    },
  },
  {
    name: "AGENTS.md has no Pages section",
    mutate: (dir) => writeFileSync(join(dir, "AGENTS.md"), "# AGENTS.md\n"),
    check: (result) => {
      assert.ok(finding(result, "navigation.agents", "does not describe"), "no pages section");
    },
  },
  {
    name: "AGENTS.md names another page count",
    mutate: (dir) => {
      const path = join(dir, "AGENTS.md");
      writeFileSync(path, readFileSync(path, "utf8").replace("Pages in this build: 2", "Pages in this build: 3"));
    },
    check: (result) => {
      assert.ok(finding(result, "navigation.agents", "another number of pages"), "page count");
    },
  },
  {
    name: "a page has no JSON twin, so permissions cannot name an edit target",
    mutate: (dir) => {
      editManifest(dir, (manifest) => {
        delete manifest.build.files["guide/index.json"];
      });
      unlinkSync(join(dir, "guide/index.json"));
    },
    check: (result) => {
      assert.ok(finding(result, "context.page-json", "no JSON twin"), "missing JSON");
      assert.ok(finding(result, "permissions.edit-target", "safe source file"), "missing edit target");
    },
  },
  {
    name: "a page JSON twin is malformed",
    mutate: (dir) => writeFileSync(join(dir, "guide/index.json"), "{"),
    check: (result) => {
      assert.ok(finding(result, "context.page-json", "JSON twin is malformed"), "malformed JSON");
    },
  },
  {
    name: "a page JSON twin names another page",
    mutate: (dir) =>
      editJson<Record<string, unknown>>(join(dir, "guide/index.json"), (value) => {
        value["url"] = "/ghost/";
      }),
    check: (result) => {
      assert.ok(finding(result, "context.page-json", "names another page or source"), "wrong page");
    },
  },
  {
    name: "no page declares an agent block",
    mutate: (dir) =>
      editManifest(dir, (manifest) => {
        delete manifest.build.files["guide/agent.json"];
        delete manifest.build.files["reference/agent.json"];
      }),
    check: (result) => assert.equal(statusOf(result, "context.agent-json"), "unknown"),
  },
  {
    name: "an agent instruction file is malformed",
    mutate: (dir) => writeFileSync(join(dir, "guide/agent.json"), "{"),
    check: (result) => {
      assert.ok(finding(result, "context.agent-json", "malformed"), "malformed agent");
    },
  },
  {
    name: "an agent instruction file names no page",
    mutate: (dir) =>
      editJson<AgentFile>(join(dir, "guide/agent.json"), (value) => {
        value.url = "/ghost/";
      }),
    check: (result) => {
      assert.ok(finding(result, "context.agent-json", "names no page"), "unknown page");
    },
  },
  {
    name: "an agent block says nothing actionable",
    mutate: (dir) =>
      editJson<AgentFile>(join(dir, "guide/agent.json"), (value) => {
        value.agent = {};
      }),
    check: (result) => {
      assert.ok(finding(result, "context.agent-json", "says nothing"), "empty agent");
    },
  },
  {
    name: "an agent block names an unsafe edit target and a generated page",
    mutate: (dir) =>
      editJson<AgentFile>(join(dir, "guide/agent.json"), (value) => {
        value.agent = { source: "../escape.md", edit: false };
      }),
    check: (result) => {
      assert.ok(finding(result, "permissions.edit-target", "unsafe edit target"), "unsafe target");
      assert.ok(finding(result, "permissions.generated", "edit false"), "generated page");
    },
  },
  {
    name: "no context pack is configured",
    mutate: (dir) =>
      editManifest(dir, (manifest) => {
        delete manifest.build.files["pack/guide.json"];
        delete manifest.build.files["pack/guide.md"];
      }),
    check: (result) => assert.equal(statusOf(result, "context.packs"), "unknown"),
  },
  {
    name: "a context pack is malformed",
    mutate: (dir) => writeJson(join(dir, "pack/guide.json"), { version: 2, items: [] }),
    check: (result) => {
      assert.ok(finding(result, "context.packs", "is malformed"), "malformed pack");
    },
  },
  {
    name: "a pack selects a ghost page, has an item without a span, and has no Markdown twin",
    mutate: (dir) => {
      editJson<PackFile>(join(dir, "pack/guide.json"), (pack) => {
        pack.items = [
          {},
          { url: "/ghost/", origin: { source: "ghost.md", span: "ghost.md:1:1-1:1" } },
          { url: "/guide/", origin: {} },
        ];
      });
      editManifest(dir, (manifest) => {
        delete manifest.build.files["pack/guide.md"];
      });
    },
    check: (result) => {
      assert.ok(finding(result, "context.packs", "does not contain"), "ghost page");
      assert.ok(finding(result, "context.packs", "no source span"), "missing span");
      assert.ok(finding(result, "context.packs", "no Markdown twin"), "missing pack twin");
    },
  },
  {
    name: "context packs disagree about their build",
    mutate: (dir) => {
      const pack = readJson<PackFile>(join(dir, "pack/guide.json"));
      writeJson(join(dir, "pack/extra.json"), { ...pack, build: { id: "f".repeat(64) } });
      writeFileSync(join(dir, "pack/extra.md"), "# Extra\n");
      editManifest(dir, (manifest) => {
        manifest.build.files["pack/extra.json"] = "0".repeat(64);
        manifest.build.files["pack/extra.md"] = "0".repeat(64);
      });
    },
    check: (result) => {
      assert.ok(finding(result, "context.packs", "disagree about which build"), "build ids");
    },
  },
  {
    name: "the examples report is missing",
    mutate: (dir) => unlinkSync(join(dir, "examples.json")),
    check: (result) => assert.equal(statusOf(result, "examples.report"), "unknown"),
  },
  {
    name: "the examples report is malformed",
    mutate: (dir) => writeJson(join(dir, "examples.json"), {}),
    check: (result) => {
      assert.ok(finding(result, "examples.report", "malformed"), "malformed report");
    },
  },
  {
    name: "the examples report omits a page and records a failure",
    mutate: (dir) =>
      editJson<ExamplesFile>(join(dir, "examples.json"), (report) => {
        report.pages = [{ url: "/reference/", failed: 1 }];
      }),
    check: (result) => {
      assert.ok(finding(result, "examples.report", "omits a page"), "omitted page");
      assert.ok(finding(result, "examples.report", "failing example"), "failed example");
    },
  },
  {
    name: "a Markdown twin has an unlabelled code fence",
    mutate: (dir) => {
      writeFileSync(guideTwin(dir), `${readFileSync(guideTwin(dir), "utf8")}\n\`\`\`\nplain\n\`\`\`\n`);
    },
    check: (result) => {
      assert.ok(finding(result, "examples.fences", "declares no language"), "unlabelled fence");
    },
  },
  {
    name: "a build with no code fences leaves the rule unknown",
    mutate: (dir) => {
      writeFileSync(guideTwin(dir), "# Guide\n\nPlain text.\n");
      writeFileSync(join(dir, "reference/index.md"), "# Reference\n\nPlain text.\n");
    },
    check: (result) => assert.equal(statusOf(result, "examples.fences"), "unknown"),
  },
  {
    name: "a folder with an unsupported entry cannot be hashed",
    mutate: (dir) => symlinkSync(join(dir, "guide/index.html"), join(dir, "link.html")),
    check: (result) => {
      assert.ok(finding(result, "verification.digest", "cannot be hashed"), "digest failure");
      assert.ok(finding(result, "verification.digest", "symlink"), "symlink evidence");
    },
  },
  {
    name: "trust.json is missing",
    mutate: (dir) => unlinkSync(join(dir, "trust.json")),
    check: (result) => assert.equal(statusOf(result, "verification.trust"), "unknown"),
  },
  {
    name: "trust.json names another build shape",
    mutate: (dir) =>
      editJson<TrustFile>(join(dir, "trust.json"), (trust) => {
        trust.build.pages = 99;
      }),
    check: (result) => {
      assert.ok(finding(result, "verification.trust", "another build shape"), "wrong build shape");
    },
  },
  {
    name: "trust.json is malformed",
    mutate: (dir) => writeJson(join(dir, "trust.json"), {}),
    check: (result) => {
      assert.ok(finding(result, "verification.trust", "malformed"), "malformed trust");
    },
  },
  {
    name: "trust.json omits a page",
    mutate: (dir) =>
      editJson<TrustFile>(join(dir, "trust.json"), (trust) => {
        delete trust.pages["/guide/"];
      }),
    check: (result) => {
      assert.ok(finding(result, "verification.trust", "does not name a page's source"), "missing trust page");
    },
  },
  {
    name: "review coverage is missing",
    mutate: (dir) => unlinkSync(join(dir, "review-coverage.json")),
    check: (result) => {
      assert.equal(statusOf(result, "maintenance.review"), "unknown");
      assert.equal(statusOf(result, "maintenance.state"), "unknown");
    },
  },
  {
    name: "review coverage is malformed",
    mutate: (dir) => writeJson(join(dir, "review-coverage.json"), {}),
    check: (result) => {
      assert.ok(finding(result, "maintenance.review", "malformed"), "malformed review");
    },
  },
  {
    name: "review coverage omits a page and marks another overdue",
    mutate: (dir) =>
      editJson<ReviewFile>(join(dir, "review-coverage.json"), (review) => {
        delete review.pages["/guide/"];
        review.pages["/reference/"]!.state = "overdue";
      }),
    check: (result) => {
      assert.ok(finding(result, "maintenance.review", "omits a page"), "omitted review page");
      assert.ok(finding(result, "maintenance.state", "due for review"), "overdue page");
    },
  },
  {
    name: "every page has a satisfied review state",
    mutate: (dir) =>
      editJson<ReviewFile>(join(dir, "review-coverage.json"), (review) => {
        for (const page of Object.values(review.pages)) page.state = "satisfied";
      }),
    check: (result) => assert.equal(statusOf(result, "maintenance.state"), "pass"),
  },
  {
    name: "a base path equal to a link path is stripped",
    mutate: (dir) => {
      editManifest(dir, (manifest) => {
        manifest.base = "/guide";
      });
      const path = join(dir, "llms.txt");
      writeFileSync(path, `${readFileSync(path, "utf8")}\n- [Base](https://example.test/guide)\n`);
    },
    check: (result) => {
      assert.ok(finding(result, "navigation.llms", "unresolved https://example.test/guide"), "base path");
    },
  },
];

test("every broken build is reported by the rule it breaks", async () => {
  for (const entry of CASES) {
    const dir = copyBuild(built, `scan-${entry.name.replace(/[^a-z0-9]+/gi, "-")}`);
    entry.mutate(dir);
    const result = await scanBuild(dir);
    try {
      entry.check(result);
    } catch (error) {
      throw new Error(`${entry.name}: ${(error as Error).message}`, { cause: error });
    }
  }
});

test("evaluation reports are matched by suite, snapshot, and rule", async () => {
  const hash = manifestOf(built.out).build.hash;
  const suite = RUBRIC.evaluation.suite;
  const version = RUBRIC.evaluation.version;

  const other = await scanBuild(built.out, {
    evaluations: { suite: "another-suite", version, snapshot: hash, results: {} },
  });
  assert.match(other.outcomes.find((outcome) => outcome.code === "examples.evaluation")?.reason ?? "", /another-suite/);

  const snapshot = await scanBuild(built.out, {
    evaluations: { suite, version, snapshot: "0".repeat(64), results: {} },
  });
  assert.match(snapshot.outcomes.find((outcome) => outcome.code === "examples.evaluation")?.reason ?? "", /snapshot/);

  const noResult = await scanBuild(built.out, { evaluations: { suite, version, snapshot: hash, results: {} } });
  assert.match(noResult.outcomes.find((outcome) => outcome.code === "examples.evaluation")?.reason ?? "", /no result/);

  const passed = await scanBuild(built.out, {
    evaluations: { suite, version, snapshot: hash, results: { "examples.evaluation": "pass" } },
  });
  assert.equal(statusOf(passed, "examples.evaluation"), "pass");

  const failed = await scanBuild(built.out, {
    evaluations: { suite, version, snapshot: hash, results: { "examples.evaluation": "fail" } },
  });
  assert.equal(statusOf(failed, "examples.evaluation"), "fail");
  assert.ok(finding(failed, "examples.evaluation", "did not pass this build"), "failed evaluation");
});

test("rule helpers expose the rubric order and dimensions", async () => {
  assert.deepEqual(rubricRules(), RUBRIC.rules);
  assert.equal(dimensionOfCode("structure.manifest"), "structure");
  assert.equal(dimensionOfCode("verification.digest"), "verification");
  assert.throws(() => dimensionOfCode("no.such-rule"), TypeError);
  assert.deepEqual(pageScope("/guide/"), { kind: "page", page: "/guide/", systemic: false });
  assert.deepEqual(pageScope("/guide/", "b-1"), { kind: "block", page: "/guide/", block: "b-1", systemic: false });
  assert.equal(scanHasBuild(await scanBuild(built.out)), true);
});
