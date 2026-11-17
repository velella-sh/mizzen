import type { Plugin } from "../../src/contracts/index.ts";

/** A doc page must say what it is about. Today a content hook reports this by throwing. */
const requireDescription: Plugin = {
  name: "require-description",
  content(page) {
    if (page.kind !== "doc" || page.frontMatter.description !== undefined) return page;
    throw new Error(`${page.source.file} has no description`);
  },
};

/** Minutes to read, at 200 words per minute, never zero. */
function readingMinutes(markdown: string): number {
  const words = markdown.split(/\s+/u).filter((word) => word !== "").length;
  return Math.max(1, Math.ceil(words / 200));
}

/** Runs after the validator, so the page it changes has already passed. */
const readingTime: Plugin = {
  name: "reading-time",
  content(page) {
    if (page.kind !== "doc") return page;
    return { ...page, frontMatter: { ...page.frontMatter, readingTime: readingMinutes(page.markdown) } };
  },
};

/** Fixes the list once, on the assembled site, so the outputs hook only writes it. */
const inventory: Plugin = {
  name: "inventory",
  model(site) {
    return {
      ...site,
      data: {
        ...site.data,
        pluginApi: {
          pages: site.pages.map((page) => ({
            url: page.url,
            title: page.title,
            readingTime: page.frontMatter.readingTime,
          })),
        },
      },
    };
  },
};

/** Adds one custom file to the files the outputs produced. */
const writeInventory: Plugin = {
  name: "write-inventory",
  outputs(files, site) {
    const contents = `${JSON.stringify(site.data.pluginApi, null, 2)}\n`;
    return [...files, { path: "plugin-api/inventory.json", contents }];
  },
};

export default { plugins: [requireDescription, readingTime, inventory, writeInventory] };
