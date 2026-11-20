import assert from "node:assert/strict";
import { test } from "node:test";
import type { NavItem } from "../src/contracts/index.ts";
import {
  convertSidebar,
  flatLinks,
  type CategoryMeta,
  type SidebarPage,
} from "../src/import/docusaurus/sidebar.ts";

const PAGES: readonly SidebarPage[] = [
  { id: "intro", title: "Introduction", url: "/docs/intro/", position: 2 },
  { id: "guides/setup", title: "Setup", url: "/docs/guides/setup/", position: 2 },
  { id: "guides/intro", title: "Guide intro", url: "/docs/guides/intro/", position: 1 },
  { id: "guides/deep/advanced", title: "Advanced", url: "/docs/guides/deep/advanced/", position: 1 },
  { id: "api/overview", title: "API overview", url: "/docs/api/overview/" },
  { id: "docs/a", title: "A", url: "/docs/a/", position: 2 },
  { id: "docs/b", title: "B", url: "/docs/b/" },
];

/** Converts one sidebar source against the fixture pages. */
function convert(source: string, categories?: ReadonlyMap<string, CategoryMeta>) {
  return convertSidebar(source, "sidebars.js", PAGES, categories === undefined ? {} : { categories });
}

/** The diagnostic ids of one conversion. */
function ids(source: string): string[] {
  return convert(source).diagnostics.map((diagnostic) => diagnostic.id);
}

test("doc, link, and category entries become links and groups in declaration order", () => {
  const source = [
    "module.exports = {",
    "  docs: [",
    '    "intro",',
    '    { type: "doc", id: "guides/setup", label: "Set up" },',
    '    { id: "api/overview" },',
    '    { type: "link", label: "Guides", href: "https://example.com/guides" },',
    '    { type: "link", label: "No href" },',
    '    { type: "link", href: "https://example.com/no-label" },',
    '    "missing",',
    '    { type: "category", label: "Group", items: ["intro", { type: "category", label: "Nested", items: ["guides/setup"] }] },',
    '    { type: "category", label: "No items" },',
    '    { type: "unknown", id: "intro" },',
    '    { type: "doc", id: 42 },',
    "  ],",
    "};",
  ].join("\n");

  const outcome = convert(source);
  assert.deepEqual(outcome.items, [
    { title: "Introduction", url: "/docs/intro/" },
    { title: "Set up", url: "/docs/guides/setup/" },
    { title: "API overview", url: "/docs/api/overview/" },
    { title: "Guides", url: "https://example.com/guides" },
    {
      title: "Group",
      children: [
        { title: "Introduction", url: "/docs/intro/" },
        { title: "Setup", url: "/docs/guides/setup/" },
      ],
    },
  ]);
  assert.deepEqual(outcome.diagnostics.map((diagnostic) => diagnostic.id), [
    "import.sidebar-invalid-link",
    "import.sidebar-invalid-link",
    "import.sidebar-unknown-doc",
    "import.sidebar-invalid-category",
    "import.sidebar-unknown-doc",
  ]);
  assert.equal(outcome.diagnostics[0]?.severity, "warning");
  assert.equal(outcome.diagnostics[0]?.pos?.file, "sidebars.js");
});

test("every export anchor and a bare JSON object find the same sidebar", () => {
  const expected = [{ title: "Introduction", url: "/docs/intro/" }];
  const sources = [
    'module.exports = { docs: ["intro"] };',
    'export default { docs: ["intro"] };',
    'const sidebars = { docs: ["intro"] };',
    '{ "docs": ["intro"] }',
  ];
  for (const source of sources) assert.deepEqual(convert(source).items, expected);
});

test("comments, strings, templates, and spreads are skipped without losing the list", () => {
  const source = [
    "const shared = [];",
    "module.exports = {",
    "  ...shared,",
    "  // the docs sidebar",
    "  docs,",
    "  run() { return 1; },",
    '  "unterminated" noColon,',
    "  /* multi",
    "     line */",
    '  guides: [...shared, "intro", `guides/setup`],',
    "};",
  ].join("\n");

  assert.deepEqual(convert(source).items, [
    { title: "Introduction", url: "/docs/intro/" },
    { title: "Setup", url: "/docs/guides/setup/" },
  ]);
});

test("escaped quotes and newlines inside a string are read as literal text", () => {
  const source = 'module.exports = { docs: ["intro\\"quoted", \'guides\\\\setup\', `api/overview`] };';
  const outcome = convert(source);
  assert.deepEqual(outcome.items, [{ title: "API overview", url: "/docs/api/overview/" }]);
  assert.deepEqual(outcome.diagnostics.map((diagnostic) => diagnostic.id), [
    "import.sidebar-unknown-doc",
    "import.sidebar-unknown-doc",
  ]);
});

test("refs expand in place, cycle, and report a ref that names no list", () => {
  const source = [
    "module.exports = {",
    '  docs: ["intro", { type: "ref", id: "more" }, { type: "ref", id: "nope" }],',
    '  more: ["guides/setup", { type: "ref", id: "more" }],',
    "};",
  ].join("\n");

  const outcome = convert(source);
  assert.deepEqual(outcome.items, [
    { title: "Introduction", url: "/docs/intro/" },
    { title: "Setup", url: "/docs/guides/setup/" },
    { title: "Setup", url: "/docs/guides/setup/" },
    { title: "Setup", url: "/docs/guides/setup/" },
  ]);
  assert.deepEqual(outcome.diagnostics.map((diagnostic) => diagnostic.id), ["import.sidebar-unknown-ref"]);
});

test("a category flattens nested refs and categories and drops an empty one", () => {
  const source = [
    "module.exports = {",
    "  other: [",
    "    { type: \"category\", label: \"Wrapped\", items: [",
    '      { type: "ref", id: "deep" },',
    '      { type: "category", label: "Inner", items: ["api/overview"] },',
    "    ] },",
    '    { type: "category", label: "Empty", items: ["missing"] },',
    '    { type: "category", label: "Clickable", link: { type: "doc", id: "intro" }, items: ["intro"] },',
    "  ],",
    '  deep: ["guides/setup"],',
    "};",
  ].join("\n");

  const outcome = convert(source);
  assert.deepEqual(outcome.items, [
    {
      title: "Wrapped",
      children: [
        { title: "Setup", url: "/docs/guides/setup/" },
        { title: "API overview", url: "/docs/api/overview/" },
      ],
    },
    { title: "Clickable", children: [{ title: "Introduction", url: "/docs/intro/" }] },
    { title: "Setup", url: "/docs/guides/setup/" },
  ]);
  assert.deepEqual(outcome.diagnostics.map((diagnostic) => diagnostic.id), ["import.sidebar-unknown-doc"]);
});

test("an autogenerated list is rebuilt from folders, positions, and category files", () => {
  const source = [
    "module.exports = {",
    '  docs: [{ type: "autogenerated", dirName: "." }],',
    "};",
  ].join("\n");
  const categories = new Map<string, CategoryMeta>([
    ["guides", { label: "Guides", position: 1 }],
    ["guides/deep", { label: "Deep docs", position: 3 }],
  ]);

  const outcome = convert(source, categories);
  assert.deepEqual(outcome.items, [
    {
      title: "Guides",
      children: [
        { title: "Advanced", url: "/docs/guides/deep/advanced/" },
        { title: "Guide intro", url: "/docs/guides/intro/" },
        { title: "Setup", url: "/docs/guides/setup/" },
      ],
    },
    { title: "Introduction", url: "/docs/intro/" },
    {
      title: "api",
      children: [{ title: "API overview", url: "/docs/api/overview/" }],
    },
    {
      title: "docs",
      children: [
        { title: "A", url: "/docs/a/" },
        { title: "B", url: "/docs/b/" },
      ],
    },
  ]);
  assert.deepEqual(outcome.diagnostics, []);
});

test("an autogenerated list without dirName roots at the section and a deep one keeps its folder group", () => {
  const source = [
    "module.exports = {",
    '  docs: [{ type: "autogenerated" }, { type: "autogenerated", dirName: "./guides/" }],',
    "};",
  ].join("\n");
  const categories = new Map<string, CategoryMeta>([
    ["guides/deep", { label: "Deep docs", position: 3 }],
  ]);
  const outcome = convert(source, categories);
  assert.deepEqual(outcome.items, [
    { title: "Introduction", url: "/docs/intro/" },
    {
      title: "api",
      children: [{ title: "API overview", url: "/docs/api/overview/" }],
    },
    {
      title: "docs",
      children: [
        { title: "A", url: "/docs/a/" },
        { title: "B", url: "/docs/b/" },
      ],
    },
    {
      title: "guides",
      children: [
        { title: "Advanced", url: "/docs/guides/deep/advanced/" },
        { title: "Guide intro", url: "/docs/guides/intro/" },
        { title: "Setup", url: "/docs/guides/setup/" },
      ],
    },
    { title: "Guide intro", url: "/docs/guides/intro/" },
    { title: "Setup", url: "/docs/guides/setup/" },
    {
      title: "Deep docs",
      children: [{ title: "Advanced", url: "/docs/guides/deep/advanced/" }],
    },
  ]);
  assert.deepEqual(outcome.diagnostics, []);
});

test("an autogenerated list with no imported pages reports once and adds nothing", () => {
  const source = 'module.exports = { docs: [{ type: "autogenerated", dirName: "missing" }] };';
  const outcome = convert(source);
  assert.deepEqual(outcome.items, []);
  assert.deepEqual(outcome.diagnostics.map((diagnostic) => diagnostic.id), ["import.sidebar-autogenerated"]);
});

test("a file with no object literal, or no list, contributes no navigation", () => {
  assert.deepEqual(ids("const value = 1;"), ["import.sidebar-unreadable"]);
  assert.deepEqual(ids("module.exports = [];"), ["import.sidebar-unreadable"]);
  assert.deepEqual(ids("module.exports = { docs: 'intro' };"), []);
  assert.deepEqual(convert("module.exports = { docs: 'intro' };").items, []);
});

test("an empty array list is valid and contributes nothing", () => {
  const outcome = convert("module.exports = { docs: [] };");
  assert.deepEqual(outcome.items, []);
  assert.deepEqual(outcome.diagnostics, []);
});

test("flatLinks replaces every group with its links at any depth", () => {
  const items: NavItem[] = [
    { title: "One", url: "/one/" },
    { title: "Group", children: [{ title: "Two", url: "/two/" }, { title: "Inner", children: [{ title: "Three", url: "/three/" }] }] },
  ];
  assert.deepEqual(flatLinks(items), [
    { title: "One", url: "/one/" },
    { title: "Two", url: "/two/" },
    { title: "Three", url: "/three/" },
  ]);
});

test("conversion is deterministic", () => {
  const source = 'module.exports = { docs: [{ type: "autogenerated", dirName: "." }, "intro"] };';
  assert.deepEqual(convert(source), convert(source));
});

test("a punctuation value ends the list and an unreadable object entry is skipped", () => {
  const source = 'module.exports = { = 1, docs: [ "intro", ( ], guides: ["guides/setup"] };';
  const outcome = convert(source);
  assert.deepEqual(outcome.items, [
    { title: "Introduction", url: "/docs/intro/" },
    { title: "Setup", url: "/docs/guides/setup/" },
  ]);
});

test("an autogenerated list inside a category rebuilds its folders as a group", () => {
  const source = [
    "module.exports = {",
    '  docs: [{ type: "category", label: "Generated", items: [{ type: "autogenerated", dirName: "docs" }] }],',
    "};",
  ].join("\n");
  assert.deepEqual(convert(source).items, [
    {
      title: "Generated",
      children: [
        { title: "A", url: "/docs/a/" },
        { title: "B", url: "/docs/b/" },
      ],
    },
  ]);
});
